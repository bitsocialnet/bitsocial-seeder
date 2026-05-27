import fs from 'fs'
import config from '../config.js'
import {db} from './db.js'
import {getCommunityKey} from './utils.js'

// Source of truth for `communitiesSeeding` is the `communities` SQLite table.
// We expose the same getter/setter shape the rest of the codebase already uses
// (`seederState.communitiesSeeding`) so callers don't have to change.

const SELECT_ALL = 'SELECT data, discovered_at FROM communities ORDER BY discovered_at, community_key'
const SELECT_EXISTING_DISCOVERED_AT = 'SELECT discovered_at FROM communities WHERE community_key = ?'
const UPSERT = `
  INSERT INTO communities (community_key, address, public_key, data, discovered_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(community_key) DO UPDATE SET
    address = excluded.address,
    public_key = excluded.public_key,
    data = excluded.data,
    updated_at = excluded.updated_at
`

const buildDeleteNotIn = (count) =>
  `DELETE FROM communities WHERE community_key NOT IN (${new Array(count).fill('?').join(',')})`

const getCommunitiesSeeding = () => {
  const rows = db.query(SELECT_ALL)
  if (rows.length === 0) {
    // Preserve the "no communities discovered yet" sentinel (undefined) so
    // start.js's wait loop continues to work.
    return undefined
  }
  return rows.map(row => JSON.parse(row.data))
}

const setCommunitiesSeeding = (communities) => {
  if (!Array.isArray(communities)) {
    return
  }
  const now = Math.floor(Date.now() / 1000)
  const tx = db.transaction()
  try {
    const keptKeys = []
    for (const community of communities) {
      const key = getCommunityKey(community)
      if (!key) {
        continue
      }
      keptKeys.push(key)
      const existing = tx.query(SELECT_EXISTING_DISCOVERED_AT, [key])
      const discoveredAt = existing[0]?.discovered_at ?? now
      tx.execute(UPSERT, [
        key,
        community.address ?? null,
        community.publicKey ?? null,
        JSON.stringify(community),
        discoveredAt,
        now
      ])
    }
    if (keptKeys.length > 0) {
      tx.execute(buildDeleteNotIn(keptKeys.length), keptKeys)
    }
    else {
      // Empty input means "no communities to seed" — clear the table so the
      // setter behavior matches its name. Callers currently guard against
      // this path, but the setter shouldn't silently retain stale rows.
      tx.execute('DELETE FROM communities')
    }
    tx.commit()
  }
  catch (error) {
    tx.rollback()
    throw error
  }
}

// One-time migration from the legacy seederState.json.
// Runs only if the communities table is empty AND a JSON state file exists.
const migrateFromJson = () => {
  const existing = db.query('SELECT COUNT(*) AS n FROM communities')[0]?.n ?? 0
  if (existing > 0) {
    return
  }
  const statePath = config.seederState?.path || 'seederState.json'
  let json
  try {
    json = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  }
  catch {
    return
  }
  const communities = json.communitiesSeeding || json.subplebbitsSeeding
  if (!Array.isArray(communities) || communities.length === 0) {
    return
  }
  console.log(`migrating ${communities.length} communities from ${statePath} to ${config.db?.path || 'seeder.db'}`)
  setCommunitiesSeeding(communities)
}

migrateFromJson()

const seederState = {}
Object.defineProperty(seederState, 'communitiesSeeding', {
  get: getCommunitiesSeeding,
  set: setCommunitiesSeeding,
  enumerable: true,
  configurable: false
})

export default seederState
