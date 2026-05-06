#!/usr/bin/env bash
set -euo pipefail

PORT="${KOOKR_PORT:-4800}"

# Mirror src/server/start.ts: port 4800 → ~/.kookr, other ports → ~/.kookr-<port>.
if [[ "$PORT" == "4800" ]]; then
  KOOKR_DIR="${HOME}/.kookr"
else
  KOOKR_DIR="${HOME}/.kookr-${PORT}"
fi
LOG_FILE="${KOOKR_DIR}/server.log"

if [[ ! -e "$LOG_FILE" ]]; then
  echo "No log file at ${LOG_FILE} yet. Has the prod server been started?" >&2
  exit 1
fi

exec tail -F "$LOG_FILE"
