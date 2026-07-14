import fs from 'fs'
import path from 'path'
import {createLibp2p} from 'libp2p'
import {tcp} from '@libp2p/tcp'
import {webSockets} from '@libp2p/websockets'
import {noise} from '@chainsafe/libp2p-noise'
import {yamux} from '@chainsafe/libp2p-yamux'
import {identify} from '@libp2p/identify'
import {gossipsub} from '@libp2p/gossipsub'
import {fetch as fetchService} from '@libp2p/fetch'
import {delegatedRoutingV1HttpApiClient} from '@helia/delegated-routing-v1-http-api-client'
import {createHelia} from 'helia'
import {FsBlockstore} from 'blockstore-fs'
import {generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf} from '@libp2p/crypto/keys'

// The embedded libp2p + Helia node backing @bitsocial/pubsub-votes. The daemon's Kubo node
// CANNOT fill this role over RPC: votes gossipsub needs the library's validate-before-forward
// topic validators (Kubo's pubsub RPC exposes no validation or peer scoring, and since Kubo
// 0.40 hard-wires an IPNS-flavored per-peer seqno validator on every topic), and the
// checkpoint responder registers @libp2p/fetch lookup functions no Kubo RPC can register. So
// votes seeding is Helia-only: an in-process node with its own on-disk blockstore
// (blockstore-fs) — verified bundle blocks and checkpoint chunks persist across restarts and
// serve over the votes network's bitswap, with no Kubo involvement at all.
//
// The delegated Routing V1 clients double as the node's content routers, so the voter's
// cold-join findProviders() queries the same routers pkc-js clients use.

// The votes peer id persists across restarts so the provider records announced to the
// routers stay valid; a fresh id every boot would leave stale records dangling for their
// 24h TTL.
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

export const createVotesNode = async ({votesConfig}) => {
  const {listenHost, tcpPort, wsPort, httpRouterUrls, fetchMaxStreams, peerKeyPath, blockstorePath, announceMultiaddrs} = votesConfig
  const listen = [`/ip4/${listenHost}/tcp/${tcpPort}`]
  if (wsPort) {
    listen.push(`/ip4/${listenHost}/tcp/${wsPort}/ws`)
  }
  const routers = Object.fromEntries(
    httpRouterUrls.map((url, i) => [`delegatedRouting${i}`, delegatedRoutingV1HttpApiClient({url})])
  )
  const libp2p = await createLibp2p({
    privateKey: await loadOrCreatePeerKey(peerKeyPath),
    // The library's built-in router announcer reads libp2p.getMultiaddrs() and drops
    // private/unspecified addrs client-side. A 0.0.0.0 listen expands to the machine's
    // interface addrs, so a host with a public interface IP announces without config;
    // behind NAT or a Docker bridge network, `announce` (VOTES_ANNOUNCE_MULTIADDRS) must
    // carry the publicly dialable addrs.
    addresses: {listen, announce: announceMultiaddrs},
    transports: [tcp(), webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      ...routers,
      identify: identify(),
      // libp2p defaults every protocol handler to 32 inbound streams; a directory-sized
      // cold joiner opens one root-record fetch per contest, so the cap must exceed the
      // largest directory this seeder serves.
      fetch: fetchService({maxInboundStreams: fetchMaxStreams, maxOutboundStreams: fetchMaxStreams}),
      // A fresh seeder is often alone on a topic; publishing a root heartbeat to zero
      // peers must not throw.
      pubsub: gossipsub({allowPublishToZeroTopicPeers: true})
    }
  })
  const helia = await createHelia({libp2p, blockstore: new FsBlockstore(blockstorePath)})
  return helia
}
