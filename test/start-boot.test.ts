import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {createFakeKuboRpcServer, createFakePkcRpcServer} from './helpers/fake-daemon-rpcs.ts'

const getFreePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address() as net.AddressInfo
    server.close(() => resolve(port))
  })
  server.once('error', reject)
})

// Boot smoke test: start.ts as a real child process against fake daemon RPCs
// (so ensureDaemon attaches instead of spawning bitsocial-cli), a local list
// source, wait for the seeding loop to come up, then SIGINT and expect a
// clean exit 0. cwd is the temp dir so dotenv cannot pick up a repo .env.
test('start.ts boots, seeds from a local list source, and shuts down cleanly on SIGINT', {timeout: 90_000}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-boot-'))
  const pkcFake = createFakePkcRpcServer()
  const kuboFake = createFakeKuboRpcServer()
  const [pkcPort, kuboPort] = await Promise.all([getFreePort(), getFreePort()])
  await Promise.all([pkcFake.listen(pkcPort), kuboFake.listen(kuboPort)])

  const listPath = path.join(tmpDir, 'communities.json')
  fs.writeFileSync(listPath, JSON.stringify({communities: [{address: 'boot-smoke.bso'}]}))

  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '..', 'start.ts')], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PKC_RPC_URL: `ws://127.0.0.1:${pkcPort}`,
      KUBO_RPC_URL: `http://127.0.0.1:${kuboPort}/api/v0`,
      COMMUNITY_LIST_SOURCES: listPath,
      COMMUNITY_EXTRA_LIST_SOURCES: '',
      VOTES_MANIFEST_SOURCES: '',
      SEEDER_DB_PATH: path.join(tmpDir, 'seeder.db'),
      SEEDER_STATE_PATH: path.join(tmpDir, 'seederState.json'),
      SEEDER_UPDATE_CHECK_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  const seedingLine = new Promise<string>(resolve => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/seeding (\d+) communities/)
      if (match) {
        resolve(match[1])
      }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
  })
  const exited = new Promise<{code: number | null, signal: string | null}>(resolve => {
    child.once('exit', (code, signal) => resolve({code, signal}))
  })

  try {
    const communityCount = await Promise.race([
      seedingLine,
      exited.then(({code, signal}) => {
        throw Error(`start.ts exited before seeding started (code: ${code}, signal: ${signal})\noutput:\n${output}`)
      }),
      new Promise<never>((resolve, reject) => setTimeout(
        () => reject(Error(`timed out waiting for the seeding log line\noutput:\n${output}`)),
        60_000
      ).unref())
    ])
    assert.equal(communityCount, '1', `expected the local list's single community\noutput:\n${output}`)
    assert.match(output, /using existing bitsocial daemon RPCs/)
    assert.match(output, /discovered 1 communities to seed/)

    child.kill('SIGINT')
    const {code, signal} = await exited
    assert.match(output, /received SIGINT, shutting down/)
    assert.equal(signal, null, `start.ts should exit itself, not die to the signal\noutput:\n${output}`)
    assert.equal(code, 0, `expected a clean exit\noutput:\n${output}`)
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await Promise.all([pkcFake.close(), kuboFake.close()])
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})
