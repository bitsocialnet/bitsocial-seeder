import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {defaultCommunityListSources} from '../config.ts'
import {getCommunityContentPins, getCommunityPubsubTopicRoutingPins} from '../lib/community-cids.ts'
import {buildDaemonArgs, isLocalDaemonUrl} from '../lib/daemon.ts'
import {
  getBitsocialCliPathCandidates,
  getBitsocialCliVersionFromCommandLineArgs,
  getExistingDaemonVersionWarning,
  isSamePkcRpcUrl,
  readProcessCommandLineArgs,
  warnIfExistingDaemonMayBeStale
} from '../lib/external-daemon-version.ts'
import {isAlreadyPinnedError} from '../lib/kubo-errors.ts'
import {
  checkForUpdate,
  checkRuntimeDependencyUpdates,
  compareVersions,
  fetchLatestVersion,
  getRuntimeDependencyUpdateMessage,
  getUpdateMessage
} from '../lib/update-check.ts'
import {extractCommunityEntries, getCommunityKey, getCommunityLookup, getTimeAgo} from '../lib/utils.ts'

test('defaults to both official directory list sources', () => {
  const expectedSources = [
    'https://api.github.com/repos/bitsocialnet/lists/contents/5chan-directories?ref=master',
    'https://api.github.com/repos/bitsocialnet/lists/contents/seedit-directories?ref=master'
  ]
  const compose = fs.readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')

  assert.deepEqual(defaultCommunityListSources, expectedSources)
  assert.ok(
    compose.includes(`COMMUNITY_LIST_SOURCES: "${expectedSources.join(',')}"`),
    'Docker Compose should use the same two official directory sources'
  )
})

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

test('matches equivalent local daemon RPC URLs', () => {
  assert.equal(isSamePkcRpcUrl('ws://127.0.0.1:9138', 'ws://localhost:9138/'), true)
  assert.equal(isSamePkcRpcUrl('ws://127.0.0.1:9138', 'ws://127.0.0.1:9139'), false)
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
  const logs: any[] = []
  const fetchImpl: any = async () => ({
    ok: true,
    json: async () => ({version: '0.19.82'})
  })

  const results = await checkRuntimeDependencyUpdates({
    dependencies: [{
      packageName: '@bitsocial/bitsocial-cli',
      currentVersion: '0.19.79'
    }],
    fetchImpl,
    logger: {log: (message: any) => logs.push(message)} as any
  })

  assert.equal(logs.length, 1)
  assert.equal(results[0].latestVersion, '0.19.82')
  assert.equal(results[0].message, logs[0])
})

test('finds bitsocial CLI package versions from daemon command line args', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-cli-version-'))
  const packageRoot = path.join(tmpDir, 'node_modules', '@bitsocial', 'bitsocial-cli')
  const binPath = path.join(packageRoot, 'bin', 'run')
  fs.mkdirSync(path.dirname(binPath), {recursive: true})
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@bitsocial/bitsocial-cli',
    version: '0.19.79'
  }))
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n')

  try {
    assert.deepEqual(getBitsocialCliPathCandidates(['node', binPath, 'daemon']), [binPath])
    assert.equal(await getBitsocialCliVersionFromCommandLineArgs(['node', binPath, 'daemon']), '0.19.79')
  }
  finally {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})

test('warns when an existing daemon is older than the bundled CLI', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-stale-daemon-'))
  const packageRoot = path.join(tmpDir, 'node_modules', '@bitsocial', 'bitsocial-cli')
  const binPath = path.join(packageRoot, 'bin', 'run')
  fs.mkdirSync(path.dirname(binPath), {recursive: true})
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@bitsocial/bitsocial-cli',
    version: '0.19.79'
  }))
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n')

  try {
    const warning = await getExistingDaemonVersionWarning({
      pkcRpcUrl: 'ws://127.0.0.1:9138',
      bundledVersion: '0.19.82',
      loadDaemonStates: async () => [{pid: 123, pkcRpcUrl: 'ws://localhost:9138'}] as any[],
      readCommandLineArgs: async () => ['node', binPath, 'daemon']
    })

    assert.match(warning!, /Existing bitsocial daemon is running @bitsocial\/bitsocial-cli v0\.19\.79/)
    assert.match(warning!, /bitsocial update install --restart-daemons/)
  }
  finally {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})

