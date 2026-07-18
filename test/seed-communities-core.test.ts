import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The db path must be set before importing any module that touches lib/db.ts,
// so the whole seeding core runs against a throwaway database for this file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-core-'))
process.env.SEEDER_DB_PATH = path.join(tmpDir, 'seeder.db')
process.env.SEEDER_STATE_PATH = path.join(tmpDir, 'seederState.json')

const {
  handleCommunityUpdate,
  pinOpQueue,
  pubsubRoutingQueue,
  makeProcessPinOp,
  makeProcessPubsubRoutingProvide,
  runOneWorker
} = await import('../lib/seed-communities-core.ts')
const {db} = await import('../lib/db.ts')

test.after(() => {
  db.close()
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

const drainQueue = (queue: any) => {
  const payloads = []
  let job
  while ((job = queue.claimOne('test-drainer'))) {
    payloads.push(job.payload)
    job.ack()
  }
  return payloads
}

const communityKey = 'test-community-key'
const makeCommunity = () => ({
  address: 'testing.bso',
  updatedAt: Math.floor(Date.now() / 1000),
  posts: {
    pageCids: {hot: 'cid-page-hot', new: 'cid-page-new'},
    pages: {hot: {nextCid: 'cid-page-hot-next', comments: [{cid: 'post1'}, {cid: 'post2'}]}}
  },
  postUpdates: {86400: 'cid-post-updates'},
  pubsubTopic: 'pubsub-topic',
  pubsubTopicRoutingCid: 'cid-pubsub-routing',
  ipnsPubsubTopic: 'ipns-pubsub-topic',
  ipnsPubsubTopicRoutingCid: 'cid-ipns-pubsub-routing'
})

test('first community update enqueues content pin adds and routing provides', () => {
  handleCommunityUpdate(makeCommunity(), communityKey)

  const pinOps = drainQueue(pinOpQueue)
  assert.deepEqual(pinOps.map((op: any) => op.op), ['add', 'add', 'add', 'add'])
  assert.deepEqual(
    pinOps.map((op: any) => op.cid).sort(),
    ['cid-page-hot', 'cid-page-hot-next', 'cid-page-new', 'cid-post-updates']
  )

  const provides = drainQueue(pubsubRoutingQueue)
  assert.deepEqual(
    provides.map((op: any) => [op.cid, op.pubsubTopic]).sort(),
    [
      ['cid-ipns-pubsub-routing', 'ipns-pubsub-topic'],
      ['cid-pubsub-routing', 'pubsub-topic']
    ]
  )

  // Both content and routing cids are tracked so the staleness sweep can unpin them later.
  const trackedCids = db.query('SELECT cid FROM community_pins WHERE community_key = ?', [communityKey]).map(row => row.cid)
  assert.equal(trackedCids.length, 6)

  const throttleRows = db.query('SELECT cid, last_queued_at FROM pubsub_routing_provides WHERE community_key = ?', [communityKey])
  assert.equal(throttleRows.length, 2)
  assert.ok(throttleRows.every(row => row.last_queued_at > 0))
})

test('a repeat update with the same cids enqueues nothing', () => {
  handleCommunityUpdate(makeCommunity(), communityKey)

  assert.deepEqual(drainQueue(pinOpQueue), [])
  assert.deepEqual(drainQueue(pubsubRoutingQueue), [])
  assert.equal(db.query('SELECT COUNT(*) AS n FROM community_pins WHERE community_key = ?', [communityKey])[0].n, 6)
})

test('dropped cids enqueue stale unpins and delete their tracking rows', () => {
  const community = makeCommunity()
  delete (community.posts.pageCids as any).new
  delete (community as any).ipnsPubsubTopic
  delete (community as any).ipnsPubsubTopicRoutingCid

  handleCommunityUpdate(community, communityKey)

  const pinOps = drainQueue(pinOpQueue)
  assert.deepEqual(pinOps.map((op: any) => op.op), ['remove', 'remove'])
  assert.deepEqual(pinOps.map((op: any) => op.cid).sort(), ['cid-ipns-pubsub-routing', 'cid-page-new'])

  const trackedCids = db.query('SELECT cid FROM community_pins WHERE community_key = ?', [communityKey]).map(row => row.cid)
  assert.equal(trackedCids.includes('cid-page-new'), false)
  assert.equal(trackedCids.includes('cid-ipns-pubsub-routing'), false)
  assert.equal(trackedCids.length, 4)
})

test('routing provides stay throttled until the interval elapses', () => {
  const community = makeCommunity()
  delete (community.posts.pageCids as any).new
  delete (community as any).ipnsPubsubTopic
  delete (community as any).ipnsPubsubTopicRoutingCid

  // Recently queued in the first test — inside the 6h window, so no new provide.
  handleCommunityUpdate(community, communityKey)
  assert.deepEqual(drainQueue(pubsubRoutingQueue), [])

  // Age the throttle row past the interval and the provide is re-enqueued.
  db.query('UPDATE pubsub_routing_provides SET last_queued_at = 0 WHERE community_key = ? AND cid = ?', [communityKey, 'cid-pubsub-routing'])
  handleCommunityUpdate(community, communityKey)
  const provides = drainQueue(pubsubRoutingQueue)
  assert.deepEqual(provides.map((op: any) => op.cid), ['cid-pubsub-routing'])
  assert.deepEqual(drainQueue(pinOpQueue), [])
})

test('processPinOp pins and unpins through kubo', async () => {
  const calls: any[] = []
  const kubo = {
    pin: {
      add: async (cid: string, options: any) => calls.push(['add', cid, options]),
      rm: async (cid: string, options: any) => calls.push(['rm', cid, options])
    }
  }
  const processPinOp = makeProcessPinOp(kubo)

  await processPinOp({payload: {op: 'add', cid: 'cid-a', name: 'page hot', communityAddress: 'testing.bso'}})
  await processPinOp({payload: {op: 'remove', cid: 'cid-b', communityAddress: 'testing.bso'}})
  assert.deepEqual(calls, [
    ['add', 'cid-a', {recursive: true}],
    ['rm', 'cid-b', {recursive: true}]
  ])

  await assert.rejects(
    processPinOp({payload: {op: 'unknown-op', cid: 'cid-c', communityAddress: 'testing.bso'}}),
    /unknown pin-op 'unknown-op'/
  )
})

const makeProvideJob = (cid: string) => ({
  payload: {
    cid,
    pubsubTopic: 'pubsub-topic',
    name: 'pubsub topic routing',
    communityAddress: 'testing.bso',
    communityKey
  }
})

test('processPubsubRoutingProvide verifies the derived cid, tolerates already-pinned, refreshes the throttle row', async () => {
  const provided: string[] = []
  const kubo = {
    block: {
      put: async (bytes: Uint8Array) => {
        assert.equal(new TextDecoder().decode(bytes), 'floodsub:pubsub-topic')
        return {toString: () => 'cid-pubsub-routing'}
      }
    },
    pin: {
      add: async () => {
        throw Error('block already pinned recursively')
      }
    },
    routing: {
      provide: async function* (blockCid: any) {
        provided.push(blockCid.toString())
        yield {name: 'SENDING_QUERY'}
      }
    }
  }

  db.query('UPDATE pubsub_routing_provides SET last_queued_at = 0 WHERE community_key = ? AND cid = ?', [communityKey, 'cid-pubsub-routing'])
  await makeProcessPubsubRoutingProvide(kubo)(makeProvideJob('cid-pubsub-routing'))

  assert.deepEqual(provided, ['cid-pubsub-routing'])
  const row = db.query('SELECT last_queued_at FROM pubsub_routing_provides WHERE community_key = ? AND cid = ?', [communityKey, 'cid-pubsub-routing'])[0]
  assert.ok(row.last_queued_at > 0, 'success should restart the 6h throttle clock')
})

test('a derived cid mismatch fails the provide and resets the throttle clock', async () => {
  const kubo = {
    block: {put: async () => ({toString: () => 'cid-derived-differently'})},
    pin: {add: async () => {}},
    routing: {provide: async function* () {}}
  }

  await assert.rejects(
    makeProcessPubsubRoutingProvide(kubo)(makeProvideJob('cid-pubsub-routing')),
    /pubsub routing CID mismatch/
  )
  const row = db.query('SELECT last_queued_at FROM pubsub_routing_provides WHERE community_key = ? AND cid = ?', [communityKey, 'cid-pubsub-routing'])[0]
  assert.equal(row.last_queued_at, 0, 'failure should reset the throttle so the provide retries')
})

test('an unexpected pin error fails the provide', async () => {
  const kubo = {
    block: {put: async () => ({toString: () => 'cid-pubsub-routing'})},
    pin: {
      add: async () => {
        throw Error('kubo rpc connection refused')
      }
    },
    routing: {provide: async function* () {}}
  }

  await assert.rejects(
    makeProcessPubsubRoutingProvide(kubo)(makeProvideJob('cid-pubsub-routing')),
    /connection refused/
  )
})

test('runOneWorker acks successful jobs and retries failures with a delay', async () => {
  const queue = db.queue('test-worker-loop', {maxAttempts: 3, visibilityTimeoutS: 600})
  queue.enqueue({kind: 'ok'})
  queue.enqueue({kind: 'fail'})

  const processed: string[] = []
  const abortController = new AbortController()
  const processJob = async (job: any) => {
    processed.push(job.payload.kind)
    if (job.payload.kind === 'fail') {
      abortController.abort()
      throw Error('simulated job failure')
    }
  }

  await runOneWorker(queue, 'test-worker', abortController.signal, processJob).catch(() => {})

  assert.deepEqual(processed, ['ok', 'fail'])
  const rows = db.query(`SELECT payload, state, attempts, run_at FROM _honker_live WHERE queue = 'test-worker-loop'`)
  assert.equal(rows.length, 1, 'the acked job should be gone, the failed job should remain')
  assert.deepEqual(JSON.parse(rows[0].payload), {kind: 'fail'})
  assert.equal(rows[0].state, 'pending')
  assert.equal(rows[0].attempts, 1)
  assert.ok(rows[0].run_at > Math.floor(Date.now() / 1000) + 50, 'the retry should be delayed ~60s')
})
