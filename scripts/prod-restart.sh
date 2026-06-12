#!/usr/bin/env bash
set -euo pipefail

PORT="${KOOKR_PORT:-4800}"
if [[ "${KOOKR_HEALTH_URL:-}" != "" ]]; then
  HEALTH_URL="${KOOKR_HEALTH_URL}"
  HEALTH_URL_EXPLICIT=1
else
  HEALTH_URL=""
  HEALTH_URL_EXPLICIT=0
fi
if [[ "${KOOKR_READY_URL:-}" != "" ]]; then
  READY_URL="${KOOKR_READY_URL}"
  READY_URL_EXPLICIT=1
else
  READY_URL=""
  READY_URL_EXPLICIT=0
fi
STARTUP_TIMEOUT_SECONDS="${KOOKR_STARTUP_TIMEOUT_SECONDS:-720}"
CHECK_INTERVAL_SECONDS="${KOOKR_STARTUP_CHECK_INTERVAL_SECONDS:-2}"
APP_DIR="$(pwd -P)"
PID_FILE="/tmp/kookr-prod-${PORT}.pid"
SYSTEMD_ENV_FILE="${HOME}/.config/kookr/kookr.env"

LOG_GENERATIONS="${KOOKR_LOG_GENERATIONS:-3}"
MAX_LOG_GENERATIONS=100

configure_port_derived_values() {
  if (( HEALTH_URL_EXPLICIT == 0 )); then
    HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
  fi
  if (( READY_URL_EXPLICIT == 0 )); then
    READY_URL="http://127.0.0.1:${PORT}/api/ready"
  fi

  # Mirror src/server/start.ts: port 4800 → ~/.kookr, other ports → ~/.kookr-<port>.
  if [[ "$PORT" == "4800" ]]; then
    KOOKR_DIR="${HOME}/.kookr"
  else
    KOOKR_DIR="${HOME}/.kookr-${PORT}"
  fi
  LOG_FILE="${KOOKR_DIR}/server.log"
  PID_FILE="/tmp/kookr-prod-${PORT}.pid"
}

apply_systemd_env_assignment() {
  local key="$1"
  local value="$2"

  case "$key" in
    KOOKR_PORT)
      PORT="$value"
      ;;
    KOOKR_HEALTH_URL)
      HEALTH_URL="$value"
      HEALTH_URL_EXPLICIT=1
      ;;
    KOOKR_READY_URL)
      READY_URL="$value"
      READY_URL_EXPLICIT=1
      ;;
  esac
}

