import config from '../config.js'
import {extractCommunityEntries, fetchCommunityListSource, getCommunityKey} from './utils.js'
import seederState from './seeder-state.js'
import 'dotenv/config'

const communityLists = []
const discoverCommunitiesFromLists = async () => {
  console.log(`discovering communities from ${config.seeding.communityListSources.length} list sources`)
  const promises = await Promise.allSettled(config.seeding.communityListSources.map(source => fetchCommunityListSource(source)))
  for (const [i, {status, value: communityList, reason}] of promises.entries()) {
    if (status === 'fulfilled') {
      communityLists[i] = communityList
    }
    else {
      console.log(`failed getting communities to monitor (${i + 1} of ${promises.length}): ${reason}`)
    }
  }

  const communitiesMap = new Map(seederState.communitiesSeeding?.map(community => [getCommunityKey(community), community]))
  for (const communityList of communityLists) {
    if (!communityList) {
      continue
    }
    for (const community of extractCommunityEntries(communityList)) {
      // Always overwrite the community with the latest data.
      communitiesMap.set(getCommunityKey(community), community)
    }
  }

  // Set initial state.
  if (communitiesMap.size > 0) {
    const communities = [...communitiesMap.values()]
    seederState.communitiesSeeding = config.seeding.maxCommunities ? communities.slice(0, config.seeding.maxCommunities) : communities
    console.log(`discovered ${seederState.communitiesSeeding.length} communities to seed`)
  }
}

export const discoverCommunities = () => {
  discoverCommunitiesFromLists().catch(console.log)
  setInterval(() => {
    discoverCommunitiesFromLists().catch(console.log)
  }, config.seeding.discoverIntervalMs)
}
