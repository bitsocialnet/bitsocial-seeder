import * as dagCbor from '@ipld/dag-cbor'
import {CID} from 'multiformats/cid'
import {sha256} from 'multiformats/hashes/sha2'
import {base58btc} from 'multiformats/bases/base58'

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

const hex = (bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`

// "anime-and-manga.bso:+1" / "12D3KooW…:+1" per vote in the bundle — WHO voted for WHAT
// is the question every debugging session asks first.
const describeBundleVotes = (bundle) => {
  try {
    const wire = dagCbor.decode(bundle)
    const votes = (wire?.votes ?? []).map((vote) => {
      const community = vote?.community?.name
        ?? (vote?.community?.publicKey instanceof Uint8Array ? base58btc.encode(vote.community.publicKey).slice(1) : '(unknown)')
      return `${community}:${vote?.vote >= 0 ? '+' : ''}${vote?.vote}`
    })
    const address = wire?.address instanceof Uint8Array ? hex(wire.address) : '(unknown address)'
    return `${address} votes [${votes.join(', ')}] at block ${wire?.blockNumber}`
  }
  catch {
    return '(undecodable bundle)'
  }
}

// Parse one gossip message on a votes topic into its envelope kind, so callers can treat
// heartbeats and live bundles differently (heartbeats tick constantly on every contest;
// bundles are rare and precious).
export const parseGossipMessage = (bytes) => {
  try {
    const message = dagCbor.decode(bytes)
    if (message?.kind === 'root' && typeof message.record?.count === 'number') {
      return {kind: 'root', record: message.record}
    }
    if (message?.kind === 'bundle' && message.bundle instanceof Uint8Array) {
      return {kind: 'bundle', bundle: message.bundle}
    }
    return {kind: 'unknown'}
  }
  catch {
    return {kind: 'unknown'}
  }
}

export const describeRootHeartbeat = (record) => describeRecord(record)

export const describeLiveBundle = async (bundle) =>
  `live vote bundle (${bundle.length} B, cid ${await bundleCidForBytes(bundle)}): ${describeBundleVotes(bundle)}`
