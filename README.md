# bitsocial-seeder

Seeds Bitsocial community first pages, post-update CIDs, and pubsub topics through a running `bitsocial daemon`.

It reuses the Kubo and PKC RPC owned by `@bitsocial/bitsocial-cli`, instead of launching a second node.

## Getting Started

```sh
npm install
npm run daemon
npm start
```

The default config expects:

- PKC RPC: `ws://127.0.0.1:9138`
- Kubo RPC: `http://127.0.0.1:50019/api/v0`
- community lists: `bitsocialnet/lists` 5chan directory files

Useful environment overrides:

```sh
PKC_RPC_URL=ws://127.0.0.1:9138
KUBO_RPC_URL=http://127.0.0.1:50019/api/v0
COMMUNITY_LIST_SOURCES=https://api.github.com/repos/bitsocialnet/lists/contents/5chan-directories?ref=master
MAX_COMMUNITIES=20
PIN_CONCURRENCY=2
```

## Docker

```sh
scripts/start-docker.sh
```

Docker uses host networking, so it still expects a Bitsocial daemon and Kubo RPC on the host.
