#!/usr/bin/env bash
set -euo pipefail

# Daily OCI pipeline runner (Linux).
# - Pull latest code
# - Run data pipeline
# - Build static site
# - Publish to Nginx web root

APP_DIR="${APP_DIR:-/home/ubuntu/stock-outlook}"
WEB_ROOT="${WEB_ROOT:-/var/www/stock-outlook}"
DEPLOY_REF="${DEPLOY_REF:-origin/main}"
LOG_DIR="${LOG_DIR:-/var/log/outlook}"
LOCK_FILE="${LOCK_FILE:-/tmp/stock-outlook-daily.lock}"

# Prevent overlapping runs (manual + cron / duplicate cron entries).
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[SKIP] Another run is already in progress (lock: $LOCK_FILE)"
  exit 0
fi

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"
exec >>"$LOG_FILE" 2>&1

echo "=================================================="
echo "START $(date -Iseconds)"
echo "APP_DIR=$APP_DIR"
echo "WEB_ROOT=$WEB_ROOT"
echo "=================================================="

cd "$APP_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "[ERROR] git not found"
  exit 1
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "[ERROR] pnpm not found"
  exit 1
fi

echo "[RUN] git sync"
git fetch --all --prune
git reset --hard
git clean -fd
if [[ "$DEPLOY_REF" == origin/* ]]; then
  BRANCH="${DEPLOY_REF#origin/}"
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
else
  git checkout --detach "$DEPLOY_REF"
fi

echo "[RUN] pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "[RUN] pnpm fetch-news"
pnpm fetch-news
echo "[RUN] pnpm fetch-market"
pnpm fetch-market
echo "[RUN] pnpm fetch-results"
pnpm fetch-results
echo "[RUN] pnpm verify"
pnpm verify
echo "[RUN] pnpm analyze"
pnpm analyze

UPDATED_IST="$(TZ=Asia/Kolkata date '+%d %b %H:%M IST')"
mkdir -p public
printf '{ "last_updated_ist": "%s" }\n' "$UPDATED_IST" > public/last-updated.json

echo "[RUN] pnpm build"
pnpm build
printf '{ "last_updated_ist": "%s" }\n' "$UPDATED_IST" > dist/last-updated.json

echo "[RUN] publish dist -> $WEB_ROOT"
mkdir -p "$WEB_ROOT"
rsync -a --delete dist/ "$WEB_ROOT/"

echo "[SUCCESS] DONE $(date -Iseconds) (Updated $UPDATED_IST)"
