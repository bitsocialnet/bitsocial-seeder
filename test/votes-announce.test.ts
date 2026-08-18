import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
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

type Announce = {raw: string, body: any}

// pkc-http-router's replay bounds on Payload.Timestamp (lib/signature.ts).
const MAX_TIMESTAMP_AGE_MS = 24 * 60 * 60 * 1000
const MAX_TIMESTAMP_SKEW_MS = 60 * 60 * 1000

// Stands in for a signature-verifying Routing V1 router, mimicking pkc-http-router's contract:
// an unsigned record is rejected outright with 403 'record verification failed: record has no
// Signature', and nothing is stored. Verification there is on unless VERIFY_SIGNATURES=0, so
// this — not the permissive router — is the default a seeder announces into.
const createVerifyingRouter = () => {
  const announces: Announce[] = []
  const server = http.createServer((request, response) => {
    if (request.method !== 'PUT' || !request.url?.startsWith('/routing/v1/providers')) {
      response.statusCode = 404
      response.end()
      return
    }
    let raw = ''
    request.on('data', chunk => {
      raw += chunk
    })
    request.on('end', () => {
      const json = (statusCode: number, payload: unknown) => {
        response.statusCode = statusCode
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(payload))
      }
      let body: any
      try {
        body = JSON.parse(raw)
      }
      catch {
        json(400, {Error: 'invalid body, expected {"Providers": [...]}'})
        return
      }
      announces.push({raw, body})
      const provider = body?.Providers?.[0]
      if (typeof provider?.Signature !== 'string' || !provider.Signature) {
        json(403, {Error: 'record verification failed: record has no Signature'})
        return
      }
      // pkc-http-router's verifyTimestamp rejects anything that is not a finite number, then
      // bounds it: older than 24h is stale_timestamp, more than 1h ahead is future_timestamp.
      const timestamp = provider?.Payload?.Timestamp
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        json(403, {Error: 'record verification failed: record has no Payload.Timestamp'})
        return
      }
      const now = Date.now()
      if (timestamp < now - MAX_TIMESTAMP_AGE_MS || timestamp > now + MAX_TIMESTAMP_SKEW_MS) {
        json(403, {Error: `record verification failed: Payload.Timestamp ${timestamp} is outside the accepted window`})
        return
      }
      json(200, {ProvideResults: [{Schema: 'peer'}]})
    })
  })
  return {
    announces,
    listen: (port: number) => new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve())),
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  }
}

const writeVotesManifest = (tmpDir: string) => {
  const manifestPath = path.join(tmpDir, 'directory-criteria.jsonc')
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: 'announce signature test',
    defaults: {
      voteSchema: {min: 1, max: 1},
      maxVotesPerAddress: 1,
      bucketChainId: 8453,
      blocksPerBucket: 43200,
      voteExpiryBuckets: 30,
      gate: {
        rule: {
          type: 'erc5192-min-balance',
          contract: '0x13d41d6B8EA5C86096bb7a94C3557FCF184491b9',
          min: 1
        }
      },
      weight: {type: 'constant', value: 1},
      requires: {rules: ['erc5192-min-balance', 'constant']}
    },
    contests: [{contestId: 'a', name: '/a/ - Anime & Manga'}]
  }))
  return manifestPath
}

