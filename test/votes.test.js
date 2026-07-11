import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {CID} from 'multiformats/cid'
import {sha256} from 'multiformats/hashes/sha2'
import {buildAnnounceBody, announceToRouters} from '../lib/votes/announce.js'
import {fetchVotesManifestSource, loadVotesCriteria} from '../lib/votes/manifest.js'
import {KuboBlockstore} from '../lib/votes/kubo-blockstore.js'

// A minimal valid manifest in the 5chan-directory-criteria.jsonc shape; two slots, one with
// a rule override, plus JSONC comments the loader must strip.
const MANIFEST_JSONC = `{
  // authoring metadata, ignored at derivation
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
      "chains": {"base": {"chainId": 8453, "rpcUrls": ["https://mainnet.base.org"]}}
    }
  },
  "contests": [
    {"contestId": "a", "name": "/a/ - Anime"},
    {
      "contestId": "q",
      "name": "/q/ - Feedback",
      // per-slot override replaces the whole rule field
      "rule": {"type": "erc721-min-balance", "chain": "base", "contract": "0x13d41d6B8EA5C86096bb7a94C3557FCF184491b9", "min": 2}
    }
  ]
}`

const writeTempManifest = (name, content) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'votes-manifest-'))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content)
  return {dir, filePath}
}

test('derives criteria from a local JSONC manifest file through the library helper', async () => {
  const {filePath} = writeTempManifest('directory.jsonc', MANIFEST_JSONC)
  const [manifest] = await fetchVotesManifestSource(filePath)
  assert.equal(manifest.contests.length, 2)

  const criteria = await loadVotesCriteria([filePath])
  assert.equal(criteria.length, 2)
  assert.equal(criteria[0].contestId, 'a')
  assert.equal(criteria[0].rule.min, 1) // inherited from defaults
  assert.equal(criteria[1].contestId, 'q')
  assert.equal(criteria[1].rule.min, 2) // whole-field override
})

test('loads every manifest file in a local directory source', async () => {
  const {dir} = writeTempManifest('one.jsonc', MANIFEST_JSONC)
  const manifests = await fetchVotesManifestSource(dir)
  assert.equal(manifests.length, 1)
  assert.equal(manifests[0].contests.length, 2)
})

test('a failing manifest source keeps serving its last good derivation', async () => {
  const {filePath} = writeTempManifest('directory.jsonc', MANIFEST_JSONC)
  const cache = []
  const first = await loadVotesCriteria([filePath], cache)
  assert.equal(first.length, 2)

  fs.rmSync(filePath) // the source disappears on the next tick
  const second = await loadVotesCriteria([filePath], cache)
  assert.equal(second.length, 2) // cached derivation still served
})

test('builds the unsigned Routing V1 announce body the routers accept', () => {
  const body = buildAnnounceBody({
    peerId: '12D3KooWNMybS8JqELi38ZBX897PrjWbCrGoMKfw3bgoqzC2n1Dh',
    addrs: ['/ip4/0.0.0.0/tcp/6742'],
    keys: ['bafyone', 'bafytwo']
  })
  assert.equal(body.Providers.length, 1)
  const [provider] = body.Providers
  assert.equal(provider.Payload.ID, '12D3KooWNMybS8JqELi38ZBX897PrjWbCrGoMKfw3bgoqzC2n1Dh')
  assert.deepEqual(provider.Payload.Addrs, ['/ip4/0.0.0.0/tcp/6742'])
  assert.deepEqual(provider.Payload.Keys, ['bafyone', 'bafytwo'])
  assert.equal(typeof provider.Payload.Timestamp, 'number')
})

test('announceToRouters PUTs to /routing/v1/providers and collects per-router failures', async () => {
  const http = await import('node:http')
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({method: req.method, url: req.url, body: JSON.parse(body)})
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end('{}')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const routerUrl = `http://127.0.0.1:${server.address().port}`

  const body = buildAnnounceBody({peerId: 'peer', addrs: ['/ip4/0.0.0.0/tcp/1'], keys: ['bafyone']})
  const downRouter = 'http://127.0.0.1:1' // nothing listens on port 1
  const {succeeded, failed} = await announceToRouters({routerUrls: [routerUrl, downRouter], body, timeoutMs: 3000})

  assert.deepEqual(succeeded, [routerUrl])
  assert.equal(failed.length, 1)
  assert.equal(failed[0].routerUrl, downRouter)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'PUT')
  assert.equal(requests[0].url, '/routing/v1/providers')
  assert.deepEqual(requests[0].body.Providers[0].Payload.Keys, ['bafyone'])

  server.close()
})

test('KuboBlockstore is local-only (offline) on reads and validates put CIDs', async () => {
  const bytes = new TextEncoder().encode('hello votes')
  const rawCid = CID.createV1(0x55, await sha256.digest(bytes))
  const calls = []
  const fakeKubo = {
    block: {
      put: async (block, options) => {
        calls.push({op: 'put', options})
        assert.equal(block, bytes)
        return rawCid
      },
      get: async (cid, options) => {
        calls.push({op: 'get', options})
        return bytes
      },
      stat: async (cid, options) => {
        calls.push({op: 'stat', options})
        throw Error(`block was not found locally (offline): ipld: could not find ${cid}`)
      }
    }
  }
  const blockstore = new KuboBlockstore(fakeKubo)

  assert.equal(await blockstore.put(rawCid, bytes), rawCid)
  assert.deepEqual(await blockstore.get(rawCid), bytes)
  assert.equal(await blockstore.has(rawCid), false) // stat "not found" → false, not a throw
  assert.equal(calls.find(c => c.op === 'get').options.offline, true)
  assert.equal(calls.find(c => c.op === 'stat').options.offline, true)

  // A put whose bytes derive a different CID than addressed must throw, never store silently.
  const otherCid = CID.createV1(0x55, await sha256.digest(new Uint8Array([1])))
  await assert.rejects(() => blockstore.put(otherCid, bytes), /derived/)
})
