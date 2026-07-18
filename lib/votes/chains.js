import {createPublicClient, createTransport, http} from 'viem'
import * as viemChains from 'viem/chains'
import {DEFAULT_PROVIDERS as ETH_DEFAULT_RPC_URLS} from '@bitsocial/bitsocial-cli/dist/common-utils/resolvers.js'
import config from '../../config.js'

// ChainClientFactory for PubsubVoter. Since pubsub-voting 0.1.x the criteria names chains
// by ticker + chainId only — RPC endpoints are deliberately NOT part of the criteria
// document (they'd fork the topic on every endpoint swap), so mapping a chain to the
// gateways this seeder trusts happens here: VOTES_CHAIN_RPC_URLS overrides per ticker,
// otherwise the viem chain's default public RPC.
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

const viemChainById = new Map(
  Object.values(viemChains)
    .filter(chain => typeof chain?.id === 'number')
    .map(chain => [chain.id, chain])
)

// Race every request across ALL the URLs and take the first success — pkc-js-style
// parallel querying, NOT viem's fallback() (sequential failover, where a dead first
// URL adds its whole timeout to every request while the healthy ones sit idle). A
// request only fails when every URL failed.
const parallelTransport = (urls) => (opts) => {
  const transports = urls.map(url => http(url)(opts))
  return createTransport({
    key: 'parallel',
    name: `parallel(${urls.join(' ')})`,
    type: 'parallel',
    async request(args) {
      try {
        return await Promise.any(transports.map(transport => transport.request(args)))
      }
      catch (error) {
        // AggregateError (all URLs failed) → surface a real per-URL error, not the wrapper.
        throw error.errors?.[0] ?? error
      }
    }
  })
}

const clients = new Map() // chainId → ChainClient

export const chainClientFactory = ({chain: chainTicker, chainId}) => {
  if (clients.has(chainId)) {
    return clients.get(chainId)
  }
  const chain = viemChainById.get(chainId)
  const overrideUrls = config.votes.chainRpcUrls?.[chainTicker]
  let urls = Array.isArray(overrideUrls) ? overrideUrls.filter(Boolean) : []
  if (urls.length === 0 && chainId === 1) {
    // ETH mainnet default: the same public RPC list bitsocial-cli hardcodes for pkc-js
    // name resolution — battle-tested endpoints, NOT viem's single default RPC (which
    // has already been unreachable from a production host and silently killed all
    // vote verification once).
    urls = [...ETH_DEFAULT_RPC_URLS]
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
const chainHealth = new Map() // chainId → 'ok' | 'failed' | 'unconfigured'

export const checkChainClients = async (criteriaList, log = console.log) => {
  const chains = new Map() // chainId → ticker
  for (const criteria of criteriaList) {
    for (const [ticker, chainConfig] of Object.entries(criteria.requires?.chains ?? {})) {
      chains.set(chainConfig.chainId, ticker)
    }
  }
  for (const [chainId, ticker] of chains) {
    let status, detail
    try {
      const client = chainClientFactory({chain: ticker, chainId})
      if (client === undefined) {
        status = 'unconfigured'
        detail = 'unknown chainId and no VOTES_CHAIN_RPC_URLS entry — this seeder recuses these contests'
      }
      else {
        detail = `block ${await client.getBlockNumber()}`
        status = 'ok'
      }
    }
    catch (error) {
      status = 'failed'
      detail = error?.shortMessage || error?.message || String(error)
    }
    if (chainHealth.get(chainId) === status) {
      continue
    }
    chainHealth.set(chainId, status)
    if (status === 'ok') {
      log(`votes chain ${ticker} (chainId ${chainId}): RPC ok, ${detail}`)
    }
    else {
      log(`votes chain ${ticker} (chainId ${chainId}): RPC ${status} — ${detail}. Without a working RPC, verification rejects EVERY incoming vote on contests requiring this chain (the tally silently stays empty). Set VOTES_CHAIN_RPC_URLS='{"${ticker}":["https://…"]}'.`)
    }
  }
}
