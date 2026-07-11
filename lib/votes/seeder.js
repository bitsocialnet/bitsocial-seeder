import pLimit from 'p-limit'
import {createPublicClient, http} from 'viem'
import {BsoResolver} from '@bitsocial/bso-resolver'
import {PubsubVoter, criteriaCid} from '@bitsocial/pubsub-votes'
import config from '../../config.js'
import {kubo} from '../bitsocial.js'
import {createVotesNode, votesAnnounceAddrs} from './node.js'
import {loadVotesCriteria} from './manifest.js'
import {buildAnnounceBody, announceToRouters} from './announce.js'

// Seed pubsub-votes contests: derive every configured directory manifest into criteria
// documents, join each contest read-only (no signer), and keep the set reconciled. Joining is
// all a seeder is — the library's checkpoint fetch responder registers itself on the first
// joined topic, verified bundles persist into the daemon's Kubo blockstore (KuboBlockstore)
// and serve over bitswap, and root-record heartbeats answer live sync. Discovery is the one
// host-side duty: announce this peer as each criteria CID's provider on the HTTP routers.

const logErrorMessage = (prefix) => (error) => console.log(`${prefix} votes error: ${error?.message || error}`)

// Runtime-only handles, like communitiesUpdating: live network state that is rebuilt from the
// manifests on every tick, not persisted.
const contestsSeeding = new Map() // criteriaCid string → {contest, criteria, updated, lastLoggedAt}
const manifestCache = []
let helia
let voter

const updateLimit = pLimit(Math.max(1, Number(config.votes.updateConcurrency) || 8))

// One viem client per chain ticker: the contest's criteria carries its own RPC config
// (criteria.requires.chains); VOTES_CHAIN_RPC_URLS overrides per ticker so an operator can
// point a busy public seeder at their own RPC.
const chainClientFactory = ({chain, config: chainConfig}) => {
  const overrideUrls = config.votes.chainRpcUrls?.[chain]
  const rpcUrl = (Array.isArray(overrideUrls) && overrideUrls[0]) || chainConfig.rpcUrls[0]
  return createPublicClient({transport: http(rpcUrl)})
}

const makeNameResolvers = () => config.votes.bsoRpcUrls.map((rpcUrl, i) => new BsoResolver({
  key: `bso-votes-${i}`,
  provider: rpcUrl
}))

const ensureVoter = async () => {
  if (voter) {
    return voter
  }
  helia = await createVotesNode({kubo, votesConfig: config.votes})
  voter = new PubsubVoter({
    helia,
    chains: chainClientFactory,
    nameResolvers: makeNameResolvers()
    // no signer: a seeder is read-only
  })
  console.log(`votes node started, peer ${helia.libp2p.peerId.toString()}, listening ${helia.libp2p.getMultiaddrs().map(String).join(' ')}`)
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

// The reconcile tick: (re)load the manifests, join new contests, leave removed ones, retry
// cold joins that failed last time, and re-announce when the set changed.
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

  let removed = 0
  for (const [cidString, entry] of contestsSeeding) {
    if (desired.has(cidString)) {
      continue
    }
    contestsSeeding.delete(cidString)
    removed++
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
  const added = joins.length
  await Promise.all(joins)
  console.log(`seeding ${contestsSeeding.size} votes contests`)

  if (added > 0 || removed > 0) {
    await votesAnnounceTick()
  }
}

// Announce this peer as the provider of every seeded contest's criteria CID; re-run on the
// announce scheduler cadence so the router records (24h TTL) never expire while we serve.
export const votesAnnounceTick = async () => {
  if (!voter || contestsSeeding.size === 0) {
    return
  }
  const body = buildAnnounceBody({
    peerId: helia.libp2p.peerId.toString(),
    addrs: votesAnnounceAddrs(config.votes),
    keys: [...contestsSeeding.keys()]
  })
  const {succeeded, failed} = await announceToRouters({routerUrls: config.votes.httpRouterUrls, body})
  for (const {routerUrl, error} of failed) {
    console.log(`votes announce to ${routerUrl} failed: ${error}`)
  }
  console.log(`votes announced ${contestsSeeding.size} contests to ${succeeded.length}/${config.votes.httpRouterUrls.length} routers`)
}

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
