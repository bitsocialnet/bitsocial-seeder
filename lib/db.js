import honker from '@russellthehippo/honker-node'
import config from '../config.js'

const {open} = honker

// Schema for the seeder's own tables. The _honker_* tables (queues, scheduler,
// streams, notifications, locks, rate limits, results) are managed by honker
// itself and created lazily on first use of db.queue() / db.scheduler() / etc.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS communities (
    community_key TEXT PRIMARY KEY,
    address TEXT,
    public_key TEXT,
    data TEXT NOT NULL,
    discovered_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS community_pins (
    community_key TEXT NOT NULL,
    cid TEXT NOT NULL,
    name TEXT,
    pinned_at INTEGER NOT NULL,
    PRIMARY KEY (community_key, cid)
  );

  CREATE TABLE IF NOT EXISTS pubsub_routing_provides (
    community_key TEXT NOT NULL,
    cid TEXT NOT NULL,
    last_queued_at INTEGER NOT NULL,
    PRIMARY KEY (community_key, cid)
  );
`

const dbPath = config.db?.path || 'seeder.db'
console.log(`opening seeder database at ${dbPath}`)
const db = open(dbPath)

// SQLite supports multiple statements in one execute via the underlying driver,
// but honker's db.query takes one statement at a time. Split on `;` boundaries.
for (const statement of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
  db.query(statement)
}

export {db, dbPath}
export default db
