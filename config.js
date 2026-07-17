export const defaultCommunityListSources = [
  'https://api.github.com/repos/bitsocialnet/lists/contents/5chan-directories?ref=master',
  'https://api.github.com/repos/bitsocialnet/lists/contents/seedit-directories?ref=master'
]
// The delegated Routing V1 HTTP routers pkc-js clients query by default; the votes library's
// built-in announcer (PubsubVoterOptions.httpRouterUrls) announces the embedded libp2p peer
// to the same set so voters' findProviders() can find it.
const defaultVotesHttpRouterUrls = 'https://peers.pleb.bot,https://routing.lol,https://peers.forumindex.com,https://peers.plebpubsub.xyz'
const parseSourceList = (value = '') => value
  .split(',')
  .map(source => source.trim())
  .filter(Boolean)

export default {
  seeding: {
    // JSON URLs, local JSON files, or directories of JSON files to monitor.
    // The defaults poll the official 5chan and Seedit directory candidate
    // folders, so additions and list changes do not require a seeder release.
    communityListSources: parseSourceList(process.env.COMMUNITY_LIST_SOURCES || defaultCommunityListSources.join(',')),
    // Operator-specific JSON URLs, local JSON files, or directories to add on
    // top of the public list sources. Extras are not capped by MAX_COMMUNITIES.
    communityExtraListSources: parseSourceList(process.env.COMMUNITY_EXTRA_LIST_SOURCES || ''),
    discoverIntervalMs: Number(process.env.DISCOVER_INTERVAL_MS || 10 * 60 * 1000),
    maxCommunities: process.env.MAX_COMMUNITIES ? Number(process.env.MAX_COMMUNITIES) : undefined,
    pinConcurrency: Number(process.env.PIN_CONCURRENCY || 2),
    pubsubRoutingProvideIntervalMs: Number(process.env.PUBSUB_ROUTING_PROVIDE_INTERVAL_MS || 6 * 60 * 60 * 1000),
  },
  votes: {
    // JSONC/JSON directory-manifest URLs, local files, or directories of manifest files
    // ({ defaults, contests } shape, e.g. 5chan-directory-criteria.jsonc). Empty = votes
    // seeding disabled.
    manifestSources: parseSourceList(process.env.VOTES_MANIFEST_SOURCES || ''),
    // Routing V1 HTTP routers to announce the votes peer to (and to look up other peers
    // through). Passed to the library's built-in announcer (hourly + debounced on checkpoint
    // changes; announces criteria CIDs, checkpoint roots, and chunk CIDs). Defaults to the
    // routers pkc-js clients query.
    httpRouterUrls: parseSourceList(process.env.VOTES_HTTP_ROUTER_URLS || defaultVotesHttpRouterUrls),
    // Listen host/ports for the embedded votes libp2p node. Listening on 0.0.0.0 makes
    // libp2p expand to the machine's interface addrs, so a host with a public interface IP
    // announces it without further config.
    listenHost: process.env.VOTES_LIBP2P_HOST || '0.0.0.0',
    tcpPort: Number(process.env.VOTES_LIBP2P_TCP_PORT || 6742),
    wsPort: Number(process.env.VOTES_LIBP2P_WS_PORT || 6743),
    // AutoTLS (libp2p.direct) gets the node a real TLS certificate once AutoNAT confirms
    // the public address, so BROWSER voters can dial the announced
    // /dns4/<peerid>.libp2p.direct/.../tls/ws addr — no reverse proxy, no manual announce
    // config. "off" only for local testing (plain /ws, no bootstrap, no certificate).
    autoTls: process.env.VOTES_AUTO_TLS !== 'off',
    // Behind provider NAT the interfaces only carry private IPs, AutoNAT may never confirm
    // the public address on its own, and the router announcer (which drops private addrs
    // client-side) would announce nothing: set the machine's public IP here to append it
    // to the announced addrs explicitly.
    publicIp: process.env.VOTES_PUBLIC_IP,
    reconcileIntervalMs: Number(process.env.VOTES_RECONCILE_INTERVAL_MS || 10 * 60 * 1000),
    // Per-chain RPC override, JSON: {"base": ["https://my-base-rpc"]}. Since pubsub-voting
    // 0.1.x RPC endpoints are the client's own setting (deliberately NOT in the criteria
    // document — swapping endpoints must not fork topics); chains without an override use
    // the viem chain's default public RPC.
    chainRpcUrls: JSON.parse(process.env.VOTES_CHAIN_RPC_URLS || '{}'),
    // ETH RPC URL(s) for .bso community-name resolution (one BsoResolver per URL). Votes
    // carry community names; a bundle whose name cannot be verified is never counted, so
    // a seeder without a working resolver serves next to nothing. Empty = the same default
    // provider list bitsocial-cli gives pkc-js.
    bsoRpcUrls: parseSourceList(process.env.VOTES_BSO_RPC_URLS || ''),
    // The embedded node's persistent peer identity (announced to the routers; the AutoTLS
    // domain embeds it). The keychain password guarding the certificate key lives next to
    // it as votes-keychain.pass.
    peerKeyPath: process.env.VOTES_PEER_KEY_PATH || 'votes-peer.key',
    // The embedded Helia node's on-disk blockstore (verified bundle blocks + checkpoint
    // chunks, served over the votes network's bitswap).
    blockstorePath: process.env.VOTES_BLOCKSTORE_PATH || 'votes-blockstore',
    // The embedded libp2p node's datastore (AutoTLS certificate + keychain persist here,
    // so restarts don't re-run ACME).
    datastorePath: process.env.VOTES_DATASTORE_PATH || 'votes-datastore',
    // The votes library's persistent state: gate-result and name-resolution caches, plus
    // each contest's checkpoint snapshot (checkpoints.db) — what keeps the tally across
    // restarts. Unset = the library default, {cwd}/.bitsocial-pubsub-voting.
    dataPath: process.env.VOTES_DATA_PATH,
    // libp2p-fetch stream cap: the default 32 inbound streams strands a directory-sized
    // cold join (63 concurrent checkpoint pulls) — raise it on a public seeder.
    fetchMaxStreams: Number(process.env.VOTES_FETCH_MAX_STREAMS || 256),
    // How many contests cold-join concurrently on reconcile.
    updateConcurrency: Number(process.env.VOTES_UPDATE_CONCURRENCY || 8)
  },
  updateCheck: {
    enabled: process.env.SEEDER_UPDATE_CHECK_ENABLED !== 'false',
    intervalMs: Number(process.env.SEEDER_UPDATE_CHECK_INTERVAL_MS || 24 * 60 * 60 * 1000),
    timeoutMs: Number(process.env.SEEDER_UPDATE_CHECK_TIMEOUT_MS || 5000)
  },
  seederState: {
    path: process.env.SEEDER_STATE_PATH || 'seederState.json',
    writeFile: process.env.SEEDER_STATE_WRITE_FILE !== 'false'
  },
  db: {
    path: process.env.SEEDER_DB_PATH || 'seeder.db'
  },
  daemon: {
    autostart: process.env.SEEDER_DAEMON_AUTOSTART !== 'false',
    dataPath: process.env.SEEDER_DAEMON_DATA_PATH,
    logPath: process.env.SEEDER_DAEMON_LOG_PATH,
    readyTimeoutMs: Number(process.env.SEEDER_DAEMON_READY_TIMEOUT_MS || 2 * 60 * 1000),
    readyStableMs: Number(process.env.SEEDER_DAEMON_READY_STABLE_MS || 2500)
  },
  pkcRpcUrl: process.env.PKC_RPC_URL || 'ws://127.0.0.1:9138',
  kuboRpcUrl: process.env.KUBO_RPC_URL || 'http://127.0.0.1:50019/api/v0',
  pubsubKuboRpcUrl: process.env.PUBSUB_KUBO_RPC_URL || process.env.KUBO_RPC_URL || 'http://127.0.0.1:50019/api/v0',
  ipfsGatewayUrl: process.env.IPFS_GATEWAY_URL || 'http://127.0.0.1:6473'
}
