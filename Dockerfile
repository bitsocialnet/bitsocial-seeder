# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# @bitsocial/bitsocial-cli's postinstall downloads the web UIs from the GitHub releases API
# and hard-errors when it gets none. Unauthenticated that API allows 60 requests/hour per IP,
# which CI shares with every other runner, so back-to-back builds (a merge fires the PR run
# and the master run within minutes) intermittently got 403s and failed the image build.
# The postinstall sends `authorization: Bearer $GITHUB_TOKEN` when the variable is set, which
# raises the limit to 1000/hour. A secret mount keeps the token out of the image layers and
# out of the layer cache key; without one (a plain local `docker build`) it stays unset and
# the build behaves exactly as it did before.
RUN --mount=type=secret,id=github_token \
  GITHUB_TOKEN="$(cat /run/secrets/github_token 2>/dev/null || true)" \
  npm ci --omit=dev \
  && npm cache clean --force

FROM node:24-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
  PKC_RPC_URL=ws://127.0.0.1:9138 \
  KUBO_RPC_URL=http://127.0.0.1:50019/api/v0 \
  PUBSUB_KUBO_RPC_URL=http://127.0.0.1:50019/api/v0 \
  IPFS_GATEWAY_URL=http://127.0.0.1:6473 \
  SEEDER_DAEMON_DATA_PATH=/data/bitsocial \
  SEEDER_DAEMON_LOG_PATH=/data/logs \
  SEEDER_STATE_PATH=/data/seederState.json \
  SEEDER_DB_PATH=/data/seeder.db \
  PIN_CONCURRENCY=1

# libsqlite3-0: honker-node's prebuilt binding links libsqlite3.so.0 dynamically as of
# 0.4.5 (0.3.3 bundled SQLite statically). The deps stage only has it transitively via the
# build toolchain, so the runtime image must ask for it or `require` fails at boot.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini libsqlite3-0 \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown -R node:node /data /app

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

VOLUME ["/data"]
USER node

ENTRYPOINT ["tini", "--"]
CMD ["node", "start.ts"]
