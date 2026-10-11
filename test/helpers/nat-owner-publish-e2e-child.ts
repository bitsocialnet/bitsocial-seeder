// Child process for test/nat-owner-publish-e2e.test.ts (bitsocialnet/bitsocial-seeder#25).
//
// Three nodes and one HTTP router, all hermetic (no bootstrap peers, no public routers, no
// AutoConf):
//
//   router   an in-memory Routing V1 server standing in for the pkc http routers: it stores
//            the provider records the kubos PUT to it (dropping address-less ones, like the
//            real router) and answers lookups with them — it is never told about any peer.
//   owner    bitsocial-cli daemon (kubo + PKC RPC) hosting the community. Its kubo is forced
//            to private reachability, announces no addresses, runs the relay client and has
//            no bootstrap peers — the NATed desktop setup from pkcprotocol/pkc-js#369. Its
//            only way to the seeder is kubo's own pubsub peer discovery, which looks up the
//            `floodsub:<topic>` routing CID through the router.
//   seeder   a bitsocial-cli daemon with public reachability and the relay service on, plus
//            the real seeding code (subscribeCommunitiesUpdates + joinPubsubTopics + the
//            routing-provide worker) so its kubo joins and provides the community's topics.
//   browser  a pkc-js libp2p-js client (what 5chan.app runs) whose only peer source is the
//            router.
//
// The owner must find and dial the seeder on its own. Then the browser loads the community,
// publishes a post through a `question` challenge (all
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
const initKuboRepo = (ipfsPath: string, {apiPort, gatewayPort, routerUrl, patch}: {apiPort: number, gatewayPort: number, routerUrl: string, patch: (config: any) => void}) => {
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
  // Exactly the Routing config pkc-js writes for its http routers
  // (runtime/node/setup-kubo-http-routers): find-providers and provide go to the router only.
  // Pre-writing it keeps the daemon's pkc-js from rewriting it and restarting kubo.
  config.Routing = {
    ...config.Routing,
    DelegatedRouters: [],
    Type: 'custom',
    Methods: {
      'find-providers': {RouterName: 'HttpRoutersParallel'},
      provide: {RouterName: 'HttpRoutersParallel'},
      'find-peers': {RouterName: 'HttpRouterNotSupported'},
      'get-ipns': {RouterName: 'HttpRouterNotSupported'},
      'put-ipns': {RouterName: 'HttpRouterNotSupported'}
    },
    Routers: {
      HttpRoutersParallel: {Type: 'parallel', Parameters: {Routers: [{RouterName: 'HttpRouter1', IgnoreErrors: true, Timeout: '10s'}]}},
      HttpRouterNotSupported: {Type: 'http', Parameters: {Endpoint: 'http://kubohttprouternotsupported'}},
      HttpRouter1: {Type: 'http', Parameters: {Endpoint: routerUrl}}
    }
  }
  config.Provide = {...config.Provide, DHT: {...config.Provide?.DHT, SweepEnabled: false}}
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

// The seeder code (config.ts) reads these at import time.
process.env.PKC_RPC_URL = `ws://127.0.0.1:${seederPkcPort}`
process.env.KUBO_RPC_URL = `http://127.0.0.1:${seederKuboPort}/api/v0`
process.env.IPFS_GATEWAY_URL = `http://127.0.0.1:${seederGatewayPort}`
process.env.SEEDER_DB_PATH = path.join(tmpDir, 'seeder.db')
process.env.SEEDER_STATE_PATH = path.join(tmpDir, 'seederState.json')

// --- HTTP router -----------------------------------------------------------------------------
// Routing V1 PUT bodies are `{Providers: [{Schema, Payload: {ID, Addrs, Keys, ...}}]}`. The
// real router verifies signatures and drops records with no addrs; this one trusts the
// loopback kubos but drops address-less records the same way, so the owner (which announces
// nothing) is never handed out and nobody can learn a way to dial it.
const routerUrl = `http://127.0.0.1:${routerPort}`
const routerProviders = new Map<string, Map<string, string[]>>()
const routerProvidesByPeer = new Map<string, number>()
let routerLookups = 0
const router = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  const lookupPrefix = '/routing/v1/providers/'
  if (request.method === 'GET' && request.url?.startsWith(lookupPrefix)) {
    routerLookups++
    const cid = request.url.slice(lookupPrefix.length).split('?')[0]
    const Providers = [...(routerProviders.get(cid) || new Map())].map(([ID, Addrs]) => ({Schema: 'peer', ID, Addrs, Protocols: ['transport-bitswap']}))
    response.end(JSON.stringify({Providers}))
    return
  }
  const chunks: Buffer[] = []
  request.on('data', chunk => chunks.push(chunk))
  request.once('end', () => {
    if (request.method === 'PUT' && request.url?.startsWith('/routing/v1/providers')) {
      try {
        const {Providers = []} = JSON.parse(Buffer.concat(chunks).toString() || '{}')
        for (const {Payload} of Providers) {
          if (typeof Payload?.ID !== 'string' || !Payload.Addrs?.length) {
            continue
          }
          for (const key of Payload.Keys || []) {
            if (!routerProviders.has(key)) {
              routerProviders.set(key, new Map())
            }
            routerProviders.get(key)!.set(Payload.ID, Payload.Addrs)
          }
          routerProvidesByPeer.set(Payload.ID, (routerProvidesByPeer.get(Payload.ID) || 0) + 1)
        }
      }
      catch {}
    }
    response.end(JSON.stringify({ProvideResults: []}))
  })
})
await new Promise<void>((resolve, reject) => {
  router.once('error', reject)
  router.listen(routerPort, '127.0.0.1', () => resolve())
})
step(`http router listening on ${routerUrl}`)

