import config from '../config.js'
import {getCommunityKey, getCommunityLookup, getTimeAgo} from './utils.js'
import {getCommunityContentPins, getCommunityPubsubTopicRoutingPins} from './community-cids.js'
import seederState from './seeder-state.js'
import {kubo, kuboPubsub, pkc} from './bitsocial.js'
import {db} from './db.js'
import {isAlreadyPinnedError} from './kubo-errors.js'

const logErrorMessage = (prefix) => (error) => console.log(`${prefix} error: ${error?.message}`)
const textEncoder = new TextEncoder()

// Durable work queues. Pin operations and pubsub routing provides used to be
// p-queue instances kept entirely in memory; honker stores them as rows in the
// shared SQLite database so they survive restarts and can be retried.
export const pinOpQueue = db.queue('pin-op', {maxAttempts: 3, visibilityTimeoutS: 600})
export const pubsubRoutingQueue = db.queue('pubsub-routing-provide', {maxAttempts: 3, visibilityTimeoutS: 600})

// Runtime-only handle map: communityKey → pkc-js community object. These are
// live network handles that don't make sense to persist; they're re-created
// each time the subscribe scheduler tick runs against a not-yet-subscribed
// community.
const communitiesUpdating = {}
const pubsubTopicsJoined = {}

// Shared throttle-and-enqueue for pubsub routing provides.
// Returns true if the provide was enqueued (and the throttle row updated),
// false if the 6h throttle window has not elapsed for this (community, cid).
// The caller is responsible for owning the transaction so the enqueue + the
// throttle write commit atomically with whatever other table work it's doing.
const enqueueRoutingProvideIfStale = (tx, communityKey, communityAddress, pin, now) => {
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
const handleCommunityUpdate = (community, communityKey) => {
  const {pins: contentPins, pageCidCount, postUpdatesCount} = getCommunityContentPins(community)
  const pubsubRoutingPins = getCommunityPubsubTopicRoutingPins(community)
  const firstPagePostCount = Object.values(community.posts?.pages || {})[0]?.comments?.length
  console.log(`${community.address} updated ${getTimeAgo(community.updatedAt)}, page cids: ${pageCidCount}, post updates cids: ${postUpdatesCount}, pubsub routing cids: ${pubsubRoutingPins.length}, first page posts: ${firstPagePostCount}`)

  const allNewCids = new Set([...contentPins.map(p => p.cid), ...pubsubRoutingPins.map(p => p.cid)])
  const now = Math.floor(Date.now() / 1000)
  const provideIntervalMs = config.seeding.pubsubRoutingProvideIntervalMs

  let addedContent = 0
  let removed = 0
  let queuedRouting = 0

  const tx = db.transaction()
  try {
    const currentRows = tx.query('SELECT cid FROM community_pins WHERE community_key = ?', [communityKey])
    const currentSet = new Set(currentRows.map(r => r.cid))

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

export const subscribeCommunitiesUpdates = async () => {
  const seeding = seederState.communitiesSeeding || []
  console.log(`seeding ${seeding.length} communities`)
  for (const communityEntry of seeding) {
    const communityKey = getCommunityKey(communityEntry)
    if (communitiesUpdating[communityKey]) {
      continue
    }
    pkc.createCommunity(getCommunityLookup(communityEntry)).then(async community => {
      communitiesUpdating[communityKey] = community
      community.on('update', () => {
        communitiesUpdating[communityKey] = community
        try {
          handleCommunityUpdate(community, communityKey)
        }
        catch (error) {
          logErrorMessage(community.address)(error)
        }
      })
      await community.update()
    }).catch(console.log)
  }
}

export const providePubsubTopicRoutingCids = async () => {
  for (const [communityKey, community] of Object.entries(communitiesUpdating)) {
    const now = Math.floor(Date.now() / 1000)
    const tx = db.transaction()
    try {
      for (const pin of getCommunityPubsubTopicRoutingPins(community)) {
        enqueueRoutingProvideIfStale(tx, communityKey, community.address, pin, now)
      }
      tx.commit()
    }
    catch (error) {
      tx.rollback()
      logErrorMessage(community.address)(error)
    }
  }
}

export const joinPubsubTopics = async () => {
  const pubsubTopics = Object.values(communitiesUpdating).map(community => community.pubsubTopic)

  // Remove pubsub topics that no longer exist.
  for (const pubsubTopic in pubsubTopicsJoined) {
    if (!pubsubTopics.includes(pubsubTopic)) {
      const {community, unsubscribe} = pubsubTopicsJoined[pubsubTopic]
      unsubscribe().catch(logErrorMessage(community.address))
      delete pubsubTopicsJoined[pubsubTopic]
      console.log(`${community.address} unsubscribed pubsub`)
    }
  }

  // Join pubsub topics.
  for (const community of Object.values(communitiesUpdating)) {
    const pubsubTopic = community.pubsubTopic
    if (!pubsubTopic || pubsubTopicsJoined[pubsubTopic]) {
      continue
    }
    const onMessage = () => {
      console.log(`${community.address} new pubsub message`)
    }
    const onError = (error) => {
      console.log(`${community.address} pubsub subscribe onError`, error)
    }
    kuboPubsub.pubsub.subscribe(pubsubTopic, onMessage, {onError}).then(() => {
      console.log(`${community.address} subscribed pubsub`)
      const unsubscribe = () => kuboPubsub.pubsub.unsubscribe(pubsubTopic, onMessage)
      pubsubTopicsJoined[pubsubTopic] = {community, unsubscribe}
    }).catch(logErrorMessage(community.address))
  }
}

// --- workers ---
//
// Each worker is a long-running async loop that claims one job at a time from
// its honker queue. honker's claim() wakes within ~1ms of any commit to the
// database, so enqueue → claim latency is bounded by SQLite commit time, not
// by a polling interval.

const runOneWorker = async (queue, workerId, signal, processJob) => {
  for await (const job of queue.claim(workerId, {signal})) {
    try {
      await processJob(job)
      job.ack()
    }
    catch (error) {
      console.log(`${workerId} job ${job.id} error: ${error?.message || error}`)
      try {
        job.retry(60, String(error?.message || error))
      }
      catch (retryError) {
        console.log(`${workerId} job ${job.id} retry failed: ${retryError?.message || retryError}`)
      }
    }
  }
}

const processPinOp = async (job) => {
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

const processPubsubRoutingProvide = async (job) => {
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

export const spawnPinWorkers = (signal) => {
  const concurrency = Math.max(1, Number(config.seeding.pinConcurrency) || 2)
  const workers = []
  for (let i = 0; i < concurrency; i++) {
    workers.push(runOneWorker(pinOpQueue, `pin-op-${i}`, signal, processPinOp))
    workers.push(runOneWorker(pubsubRoutingQueue, `pubsub-routing-${i}`, signal, processPubsubRoutingProvide))
  }
  return workers
}
