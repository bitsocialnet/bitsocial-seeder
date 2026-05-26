const uniqueByCid = (items) => items.filter(({cid}, i) => cid && items.findIndex(item => item.cid === cid) === i)

export const getCommunityContentPins = (community) => {
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

  return {
    pins: uniqueByCid(cidsToPin),
    pageCidCount,
    postUpdatesCount: cidsToPin.length - pageCidCount
  }
}

export const getCommunityPubsubTopicRoutingPins = (community) => uniqueByCid([
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
