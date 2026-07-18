import config from '../config.ts'
import {getTimeAgo} from './utils.ts'
import {getCommunityContentPins, getCommunityPubsubTopicRoutingPins} from './community-cids.ts'
import {db} from './db.ts'
import {isAlreadyPinnedError} from './kubo-errors.ts'

// This module holds the parts of community seeding that only touch the SQLite
// database and a plain community object: pin reconciliation, the durable work
// queues, and the queue workers (with the kubo handle injected). The network
// orchestration (pkc subscriptions, pubsub joins) lives in seed-communities.ts,
// which imports bitsocial.ts and therefore connects to the daemon on import.

const textEncoder = new TextEncoder()

// Durable work queues. Pin operations and pubsub routing provides used to be
// p-queue instances kept entirely in memory; honker stores them as rows in the
// shared SQLite database so they survive restarts and can be retried.
export const pinOpQueue = db.queue('pin-op', {maxAttempts: 3, visibilityTimeoutS: 600})
export const pubsubRoutingQueue = db.queue('pubsub-routing-provide', {maxAttempts: 3, visibilityTimeoutS: 600})

// Shared throttle-and-enqueue for pubsub routing provides.
// Returns true if the provide was enqueued (and the throttle row updated),
// false if the 6h throttle window has not elapsed for this (community, cid).
// The caller is responsible for owning the transaction so the enqueue + the
// throttle write commit atomically with whatever other table work it's doing.
export const enqueueRoutingProvideIfStale = (tx: any, communityKey: string, communityAddress: string, pin: any, now: number) => {
  const {cid, name, pubsubTopic} = pin
  const throttleRow = tx.query(
    'SELECT last_queued_at FROM pubsub_routing_provides WHERE community_key = ? AND cid = ?',
    [communityKey, cid]
  )[0]
  const lastQueuedAtMs = (throttleRow?.last_queued_at || 0) * 1000
  if (Date.now() - lastQueuedAtMs < config.seeding.pubsubRoutingProvideIntervalMs) {
    return false
  }
  pubsubRoutingQueue.enqueueTx(tx, {communityKey, cid, name, pubsubTopic, communityAddress})
  tx.execute(
    `INSERT INTO pubsub_routing_provides (community_key, cid, last_queued_at)
     VALUES (?, ?, ?)
     ON CONFLICT(community_key, cid) DO UPDATE SET last_queued_at = excluded.last_queued_at`,
    [communityKey, cid, now]
  )
  console.log(`${communityAddress} queueing pubsub routing provide ${cid} (${name})`)
  return true
}

// --- atomic update of pin tracking + queue enqueue ---
//
// For each community update we compute the new desired pin set and reconcile
// it against the durable `community_pins` table inside a single transaction
// that also enqueues the corresponding pin-op / pubsub-routing-provide jobs.
// honker's enqueueTx commits the queue row in the same SQLite transaction as
// our table mutation, so a crash mid-handler either lands both the bookkeeping
// row and the queued job or neither — no orphaned pins or lost work.
export const handleCommunityUpdate = (community: any, communityKey: string) => {
  const {pins: contentPins, pageCidCount, postUpdatesCount} = getCommunityContentPins(community)
  const pubsubRoutingPins = getCommunityPubsubTopicRoutingPins(community)
  const firstPagePostCount = (Object.values(community.posts?.pages || {})[0] as any)?.comments?.length
  console.log(`${community.address} updated ${getTimeAgo(community.updatedAt)}, page cids: ${pageCidCount}, post updates cids: ${postUpdatesCount}, pubsub routing cids: ${pubsubRoutingPins.length}, first page posts: ${firstPagePostCount}`)

  const allNewCids = new Set([...contentPins.map(p => p.cid), ...pubsubRoutingPins.map(p => p.cid)])
  const now = Math.floor(Date.now() / 1000)

  let addedContent = 0
  let removed = 0
  let queuedRouting = 0

  const tx = db.transaction()
  try {
    const currentRows = tx.query('SELECT cid FROM community_pins WHERE community_key = ?', [communityKey])
    const currentSet = new Set(currentRows.map((r: any) => r.cid))

    // Stale pins: anything we track for this community that isn't in the new desired set.
    for (const {cid} of currentRows) {
      if (allNewCids.has(cid)) {
        continue
      }
      pinOpQueue.enqueueTx(tx, {op: 'remove', communityKey, cid, communityAddress: community.address})
      tx.execute('DELETE FROM community_pins WHERE community_key = ? AND cid = ?', [communityKey, cid])
      removed++
    }

    // New content cids: anything in contentPins not already tracked. These go to the pin-op queue.
    for (const {cid, name} of contentPins) {
      if (currentSet.has(cid)) {
        continue
      }
      pinOpQueue.enqueueTx(tx, {op: 'add', communityKey, cid, name, communityAddress: community.address})
      tx.execute(
        `INSERT INTO community_pins (community_key, cid, name, pinned_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(community_key, cid) DO NOTHING`,
        [communityKey, cid, name ?? null, now]
      )
      addedContent++
    }

    // Pubsub routing cids: throttled re-provides (default every 6h per cid).
    // The cid is also tracked in community_pins so the staleness sweep above
    // unpins it later if the community drops the pubsub topic.
    for (const pin of pubsubRoutingPins) {
      if (enqueueRoutingProvideIfStale(tx, communityKey, community.address, pin, now)) {
        queuedRouting++
      }
      // Track in community_pins so a future tick where the cid disappears triggers an unpin.
      if (!currentSet.has(pin.cid)) {
        tx.execute(
          `INSERT INTO community_pins (community_key, cid, name, pinned_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(community_key, cid) DO NOTHING`,
          [communityKey, pin.cid, pin.name ?? null, now]
        )
      }
    }

    tx.commit()
  }
  catch (error) {
    tx.rollback()
    throw error
  }

  if (removed > 0) {
    console.log(`${community.address} queued ${removed} stale unpins`)
  }
  if (addedContent === 0 && removed === 0 && queuedRouting === 0) {
    console.log(`${community.address} pins unchanged`)
  }
}

