import {createPublicClient, createTransport, http} from 'viem'
import type {Chain, Transport} from 'viem'
import * as viemChains from 'viem/chains'
import {DEFAULT_PROVIDERS as ETH_DEFAULT_RPC_URLS} from '@bitsocial/bitsocial-cli/dist/common-utils/resolvers.js'
import type {ChainClient, ChainClientFactory, Criteria} from '@bitsocial/pubsub-voting'
import config from '../../config.ts'

// ChainClientFactory for PubsubVoter. Since pubsub-voting 0.5.0 a contest names its chain
// ONCE and by numeric id (`criteria.bucketChainId`) — there is no ticker anywhere in the
// document, and rules no longer carry a `chain` option. RPC endpoints are deliberately NOT
// part of the criteria document either (they'd fork the topic on every endpoint swap), so
// mapping a chain to the gateways this seeder trusts happens here: VOTES_CHAIN_RPC_URLS
// overrides, otherwise the viem chain's default public RPC.
//
// Contract details that matter (see ChainClientFactory in @bitsocial/pubsub-voting):
// - Return ONE shared client per chainId, memoized: the voter wraps each distinct client
//   with its cross-contest read coalescer, so sharing is what merges parallel contests'
//   pinned-block gate reads into shared multicalls under one in-flight budget.
// - Pass the viem `chain` object, not just a transport: it carries the multicall3
//   deployment the background verifier batches cold-join gate reads through — without it
//   verification degrades to per-address reads and free public RPCs throttle.
// - Return undefined to recuse a chain with no RPC configured; the voter then throws
//   MissingChainClientError at createContest instead of miscounting.

const viemChainById = new Map<number, Chain>(
  (Object.values(viemChains) as Chain[])
    .filter(chain => typeof chain?.id === 'number')
    .map(chain => [chain.id, chain])
)

// VOTES_CHAIN_RPC_URLS keys, most specific first. The chain id is the canonical spelling
// now that the criteria carries nothing else, but deployments configured before 0.5.0 keyed
// this env by TICKER — so the ticker spellings keep working: the viem chain's export names
// for that id ('base', 'baseSepolia', 'mainnet'), plus 'eth' for mainnet, which is what
// bitsocial spells chainId 1 everywhere else (VOTES_ETH_RPC_URLS, the resolvers). Bumping
// the library must not silently drop an operator's RPC override and take the tally with it.
const tickersByChainId = new Map<number, string[]>()
for (const [key, chain] of Object.entries(viemChains) as [string, Chain][]) {
  if (typeof chain?.id !== 'number') {
    continue
  }
  tickersByChainId.set(chain.id, [...(tickersByChainId.get(chain.id) ?? []), key])
}
tickersByChainId.set(1, ['eth', ...(tickersByChainId.get(1) ?? [])])

const rpcUrlKeys = (chainId: number) => [String(chainId), ...(tickersByChainId.get(chainId) ?? [])]

// A human label for the logs, which used to name the ticker the criteria carried. The id is
// the identity now, so it always appears; a known chain also gets its name.
const chainLabel = (chainId: number) => {
  const ticker = tickersByChainId.get(chainId)?.[0]
  return ticker ? `${ticker} (chainId ${chainId})` : `chainId ${chainId}`
}

const overrideRpcUrls = (chainId: number) => {
  for (const key of rpcUrlKeys(chainId)) {
    const urls = config.votes.chainRpcUrls?.[key]
    const usable = Array.isArray(urls) ? urls.filter(Boolean) : []
    if (usable.length > 0) {
      return usable
    }
  }
  return []
}

// Race every request across ALL the URLs and take the first success — pkc-js-style
// parallel querying, NOT viem's fallback() (sequential failover, where a dead first
// URL adds its whole timeout to every request while the healthy ones sit idle). A
// request only fails when every URL failed.
const parallelTransport = (urls: string[]): Transport => (opts: any) => {
  const transports = urls.map((url: string) => http(url)(opts))
  return createTransport({
    key: 'parallel',
    name: `parallel(${urls.join(' ')})`,
    type: 'parallel',
    async request(args) {
      try {
        return await Promise.any(transports.map((transport: any) => transport.request(args)))
      }
      catch (error: any) {
        // AggregateError (all URLs failed) → surface a real per-URL error, not the wrapper.
        throw error.errors?.[0] ?? error
      }
    }
  })
}

const clients = new Map<number, ChainClient>() // chainId → ChainClient

export const chainClientFactory: ChainClientFactory = ({chainId}) => {
  if (clients.has(chainId)) {
    return clients.get(chainId)
  }
  const chain = viemChainById.get(chainId)
  let urls = overrideRpcUrls(chainId)
  if (urls.length === 0 && chainId === 1) {
    // ETH mainnet default: the operator's VOTES_ETH_RPC_URLS (the same URLs .bso name
    // resolution uses), else the public RPC list bitsocial-cli hardcodes for pkc-js —
    // battle-tested endpoints, NOT viem's single default RPC (which has already been
    // unreachable from a production host and silently killed all vote verification once).
    urls = config.votes.ethRpcUrls.length > 0 ? [...config.votes.ethRpcUrls] : [...ETH_DEFAULT_RPC_URLS]
  }
  if (!chain && urls.length === 0) {
    // Unknown chain and no operator-configured RPC: recuse rather than miscount.
    return undefined
  }
  const client = createPublicClient({
    // Without a matching viem chain config there is no multicall3 address, so gate reads
    // fall back to per-address calls — configure a known chainId whenever possible.
    ...(chain ? {chain} : {}),
    // No URLs configured (non-eth chain without override): the viem chain's default RPC.
    transport: urls.length > 0 ? parallelTransport(urls) : http()
  })
  clients.set(chainId, client)
  return client
}

// A broken chain RPC is the WORST votes failure mode: the verifier can't sample bucket
// blocks, so the validate-before-forward gate silently rejects every incoming bundle and
// the seeder looks healthy while counting nothing (this exact thing shipped once: viem
// mainnet's default RPC was unreachable from the host and every vote vanished without a
// log line). Probe every chain the joined contests require and log status CHANGES loudly.
const chainHealth = new Map<number, string>() // chainId → 'ok' | 'failed' | 'unconfigured'

export const checkChainClients = async (criteriaList: Criteria[], log = console.log) => {
  // One chain per contest since 0.5.0: `bucketChainId` is the clock every rule reads.
  const chainIds = new Set(criteriaList.map(criteria => criteria.bucketChainId))
  for (const chainId of chainIds) {
    let status, detail
    try {
      const client = chainClientFactory({chainId})
      if (client === undefined) {
        status = 'unconfigured'
        detail = 'unknown chainId and no VOTES_CHAIN_RPC_URLS entry — this seeder recuses these contests'
      }
      else {
        detail = `block ${await client.getBlockNumber()}`
        status = 'ok'
      }
    }
    catch (error: any) {
      status = 'failed'
      detail = error?.shortMessage || error?.message || String(error)
    }
    if (chainHealth.get(chainId) === status) {
      continue
    }
    chainHealth.set(chainId, status)
    if (status === 'ok') {
      log(`votes chain ${chainLabel(chainId)}: RPC ok, ${detail}`)
    }
    else {
      log(`votes chain ${chainLabel(chainId)}: RPC ${status} — ${detail}. Without a working RPC, verification rejects EVERY incoming vote on contests requiring this chain (the tally silently stays empty). Set VOTES_CHAIN_RPC_URLS='{"${chainId}":["https://…"]}'.`)
    }
  }
}
