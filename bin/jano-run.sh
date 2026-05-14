#!/bin/bash
# launchd / systemd entry point. Resolves the project root from the script's
# location, sources mise (if present) so the pinned Node is on PATH, then
# execs the daemon. Stays in the foreground; the process supervisor restarts
# on exit.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if command -v mise >/dev/null 2>&1; then
  NODE_BIN="$(mise which node)"
else
  NODE_BIN="$(command -v node)"
fi

exec "$NODE_BIN" --experimental-strip-types src/index.ts
