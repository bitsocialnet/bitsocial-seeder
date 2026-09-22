import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {CID} from 'multiformats/cid'
import {sha256} from 'multiformats/hashes/sha2'
import {VotesBlockstore} from '../lib/votes/blockstore.ts'

const makeBlock = async (text: string) => {
  const bytes = new TextEncoder().encode(text)
  return {cid: CID.createV1(0x71, await sha256.digest(bytes)), bytes}
}
const read = async (store: VotesBlockstore, cid: CID) => {
  const parts = []
  for await (const bytes of store.get(cid)) parts.push(bytes)
  return Buffer.concat(parts)
}

test('GC retains live blocks, ages unreferenced blocks, and resets grace after restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'votes-gc-'))
  let now = 0
  const store = new VotesBlockstore(dir, () => now)
  await store.open()
  try {
    const live = await makeBlock('live'), stale = await makeBlock('stale')
    await store.put(live.cid, live.bytes)
    await store.put(stale.cid, stale.bytes)
    const retains = (cid: CID) => Buffer.from(cid.multihash.bytes).equals(live.cid.multihash.bytes)
    assert.equal((await store.collect(retains, 100)).removed, 0)
    now = 99
    assert.equal((await store.collect(retains, 100)).removed, 0)
    now = 100
    assert.deepEqual(await store.collect(retains, 100), {scanned: 2, removed: 1})
    assert.deepEqual(await read(store, live.cid), Buffer.from(live.bytes))
    assert.equal(await store.has(stale.cid), false)
    // Dropped contest: formerly retained block becomes eligible only after another grace.
    assert.equal((await store.collect(() => false, 100)).removed, 0)
    now = 200
    const restarted = new VotesBlockstore(dir, () => now)
    await restarted.open()
    assert.equal((await restarted.collect(() => false, 100)).removed, 0)
    now = 300
    assert.equal((await restarted.collect(() => false, 100)).removed, 1)
    await restarted.close()
  }
  finally { await store.close(); fs.rmSync(dir, {recursive: true, force: true}) }
})

test('GC protects touched blocks, active readers, and blocks retained during enumeration', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'votes-gc-race-'))
  let now = 0
  const store = new VotesBlockstore(dir, () => now)
  await store.open()
  try {
    const block = await makeBlock('active read')
    await store.put(block.cid, block.bytes)
    await store.collect(() => false, 100)
    now = 100
    const reader = store.get(block.cid)
    await reader.next() // holds the per-block lock until the generator finishes
    let finished = false
    const collecting = store.collect(() => false, 100).then(result => { finished = true; return result })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(finished, false)
    await reader.return()
    assert.equal((await collecting).removed, 0)
    now = 200
    await store.put(block.cid, block.bytes) // a put of an old CID must reset eligibility too
    assert.equal((await store.collect(() => false, 100)).removed, 0)
    now = 300
    assert.equal((await store.collect(() => true, 100)).removed, 0)
    assert.equal(await store.has(block.cid), true)
    await assert.rejects(store.collect(() => false, 0), /positive/)
  }
  finally { await store.close(); fs.rmSync(dir, {recursive: true, force: true}) }
})
