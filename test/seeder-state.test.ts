import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The db path must be set before importing lib/seeder-state.ts, which opens the
// database and runs the one-time JSON migration at import time. Writing the
// legacy state file first lets the import itself exercise the migration.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-state-'))
process.env.SEEDER_DB_PATH = path.join(tmpDir, 'seeder.db')
process.env.SEEDER_STATE_PATH = path.join(tmpDir, 'seederState.json')

fs.writeFileSync(process.env.SEEDER_STATE_PATH, JSON.stringify({
  communitiesSeeding: [
    {address: 'legacy-one.bso'},
    {address: 'legacy-two.bso', publicKey: 'legacy-key'}
  ]
}))

const {default: seederState} = await import('../lib/seeder-state.ts')
const {db} = await import('../lib/db.ts')

test.after(() => {
  db.close()
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

test('migrates communities from the legacy seederState.json on first run', () => {
  const migrated = seederState.communitiesSeeding
  assert.deepEqual(
    migrated?.map(community => community.address).sort(),
    ['legacy-one.bso', 'legacy-two.bso']
  )
  assert.deepEqual(
    migrated?.find(community => community.publicKey),
    {address: 'legacy-two.bso', publicKey: 'legacy-key'}
  )
})

test('setting communities upserts rows and removes everything not in the new set', () => {
  seederState.communitiesSeeding = [
    {address: 'one.bso', title: 'One'},
    {address: 'two.bso', publicKey: 'two-key'}
  ]

  const communities = seederState.communitiesSeeding
  assert.deepEqual(communities?.map(community => community.address).sort(), ['one.bso', 'two.bso'])
  assert.equal(communities?.some(community => community.address?.startsWith('legacy-')), false)
  assert.deepEqual(communities?.find(community => community.address === 'one.bso'), {address: 'one.bso', title: 'One'})
})

test('re-setting a community preserves discovered_at but updates its data', () => {
  db.query(`UPDATE communities SET discovered_at = 111 WHERE community_key = 'one.bso'`)

  seederState.communitiesSeeding = [
    {address: 'one.bso', title: 'One updated'},
    {address: 'two.bso', publicKey: 'two-key'}
  ]

  const row = db.query(`SELECT discovered_at, data FROM communities WHERE community_key = 'one.bso'`)[0]
  assert.equal(row.discovered_at, 111)
  assert.equal(JSON.parse(row.data).title, 'One updated')
})

test('communities are returned in discovery order', () => {
  // one.bso was backdated to discovered_at = 111 above, so it sorts first.
  assert.deepEqual(
    seederState.communitiesSeeding?.map(community => community.address),
    ['one.bso', 'two.bso']
  )
})

test('entries without an address or public key are skipped', () => {
  seederState.communitiesSeeding = [{address: 'keeper.bso'}, {title: 'no key at all'}]
  assert.deepEqual(seederState.communitiesSeeding?.map(community => community.address), ['keeper.bso'])
})

test('non-array input is ignored and keeps the current state', () => {
  ;(seederState as any).communitiesSeeding = undefined
  const communities = seederState.communitiesSeeding
  assert.deepEqual(communities?.map(community => community.address), ['keeper.bso'])
})

test('an empty array clears the table and restores the undefined sentinel', () => {
  seederState.communitiesSeeding = []
  assert.equal(seederState.communitiesSeeding, undefined)
})

test('the JSON migration does not run when the communities table already has rows', () => {
  const migrationTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-migration-'))
  const dbPath = path.join(migrationTmpDir, 'seeder.db')
  const statePath = path.join(migrationTmpDir, 'seederState.json')

  const runChild = (script: string) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {...process.env, SEEDER_DB_PATH: dbPath, SEEDER_STATE_PATH: statePath},
      encoding: 'utf8'
    })
    assert.equal(result.status, 0, `child process failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    return result
  }

  try {
    // First process populates the table (no legacy file exists yet).
    runChild(`
      const {default: seederState} = await import('./lib/seeder-state.ts')
      const {db} = await import('./lib/db.ts')
      seederState.communitiesSeeding = [{address: 'existing.bso'}]
      db.close()
    `)

    // Second process starts with a legacy file present; the non-empty table must win.
    fs.writeFileSync(statePath, JSON.stringify({communitiesSeeding: [{address: 'from-legacy-json.bso'}]}))
    runChild(`
      import assert from 'node:assert/strict'
      const {default: seederState} = await import('./lib/seeder-state.ts')
      const {db} = await import('./lib/db.ts')
      assert.deepEqual(seederState.communitiesSeeding, [{address: 'existing.bso'}])
      db.close()
    `)
  }
  finally {
    fs.rmSync(migrationTmpDir, {recursive: true, force: true})
  }
})
