#!/usr/bin/env bash
set -euo pipefail

# Deploy latest code + static build to OCI host.
# Default mode is pull-based deployment on server (git fetch/reset).
# Usage:
#   bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP /home/ubuntu/stock-outlook /var/www/stock-outlook
#
# Optional:
#   DEPLOY_MODE=rsync bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP ...
#   DEPLOY_REF=origin/main bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP ...
#   CLEAN_PULL=1 bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP ...

HOST="${1:-}"
REMOTE_APP_DIR="${2:-/home/ubuntu/stock-outlook}"
REMOTE_WEB_ROOT="${3:-/var/www/stock-outlook}"
DEPLOY_MODE="${DEPLOY_MODE:-pull}"   # pull | rsync
DEPLOY_REF="${DEPLOY_REF:-origin/main}"
CLEAN_PULL="${CLEAN_PULL:-1}"        # 1 = hard reset/clean before pull

if [[ -z "$HOST" ]]; then
  echo "Usage: bash scripts/deploy-oci.sh <user@host> [remote_app_dir] [remote_web_root]"
  exit 1
fi

if [[ "$DEPLOY_MODE" == "rsync" ]]; then
  echo "==> Syncing repo to ${HOST}:${REMOTE_APP_DIR} (rsync mode)"
  rsync -az --delete \
    --exclude ".git" \
    --exclude "node_modules" \
    --exclude "dist" \
    --exclude ".astro" \
    ./ "${HOST}:${REMOTE_APP_DIR}/"
else
  echo "==> Using pull mode on remote (${DEPLOY_REF})"
fi

echo "==> Running remote install + build + publish"
ssh "$HOST" "bash -lc '
  set -euo pipefail
  cd \"${REMOTE_APP_DIR}\"

  if [[ \"${DEPLOY_MODE}\" == \"pull\" ]]; then
    if ! command -v git >/dev/null 2>&1; then
      echo \"git not found on remote host.\"
      exit 1
    fi
    git fetch --all --prune
    if [[ \"${CLEAN_PULL}\" == \"1\" ]]; then
      # OCI box contains generated artifacts (tmp/, analyses json, logs, etc.).
      # Force-clean to avoid pull conflicts during deployment.
      git reset --hard
      git clean -fd
    fi
    if [[ \"${DEPLOY_REF}\" == origin/* ]]; then
      BRANCH=\"${DEPLOY_REF#origin/}\"
      git checkout \"${BRANCH}\"
      git pull --ff-only origin \"${BRANCH}\"
    else
      git checkout --detach \"${DEPLOY_REF}\"
    fi
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo \"pnpm not found on remote host. Install Node.js + pnpm first.\"
    exit 1
  fi

  pnpm install --frozen-lockfile
  pnpm fetch-news
  pnpm fetch-market
  pnpm fetch-results
  pnpm verify
  pnpm analyze
  pnpm build

  mkdir -p \"${REMOTE_WEB_ROOT}\"
  rsync -a --delete dist/ \"${REMOTE_WEB_ROOT}/\"
  echo \"Deploy complete at \$(date -Iseconds)\"
'"

echo "==> Deployment finished"
