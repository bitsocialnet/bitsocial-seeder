import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// Pins the votes-only boot path: a source that fetches successfully but carries
// zero communities must let discovery *complete* rather than crash or hang.
// setCommunitiesSeeding([]) empties the table and the getter reads an empty
// table back as the undefined "not discovered yet" sentinel, so discovery
// completion is tracked on a separate seederState.discoveryCompleted flag that
// start.ts's boot loop also checks. Without it, the post-discovery log line
// crashes on `.length` of undefined and the boot loop spins forever.
test('discovering zero communities completes boot instead of hanging', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-discover-zero-'))
  const emptySource = path.join(tmpDir, 'empty-communities.json')
  fs.writeFileSync(emptySource, JSON.stringify({communities: []}))

  const script = `
    import assert from 'node:assert/strict'
    const {discoverCommunitiesFromLists} = await import('./lib/discover-communities.ts')
    const {default: seederState} = await import('./lib/seeder-state.ts')
    const {db} = await import('./lib/db.ts')

    try {
      assert.equal(seederState.discoveryCompleted, undefined) // not completed before discovery

      // A votes-only config: the source fetches fine but has zero communities.
      // This must not throw (the log line reads back the empty-table sentinel).
      await discoverCommunitiesFromLists()

      // Empty table reads back as undefined, but discovery is nonetheless done —
      // the flag is what lets start.ts's boot loop proceed.
      assert.equal(seederState.communitiesSeeding, undefined)
      assert.equal(seederState.discoveryCompleted, true)

      // The boot loop's exit condition must now be satisfied.
      const canBoot = Boolean(seederState.communitiesSeeding) || Boolean(seederState.discoveryCompleted)
      assert.equal(canBoot, true)
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
        COMMUNITY_LIST_SOURCES: emptySource,
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
