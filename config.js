export default {
  seeding: {
    // JSON URLs, local JSON files, or directories of JSON files to monitor.
    // The default points at the current 5chan directory candidate lists.
    communityListSources: (process.env.COMMUNITY_LIST_SOURCES || 'https://api.github.com/repos/bitsocialnet/lists/contents/5chan-directories?ref=master')
      .split(',')
      .map(source => source.trim())
      .filter(Boolean),
    discoverIntervalMs: Number(process.env.DISCOVER_INTERVAL_MS || 10 * 60 * 1000),
    maxCommunities: process.env.MAX_COMMUNITIES ? Number(process.env.MAX_COMMUNITIES) : undefined,
    pinConcurrency: Number(process.env.PIN_CONCURRENCY || 2),
    pubsubRoutingProvideIntervalMs: Number(process.env.PUBSUB_ROUTING_PROVIDE_INTERVAL_MS || 6 * 60 * 60 * 1000),
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
