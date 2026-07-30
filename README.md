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

That's it — you're seeding. The container bundles its own Bitsocial daemon (Kubo IPFS + PKC), discovers communities from the official [5chan](https://github.com/bitsocialnet/lists/tree/master/5chan-directories) and [Seedit](https://github.com/bitsocialnet/lists/tree/master/seedit-directories) directory sources, and pins their content. It re-reads both sources on the normal discovery interval, so communities added to either directory are seeded without another `bitsocial-seeder` upgrade.

It also seeds the [5chan directory votes](#seed-pubsub-votes-directory-contests) by default, so you will see votes lines alongside the community ones:

```
votes joined 63 contests
votes fetch serve 5chan-dir-g (12 bundles)
```

Votes seeding starts an embedded libp2p node that wants two open ports (`6742`/`6743`) and does a few minutes of AutoTLS setup on first run. Set `VOTES_MANIFEST_SOURCES=none` to switch it off and seed communities only.

Directory voting is still on **testnet** — the contests are gated by the `5chan Pass` ERC-721 on Base Sepolia, so seeding them costs only the node and some testnet RPC reads.

**3. (Optional) Cap the workload on small VPSes:**

By default there is no cap — the seeder seeds every community in the configured public lists:

```sh
MAX_COMMUNITIES=10 PIN_CONCURRENCY=1 docker compose up -d
```

See [VPS Sizing](#vps-sizing) for capacity guidance.

Compose pulls `ghcr.io/bitsocialnet/bitsocial-seeder:latest` by default. To pin a specific version, edit `docker-compose.yml` and set `image: ghcr.io/bitsocialnet/bitsocial-seeder:0.6.1`.

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

### Updating

If you installed with Docker Compose, update the repository and recreate the
container with the latest image:

```sh
cd /opt/bitsocial-seeder && git pull --ff-only && docker compose pull && docker compose up -d --force-recreate
```

The `/data` Docker volume is preserved, so the seeder database and bundled
daemon data survive the update.

If you installed globally with npm, update to the latest release with:

```sh
npm install -g @bitsocial/bitsocial-seeder@latest
```

Restart the running `bitsocial-seeder` process after an npm update. Installing
the new package does not restart an existing process automatically.

### Seed a different list of communities

Override `COMMUNITY_LIST_SOURCES` with one or more comma-separated URLs or local file paths pointing at JSON files in the format `{"communities": [{"address": "...", "publicKey": "..."}]}`. See [Configuration](#configuration) for the full list of env vars.

### Add private communities to seed

Set `COMMUNITY_EXTRA_LIST_SOURCES` to add operator-specific communities without replacing the default public lists:

```sh
COMMUNITY_EXTRA_LIST_SOURCES=/data/extra-communities.json docker compose up -d
```

Example `/data/extra-communities.json`:

```json
{"communities": [{"address": "my-community.bso", "publicKey": "12D3KooW..."}]}
```

Extra sources use the same format as `COMMUNITY_LIST_SOURCES`, can be URLs, files, or directories of JSON files, and are re-read on the normal discovery interval. `MAX_COMMUNITIES` caps only the public list entries; explicitly configured extra communities are always included. If an extra entry has the same `publicKey` or address as a public entry, the extra entry wins.

### Verify what's being seeded

The seeder's state lives in a SQLite database at `SEEDER_DB_PATH` (default `/data/seeder.db` in Docker):

```sh
docker compose exec bitsocial-seeder sqlite3 /data/seeder.db \
  'SELECT address FROM communities'
```

See [State](#state) for the schema and other tables you can query.

### Seed pubsub votes (directory contests)

The seeder seeds [`@bitsocial/pubsub-voting`](https://github.com/bitsocialnet/pubsub-voting) directory contests (e.g. 5chan's board-slot voting) **by default**, from the published 5chan manifest:

```sh
# the default — no configuration needed
VOTES_MANIFEST_SOURCES=https://raw.githubusercontent.com/bitsocialnet/lists/master/5chan-directory-criteria.jsonc
```

It is on by default because a directory contest is only as live as the seeders holding its checkpoint: browser voters cannot dial each other, so a cold-joining voter with no reachable seeder sees an empty tally. Override the variable to seed a different manifest (`{ defaults, contests }` JSONC/JSON, one derived criteria document per slot), or set it to `none` to opt out:

```sh
VOTES_MANIFEST_SOURCES=none docker compose up -d
```

With a manifest configured the seeder starts an embedded libp2p/Helia node for the votes mesh — the daemon's Kubo cannot fill this role over RPC (no topic validators, no peer scoring, no libp2p-fetch registration), so votes seeding is **Helia-only**: verified vote bundles and checkpoint chunks persist in the node's own on-disk blockstore (`VOTES_BLOCKSTORE_PATH`), and each contest's checkpoint snapshot persists under `VOTES_DATA_PATH` so a restart keeps the tally, with no Kubo involvement. The seeder then:

- joins every derived contest read-only (no signer, no voting) and keeps the set reconciled against the manifests every `VOTES_RECONCILE_INTERVAL_MS`,
- serves checkpoint root records over libp2p-fetch to cold-joining voters (this registration is automatic on join),
- announces its votes peer as the provider of each contest's criteria CID, checkpoint root, and chunk CIDs on the Routing V1 HTTP routers (`VOTES_HTTP_ROUTER_URLS`), which is how voters' `findProviders()` discovers it — the library's built-in announcer re-announces hourly and debounces on joins and checkpoint changes.

Browser voters can only dial **WSS** (and browsers cannot dial each other — the gossipsub mesh forms through publicly dialable seeders), so the node runs **AutoTLS** ([libp2p.direct](https://libp2p.direct)): the node learns its public address the same way the daemon's Kubo does (identify observed-addresses from the bootstrap connections, confirmed by AutoNAT dial-backs), then the ACME broker issues a real TLS certificate and the node announces a browser-dialable `/dns4/<peerid>.libp2p.direct/.../tls/ws` address — no reverse proxy, no manual multiaddr config. The certificate takes a few minutes on first run (ACME + DNS propagation) and persists in `VOTES_DATASTORE_PATH` across restarts; watch the log for `AutoTLS certificate provisioned` and the announced addrs. Open `VOTES_LIBP2P_TCP_PORT` and `VOTES_LIBP2P_WS_PORT` in the firewall.

The votes peer identity persists in `VOTES_PEER_KEY_PATH` so announced provider records (and the AutoTLS domain, which embeds the peer id) stay valid across restarts — treat that key file and the `votes-keychain.pass` next to it as part of the seeder's state.

Chain verification reads each contest's gate rule on-chain. Since pubsub-voting 0.1.x the criteria document names chains by ticker + chainId only — RPC endpoints are each client's own setting (so operators can swap endpoints without forking topics). Multiple URLs per chain are queried **in parallel** (every request races all endpoints, first success wins — a dead RPC costs nothing); ETH mainnet defaults to the same six public RPCs bitsocial-cli hardcodes for pkc-js, other chains default to their viem chain's public RPC, and a busy public seeder should point `VOTES_CHAIN_RPC_URLS` (JSON, per chain ticker, e.g. `'{"baseSepolia":["https://my-base-sepolia-rpc"]}'` for the published 5chan manifest) at its own. Votes carry community names whose claims are verified through `.bso` resolution (an ETH mainnet read) — `VOTES_ETH_RPC_URLS` sets the ETH mainnet RPCs used for both name resolution and eth-gated contest verification (an explicit `VOTES_CHAIN_RPC_URLS` `"eth"` entry still wins for verification), defaulting to the same resolver providers bitsocial-cli gives pkc-js; a seeder whose resolvers are down counts (and therefore serves) almost nothing.

The log answers the questions production debugging asks — did a voter ever connect (`votes conn open`), join a topic (`votes topic subscribe`), pull the checkpoint (`votes fetch serve`, with the decoded bundle count — a root record is constant-size whether the contest is empty or not, so only the decoded `count` distinguishes "no votes" from "checkpoint didn't load"), or publish a vote (`votes gossip ... live vote bundle`)?

### Run a votes-only seeder

Set `COMMUNITY_LIST_SOURCES=none` to skip community seeding entirely and dedicate the machine to directory contests:

```sh
COMMUNITY_LIST_SOURCES=none docker compose up -d
```

The seeder then never runs discovery, subscribes to no community pubsub topics, and pins nothing — it boots straight into the votes workers and logs `community seeding disabled (COMMUNITY_LIST_SOURCES=none), seeding votes only`. `none` is what distinguishes "zero sources" from "unset" (an unset or empty variable falls through to the defaults), and the same spelling works for `VOTES_MANIFEST_SOURCES` to get the mirror config: communities only, no votes. Setting *both* to `none` leaves nothing to seed, and the seeder exits with `nothing to seed`.

A votes-only seeder still starts (or attaches to) a Bitsocial daemon, because the same binary serves both roles; it just makes no use of it beyond that.

## Configuration

The default config expects:

- PKC RPC: `ws://127.0.0.1:9138`
- Kubo RPC: `http://127.0.0.1:50019/api/v0`
- community lists: official `bitsocialnet/lists` 5chan and Seedit directory files
- daemon data: `/data/bitsocial`

On Linux hosts the compose file uses `network_mode: host`, so the container can reach the host daemon through `127.0.0.1`.
If no host daemon is running, the container starts its bundled daemon on those same local RPC addresses.

Useful environment overrides:

```sh
PKC_RPC_URL=ws://127.0.0.1:9138
KUBO_RPC_URL=http://127.0.0.1:50019/api/v0
# Kubo RPC used for pubsub subscriptions; defaults to KUBO_RPC_URL
PUBSUB_KUBO_RPC_URL=http://127.0.0.1:50019/api/v0
IPFS_GATEWAY_URL=http://127.0.0.1:6473
# Default; 'none' disables community seeding (votes-only seeder)
COMMUNITY_LIST_SOURCES=https://api.github.com/repos/bitsocialnet/lists/contents/5chan-directories?ref=master,https://api.github.com/repos/bitsocialnet/lists/contents/seedit-directories?ref=master
COMMUNITY_EXTRA_LIST_SOURCES=/data/extra-communities.json
# How often the community list sources are re-read ("the discovery interval"); default 10 minutes
DISCOVER_INTERVAL_MS=600000
# Minimum time between re-providing a community's pubsub routing CIDs; default 6 hours
PUBSUB_ROUTING_PROVIDE_INTERVAL_MS=21600000
SEEDER_DAEMON_AUTOSTART=true
SEEDER_DAEMON_DATA_PATH=/data/bitsocial
SEEDER_DAEMON_LOG_PATH=/data/logs
# How long to wait for an autostarted daemon's RPCs to come up, and how long they must
# stay up before the daemon counts as ready
SEEDER_DAEMON_READY_TIMEOUT_MS=120000
SEEDER_DAEMON_READY_STABLE_MS=2500
SEEDER_DB_PATH=/data/seeder.db
# Legacy JSON state file migrated into the database on first start; the mirror write can
# be disabled with SEEDER_STATE_WRITE_FILE=false
SEEDER_STATE_PATH=/data/seederState.json
SEEDER_STATE_WRITE_FILE=true
# No default cap — all discovered public-list communities are seeded unless this is set
MAX_COMMUNITIES=
# Default 2; the Docker image and compose file set 1
PIN_CONCURRENCY=2
SEEDER_UPDATE_CHECK_ENABLED=true
SEEDER_UPDATE_CHECK_INTERVAL_MS=86400000
SEEDER_UPDATE_CHECK_TIMEOUT_MS=5000
# Default; 'none' disables votes seeding (communities-only seeder)
VOTES_MANIFEST_SOURCES=https://raw.githubusercontent.com/bitsocialnet/lists/master/5chan-directory-criteria.jsonc
VOTES_HTTP_ROUTER_URLS=https://peers.pleb.bot,https://routing.lol,https://peers.forumindex.com,https://peers.plebpubsub.xyz,https://routerofbitsocial.xyz,https://bsotracker.online
VOTES_LIBP2P_HOST=0.0.0.0
VOTES_LIBP2P_TCP_PORT=6742
VOTES_LIBP2P_WS_PORT=6743
VOTES_RECONCILE_INTERVAL_MS=600000
# Per-chain RPC override; the published 5chan manifest gates on Base Sepolia
VOTES_CHAIN_RPC_URLS='{"baseSepolia":["https://sepolia.base.org"]}'
VOTES_ETH_RPC_URLS=https://eth.drpc.org,https://ethereum-rpc.publicnode.com
VOTES_PEER_KEY_PATH=/data/votes-peer.key
VOTES_BLOCKSTORE_PATH=/data/votes-blockstore
VOTES_DATASTORE_PATH=/data/votes-datastore
VOTES_DATA_PATH=/data/votes-cache
VOTES_FETCH_MAX_STREAMS=256
VOTES_UPDATE_CONCURRENCY=8
# util.inspect depth for object logging (unset = Node's util.inspect default)
DEBUG_DEPTH=6
```

### Public seeder defaults

`COMMUNITY_LIST_SOURCES` points at the GitHub contents APIs for both
`bitsocialnet/lists/5chan-directories` and `bitsocialnet/lists/seedit-directories`.
The seeder re-reads every non-default JSON file from both folders on the normal
discovery interval. New directory files and changes to existing files therefore
reach current seeders without another package release or restart.

Older releases and old Docker Compose files only poll `5chan-directories`,
because Compose sets this environment variable explicitly. For compatibility,
public seed targets that those installs must see can temporarily be mirrored in
`bitsocialnet/lists/5chan-directories/bitsocial-seeder-communities.json`.
Existing seeders fetch every JSON file in that folder except `*-defaults.json`,
while 5chan clients and stats tooling only treat files named
`5chan-<code>-directory.json` as real 5chan directories.

Keep that compatibility mirror until old folder-only installs have had time to
upgrade. Current installs use the two directory folders themselves as the
canonical public sources, avoiding a generated aggregate that could drift from
the client directory lists.

## State

The seeder keeps its operational state in a single SQLite file at `SEEDER_DB_PATH` (defaults to `./seeder.db`, set to `/data/seeder.db` in the Docker image). The file holds the seeded community list, per-pin bookkeeping for stale-pin GC, the pubsub-routing re-provide throttle, and the durable work queues + scheduler powered by [honker](https://github.com/russellromney/honker).

On first start the seeder will migrate any pre-existing `seederState.json` into the database. After migration the JSON file is no longer read or written and can be removed at the operator's discretion.

Inspect state with the host's `sqlite3` against the file directly, e.g. `sqlite3 /data/seeder.db 'SELECT community_key, address FROM communities'`.

The seeder checks npm for a newer `@bitsocial/bitsocial-seeder` release on
startup and once per day after that. When a newer release exists, it prints an
update notice in the logs. Set `SEEDER_UPDATE_CHECK_ENABLED=false` to disable
that check.

The same check also watches the bundled runtime packages, including
`@bitsocial/bitsocial-cli` and `@pkcprotocol/pkc-js`. Upgrading the seeder
package or Docker image upgrades the bundled daemon used by
`SEEDER_DAEMON_AUTOSTART=true`. If the seeder is reusing an already-running
external `bitsocial daemon`, upgrade and restart that daemon separately; the
seeder does not install over or restart externally managed daemon processes.

## VPS Sizing

For public seeding, size the host like a small Kubo node plus a lightweight Node.js seeder process.
The seeder wrapper is small, but with `SEEDER_DAEMON_AUTOSTART=true` it also runs a bundled Bitsocial daemon and Kubo IPFS node.

Recommended starting point:

- CPU: 2 vCPU.
- Memory: 4 GiB can work for a low-cost trial, especially with swap, but 6 GiB or more is the safer target for unattended public seeders. Kubo's [published baseline](https://docs.ipfs.tech/install/command-line/#system-requirements) is 6 GiB memory and 2 CPU cores.
- Disk: 20 GiB minimum free space for Docker, logs, seeder state, and the IPFS repo; 50 GiB or more is more comfortable for long-running nodes or larger `MAX_COMMUNITIES` values.
- Network: stable public IPv4 or IPv6 with unrestricted outbound TCP/UDP. Allow inbound Kubo swarm traffic if possible, usually TCP/UDP 4001 with the default Kubo config, but keep PKC and Kubo RPC ports private to the host.
- Transfer: avoid tiny metered bandwidth caps. Start with at least 1 TB/month included transfer and monitor provider-level bandwidth, not only `ipfs stats bw`.

The compose file ships with memory guardrails: `NODE_OPTIONS: "--max-old-space-size=1024"` caps the seeder's V8 heap (Node's default limit scales with host RAM, and lazy GC otherwise lets a long-running seeder balloon toward ~4 GiB on an 8 GiB host), and `mem_limit: 2g` is a hard container backstop that also covers native/buffer memory.
Raise both if you seed many more communities than the defaults and the seeder gets memory-starved; on tighter hosts, lower `MAX_COMMUNITIES` before lowering the caps.

The default community sources are dozens of small directory communities plus a short supplemental seeder list, not full media archiving.
Disk and bandwidth mostly scale with `MAX_COMMUNITIES`, pinned page/update size, pubsub activity, and Kubo/libp2p overhead.
On small VPSes, set `MAX_COMMUNITIES` (unset = no cap) and keep `PIN_CONCURRENCY=1` (the Docker default).

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
