import config from '../config.js'
import {getCommunityKey, getCommunityLookup, getTimeAgo} from './utils.js'
import seederState from './seeder-state.js'
import {kubo, kuboPubsub, pkc} from './bitsocial.js'
import PQueue from 'p-queue'

const logErrorMessage = (prefix) => (error) => console.log(`${prefix} error: ${error?.message}`)
const pinQueue = new PQueue({concurrency: config.seeding.pinConcurrency})

// Join all IPNS over pubsub.
const communitiesUpdating = {}
const pinsToRemove = {}
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
        const cidsToPin = []
        for (const sortType in community.posts?.pageCids || {}) {
          cidsToPin.push({name: `page ${sortType}`, cid: community.posts?.pageCids[sortType]})
        }
        for (const sortType in community.posts?.pages || {}) {
          const page = community.posts.pages[sortType]
          if (page.nextCid) {
            cidsToPin.push({name: `next page ${sortType}`, cid: page.nextCid})
          }
        }
        const pageCidCount = cidsToPin.length

        for (const timeBucket in community.postUpdates || {}) {
          cidsToPin.push({name: `post updates ${timeBucket}`, cid: community.postUpdates[timeBucket]})
        }
        const postUpdatesCount = cidsToPin.length - pageCidCount
        const firstPagePostCount = Object.values(community.posts?.pages || {})[0]?.comments?.length
        console.log(`${community.address} updated ${getTimeAgo(community.updatedAt)}, page cids: ${pageCidCount}, post updates cids: ${postUpdatesCount}, first page posts: ${firstPagePostCount}`)

        const uniqueCidsToPin = cidsToPin.filter(({cid}, i) => cidsToPin.findIndex(item => item.cid === cid) === i)
        const previousPins = pinsToRemove[communityKey] || []
        const previousPinsSet = new Set(previousPins)
        const nextPins = uniqueCidsToPin.map(i => i.cid)
        const nextPinsSet = new Set(nextPins)
        const stalePins = previousPins.filter(cid => !nextPinsSet.has(cid))
        const newPins = uniqueCidsToPin.filter(({cid}) => !previousPinsSet.has(cid))
        if (stalePins.length === 0 && newPins.length === 0) {
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
        for (const {name, cid} of newPins) {
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
  }, 60 * 1000)
}