// Regression test for bitsocialnet/pubsub-voting#38, found on production (new-plebbit): the
// announcer used to send an unsigned provider record, so every router that verifies signatures
// answered 403 and the seeder was absent from it. Four of the six default routers verify; the
// seeder was findable only on the two that do not. Fixed upstream in pubsub-voting 0.6.1, which
// signs the payload and stamps it.
//
// The fix lives in pubsub-voting — this repo only passes httpRouterUrls into the announcer and
// never builds or signs the record. This test guards the integration: whatever the library puts
// on the wire has to survive a router that checks. It fails against 0.6.0 and passes from 0.6.1.
//
// Why the library announces at all, rather than Helia doing it: Routing V1 has no standardized
// provider-write path yet (IPIP-0526, ipfs/specs#526, still an open PR), so the delegated
// routing client's provide() is a no-op and this node runs no DHT. Without the library's
// announcer nothing would publish this seeder at all. See lib/votes/node.ts.
test('votes announces carry a signature a verifying router accepts', {timeout: 120_000}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-announce-'))
  const router = createVerifyingRouter()
  const [routerPort, tcpPort, wsPort, closedKuboPort, closedChainPort, closedEthPort] =
    await Promise.all(Array.from({length: 6}, getFreePort))
  await router.listen(routerPort)

  const manifestPath = writeVotesManifest(tmpDir)

  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '..', 'start.ts')], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PKC_RPC_URL: 'ws://198.51.100.1:9138',
      KUBO_RPC_URL: `http://127.0.0.1:${closedKuboPort}/api/v0`,
      COMMUNITY_LIST_SOURCES: 'none',
      COMMUNITY_EXTRA_LIST_SOURCES: '',
      VOTES_MANIFEST_SOURCES: manifestPath,
      VOTES_HTTP_ROUTER_URLS: `http://127.0.0.1:${routerPort}`,
      // 0.0.0.0, not loopback: the announcer deliberately announces nothing from a
      // loopback-only node (sentinelAddrs excludes 127.0.0.1 as a synthesis source, since no
      // source-IP rewrite could make it dialable). Binding every interface is what production
      // does, and it is what makes libp2p report a non-loopback addr for the sentinel to be
      // synthesized from — without it no PUT is ever sent and there is nothing to assert on.
      VOTES_LIBP2P_HOST: '0.0.0.0',
      VOTES_LIBP2P_TCP_PORT: String(tcpPort),
      VOTES_LIBP2P_WS_PORT: String(wsPort),
      VOTES_CHAIN_RPC_URLS: JSON.stringify({base: [`http://127.0.0.1:${closedChainPort}`]}),
      VOTES_ETH_RPC_URLS: `http://127.0.0.1:${closedEthPort}`,
      VOTES_PEER_KEY_PATH: path.join(tmpDir, 'votes-peer.key'),
      VOTES_BLOCKSTORE_PATH: path.join(tmpDir, 'votes-blockstore'),
      VOTES_DATASTORE_PATH: path.join(tmpDir, 'votes-datastore'),
      VOTES_DATA_PATH: path.join(tmpDir, 'votes-cache'),
      SEEDER_DB_PATH: path.join(tmpDir, 'seeder.db'),
      SEEDER_STATE_PATH: path.join(tmpDir, 'seederState.json'),
      SEEDER_UPDATE_CHECK_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  const onData = (chunk: Buffer) => {
    output += chunk.toString()
  }
  child.stdout!.on('data', onData)
  child.stderr!.on('data', onData)
  const exited = new Promise<{code: number | null, signal: string | null}>(resolve => {
    child.once('exit', (code, signal) => resolve({code, signal}))
  })

  try {
    // The announcer fires on contest join (debounced), so the first PUT lands shortly after boot.
    const deadline = Date.now() + 90_000
    while (router.announces.length === 0 && Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw Error(`start.ts exited before announcing (code: ${child.exitCode})\noutput:\n${output}`)
      }
      await new Promise(r => setTimeout(r, 500))
    }
    assert.ok(router.announces.length > 0, `no provider announce reached the router\noutput:\n${output}`)

    const [{body}] = router.announces
    const provider = body?.Providers?.[0]
    assert.ok(provider, `announce carried no provider record: ${JSON.stringify(body)}`)
    assert.equal(provider.Schema, 'peer')
    assert.ok(provider.Payload?.ID, 'announce carried no Payload.ID')
    assert.ok(Array.isArray(provider.Payload?.Keys) && provider.Payload.Keys.length > 0, 'announce carried no Keys')

    // The two fields a verifying router requires, and what 0.6.0 left out.
    assert.ok(
      typeof provider.Signature === 'string' && provider.Signature.length > 0,
      `announce is unsigned, so a verifying router rejects it with 403 (pubsub-voting#38): ${JSON.stringify(provider)}`
    )
    // Stamped fresh per announce, not cached. Asserted the way the router checks it: a finite
    // *number* (a string is rejected outright as missing_timestamp, so accepting one here would
    // pass a record production drops), inside the replay window it bounds — 24h stale, 1h skew.
    // A build-time or join-time constant would drift out of that window and start failing.
    const {Timestamp} = provider.Payload
    assert.equal(typeof Timestamp, 'number', `Payload.Timestamp must be epoch ms, got ${JSON.stringify(Timestamp)}`)
    assert.ok(Number.isFinite(Timestamp), `Payload.Timestamp is not finite: ${Timestamp}`)
    const now = Date.now()
    assert.ok(
      Timestamp > now - MAX_TIMESTAMP_AGE_MS && Timestamp < now + MAX_TIMESTAMP_SKEW_MS,
      `Payload.Timestamp ${Timestamp} is outside the router's accepted window around ${now}`
    )

    // And the seeder must not be logging announce failures against a router that verifies.
    assert.doesNotMatch(output, /provider announce to router .* failed/, `announce was rejected\noutput:\n${output}`)
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await exited.catch(() => {})
    await router.close()
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})
