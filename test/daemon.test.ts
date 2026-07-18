import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {createFakeKuboRpcServer, createFakePkcRpcServer} from './helpers/fake-daemon-rpcs.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const getFreePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address() as net.AddressInfo
    server.close(() => resolve(port))
  })
  server.once('error', reject)
})

// The config (and with it the daemon endpoints) is read at import time, so the
// env must be set before the dynamic import below. The pkc/kubo ports stay
// closed until individual tests start fake servers on them.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-daemon-'))
const [pkcPort, kuboPort] = await Promise.all([getFreePort(), getFreePort()])
process.env.SEEDER_DB_PATH = path.join(tmpDir, 'seeder.db')
process.env.PKC_RPC_URL = `ws://127.0.0.1:${pkcPort}`
process.env.KUBO_RPC_URL = `http://127.0.0.1:${kuboPort}/api/v0`
process.env.SEEDER_DAEMON_READY_TIMEOUT_MS = '30000'
process.env.SEEDER_DAEMON_READY_STABLE_MS = '1500'
const readyStableMs = 1500

// daemon.ts binds `spawn` from node:child_process at import time; patching the
// builtin and calling syncBuiltinESMExports() before the import lets each test
// substitute a controllable child for the real bitsocial-cli daemon. The
// default override refuses to spawn so no test can start a real daemon by
// accident.
const realSpawn = childProcess.spawn
let spawnOverride: ((command: string, args: string[], options: any) => ChildProcess) | undefined
childProcess.spawn = ((command: string, args: string[], options: any) => {
  if (!spawnOverride) {
    throw Error('test attempted to spawn a real bundled daemon')
  }
  return spawnOverride(command, args, options)
}) as typeof childProcess.spawn
syncBuiltinESMExports()

const daemon = await import('../lib/daemon.ts')

const pkcFake = createFakePkcRpcServer()
const kuboFake = createFakeKuboRpcServer()