const {buildDaemonArgs, isPkcRpcReady, isKuboRpcReachable} = await import('../../lib/daemon.ts')

// Both daemons are spawned here rather than through ensureDaemon so they can be pointed at
// the router (--pkcOptions.httpRoutersOptions); the seeder code then reuses its daemon over
// PKC_RPC_URL/KUBO_RPC_URL like any already-running local daemon.
type Daemon = {name: string, kuboRpcUrl: string, process: ChildProcess, exit?: {code: number | null, signal: NodeJS.Signals | null}}
const daemons: Daemon[] = []

const startDaemon = async ({name, pkcPort, kuboPort, gatewayPort, patch}: {name: string, pkcPort: number, kuboPort: number, gatewayPort: number, patch: (config: any) => void}) => {
  const dataPath = path.join(tmpDir, `${name}-daemon-data`)
  initKuboRepo(path.join(dataPath, '.bitsocial-cli.ipfs'), {apiPort: kuboPort, gatewayPort, routerUrl, patch})
  const pkcRpcUrl = `ws://127.0.0.1:${pkcPort}`
  const kuboRpcUrl = `http://127.0.0.1:${kuboPort}/api/v0`
  const args = [
    ...buildDaemonArgs({pkcRpcUrl, dataPath, logPath: path.join(tmpDir, `${name}-daemon.log`)}),
    '--pkcOptions.httpRoutersOptions[0]', routerUrl
  ]
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: {...process.env, KUBO_RPC_URL: kuboRpcUrl, IPFS_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`},
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const daemon: Daemon = {name, kuboRpcUrl, process: child}
  daemons.push(daemon)
  const prefixOutput = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line) {
        console.log(`[${name} daemon] ${line}`)
      }
    }
  }
  child.stdout!.on('data', prefixOutput)
  child.stderr!.on('data', prefixOutput)
  child.once('exit', (code, signal) => {
    daemon.exit = {code, signal}
  })
  await waitFor(`the ${name} daemon RPCs`, Number(process.env.SEEDER_DAEMON_READY_TIMEOUT_MS || 120_000), async () => {
    if (daemon.exit) {
      throw Error(`${name} daemon exited before it was ready (code: ${daemon.exit.code}, signal: ${daemon.exit.signal})`)
    }
    const [pkcReady, kuboReady] = await Promise.all([isPkcRpcReady(pkcRpcUrl), isKuboRpcReachable(kuboRpcUrl)])
    return pkcReady && kuboReady
  })
  return {daemon, pkcRpcUrl, kuboRpcUrl}
}

const stopDaemon = async (daemon: Daemon) => {
  if (daemon.exit) {
    return
  }
  const exited = new Promise<void>(resolve => daemon.process.once('exit', () => resolve()))
  daemon.process.kill('SIGINT')
  const killTimer = setTimeout(() => {
    // bitsocial-cli spawns kubo detached; if the daemon has to be SIGKILLed, its kubo would
    // outlive the test — ask it to shut down over its RPC first.
    fetch(`${daemon.kuboRpcUrl}/shutdown`, {method: 'POST', signal: AbortSignal.timeout(2000)}).catch(() => {})
    daemon.process.kill('SIGKILL')
  }, 20_000)
  await exited
  clearTimeout(killTimer)
}

const pkcInstances: any[] = []

let exitCode = 0
try {
  // --- seeder daemon -----------------------------------------------------------------------
  const seeder = await startDaemon({
    name: 'seeder',
    pkcPort: seederPkcPort,
    kuboPort: seederKuboPort,
    gatewayPort: seederGatewayPort,
    patch: config => {
      // Random loopback ports: tcp for the owner's kubo, websocket for the browser (a real
      // browser can only dial WSS). NoAnnounce is emptied so the provider records carry the
      // loopback addrs — in production the seeder announces its public ones.
      config.Addresses.Swarm = ['/ip4/127.0.0.1/tcp/0', '/ip4/127.0.0.1/tcp/0/ws']
      config.Addresses.NoAnnounce = []
      config.Internal = {...config.Internal, Libp2pForceReachability: 'public'}
      config.Swarm.RelayService = {Enabled: true}
    }
  })
  const {kubo: seederKubo, kuboPubsub: seederKuboPubsub, pkc: seederPkc} = await import('../../lib/bitsocial.ts')
  pkcInstances.push(seederPkc)
  const seederPeerId = (await seederKubo.id()).id.toString()
  step(`seeder daemon ready, kubo peer ${seederPeerId}`)

  // --- owner daemon ----------------------------------------------------------------------
  const owner = await startDaemon({
    name: 'owner',
    pkcPort: ownerPkcPort,
    kuboPort: ownerKuboPort,
    gatewayPort: ownerGatewayPort,
    patch: config => {
      // Loopback-only listen, no announced addresses, forced private reachability, relay
      // client on, no bootstrap peers: nobody can dial this node and it knows nobody to dial.
      config.Addresses.Swarm = ['/ip4/127.0.0.1/tcp/0']
      config.Internal = {...config.Internal, Libp2pForceReachability: 'private'}
      config.Swarm.RelayClient = {Enabled: true}
    }
  })
  const {create: createKubo} = await import('kubo-rpc-client')
  const ownerKubo = createKubo({url: owner.kuboRpcUrl})
  const ownerId = await ownerKubo.id()
  const ownerPeerId = ownerId.id.toString()
  // With nothing to announce kubo reports the bare `/p2p/<id>` entry.
  const ownerAnnouncedAddrs = ownerId.addresses.map(String).filter(addr => addr !== `/p2p/${ownerPeerId}`)
  assert.deepEqual(ownerAnnouncedAddrs, [], `the owner kubo must announce no addresses, got ${ownerAnnouncedAddrs.join(', ')}`)
  assert.deepEqual(await ownerKubo.swarm.peers(), [], 'the owner kubo must start with no peers')
  step(`owner daemon ready, kubo peer ${ownerPeerId} announces no addresses and has no peers`)

  // --- community on the owner ------------------------------------------------------------
  const {default: PKC} = await import('@pkcprotocol/pkc-js')
  const ownerPkc = await PKC({pkcRpcClientsOptions: [owner.pkcRpcUrl]})
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
  // Same loop the scheduler runs (start.ts): subscribe to community updates, join the topics
  // of resolved communities, provide their routing CIDs. Nothing here tells either side about
  // the other; the first update can only resolve once the owner has found the seeder.
  const {default: seederState} = await import('../../lib/seeder-state.ts')
  seederState.communitiesSeeding = [{address: communityAddress}]
  const {subscribeCommunitiesUpdates, joinPubsubTopics, providePubsubTopicRoutingCids} = await import('../../lib/seed-communities.ts')
  const {makeProcessPubsubRoutingProvide, pubsubRoutingQueue} = await import('../../lib/seed-communities-core.ts')
  const processProvide = makeProcessPubsubRoutingProvide(seederKubo)
  await subscribeCommunitiesUpdates()

  const pubsubTopic = await waitFor('the seeder kubo to join the community pubsub topic', 300_000, async () => {
    await joinPubsubTopics()
    await providePubsubTopicRoutingCids()
    let job
    while ((job = pubsubRoutingQueue.claimOne('nat-owner-e2e-worker'))) {
      await processProvide(job)
      job.ack()
    }
    const topics = await seederKuboPubsub.pubsub.ls()
    return topics.find(topic => topic === communityAddress)
  }, 2000)
  step(`seeder kubo joined pubsub topic ${pubsubTopic}`)

  // The owner announces nothing and the router never hands it out, so the connection can
  // only be one the owner dialed, to an address it got from the router.
  const ownerToSeeder = (await ownerKubo.swarm.peers()).find(peer => peer.peer.toString() === seederPeerId)
  assert.ok(ownerToSeeder, 'the owner kubo should have dialed the seeder kubo')
  assert.ok(![...routerProviders.values()].some(providers => providers.has(ownerPeerId)), 'the router must never hand out the owner')
  assert.ok(routerProvidesByPeer.get(seederPeerId), 'the seeder kubo should have provided to the router')
  step(`owner kubo found and dialed the seeder kubo at ${ownerToSeeder.addr} through the router`)

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
  assert.ok(routerLookups > 0, 'the nodes should have discovered the seeder through the http router')
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
  await stopDaemon(seeder.daemon)
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
for (const daemon of daemons) {
  await stopDaemon(daemon)
}
router.close()
step('done')
process.exit(exitCode)
