#!/usr/bin/env bash
# Stop the production-style Kookr Node process (and optionally bundled speech sidecars).
#
#   pnpm prod:stop                 # stop Node only; leave STT/TTS running; print GPU hint
#   pnpm prod:stop --with-sidecars # stop Node first, then shared compose teardown
#
# See docs/rfc/rfc-fast-prod-restart.md (R6, R14) and docs/configuration.md.
set -euo pipefail

PORT="${KOOKR_PORT:-4800}"
APP_DIR="$(pwd -P)"
SYSTEMD_ENV_FILE="${HOME}/.config/kookr/kookr.env"
WITH_SIDECARS=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

for arg in "$@"; do
  case "$arg" in
    --with-sidecars)
      WITH_SIDECARS=1
      ;;
    -h|--help)
      cat <<'EOF'
Usage: prod-stop.sh [--with-sidecars]

  Stop the Kookr production Node process on KOOKR_PORT (default 4800).

  --with-sidecars
      After Node stops, tear down bundled STT/TTS via the shared stop-sidecars
      entrypoint (same compose flags as start). Skips foreign stacks when only
      external KOOKR_STT_URL / KOOKR_TTS_URL are configured.

  Without --with-sidecars, speech containers are left running (warm restart
  path). Free GPU memory with: pnpm prod:stop --with-sidecars
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

if [[ "${KOOKR_HEALTH_URL:-}" != "" ]]; then
  HEALTH_URL_EXPLICIT=1
else
  HEALTH_URL_EXPLICIT=0
fi

apply_systemd_env_assignment() {
  local key="$1"
  local value="$2"
  case "$key" in
    KOOKR_PORT) PORT="$value" ;;
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

# Mirror prod-restart: if systemd unit is active, load its env for the port.
systemd_unit_active() {
  command -v systemctl >/dev/null 2>&1 \
    && systemctl --user is-active --quiet kookr.service >/dev/null 2>&1
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
    sleep 0.2
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

# Load .env from APP_DIR into the environment for stop-sidecars ownership checks
# (does not override already-exported vars).
load_app_env_file() {
  local env_file="${APP_DIR}/.env"
  [[ -f "$env_file" ]] || return 0
  set -a
  # shellcheck disable=SC1090
  source "$env_file" 2>/dev/null || true
  set +a
}

stop_node() {
  local -a port_pids=()
  local -a start_pids=()
  local pid

  if systemd_unit_active; then
    load_systemd_env_file
    echo "Stopping systemd user unit kookr.service..."
    systemctl --user stop kookr.service || true
    # Fall through to also clear any stray pid-file listeners on the port.
  fi

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    port_pids+=("$pid")
  done < <(find_port_pids)

  if (( ${#port_pids[@]} > 0 )); then
    echo "Stopping process(es) on port ${PORT}: ${port_pids[*]}"
    terminate_pids TERM "${port_pids[@]}"
    wait_for_port_to_clear 30 || true
  fi

  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    start_pids+=("$pid")
  done < <(find_start_pids)

  if (( ${#start_pids[@]} > 0 )); then
    echo "Stopping existing Kookr startup process(es): ${start_pids[*]}"
    terminate_pids TERM "${start_pids[@]}"
    sleep 1
  fi

  port_pids=()
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    port_pids+=("$pid")
  done < <(find_port_pids)

  if (( ${#port_pids[@]} > 0 )); then
    echo "Force-killing lingering process(es) on port ${PORT}: ${port_pids[*]}"
    terminate_pids KILL "${port_pids[@]}"
    wait_for_port_to_clear 5 || true
  fi

  if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port ${PORT} is still busy after stop attempt" >&2
    exit 1
  fi

  echo "Kookr Node process stopped (port ${PORT} free)."
}

print_gpu_hint() {
  echo "NOTE: Bundled STT/TTS containers (if any) were left running so the next start can reuse them."
  echo "      Free GPU / stop speech sidecars with: pnpm prod:stop --with-sidecars"
}

stop_sidecars() {
  load_app_env_file
  echo "Tearing down bundled speech sidecars (shared compose identity)..."
  (cd "$APP_DIR" && node --import tsx "${SCRIPT_DIR}/stop-sidecars.ts")
}

# Resolve APP_DIR like prod:restart: when invoked via `pnpm prod:stop` the
# package.json cd's into ../kookr-prod first. If that sibling is missing, stay
# in cwd (development / direct script use).
if [[ -d "${APP_DIR}/../kookr-prod" ]] && [[ "$(basename "$APP_DIR")" != "kookr-prod" ]]; then
  # Only auto-switch when the package.json wrapper did not already cd —
  # ROOT_DIR convention from package.json is optional; prefer explicit APP_DIR.
  :
fi

stop_node

if (( WITH_SIDECARS == 1 )); then
  stop_sidecars
else
  print_gpu_hint
fi
