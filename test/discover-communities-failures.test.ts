import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Pins the source-failure behavior of discoverCommunitiesFromLists: each
// source's last successfully fetched list is cached per index, so a source
// failing entirely on a later run must keep contributing its cached
// communities instead of wiping them from the seeding set. The flip side
// (deliberate: availability over freshness) is that a permanently removed
// source keeps its communities seeded until the process restarts.
test('a source failing mid-run keeps its previously discovered communities', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-discover-failure-'))
  const stableSource = path.join(tmpDir, 'stable-communities.json')
  const flakySource = path.join(tmpDir, 'flaky-communities.json')

  fs.writeFileSync(stableSource, JSON.stringify({communities: [{address: 'stable-one.bso'}]}))
  fs.writeFileSync(flakySource, JSON.stringify({communities: [{address: 'flaky-one.bso'}, {address: 'flaky-two.bso'}]}))

  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    const {discoverCommunitiesFromLists} = await import('./lib/discover-communities.ts')
    const {default: seederState} = await import('./lib/seeder-state.ts')
    const {db} = await import('./lib/db.ts')
    const [stableSource, flakySource] = process.env.COMMUNITY_LIST_SOURCES.split(',')
    const addresses = () => seederState.communitiesSeeding.map(community => community.address).sort()

    try {
      // Run 1: both sources healthy.
      await discoverCommunitiesFromLists()
      assert.deepEqual(addresses(), ['flaky-one.bso', 'flaky-two.bso', 'stable-one.bso'])

      // Run 2: the flaky source disappears entirely while the stable source
      // updates. The flaky source's communities must survive on its cached
      // list, and the stable source's update must still be picked up.
      fs.rmSync(flakySource)
      fs.writeFileSync(stableSource, JSON.stringify({communities: [{address: 'stable-two.bso'}]}))
      await discoverCommunitiesFromLists()
      assert.deepEqual(addresses(), ['flaky-one.bso', 'flaky-two.bso', 'stable-two.bso'])

      // Run 3: the flaky source now serves invalid JSON — same failure path,
      // the cached list must still win.
      fs.writeFileSync(flakySource, '<html>500 Server Error</html>')
      await discoverCommunitiesFromLists()
      assert.deepEqual(addresses(), ['flaky-one.bso', 'flaky-two.bso', 'stable-two.bso'])

      // Run 4: the flaky source recovers with a new list, replacing its cache.
      fs.writeFileSync(flakySource, JSON.stringify({communities: [{address: 'flaky-three.bso'}]}))
      await discoverCommunitiesFromLists()
      assert.deepEqual(addresses(), ['flaky-three.bso', 'stable-two.bso'])
    }
    finally {
      db.close()
    }
  `

  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        COMMUNITY_LIST_SOURCES: `${stableSource},${flakySource}`,
        COMMUNITY_EXTRA_LIST_SOURCES: '',
        SEEDER_DB_PATH: path.join(tmpDir, 'seeder.db'),
        SEEDER_STATE_PATH: path.join(tmpDir, 'seederState.json')
      },
      encoding: 'utf8'
    })

    assert.equal(
      result.status,
      0,
      `child process failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
  }
  finally {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})

test('every source failing on the first run leaves the seeding state untouched', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-discover-allfail-'))
  const missingSource = path.join(tmpDir, 'missing-communities.json')

  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    const {discoverCommunitiesFromLists} = await import('./lib/discover-communities.ts')
    const {default: seederState} = await import('./lib/seeder-state.ts')
    const {db} = await import('./lib/db.ts')
    const missingSource = process.env.COMMUNITY_LIST_SOURCES

    try {
      // Pre-existing state from an earlier process (e.g. the durable db).
      seederState.communitiesSeeding = [{address: 'previous.bso'}]

      // With no source ever fetched and nothing cached, discover must bail
      // out instead of overwriting the seeding set with an empty list.
      await discoverCommunitiesFromLists()
      assert.deepEqual(seederState.communitiesSeeding.map(community => community.address), ['previous.bso'])

      // Once the source appears, discovery takes over again.
      fs.writeFileSync(missingSource, JSON.stringify({communities: [{address: 'fresh.bso'}]}))
      await discoverCommunitiesFromLists()
      assert.deepEqual(seederState.communitiesSeeding.map(community => community.address), ['fresh.bso'])
    }
    finally {
      db.close()
    }
  `

  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        COMMUNITY_LIST_SOURCES: missingSource,
        COMMUNITY_EXTRA_LIST_SOURCES: '',
        SEEDER_DB_PATH: path.join(tmpDir, 'seeder.db'),
        SEEDER_STATE_PATH: path.join(tmpDir, 'seederState.json')
      },
      encoding: 'utf8'
    })

    assert.equal(
      result.status,
      0,
      `child process failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
  }
  finally {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})
