const defaultCommunityListSources = 'https://api.github.com/repos/bitsocialnet/lists/contents/5chan-directories?ref=master'
// The delegated Routing V1 HTTP routers pkc-js clients query by default; the votes seeder
// announces its embedded libp2p peer to the same set so voters' findProviders() can find it.
const defaultVotesHttpRouterUrls = 'https://peers.pleb.bot,https://routing.lol,https://peers.forumindex.com,https://peers.plebpubsub.xyz'
const parseSourceList = (value = '') => value
  .split(',')
  .map(source => source.trim())
  .filter(Boolean)

export default {
  seeding: {
    // JSON URLs, local JSON files, or directories of JSON files to monitor.
    // The default points at the current 5chan directory candidate lists.
    communityListSources: parseSourceList(process.env.COMMUNITY_LIST_SOURCES || defaultCommunityListSources),
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
    // through). Defaults to the routers pkc-js clients query.
    httpRouterUrls: parseSourceList(process.env.VOTES_HTTP_ROUTER_URLS || defaultVotesHttpRouterUrls),
    // Listen host/ports for the embedded votes libp2p node. The announced addrs keep the
    // 0.0.0.0 host — the routers rewrite it to the request's observed public IP.
    listenHost: process.env.VOTES_LIBP2P_HOST || '0.0.0.0',
    tcpPort: Number(process.env.VOTES_LIBP2P_TCP_PORT || 6742),
    wsPort: Number(process.env.VOTES_LIBP2P_WS_PORT || 6743),
    // Extra/override multiaddrs to announce to the routers (e.g. a /dns4/.../wss addr
    // behind a TLS proxy, so browser voters can dial). Empty = announce the listen addrs.
    announceMultiaddrs: parseSourceList(process.env.VOTES_ANNOUNCE_MULTIADDRS || ''),
    announceIntervalMs: Number(process.env.VOTES_ANNOUNCE_INTERVAL_MS || 6 * 60 * 60 * 1000),
    reconcileIntervalMs: Number(process.env.VOTES_RECONCILE_INTERVAL_MS || 10 * 60 * 1000),
    // Per-chain RPC override, JSON: {"base": ["https://my-base-rpc"]}. Chains without an
    // override use the rpcUrls each contest's criteria.requires.chains declares.
    chainRpcUrls: JSON.parse(process.env.VOTES_CHAIN_RPC_URLS || '{}'),
    // ETH RPC URL(s) for .bso community-name resolution (one BsoResolver per URL). Votes
    // carry community names; a bundle whose name cannot be verified is never counted, so
    // a seeder without a working resolver serves next to nothing.
    bsoRpcUrls: parseSourceList(process.env.VOTES_BSO_RPC_URLS || 'https://eth.drpc.org'),
    // The embedded node's persistent peer identity (announced to the routers).
    peerKeyPath: process.env.VOTES_PEER_KEY_PATH || 'votes-peer.key',
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
