import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
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

// The published entrypoint is the bin shim (a bare `import '../start.ts'`). Run it with both
// halves explicitly switched off ('none') so it exercises the shim and start.ts's
// nothing-to-seed guard, then exits 0 before touching any daemon RPC. Only *both* off is a
// misconfiguration — either one alone is a supported single-purpose seeder.
test('the bin shim runs start.ts, which exits cleanly when both communities and votes are off', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-bin-'))
  try {
    const result = spawnSync(
      process.execPath,
      [path.resolve(import.meta.dirname, '..', 'bin', 'bitsocial-seeder.ts')],
      {
        cwd: tmpDir,
        env: {
          ...process.env,
          COMMUNITY_LIST_SOURCES: 'none',
          COMMUNITY_EXTRA_LIST_SOURCES: '',
          VOTES_MANIFEST_SOURCES: 'none',
          SEEDER_DB_PATH: path.join(tmpDir, 'seeder.db'),
          SEEDER_STATE_PATH: path.join(tmpDir, 'seederState.json'),
          SEEDER_UPDATE_CHECK_ENABLED: 'false'
        },
        encoding: 'utf8',
        timeout: 60_000
      }
    )
    assert.match(result.stdout, /nothing to seed/)
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  }
  finally {
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
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
      // 'none', not '', so the smoke test does not start a real votes libp2p node now that
      // votes seeding is on by default.
      VOTES_MANIFEST_SOURCES: 'none',
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

// One contest, same shape as the published manifest, kept local so the votes-only tests never
// fetch the real one.
const writeVotesManifest = (tmpDir: string) => {
  const manifestPath = path.join(tmpDir, 'directory-criteria.jsonc')
  fs.writeFileSync(manifestPath, JSON.stringify({
    name: 'votes-only boot test',
    defaults: {
      voteSchema: {min: 1, max: 1},
      maxVotesPerAddress: 1,
      blocksPerBucket: 43200,
      voteExpiryBuckets: 30,
      rule: {
        type: 'erc721-min-balance',
        chain: 'base',
        contract: '0x13d41d6B8EA5C86096bb7a94C3557FCF184491b9',
        min: 1
      },
      weight: {type: 'constant', value: 1},
      requires: {rules: ['erc721-min-balance', 'constant'], chains: {base: {chainId: 8453}}}
    },
    contests: [{contestId: 'a', name: '/a/ - Anime & Manga'}]
  }))
  return manifestPath
}

// The votes-only seeder (the shape new-plebbit runs): COMMUNITY_LIST_SOURCES=none must be a
// supported boot path, not a config error and not a hang. Before votes-only was first-class,
// this config exited on start.ts's guard, and pointing the guard at an empty local list
// instead left the boot loop spinning forever waiting for a discovery that never completes.
test('start.ts boots votes-only when community seeding is off', {timeout: 120_000}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-votes-only-'))
  const pkcFake = createFakePkcRpcServer()
  const kuboFake = createFakeKuboRpcServer()
  // A Routing V1 router that 404s everything, so no announce traffic leaves the machine.
  const fakeRouter = http.createServer((request, response) => {
    response.statusCode = 404
    response.end()
  })
  const [pkcPort, kuboPort, routerPort, tcpPort, wsPort, closedChainPort, closedEthPort] =
    await Promise.all(Array.from({length: 7}, getFreePort))
  await Promise.all([
    pkcFake.listen(pkcPort),
    kuboFake.listen(kuboPort),
    new Promise<void>(resolve => fakeRouter.listen(routerPort, '127.0.0.1', () => resolve()))
  ])

  const manifestPath = writeVotesManifest(tmpDir)

  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '..', 'start.ts')], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PKC_RPC_URL: `ws://127.0.0.1:${pkcPort}`,
      KUBO_RPC_URL: `http://127.0.0.1:${kuboPort}/api/v0`,
      COMMUNITY_LIST_SOURCES: 'none',
      COMMUNITY_EXTRA_LIST_SOURCES: '',
      VOTES_MANIFEST_SOURCES: manifestPath,
      VOTES_HTTP_ROUTER_URLS: `http://127.0.0.1:${routerPort}`,
      VOTES_LIBP2P_HOST: '127.0.0.1',
      VOTES_LIBP2P_TCP_PORT: String(tcpPort),
      VOTES_LIBP2P_WS_PORT: String(wsPort),
      VOTES_CHAIN_RPC_URLS: JSON.stringify({base: [`http://127.0.0.1:${closedChainPort}`]}),
      VOTES_ETH_RPC_URLS: `http://127.0.0.1:${closedEthPort}`,
      VOTES_PEER_KEY_PATH: path.join(tmpDir, 'votes-peer.key'),
      VOTES_BLOCKSTORE_PATH: path.join(tmpDir, 'votes-blockstore'),
      VOTES_DATASTORE_PATH: path.join(tmpDir, 'votes-datastore'),
      VOTES_DATA_PATH: path.join(tmpDir, 'votes-cache'),
      SEEDER_DB_PATH: path.join(tmpDir, 'seeder.db'),
      SEEDER_STATE_PATH: path.join(tmpDir, 'seederState.json'),
      SEEDER_UPDATE_CHECK_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  const votesOnlyLine = new Promise<void>(resolve => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (/seeding votes only/.test(output)) {
        resolve()
      }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
  })
  const exited = new Promise<{code: number | null, signal: string | null}>(resolve => {
    child.once('exit', (code, signal) => resolve({code, signal}))
  })

  try {
    await Promise.race([
      votesOnlyLine,
      exited.then(({code, signal}) => {
        throw Error(`start.ts exited before votes seeding started (code: ${code}, signal: ${signal})\noutput:\n${output}`)
      }),
      new Promise<never>((resolve, reject) => setTimeout(
        () => reject(Error(`timed out waiting for the votes-only boot line\noutput:\n${output}`)),
        90_000
      ).unref())
    ])

    // The community half must be entirely absent — no discovery, no boot-wait spin.
    assert.doesNotMatch(output, /no communities discovered yet/, `votes-only must not wait on discovery\noutput:\n${output}`)
    assert.doesNotMatch(output, /discovering communities from/, `votes-only must not run discovery\noutput:\n${output}`)
    assert.doesNotMatch(output, /nothing to seed/, `votes-only is a valid config\noutput:\n${output}`)

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
    await Promise.all([
      pkcFake.close(),
      kuboFake.close(),
      new Promise<void>(resolve => fakeRouter.close(() => resolve()))
    ])
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})

