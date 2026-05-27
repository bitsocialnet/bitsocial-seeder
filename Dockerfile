# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
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

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown -R node:node /data /app

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

VOLUME ["/data"]
USER node

ENTRYPOINT ["tini", "--"]
CMD ["node", "start.js"]
