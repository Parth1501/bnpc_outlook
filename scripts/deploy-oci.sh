#!/usr/bin/env bash
set -euo pipefail

# Sync latest code to OCI host.
# Default mode is pull-based sync on server (git fetch/reset/pull).
# Usage:
#   bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP /home/ubuntu/stock-outlook
#
# Optional:
#   DEPLOY_MODE=rsync bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP ...
#   DEPLOY_REF=origin/main bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP ...
#   CLEAN_PULL=1 bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP ...
#   SSH_KEY=/c/Users/parth/OneDrive/Desktop/Parth/Code/OCI/ssh-key-2025-01-01.key bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP

HOST="${1:-}"
REMOTE_APP_DIR="${2:-/home/ubuntu/stock-outlook}"
DEPLOY_MODE="${DEPLOY_MODE:-pull}"   # pull | rsync
DEPLOY_REF="${DEPLOY_REF:-origin/main}"
CLEAN_PULL="${CLEAN_PULL:-1}"        # 1 = hard reset/clean before pull
SSH_KEY="${SSH_KEY:-}"               # optional private key path
SSH_OPTS=()

if [[ -n "$SSH_KEY" ]]; then
  SSH_OPTS=(-i "$SSH_KEY")
fi

if [[ -z "$HOST" ]]; then
  echo "Usage: bash scripts/deploy-oci.sh <user@host> [remote_app_dir]"
  exit 1
fi

if [[ "$DEPLOY_MODE" == "rsync" ]]; then
  echo "==> Syncing repo to ${HOST}:${REMOTE_APP_DIR} (rsync mode)"
  rsync -az --delete \
    -e "ssh ${SSH_OPTS[*]}" \
    --exclude ".git" \
    --exclude "node_modules" \
    --exclude "dist" \
    --exclude ".astro" \
    ./ "${HOST}:${REMOTE_APP_DIR}/"
else
  echo "==> Using pull mode on remote (${DEPLOY_REF})"
fi

echo "==> Running remote code sync"
ssh "${SSH_OPTS[@]}" "$HOST" \
  "REMOTE_APP_DIR='${REMOTE_APP_DIR}' DEPLOY_MODE='${DEPLOY_MODE}' DEPLOY_REF='${DEPLOY_REF}' CLEAN_PULL='${CLEAN_PULL}' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail
cd "$REMOTE_APP_DIR"

if [[ "$DEPLOY_MODE" == "pull" ]]; then
  if ! command -v git >/dev/null 2>&1; then
    echo "git not found on remote host."
    exit 1
  fi
  git fetch --all --prune
  if [[ "$CLEAN_PULL" == "1" ]]; then
    # OCI box contains generated artifacts (tmp/, analyses json, logs, etc.).
    # Force-clean to avoid pull conflicts during deployment.
    git reset --hard
    git clean -fd
  fi
  if [[ "$DEPLOY_REF" == origin/* ]]; then
    git checkout "${DEPLOY_REF#origin/}"
    git pull --ff-only origin "${DEPLOY_REF#origin/}"
  else
    git checkout --detach "$DEPLOY_REF"
  fi
fi

chmod +x scripts/run-daily.sh

echo "Code sync complete at $(date -Iseconds)"
REMOTE_SCRIPT

echo "==> Deployment finished"
