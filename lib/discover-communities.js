import config from '../config.js'
import {extractCommunityEntries, fetchCommunityListSource, getCommunityKey} from './utils.js'
import seederState from './seeder-state.js'
import 'dotenv/config'

const communityLists = []
const extraCommunityLists = []

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const fetchConfiguredCommunityLists = async (sources, cache, label) => {
  if (sources.length === 0) {
    return cache.filter(Boolean)
  }

  const promises = await Promise.allSettled(sources.map(source => fetchCommunityListSource(source)))
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

const mergeCommunityLists = (lists) => {
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

export const mergeDiscoveredCommunities = ({communityLists, extraCommunityLists, maxCommunities}) => {
  const publicCommunities = mergeCommunityLists(communityLists)
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

  seederState.communitiesSeeding = mergeDiscoveredCommunities({
    communityLists: fetchedCommunityLists,
    extraCommunityLists: fetchedExtraCommunityLists,
    maxCommunities: config.seeding.maxCommunities
  })
  console.log(`discovered ${seederState.communitiesSeeding.length} communities to seed`)
}
