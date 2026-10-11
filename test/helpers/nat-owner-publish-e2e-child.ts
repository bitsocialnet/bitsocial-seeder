// Child process for test/nat-owner-publish-e2e.test.ts (bitsocialnet/bitsocial-seeder#25).
//
// Three nodes, all hermetic (no bootstrap peers, no public routers, no AutoConf):
//
//   owner    bitsocial-cli daemon (kubo + PKC RPC) hosting the community. Its kubo is forced
//            to private reachability, announces no addresses, runs the relay client and only
//            knows the seeder as a bootstrap peer — the NATed desktop setup from
//            pkcprotocol/pkc-js#369.
//   seeder   the bundled daemon this repo seeds through, with public reachability and the
//            relay service on, plus the real seeding code (subscribeCommunitiesUpdates +
//            joinPubsubTopics) so its kubo joins the community's pubsub topic.
//   browser  a pkc-js libp2p-js client (what 5chan.app runs) whose only peer source is an
//            HTTP router that answers every lookup with the seeder's websocket address.
//
// The browser loads the community, publishes a post through a `question` challenge (all
// four pubsub messages: challengerequest → challenge → challengeanswer →
// challengeverification), and the post must land in the owner's community. Then the seeder
// is stopped and a fresh browser must fail to publish, proving the seeder carried the
// messages. Lives outside the test/*.test.ts glob so the runner never executes it directly.
import assert from 'node:assert/strict'
import {spawn, spawnSync} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import {createRequire} from 'node:module'
import net from 'node:net'
import path from 'node:path'

const require = createRequire(import.meta.url)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const startedAt = Date.now()
const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(1)}s`
const step = (message: string) => console.log(`[nat owner e2e ${elapsed()}] ${message}`)

const getFreePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer()
  server.listen(0, '127.0.0.1', () => {
    const {port} = server.address() as net.AddressInfo
    server.close(() => resolve(port))
  })
  server.once('error', reject)
})

const waitFor = async <T>(description: string, timeoutMs: number, check: () => Promise<T | undefined | false> | T | undefined | false, intervalMs = 1000) => {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const result = await check()
    if (result) {
      return result
    }
    if (Date.now() >= deadline) {
      throw Error(`timed out after ${timeoutMs}ms waiting for ${description}`)
    }
    await sleep(intervalMs)
  }
}

const tmpDir = process.env.SEEDER_E2E_TMP
assert.ok(tmpDir, 'SEEDER_E2E_TMP must point at the test tmp directory')
const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const kuboBinary: string = require('kubo').path()

// Kubo repos are pre-initialized so bitsocial-cli preserves our config (it only applies its
// defaults to a repo it created itself). Every "auto" placeholder kubo 0.37+ expands via
// AutoConf is replaced, so neither node ever touches the public network.
const initKuboRepo = (ipfsPath: string, {apiPort, gatewayPort, patch}: {apiPort: number, gatewayPort: number, patch: (config: any) => void}) => {
  fs.mkdirSync(ipfsPath, {recursive: true})
  const initResult = spawnSync(kuboBinary, ['init', '--profile', 'server'], {
    env: {...process.env, IPFS_PATH: ipfsPath},
    encoding: 'utf8'
  })
  assert.equal(initResult.status, 0, `ipfs init failed: ${initResult.stderr}`)
  const configPath = path.join(ipfsPath, 'config')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  config.Addresses.API = `/ip4/127.0.0.1/tcp/${apiPort}`
  config.Addresses.Gateway = `/ip4/127.0.0.1/tcp/${gatewayPort}`
  config.Bootstrap = []
  // The server profile refuses to dial private ranges, loopback included; this network is
  // nothing but loopback.
  config.Swarm.AddrFilters = []
  config.AutoConf = {Enabled: false}
  config.Routing = {...config.Routing, DelegatedRouters: []}
  config.Ipns = {...config.Ipns, UsePubsub: true, DelegatedPublishers: []}
  config.DNS = {Resolvers: {}}
  config.AutoTLS = {Enabled: false}
  config.Discovery = {MDNS: {Enabled: false}}
  patch(config)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  return config
}

const [
  seederPkcPort, seederKuboPort, seederGatewayPort,
  ownerPkcPort, ownerKuboPort, ownerGatewayPort,
  routerPort
] = await Promise.all(Array.from({length: 7}, getFreePort))

// --- seeder daemon -------------------------------------------------------------------------
const seederDataPath = path.join(tmpDir, 'seeder-daemon-data')
process.env.PKC_RPC_URL = `ws://127.0.0.1:${seederPkcPort}`
process.env.KUBO_RPC_URL = `http://127.0.0.1:${seederKuboPort}/api/v0`
process.env.IPFS_GATEWAY_URL = `http://127.0.0.1:${seederGatewayPort}`
process.env.SEEDER_DAEMON_DATA_PATH = seederDataPath
process.env.SEEDER_DB_PATH = path.join(tmpDir, 'seeder.db')
process.env.SEEDER_STATE_PATH = path.join(tmpDir, 'seederState.json')
process.env.SEEDER_DAEMON_READY_TIMEOUT_MS = process.env.SEEDER_DAEMON_READY_TIMEOUT_MS || '120000'