test.after(async () => {
  await Promise.all([pkcFake.close(), kuboFake.close()])
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

test('buildDaemonArgs and isLocalDaemonUrl basics', () => {
  const args = daemon.buildDaemonArgs({pkcRpcUrl: 'ws://127.0.0.1:1234', dataPath: '/data', logPath: '/log'})
  assert.match(args[0], /bitsocial-cli/)
  assert.equal(args[1], 'daemon')
  assert.deepEqual(args.slice(2), ['--pkcRpcUrl', 'ws://127.0.0.1:1234', '--pkcOptions.dataPath', '/data', '--logPath', '/log'])
  assert.equal(daemon.buildDaemonArgs({pkcRpcUrl: 'ws://127.0.0.1:1234'}).length, 4)

  for (const local of ['ws://localhost:9138', 'ws://127.0.0.1:9138', 'ws://[::1]:9138', 'ws://0.0.0.0:9138']) {
    assert.equal(daemon.isLocalDaemonUrl(local), true, local)
  }
  assert.equal(daemon.isLocalDaemonUrl('wss://pkc.example.com:9138'), false)
  assert.equal(daemon.isLocalDaemonUrl('not a url'), false)
})

test('isTcpEndpointReachable distinguishes open and closed ports', async () => {
  const server = net.createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const {port} = server.address() as net.AddressInfo
  assert.equal(await daemon.isTcpEndpointReachable(`ws://127.0.0.1:${port}`), true)
  await new Promise<void>(resolve => server.close(() => resolve()))
  assert.equal(await daemon.isTcpEndpointReachable(`ws://127.0.0.1:${port}`), false)
  assert.equal(await daemon.isTcpEndpointReachable('not a url'), false)
})

test('isPkcRpcReady requires a subscriptionId answer over websocket', async () => {
  const fake = createFakePkcRpcServer()
  const port = await getFreePort()
  await fake.listen(port)
  try {
    assert.equal(await daemon.isPkcRpcReady(`ws://127.0.0.1:${port}`), true)
    fake.state.ready = false
    assert.equal(await daemon.isPkcRpcReady(`ws://127.0.0.1:${port}`), false, 'open port without subscriptionId is not ready')
  }
  finally {
    await fake.close()
  }

  // A TCP port that accepts but never completes the websocket handshake. The
  // hanging client connections must be destroyed before close() can finish.
  const tcpOnlySockets = new Set<net.Socket>()
  const tcpOnly = net.createServer(socket => {
    tcpOnlySockets.add(socket)
    socket.on('close', () => tcpOnlySockets.delete(socket))
  })
  await new Promise<void>(resolve => tcpOnly.listen(0, '127.0.0.1', () => resolve()))
  const {port: tcpPort} = tcpOnly.address() as net.AddressInfo
  try {
    assert.equal(await daemon.isPkcRpcReady(`ws://127.0.0.1:${tcpPort}`, 1000), false)
  }
  finally {
    for (const socket of tcpOnlySockets) {
      socket.destroy()
    }
    await new Promise<void>(resolve => tcpOnly.close(() => resolve()))
  }
})

test('isKuboRpcReachable checks the /version endpoint', async () => {
  const fake = createFakeKuboRpcServer()
  const port = await getFreePort()
  await fake.listen(port)
  try {
    assert.equal(await daemon.isKuboRpcReachable(`http://127.0.0.1:${port}/api/v0`), true)
    fake.state.ready = false
    assert.equal(await daemon.isKuboRpcReachable(`http://127.0.0.1:${port}/api/v0`), false)
  }
  finally {
    await fake.close()
  }
  assert.equal(await daemon.isKuboRpcReachable(`http://127.0.0.1:${await getFreePort()}/api/v0`), false)
})

test('stopDaemon resolves immediately when no bundled daemon is running', async () => {
  const before = Date.now()
  await daemon.stopDaemon()
  assert.ok(Date.now() - before < 1000)
})

test('ensureDaemon rejects when the spawned daemon exits before it is ready', async () => {
  spawnOverride = (command, args, options) => {
    assert.equal(command, process.execPath)
    assert.equal(args[1], 'daemon')
    return realSpawn(process.execPath, ['-e', 'process.exit(7)'], options)
  }
  try {
    await assert.rejects(daemon.ensureDaemon(), /exited before it was ready \(code: 7/)
  }
  finally {
    spawnOverride = undefined
  }
})

test('ensureDaemon attaches to an existing not-yet-ready daemon and debounces readiness', {timeout: 30000}, async () => {
  // pkc port open but answering without a subscriptionId → the attach branch
  // must wait instead of spawning a bundled daemon (spawn would throw here).
  pkcFake.state.ready = false
  kuboFake.state.ready = true
  await Promise.all([pkcFake.listen(pkcPort), kuboFake.listen(kuboPort)])

  const readyDelayMs = 1200
  const before = Date.now()
  const pending = daemon.ensureDaemon()
  setTimeout(() => {
    pkcFake.state.ready = true
  }, readyDelayMs)

  const {started, status} = await pending
  const elapsed = Date.now() - before
  assert.equal(started, false)
  assert.equal(status.ready, true)
  assert.ok(
    elapsed >= readyDelayMs + readyStableMs,
    `resolved after ${elapsed}ms, expected at least ${readyDelayMs + readyStableMs}ms (readyStableMs debounce)`
  )
})

test('a readiness flap resets the readyStableMs debounce', {timeout: 30000}, async () => {
  // Ready at ~0.4s, flaps down between ~1.4s and ~2.4s: the stability window
  // must restart after the flap, so completion cannot come before 2.4s + 1.5s.
  pkcFake.state.ready = false
  kuboFake.state.ready = true

  const before = Date.now()
  const pending = daemon.ensureDaemon()
  setTimeout(() => {
    pkcFake.state.ready = true
  }, 400)
  setTimeout(() => {
    kuboFake.state.ready = false
  }, 1400)
  const flapEndMs = 2400
  setTimeout(() => {
    kuboFake.state.ready = true
  }, flapEndMs)

  const {started, status} = await pending
  const elapsed = Date.now() - before
  assert.equal(started, false)
  assert.equal(status.ready, true)
  assert.ok(
    elapsed >= flapEndMs + readyStableMs,
    `resolved after ${elapsed}ms, expected at least ${flapEndMs + readyStableMs}ms (flap must reset the debounce)`
  )
})

test('checkDaemonEndpoints reports per-endpoint status', async () => {
  // Both fakes are listening and healthy after the previous tests. With
  // PUBSUB_KUBO_RPC_URL unset it equals KUBO_RPC_URL, so the pubsub probe is
  // the same-URL shortcut.
  const healthy = await daemon.checkDaemonEndpoints()
  assert.deepEqual(healthy, {
    pkcPortOpen: true,
    pkcReachable: true,
    kuboReachable: true,
    pubsubReachable: true,
    ready: true
  })

  kuboFake.state.ready = false
  const kuboDown = await daemon.checkDaemonEndpoints()
  assert.equal(kuboDown.pkcReachable, true)
  assert.equal(kuboDown.kuboReachable, false)
  assert.equal(kuboDown.ready, false)
  kuboFake.state.ready = true
})

test('stopDaemon escalates to SIGKILL when the daemon ignores SIGINT', {timeout: 30000}, async () => {
  // Free the endpoint ports so ensureDaemon takes the autostart branch.
  await Promise.all([pkcFake.close(), kuboFake.close()])

  const readyFile = path.join(tmpDir, 'stubborn-ready')
  process.env.SEEDER_TEST_READY_FILE = readyFile
  let stubborn: ChildProcess | undefined
  spawnOverride = (command, args, options) => {
    stubborn = realSpawn(process.execPath, ['-e', `
      require('fs').writeFileSync(process.env.SEEDER_TEST_READY_FILE, 'ready')
      process.on('SIGINT', () => console.log('ignoring SIGINT'))
      setInterval(() => {}, 1000)
    `], options)
    return stubborn
  }

  const pending = daemon.ensureDaemon()
  const rejection = assert.rejects(pending, /exited before it was ready \(code: null, signal: SIGKILL\)/)
  try {
    const spawnDeadline = Date.now() + 15000
    while (!fs.existsSync(readyFile)) {
      assert.ok(Date.now() < spawnDeadline, 'the stubborn daemon child was never spawned')
      await sleep(50)
    }
    const timeoutMs = 1500
    const before = Date.now()
    await daemon.stopDaemon(timeoutMs)
    const elapsed = Date.now() - before
    assert.ok(elapsed >= timeoutMs - 100, `stopDaemon resolved after ${elapsed}ms, expected the ${timeoutMs}ms SIGKILL grace window`)
    assert.equal(stubborn?.signalCode, 'SIGKILL')
    await rejection
  }
  finally {
    spawnOverride = undefined
    if (stubborn && stubborn.exitCode === null && stubborn.signalCode === null) {
      stubborn.kill('SIGKILL')
    }
  }
})

// The refusal branches need different config (env) values, so they run in
// child processes like the other import-time-config tests.
const runEnsureDaemonChild = (script: string, env: {[name: string]: string}) => spawnSync(
  process.execPath,
  ['--input-type=module', '-e', script],
  {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {...process.env, ...env},
    encoding: 'utf8',
    timeout: 60000
  }
)

test('ensureDaemon refuses to autostart for a non-local PKC_RPC_URL', async () => {
  const result = runEnsureDaemonChild(`
    import assert from 'node:assert/strict'
    const {ensureDaemon} = await import('./lib/daemon.ts')
    await assert.rejects(ensureDaemon(), /cannot autostart a daemon for non-local PKC_RPC_URL 'ws:\\/\\/pkc-rpc.invalid:9138'/)
  `, {
    PKC_RPC_URL: 'ws://pkc-rpc.invalid:9138',
    KUBO_RPC_URL: `http://127.0.0.1:${await getFreePort()}/api/v0`
  })
  assert.equal(result.status, 0, `child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
})

test('ensureDaemon fails fast when autostart is disabled and the endpoints are down', async () => {
  const result = runEnsureDaemonChild(`
    import assert from 'node:assert/strict'
    const {ensureDaemon} = await import('./lib/daemon.ts')
    await assert.rejects(ensureDaemon(), /SEEDER_DAEMON_AUTOSTART=false/)
  `, {
    PKC_RPC_URL: `ws://127.0.0.1:${await getFreePort()}`,
    KUBO_RPC_URL: `http://127.0.0.1:${await getFreePort()}/api/v0`,
    SEEDER_DAEMON_AUTOSTART: 'false'
  })
  assert.equal(result.status, 0, `child failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
})
