import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import {createRequire} from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '..')

// Same prerequisites as the daemon e2e: the bundled kubo binary and the
// better-sqlite3 bindings the bitsocial-cli daemon needs.
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

// bitsocialnet/bitsocial-seeder#25: a browser (libp2p-js pkc-js client) that can only reach
// the seeder must be able to publish to a community whose owner node is behind NAT, with
// the seeder's kubo relaying the challenge exchange over gossipsub in both directions.
test('a browser publishes to a NAT-hosted community through the seeder pubsub topic', {timeout: 600_000}, t => {
  const skipReason = getSkipReason()
  if (skipReason) {
    return t.skip(skipReason)
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-nat-owner-e2e-'))
  try {
    const result = spawnSync(process.execPath, [path.join(import.meta.dirname, 'helpers', 'nat-owner-publish-e2e-child.ts')], {
      cwd: repoRoot,
      env: {...process.env, SEEDER_E2E_TMP: tmpDir},
      encoding: 'utf8',
      timeout: 590_000,
      maxBuffer: 64 * 1024 * 1024
    })
    assert.equal(
      result.status,
      0,
      `nat owner publish e2e child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    )
  }
  finally {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})
