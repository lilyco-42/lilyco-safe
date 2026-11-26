#!/usr/bin/env bash
# Zero-downtime hot-swap for ONLY the Relay frontend static assets on Server B.
# Never restarts any Rust backend binary.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE="root@123.60.38.191"
KEY_FILE="${RELAY_SSH_KEY:-$HOME/.ssh/lain42-dev.pem}"
DIST_DIR="${1:-$REPO_ROOT/web/dist}"

if [ ! -d "$DIST_DIR" ]; then
  echo "Building frontend in $REPO_ROOT/web..."
  (cd "$REPO_ROOT/web" && npm run build)
fi

eval "$(ssh-agent -s)" >/dev/null
trap 'ssh-agent -k >/dev/null 2>&1' EXIT
ssh-add - < "$KEY_FILE" 2>/dev/null

TS="$(date +%Y%m%d-%H%M%S)"
ssh -F /dev/null -o BatchMode=yes "$REMOTE" "cp -a /opt/lilyco-relay/web_dist /opt/lilyco-relay/web_dist.bak.$TS"
rsync -az --delete -e "ssh -F /dev/null -o BatchMode=yes" "$DIST_DIR/" "$REMOTE:/opt/lilyco-relay/web_dist/"
echo "Frontend hot-swapped with zero backend restart (backup: web_dist.bak.$TS)."