initKuboRepo(path.join(seederDataPath, '.bitsocial-cli.ipfs'), {
  apiPort: seederKuboPort,
  gatewayPort: seederGatewayPort,
  patch: config => {
    // Random loopback ports: tcp for the owner's kubo, websocket for the browser (a real
    // browser can only dial WSS). NoAnnounce is emptied so `ipfs id` reports the loopback
    // addrs — in production the seeder announces its public ones.
    config.Addresses.Swarm = ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0/ws']
    config.Addresses.NoAnnounce = []
    config.Internal = {...config.Internal, Libp2pForceReachability: 'public'}
    config.Swarm.RelayService = {Enabled: true}
  }
})
step(`seeder kubo repo pre-initialized, pkc=${seederPkcPort} kubo=${seederKuboPort} gateway=${seederGatewayPort}`)

const {ensureDaemon, stopDaemon, buildDaemonArgs, isPkcRpcReady, isKuboRpcReachable} = await import('../../lib/daemon.ts')

let ownerDaemon: ChildProcess | undefined
let ownerDaemonExit: {code: number | null, signal: NodeJS.Signals | null} | undefined
let router: http.Server | undefined
const pkcInstances: any[] = []
const ownerKuboRpcUrl = `http://127.0.0.1:${ownerKuboPort}/api/v0`

const stopOwnerDaemon = async () => {
  if (!ownerDaemon || ownerDaemonExit) {
    return
  }
  const exited = new Promise<void>(resolve => ownerDaemon!.once('exit', () => resolve()))
  ownerDaemon.kill('SIGINT')
  const killTimer = setTimeout(() => {
    // bitsocial-cli spawns kubo detached; if the daemon has to be SIGKILLed, its kubo would
    // outlive the test — ask it to shut down over its RPC first.
    fetch(`${ownerKuboRpcUrl}/shutdown`, {method: 'POST', signal: AbortSignal.timeout(2000)}).catch(() => {})
    ownerDaemon!.kill('SIGKILL')
  }, 20_000)
  await exited
  clearTimeout(killTimer)
}

