import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {createVotesNode} from '../lib/votes/node.ts'

const getFreePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address() as net.AddressInfo
    server.close(() => resolve(port))
  })
  server.once('error', reject)
})

// Just enough of Kubo's /api/v0/id for kuboPublicIps: a valid peer id plus a mix of
// private and public interface addrs — only the public one may be borrowed.
const createFakeKuboIdServer = () => {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      ID: 'QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
      Addresses: [
        '/ip4/127.0.0.1/tcp/4001',
        '/ip4/192.168.1.5/tcp/4001',
        '/ip4/203.0.113.7/tcp/4001',
        '/ip4/203.0.113.7/udp/4001/quic-v1'
      ]
    }))
  })
  return {
    listen: (port: number) => new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve())),
    close: () => new Promise<void>(resolve => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }
}

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

test('createVotesNode persists its identity and borrows the daemon Kubo public IPs', {timeout: 120_000}, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-votes-node-'))
  const kuboIdFake = createFakeKuboIdServer()
  const kuboPort = await getFreePort()
  await kuboIdFake.listen(kuboPort)

  const logs: string[] = []
  const log = (message: string) => logs.push(message)

  let firstPeerId: string
  const [tcpPort, wsPort] = await Promise.all([getFreePort(), getFreePort()])
  const helia = await createVotesNode({
    votesConfig: votesConfigFor(dataDir, tcpPort, wsPort),
    kuboRpcUrl: `http://127.0.0.1:${kuboPort}/api/v0`,
    log
  })
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

    // Only Kubo's public interface addr is borrowed; loopback and LAN addrs are dropped.
    assert.ok(
      logs.some(line => line.includes(`announcing the daemon Kubo's confirmed public IP(s) 203.0.113.7`)),
      `missing the Kubo public IP borrow log in:\n${logs.join('\n')}`
    )

    // The services the votes library depends on are wired in.
    assert.ok(helia.libp2p.services.pubsub, 'gossipsub service missing')
    assert.ok(helia.libp2p.services.fetch, 'libp2p-fetch service missing')
  }
  finally {
    await helia.stop()
  }

  // A restart — with the daemon's Kubo down — reuses the same peer identity, so the
  // provider records and AutoTLS domain stay valid, and skips the public IP borrow.
  const restartLogs: string[] = []
  const [tcpPort2, wsPort2, closedKuboPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()])
  await kuboIdFake.close()
  const restarted = await createVotesNode({
    votesConfig: votesConfigFor(dataDir, tcpPort2, wsPort2),
    kuboRpcUrl: `http://127.0.0.1:${closedKuboPort}/api/v0`,
    log: (message: string) => restartLogs.push(message)
  })
  try {
    assert.equal(restarted.libp2p.peerId.toString(), firstPeerId)
    assert.ok(
      !restartLogs.some(line => line.includes('announcing the daemon Kubo')),
      'must not announce borrowed IPs when Kubo is unreachable'
    )
  }
  finally {
    await restarted.stop()
    fs.rmSync(dataDir, {recursive: true, force: true})
  }
})
