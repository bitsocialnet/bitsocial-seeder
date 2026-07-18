import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '..')

// The e2e needs the pieces npm's postinstall scripts provide. When they were
// skipped (e.g. ignore-scripts installs) the daemon cannot run, so skip with a
// pointer at the fix instead of failing.
const getSkipReason = () => {
  try {
    require('kubo').path()
  }
  catch {
    return `kubo binary not installed — run 'npm rebuild kubo' (or set KUBO_BINARY)`
  }
  const bindings = spawnSync(process.execPath, ['-e', `require('better-sqlite3')`], {cwd: repoRoot, encoding: 'utf8'})
  if (bindings.status !== 0) {
    return `better-sqlite3 native bindings missing — run 'npm rebuild better-sqlite3'`
  }
}

test('seeds a community end-to-end through a bundled bitsocial-cli daemon', {timeout: 300_000}, t => {
  const skipReason = getSkipReason()
  if (skipReason) {
    return t.skip(skipReason)
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-daemon-e2e-'))
  try {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'helpers', 'daemon-e2e-child.ts')], {
      cwd: repoRoot,
      env: {...process.env, SEEDER_E2E_TMP: tmpDir},
      encoding: 'utf8',
      timeout: 290_000
    })
    assert.equal(
      result.status,
      0,
      `daemon e2e child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
  }
  finally {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})
