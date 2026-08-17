import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'

// Local JSON-RPC stub: answers eth_blockNumber with the given hex result, records how
// many requests it served (the parallelism proof), optionally delayed or failing.
const startRpcServer = async ({result = '0x10', delayMs = 0, status = 200} = {}) => {
  const state = {requests: 0} as {requests: number, url: string, close: () => Promise<any>}
  const server = http.createServer((req, res) => {
    state.requests++
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      setTimeout(() => {
        if (status !== 200) {
          res.writeHead(status)
          res.end()
          return
        }
        const id = (() => { try { return JSON.parse(body).id } catch { return 1 } })()
        res.writeHead(200, {'content-type': 'application/json'})
        res.end(JSON.stringify({jsonrpc: '2.0', id, result}))
      }, delayMs)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve as () => void))
  state.url = `http://127.0.0.1:${(server.address() as any).port}`
  state.close = () => new Promise((resolve) => server.close(resolve))
  return state
}

// The factory reads VOTES_CHAIN_RPC_URLS through config.ts at import time, so the servers
// must exist (ports known) before lib/votes/chains.ts is imported. node --test runs each
// test file in its own process, so this env set cannot leak into other test files.
const fast = await startRpcServer({result: '0x10'})
const slow = await startRpcServer({result: '0xff', delayMs: 300})
const broken = await startRpcServer({status: 500})
const deadUrl = 'http://127.0.0.1:1' // nothing listens on port 1

// Keyed by CHAIN ID — the canonical spelling since pubsub-voting 0.5.0, where a contest
// names its chain once as `bucketChainId` and no ticker survives anywhere in the document.
// `baseSepolia` is deliberately spelled the OLD way: pre-0.5.0 deployments configured this
// env by ticker and must keep working across the bump (see the legacy-key test below).
process.env.VOTES_CHAIN_RPC_URLS = JSON.stringify({
  '900001': [fast.url, slow.url],
  '900002': [deadUrl, fast.url],
  '900003': [deadUrl, broken.url],
  baseSepolia: [fast.url]
})
const {chainClientFactory, checkChainClients} = await import('../lib/votes/chains.ts')
const {DEFAULT_PROVIDERS} = await import('@bitsocial/bitsocial-cli/dist/common-utils/resolvers.js')

test('multiple RPC urls are queried in PARALLEL, first success wins', async () => {
  const client = chainClientFactory({chainId: 900001})
  const before = {fast: fast.requests, slow: slow.requests}
  assert.equal(await client!.getBlockNumber(), 0x10n) // the fast server's answer
  // Sequential failover would never touch the second (healthy first URL); the race
  // hits every endpoint on the SAME request.
  assert.equal(fast.requests, before.fast + 1)
  assert.equal(slow.requests, before.slow + 1)
})

test('a dead RPC among the urls does not fail (or slow) the request', async () => {
  const client = chainClientFactory({chainId: 900002})
  assert.equal(await client!.getBlockNumber(), 0x10n)
})

test('only when EVERY RPC fails does the request throw — a real error, not AggregateError', async () => {
  const client = chainClientFactory({chainId: 900003})
  await assert.rejects(client!.getBlockNumber(), (error) => !(error instanceof AggregateError))
})

test('eth mainnet defaults to the six bitsocial-cli RPC providers, raced', () => {
  const client = chainClientFactory({chainId: 1})
  assert.ok(client) // no override configured, still usable
  assert.equal(DEFAULT_PROVIDERS.length, 6)
  for (const url of DEFAULT_PROVIDERS) {
    assert.ok(client.transport.name.includes(url), `default transport races ${url}`)
  }
})

test('one memoized client per chainId — the read coalescer contract', () => {
  assert.equal(chainClientFactory({chainId: 900001}), chainClientFactory({chainId: 900001}))
})

test('unknown chain with no configured RPC recuses (undefined), never miscounts', () => {
  assert.equal(chainClientFactory({chainId: 424242424}), undefined)
})

test('a pre-0.5.0 VOTES_CHAIN_RPC_URLS keyed by TICKER still overrides that chain', async () => {
  // Deployed seeders configured this env before the criteria lost its tickers. Bumping the
  // library must not silently fall back to the chain's default public RPC — the tally would
  // quietly follow whichever endpoint the operator did NOT choose.
  const client = chainClientFactory({chainId: 84532}) // 'baseSepolia', the 5chan manifest's chain
  assert.ok(client)
  assert.ok(client.transport.name.includes(fast.url), `ticker-keyed override reaches ${fast.url}`)
  assert.equal(await client.getBlockNumber(), 0x10n)
})

test('checkChainClients logs ok/failure loudly, and only on status CHANGE', async () => {
  const lines: string[] = []
  const log = (line: string) => lines.push(line)
  // One chain per contest, named once: `bucketChainId`.
  const criteria = (bucketChainId: number): any => ({bucketChainId})

  await checkChainClients([criteria(900001)], log)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /chainId 900001: RPC ok, block 16/)

  await checkChainClients([criteria(900001)], log)
  assert.equal(lines.length, 1) // unchanged status: no repeat spam

  await checkChainClients([criteria(900003), criteria(424242424)], log)
  assert.equal(lines.length, 3)
  // The failure message must carry the operator fix — a dead RPC silently rejects
  // every incoming vote, which is exactly the failure that shipped once.
  assert.match(lines[1], /RPC failed .* rejects EVERY incoming vote .* VOTES_CHAIN_RPC_URLS/s)
  assert.match(lines[2], /unconfigured .* recuses/s)
})

test.after(async () => {
  await Promise.all([fast.close(), slow.close(), broken.close()])
})
