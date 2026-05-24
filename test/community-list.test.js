import assert from 'node:assert/strict'
import test from 'node:test'
import {buildDaemonArgs, isLocalDaemonUrl} from '../lib/daemon.js'
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
