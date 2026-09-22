import {FsBlockstore} from 'blockstore-fs'
import type {CID} from 'multiformats/cid'

const keyFor = (cid: CID) => Buffer.from(cid.multihash.bytes).toString('hex')

// Dedicated votes store only. All access paths (including inherited getMany/putMany)
// go through these methods, so a sweep cannot unlink a block being read or written.
export class VotesBlockstore extends FsBlockstore {
  private locks = new Map<string, Promise<void>>()
  private candidates = new Map<string, number>()
  private collecting = false
  private clock: () => number

  constructor(location: string, clock = Date.now) {
    super(location)
    this.clock = clock
  }

  private async lock(cid: CID) {
    const key = keyFor(cid)
    const previous = this.locks.get(key)
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    this.locks.set(key, current)
    await previous
    return () => {
      if (this.locks.get(key) === current) this.locks.delete(key)
      release()
    }
  }

  override async put(...args: Parameters<FsBlockstore['put']>) {
    const release = await this.lock(args[0])
    try {
      this.candidates.delete(keyFor(args[0]))
      return await super.put(...args)
    }
    finally { release() }
  }

  override async *get(...args: Parameters<FsBlockstore['get']>) {
    const release = await this.lock(args[0])
    try {
      this.candidates.delete(keyFor(args[0]))
      yield* super.get(...args)
    }
    finally { release() }
  }

  override async has(...args: Parameters<FsBlockstore['has']>) {
    const release = await this.lock(args[0])
    try {
      this.candidates.delete(keyFor(args[0]))
      return await super.has(...args)
    }
    finally { release() }
  }

  override async delete(...args: Parameters<FsBlockstore['delete']>) {
    const release = await this.lock(args[0])
    try {
      await super.delete(...args)
      this.candidates.delete(keyFor(args[0]))
    }
    finally { release() }
  }

  override async *getAll(...args: Parameters<FsBlockstore['getAll']>) {
    for await (const {cid} of super.getAll(...args)) {
      yield {cid, bytes: this.get(cid, ...args)}
    }
  }

  async collect(retainsBlock: (cid: CID) => boolean, graceMs: number) {
    if (!Number.isFinite(graceMs) || graceMs <= 0) throw Error('GC grace period must be positive')
    if (this.collecting) return {scanned: 0, removed: 0}
    this.collecting = true
    const seen = new Set<string>()
    let scanned = 0
    let removed = 0
    try {
      // getAll enumerates lazily: its bytes generator is intentionally never consumed.
      for await (const {cid} of super.getAll()) {
        const key = keyFor(cid)
        seen.add(key)
        scanned++
        const release = await this.lock(cid)
        try {
          // Live check under the same lock as delete: a root change/rejoin between
          // enumeration and sweeping cannot invalidate an earlier root snapshot.
          if (retainsBlock(cid)) {
            this.candidates.delete(key)
            continue
          }
          const since = this.candidates.get(key)
          if (since === undefined) {
            this.candidates.set(key, this.clock())
          }
          else if (this.clock() - since >= graceMs) {
            await super.delete(cid)
            this.candidates.delete(key)
            removed++
          }
        }
        finally { release() }
      }
      for (const key of this.candidates.keys()) {
        if (!seen.has(key)) this.candidates.delete(key)
      }
      return {scanned, removed}
    }
    finally { this.collecting = false }
  }
}
