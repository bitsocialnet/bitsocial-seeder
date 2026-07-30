import pLimit from 'p-limit'
import {create as createKubo} from 'kubo-rpc-client'
import {createBsoResolvers} from '@bitsocial/bitsocial-cli/dist/common-utils/resolvers.js'
import {PubsubVoter, criteriaCid, TOPIC_PREFIX} from '@bitsocial/pubsub-voting'
import type {Contest, Criteria} from '@bitsocial/pubsub-voting'
import config from '../../config.ts'
import {confirmKuboPublicAddrs, createVotesNode} from './node.ts'
import {chainClientFactory, checkChainClients} from './chains.ts'
import {loadVotesCriteria} from './manifest.ts'
import {describeLiveBundle, describeRootHeartbeat, describeRootRecord, parseGossipMessage} from './wire-log.ts'

// Seed pubsub-voting contests: derive every configured directory manifest into criteria
// documents, join each contest read-only (no signer), and keep the set reconciled. Joining is
// all a seeder is — the library's checkpoint fetch responder registers itself on the first
// joined topic, verified bundles persist into the node's on-disk blockstore and serve over
// bitswap, root-record heartbeats answer live sync, the checkpoint snapshot persists under
// dataPath so a restart keeps the tally, and the library's built-in announcer
// (httpRouterUrls) keeps this peer registered as each contest's provider on the HTTP routers
// (hourly, debounced on joins and checkpoint changes).

const logErrorMessage = (prefix: string) => (error: any) => console.log(`${prefix} votes error: ${error?.message || error}`)

type ContestEntry = {contest: Contest, criteria: Criteria, updated: boolean, lastLoggedAt: number}

// Runtime-only handles, like communitiesUpdating: live network state that is rebuilt from the
// manifests on every tick, not persisted.
const contestsSeeding = new Map<string, ContestEntry>() // criteriaCid string → {contest, criteria, updated, lastLoggedAt}
const manifestCache: Criteria[][] = []
let helia: any
let voter: PubsubVoter | undefined

const updateLimit = pLimit(Math.max(1, Number(config.votes.updateConcurrency) || 8))

// Answers the questions production debugging actually asks — "did that voter ever reach
// us, join the topic, and pull the checkpoint?" — from the log alone. Byte counts are
// decoded through wire-log.ts (a root heartbeat is constant-size regardless of votes;
// only `count` distinguishes an empty contest from a broken checkpoint).
const addNodeDiagnostics = (helia: any) => {
  const {libp2p} = helia
  libp2p.addEventListener('connection:open', (evt: any) => {
    const {remotePeer, remoteAddr} = evt.detail
    console.log(`votes conn open: ${remotePeer} via ${remoteAddr} (${libp2p.getConnections().length} conns)`)
  })
  libp2p.addEventListener('connection:close', (evt: any) => {
    const {remotePeer, remoteAddr} = evt.detail
    console.log(`votes conn close: ${remotePeer} via ${remoteAddr} (${libp2p.getConnections().length} conns)`)
  })
  const pubsub = libp2p.services.pubsub
  pubsub.addEventListener('subscription-change', (evt: any) => {
    for (const sub of evt.detail.subscriptions) {
      if (!sub.topic.startsWith(TOPIC_PREFIX)) {
        continue
      }
      console.log(`votes topic ${sub.subscribe ? 'subscribe' : 'unsubscribe'}: ${evt.detail.peerId} on ${sub.topic} (${pubsub.getSubscribers(sub.topic).length} subscriber(s))`)
    }
  })
  // Live vote bundles are rare and precious — log each one, decoded (who voted for what).
  // Root heartbeats tick constantly on every contest (63 topics on a full directory), so
  // log them only when a peer's observed root CHANGES — a changing or diverging peer root
  // is the anti-entropy signal worth seeing (peer has bundles we don't, or vice versa).
  const lastPeerRoots = new Map() // topic → last observed peer root CID string
  pubsub.addEventListener('message', (evt: any) => {
    if (!evt.detail.topic.startsWith(TOPIC_PREFIX)) {
      return
    }
    const from = 'from' in evt.detail ? evt.detail.from.toString() : '(unsigned)'
    const message = parseGossipMessage(evt.detail.data)
    if (message.kind === 'root') {
      const rootString = String(message.record.root)
      if (lastPeerRoots.get(evt.detail.topic) === rootString) {
        return
      }
      lastPeerRoots.set(evt.detail.topic, rootString)
      console.log(`votes peer root on ${evt.detail.topic} from ${from}: ${describeRootHeartbeat(message.record)}`)
    }
    else if (message.kind === 'bundle') {
      describeLiveBundle(message.bundle).then((described) =>
        console.log(`votes gossip on ${evt.detail.topic} from ${from}: ${described}`))
    }
    else {
      console.log(`votes gossip on ${evt.detail.topic} from ${from}: unknown message kind (${evt.detail.data.length} bytes)`)
    }
  })
  // The fetch protocol has no serve event, so wrap lookup registration (the voter registers
  // its checkpoint responder through this): each cold joiner pulling a root record shows up
  // as one "fetch serve" line.
  const fetchService = libp2p.services.fetch
  const realRegister = fetchService.registerLookupFunction.bind(fetchService)
  fetchService.registerLookupFunction = (prefix: any, lookup: any) => {
    realRegister(prefix, async (key: any) => {
      const value = await lookup(key)
      console.log(`votes fetch serve: ${new TextDecoder().decode(key)} → ${value === undefined ? 'no value' : `${value.length} bytes: ${describeRootRecord(value)}`}`)
      return value
    })
  }
}

