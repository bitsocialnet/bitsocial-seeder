import assert from 'node:assert/strict'
import test from 'node:test'
import * as dagCbor from '@ipld/dag-cbor'
import {CID} from 'multiformats/cid'
import {sha256} from 'multiformats/hashes/sha2'
import {base58btc} from 'multiformats/bases/base58'
import {describeLiveBundle, describeRootHeartbeat, describeRootRecord, parseGossipMessage} from '../lib/votes/wire-log.ts'

// The wire shapes decoded here are canonical dag-cbor layouts pinned by fixed upstream
// test vectors in @bitsocial/pubsub-voting — a change there is a breaking wire change.
// These tests pin OUR decode side: the log must say who voted for what, and never throw
// on garbage (it is a logging path).

const someCid = async (label: string) => CID.createV1(dagCbor.code, await sha256.digest(new TextEncoder().encode(label)))

const wireBundle = (votes: any[]) => dagCbor.encode({
  address: new Uint8Array([0xc4, 0x7d, 0x56, 0xe5]),
  blockNumber: 25557838,
  signature: {signature: new Uint8Array(65), type: 'eip191'},
  votes
})

test('root records decode to count/size/root — never inferred from byte length', async () => {
  const root = await someCid('root')
  const bytes = dagCbor.encode({version: 1, root, count: 2, sizeBytes: 421})
  assert.equal(describeRootRecord(bytes), `2 vote bundle(s), checkpoint 421 B, root ${root}`)
  assert.equal(describeRootRecord(new Uint8Array([1, 2, 3])), 'undecodable root record')
})

test('gossip envelopes parse into root | bundle | unknown', async () => {
  const record = {version: 1, root: await someCid('r'), count: 0, sizeBytes: 9}
  const rootMessage = parseGossipMessage(dagCbor.encode({kind: 'root', record}))
  assert.equal(rootMessage.kind, 'root')
  assert.equal(describeRootHeartbeat(rootMessage.record), `0 vote bundle(s), checkpoint 9 B, root ${record.root}`)

  const bundleMessage = parseGossipMessage(dagCbor.encode({kind: 'bundle', bundle: wireBundle([])}))
  assert.equal(bundleMessage.kind, 'bundle')
  assert.ok(bundleMessage.bundle instanceof Uint8Array)

  assert.equal(parseGossipMessage(dagCbor.encode({kind: 'mystery'})).kind, 'unknown')
  assert.equal(parseGossipMessage(new Uint8Array([0xff, 0x00])).kind, 'unknown')
})

test('live bundles decode to WHO voted for WHAT', async () => {
  const publicKey = new Uint8Array(32).fill(7)
  const bundle = wireBundle([
    {community: {name: 'anime-and-manga.bso', publicKey}, vote: 1},
    {community: {publicKey}, vote: -2} // nameless: falls back to the base58 public key
  ])
  const described = await describeLiveBundle(bundle)
  assert.match(described, /^live vote bundle \(\d+ B, cid ba/)
  assert.ok(described.includes('0xc47d56e5 votes'))
  assert.ok(described.includes('anime-and-manga.bso:+1'))
  assert.ok(described.includes(`${base58btc.encode(publicKey).slice(1)}:-2`))
  assert.ok(described.includes('at block 25557838'))
})

test('20-byte addresses log EIP-55 checksummed, matching wallet displays verbatim', async () => {
  const address = Uint8Array.from('1243527ae488a51611c7618b4a72defbfa2c62bb'.match(/../g)!.map((h) => parseInt(h, 16)))
  const bundle = dagCbor.encode({address, blockNumber: 1, signature: {signature: new Uint8Array(65), type: 'eip191'}, votes: []})
  assert.ok((await describeLiveBundle(bundle)).includes('0x1243527aE488A51611c7618b4a72DEFbfa2C62bb'))
})

test('garbage bundles never throw on the logging path', async () => {
  const described = await describeLiveBundle(new Uint8Array([0x01, 0x02]))
  assert.match(described, /undecodable bundle/)
})
