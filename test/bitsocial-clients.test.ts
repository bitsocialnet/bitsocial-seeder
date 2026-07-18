import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import net from 'node:net'
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

// bitsocial.ts builds live PKC and Kubo clients at import time from the config,
// so it runs in a child process (like the other import-time-config tests) —
// which also keeps pkc-js's persistent websocket from hanging the test runner.
// The child must be an async spawn: the fake RPC servers live in THIS process,
// and a spawnSync would block the event loop they answer from. This is the only
// direct coverage that survives when the daemon e2e skips itself on machines
// without the kubo/better-sqlite3 native deps.
test('bitsocial.ts constructs working pkc and kubo clients from the config', {timeout: 60_000}, async () => {
  const pkcFake = createFakePkcRpcServer()
  const kuboFake = createFakeKuboRpcServer()
  const pubsubKuboFake = createFakeKuboRpcServer()
  const [pkcPort, kuboPort, pubsubKuboPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()])
  await Promise.all([pkcFake.listen(pkcPort), kuboFake.listen(kuboPort), pubsubKuboFake.listen(pubsubKuboPort)])

  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', `
      import assert from 'node:assert/strict'
      const {kubo, kuboPubsub, pkc, pubsubKuboRpcUrl} = await import('./lib/bitsocial.ts')
      assert.equal(pubsubKuboRpcUrl, process.env.PUBSUB_KUBO_RPC_URL)
      const version = await kubo.version()
      assert.equal(version.version, '0.0.0-fake')
      const pubsubVersion = await kuboPubsub.version()
      assert.equal(pubsubVersion.version, '0.0.0-fake')
      assert.equal(typeof pkc.on, 'function')
      console.log('bitsocial clients ok')
      process.exit(0)
    `],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: {
        ...process.env,
        PKC_RPC_URL: `ws://127.0.0.1:${pkcPort}`,
        KUBO_RPC_URL: `http://127.0.0.1:${kuboPort}/api/v0`,
        PUBSUB_KUBO_RPC_URL: `http://127.0.0.1:${pubsubKuboPort}/api/v0`
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )

  let output = ''
  child.stdout!.on('data', chunk => { output += chunk.toString() })
  child.stderr!.on('data', chunk => { output += chunk.toString() })
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 45_000)
  killTimer.unref()

  try {
    const code = await new Promise<number | null>(resolve => child.once('exit', resolve))
    assert.match(output, /bitsocial clients ok/)
    assert.equal(code, 0, `child failed\noutput:\n${output}`)
  }
  finally {
    clearTimeout(killTimer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await Promise.all([pkcFake.close(), kuboFake.close(), pubsubKuboFake.close()])
  }
})
