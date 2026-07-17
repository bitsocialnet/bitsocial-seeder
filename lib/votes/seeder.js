import pLimit from 'p-limit'
import {createBsoResolvers} from '@bitsocial/bitsocial-cli/dist/common-utils/resolvers.js'
import {PubsubVoter, criteriaCid, TOPIC_PREFIX} from '@bitsocial/pubsub-voting'
import config from '../../config.js'
import {createVotesNode} from './node.js'
import {chainClientFactory} from './chains.js'
import {loadVotesCriteria} from './manifest.js'
import {describeGossipMessage, describeRootRecord} from './wire-log.js'

// Seed pubsub-voting contests: derive every configured directory manifest into criteria
// documents, join each contest read-only (no signer), and keep the set reconciled. Joining is
// all a seeder is — the library's checkpoint fetch responder registers itself on the first
// joined topic, verified bundles persist into the node's on-disk blockstore and serve over
// bitswap, root-record heartbeats answer live sync, the checkpoint snapshot persists under
// dataPath so a restart keeps the tally, and the library's built-in announcer
// (httpRouterUrls) keeps this peer registered as each contest's provider on the HTTP routers
// (hourly, debounced on joins and checkpoint changes).

const logErrorMessage = (prefix) => (error) => console.log(`${prefix} votes error: ${error?.message || error}`)

// Runtime-only handles, like communitiesUpdating: live network state that is rebuilt from the
// manifests on every tick, not persisted.
const contestsSeeding = new Map() // criteriaCid string → {contest, criteria, updated, lastLoggedAt}
const manifestCache = []
let helia
let voter

const updateLimit = pLimit(Math.max(1, Number(config.votes.updateConcurrency) || 8))

// Answers the questions production debugging actually asks — "did that voter ever reach
// us, join the topic, and pull the checkpoint?" — from the log alone. Byte counts are
// decoded through wire-log.js (a root heartbeat is constant-size regardless of votes;
// only `count` distinguishes an empty contest from a broken checkpoint).
const addNodeDiagnostics = (helia) => {
  const {libp2p} = helia
  libp2p.addEventListener('connection:open', (evt) => {
    const {remotePeer, remoteAddr} = evt.detail
    console.log(`votes conn open: ${remotePeer} via ${remoteAddr} (${libp2p.getConnections().length} conns)`)
  })
  libp2p.addEventListener('connection:close', (evt) => {
    const {remotePeer, remoteAddr} = evt.detail
    console.log(`votes conn close: ${remotePeer} via ${remoteAddr} (${libp2p.getConnections().length} conns)`)
  })
  const pubsub = libp2p.services.pubsub
  pubsub.addEventListener('subscription-change', (evt) => {
    for (const sub of evt.detail.subscriptions) {
      if (!sub.topic.startsWith(TOPIC_PREFIX)) {
        continue
      }
      console.log(`votes topic ${sub.subscribe ? 'subscribe' : 'unsubscribe'}: ${evt.detail.peerId} on ${sub.topic} (${pubsub.getSubscribers(sub.topic).length} subscriber(s))`)
    }
  })
  // Live vote bundles are rare and precious — log each one. Root heartbeats tick on every
  // contest constantly (63 topics on a full directory), so they stay out of the log; the
  // fetch-serve lines below and the per-contest tally lines carry the checkpoint state.
  pubsub.addEventListener('message', (evt) => {
    if (!evt.detail.topic.startsWith(TOPIC_PREFIX)) {
      return
    }
    const from = 'from' in evt.detail ? evt.detail.from.toString() : '(unsigned)'
    describeGossipMessage(evt.detail.data).then((described) => {
      if (!described.startsWith('root heartbeat')) {
        console.log(`votes gossip on ${evt.detail.topic} from ${from}: ${described} (${evt.detail.data.length} bytes)`)
      }
    })
  })
  // The fetch protocol has no serve event, so wrap lookup registration (the voter registers
  // its checkpoint responder through this): each cold joiner pulling a root record shows up
  // as one "fetch serve" line.
  const fetchService = libp2p.services.fetch
  const realRegister = fetchService.registerLookupFunction.bind(fetchService)
  fetchService.registerLookupFunction = (prefix, lookup) => {
    realRegister(prefix, async (key) => {
      const value = await lookup(key)
      console.log(`votes fetch serve: ${new TextDecoder().decode(key)} → ${value === undefined ? 'no value' : `${value.length} bytes: ${describeRootRecord(value)}`}`)
      return value
    })
  }
}

const ensureVoter = async () => {
  if (voter) {
    return voter
  }
  helia = await createVotesNode({votesConfig: config.votes})
  addNodeDiagnostics(helia)
  voter = new PubsubVoter({
    helia,
    chains: chainClientFactory,
    // The same .bso resolvers the daemon's pkc-js uses (bitsocial-cli's default provider
    // list unless VOTES_BSO_RPC_URLS overrides): votes carry community names, and a bundle
    // whose name cannot be verified is never counted, so a seeder without working
    // resolvers serves next to nothing.
    nameResolvers: createBsoResolvers(config.votes.bsoRpcUrls),
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

const logContestUpdate = (entry) => {
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

const joinContest = async (cidString, criteria) => {
  const contest = await voter.createContest({criteria})
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
  const desired = new Map()
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
    joins.push(updateLimit(() => joinContest(cidString, criteria)).catch((error) => {
      contestsSeeding.delete(cidString)
      logErrorMessage(`/${criteria.contestId}/`)(error)
    }))
  }
  await Promise.all(joins)
  console.log(`seeding ${contestsSeeding.size} votes contests`)
}

// voter.destroy() is what flushes the debounced checkpoint-snapshot write — start.js awaits
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
