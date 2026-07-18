import fs from 'fs'
import path from 'path'
import {randomBytes} from 'crypto'
import {createLibp2p} from 'libp2p'
import {tcp} from '@libp2p/tcp'
import {webSockets} from '@libp2p/websockets'
import {noise} from '@chainsafe/libp2p-noise'
import {yamux} from '@chainsafe/libp2p-yamux'
import {identify} from '@libp2p/identify'
import {gossipsub} from '@libp2p/gossipsub'
import {fetch as fetchService} from '@libp2p/fetch'
import {keychain} from '@libp2p/keychain'
import {http} from '@libp2p/http'
import {autoNAT} from '@libp2p/autonat'
import {bootstrap} from '@libp2p/bootstrap'
import {autoTLS} from '@ipshipyard/libp2p-auto-tls'
import {delegatedRoutingV1HttpApiClient} from '@helia/delegated-routing-v1-http-api-client'
import {createHelia} from 'helia'
import {FsBlockstore} from 'blockstore-fs'
import {FsDatastore} from 'datastore-fs'
import {generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf} from '@libp2p/crypto/keys'
import {create as createKubo} from 'kubo-rpc-client'

// The embedded libp2p + Helia node backing @bitsocial/pubsub-voting. The daemon's Kubo node
// CANNOT fill this role over RPC: votes gossipsub needs the library's validate-before-forward
// topic validators (Kubo's pubsub RPC exposes no validation or peer scoring, and since Kubo
// 0.40 hard-wires an IPNS-flavored per-peer seqno validator on every topic), and the
// checkpoint responder registers @libp2p/fetch lookup functions no Kubo RPC can register. So
// votes seeding is Helia-only: an in-process node with its own on-disk blockstore
// (blockstore-fs) — verified bundle blocks and checkpoint chunks persist across restarts and
// serve over the votes network's bitswap, with no Kubo involvement at all.
//
// Browser voters can ONLY dial WSS (and browser↔browser is impossible — the gossipsub mesh
// forms through publicly dialable seeders), so this node runs AutoTLS (libp2p.direct): once
// AutoNAT confirms the public address, the ACME broker issues a real certificate and the
// node announces browser-dialable /dns4/<peerid>.libp2p.direct/.../tls/ws addrs — zero
// operator config, no reverse proxy. The certificate takes a few minutes on first run
// (ACME + DNS propagation) and persists in the node's datastore across restarts.
//
// The delegated Routing V1 clients double as the node's content routers, so the voter's
// cold-join findProviders() queries the same routers pkc-js clients use.

// The votes peer id persists across restarts so the provider records announced to the
// routers stay valid (a fresh id every boot would leave stale records dangling for their
// 24h TTL) — and because the AutoTLS domain and any browser-pinned multiaddr embed it.
const loadOrCreatePeerKey = async (keyPath) => {
  try {
    return privateKeyFromProtobuf(new Uint8Array(fs.readFileSync(keyPath)))
  }
  catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
  const key = await generateKeyPair('Ed25519')
  fs.mkdirSync(path.dirname(path.resolve(keyPath)), {recursive: true})
  fs.writeFileSync(keyPath, privateKeyToProtobuf(key), {mode: 0o600})
  return key
}

// Keychain password (encrypts the AutoTLS certificate key at rest), generated once and
// kept next to the peer key.
const loadOrCreateKeychainPass = (peerKeyPath) => {
  const passPath = path.join(path.dirname(path.resolve(peerKeyPath)), 'votes-keychain.pass')
  try {
    return fs.readFileSync(passPath, 'utf8').trim()
  }
  catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
  }
  const pass = randomBytes(24).toString('hex')
  fs.mkdirSync(path.dirname(passPath), {recursive: true})
  fs.writeFileSync(passPath, pass, {mode: 0o600})
  return pass
}