// The pre-warm hint. The machine's Kubo node serves community content — same host, DIFFERENT
// peer id — so a browser that just dialed the votes node still pays a full router discovery +
// dial (~1.4s, measured) for Kubo when its first leaderboard resolves. This fetch key hands a
// connected voter the Kubo peer's browser-dialable addrs so it can dial while the votes cold
// pull is still running. Discovery-driven by construction: the votes node was itself found
// through the routers, and the addrs are read live from Kubo, so nothing rots when the Kubo
// key is regenerated (the failure that killed the hardcoded pre-warm). The addrs are dial
// HINTS with the peer id embedded — a dial either authenticates that key or fails, exactly as
// with router-served addrs, so this adds no trust surface.
//
// Note this stays worth doing on a votes-only seeder: what matters is whether a
// community-serving Kubo is reachable at KUBO_RPC_URL, not whether this process is the one
// pinning the communities.
const KUBO_PEERS_FETCH_KEY_PREFIX = 'bitsocial-seeder/'
const KUBO_PEERS_FETCH_KEY = `${KUBO_PEERS_FETCH_KEY_PREFIX}peers`

// One poll of the local Kubo feeds both opportunistic uses of it: the pre-warm hint above and
// the public-IP borrow that gets this node announced (confirmKuboPublicAddrs). Periodic rather
// than once at startup, because a votes-only seeder never waits for a daemon — Kubo may come
// up minutes or hours after the votes node, or restart under it, or never exist at all. The
// confirmation TTL spans a few polls so a couple of failed ones don't flap the announced
// addrs; past that AutoNAT takes over verifying them.
const KUBO_REFRESH_MS = 5 * 60_000
const KUBO_ADDR_TTL_MS = 3 * KUBO_REFRESH_MS

let kuboBrowserAddrs: string[] = []
let kuboConfirmedAddrs: string[] = []

// Browsers can only dial secure websockets — the AutoTLS /dns4/….libp2p.direct/…/tls/ws addr.
const isBrowserDialable = (addr: string) => addr.includes('/tls/ws') || addr.includes('/wss')

const refreshFromKubo = async (helia: any) => {
  try {
    const kubo = createKubo({url: config.kuboRpcUrl})
    const {id, addresses} = await kubo.id({timeout: 10_000})
    const idString = String(id)
    const addrs = [...new Set(
      addresses
        .map(String)
        .filter(isBrowserDialable)
        .map((addr) => addr.includes('/p2p/') ? addr : `${addr}/p2p/${idString}`)
    )]
    if (addrs.length > 0 && addrs.join(' ') !== kuboBrowserAddrs.join(' ')) {
      console.log(`votes peers hint: serving Kubo addr(s) ${addrs.join(' ')}`)
    }
    kuboBrowserAddrs = addrs

    const confirmed = confirmKuboPublicAddrs({
      helia,
      kuboAddresses: addresses,
      votesConfig: config.votes,
      ttlMs: KUBO_ADDR_TTL_MS
    })
    // Re-confirming an already-confirmed addr is silent inside libp2p (no self:peer:update
    // unless confidence changed), so log on change only — this fires every 5 minutes.
    if (confirmed.length > 0 && confirmed.join(' ') !== kuboConfirmedAddrs.join(' ')) {
      console.log(`votes node: announcing the daemon Kubo's confirmed public IP(s) on the votes ports: ${confirmed.join(' ')}`)
    }
    kuboConfirmedAddrs = confirmed
  }
  catch {
    // Kubo down is normal (votes seeding must survive it) — keep serving the last answer, and
    // let the borrowed addrs age out into AutoNAT's hands.
  }
}

const startKuboRefresh = (helia: any) => {
  void refreshFromKubo(helia)
  const timer = setInterval(() => void refreshFromKubo(helia), KUBO_REFRESH_MS)
  timer.unref?.()
}

const registerKuboPeersHint = (helia: any) => {
  helia.libp2p.services.fetch.registerLookupFunction(KUBO_PEERS_FETCH_KEY_PREFIX, async (keyBytes: Uint8Array) => {
    if (new TextDecoder().decode(keyBytes) !== KUBO_PEERS_FETCH_KEY || kuboBrowserAddrs.length === 0) {
      return undefined
    }
    return new TextEncoder().encode(JSON.stringify({kubo: kuboBrowserAddrs}))
  })
}

