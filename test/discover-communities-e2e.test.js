import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`)
}

test('discovers public and extra list sources end-to-end', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-discover-'))
  const fivechanSource = path.join(tmpDir, '5chan-communities.json')
  const seeditSource = path.join(tmpDir, 'seedit-communities.json')
  const extraSource = path.join(tmpDir, 'extra-communities.json')
  const dbPath = path.join(tmpDir, 'seeder.db')
  const statePath = path.join(tmpDir, 'seederState.json')

  writeJson(fivechanSource, {
    communities: [
      {address: 'shared-public.bso', publicKey: 'shared-public-key'}
    ]
  })
  writeJson(seeditSource, {
    communities: [
      {address: 'seedit-public.bso'}
    ]
  })
  writeJson(extraSource, {
    communities: [
      {address: 'extra-shared.bso', publicKey: 'shared-public-key'},
      {address: 'extra-one.bso'}
    ]
  })

  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    const writeJson = (filePath, value) => fs.writeFileSync(filePath, \`\${JSON.stringify(value)}\\n\`)
    const {discoverCommunitiesFromLists} = await import('./lib/discover-communities.js')
    const {default: seederState} = await import('./lib/seeder-state.js')
    const {db} = await import('./lib/db.js')

    try {
      await discoverCommunitiesFromLists()
      const first = seederState.communitiesSeeding
      assert.deepEqual(first.map(community => community.address).sort(), ['extra-one.bso', 'extra-shared.bso', 'seedit-public.bso'])
      assert.deepEqual(first.find(community => community.publicKey === 'shared-public-key'), {
        address: 'extra-shared.bso',
        publicKey: 'shared-public-key'
      })
      assert.equal(first.some(community => community.address === 'seedit-public.bso'), true)

      const [fivechanSource, seeditSource] = process.env.COMMUNITY_LIST_SOURCES.split(',')
      writeJson(fivechanSource, {
        communities: [{address: '5chan-new.bso'}]
      })
      writeJson(seeditSource, {
        communities: [{address: 'seedit-new.bso'}]
      })
      writeJson(process.env.COMMUNITY_EXTRA_LIST_SOURCES, {
        communities: [{address: 'extra-two.bso'}]
      })

      await discoverCommunitiesFromLists()
      const second = seederState.communitiesSeeding
      assert.deepEqual(second.map(community => community.address).sort(), ['5chan-new.bso', 'extra-two.bso', 'seedit-new.bso'])
      assert.equal(second.some(community => community.address === 'seedit-public.bso'), false)
      assert.equal(second.some(community => community.address === 'extra-one.bso'), false)
      assert.equal(second.some(community => community.publicKey === 'shared-public-key'), false)
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
        COMMUNITY_LIST_SOURCES: `${fivechanSource},${seeditSource}`,
        COMMUNITY_EXTRA_LIST_SOURCES: extraSource,
        MAX_COMMUNITIES: '2',
        SEEDER_DB_PATH: dbPath,
        SEEDER_STATE_PATH: statePath
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
