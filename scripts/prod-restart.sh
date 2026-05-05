#!/usr/bin/env bash
set -euo pipefail

PORT="${KOOKR_PORT:-4800}"
HEALTH_URL="${KOOKR_HEALTH_URL:-http://127.0.0.1:${PORT}/api/health}"
STARTUP_TIMEOUT_SECONDS="${KOOKR_STARTUP_TIMEOUT_SECONDS:-720}"
CHECK_INTERVAL_SECONDS="${KOOKR_STARTUP_CHECK_INTERVAL_SECONDS:-2}"
APP_DIR="$(pwd -P)"
PID_FILE="/tmp/kookr-prod-${PORT}.pid"

get_process_cwd() {
  local pid="$1"
  local cwd=""

  if [[ -e "/proc/${pid}/cwd" ]]; then
    cwd="$(cd "/proc/${pid}/cwd" 2>/dev/null && pwd -P)" || true
  else
    cwd="$(
      lsof -a -d cwd -p "$pid" -Fn 2>/dev/null \
        | sed -n 's/^n//p' \
        | head -n 1
    )"
    if [[ -n "$cwd" ]]; then
      cwd="$(cd "$cwd" 2>/dev/null && pwd -P)" || true
    fi
  fi

  printf '%s\n' "$cwd"
}

find_start_pids() {
  local pid cwd cmd
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    cwd="$(get_process_cwd "$pid")"
    [[ "$cwd" == "$APP_DIR" ]] || continue
    cmd="$(ps -p "$pid" -o args= 2>/dev/null || true)"
    [[ "$cmd" == *"node dist/server/start.js"* ]] || continue
    printf '%s\n' "$pid"
  done < <(pgrep -f "node dist/server/start.js" 2>/dev/null || true)
}

wait_for_pids_to_exit() {
  local timeout_seconds="$1"
  shift
  local deadline=$((SECONDS + timeout_seconds))
  local -a pids=("$@")
  local -a remaining=()
  local pid

  while (( SECONDS < deadline )); do
    remaining=()
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        remaining+=("$pid")
      fi
    done

    if (( ${#remaining[@]} == 0 )); then
      return 0
    fi

    pids=("${remaining[@]}")
    sleep 1
  done

  return 1
}

terminate_pids() {
  local signal="$1"
  shift
  local pid
  for pid in "$@"; do
    kill -s "$signal" "$pid" 2>/dev/null || true
  done
}

find_port_pids() {
  lsof -ti:"$PORT" 2>/dev/null || true
}

wait_for_port_to_clear() {
  local timeout_seconds="$1"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if ! lsof -ti:"$PORT" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  return 1
}

wait_for_start_pids_to_exit() {
  local timeout_seconds="$1"
  local -a pids=()

  mapfile -t pids < <(find_start_pids)
  if (( ${#pids[@]} == 0 )); then
    return 0
  fi

  if wait_for_pids_to_exit "$timeout_seconds" "${pids[@]}"; then
    return 0
  fi

  mapfile -t pids < <(find_start_pids)
  if (( ${#pids[@]} > 0 )); then
    echo "Force-killing lingering Kookr startup processes: ${pids[*]}"
    terminate_pids KILL "${pids[@]}"
    sleep 1
  fi
}

stop_existing_server() {
  local -a port_pids=()
  local -a start_pids=()

  mapfile -t port_pids < <(find_port_pids)
  if (( ${#port_pids[@]} > 0 )); then
    echo "Stopping process(es) on port ${PORT}: ${port_pids[*]}"
    terminate_pids TERM "${port_pids[@]}"
    wait_for_port_to_clear 30 || true
  fi

  mapfile -t start_pids < <(find_start_pids)
  if (( ${#start_pids[@]} > 0 )); then
    echo "Stopping existing Kookr startup process(es): ${start_pids[*]}"
    terminate_pids TERM "${start_pids[@]}"
    wait_for_start_pids_to_exit 30
  fi

  mapfile -t port_pids < <(find_port_pids)
  if (( ${#port_pids[@]} > 0 )); then
    echo "Force-killing lingering process(es) on port ${PORT}: ${port_pids[*]}"
    terminate_pids KILL "${port_pids[@]}"
    wait_for_port_to_clear 5 || true
  fi

  if lsof -ti:"$PORT" >/dev/null 2>&1; then
    echo "Port ${PORT} is still busy after shutdown attempt"
    exit 1
  fi
}

start_server() {
  rm -f "$PID_FILE"
  echo "Starting Kookr prod server from ${APP_DIR}"
  setsid -f sh -c "echo \$\$ > \"$PID_FILE\"; exec node dist/server/start.js > kookr.log 2>&1 < /dev/null"
}

wait_for_health() {
  local deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
  local start_pid=""

  while (( SECONDS < deadline )); do
    if [[ -s "$PID_FILE" ]]; then
      start_pid="$(cat "$PID_FILE")"
      break
    fi
    sleep 1
  done

  if [[ -z "$start_pid" ]]; then
    echo "Failed to capture the Kookr prod server PID"
    exit 1
  fi

  while (( SECONDS < deadline )); do
    sleep "$CHECK_INTERVAL_SECONDS"
    if ! kill -0 "$start_pid" 2>/dev/null; then
      echo "Kookr prod server exited before becoming healthy"
      tail -n 100 kookr.log || true
      exit 1
    fi
    if curl -sf "$HEALTH_URL"; then
      rm -f "$PID_FILE"
      echo " Kookr prod restarted successfully"
      return 0
    fi
  done

  rm -f "$PID_FILE"
  echo "Health check failed after ${STARTUP_TIMEOUT_SECONDS}s"
  exit 1
}

stop_existing_server
start_server
wait_for_health
