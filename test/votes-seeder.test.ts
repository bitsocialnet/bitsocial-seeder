import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const getFreePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address() as net.AddressInfo
    server.close(() => resolve(port))
  })
  server.once('error', reject)
})

// A Routing V1 router that has nothing: 404 on every route. The delegated routing
// client treats that as no providers, and failed announces are the library's problem
// to swallow — either way no test traffic leaves the machine.
const fakeRouter = http.createServer((request, response) => {
  response.statusCode = 404
  response.end()
})

// Same two-contest manifest shape as votes.test.ts (5chan-directory-criteria.jsonc).
const manifestWithContests = (contests: string) => `{
  "name": "test directory",
  "defaults": {
    "voteSchema": {"min": 1, "max": 1},
    "maxVotesPerAddress": 1,
    "blocksPerBucket": 43200,
    "voteExpiryBuckets": 30,
    "rule": {"type": "erc721-min-balance", "chain": "base", "contract": "0x13d41d6B8EA5C86096bb7a94C3557FCF184491b9", "min": 1},
    "weight": {"type": "constant", "value": 1},
    "requires": {
      "rules": ["erc721-min-balance", "constant"],
      "chains": {"base": {"chainId": 8453}}
    }
  },
  "contests": [${contests}]
}`

// The votes seeder module reads the config (env) at import time, so everything —
// manifest path, temp state dirs, listen ports, and closed ports for the chain RPC,
// ETH resolvers, and the daemon Kubo (so nothing dials out) — is set before the
// dynamic import below.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-votes-seeder-'))
const manifestPath = path.join(tmpDir, 'directory-criteria.jsonc')
const routerPort = await getFreePort()
await new Promise<void>(resolve => fakeRouter.listen(routerPort, '127.0.0.1', () => resolve()))
const [tcpPort, wsPort, closedChainPort, closedEthPort, closedKuboPort] = await Promise.all([
  getFreePort(), getFreePort(), getFreePort(), getFreePort(), getFreePort()
])
process.env.VOTES_MANIFEST_SOURCES = manifestPath
process.env.VOTES_HTTP_ROUTER_URLS = `http://127.0.0.1:${routerPort}`
process.env.VOTES_LIBP2P_HOST = '127.0.0.1'
process.env.VOTES_LIBP2P_TCP_PORT = String(tcpPort)
process.env.VOTES_LIBP2P_WS_PORT = String(wsPort)
process.env.VOTES_CHAIN_RPC_URLS = JSON.stringify({base: [`http://127.0.0.1:${closedChainPort}`]})
process.env.VOTES_ETH_RPC_URLS = `http://127.0.0.1:${closedEthPort}`
process.env.VOTES_PEER_KEY_PATH = path.join(tmpDir, 'votes-peer.key')
process.env.VOTES_BLOCKSTORE_PATH = path.join(tmpDir, 'votes-blockstore')
process.env.VOTES_DATASTORE_PATH = path.join(tmpDir, 'votes-datastore')
process.env.VOTES_DATA_PATH = path.join(tmpDir, 'votes-cache')
process.env.KUBO_RPC_URL = `http://127.0.0.1:${closedKuboPort}/api/v0`

const {votesTick, destroyVotesSeeder} = await import('../lib/votes/seeder.ts')

const logs: string[] = []
const realLog = console.log
console.log = (...args: any[]) => {
  logs.push(args.map(String).join(' '))
  realLog(...args)
}

test.after(async () => {
  console.log = realLog
  await destroyVotesSeeder()
  await new Promise<void>(resolve => {
    fakeRouter.closeAllConnections()
    fakeRouter.close(() => resolve())
  })
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

test('votesTick reconciles contests against the manifests', {timeout: 300_000}, async () => {
  // No manifest file yet: the tick reports nothing derived and must NOT start the
  // embedded node.
  await votesTick()
  assert.ok(logs.some(line => line.includes('no votes contests derived yet')), logs.join('\n'))
  assert.ok(!logs.some(line => line.includes('votes node started')), 'the node must not start without contests')

  // The manifest appears with two contests: the tick starts the node and joins both.
  fs.writeFileSync(manifestPath, manifestWithContests(`
    {"contestId": "a", "name": "/a/ - Anime"},
    {"contestId": "q", "name": "/q/ - Feedback"}
  `))
  await votesTick()
  assert.ok(logs.some(line => line.includes('votes node started, peer ')), logs.join('\n'))
  assert.ok(logs.some(line => line.includes('seeding 2 votes contests')), logs.join('\n'))

  // A contest dropped from the manifest is left on the next tick.
  logs.length = 0
  fs.writeFileSync(manifestPath, manifestWithContests(`{"contestId": "a", "name": "/a/ - Anime"}`))
  await votesTick()
  assert.ok(logs.some(line => line.includes('votes /q/ left (dropped from manifest)')), logs.join('\n'))
  assert.ok(logs.some(line => line.includes('seeding 1 votes contests')), logs.join('\n'))
})

test('destroyVotesSeeder stops the voter and the embedded node', {timeout: 60_000}, async () => {
  await destroyVotesSeeder()
  // The votes listen port is released once the node is stopped.
  const portFree = await new Promise<boolean>(resolve => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(tcpPort, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
  assert.equal(portFree, true, 'expected the votes tcp port to be released')
})
