import {getCommunityKey, getCommunityLookup} from './utils.ts'

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
