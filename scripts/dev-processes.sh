#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-dev}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kookr-dev.XXXXXX")"

SERVER_PID=""
VITE_PID=""
SERVER_PREFIX_PID=""
VITE_PREFIX_PID=""
CLEANED_UP=0

WATCH_PATHS=(
  --watch-path=src/server
  --watch-path=src/core
  --watch-path=src/adapters
  --watch-path=src/shared
  --watch-path=src/remote
  --watch-path=src/integrations
)

if [[ "$MODE" == "demo" ]]; then
  WATCH_PATHS=(
    --watch-path=scripts
    --watch-path=src/server
    --watch-path=src/core
    --watch-path=src/adapters
    --watch-path=src/shared
    --watch-path=demo
  )
fi

VITE_BIN="$REPO_ROOT/node_modules/.bin/vite"
if [[ ! -x "$VITE_BIN" ]]; then
  VITE_BIN="vite"
fi

prefix_stream() {
  local name="$1"
  local line

  while IFS= read -r line; do
    printf '[%s] %s\n' "$name" "$line"
  done
}

start_prefixed() {
  local name="$1"
  local child_var="$2"
  local prefix_var="$3"
  local fifo="$TMP_DIR/${name}.fifo"
  shift 3

  # The FIFO lets the prefixer keep stdout/stderr labels while the caller keeps
  # separate PIDs for both the child process and its prefix reader.
  mkfifo "$fifo"
  prefix_stream "$name" < "$fifo" &
  eval "$prefix_var=$!"
  "$@" > "$fifo" 2>&1 &
  eval "$child_var=$!"
}

pid_is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

wait_status() {
  local pid="$1"
  local status=0

  wait "$pid" || status=$?
  printf '%s\n' "$status"
}

cleanup() {
  local pid
  local deadline
  local any_alive

  if (( CLEANED_UP == 1 )); then
    return 0
  fi
  CLEANED_UP=1
  trap - EXIT INT TERM

  for pid in "$SERVER_PID" "$VITE_PID"; do
    if pid_is_alive "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  deadline=$((SECONDS + 5))
  while (( SECONDS < deadline )); do
    any_alive=0
    for pid in "$SERVER_PID" "$VITE_PID"; do
      if pid_is_alive "$pid"; then
        any_alive=1
      fi
    done
    (( any_alive == 0 )) && break
    sleep 1
  done

  for pid in "$SERVER_PID" "$VITE_PID"; do
    if pid_is_alive "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done

  for pid in "$SERVER_PID" "$VITE_PID" "$SERVER_PREFIX_PID" "$VITE_PREFIX_PID"; do
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done

  rm -rf "$TMP_DIR"
}

handle_signal() {
  cleanup
  exit 130
}

trap cleanup EXIT
trap handle_signal INT TERM

cd "$REPO_ROOT"

case "$MODE" in
  dev)
    start_prefixed server SERVER_PID SERVER_PREFIX_PID \
      env KOOKR_PORT=4801 node --import tsx "${WATCH_PATHS[@]}" src/server/start.ts
    ;;
  demo)
    start_prefixed server SERVER_PID SERVER_PREFIX_PID \
      env KOOKR_PORT=4801 node --import tsx "${WATCH_PATHS[@]}" scripts/dev-demo.ts
    ;;
  *)
    echo "Usage: $0 [dev|demo]" >&2
    exit 2
    ;;
esac

start_prefixed vite VITE_PID VITE_PREFIX_PID "$VITE_BIN"

while true; do
  if ! pid_is_alive "$SERVER_PID"; then
    STATUS="$(wait_status "$SERVER_PID")"
    echo "[dev] server exited with status $STATUS"
    cleanup
    exit "$STATUS"
  fi

  if ! pid_is_alive "$VITE_PID"; then
    STATUS="$(wait_status "$VITE_PID")"
    echo "[dev] vite exited with status $STATUS"
    cleanup
    exit "$STATUS"
  fi

  sleep 1
done
