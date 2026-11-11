import config from '../config.ts'
import {reconcileCommunitySubscriptions, reconcilePubsubTopics} from './community-subscriptions.ts'
import {getCommunityPubsubTopicRoutingPins} from './community-cids.ts'
import seederState from './seeder-state.ts'
import {kubo, kuboPubsub, pkc} from './bitsocial.ts'
import {db} from './db.ts'
import {
  pinOpQueue,
  pubsubRoutingQueue,
  enqueueRoutingProvideIfStale,
  handleCommunityUpdate,
  runOneWorker,
  makeProcessPinOp,
  makeProcessPubsubRoutingProvide
} from './seed-communities-core.ts'

export {pinOpQueue, pubsubRoutingQueue}

const logErrorMessage = (prefix: string) => (error: any) => console.log(`${prefix} error: ${error?.message}`)

// Runtime-only handle map: communityKey → pkc-js community object. These are
// live network handles that don't make sense to persist; they're re-created
// each time the subscribe scheduler tick runs against a not-yet-subscribed
// community.
const communitiesUpdating: {[communityKey: string]: any} = {}
const pubsubTopicsJoined: {[pubsubTopic: string]: {community: any, unsubscribe: () => Promise<any>}} = {}

export const subscribeCommunitiesUpdates = async () => {
  const seeding = seederState.communitiesSeeding || []
  console.log(`seeding ${seeding.length} communities`)
  await reconcileCommunitySubscriptions({
    seeding,
    updating: communitiesUpdating,
    createCommunity: lookup => pkc.createCommunity(lookup),
    onUpdate: handleCommunityUpdate,
    onError: console.log
  })
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

export const joinPubsubTopics = () => reconcilePubsubTopics({
  communities: Object.values(communitiesUpdating),
  joined: pubsubTopicsJoined,
  pubsub: kuboPubsub.pubsub
})

const processPinOp = makeProcessPinOp(kubo)
const processPubsubRoutingProvide = makeProcessPubsubRoutingProvide(kubo)

export const spawnPinWorkers = (signal: AbortSignal) => {
  const concurrency = Math.max(1, Number(config.seeding.pinConcurrency) || 2)
  const workers = []
  for (let i = 0; i < concurrency; i++) {
    workers.push(runOneWorker(pinOpQueue, `pin-op-${i}`, signal, processPinOp))
    workers.push(runOneWorker(pubsubRoutingQueue, `pubsub-routing-${i}`, signal, processPubsubRoutingProvide))
  }
  return workers
}