load_systemd_env_file() {
  local line key value

  [[ -f "$SYSTEMD_ENV_FILE" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=([^[:space:]]*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      apply_systemd_env_assignment "$key" "$value"
    fi
  done < "$SYSTEMD_ENV_FILE"
}

configure_port_derived_values

validate_log_generations() {
  if [[ ! "$LOG_GENERATIONS" =~ ^[0-9]+$ ]]; then
    echo "KOOKR_LOG_GENERATIONS must be a non-negative integer (got ${LOG_GENERATIONS})" >&2
    exit 2
  fi
  while [[ "$LOG_GENERATIONS" == 0* && "${#LOG_GENERATIONS}" -gt 1 ]]; do
    LOG_GENERATIONS="${LOG_GENERATIONS#0}"
  done
  if (( ${#LOG_GENERATIONS} > 3 )); then
    echo "KOOKR_LOG_GENERATIONS must be <= ${MAX_LOG_GENERATIONS} (got ${LOG_GENERATIONS})" >&2
    exit 2
  fi
  LOG_GENERATIONS="$((10#$LOG_GENERATIONS))"
  if (( LOG_GENERATIONS > MAX_LOG_GENERATIONS )); then
    echo "KOOKR_LOG_GENERATIONS must be <= ${MAX_LOG_GENERATIONS} (got ${LOG_GENERATIONS})" >&2
    exit 2
  fi
}

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
  lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true
}

wait_for_port_to_clear() {
  local timeout_seconds="$1"
  local deadline=$((SECONDS + timeout_seconds))

  while (( SECONDS < deadline )); do
    if ! lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
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

  if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${PORT} is still busy after shutdown attempt"
    exit 1
  fi
}

rotate_server_log() {
  local generations="$LOG_GENERATIONS"
  local i

  for (( i = generations; i <= MAX_LOG_GENERATIONS; i++ )); do
    rm -f -- "${LOG_FILE}.${i}"
  done

  if (( generations == 0 )) || [[ ! -e "$LOG_FILE" ]]; then
    return 0
  fi

  for (( i = generations - 1; i >= 1; i-- )); do
    if [[ -e "${LOG_FILE}.${i}" ]]; then
      mv -f -- "${LOG_FILE}.${i}" "${LOG_FILE}.$((i + 1))"
    fi
  done
  mv -f -- "$LOG_FILE" "${LOG_FILE}.1"
  echo "Rotated previous server log to ${LOG_FILE}.1 (retaining ${generations} generation(s))"
}

start_server() {
  rm -f "$PID_FILE"
  mkdir -p "$KOOKR_DIR"
  validate_log_generations
  if [[ -s "$LOG_FILE" ]]; then
    echo "--- last 20 lines of previous ${LOG_FILE} ---"
    tail -n 20 "$LOG_FILE" || true
    echo "--- end of previous log ---"
  fi
  rotate_server_log
  echo "Starting Kookr prod server from ${APP_DIR}"
  echo "Server stdout/stderr → ${LOG_FILE}"
  setsid -f sh -c "echo \$\$ > \"$PID_FILE\"; exec node dist/server/start.js > \"$LOG_FILE\" 2>&1 < /dev/null"
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
      echo "--- last 100 lines of ${LOG_FILE} ---"
      tail -n 100 "$LOG_FILE" || true
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

systemd_unit_active() {
  command -v systemctl >/dev/null 2>&1 \
    && systemctl --user is-active --quiet kookr.service >/dev/null 2>&1
}

restart_systemd_unit() {
  echo "systemd user unit kookr.service is active; delegating restart to systemctl --user restart kookr.service"
  systemctl --user restart kookr.service
}

wait_for_systemd_health() {
  local deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    sleep "$CHECK_INTERVAL_SECONDS"
    if ! systemctl --user is-active --quiet kookr.service >/dev/null 2>&1; then
      echo "Kookr systemd service kookr.service is not active after restart"
      systemctl --user status kookr.service --no-pager || true
      exit 1
    fi
    if curl -sf "$HEALTH_URL"; then
      echo " Kookr systemd service restarted successfully"
      return 0
    fi
  done

  echo "Health check failed after ${STARTUP_TIMEOUT_SECONDS}s for systemd unit kookr.service"
  systemctl --user status kookr.service --no-pager || true
  exit 1
}

run_post_restart_checks() {
  # Post-restart capability nag — if the configured Codex binary doesn't
  # advertise --plugin-dir, kookr-spawned codex sessions silently miss the
  # toolkit. Mirrors the `pnpm run doctor` row; emits only on missing-flag.
  # See scripts/lib/probe-codex-plugin-dir.sh for the shared contract.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  . "${SCRIPT_DIR}/lib/probe-codex-plugin-dir.sh"
  probe_codex_plugin_dir
  if [[ "$PROBE_RESULT" == "missing-flag" ]]; then
    {
      echo "WARN: codex on PATH does not advertise --plugin-dir; kookr-spawned codex sessions"
      echo "      will NOT see the kookr-toolkit. Run \`pnpm codex:rebuild\` to fix."
    } >&2
  fi

  # Post-restart readiness nag (issue #660) — /api/health always returns 200 for
  # the dashboard, so the liveness gate above cannot see a wedged terminal
  # backend or an unwritable state directory. /api/ready turns 503 when a
  # critical subsystem is down; surface that as a non-fatal warning rather than
  # failing the restart (the server is live and serving — an operator should
  # investigate, but a partial outage should not block the deploy).
  # --max-time so a wedged HTTP layer cannot hang the restart after the server is
  # already live (the liveness gate above is bounded by its own deadline loop).
  if ! curl -sf --max-time 5 "$READY_URL" >/dev/null 2>&1; then
    {
      echo "WARN: ${READY_URL} reports NOT READY — a critical subsystem (terminal"
      echo "      backend or persistence) is degraded. The server is live but may"
      echo "      be serving from a partial outage; inspect ${LOG_FILE}."
    } >&2
  fi
}

if [[ "${KOOKR_PROD_RESTART_TEST_ONLY:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

if systemd_unit_active; then
  load_systemd_env_file
  configure_port_derived_values
  restart_systemd_unit
  wait_for_systemd_health
  run_post_restart_checks
  exit 0
fi

stop_existing_server
start_server
wait_for_health
run_post_restart_checks
