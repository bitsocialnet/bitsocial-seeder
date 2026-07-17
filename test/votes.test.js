import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fetchVotesManifestSource, loadVotesCriteria} from '../lib/votes/manifest.js'

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
      "chains": {"base": {"chainId": 8453}}
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

test('a manifest carrying RPC URLs in the criteria fails derivation loudly', async () => {
  // pubsub-voting 0.1.x moved RPC endpoints OUT of the criteria document (they'd fork the
  // topic on every endpoint swap): a pre-0.1.x manifest still carrying requires.chains
  // rpcUrls must be a loud per-source error, never a silently different document.
  const stale = MANIFEST_JSONC.replace('{"chainId": 8453}', '{"chainId": 8453, "rpcUrls": ["https://mainnet.base.org"]}')
  const {filePath} = writeTempManifest('stale.jsonc', stale)
  const criteria = await loadVotesCriteria([filePath])
  assert.equal(criteria.length, 0) // derivation failed, nothing served from this source
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

test('the embedded node persists blocks in an on-disk blockstore across reopen', async () => {
  const {FsBlockstore} = await import('blockstore-fs')
  const {CID} = await import('multiformats/cid')
  const {sha256} = await import('multiformats/hashes/sha2')

  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'votes-blockstore-')), 'blocks')
  const bytes = new TextEncoder().encode('hello votes')
  const cid = CID.createV1(0x55, await sha256.digest(bytes))

  const first = new FsBlockstore(dir)
  await first.open()
  await first.put(cid, bytes)
  await first.close()

  // A restarted seeder reopens the same directory and still serves the block. In this
  // js-stores generation get() yields the block bytes as an async iterable of chunks
  // (the same shape @bitsocial/pubsub-voting normalises via adaptBlockstore).
  const second = new FsBlockstore(dir)
  await second.open()
  assert.equal(await second.has(cid), true)
  const chunks = []
  for await (const chunk of await second.get(cid)) {
    chunks.push(...chunk)
  }
  assert.deepEqual(new Uint8Array(chunks), bytes)
  await second.close()
})