const ensureVoter = async () => {
  if (voter) {
    return voter
  }
  helia = await createVotesNode({votesConfig: config.votes})
  addNodeDiagnostics(helia)
  registerKuboPeersHint(helia)
  startKuboRefresh(helia)
  voter = new PubsubVoter({
    helia,
    chains: chainClientFactory,
    // The same .bso resolvers the daemon's pkc-js uses (bitsocial-cli's default provider
    // list unless VOTES_ETH_RPC_URLS overrides): votes carry community names, and a bundle
    // whose name cannot be verified is never counted, so a seeder without working
    // resolvers serves next to nothing.
    nameResolvers: createBsoResolvers(config.votes.ethRpcUrls),
    dataPath: config.votes.dataPath,
    httpRouterUrls: config.votes.httpRouterUrls
    // no signer: a seeder is read-only
  })
  console.log(`votes node started, peer ${helia.libp2p.peerId.toString()}, listening ${helia.libp2p.getMultiaddrs().map(String).join(' ')}`)
  // Surface the announced addrs whenever they change — this is where the AutoTLS
  // /dns4/<peerid>.libp2p.direct/.../tls/ws browser-dialable addr shows up once the
  // certificate lands.
  let lastAddrs = ''
  helia.libp2p.addEventListener('self:peer:update', () => {
    const addrs = helia.libp2p.getMultiaddrs().map(String).join(' ')
    if (addrs && addrs !== lastAddrs) {
      lastAddrs = addrs
      console.log(`votes node addrs: ${addrs}`)
    }
  })
  return voter
}

const logContestUpdate = (entry: ContestEntry) => {
  // Tally updates arrive in bursts (cold-join settlement, gossip); one line per contest per
  // minute is enough operational signal.
  if (Date.now() - (entry.lastLoggedAt || 0) < 60_000) {
    return
  }
  entry.lastLoggedAt = Date.now()
  const winner = entry.contest.tally?.ranking?.[0]?.community
  const label = winner ? (winner.name || winner.publicKey) : '(no votes yet)'
  console.log(`votes /${entry.criteria.contestId}/ tally updated, top: ${label}`)
}

const joinContest = async (cidString: string, criteria: Criteria) => {
  const contest = await voter!.createContest({criteria})
  const entry = {contest, criteria, updated: false, lastLoggedAt: 0}
  contest.on('update', () => logContestUpdate(entry))
  contest.on('error', logErrorMessage(`/${criteria.contestId}/`))
  contestsSeeding.set(cidString, entry)
  await contest.update()
  entry.updated = true
  console.log(`votes /${criteria.contestId}/ joined (topic ${contest.topic})`)
}

// The reconcile tick: (re)load the manifests, join new contests, leave removed ones, and
// retry cold joins that failed last time. Router announces need no step here: the library's
// announcer debounce-fires on every join and checkpoint change.
export const votesTick = async () => {
  const allCriteria = await loadVotesCriteria(config.votes.manifestSources, manifestCache)
  if (allCriteria.length === 0 && contestsSeeding.size === 0) {
    console.log('no votes contests derived yet')
    return
  }

  // Key every contest by its criteria CID (the topic identity) and drop duplicates across
  // manifest sources: same document = same topic = one contest.
  const desired = new Map<string, Criteria>()
  for (const criteria of allCriteria) {
    const cid = await criteriaCid(criteria)
    desired.set(cid.toString(), criteria)
  }

  await ensureVoter()

  for (const [cidString, entry] of contestsSeeding) {
    if (desired.has(cidString)) {
      continue
    }
    contestsSeeding.delete(cidString)
    entry.contest.stop().catch(logErrorMessage(`/${entry.criteria.contestId}/`))
    console.log(`votes /${entry.criteria.contestId}/ left (dropped from manifest)`)
  }

  const joins = []
  for (const [cidString, criteria] of desired) {
    const existing = contestsSeeding.get(cidString)
    if (existing) {
      if (!existing.updated) {
        // A cold join that failed on a previous tick; update() is idempotent, retry it.
        joins.push(updateLimit(async () => {
          await existing.contest.update()
          existing.updated = true
        }).catch(logErrorMessage(`/${criteria.contestId}/`)))
      }
      continue
    }
    // Keep the entry on failure: joinContest registered it with updated:false before
    // update(), so the retry branch above re-runs the idempotent update() next tick —
    // deleting it would re-createContest a contest that was never stopped.
    joins.push(updateLimit(() => joinContest(cidString, criteria)).catch(logErrorMessage(`/${criteria.contestId}/`)))
  }
  await Promise.all(joins)
  console.log(`seeding ${contestsSeeding.size} votes contests`)

  // Probe every chain the joined contests verify against; a dead RPC means every incoming
  // vote is silently rejected, so it must be loud in the log (reported on status change).
  await checkChainClients(allCriteria).catch(logErrorMessage('chain health'))
}

// voter.destroy() is what flushes the debounced checkpoint-snapshot write — start.ts awaits
// these cleanups (racing the shutdown grace window) so a restart doesn't lose the tally.
export const destroyVotesSeeder = async () => {
  try {
    await voter?.destroy()
  }
  catch (error) {
    logErrorMessage('destroy')(error)
  }
  try {
    await helia?.stop()
  }
  catch (error) {
    logErrorMessage('destroy')(error)
  }
}
