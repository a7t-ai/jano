#!/bin/bash
# Daily log rotation for jano. Uses copytruncate so launchd-held FDs
# stay valid (rename would orphan the writer's FD onto the renamed copy).
# Idempotent within a day; prunes archives older than KEEP_DAYS.
set -euo pipefail
shopt -s nullglob

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGS_DIR="$PROJECT_DIR/logs"
KEEP_DAYS=14
DATE="$(date +%Y-%m-%d)"

cd "$LOGS_DIR"

echo "[$(date +%FT%T%z)] starting log rotation in $LOGS_DIR"

for log in *.log; do
  [ -f "$log" ] || continue

  if [ -f "${log}.${DATE}.gz" ]; then
    echo "[$(date +%FT%T%z)] skip $log (already rotated today)"
    continue
  fi

  if [ ! -s "$log" ]; then
    echo "[$(date +%FT%T%z)] skip $log (empty)"
    continue
  fi

  cp "$log" "${log}.${DATE}"
  : > "$log"
  gzip "${log}.${DATE}"
  echo "[$(date +%FT%T%z)] rotated $log -> ${log}.${DATE}.gz"
done

find . -maxdepth 1 -type f -name "*.log.*.gz" -mtime "+$KEEP_DAYS" -print -delete \
  | sed 's/^/  pruned: /' || true

echo "[$(date +%FT%T%z)] log rotation complete"
