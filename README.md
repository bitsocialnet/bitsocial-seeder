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
