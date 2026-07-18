// Child process for test/daemon-e2e.test.ts. Runs the real seeding stack
// against a bundled bitsocial-cli daemon: spawn daemon → host a community on it
// → subscribe with the seeder → verify pins land in the daemon's kubo.
// Lives outside the test/*.test.ts glob so the runner never executes it directly.
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import {createRequire} from 'node:module'
import net from 'node:net'
import path from 'node:path'

const require = createRequire(import.meta.url)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const startedAt = Date.now()
const step = (message: string) => console.log(`[daemon e2e ${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`)

const getFreePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address() as net.AddressInfo
    server.close(() => resolve(port))
  })
  server.once('error', reject)
})

const tmpDir = process.env.SEEDER_E2E_TMP
assert.ok(tmpDir, 'SEEDER_E2E_TMP must point at the test tmp directory')
const dataPath = path.join(tmpDir, 'daemon-data')
const [pkcPort, kuboPort, gatewayPort] = await Promise.all([getFreePort(), getFreePort(), getFreePort()])

process.env.PKC_RPC_URL = `ws://127.0.0.1:${pkcPort}`
process.env.KUBO_RPC_URL = `http://127.0.0.1:${kuboPort}/api/v0`
process.env.IPFS_GATEWAY_URL = `http://127.0.0.1:${gatewayPort}`
process.env.SEEDER_DAEMON_DATA_PATH = dataPath
process.env.SEEDER_DB_PATH = path.join(tmpDir, 'seeder.db')
process.env.SEEDER_STATE_PATH = path.join(tmpDir, 'seederState.json')
process.env.SEEDER_DAEMON_READY_TIMEOUT_MS = process.env.SEEDER_DAEMON_READY_TIMEOUT_MS || '90000'

// Pre-initialize the daemon's kubo repo so the test is hermetic: localhost-only
// swarm on a random port (no 4001 collision with a real daemon or a parallel
// test run), no bootstrap peers, and our ephemeral API/gateway ports.
// bitsocial-cli sees the existing repo and preserves this config.
const ipfsPath = path.join(dataPath, '.bitsocial-cli.ipfs')
fs.mkdirSync(ipfsPath, {recursive: true})
const kuboBinary: string = require('kubo').path()
const initResult = spawnSync(kuboBinary, ['init', '--profile', 'server'], {
  env: {...process.env, IPFS_PATH: ipfsPath},
  encoding: 'utf8'
})
assert.equal(initResult.status, 0, `ipfs init failed: ${initResult.stderr}`)
const kuboConfigPath = path.join(ipfsPath, 'config')
const kuboConfig = JSON.parse(fs.readFileSync(kuboConfigPath, 'utf8'))
kuboConfig.Addresses.API = `/ip4/127.0.0.1/tcp/${kuboPort}`
kuboConfig.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${gatewayPort}`
kuboConfig.Addresses.Swarm = ['/ip4/127.0.0.1/tcp/0']
kuboConfig.Bootstrap = []
fs.writeFileSync(kuboConfigPath, JSON.stringify(kuboConfig, null, 2))
step(`kubo repo pre-initialized, pkc=${pkcPort} kubo=${kuboPort} gateway=${gatewayPort}`)

const {ensureDaemon, stopDaemon} = await import('../../lib/daemon.ts')

let exitCode = 0
try {
  const {started, status} = await ensureDaemon()
  assert.equal(started, true, 'the test must spawn its own bundled daemon')
  assert.equal(status.ready, true)
  step('bundled daemon ready')

  const {kubo, kuboPubsub, pkc} = await import('../../lib/bitsocial.ts')
  const {version} = await kubo.version()
  assert.ok(version, 'kubo rpc should answer version')
  step(`connected to kubo ${version}`)

  // Real pin add/remove roundtrip through the worker code.
  const {makeProcessPinOp, makeProcessPubsubRoutingProvide} = await import('../../lib/seed-communities-core.ts')
  const listPins = async (cid: string) => {
    const pins: string[] = []
    for await (const pin of kubo.pin.ls({paths: [cid]})) {
      pins.push(pin.cid.toString())
    }
    return pins
  }
  const processPinOp = makeProcessPinOp(kubo)
  const blockCid = (await kubo.block.put(new TextEncoder().encode('bitsocial-seeder daemon e2e block'), {
    format: 'raw',
    mhtype: 'sha2-256',
    version: 1
  })).toString()
  await processPinOp({payload: {op: 'add', cid: blockCid, name: 'e2e block', communityAddress: 'e2e'}})
  assert.deepEqual(await listPins(blockCid), [blockCid])
  await processPinOp({payload: {op: 'remove', cid: blockCid, communityAddress: 'e2e'}})
  await assert.rejects(listPins(blockCid), /not pinned/i)
  step('pin worker add/remove roundtrip ok')

  // The joinPubsubTopics transport: subscribe over the pubsub kubo rpc.
  const pubsubTopic = 'bitsocial-seeder-daemon-e2e-topic'
  await kuboPubsub.pubsub.subscribe(pubsubTopic, () => {})
  assert.equal((await kuboPubsub.pubsub.ls()).includes(pubsubTopic), true)
  step('pubsub subscribe ok')

  // Full seeding loop: host a community on the daemon, point the seeder at it,
  // and wait for its update to reconcile pins into the durable queues.
  const community = await pkc.createCommunity({})
  assert.ok(community.address, 'daemon should create a local community over pkc rpc')
  await community.start()
  step(`hosting community ${community.address}`)

  const {default: seederState} = await import('../../lib/seeder-state.ts')
  const {db} = await import('../../lib/db.ts')
  seederState.communitiesSeeding = [{address: community.address}]
  const {subscribeCommunitiesUpdates, pubsubRoutingQueue} = await import('../../lib/seed-communities.ts')
  await subscribeCommunitiesUpdates()

  const deadline = Date.now() + 60_000
  let trackedPins: any[] = []
  while (Date.now() < deadline) {
    trackedPins = db.query('SELECT cid, name FROM community_pins')
    if (trackedPins.length > 0) {
      break
    }
    await sleep(500)
  }
  assert.ok(trackedPins.length > 0, 'the community update should track at least one pin')
  assert.ok(trackedPins.some(pin => pin.name === 'pubsub topic routing'))
  step(`community update tracked ${trackedPins.length} pins`)

  // Run the real routing-provide worker on every queued job.
  const processProvide = makeProcessPubsubRoutingProvide(kubo)
  let providedJobs = 0
  let provideJob
  while ((provideJob = pubsubRoutingQueue.claimOne('daemon-e2e-worker'))) {
    await processProvide(provideJob)
    assert.deepEqual(await listPins((provideJob.payload as any).cid), [(provideJob.payload as any).cid])
    provideJob.ack()
    providedJobs++
  }
  assert.ok(providedJobs > 0, 'the community update should queue at least one routing provide')
  step(`provided and pinned ${providedJobs} pubsub routing cids`)
}
catch (error) {
  console.error(error)
  exitCode = 1
}

step('stopping daemon')
await stopDaemon()
step('daemon stopped')
process.exit(exitCode)
