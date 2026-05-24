# bitsocial-seeder

Seeds Bitsocial community first pages, post-update CIDs, and pubsub topics through a `bitsocial daemon`.

It reuses an already-running Kubo and PKC RPC when one is available. If it cannot find a local daemon, it starts the bundled `@bitsocial/bitsocial-cli` daemon automatically and seeds through that node. The supported deployment target is Docker, not npm.

## Docker

```sh
docker compose up -d
docker compose logs -f
```

Published images are available from `ghcr.io/bitsocialnet/bitsocial-seeder`.
Use `latest` for the current release or a fixed version tag such as `0.1.1`.

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
MAX_COMMUNITIES=20
PIN_CONCURRENCY=2
```

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
`master`, CI updates `CHANGELOG.md`, pushes versioned Docker image tags, and
creates the matching GitHub Release. This package is private and is not published
to npm.
