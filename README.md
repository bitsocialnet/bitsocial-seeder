# bitsocial-seeder

Seeds Bitsocial community first pages, post-update CIDs, pubsub topic routing CIDs, and pubsub topics through a `bitsocial daemon`.

It reuses an already-running Kubo and PKC RPC when one is available. If it cannot find a local daemon, it starts the bundled `@bitsocial/bitsocial-cli` daemon automatically and seeds through that node.

## Is this the only way to seed?

No — and for most users it is not the recommended way. Bitsocial desktop apps such as the 5chan Electron app already seed automatically while they are running. If many users keep an app open, the network is well served without anyone running a dedicated seeder. **The apps are the load-bearing seeders of the protocol; this repo is supplemental.**

`bitsocial-seeder` exists for operators who want to contribute consistent 24/7 seeding capacity from a VPS or a spare machine — for example, running closer to popular communities to lower fetch latency, or keeping data available during quiet periods when few app users are online. It is helpful but not required.

This is also an **experimental repository**. Releases are cut frequently, internals change without warning between minor versions, and the project is treated as a place to try ideas that benefit the protocol but are not on its critical path. Please file issues if you hit anything; expect bumps.

## Setup

The fastest path is Docker Compose. Recommended for unattended VPS seeders — it gives you a predictable service wrapper, simpler updates, and fewer local Node/native dependency surprises.

**1. Clone and start the container:**

```sh
git clone https://github.com/bitsocialnet/bitsocial-seeder.git
cd bitsocial-seeder
docker compose up -d
```

**2. Watch the logs to confirm it's seeding:**

```sh
docker compose logs -f
```

Within a couple of minutes you should see lines like:

```
discovered N communities to seed
seeding N communities
some-community.bso updated 2 minutes ago, page cids: 0, post updates cids: 3, ...
some-community.bso queueing pubsub routing provide bafkrei...
some-community.bso pinned Qm... in 1.2s
```

