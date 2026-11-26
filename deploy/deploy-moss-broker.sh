#!/usr/bin/env bash
# Modular deployment for ONLY the MOSS multimodal gallery & GPU broker.
set -euo pipefail

SRC_DIR="${1:?usage: deploy-moss-broker.sh <dir-containing-broker.py-and-gallery.py>}"
REMOTE="${MOSS_REMOTE:-root@123.60.38.191}"
KEY_FILE="${MOSS_SSH_KEY:-$HOME/.ssh/lain42-dev.pem}"

python3 -m py_compile "$SRC_DIR/broker.py" "$SRC_DIR/gallery.py"

eval "$(ssh-agent -s)" >/dev/null
trap 'ssh-agent -k >/dev/null 2>&1' EXIT
ssh-add - < "$KEY_FILE" 2>/dev/null

scp -F /dev/null -o BatchMode=yes "$SRC_DIR/broker.py" "$SRC_DIR/gallery.py" "$REMOTE:/opt/lain42-moss-broker/"
ssh -F /dev/null -o BatchMode=yes "$REMOTE" '
set -e
chmod 755 /opt/lain42-moss-broker/broker.py
chmod 644 /opt/lain42-moss-broker/gallery.py
systemctl restart lain42-moss-broker.service
sleep 1
curl -fsS http://127.0.0.1:4720/status
echo ""
'
