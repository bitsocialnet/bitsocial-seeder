#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-bitsocial-seeder}"
APP_DIR="${APP_DIR:-/opt/bitsocial-seeder}"
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v24.0.1/bin/node}"
PIN_CONCURRENCY="${PIN_CONCURRENCY:-2}"
PKC_RPC_URL="${PKC_RPC_URL:-ws://127.0.0.1:9138}"
KUBO_RPC_URL="${KUBO_RPC_URL:-http://127.0.0.1:50019/api/v0}"

cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Bitsocial seeder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=PKC_RPC_URL=${PKC_RPC_URL}
Environment=KUBO_RPC_URL=${KUBO_RPC_URL}
Environment=PIN_CONCURRENCY=${PIN_CONCURRENCY}
ExecStart=${NODE_BIN} ${APP_DIR}/start.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"
systemctl status "${SERVICE_NAME}.service" --no-pager
