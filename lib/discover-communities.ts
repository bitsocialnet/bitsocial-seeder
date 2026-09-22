import config from '../config.ts'
import {createHash, randomUUID} from 'node:crypto'
import {db} from './db.ts'
import {extractCommunityEntries, fetchCommunityListSource, getCommunityKey} from './utils.ts'
import seederStateModule from './seeder-state.ts'
import 'dotenv/config'

const seederState = seederStateModule as {communitiesSeeding?: any[]; discoveryCompleted?: boolean}

const communityLists: any[] = []
const extraCommunityLists: any[] = []

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

// Persist independently of list order and the optional votes node identity.
db.query('INSERT OR IGNORE INTO seeder_metadata (key, value) VALUES (?, ?)', ['community-selection-seed', randomUUID()])
const selectionSeed = db.query('SELECT value FROM seeder_metadata WHERE key = ?', ['community-selection-seed'])[0].value as string

const fetchConfiguredCommunityLists = async (sources: string[], cache: any[], label: string) => {
  if (sources.length === 0) {
    return cache.filter(Boolean)
  }

  const promises: {status: string, value?: any, reason?: any}[] = await Promise.allSettled(sources.map(source => fetchCommunityListSource(source)))
  for (const [i, {status, value: communityList, reason}] of promises.entries()) {
    if (status === 'fulfilled') {
      cache[i] = communityList
    }
    else {
      console.log(`failed getting ${label} communities to monitor (${i + 1} of ${promises.length}): ${reason}`)
    }
  }

  return cache.filter(Boolean)
}

const mergeCommunityLists = (lists: any[]) => {
  const communitiesMap = new Map()
  for (const communityList of lists) {
    if (!communityList) {
      continue
    }
    for (const community of extractCommunityEntries(communityList)) {
      // Always overwrite the community with the latest data.
      communitiesMap.set(getCommunityKey(community), community)
    }
  }
  return [...communitiesMap.values()]
}

export const mergeDiscoveredCommunities = ({communityLists, extraCommunityLists, maxCommunities, seed = selectionSeed}: {communityLists: any[], extraCommunityLists: any[], maxCommunities?: number, seed?: string}) => {
  const publicCommunities = mergeCommunityLists(communityLists)
  if (isFiniteNumber(maxCommunities) && publicCommunities.length > maxCommunities) {
    const rank = (community: any) => createHash('sha256').update(JSON.stringify([seed, getCommunityKey(community)])).digest('hex')
    const ranks = new Map(publicCommunities.map(community => [getCommunityKey(community), rank(community)]))
    publicCommunities.sort((a, b) => ranks.get(getCommunityKey(a))!.localeCompare(ranks.get(getCommunityKey(b))!))
  }
  const limitedPublicCommunities = isFiniteNumber(maxCommunities)
    ? publicCommunities.slice(0, Math.max(0, maxCommunities))
    : publicCommunities

  const communitiesMap = new Map(limitedPublicCommunities.map(community => [getCommunityKey(community), community]))
  for (const community of mergeCommunityLists(extraCommunityLists)) {
    communitiesMap.set(getCommunityKey(community), community)
  }
  return [...communitiesMap.values()]
}

export const discoverCommunitiesFromLists = async () => {
  const publicSourceCount = config.seeding.communityListSources.length
  const extraSourceCount = config.seeding.communityExtraListSources.length
  const extraSummary = extraSourceCount > 0 ? ` and ${extraSourceCount} extra list sources` : ''
  console.log(`discovering communities from ${publicSourceCount} list sources${extraSummary}`)

  const fetchedCommunityLists = await fetchConfiguredCommunityLists(
    config.seeding.communityListSources,
    communityLists,
    'list'
  )
  const fetchedExtraCommunityLists = await fetchConfiguredCommunityLists(
    config.seeding.communityExtraListSources,
    extraCommunityLists,
    'extra list'
  )

  const hasFetchedOrCachedSources = fetchedCommunityLists.length > 0 || fetchedExtraCommunityLists.length > 0
  if (!hasFetchedOrCachedSources) {
    return
  }

  const communities = mergeDiscoveredCommunities({
    communityLists: fetchedCommunityLists,
    extraCommunityLists: fetchedExtraCommunityLists,
    maxCommunities: config.seeding.maxCommunities
  })
  seederState.communitiesSeeding = communities
  // An empty result reads back as the undefined "not discovered yet" sentinel, so
  // completion is tracked separately: a votes-only seeder (zero communities, e.g.
  // COMMUNITY_LIST_SOURCES pointing at an empty local list) must still finish boot.
  seederState.discoveryCompleted = true
  console.log(`discovered ${communities.length} communities to seed`)
}
