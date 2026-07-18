import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// discover-communities.ts imports seeder-state (and with it the SQLite db), which
// initialize at import time — point them at a temp dir before the dynamic import.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-merge-'))
process.env.SEEDER_DB_PATH = path.join(tmpDir, 'seeder.db')
process.env.SEEDER_STATE_PATH = path.join(tmpDir, 'seederState.json')

const {mergeDiscoveredCommunities} = await import('../lib/discover-communities.ts')

test.after(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

test('caps only the public lists, never the extra lists', () => {
  const communities = mergeDiscoveredCommunities({
    communityLists: [{communities: [
      {address: 'public-1.bso'},
      {address: 'public-2.bso'},
      {address: 'public-3.bso'}
    ]}],
    extraCommunityLists: [{communities: [
      {address: 'extra-1.bso'},
      {address: 'extra-2.bso'}
    ]}],
    maxCommunities: 1
  })

  assert.deepEqual(communities.map(community => community.address), [
    'public-1.bso',
    'extra-1.bso',
    'extra-2.bso'
  ])
})

test('an unset cap keeps every public community', () => {
  const communities = mergeDiscoveredCommunities({
    communityLists: [{communities: [{address: 'public-1.bso'}, {address: 'public-2.bso'}]}],
    extraCommunityLists: [],
    maxCommunities: undefined
  })
  assert.equal(communities.length, 2)
})

test('an extra entry overrides the public entry with the same community key', () => {
  const publicKey = '12D3KooWNMybS8JqELi38ZBX897PrjWbCrGoMKfw3bgoqzC2n1Dh'
  const byPublicKey = mergeDiscoveredCommunities({
    communityLists: [{communities: [{address: 'public-name.bso', publicKey}]}],
    extraCommunityLists: [{communities: [{address: 'extra-name.bso', publicKey}]}],
    maxCommunities: undefined
  })
  assert.equal(byPublicKey.length, 1)
  assert.equal(byPublicKey[0].address, 'extra-name.bso')

  // Without a publicKey the address is the community key.
  const byAddress = mergeDiscoveredCommunities({
    communityLists: [{communities: [{address: 'same.bso', title: 'public'}]}],
    extraCommunityLists: [{communities: [{address: 'same.bso', title: 'extra'}]}],
    maxCommunities: undefined
  })
  assert.equal(byAddress.length, 1)
  assert.equal(byAddress[0].title, 'extra')
})

test('later public lists overwrite earlier entries with the latest data', () => {
  const communities = mergeDiscoveredCommunities({
    communityLists: [
      {communities: [{address: 'dup.bso', title: 'old'}]},
      {communities: [{address: 'dup.bso', title: 'new'}]}
    ],
    extraCommunityLists: [],
    maxCommunities: undefined
  })
  assert.deepEqual(communities, [{address: 'dup.bso', publicKey: undefined, title: 'new'}])
})
