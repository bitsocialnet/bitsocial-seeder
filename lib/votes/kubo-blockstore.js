import {BaseBlockstore} from 'blockstore-core/base'

// Blockstore for the embedded votes Helia node, backed by the daemon's Kubo blockstore over
// RPC. Helia wraps this in its own BlockStorage: local hits come from here, local misses fall
// through to Helia's bitswap over the votes libp2p node — so every get/has/stat below MUST be
// local-only (`offline: true`). Without it a miss makes Kubo fetch over KUBO'S bitswap on the
// wrong network and hang for the whole request timeout (verified against Kubo 0.42: an offline
// miss fails in ~4ms, an online miss hangs). Blocks put here are also served by Kubo's own
// bitswap/gateway as a bonus.
//
// Kubo GC caveat: puts are NOT pinned (pinning every vote bundle block forever would grow an
// unbounded pin set). Kubo does not garbage-collect unless started with --enable-gc; if an
// operator enables GC, collected vote blocks are re-fetched from other peers on the next
// cold-join (content-addressed and idempotent, so this degrades to wasted bandwidth, not
// corruption).

// codec byte → the `cidCodec` name Kubo's block/put expects, for the codecs this library
// stores (binary bundle blocks + checkpoint chunks are raw/dag-cbor).
const CODEC_NAMES = {0x55: 'raw', 0x71: 'dag-cbor', 0x70: 'dag-pb'}
const SHA2_256 = 0x12

const isNotFoundError = (error) => /not found|could not find/i.test(error?.message || '')

export class KuboBlockstore extends BaseBlockstore {
  constructor(kubo) {
    super()
    this._kubo = kubo
  }

  async put(cid, block, options) {
    const cidCodec = CODEC_NAMES[cid.code]
    if (!cidCodec) {
      throw Error(`KuboBlockstore.put: unsupported codec 0x${cid.code.toString(16)} for ${cid}`)
    }
    if (cid.multihash.code !== SHA2_256) {
      throw Error(`KuboBlockstore.put: unsupported multihash 0x${cid.multihash.code.toString(16)} for ${cid}`)
    }
    const putCid = await this._kubo.block.put(block, {
      cidCodec,
      mhtype: 'sha2-256',
      version: 1,
      pin: false,
      signal: options?.signal
    })
    // Kubo re-derives the CID from the bytes; a mismatch means the codec/hash mapping above
    // disagrees with what the caller addressed, which would corrupt the store silently.
    if (putCid.toString() !== cid.toString()) {
      throw Error(`KuboBlockstore.put: kubo derived ${putCid}, caller addressed ${cid}`)
    }
    return cid
  }

  async get(cid, options) {
    return this._kubo.block.get(cid, {offline: true, signal: options?.signal})
  }

  async has(cid, options) {
    try {
      await this._kubo.block.stat(cid, {offline: true, signal: options?.signal})
      return true
    }
    catch (error) {
      if (isNotFoundError(error)) {
        return false
      }
      throw error
    }
  }

  async delete(cid, options) {
    for await (const result of this._kubo.block.rm(cid, {force: true, signal: options?.signal})) {
      if (result.error && !isNotFoundError(result.error)) {
        throw result.error
      }
    }
  }
}
