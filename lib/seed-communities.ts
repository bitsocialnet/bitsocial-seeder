import config from '../config.ts'
import {getCommunityKey, getCommunityLookup} from './utils.ts'
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
    const onError = (error: any) => {
      console.log(`${community.address} pubsub subscribe onError`, error)
    }
    kuboPubsub.pubsub.subscribe(pubsubTopic, onMessage, {onError}).then(() => {
      console.log(`${community.address} subscribed pubsub`)
      const unsubscribe = () => kuboPubsub.pubsub.unsubscribe(pubsubTopic, onMessage)
      pubsubTopicsJoined[pubsubTopic] = {community, unsubscribe}
    }).catch(logErrorMessage(community.address))
  }
}

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
