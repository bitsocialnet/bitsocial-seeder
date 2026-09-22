import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {parseMaxCommunities} from '../config.ts'

test('the default cap is finite and unlimited requires an explicit opt-in', () => {
  for (const value of [undefined, '', '  ']) assert.equal(parseMaxCommunities(value), 10)
  assert.equal(parseMaxCommunities('0'), 0)
  assert.equal(parseMaxCommunities('25'), 25)
  assert.equal(parseMaxCommunities(' Unlimited '), undefined)
  for (const value of ['NaN', 'Infinity', '-1', '1.5', 'oops', '1e3', '9007199254740992']) {
    assert.throws(() => parseMaxCommunities(value), /MAX_COMMUNITIES/)
  }
})

test('default selection persists across processes and reordered lists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seeder-cap-'))
  const source = path.join(dir, 'communities.json')
  const entries = Array.from({length: 100}, (_, i) => ({address: `public-${i}.bso`}))
  const run = (db: string, max = '') => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const {discoverCommunitiesFromLists} = await import('./lib/discover-communities.ts')
      const {default: state} = await import('./lib/seeder-state.ts')
      const {db} = await import('./lib/db.ts')
      await discoverCommunitiesFromLists()
      console.log('RESULT:' + JSON.stringify(state.communitiesSeeding?.map(c => c.address).sort() || []))
      db.close()
    `], {cwd: path.resolve(import.meta.dirname, '..'), env: {...process.env,
      COMMUNITY_LIST_SOURCES: source, COMMUNITY_EXTRA_LIST_SOURCES: '', MAX_COMMUNITIES: max,
      SEEDER_DB_PATH: db, SEEDER_STATE_PATH: path.join(dir, 'missing.json')
    }, encoding: 'utf8'})
    assert.equal(result.status, 0, result.stdout + result.stderr)
    return JSON.parse(result.stdout.match(/RESULT:(.*)/)![1]) as string[]
  }
  try {
    fs.writeFileSync(source, JSON.stringify({communities: entries}))
    const db = path.join(dir, 'one.db')
    const first = run(db)
    assert.equal(first.length, 10)
    fs.writeFileSync(source, JSON.stringify({communities: entries.toReversed()}))
    assert.deepEqual(run(db), first)
    assert.notDeepEqual(run(path.join(dir, 'two.db')), first)
    assert.equal(run(db, 'unlimited').length, 100)
    assert.equal(run(db, '0').length, 0)
  }
  finally { fs.rmSync(dir, {recursive: true, force: true}) }
})
