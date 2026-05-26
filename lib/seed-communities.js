import config from '../config.js'
import {getCommunityKey, getCommunityLookup, getTimeAgo} from './utils.js'
import {getCommunityContentPins, getCommunityPubsubTopicRoutingPins} from './community-cids.js'
import seederState from './seeder-state.js'
import {kubo, kuboPubsub, pkc} from './bitsocial.js'
import PQueue from 'p-queue'

const logErrorMessage = (prefix) => (error) => console.log(`${prefix} error: ${error?.message}`)
const pinQueue = new PQueue({concurrency: config.seeding.pinConcurrency})
const pubsubRoutingProvideQueue = new PQueue({concurrency: config.seeding.pinConcurrency})
const textEncoder = new TextEncoder()

// Join all IPNS over pubsub.
const communitiesUpdating = {}
const pinsToRemove = {}
const pubsubRoutingPinsLastQueuedAt = {}

const getPubsubRoutingPinKey = (communityKey, cid) => `${communityKey}:${cid}`

const shouldQueuePubsubRoutingPin = (communityKey, cid) => {
  const pinKey = getPubsubRoutingPinKey(communityKey, cid)
  const lastQueuedAt = pubsubRoutingPinsLastQueuedAt[pinKey] || 0
  return Date.now() - lastQueuedAt >= config.seeding.pubsubRoutingProvideIntervalMs
}

const storePinAndProvidePubsubTopicRoutingCid = async ({cid, pubsubTopic}) => {
  const blockCid = await kubo.block.put(textEncoder.encode(`floodsub:${pubsubTopic}`), {
    format: 'raw',
    mhtype: 'sha2-256',
    version: 1
  })
  if (blockCid.toString() !== cid) {
    throw Error(`pubsub routing CID mismatch for ${pubsubTopic}: expected ${cid}, got ${blockCid}`)
  }
  await kubo.pin.add(blockCid, {recursive: false})
  for await (const event of kubo.routing.provide(blockCid, {recursive: false})) {
    if (event?.name) {
      console.log(`${cid} provide event: ${event.name}`)
    }
  }
}

const queuePubsubRoutingProvides = (communityKey, community, pubsubRoutingPins) => {
  const pubsubRoutingPinsToQueue = pubsubRoutingPins.filter(({cid}) => shouldQueuePubsubRoutingPin(communityKey, cid))
  for (const {name, cid, pubsubTopic} of pubsubRoutingPinsToQueue) {
    const before = Date.now()
    const pinKey = getPubsubRoutingPinKey(communityKey, cid)
    pubsubRoutingPinsLastQueuedAt[pinKey] = Date.now()
    console.log(`${community.address} queueing pubsub routing provide ${cid} (${name})`)
    pubsubRoutingProvideQueue.add(() => storePinAndProvidePubsubTopicRoutingCid({cid, pubsubTopic}))
      .then(async () => {
        console.log(`${community.address} provided ${cid} (${name}) in ${(Date.now() - before) / 1000}s`)
      })
      .catch((error) => {
        delete pubsubRoutingPinsLastQueuedAt[pinKey]
        logErrorMessage(community.address)(error)
      })
  }
  return pubsubRoutingPinsToQueue.length
}

const subscribeCommunitiesUpdates = async () => {
  console.log(`seeding ${seederState.communitiesSeeding.length} communities`)
  for (const communityEntry of seederState.communitiesSeeding) {
    const communityKey = getCommunityKey(communityEntry)
    if (communitiesUpdating[communityKey]) {
      continue
    }
    pkc.createCommunity(getCommunityLookup(communityEntry)).then(async community => {
      communitiesUpdating[communityKey] = community
      community.on('update', async () => {
        communitiesUpdating[communityKey] = community

        // Every time there's a new community update, download and seed all first pages and all post updates.
        const {pins: contentPins, pageCidCount, postUpdatesCount} = getCommunityContentPins(community)
        const pubsubRoutingPins = getCommunityPubsubTopicRoutingPins(community)
        const firstPagePostCount = Object.values(community.posts?.pages || {})[0]?.comments?.length
        console.log(`${community.address} updated ${getTimeAgo(community.updatedAt)}, page cids: ${pageCidCount}, post updates cids: ${postUpdatesCount}, pubsub routing cids: ${pubsubRoutingPins.length}, first page posts: ${firstPagePostCount}`)

        const previousPins = pinsToRemove[communityKey] || []
        const previousPinsSet = new Set(previousPins)
        const nextPins = [...contentPins, ...pubsubRoutingPins].map(i => i.cid)
        const nextPinsSet = new Set(nextPins)
        const stalePins = previousPins.filter(cid => !nextPinsSet.has(cid))
        const newContentPins = contentPins.filter(({cid}) => !previousPinsSet.has(cid))
        const pubsubRoutingPinsQueued = queuePubsubRoutingProvides(communityKey, community, pubsubRoutingPins)
        if (stalePins.length === 0 && newContentPins.length === 0 && pubsubRoutingPinsQueued === 0) {
          console.log(`${community.address} pins unchanged`)
          return
        }

        // Remove stale pins.
        console.log(`${community.address} removing ${stalePins.length} stale pins`)
        for (const pin of stalePins) {
          pinQueue.add(() => kubo.pin.rm(pin, {recursive: true})).catch(logErrorMessage(community.address))
        }
        pinsToRemove[communityKey] = nextPins

        // Download and pin new cids.
        for (const {name, cid} of newContentPins) {
          const before = Date.now()
          console.log(`${community.address} queueing pin ${cid} (${name})`)
          pinQueue.add(() => kubo.pin.add(cid, {recursive: true}))
            .then(async () => {
              console.log(`${community.address} pinned ${cid} (${name}) in ${(Date.now() - before) / 1000}s`)
            })
            .catch(logErrorMessage(community.address))
        }
      })
      await community.update()
    }).catch(console.log)
  }
}

const providePubsubTopicRoutingCids = async () => {
  for (const [communityKey, community] of Object.entries(communitiesUpdating)) {
    queuePubsubRoutingProvides(communityKey, community, getCommunityPubsubTopicRoutingPins(community))
  }
}

// Join all pubsub topics.
const pubsubTopicsJoined = {}
const joinPubsubTopics = async () => {
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

export const seedCommunities = () => {
  subscribeCommunitiesUpdates().catch(console.log)
  setInterval(() => {
    subscribeCommunitiesUpdates().catch(console.log)
  }, 10 * 60 * 1000)

  setInterval(() => {
    joinPubsubTopics().catch(console.log)
    providePubsubTopicRoutingCids().catch(console.log)
  }, 60 * 1000)
}
