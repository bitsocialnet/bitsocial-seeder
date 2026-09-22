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
    if (updating[key]) return
    try {
      const community = await createCommunity(getCommunityLookup(entry))
      updating[key] = community
      community.on('update', () => {
        if (updating[key] !== community) return
        try { onUpdate(community, key) } catch (error) { onError(error) }
      })
      await community.update()
    }
    catch (error) { onError(error) }
  }))
}
