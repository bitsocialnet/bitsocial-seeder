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
  },
  seederState: {
    path: process.env.SEEDER_STATE_PATH || 'seederState.json',
    writeFile: process.env.SEEDER_STATE_WRITE_FILE !== 'false'
  },
  pkcRpcUrl: process.env.PKC_RPC_URL || 'ws://127.0.0.1:9138',
  kuboRpcUrl: process.env.KUBO_RPC_URL || 'http://127.0.0.1:50019/api/v0',
  pubsubKuboRpcUrl: process.env.PUBSUB_KUBO_RPC_URL || process.env.KUBO_RPC_URL || 'http://127.0.0.1:50019/api/v0'
}