That's it — you're seeding. The container bundles its own Bitsocial daemon (Kubo IPFS + PKC), discovers communities from the [default 5chan directories](https://github.com/bitsocialnet/lists/tree/master/5chan-directories), and pins their content.

**3. (Optional) Cap the workload on small VPSes:**

```sh
MAX_COMMUNITIES=10 PIN_CONCURRENCY=1 docker compose up -d
```

See [VPS Sizing](#vps-sizing) for capacity guidance.

Compose pulls `ghcr.io/bitsocialnet/bitsocial-seeder:latest` by default. To pin a specific version, edit `docker-compose.yml` and set `image: ghcr.io/bitsocialnet/bitsocial-seeder:0.2.0`.

### Run without Docker (npm)

For local testing or Node-first operators (Node 24+ required):

```sh
npx @bitsocial/bitsocial-seeder
```

Or install globally:

```sh
npm install -g @bitsocial/bitsocial-seeder
bitsocial-seeder
```

Same environment variables as the Docker image. Reuses an already-running Bitsocial daemon when one is reachable, otherwise starts the bundled one.

### Seed a different list of communities

Override `COMMUNITY_LIST_SOURCES` with one or more comma-separated URLs or local file paths pointing at JSON files in the format `{"communities": [{"address": "...", "publicKey": "..."}]}`. See [Configuration](#configuration) for the full list of env vars.

### Verify what's being seeded

The seeder's state lives in a SQLite database at `SEEDER_DB_PATH` (default `/data/seeder.db` in Docker):

```sh
docker compose exec bitsocial-seeder sqlite3 /data/seeder.db \
  'SELECT address FROM communities'
```

See [State](#state) for the schema and other tables you can query.

## Configuration

The default config expects:

- PKC RPC: `ws://127.0.0.1:9138`
- Kubo RPC: `http://127.0.0.1:50019/api/v0`
- community lists: `bitsocialnet/lists` 5chan directory files
- daemon data: `/data/bitsocial`

On Linux hosts the compose file uses `network_mode: host`, so the container can reach the host daemon through `127.0.0.1`.
If no host daemon is running, the container starts its bundled daemon on those same local RPC addresses.

Useful environment overrides:

```sh
PKC_RPC_URL=ws://127.0.0.1:9138
KUBO_RPC_URL=http://127.0.0.1:50019/api/v0
IPFS_GATEWAY_URL=http://127.0.0.1:6473
COMMUNITY_LIST_SOURCES=https://api.github.com/repos/bitsocialnet/lists/contents/5chan-directories?ref=master
SEEDER_DAEMON_AUTOSTART=true
SEEDER_DAEMON_DATA_PATH=/data/bitsocial
SEEDER_DAEMON_LOG_PATH=/data/logs
SEEDER_DB_PATH=/data/seeder.db
MAX_COMMUNITIES=20
PIN_CONCURRENCY=2
SEEDER_UPDATE_CHECK_ENABLED=true
SEEDER_UPDATE_CHECK_INTERVAL_MS=86400000
SEEDER_UPDATE_CHECK_TIMEOUT_MS=5000
```

## State

The seeder keeps its operational state in a single SQLite file at `SEEDER_DB_PATH` (defaults to `./seeder.db`, set to `/data/seeder.db` in the Docker image). The file holds the seeded community list, per-pin bookkeeping for stale-pin GC, the pubsub-routing re-provide throttle, and the durable work queues + scheduler powered by [honker](https://github.com/russellromney/honker).

On first start the seeder will migrate any pre-existing `seederState.json` into the database. After migration the JSON file is no longer read or written and can be removed at the operator's discretion.

Inspect state with the host's `sqlite3` against the file directly, e.g. `sqlite3 /data/seeder.db 'SELECT community_key, address FROM communities'`.

The seeder checks npm for a newer `@bitsocial/bitsocial-seeder` release on
startup and once per day after that. When a newer release exists, it prints an
update notice in the logs. Set `SEEDER_UPDATE_CHECK_ENABLED=false` to disable
that check.

## VPS Sizing

For public seeding, size the host like a small Kubo node plus a lightweight Node.js seeder process.
The seeder wrapper is small, but with `SEEDER_DAEMON_AUTOSTART=true` it also runs a bundled Bitsocial daemon and Kubo IPFS node.

Recommended starting point:

- CPU: 2 vCPU.
- Memory: 4 GiB can work for a low-cost trial, especially with swap, but 6 GiB or more is the safer target for unattended public seeders. Kubo's [published baseline](https://docs.ipfs.tech/install/command-line/#system-requirements) is 6 GiB memory and 2 CPU cores.
- Disk: 20 GiB minimum free space for Docker, logs, seeder state, and the IPFS repo; 50 GiB or more is more comfortable for long-running nodes or larger `MAX_COMMUNITIES` values.
- Network: stable public IPv4 or IPv6 with unrestricted outbound TCP/UDP. Allow inbound Kubo swarm traffic if possible, usually TCP/UDP 4001 with the default Kubo config, but keep PKC and Kubo RPC ports private to the host.
- Transfer: avoid tiny metered bandwidth caps. Start with at least 1 TB/month included transfer and monitor provider-level bandwidth, not only `ipfs stats bw`.

The default 5chan directory source is dozens of small communities, not full media archiving.
Disk and bandwidth mostly scale with `MAX_COMMUNITIES`, pinned page/update size, pubsub activity, and Kubo/libp2p overhead.
On small VPSes, lower `MAX_COMMUNITIES` and keep `PIN_CONCURRENCY=1`.

Bitsocial configures delegated HTTP routing/tracker endpoints for provider lookups, so it should be lighter than an untuned Kubo node doing full DHT provider sweeps.
It still runs Kubo and joins pubsub topics, so treat it as Kubo-class infrastructure rather than a static HTTP service.

## Local Development

```sh
npm install
npm test
npm start
```

## Releases

Releases are driven by the `version` in `package.json`. On a successful push to
`master`, CI updates `CHANGELOG.md`, pushes versioned Docker image tags, publishes
`@bitsocial/bitsocial-seeder` to npm with trusted publishing, and creates the
matching GitHub Release.

The npm trusted publisher should be configured for:

- npm package: `@bitsocial/bitsocial-seeder`
- GitHub repository: `bitsocialnet/bitsocial-seeder`
- workflow filename: `release.yml`
- allowed action: `npm publish`

The package must exist on npm before trusted publishing can be configured. After
the first package version exists, future releases should publish through CI
without long-lived npm tokens.

For initial npm bootstrap, backfill historical package versions before cutting
the next release if you want npm to show the full release line. Publish `0.1.0`
and `0.1.1` only from their matching release code plus the minimum npm metadata
needed for the scoped package; do not publish current code under an old version.