// The public IPv4s the daemon's Kubo has CONFIRMED for itself (via its own identify
// observed-addresses + AutoNAT, backed by far more peers than the votes mesh has).
// Behind provider NAT the machine's interfaces only carry private IPs and js-libp2p's
// AutoNAT — fed by just the bootstrap connections — can take arbitrarily long to confirm
// the public address, which stalls both the router announcer (it drops private addrs)
// and AutoTLS (it waits for a confirmed address). Kubo next door has already done this
// work, so borrow its answer: best-effort, empty on any failure (Kubo down is normal —
// votes seeding must survive it, and AutoNAT can still confirm the slow way).
const kuboPublicIps = async (kuboRpcUrl) => {
  try {
    const kubo = createKubo({url: kuboRpcUrl})
    const {addresses} = await kubo.id({timeout: 10_000})
    const ips = addresses
      .map((addr) => addr.toString().match(/^\/ip4\/(\d+\.\d+\.\d+\.\d+)\//)?.[1])
      .filter(Boolean)
      .filter((ip) => !isPrivateIp(ip))
    return [...new Set(ips)]
  }
  catch {
    return []
  }
}

const isPrivateIp = (ip) => {
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

// Public peers used for AutoNAT dial-backs so libp2p confirms our public address —
// AutoTLS waits for that confirmation before requesting a certificate.
const BOOTSTRAP_PEERS = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt'
]

export const createVotesNode = async ({votesConfig, kuboRpcUrl, log = console.log}) => {
  const {listenHost, tcpPort, wsPort, httpRouterUrls, fetchMaxStreams, peerKeyPath, blockstorePath, datastorePath} = votesConfig
  const listen = [`/ip4/${listenHost}/tcp/${tcpPort}`]
  if (wsPort) {
    // Plain /ws on purpose, even with AutoTLS on: the websockets listener serves http and
    // https on the same port (first-byte sniffing) and only installs the AutoTLS
    // certificate into a listener that isn't already https — an explicit /tls/ws listen
    // creates a certless https server that rejects every handshake (TLS alert 40) forever.
    listen.push(`/ip4/${listenHost}/tcp/${wsPort}/ws`)
  }
  // Borrow the public IPs the daemon's Kubo has already confirmed and append them (with
  // OUR ports) to the announced addrs. appendAnnounce, not announce: the interface-derived
  // addrs and the AutoTLS /dns4 addr must survive. Assumes the NAT forwards our ports to
  // the same place it forwards Kubo's — true on 1:1 provider NAT and open-firewall hosts.
  const publicIps = await kuboPublicIps(kuboRpcUrl)
  const appendAnnounce = publicIps.flatMap((ip) => [
    `/ip4/${ip}/tcp/${tcpPort}`,
    ...(wsPort ? [`/ip4/${ip}/tcp/${wsPort}/ws`] : [])
  ])
  if (appendAnnounce.length > 0) {
    log(`votes node: announcing the daemon Kubo's confirmed public IP(s) ${publicIps.join(' ')} on the votes ports`)
  }
  const routers = Object.fromEntries(
    httpRouterUrls.map((url, i) => [`delegatedRouting${i}`, delegatedRoutingV1HttpApiClient({url})])
  )
  const services = {
    ...routers,
    identify: identify(),
    keychain: keychain({pass: loadOrCreateKeychainPass(peerKeyPath)}),
    // libp2p defaults every protocol handler to 32 inbound streams; a directory-sized
    // cold joiner opens one root-record fetch per contest, so the cap must exceed the
    // largest directory this seeder serves.
    fetch: fetchService({maxInboundStreams: fetchMaxStreams, maxOutboundStreams: fetchMaxStreams}),
    pubsub: gossipsub({
      // A fresh seeder is often alone on a topic; publishing a root heartbeat to zero
      // peers must not throw.
      allowPublishToZeroTopicPeers: true,
      // Several voters routinely share one IP (NAT, classroom, dev machine); the default
      // colocation penalty graylists them, which starves the very peers this seeder
      // exists to serve.
      scoreParams: {IPColocationFactorWeight: 0}
    }),
    // AutoTLS talks to the registration.libp2p.direct ACME broker over libp2p-HTTP,
    // so it requires sibling `http` and `keychain` services, and AutoNAT to confirm
    // the public address first. autoConfirmAddress matters: without it the mapped
    // /dns4/<ip-dashed>.<peerid>.libp2p.direct addr stays unconfirmed until some peer
    // successfully dials it, so it never reaches getMultiaddrs() — and therefore never
    // reaches the router announcer. Browsers can ONLY dial that addr, and they discover
    // it through the routers: unannounced = unreachable, a chicken-and-egg the
    // auto-confirm breaks (the cert only ever covers IPs this node actually announces).
    http: http(),
    autoNAT: autoNAT(),
    autoTLS: autoTLS({autoConfirmAddress: true})
  }
  const libp2p = await createLibp2p({
    privateKey: await loadOrCreatePeerKey(peerKeyPath),
    // Persists the AutoTLS certificate (and keychain) so restarts don't re-run ACME.
    datastore: new FsDatastore(datastorePath),
    // The library's router announcer reads libp2p.getMultiaddrs() and drops
    // private/unspecified addrs client-side. A 0.0.0.0 listen expands to the machine's
    // interface addrs; behind NAT the public address comes from the Kubo borrow above,
    // with identify observed-addresses + AutoNAT dial-backs as the Kubo-less fallback.
    addresses: {listen, ...(appendAnnounce.length > 0 ? {appendAnnounce} : {})},
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    peerDiscovery: [bootstrap({list: BOOTSTRAP_PEERS})],
    services
  })
  libp2p.addEventListener('certificate:provision', () => {
    log('votes node: AutoTLS certificate provisioned')
  })
  log('votes node: waiting for AutoNAT to confirm the public address, then AutoTLS provisions the certificate (a few minutes on first run)')
  const helia = await createHelia({libp2p, blockstore: new FsBlockstore(blockstorePath)})
  return helia
}