test('warns when an existing daemon version cannot be verified', async () => {
  const warning = await getExistingDaemonVersionWarning({
    pkcRpcUrl: 'ws://127.0.0.1:9138',
    bundledVersion: '0.19.82',
    loadDaemonStates: async () => [],
    readCommandLineArgs: async () => []
  })

  assert.match(warning!, /could not verify/)
  assert.match(warning!, /at least v0\.19\.82/)
})

test('fetchLatestVersion reads the npm registry latest dist-tag and rejects bad responses', async () => {
  const okFetch: any = async () => ({ok: true, json: async () => ({version: '0.9.9'})})
  assert.equal(await fetchLatestVersion({packageName: 'x', fetchImpl: okFetch}), '0.9.9')

  const errorFetch: any = async () => ({ok: false, status: 503})
  await assert.rejects(fetchLatestVersion({packageName: 'x', fetchImpl: errorFetch}), /npm registry returned 503/)

  const noVersionFetch: any = async () => ({ok: true, json: async () => ({})})
  await assert.rejects(fetchLatestVersion({packageName: 'x', fetchImpl: noVersionFetch}), /did not include a version/)
})

test('checkForUpdate logs an update notice only when the registry has a newer version', async () => {
  const logs: any[] = []
  const logger = {log: (message: any) => logs.push(message)} as any
  const fetchVersion = (version: string): any => async () => ({ok: true, json: async () => ({version})})

  const outdated = await checkForUpdate({
    currentVersion: '0.1.0',
    packageName: '@bitsocial/bitsocial-seeder',
    fetchImpl: fetchVersion('0.2.0'),
    logger
  })
  assert.equal(outdated.latestVersion, '0.2.0')
  assert.equal(outdated.message, logs[0])
  assert.match(logs[0], /Update available: v0\.2\.0 \(current: v0\.1\.0\)/)

  const current = await checkForUpdate({
    currentVersion: '0.2.0',
    packageName: '@bitsocial/bitsocial-seeder',
    fetchImpl: fetchVersion('0.2.0'),
    logger
  })
  assert.equal(current.message, undefined)
  assert.equal(logs.length, 1)
})

test('formats seconds timestamps as relative time and null as never', () => {
  assert.equal(getTimeAgo(undefined), 'never')
  assert.equal(getTimeAgo(null), 'never')
  assert.match(getTimeAgo(Math.floor(Date.now() / 1000) - 120), /minutes? ago/)
})

test('reads this process command line args from /proc or ps', async () => {
  const args = await readProcessCommandLineArgs(process.pid)
  assert.ok(args.length > 0, 'expected at least the executable path')
  assert.ok(args.join(' ').includes('node'), `expected the node executable in ${JSON.stringify(args)}`)

  // A pid that cannot exist yields an empty list, never a throw.
  assert.deepEqual(await readProcessCommandLineArgs(2 ** 31 - 7), [])
})

test('warnIfExistingDaemonMayBeStale warns and never throws when no daemon matches', async () => {
  const warnings: any[] = []
  // Port 1 matches no real daemon state, so both the no-match branch and the
  // load-failure branch produce a could-not-verify warning through the logger.
  await warnIfExistingDaemonMayBeStale({
    pkcRpcUrl: 'ws://127.0.0.1:1',
    logger: {warn: (message: any) => warnings.push(message)} as any
  })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not verify/)
})

test('does not warn when the existing daemon is at least the bundled CLI version', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-current-daemon-'))
  const packageRoot = path.join(tmpDir, 'node_modules', '@bitsocial', 'bitsocial-cli')
  const binPath = path.join(packageRoot, 'bin', 'run')
  fs.mkdirSync(path.dirname(binPath), {recursive: true})
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@bitsocial/bitsocial-cli',
    version: '0.19.82'
  }))
  fs.writeFileSync(binPath, '#!/usr/bin/env node\n')

  try {
    assert.equal(await getExistingDaemonVersionWarning({
      pkcRpcUrl: 'ws://127.0.0.1:9138',
      bundledVersion: '0.19.82',
      loadDaemonStates: async () => [{pid: 123, pkcRpcUrl: 'ws://localhost:9138'}] as any[],
      readCommandLineArgs: async () => ['node', binPath, 'daemon']
    }), undefined)
  }
  finally {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})
