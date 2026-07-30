import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {confirmKuboPublicAddrs, createVotesNode, kuboPublicIp4s} from '../lib/votes/node.ts'

const getFreePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address() as net.AddressInfo
    server.close(() => resolve(port))
  })
  server.once('error', reject)
})

// The shape of Kubo's /api/v0/id addresses: a mix of loopback, LAN, and public addrs, with
// the public one repeated under a second transport.
const KUBO_ADDRESSES = [
  '/ip4/127.0.0.1/tcp/4001',
  '/ip4/192.168.1.5/tcp/4001',
  '/ip4/172.31.0.1/tcp/4001',
  '/ip4/203.0.113.7/tcp/4001',
  '/ip4/203.0.113.7/udp/4001/quic-v1'
]

const votesConfigFor = (dataDir: string, tcpPort: number, wsPort: number) => ({
  listenHost: '127.0.0.1',
  tcpPort,
  wsPort,
  httpRouterUrls: [],
  fetchMaxStreams: 64,
  peerKeyPath: path.join(dataDir, 'votes-peer.key'),
  blockstorePath: path.join(dataDir, 'votes-blockstore'),
  datastorePath: path.join(dataDir, 'votes-datastore')
})

test('kuboPublicIp4s keeps only public IPv4s, deduplicated', () => {
  assert.deepEqual(kuboPublicIp4s(KUBO_ADDRESSES), ['203.0.113.7'])
  assert.deepEqual(kuboPublicIp4s([]), [])
  // CGNAT (100.64/10) and link-local are not borrowable public addresses.
  assert.deepEqual(kuboPublicIp4s(['/ip4/100.64.1.1/tcp/4001', '/ip4/169.254.1.1/tcp/4001']), [])
  // Real Kubo returns Multiaddr objects, not strings.
  assert.deepEqual(kuboPublicIp4s([{toString: () => '/ip4/198.51.100.9/tcp/4001'}]), ['198.51.100.9'])
})

test('createVotesNode persists its identity and can borrow the daemon Kubo public IPs', {timeout: 120_000}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-votes-node-'))

  let firstPeerId: string
  const [tcpPort, wsPort] = await Promise.all([getFreePort(), getFreePort()])
  const votesConfig = votesConfigFor(dataDir, tcpPort, wsPort)
  const helia = await createVotesNode({votesConfig, log: () => {}})
  try {
    firstPeerId = helia.libp2p.peerId.toString()

    // The persistent identity files exist and are private to the operator.
    const keyStat = fs.statSync(path.join(dataDir, 'votes-peer.key'))
    assert.equal(keyStat.mode & 0o777, 0o600)
    const passStat = fs.statSync(path.join(dataDir, 'votes-keychain.pass'))
    assert.equal(passStat.mode & 0o777, 0o600)

    // Listens on the configured TCP and websocket ports.
    const addrs: string[] = helia.libp2p.getMultiaddrs().map(String)
    assert.ok(addrs.some(addr => addr.includes(`/ip4/127.0.0.1/tcp/${tcpPort}/p2p/`)), `missing tcp listen addr in ${addrs.join(' ')}`)
    assert.ok(addrs.some(addr => addr.includes(`/tcp/${wsPort}/ws`)), `missing ws listen addr in ${addrs.join(' ')}`)

    // No Kubo has been polled yet, so nothing public is announced: the node is not created
    // with a static appendAnnounce anymore, the borrow happens on the seeder's Kubo poll.
    assert.ok(
      !addrs.some(addr => addr.includes('203.0.113.7')),
      `must not announce a borrowed IP before any Kubo poll: ${addrs.join(' ')}`
    )

    // The borrow puts Kubo's public IP on OUR ports into getMultiaddrs() — which is what the
    // votes library's router announcer and AutoTLS both read.
    const confirmed = confirmKuboPublicAddrs({
      helia,
      kuboAddresses: KUBO_ADDRESSES,
      votesConfig,
      ttlMs: 15 * 60_000
    })
    assert.deepEqual(confirmed, [`/ip4/203.0.113.7/tcp/${tcpPort}`, `/ip4/203.0.113.7/tcp/${wsPort}/ws`])

    const borrowed: string[] = helia.libp2p.getMultiaddrs().map(String)
    assert.ok(
      borrowed.some(addr => addr.startsWith(`/ip4/203.0.113.7/tcp/${tcpPort}/p2p/`)),
      `missing the borrowed tcp addr in ${borrowed.join(' ')}`
    )
    assert.ok(
      borrowed.some(addr => addr.startsWith(`/ip4/203.0.113.7/tcp/${wsPort}/ws/p2p/`)),
      `missing the borrowed ws addr in ${borrowed.join(' ')}`
    )
    // Kubo's own ports are never announced as ours, and its private addrs never leak.
    assert.ok(
      !borrowed.some(addr => addr.includes('/tcp/4001') || addr.includes('192.168.1.5') || addr.includes('172.31.0.1')),
      `borrowed the wrong addrs: ${borrowed.join(' ')}`
    )

    // Repeating the poll is idempotent (it re-arms the TTL, it does not accumulate addrs).
    confirmKuboPublicAddrs({helia, kuboAddresses: KUBO_ADDRESSES, votesConfig, ttlMs: 15 * 60_000})
    assert.deepEqual(helia.libp2p.getMultiaddrs().map(String).sort(), borrowed.sort())

    // A Kubo that reports no public addr (down, or only private interfaces) confirms nothing.
    assert.deepEqual(
      confirmKuboPublicAddrs({helia, kuboAddresses: [], votesConfig, ttlMs: 15 * 60_000}),
      []
    )

    // The services the votes library depends on are wired in.
    assert.ok(helia.libp2p.services.pubsub, 'gossipsub service missing')
    assert.ok(helia.libp2p.services.fetch, 'libp2p-fetch service missing')
  }
  finally {
    await helia.stop()
  }

  // A restart reuses the same peer identity, so the provider records and the AutoTLS domain
  // stay valid.
  const [tcpPort2, wsPort2] = await Promise.all([getFreePort(), getFreePort()])
  const restarted = await createVotesNode({
    votesConfig: votesConfigFor(dataDir, tcpPort2, wsPort2),
    log: () => {}
  })
  try {
    assert.equal(restarted.libp2p.peerId.toString(), firstPeerId)
  }
  finally {
    await restarted.stop()
    fs.rmSync(dataDir, {recursive: true, force: true})
  }
})