// The incident this guards: a votes-only seeder used to run ensureDaemon() unconditionally, so
// a container restarting while the machine's real daemon was down spawned the bundled daemon,
// which claimed the PKC RPC port and blocked the real daemon from coming back. The votes half
// needs no daemon at all, so with NO daemon RPCs reachable and autostart left on (the default)
// this must boot straight into votes seeding and never touch the daemon path.
//
// PKC_RPC_URL points at TEST-NET-2, deliberately not localhost: if the gate ever regresses,
// ensureDaemon refuses to autostart for a non-local URL and start.ts exits 1 — this test fails
// on the exit instead of spawning a real bitsocial-cli daemon on the machine running it.
test('a votes-only seeder starts no daemon, even with autostart on and no daemon reachable', {timeout: 120_000}, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitsocial-seeder-no-daemon-'))
  const fakeRouter = http.createServer((request, response) => {
    response.statusCode = 404
    response.end()
  })
  const [routerPort, tcpPort, wsPort, closedKuboPort, closedChainPort, closedEthPort] =
    await Promise.all(Array.from({length: 6}, getFreePort))
  await new Promise<void>(resolve => fakeRouter.listen(routerPort, '127.0.0.1', () => resolve()))

  const manifestPath = writeVotesManifest(tmpDir)

  const child = spawn(process.execPath, [path.resolve(import.meta.dirname, '..', 'start.ts')], {
    cwd: tmpDir,
    env: {
      ...process.env,
      PKC_RPC_URL: 'ws://198.51.100.1:9138',
      KUBO_RPC_URL: `http://127.0.0.1:${closedKuboPort}/api/v0`,
      SEEDER_DAEMON_AUTOSTART: 'true',
      COMMUNITY_LIST_SOURCES: 'none',
      COMMUNITY_EXTRA_LIST_SOURCES: '',
      VOTES_MANIFEST_SOURCES: manifestPath,
      VOTES_HTTP_ROUTER_URLS: `http://127.0.0.1:${routerPort}`,
      VOTES_LIBP2P_HOST: '127.0.0.1',
      VOTES_LIBP2P_TCP_PORT: String(tcpPort),
      VOTES_LIBP2P_WS_PORT: String(wsPort),
      VOTES_CHAIN_RPC_URLS: JSON.stringify({base: [`http://127.0.0.1:${closedChainPort}`]}),
      VOTES_ETH_RPC_URLS: `http://127.0.0.1:${closedEthPort}`,
      VOTES_PEER_KEY_PATH: path.join(tmpDir, 'votes-peer.key'),
      VOTES_BLOCKSTORE_PATH: path.join(tmpDir, 'votes-blockstore'),
      VOTES_DATASTORE_PATH: path.join(tmpDir, 'votes-datastore'),
      VOTES_DATA_PATH: path.join(tmpDir, 'votes-cache'),
      SEEDER_DB_PATH: path.join(tmpDir, 'seeder.db'),
      SEEDER_STATE_PATH: path.join(tmpDir, 'seederState.json'),
      SEEDER_UPDATE_CHECK_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let output = ''
  const seedingLine = new Promise<void>(resolve => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (/seeding \d+ votes contests/.test(output)) {
        resolve()
      }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
  })
  const exited = new Promise<{code: number | null, signal: string | null}>(resolve => {
    child.once('exit', (code, signal) => resolve({code, signal}))
  })

  try {
    await Promise.race([
      seedingLine,
      exited.then(({code, signal}) => {
        throw Error(`start.ts exited instead of seeding votes without a daemon (code: ${code}, signal: ${signal})\noutput:\n${output}`)
      }),
      new Promise<never>((resolve, reject) => setTimeout(
        () => reject(Error(`timed out waiting for votes seeding\noutput:\n${output}`)),
        90_000
      ).unref())
    ])

    // No part of the daemon path may run: no spawn, no attach, no wait, no autostart error.
    assert.doesNotMatch(output, /starting bundled bitsocial daemon/, `must not spawn a daemon\noutput:\n${output}`)
    assert.doesNotMatch(output, /using existing bitsocial daemon RPCs/, `must not probe for a daemon\noutput:\n${output}`)
    assert.doesNotMatch(output, /waiting for the existing daemon/, `must not wait on a daemon\noutput:\n${output}`)
    assert.doesNotMatch(output, /bitsocial daemon RPCs are not ready/, `must not require a daemon\noutput:\n${output}`)
    assert.doesNotMatch(output, /cannot autostart a daemon/, `must not reach the autostart path at all\noutput:\n${output}`)
    assert.match(output, /no bitsocial daemon needed/)

    // The bundled daemon's data path is never created, so nothing is left to clean up.
    assert.equal(fs.existsSync(path.join(tmpDir, 'bitsocial')), false)

    child.kill('SIGINT')
    const {code, signal} = await exited
    assert.equal(signal, null, `start.ts should exit itself, not die to the signal\noutput:\n${output}`)
    assert.equal(code, 0, `expected a clean exit\noutput:\n${output}`)
  }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await new Promise<void>(resolve => fakeRouter.close(() => resolve()))
    fs.rmSync(tmpDir, {recursive: true, force: true})
  }
})
