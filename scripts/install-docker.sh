#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/bitsocial-seeder}"
COMPOSE="${COMPOSE:-docker compose}"

cd "$APP_DIR"

$COMPOSE pull || true
$COMPOSE up -d --build
$COMPOSE ps
