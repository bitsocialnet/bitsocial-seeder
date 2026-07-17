import * as dagCbor from '@ipld/dag-cbor'
import {CID} from 'multiformats/cid'
import {sha256} from 'multiformats/hashes/sha2'

// Decode-only diagnostics for the pubsub-voting wire shapes: the gossip message envelope
// (root heartbeat | live vote bundle) and the fetch-protocol root record served to cold
// joiners. Root heartbeats are constant-size (~95 B) regardless of vote count, so byte
// counts alone can't distinguish "the contest is empty" from "the checkpoint didn't load" —
// decode `count`, don't infer from size.
//
// pubsub-voting doesn't export its wire codecs, but every layout is canonical dag-cbor
// pinned by fixed upstream test vectors (any change there is a breaking wire change), so
// decoding them here is safe. Best-effort by design: garbage in, a fallback string out —
// never a throw on the logging path.

// The full root CID on purpose: comparing roots across peers is what settles divergence
// questions ("do we all share one tally?").
const describeRecord = (record) => `${record.count} vote bundle(s), checkpoint ${record.sizeBytes} B, root ${record.root}`

// Describe fetched root-record bytes (the `<topic>/root` fetch-protocol response).
export const describeRootRecord = (bytes) => {
  try {
    const record = dagCbor.decode(bytes)
    return typeof record?.count === 'number' ? describeRecord(record) : 'undecodable root record'
  }
  catch {
    return 'undecodable root record'
  }
}

// A bundle block's CID, matching the library's bundleCid: CIDv1, dag-cbor, sha2-256 over
// the standalone block bytes.
const bundleCidForBytes = async (bytes) => CID.createV1(dagCbor.code, await sha256.digest(bytes)).toString()

// Describe one gossip message on a votes topic (async: a bundle's CID is a hash away).
export const describeGossipMessage = async (bytes) => {
  try {
    const message = dagCbor.decode(bytes)
    if (message?.kind === 'root' && message.record) {
      return `root heartbeat: ${describeRecord(message.record)}`
    }
    if (message?.kind === 'bundle' && message.bundle instanceof Uint8Array) {
      return `live vote bundle (${message.bundle.length} B, cid ${await bundleCidForBytes(message.bundle)})`
    }
    return `unknown message kind ${JSON.stringify(message?.kind)}`
  }
  catch {
    return 'undecodable message'
  }
}
