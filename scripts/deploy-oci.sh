#!/usr/bin/env bash
set -euo pipefail

# Deploy latest code + static build to OCI host.
# Usage:
#   bash scripts/deploy-oci.sh ubuntu@YOUR_OCI_IP /home/ubuntu/stock-outlook /var/www/stock-outlook

HOST="${1:-}"
REMOTE_APP_DIR="${2:-/home/ubuntu/stock-outlook}"
REMOTE_WEB_ROOT="${3:-/var/www/stock-outlook}"

if [[ -z "$HOST" ]]; then
  echo "Usage: bash scripts/deploy-oci.sh <user@host> [remote_app_dir] [remote_web_root]"
  exit 1
fi

echo "==> Syncing repo to ${HOST}:${REMOTE_APP_DIR}"
rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude ".astro" \
  ./ "${HOST}:${REMOTE_APP_DIR}/"

echo "==> Running remote install + build + publish"
ssh "$HOST" "bash -lc '
  set -euo pipefail
  cd \"${REMOTE_APP_DIR}\"

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
