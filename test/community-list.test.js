import assert from 'node:assert/strict'
import test from 'node:test'
import {getCommunityContentPins, getCommunityPubsubTopicRoutingPins} from '../lib/community-cids.js'
import {buildDaemonArgs, isLocalDaemonUrl} from '../lib/daemon.js'
import {isAlreadyPinnedError} from '../lib/kubo-errors.js'
import {
  checkRuntimeDependencyUpdates,
  compareVersions,
  getRuntimeDependencyUpdateMessage,
  getUpdateMessage
} from '../lib/update-check.js'
import {extractCommunityEntries, getCommunityKey, getCommunityLookup} from '../lib/utils.js'

test('extracts old multisub community entries', () => {
  const entries = extractCommunityEntries({
    subplebbits: [{address: 'anime-and-manga.bso'}, {address: ''}, {title: 'missing'}]
  })

  assert.deepEqual(entries, [{address: 'anime-and-manga.bso', publicKey: undefined}])
})

test('extracts 5chan directory board entries', () => {
  const entries = extractCommunityEntries({
    boards: [{address: 'business-and-finance.bso', publicKey: '12D3KooWNMybS8JqELi38ZBX897PrjWbCrGoMKfw3bgoqzC2n1Dh'}]
  })

  assert.equal(getCommunityKey(entries[0]), '12D3KooWNMybS8JqELi38ZBX897PrjWbCrGoMKfw3bgoqzC2n1Dh')
  assert.deepEqual(getCommunityLookup(entries[0]), {
    address: 'business-and-finance.bso',
    publicKey: '12D3KooWNMybS8JqELi38ZBX897PrjWbCrGoMKfw3bgoqzC2n1Dh'
  })
})

test('recognizes local daemon URLs for autostart', () => {
  assert.equal(isLocalDaemonUrl('ws://127.0.0.1:9138'), true)
  assert.equal(isLocalDaemonUrl('ws://localhost:9138'), true)
  assert.equal(isLocalDaemonUrl('ws://192.0.2.10:9138'), false)
})

test('builds daemon args with optional data and log paths', () => {
  const args = buildDaemonArgs({
    pkcRpcUrl: 'ws://127.0.0.1:9138',
    dataPath: '/data/bitsocial',
    logPath: '/data/logs'
  })

  assert.deepEqual(args.slice(1), [
    'daemon',
    '--pkcRpcUrl',
    'ws://127.0.0.1:9138',
    '--pkcOptions.dataPath',
    '/data/bitsocial',
    '--logPath',
    '/data/logs'
  ])
})

test('extracts community content pins without duplicates', () => {
  const {pins, pageCidCount, postUpdatesCount} = getCommunityContentPins({
    posts: {
      pageCids: {hot: 'bafy-page-hot', top: 'bafy-page-hot'},
      pages: {hot: {nextCid: 'bafy-page-next'}}
    },
    postUpdates: {
      recent: 'bafy-post-updates'
    }
  })

  assert.equal(pageCidCount, 3)
  assert.equal(postUpdatesCount, 1)
  assert.deepEqual(pins, [
    {name: 'page hot', cid: 'bafy-page-hot'},
    {name: 'next page hot', cid: 'bafy-page-next'},
    {name: 'post updates recent', cid: 'bafy-post-updates'}
  ])
})

test('extracts pubsub routing pins including ipns over pubsub', () => {
  const pins = getCommunityPubsubTopicRoutingPins({
    pubsubTopic: 'community-topic',
    pubsubTopicRoutingCid: 'baf-community-routing',
    ipnsPubsubTopic: '/record/L2lwbnMv...',
    ipnsPubsubTopicRoutingCid: 'baf-ipns-routing'
  })

  assert.deepEqual(pins, [
    {
      name: 'pubsub topic routing',
      cid: 'baf-community-routing',
      pubsubTopic: 'community-topic'
    },
    {
      name: 'ipns pubsub topic routing',
      cid: 'baf-ipns-routing',
      pubsubTopic: '/record/L2lwbnMv...'
    }
  ])
})

test('recognizes harmless Kubo already-pinned errors', () => {
  assert.equal(isAlreadyPinnedError(new Error('pin: bafkrei already pinned recursively')), true)
  assert.equal(isAlreadyPinnedError({message: 'already pinned directly'}), true)
  assert.equal(isAlreadyPinnedError(new Error('fetch failed')), false)
})

test('compares published seeder versions', () => {
  assert.equal(compareVersions('0.1.3', '0.1.2'), 1)
  assert.equal(compareVersions('v0.1.2', '0.1.2'), 0)
  assert.equal(compareVersions('0.1.2', '0.1.3'), -1)
})

test('formats update messages only for newer versions', () => {
  assert.equal(getUpdateMessage({
    currentVersion: '0.1.2',
    latestVersion: '0.1.3'
  }), "Update available: v0.1.3 (current: v0.1.2). Run 'npm install -g @bitsocial/bitsocial-seeder@latest' to upgrade npm installs, or pull 'ghcr.io/bitsocialnet/bitsocial-seeder:latest' for Docker.")

  assert.equal(getUpdateMessage({
    currentVersion: '0.1.3',
    latestVersion: '0.1.3'
  }), undefined)
})

test('formats runtime dependency update messages without mutating external daemons', () => {
  assert.equal(getRuntimeDependencyUpdateMessage({
    packageName: '@bitsocial/bitsocial-cli',
    currentVersion: '0.19.79',
    latestVersion: '0.19.82'
  }), '@bitsocial/bitsocial-cli update available: v0.19.82 (bundled: v0.19.79). Upgrade @bitsocial/bitsocial-seeder to get the newer bundled dependency. If the seeder is reusing an already-running bitsocial daemon, upgrade and restart that daemon separately; bitsocial-seeder does not update external daemon installs.')

  assert.equal(getRuntimeDependencyUpdateMessage({
    packageName: '@pkcprotocol/pkc-js',
    currentVersion: '0.0.59',
    latestVersion: '0.0.59'
  }), undefined)
})

test('checks runtime dependency updates through the npm registry helper', async () => {
  const logs = []
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({version: '0.19.82'})
  })

  const results = await checkRuntimeDependencyUpdates({
    dependencies: [{
      packageName: '@bitsocial/bitsocial-cli',
      currentVersion: '0.19.79'
    }],
    fetchImpl,
    logger: {log: message => logs.push(message)}
  })

  assert.equal(logs.length, 1)
  assert.equal(results[0].latestVersion, '0.19.82')
  assert.equal(results[0].message, logs[0])
})
