#!/usr/bin/env bash
# Modular deployment for ONLY the Rust `lilyco-relay` backend on Server B (123.60.38.191).
# Features: automatic remote backup (binary + DB + models.toml), health probe, auto-rollback on failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="root@123.60.38.191"
KEY_FILE="${RELAY_SSH_KEY:-$HOME/.ssh/lain42-dev.pem}"
BIN_PATH="$REPO_ROOT/target/x86_64-unknown-linux-musl/release/relay-server"
TS="$(date +%Y%m%d-%H%M%S)"
CONFIG_ONLY=0

if [ "${1:-}" = "--config-only" ]; then
  CONFIG_ONLY=1
fi

if [ "$CONFIG_ONLY" = "0" ]; then
  echo "[1/4] Building static musl release binary via zig cc..."
  ZIG_CC="$REPO_ROOT/deploy/zig-musl-cc.sh"
  chmod +x "$ZIG_CC"
  (cd "$REPO_ROOT" && \
    CC_x86_64_unknown_linux_musl="$ZIG_CC" \
    cargo build --release --target x86_64-unknown-linux-musl --bin relay-server)
  # Support custom CARGO_TARGET_DIR if configured
  if [ ! -f "$BIN_PATH" ]; then
    TARGET_DIR="$(cd "$REPO_ROOT" && cargo metadata --no-deps --format-version 1 | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
    BIN_PATH="$TARGET_DIR/x86_64-unknown-linux-musl/release/relay-server"
  fi
  test -f "$BIN_PATH"
fi

eval "$(ssh-agent -s)" >/dev/null
trap 'ssh-agent -k >/dev/null 2>&1' EXIT
ssh-add - < "$KEY_FILE" 2>/dev/null

echo "[2/4] Backing up remote binary, DB, and models.toml..."
ssh -F /dev/null -o BatchMode=yes "$REMOTE" "
set -e
mkdir -p /opt/lilyco-relay/backups
cp -a /opt/lilyco-relay/lilyco-relay /opt/lilyco-relay/backups/lilyco-relay.$TS
cp -a /opt/lilyco-relay/config/models.toml /opt/lilyco-relay/backups/models.toml.$TS
if [ -f /opt/lilyco-relay/data/lilyco-relay.db ]; then
  cp -a /opt/lilyco-relay/data/lilyco-relay.db /opt/lilyco-relay/backups/lilyco-relay.db.$TS
fi
"

echo "[3/4] Uploading updated artifacts..."
scp -F /dev/null -o BatchMode=yes "$REPO_ROOT/config/models.toml" "$REMOTE:/opt/lilyco-relay/config/models.toml.new"
if [ "$CONFIG_ONLY" = "0" ]; then
  scp -F /dev/null -o BatchMode=yes "$BIN_PATH" "$REMOTE:/opt/lilyco-relay/lilyco-relay.new"
fi

echo "[4/4] Atomic swap, restart, and health verification (auto-rollback on error)..."
ssh -F /dev/null -o BatchMode=yes "$REMOTE" "
set -e
mv /opt/lilyco-relay/config/models.toml.new /opt/lilyco-relay/config/models.toml
if [ -f /opt/lilyco-relay/lilyco-relay.new ]; then
  chmod 755 /opt/lilyco-relay/lilyco-relay.new
  mv /opt/lilyco-relay/lilyco-relay.new /opt/lilyco-relay/lilyco-relay
fi
systemctl restart lilyco-relay.service
sleep 2
if ! curl -fsS http://127.0.0.1:8090/api/v1/health >/dev/null; then
  echo 'Health check failed! Rolling back...' >&2
  cp -a /opt/lilyco-relay/backups/lilyco-relay.$TS /opt/lilyco-relay/lilyco-relay
  cp -a /opt/lilyco-relay/backups/models.toml.$TS /opt/lilyco-relay/config/models.toml
  systemctl restart lilyco-relay.service
  exit 1
fi
echo 'Deploy succeeded! Health:'
curl -sS http://127.0.0.1:8090/api/v1/health
echo ''
"
