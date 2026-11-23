import {getCommunityKey, getCommunityLookup} from './utils.ts'

const logErrorMessage = (prefix: string) => (error: any) => console.log(`${prefix} error: ${error?.message}`)

// The scheduler awaits each tick: finish stops and creations before it can retry.
export const reconcileCommunitySubscriptions = async ({seeding, updating, createCommunity, onUpdate, onError}: {
  seeding: any[]
  updating: {[key: string]: any}
  createCommunity: (lookup: any) => Promise<any>
  onUpdate: (community: any, key: string) => void
  onError: (error: any) => void
}) => {
  const desired = new Set(seeding.map(getCommunityKey))
  for (const [key, community] of Object.entries(updating)) {
    if (desired.has(key)) continue
    // If stopping fails, retain the handle and retry before adding replacements.
    await community.stop()
    delete updating[key]
  }
  await Promise.all(seeding.map(async entry => {
    const key = getCommunityKey(entry)
    const registered = updating[key]
    // A stopped pkc-js community gets no more updates, and pkc-js can stop one on its own after
    // update() resolved (it stops a community whose subscribe-time replay throws). Replace it
    // like one whose update() failed; it needs no stop() of ours.
    if (registered?.state === 'stopped') {
      delete updating[key]
      console.log(`${registered.address || key} community stopped, subscribing again`)
    }
    else if (registered) return
    let community: any
    try {
      community = await createCommunity(getCommunityLookup(entry))
      updating[key] = community
      community.on('update', () => {
        if (updating[key] !== community) return
        try { onUpdate(community, key) } catch (error) { onError(error) }
      })
      await community.update()
    }
    catch (error) {
      onError(error)
      // pkc-js stops a community whose update() rejects, so a handle kept here would be
      // skipped above on every later tick. Drop it so the next tick subscribes afresh; the
      // stop is best-effort, since the failed update() never left a subscription behind.
      if (community && updating[key] === community) {
        delete updating[key]
        try { await community.stop() } catch (stopError) { onError(stopError) }
      }
    }
  }))
}

// The pubsub tick's join loop, with the Kubo pubsub client injected so it runs without a daemon.
export const reconcilePubsubTopics = async ({communities, joined, pubsub, lsTimeoutMs = 30_000}: {
  communities: any[]
  joined: {[pubsubTopic: string]: {community: any, unsubscribe: () => Promise<any>}}
  pubsub: {
    subscribe: (topic: string, handler: (message: any) => void, options: {onError: (error: any) => void}) => Promise<any>
    unsubscribe: (topic: string, handler: (message: any) => void) => Promise<any>
    ls: (options: {signal: AbortSignal}) => Promise<string[]>
  }
  lsTimeoutMs?: number
}) => {
  const pubsubTopics = communities.map(community => community.pubsubTopic)

  // Remove pubsub topics that no longer exist.
  for (const pubsubTopic in joined) {
    if (!pubsubTopics.includes(pubsubTopic)) {
      const {community, unsubscribe} = joined[pubsubTopic]
      unsubscribe().catch(logErrorMessage(community.address))
      delete joined[pubsubTopic]
      console.log(`${community.address} unsubscribed pubsub`)
    }
  }

  // A recorded join only means subscribe() returned. Kubo forgets its subscriptions when it
  // restarts (bitsocial-cli restarts it in place), the HTTP stream can end on its own, and
  // kubo-rpc-client reports neither to us. So forget every join Kubo no longer has and let the
  // loop below join it again; when ls() fails, Kubo is unreachable and joining would fail too.
  // kubo-rpc-client sets no timeout of its own, and this tick is awaited by the only pubsub
  // worker, so a wedged Kubo must not hold it: a timed-out ls counts as a failed one.
  if (Object.keys(joined).length) {
    let kuboTopics: Set<string> | undefined
    try {
      kuboTopics = new Set(await pubsub.ls({signal: AbortSignal.timeout(lsTimeoutMs)}))
    }
    catch (error) {
      logErrorMessage('pubsub ls')(error)
    }
    for (const pubsubTopic in joined) {
      if (!kuboTopics || kuboTopics.has(pubsubTopic)) {
        continue
      }
      const {community, unsubscribe} = joined[pubsubTopic]
      unsubscribe().catch(logErrorMessage(community.address))
      delete joined[pubsubTopic]
      console.log(`${community.address} pubsub topic no longer joined on kubo, joining again`)
    }
  }

  // Join pubsub topics.
  for (const community of communities) {
    const pubsubTopic = community.pubsubTopic
    if (!pubsubTopic || joined[pubsubTopic]) {
      continue
    }
    const onMessage = () => {
      console.log(`${community.address} new pubsub message`)
    }
    const onError = (error: any) => {
      console.log(`${community.address} pubsub subscribe onError`, error)
    }
    pubsub.subscribe(pubsubTopic, onMessage, {onError}).then(() => {
      console.log(`${community.address} subscribed pubsub`)
      const unsubscribe = () => pubsub.unsubscribe(pubsubTopic, onMessage)
      joined[pubsubTopic] = {community, unsubscribe}
    }).catch(logErrorMessage(community.address))
  }
}
