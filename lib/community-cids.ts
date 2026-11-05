type Pin = {name: string, cid: string, pubsubTopic?: string}

const uniqueByCid = <T extends {cid: string}>(items: T[]) => items.filter(({cid}, i) => cid && items.findIndex(item => item.cid === cid) === i)

export const getCommunityContentPins = (community: any) => {
  const cidsToPin: Pin[] = []
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

  // The community record itself. Kubo only caches it after fetching, and bitsocial-cli runs an
  // hourly repo gc, so without a pin the node loses the current record until the next publish.
  if (typeof community.updateCid === 'string') {
    cidsToPin.push({name: 'update', cid: community.updateCid})
  }

  return {
    pins: uniqueByCid(cidsToPin),
    pageCidCount,
    postUpdatesCount
  }
}

export const getCommunityPubsubTopicRoutingPins = (community: any): Pin[] => uniqueByCid([
  {
    name: 'pubsub topic routing',
    cid: community.pubsubTopicRoutingCid,
    pubsubTopic: community.pubsubTopic
  },
  {
    name: 'ipns pubsub topic routing',
    cid: community.ipnsPubsubTopicRoutingCid,
    pubsubTopic: community.ipnsPubsubTopic
  }
].filter(({cid, pubsubTopic}) => typeof cid === 'string' && typeof pubsubTopic === 'string'))
