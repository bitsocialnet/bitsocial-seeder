import {createPublicClient, fallback, http} from 'viem'
import * as viemChains from 'viem/chains'
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

const clients = new Map() // chainId → ChainClient

export const chainClientFactory = ({chain: chainTicker, chainId}) => {
  if (clients.has(chainId)) {
    return clients.get(chainId)
  }
  const chain = viemChainById.get(chainId)
  const overrideUrls = config.votes.chainRpcUrls?.[chainTicker]
  const urls = Array.isArray(overrideUrls) ? overrideUrls.filter(Boolean) : []
  if (!chain && urls.length === 0) {
    // Unknown chain and no operator-configured RPC: recuse rather than miscount.
    return undefined
  }
  const client = createPublicClient({
    // Without a matching viem chain config there is no multicall3 address, so gate reads
    // fall back to per-address calls — configure a known chainId whenever possible.
    ...(chain ? {chain} : {}),
    // fallback() rotates through every configured URL so one dead public RPC doesn't
    // take gate verification down; no override = the chain's default public RPC.
    transport: urls.length > 0 ? fallback(urls.map(url => http(url))) : http()
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