let exitCode = 0
try {
  const {started, status} = await ensureDaemon()
  assert.equal(started, true, 'the test must spawn its own bundled seeder daemon')
  assert.equal(status.ready, true)
  const {kubo: seederKubo, kuboPubsub: seederKuboPubsub, pkc: seederPkc} = await import('../../lib/bitsocial.ts')
  pkcInstances.push(seederPkc)
  const seederId = await seederKubo.id()
  const seederPeerId = seederId.id.toString()
  const seederAddrs = seederId.addresses.map(addr => addr.toString())
  const seederTcpAddr = seederAddrs.find(addr => addr.includes('/ip4/127.0.0.1/tcp/') && !addr.includes('/ws'))
  const seederWsAddr = seederAddrs.find(addr => addr.includes('/ip4/127.0.0.1/tcp/') && addr.includes('/ws'))
  assert.ok(seederTcpAddr, `seeder kubo should announce a loopback tcp addr, got ${seederAddrs.join(', ')}`)
  assert.ok(seederWsAddr, `seeder kubo should announce a loopback ws addr, got ${seederAddrs.join(', ')}`)
  step(`seeder daemon ready, kubo peer ${seederPeerId} at ${seederTcpAddr} and ${seederWsAddr}`)

  // --- HTTP router -----------------------------------------------------------------------
  // Stands in for the delegated Routing V1 routers pkc-js clients query (the seeder
  // provides every seeded community's pubsub topic routing CID to them, see
  // lib/seed-communities-core.ts): every provider lookup answers with the seeder's
  // browser-dialable address and nothing else. Writes (announcements from the owner's
  // daemon) are acknowledged and dropped.
  const routerUrl = `http://127.0.0.1:${routerPort}`
  const routerProviders = {
    Providers: [{Schema: 'peer', ID: seederPeerId, Addrs: [seederWsAddr], Protocols: ['transport-bitswap']}]
  }
  let routerLookups = 0
  router = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'GET' && request.url?.startsWith('/routing/v1/providers/')) {
      routerLookups++
      response.end(JSON.stringify(routerProviders))
      return
    }
    request.resume()
    request.once('end', () => response.end(JSON.stringify({ProvideResults: []})))
  })
  await new Promise<void>((resolve, reject) => {
    router!.once('error', reject)
    router!.listen(routerPort, '127.0.0.1', () => resolve())
  })
  step(`mock http router listening on ${routerUrl}`)

  // --- owner daemon ----------------------------------------------------------------------
  const ownerDataPath = path.join(tmpDir, 'owner-daemon-data')
  initKuboRepo(path.join(ownerDataPath, '.bitsocial-cli.ipfs'), {
    apiPort: ownerKuboPort,
    gatewayPort: ownerGatewayPort,
    patch: config => {
      // Loopback-only listen, no announced addresses, forced private reachability, relay
      // client on: nobody can dial this node, it can only dial out — to the seeder.
      config.Addresses.Swarm = ['/ip4/127.0.0.1/tcp/0']
      config.Bootstrap = [seederTcpAddr]
      config.Internal = {...config.Internal, Libp2pForceReachability: 'private'}
      config.Swarm.RelayClient = {Enabled: true}
    }
  })
  const ownerPkcRpcUrl = `ws://127.0.0.1:${ownerPkcPort}`
  const ownerArgs = [
    ...buildDaemonArgs({pkcRpcUrl: ownerPkcRpcUrl, dataPath: ownerDataPath, logPath: path.join(tmpDir, 'owner-daemon.log')}),
    '--pkcOptions.httpRoutersOptions[0]', routerUrl
  ]
  ownerDaemon = spawn(process.execPath, ownerArgs, {
    cwd: repoRoot,
    env: {...process.env, KUBO_RPC_URL: ownerKuboRpcUrl, IPFS_GATEWAY_URL: `http://127.0.0.1:${ownerGatewayPort}`},
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const prefixOwnerOutput = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line) {
        console.log(`[owner daemon] ${line}`)
      }
    }
  }
  ownerDaemon.stdout!.on('data', prefixOwnerOutput)
  ownerDaemon.stderr!.on('data', prefixOwnerOutput)
  ownerDaemon.once('exit', (code, signal) => {
    ownerDaemonExit = {code, signal}
  })
  await waitFor('the owner daemon RPCs', Number(process.env.SEEDER_DAEMON_READY_TIMEOUT_MS), async () => {
    if (ownerDaemonExit) {
      throw Error(`owner daemon exited before it was ready (code: ${ownerDaemonExit.code}, signal: ${ownerDaemonExit.signal})`)
    }
    const [pkcReady, kuboReady] = await Promise.all([isPkcRpcReady(ownerPkcRpcUrl), isKuboRpcReachable(ownerKuboRpcUrl)])
    return pkcReady && kuboReady
  })
  const {create: createKubo} = await import('kubo-rpc-client')
  const ownerKubo = createKubo({url: ownerKuboRpcUrl})
  const ownerId = await ownerKubo.id()
  const ownerPeerId = ownerId.id.toString()
  // With nothing to announce kubo reports the bare `/p2p/<id>` entry.
  const ownerAnnouncedAddrs = ownerId.addresses.map(String).filter(addr => addr !== `/p2p/${ownerPeerId}`)
  assert.deepEqual(ownerAnnouncedAddrs, [], `the owner kubo must announce no addresses, got ${ownerAnnouncedAddrs.join(', ')}`)
  step(`owner daemon ready, kubo peer ${ownerPeerId} announces no addresses`)

  // The owner only ever connects *out*, to its bootstrap peer.
  await waitFor('the owner kubo to connect to the seeder kubo', 60_000, async () => {
    const peers = await seederKubo.swarm.peers()
    return peers.some(peer => peer.peer.toString() === ownerPeerId)
  })
  step('owner kubo connected to seeder kubo')

  // --- community on the owner ------------------------------------------------------------
  const {default: PKC} = await import('@pkcprotocol/pkc-js')
  const ownerPkc = await PKC({pkcRpcClientsOptions: [ownerPkcRpcUrl]})
  pkcInstances.push(ownerPkc)
  ownerPkc.on('error', (error: any) => console.log(`owner pkc error: ${error?.message || error}`))
  const challengeQuestion = 'What is the seeder test password?'
  const challengeAnswer = 'bitsocial-seeder-nat-e2e'
  const ownerCommunity: any = await ownerPkc.createCommunity({
    title: 'nat owner e2e',
    settings: {challenges: [{name: 'question', options: {question: challengeQuestion, answer: challengeAnswer}}]}
  })
  assert.ok(ownerCommunity.address, 'owner daemon should create a local community over pkc rpc')
  await ownerCommunity.start()
  const communityAddress: string = ownerCommunity.address
  step(`owner hosting community ${communityAddress}`)
  await waitFor('the owner kubo to subscribe to the community pubsub topic', 60_000, async () => {
    return (await ownerKubo.pubsub.ls()).includes(communityAddress)
  })
  step('owner kubo subscribed to the community pubsub topic')

  // --- seeder seeds the community --------------------------------------------------------
  const {default: seederState} = await import('../../lib/seeder-state.ts')
  seederState.communitiesSeeding = [{address: communityAddress}]
  const {subscribeCommunitiesUpdates, joinPubsubTopics} = await import('../../lib/seed-communities.ts')
  await subscribeCommunitiesUpdates()
  // joinPubsubTopics only knows a community once its first update resolved on the seeder's
  // daemon (which resolves the owner's IPNS record through the owner↔seeder connection), so
  // run it like the scheduler does, until the seeder's kubo is in the topic.
  const pubsubTopic = await waitFor('the seeder kubo to join the community pubsub topic', 180_000, async () => {
    await joinPubsubTopics()
    const topics = await seederKuboPubsub.pubsub.ls()
    return topics.find(topic => topic === communityAddress)
  })
  step(`seeder kubo joined pubsub topic ${pubsubTopic}`)
  await waitFor('the seeder kubo to see the owner kubo as a topic peer', 60_000, async () => {
    const peers = await seederKuboPubsub.pubsub.peers(pubsubTopic)
    return peers.some(peer => peer.toString() === ownerPeerId)
  })
  step('seeder kubo sees the owner as a pubsub topic peer')

  // --- browser -----------------------------------------------------------------------------
  const createBrowserPkc = async (key: string) => {
    const pkc = await PKC({
      libp2pJsClientsOptions: [{
        key,
        // helia's node defaults refuse to dial loopback/private addresses; the whole test
        // network is loopback.
        libp2pOptions: {connectionGater: {denyDialMultiaddr: async () => false}}
      }],
      kuboRpcClientsOptions: [],
      pubsubKuboRpcClientsOptions: [],
      ipfsGatewayUrls: [],
      httpRoutersOptions: [routerUrl],
      resolveAuthorNames: false,
      noData: true
    })
    pkcInstances.push(pkc)
    pkc.on('error', (error: any) => console.log(`${key} pkc error: ${error?.message || error}`))
    const libp2pJsClient: any = Object.values(pkc.clients.libp2pJsClients)[0]
    const libp2p = libp2pJsClient._helia.libp2p
    return {pkc, libp2p, peerId: libp2p.peerId.toString()}
  }
  const browser = await createBrowserPkc('nat-owner-e2e-browser')
  step(`browser libp2p-js client started, peer ${browser.peerId}`)

  const loadStart = Date.now()
  const browserCommunity: any = await browser.pkc.getCommunity({address: communityAddress})
  assert.equal(browserCommunity.address, communityAddress)
  assert.equal(browserCommunity.title, 'nat owner e2e')
  assert.equal(browserCommunity.pubsubTopic, pubsubTopic)
  step(`browser loaded the community in ${Date.now() - loadStart}ms`)

  const publishThroughSeeder = async (label: string, pkc: any) => {
    const signer = await pkc.createSigner()
    const post: any = await pkc.createComment({
      signer,
      communityAddress,
      title: `${label} post`,
      content: 'published from a libp2p-js client through the seeder pubsub topic'
    })
    const timings: {[event: string]: number} = {}
    const publishStart = Date.now()
    const verification: any = await new Promise((resolve, reject) => {
      post.once('challenge', (challenge: any) => {
        timings.challenge = Date.now() - publishStart
        assert.equal(challenge.challenges?.[0]?.challenge, challengeQuestion)
        post.publishChallengeAnswers({challengeAnswers: [challengeAnswer]}).catch(reject)
      })
      post.once('challengeverification', (challengeVerification: any) => {
        timings.challengeverification = Date.now() - publishStart
        resolve(challengeVerification)
      })
      post.once('error', reject)
      post.publish().catch(reject)
    })
    return {post, verification, timings}
  }

  const {post, verification, timings} = await publishThroughSeeder('browser', browser.pkc)
  assert.equal(verification.challengeSuccess, true, `post publish failed: ${JSON.stringify(verification.challengeErrors || verification.reason)}`)
  assert.ok(post.cid, 'a verified post should have a cid')
  step(`browser post ${post.cid} verified through the seeder: challenge after ${timings.challenge}ms, verification after ${timings.challengeverification}ms`)

  // The messages can only have travelled browser → seeder → owner and back: the browser
  // knows no peer but the seeder, and the seeder has both ends as topic peers.
  const browserPeers = browser.libp2p.getPeers().map((peer: any) => peer.toString())
  assert.deepEqual(browserPeers, [seederPeerId], `the browser must only be connected to the seeder, got ${browserPeers.join(', ')}`)
  const seederTopicPeers = (await seederKuboPubsub.pubsub.peers(pubsubTopic)).map(peer => peer.toString())
  assert.ok(seederTopicPeers.includes(ownerPeerId), `seeder topic peers should include the owner, got ${seederTopicPeers.join(', ')}`)
  assert.ok(seederTopicPeers.includes(browser.peerId), `seeder topic peers should include the browser, got ${seederTopicPeers.join(', ')}`)
  assert.ok(routerLookups > 0, 'the browser should have discovered the seeder through the http router')
  step(`topology confirmed: browser peers=[${browserPeers.join(', ')}], seeder topic peers=[${seederTopicPeers.join(', ')}], router lookups=${routerLookups}`)

  // The post lands in the owner's community (its database, read back over the owner's RPC).
  await waitFor('the owner community to list the post', 120_000, async () => {
    await ownerCommunity.update().catch(() => {})
    return ownerCommunity.lastPostCid === post.cid
  })
  assert.equal(ownerCommunity.lastPostCid, post.cid)
  step('owner community update lists the post as lastPostCid')

  // --- negative control: without the seeder nothing carries the messages -------------------
  await browser.pkc.destroy()
  step('stopping the seeder daemon')
  await stopDaemon()
  await waitFor('the owner kubo to lose the seeder connection', 60_000, async () => {
    const peers = await ownerKubo.swarm.peers()
    return !peers.some(peer => peer.peer.toString() === seederPeerId)
  })
  step('seeder daemon stopped, owner kubo has no peers left')

  const lonelyBrowser = await createBrowserPkc('nat-owner-e2e-browser-without-seeder')
  const signer = await lonelyBrowser.pkc.createSigner()
  // getCommunity would hang on IPNS resolution with nobody to ask, so publish against the
  // community record the first browser already loaded — the question is only whether the
  // challenge exchange has a path.
  const lonelyPost: any = await lonelyBrowser.pkc.createComment({
    signer,
    communityAddress,
    title: 'post without a seeder',
    content: 'must never be verified'
  })
  const controlWindowMs = 60_000
  const outcome: string = await new Promise(resolve => {
    const timer = setTimeout(() => resolve('no challenge or verification within the control window'), controlWindowMs)
    const settle = (result: string) => {
      clearTimeout(timer)
      resolve(result)
    }
    lonelyPost.once('challenge', () => settle('challenge'))
    lonelyPost.once('challengeverification', () => settle('challengeverification'))
    lonelyPost.on('publishingstatechange', (state: string) => {
      if (state === 'failed') {
        settle(`publishingState failed: ${lonelyPost.publishingState}`)
      }
    })
    lonelyPost.once('error', (error: any) => settle(`error: ${error?.code || error?.message}`))
    lonelyPost.publish().catch((error: any) => settle(`publish rejected: ${error?.code || error?.message}`))
  })
  assert.notEqual(outcome, 'challenge', 'the owner must not receive the challenge request without the seeder')
  assert.notEqual(outcome, 'challengeverification', 'the post must not be verified without the seeder')
  assert.equal(lonelyBrowser.libp2p.getPeers().length, 0, 'the browser must not have found any peer without the seeder')
  step(`without the seeder the publish did not complete (${outcome})`)
  await lonelyBrowser.pkc.destroy()
}
catch (error) {
  console.error(error)
  exitCode = 1
}

step('tearing down')
for (const pkc of pkcInstances) {
  // destroy() throws synchronously on an instance the test already destroyed.
  try {
    await pkc.destroy()
  }
  catch {}
}
await stopOwnerDaemon()
await stopDaemon()
router?.close()
step('done')
process.exit(exitCode)
