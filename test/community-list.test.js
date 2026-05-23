import assert from 'node:assert/strict'
import test from 'node:test'
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