// --- workers ---
//
// Each worker is a long-running async loop that claims one job at a time from
// its honker queue. honker's claim() wakes within ~1ms of any commit to the
// database, so enqueue → claim latency is bounded by SQLite commit time, not
// by a polling interval.

export const runOneWorker = async (queue: any, workerId: string, signal: AbortSignal, processJob: (job: any) => Promise<void>) => {
  for await (const job of queue.claim(workerId, {signal})) {
    try {
      await processJob(job)
      job.ack()
    }
    catch (error: any) {
      console.log(`${workerId} job ${job.id} error: ${error?.message || error}`)
      try {
        job.retry(60, String(error?.message || error))
      }
      catch (retryError: any) {
        console.log(`${workerId} job ${job.id} retry failed: ${retryError?.message || retryError}`)
      }
    }
  }
}

export const makeProcessPinOp = (kubo: any) => async (job: any) => {
  const {op, cid, name, communityAddress} = job.payload
  const before = Date.now()
  if (op === 'add') {
    console.log(`${communityAddress} pin add ${cid} (${name || ''})`)
    await kubo.pin.add(cid, {recursive: true})
    console.log(`${communityAddress} pinned ${cid} in ${(Date.now() - before) / 1000}s`)
  }
  else if (op === 'remove') {
    console.log(`${communityAddress} pin rm ${cid}`)
    await kubo.pin.rm(cid, {recursive: true})
  }
  else {
    throw Error(`unknown pin-op '${op}'`)
  }
}

export const makeProcessPubsubRoutingProvide = (kubo: any) => async (job: any) => {
  const {cid, pubsubTopic, name, communityAddress, communityKey} = job.payload
  const before = Date.now()
  console.log(`${communityAddress} pubsub-routing-provide ${cid} (${name || ''})`)
  try {
    const blockCid = await kubo.block.put(textEncoder.encode(`floodsub:${pubsubTopic}`), {
      format: 'raw',
      mhtype: 'sha2-256',
      version: 1
    })
    if (blockCid.toString() !== cid) {
      throw Error(`pubsub routing CID mismatch for ${pubsubTopic}: expected ${cid}, got ${blockCid}`)
    }
    try {
      await kubo.pin.add(blockCid, {recursive: false})
    }
    catch (error) {
      if (!isAlreadyPinnedError(error)) {
        throw error
      }
      console.log(`${communityAddress} pubsub routing ${cid} already pinned; continuing to provide`)
    }
    for await (const event of kubo.routing.provide(blockCid, {recursive: false})) {
      if (event?.name) {
        console.log(`${cid} provide event: ${event.name}`)
      }
    }
    // Worker succeeded — refresh the throttle row so the 6h clock starts now.
    db.query(
      `INSERT INTO pubsub_routing_provides (community_key, cid, last_queued_at)
       VALUES (?, ?, ?)
       ON CONFLICT(community_key, cid) DO UPDATE SET last_queued_at = excluded.last_queued_at`,
      [communityKey, cid, Math.floor(Date.now() / 1000)]
    )
    console.log(`${communityAddress} provided ${cid} (${name || ''}) in ${(Date.now() - before) / 1000}s`)
  }
  catch (error) {
    db.query(
      'UPDATE pubsub_routing_provides SET last_queued_at = 0 WHERE community_key = ? AND cid = ?',
      [communityKey, cid]
    )
    throw error
  }
}
