// Announce the votes peer as the provider of each contest's criteria CID on the Routing V1
// HTTP routers — the discovery step @bitsocial/pubsub-votes deliberately leaves to the host:
// a cold-joining voter runs contentRouting.findProviders(criteriaCid) against these routers,
// dials whoever answers, and pulls the checkpoint. Announcing through the daemon's Kubo would
// advertise KUBO's peer id, which is not in the votes mesh, so the seeder announces the
// embedded node's identity itself with the same unsigned {Providers: [...]} JSON body Kubo
// sends the routers (signature verification is a routing-spec TODO the routers don't enforce).

export const buildAnnounceBody = ({peerId, addrs, keys}) => ({
  Providers: [
    {
      Schema: 'announcement',
      Protocol: 'transport-bitswap',
      Payload: {
        ID: peerId,
        Addrs: addrs,
        Keys: keys,
        Timestamp: Date.now()
      }
    }
  ]
})

// PUT the announcement to every router; per-router failures are collected, not thrown, so one
// down router never stops the others from learning the records.
export const announceToRouters = async ({routerUrls, body, timeoutMs = 30000}) => {
  const settled = await Promise.allSettled(
    routerUrls.map(async (routerUrl) => {
      const res = await fetch(new URL('/routing/v1/providers', routerUrl), {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'User-Agent': 'bitsocial-seeder'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        throw Error(`status ${res.status}`)
      }
    })
  )
  const succeeded = []
  const failed = []
  for (const [i, result] of settled.entries()) {
    if (result.status === 'fulfilled') {
      succeeded.push(routerUrls[i])
    }
    else {
      failed.push({routerUrl: routerUrls[i], error: result.reason?.message || String(result.reason)})
    }
  }
  return {succeeded, failed}
}
