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
# Startup gate deadline (issue #1721). Listen-early already landed: the server
# binds the HTTP listener before deferred recovery finishes, and this script
# waits on /api/ready until ready is no longer `startup-in-progress`. Recovery
# on a ~727-task instance was measured multi-minute and raced the old 720s
# default — keep the default comfortably above observed M2 so a loaded box
# doesn't fail the deploy and tempt a retry that kills the almost-ready server.
STARTUP_TIMEOUT_SECONDS="${KOOKR_STARTUP_TIMEOUT_SECONDS:-1800}"
# Early poll for fast warm restarts (RFC fast-prod-restart R4): default ≤200ms.
# Override with KOOKR_STARTUP_CHECK_INTERVAL_SECONDS (fractional seconds ok).
CHECK_INTERVAL_SECONDS="${KOOKR_STARTUP_CHECK_INTERVAL_SECONDS:-0.2}"
# Per-probe curl bound for the liveness gate (issue #1553). The deadline loop
# only re-checks BETWEEN curls, so one unbounded curl against a hung
# /api/health defeats STARTUP_TIMEOUT_SECONDS and wedges the deploy forever.
HEALTH_CURL_MAX_TIME_SECONDS="${KOOKR_HEALTH_CURL_MAX_TIME_SECONDS:-10}"
APP_DIR="$(pwd -P)"
RESTART_SCRIPT_DIR="$(
  cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null
  pwd -P
)"
# Reason recorded in the planned-restart marker (issue #2410). prod-update.sh
# overrides this to "prod:update"; a bare `pnpm prod:restart` keeps the default.
RESTART_INTENT_REASON="${KOOKR_RESTART_INTENT_REASON:-prod:restart}"
# Unique token of the marker we wrote, captured so clear only deletes OUR marker.
RESTART_INTENT_TOKEN=""
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

# Planned-restart marker (issue #2410). Written BEFORE the old server is killed
# and cleared once the new server is healthy, so the local `kookr` CLI can tell
# a planned redeploy apart from an unexpected crash while the API is down. Both
# helpers are best-effort: a marker failure must never block or fail a deploy.
RESTART_INTENT_HELPER="${RESTART_SCRIPT_DIR}/../bin/kookr-restart-intent.js"

write_restart_intent() {
  [[ -f "$RESTART_INTENT_HELPER" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  local token=""
  # Stamp the deploy's own give-up budget so the CLI only reads "failed deploy"
  # once the restart outlives the time this deploy actually allowed itself.
  local stale_after_ms=$(( STARTUP_TIMEOUT_SECONDS * 1000 ))
  if token="$(node "$RESTART_INTENT_HELPER" write \
    --dir "$KOOKR_DIR" \
    --reason "$RESTART_INTENT_REASON" \
    --initiator "$(basename "${BASH_SOURCE[0]}")" \
    --pid "$$" \
    --stale-after-ms "$stale_after_ms" 2>/dev/null)"; then
    RESTART_INTENT_TOKEN="$token"
    echo "Recorded planned-restart marker (${RESTART_INTENT_REASON}) in ${KOOKR_DIR}"
  else
    echo "WARN: could not record planned-restart marker in ${KOOKR_DIR}; CLI outage messages will be generic" >&2
  fi
}

clear_restart_intent() {
  [[ -f "$RESTART_INTENT_HELPER" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  # If write failed (no token captured) there is no marker of OURS to clear;
  # skip entirely rather than force-remove whatever is on disk — a concurrent
  # deploy's live marker must not be erased by us.
  [[ -n "$RESTART_INTENT_TOKEN" ]] || return 0
  # Ownership-checked: only delete the marker whose unique token we wrote, so a
  # concurrent restart's in-flight marker is never erased out from under it.
  if node "$RESTART_INTENT_HELPER" clear \
    --dir "$KOOKR_DIR" \
    --expect-token "$RESTART_INTENT_TOKEN" >/dev/null 2>&1; then
    :
  else
    echo "WARN: could not clear planned-restart marker in ${KOOKR_DIR}; a stale marker may linger" >&2
  fi
}

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

# macOS ships bash 3.2, which has no `mapfile`/`readarray`. `_collect_lines`
# reads stdin into the global array `_COLLECTED_LINES`; callers copy it with the
# set -u-safe `${arr[@]:+...}` form. Feed it via process substitution
# (`_collect_lines < <(producer)`), not a pipe: a pipe would run the loop in a
# subshell and the populated array would not survive into the caller.
_collect_lines() {
  _COLLECTED_LINES=()
  local _line=""
  while IFS= read -r _line; do
    _COLLECTED_LINES+=("$_line")
  done
  # A final line with no trailing newline leaves `read` returning non-zero with
  # `$_line` still populated, so the loop skips it; append it here so this is a
  # faithful `mapfile -t` replacement regardless of the producer. The `if`
  # (not `&& `) keeps the function's exit status 0 under `set -e`.
  if [ -n "$_line" ]; then
    _COLLECTED_LINES+=("$_line")
  fi
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

  _collect_lines < <(find_start_pids)
  pids=("${_COLLECTED_LINES[@]:+${_COLLECTED_LINES[@]}}")
  if (( ${#pids[@]} == 0 )); then
    return 0
  fi

  if wait_for_pids_to_exit "$timeout_seconds" "${pids[@]}"; then
    return 0
  fi

  _collect_lines < <(find_start_pids)
  pids=("${_COLLECTED_LINES[@]:+${_COLLECTED_LINES[@]}}")
  if (( ${#pids[@]} > 0 )); then
    echo "Force-killing lingering Kookr startup processes: ${pids[*]}"
    terminate_pids KILL "${pids[@]}"
    sleep 1
  fi
}

# Best-effort enter drain mode before SIGTERM (issue #1971).
# Opt out: KOOKR_RESTART_SKIP_DRAIN=1.
# Bound with a short timeout so a hung admin endpoint never blocks restart.
#
# Drain is in-memory only on the running process. Process kill/restart clears
# it automatically — the fresh process accepts launches by default. No post-
# restart `kookr resume` is required (resume would be a no-op on a new PID).
#
# Before drain, write a short-lived server-restarting marker (issue #1983) so
# schedule fires during pre-stop drain record `skipped_server_restarting`
# instead of a generic operator drain — operators can see "missed due to
# redeploy" after resume. Marker is age-capped by the server reader.
write_server_restarting_marker() {
  # Prefer the port-derived KOOKR_DIR (set by configure_port_derived_values in
  # the main flow). When sourced in isolation (unit tests), fall back so the
  # write is still best-effort rather than targeting an empty path.
  if [[ -z "${KOOKR_DIR:-}" ]]; then
    if [[ "${PORT:-4800}" == "4800" ]]; then
      KOOKR_DIR="${HOME}/.kookr"
    else
      KOOKR_DIR="${HOME}/.kookr-${PORT}"
    fi
  fi
  local marker_file at_iso tmp
  marker_file="${KOOKR_DIR}/server-restarting.json"
  at_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  if [[ -z "$at_iso" ]]; then
    at_iso="unknown"
  fi
  set +e
  mkdir -p "$KOOKR_DIR" 2>/dev/null
  tmp="$(mktemp "${KOOKR_DIR}/server-restarting.XXXXXX" 2>/dev/null)"
  if [[ -z "$tmp" ]]; then
    echo "WARN: could not write ${marker_file} (mktemp failed)" >&2
    set -e
    return 0
  fi
  cat > "$tmp" <<EOF
{
  "schemaVersion": "server-restarting.v1",
  "reason": "server_restarting",
  "at": "${at_iso}",
  "source": "prod-restart"
}
EOF
  if [[ $? -eq 0 ]] && mv -f "$tmp" "$marker_file" 2>/dev/null; then
    echo "Wrote server-restarting marker → ${marker_file}"
  else
    rm -f -- "$tmp" 2>/dev/null
    echo "WARN: could not write ${marker_file}" >&2
  fi
  set -e
}

enter_drain_before_stop() {
  if [[ "${KOOKR_RESTART_SKIP_DRAIN:-}" == "1" ]]; then
    echo "Skipping pre-stop drain (KOOKR_RESTART_SKIP_DRAIN=1)"
    return 0
  fi

  # Marker first so any schedule tick that races the drain POST already sees
  # the redeploy signal (issue #1983). Best-effort; never blocks restart.
  write_server_restarting_marker

  local drain_url="http://127.0.0.1:${PORT}/api/admin/drain"
  local max_time="${KOOKR_RESTART_DRAIN_TIMEOUT_SECONDS:-2}"
  local -a curl_args=(
    -sS
    -o /dev/null
    -w '%{http_code}'
    --max-time "$max_time"
    -X POST
  )
  if [[ -n "${KOOKR_ADMIN_TOKEN:-}" ]]; then
    curl_args+=(-H "x-kookr-admin-token: ${KOOKR_ADMIN_TOKEN}")
  fi
  curl_args+=("$drain_url")

  echo "Entering drain mode before stop (${drain_url}, timeout ${max_time}s)..."
  local http_code=""
  # Best-effort: never fail the restart if drain is unreachable / hung.
  set +e
  http_code="$(curl "${curl_args[@]}" 2>/dev/null)"
  local curl_status=$?
  set -e
  if (( curl_status == 0 )) && [[ "$http_code" == "200" ]]; then
    echo "Drain mode ON (HTTP 200) — new launches will get 503 until process exit"
  else
    echo "Pre-stop drain skipped/failed (HTTP ${http_code:-000}, curl=${curl_status}) — continuing restart"
  fi
}

stop_existing_server() {
  local -a port_pids=()
  local -a start_pids=()

  _collect_lines < <(find_port_pids)
  port_pids=("${_COLLECTED_LINES[@]:+${_COLLECTED_LINES[@]}}")
  if (( ${#port_pids[@]} > 0 )); then
    echo "Stopping process(es) on port ${PORT}: ${port_pids[*]}"
    terminate_pids TERM "${port_pids[@]}"
    wait_for_port_to_clear 30 || true
  fi

  _collect_lines < <(find_start_pids)
  start_pids=("${_COLLECTED_LINES[@]:+${_COLLECTED_LINES[@]}}")
  if (( ${#start_pids[@]} > 0 )); then
    echo "Stopping existing Kookr startup process(es): ${start_pids[*]}"
    terminate_pids TERM "${start_pids[@]}"
    wait_for_start_pids_to_exit 30
  fi

  _collect_lines < <(find_port_pids)
  port_pids=("${_COLLECTED_LINES[@]:+${_COLLECTED_LINES[@]}}")
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
  # glibc allocator tuning (issue #1753) — mirrors the systemd unit's
  # Environment= lines so the pid-file fallback path gets the same mitigation
  # for the RSS sawtooth / arena fragmentation. glibc reads these at init, so
  # they must be exported before node starts. No-op on macOS/musl.
  # Pre-existing values in the launching shell win, keeping them overridable.
  local launch="export MALLOC_ARENA_MAX=\"\${MALLOC_ARENA_MAX:-2}\" MALLOC_TRIM_THRESHOLD_=\"\${MALLOC_TRIM_THRESHOLD_:-131072}\"; echo \$\$ > \"$PID_FILE\"; exec node dist/server/start.js > \"$LOG_FILE\" 2>&1 < /dev/null"
  if command -v setsid >/dev/null 2>&1; then
    # Linux: setsid -f gives the server a brand-new session, fully detached.
    setsid -f sh -c "$launch"
  else
    # macOS has no setsid. nohup + background + disown detaches the server
    # from this shell so it survives `pnpm prod:restart` returning.
    nohup sh -c "$launch" >/dev/null 2>&1 &
    disown 2>/dev/null || true
  fi
}

# Deploy gate (issue #1721): prefer /api/ready so listen-early boots stay
# "not ready" until deferred recovery finishes. Success is:
#   - HTTP 200 (fully ready), OR
#   - HTTP 503 whose body does NOT contain startup-in-progress (startup done;
#     other critical degradation is handled as a non-fatal post-restart WARN).
# Connection refused / curl failure keeps waiting (listener not bound yet).
# Writes the response body to $1 when a probe reaches the server.
probe_ready_for_deploy() {
  local body_file="$1"
  local http_code=""
  local curl_status=0

  # Do not append a fallback via `|| echo` after curl -w: on connection failure
  # curl already writes "000" and a non-zero exit, which would concatenate to
  # "000000" and never match a real status code.
  set +e
  http_code="$(
    curl -sS --max-time "$HEALTH_CURL_MAX_TIME_SECONDS" \
      -o "$body_file" -w '%{http_code}' \
      "$READY_URL" 2>/dev/null
  )"
  curl_status=$?
  set -e
  if (( curl_status != 0 )) || [[ -z "$http_code" ]]; then
    http_code="000"
  fi

  if [[ "$http_code" == "200" ]]; then
    return 0
  fi
  if [[ "$http_code" == "503" ]] && [[ -s "$body_file" ]] \
    && ! grep -q 'startup-in-progress' "$body_file" 2>/dev/null; then
    return 0
  fi
  return 1
}

# Operator-facing phase snippet for heartbeats (best-effort; empty on parse miss).
ready_probe_phase_hint() {
  local body_file="$1"
  if [[ ! -s "$body_file" ]]; then
    echo "waiting for listener"
    return 0
  fi
  if grep -q 'startup-in-progress' "$body_file" 2>/dev/null; then
    # Prefer the startup.status field when present.
    local status
    status="$(
      sed -n 's/.*"startup"[[:space:]]*:[[:space:]]*{[^}]*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$body_file" 2>/dev/null | head -n 1
    )"
    if [[ -n "$status" ]]; then
      echo "startup phase=${status}"
      return 0
    fi
    echo "startup in progress"
    return 0
  fi
  echo "probe pending"
}

# Probe GET /api/health for M1 process liveness (HTTP 200). Connection failure
# keeps waiting. Writes body to $1 when a probe reaches the server.
probe_health_for_m1() {
  local body_file="$1"
  local http_code=""
  local curl_status=0

  set +e
  http_code="$(
    curl -sS --max-time "$HEALTH_CURL_MAX_TIME_SECONDS" \
      -o "$body_file" -w '%{http_code}' \
      "$HEALTH_URL" 2>/dev/null
  )"
  curl_status=$?
  set -e
  if (( curl_status != 0 )) || [[ -z "$http_code" ]]; then
    http_code="000"
  fi
  [[ "$http_code" == "200" ]]
}

# Print phase timings + dominant phase (RFC fast-prod-restart R5).
# Args are wall-clock seconds (integers preferred; fractional ok as strings).
# Also prints apiBlackoutSeconds (port free → first /api/health 200) and a
# non-fatal WARN when blackout exceeds the 5s SLO (issue #1972).
# Caveat: systemd path approximates port free at systemctl-restart return.
print_restart_phase_timings() {
  local port_free_s="$1"
  local m1_s="$2"
  local m2_s="$3"
  local smoke_s="$4"
  local total_s="$5"

  # Derive phase durations (clamped at 0).
  local d_port d_m1 d_m2 d_smoke
  d_port="$port_free_s"
  d_m1="$(awk -v a="$m1_s" -v b="$port_free_s" 'BEGIN { d=a-b; if (d<0) d=0; printf "%.1f", d }')"
  d_m2="$(awk -v a="$m2_s" -v b="$m1_s" 'BEGIN { d=a-b; if (d<0) d=0; printf "%.1f", d }')"
  d_smoke="$(awk -v a="$smoke_s" -v b="$m2_s" 'BEGIN { d=a-b; if (d<0) d=0; printf "%.1f", d }')"

  # API blackout = gap from last listen lost (port free) → first health 200.
  local api_blackout="$d_m1"

  echo "Restart phase timings:"
  echo "  port free (stop→listen free):  ${d_port}s"
  echo "  M1 first /api/health 200:      ${m1_s}s wall (Δ ${d_m1}s after port free)"
  echo "  M2 deploy-ready /api/ready:    ${m2_s}s wall (Δ ${d_m2}s after M1)"
  echo "  smoke end:                     ${smoke_s}s wall (Δ ${d_smoke}s after M2)"
  echo "  total script:                  ${total_s}s"
  echo "  apiBlackoutSeconds:            ${api_blackout}s  (port free → first /api/health; ideal <1s, SLO max 5s)"

  # Dominant phase among stop, M1-gap, M2-gap, smoke-gap.
  awk -v p="$d_port" -v m1="$d_m1" -v m2="$d_m2" -v sm="$d_smoke" 'BEGIN {
    max=p+0; name="port-free"
    if (m1+0 > max) { max=m1+0; name="M1-health" }
    if (m2+0 > max) { max=m2+0; name="M2-ready" }
    if (sm+0 > max) { max=sm+0; name="smoke" }
    printf "  dominant phase: %s (%.1fs)\n", name, max
  }'

  # Non-fatal SLO warning (issue #1972). Ideal <1s; hard warn above 5s.
  if awk -v b="$api_blackout" 'BEGIN { exit !(b + 0 > 5) }'; then
    echo "WARN: API blackout ${api_blackout}s exceeds 5s SLO (ideal <1s)" >&2
  fi
}

# Persist last restart phase timings for GET /api/deploy/status (issue #1973).
# Writes ${KOOKR_DIR}/last-restart-metrics.json (port-aware via configure_port_derived_values).
# Best-effort: never fails the restart if the write fails.
write_last_restart_metrics() {
  local port_free_s="$1"
  local m1_s="$2"
  local m2_s="$3"
  local smoke_s="$4"
  local total_s="$5"
  local path_mode="${6:-script}"

  local metrics_file api_blackout d_m2 d_smoke dominant at_iso tmp
  metrics_file="${KOOKR_DIR}/last-restart-metrics.json"
  api_blackout="$(awk -v a="$m1_s" -v b="$port_free_s" 'BEGIN { d=a-b; if (d<0) d=0; printf "%.1f", d }')"
  d_m2="$(awk -v a="$m2_s" -v b="$m1_s" 'BEGIN { d=a-b; if (d<0) d=0; printf "%.1f", d }')"
  d_smoke="$(awk -v a="$smoke_s" -v b="$m2_s" 'BEGIN { d=a-b; if (d<0) d=0; printf "%.1f", d }')"
  dominant="$(awk -v p="$port_free_s" -v m1="$api_blackout" -v m2="$d_m2" -v sm="$d_smoke" 'BEGIN {
    max=p+0; name="port-free"
    if (m1+0 > max) { max=m1+0; name="M1-health" }
    if (m2+0 > max) { max=m2+0; name="M2-ready" }
    if (sm+0 > max) { max=sm+0; name="smoke" }
    printf "%s", name
  }')"
  at_iso="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
  if [[ -z "$at_iso" ]]; then
    at_iso="unknown"
  fi

  # Fully best-effort under set -e: never abort a healthy restart on metrics I/O.
  set +e
  mkdir -p "$KOOKR_DIR" 2>/dev/null
  tmp="$(mktemp "${KOOKR_DIR}/last-restart-metrics.XXXXXX" 2>/dev/null)"
  if [[ -z "$tmp" ]]; then
    echo "WARN: could not write ${metrics_file} (mktemp failed)" >&2
    set -e
    return 0
  fi
  # Numbers only from our phase vars / awk; path_mode is a fixed enum from callers.
  cat > "$tmp" <<EOF
{
  "schemaVersion": "last-restart-metrics.v1",
  "at": "${at_iso}",
  "port": ${PORT},
  "path": "${path_mode}",
  "m1Seconds": ${m1_s},
  "m2Seconds": ${m2_s},
  "portFreeSeconds": ${port_free_s},
  "smokeSeconds": ${smoke_s},
  "totalSeconds": ${total_s},
  "apiBlackoutSeconds": ${api_blackout},
  "dominantPhase": "${dominant}"
}
EOF
  if [[ $? -eq 0 ]] && mv -f "$tmp" "$metrics_file" 2>/dev/null; then
    echo "Wrote restart metrics → ${metrics_file}"
  else
    rm -f -- "$tmp" 2>/dev/null
    echo "WARN: could not write ${metrics_file}" >&2
  fi
  set -e
}

wait_for_health() {
  # Populates PHASE_M1_S / PHASE_M2_S as wall seconds since RESTART_T0.
  # Default RESTART_T0 when sourced by unit tests that call wait_for_health alone.
  : "${RESTART_T0:=$SECONDS}"
  local deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
  local start_pid=""
  local body_file=""
  local last_heartbeat=$SECONDS
  local phase_hint=""
  local m1_seen=0
  local health_body=""

  PHASE_M1_S=""
  PHASE_M2_S=""

  while (( SECONDS < deadline )); do
    if [[ -s "$PID_FILE" ]]; then
      start_pid="$(cat "$PID_FILE")"
      break
    fi
    sleep "$CHECK_INTERVAL_SECONDS"
  done

  if [[ -z "$start_pid" ]]; then
    echo "Failed to capture the Kookr prod server PID"
    exit 1
  fi

  body_file="$(mktemp "${TMPDIR:-/tmp}/kookr-ready-probe.XXXXXX")"
  health_body="$(mktemp "${TMPDIR:-/tmp}/kookr-health-probe.XXXXXX")"

  last_heartbeat=$SECONDS
  while (( SECONDS < deadline )); do
    sleep "$CHECK_INTERVAL_SECONDS"
    if ! kill -0 "$start_pid" 2>/dev/null; then
      rm -f -- "$body_file" "$health_body"
      echo "Kookr prod server exited before becoming healthy"
      echo "--- last 100 lines of ${LOG_FILE} ---"
      tail -n 100 "$LOG_FILE" || true
      exit 1
    fi

    # M1: first successful /api/health (process liveness).
    if (( m1_seen == 0 )); then
      if probe_health_for_m1 "$health_body"; then
        m1_seen=1
        PHASE_M1_S=$((SECONDS - RESTART_T0))
        echo "M1: ${HEALTH_URL} OK at +${PHASE_M1_S}s"
      fi
    fi

    if probe_ready_for_deploy "$body_file"; then
      PHASE_M2_S=$((SECONDS - RESTART_T0))
      if (( m1_seen == 0 )); then
        # Ready implies listener is up; backfill M1 if health probe lagged.
        PHASE_M1_S="$PHASE_M2_S"
        m1_seen=1
      fi
      rm -f -- "$body_file" "$health_body" "$PID_FILE"
      echo "M2: ${READY_URL} deploy-ready at +${PHASE_M2_S}s"
      echo " Kookr prod restarted successfully"
      return 0
    fi
    if (( SECONDS - last_heartbeat >= 30 )); then
      phase_hint="$(ready_probe_phase_hint "$body_file")"
      echo "Still waiting for ${READY_URL} (${SECONDS}s elapsed of ${STARTUP_TIMEOUT_SECONDS}s; server pid ${start_pid} alive; ${phase_hint})"
      last_heartbeat=$SECONDS
    fi
  done

  rm -f -- "$body_file" "$health_body" "$PID_FILE"
  echo "Health check failed after ${STARTUP_TIMEOUT_SECONDS}s"
  echo "--- last 100 lines of ${LOG_FILE} ---"
  tail -n 100 "$LOG_FILE" || true
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
  # Populates PHASE_M1_S / PHASE_M2_S as wall seconds since RESTART_T0.
  : "${RESTART_T0:=$SECONDS}"
  local deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
  local body_file=""
  local health_body=""
  local last_heartbeat=$SECONDS
  local phase_hint=""
  local m1_seen=0

  PHASE_M1_S=""
  PHASE_M2_S=""

  body_file="$(mktemp "${TMPDIR:-/tmp}/kookr-ready-probe.XXXXXX")"
  health_body="$(mktemp "${TMPDIR:-/tmp}/kookr-health-probe.XXXXXX")"

  last_heartbeat=$SECONDS
  while (( SECONDS < deadline )); do
    sleep "$CHECK_INTERVAL_SECONDS"
    if ! systemctl --user is-active --quiet kookr.service >/dev/null 2>&1; then
      rm -f -- "$body_file" "$health_body"
      echo "Kookr systemd service kookr.service is not active after restart"
      systemctl --user status kookr.service --no-pager || true
      exit 1
    fi

    if (( m1_seen == 0 )); then
      if probe_health_for_m1 "$health_body"; then
        m1_seen=1
        PHASE_M1_S=$((SECONDS - RESTART_T0))
        echo "M1: ${HEALTH_URL} OK at +${PHASE_M1_S}s"
      fi
    fi

    if probe_ready_for_deploy "$body_file"; then
      PHASE_M2_S=$((SECONDS - RESTART_T0))
      if (( m1_seen == 0 )); then
        PHASE_M1_S="$PHASE_M2_S"
        m1_seen=1
      fi
      rm -f -- "$body_file" "$health_body"
      echo "M2: ${READY_URL} deploy-ready at +${PHASE_M2_S}s"
      echo " Kookr systemd service restarted successfully"
      return 0
    fi
    if (( SECONDS - last_heartbeat >= 30 )); then
      phase_hint="$(ready_probe_phase_hint "$body_file")"
      echo "Still waiting for ${READY_URL} (${SECONDS}s elapsed of ${STARTUP_TIMEOUT_SECONDS}s; kookr.service active; ${phase_hint})"
      last_heartbeat=$SECONDS
    fi
  done

  rm -f -- "$body_file" "$health_body"
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

  # Post-restart relay drift nag (issue #1014) — prod:update rebuilds the relay
  # bundle, but the relay is an independently managed process. Warn when the
  # tracked relay predates the freshly built relay artifacts. Operators can opt
  # into restarting it as part of the deploy by setting KOOKR_RESTART_RELAY=1.
  check_relay_drift_after_restart
}

check_relay_drift_after_restart() {
  local relay_state_path="${KOOKR_DIR}/relay.state.json"
  local relay_drift_output=""
  local relay_drift_status=0

  [[ -f "$relay_state_path" ]] || return 0

  set +e
  relay_drift_output="$(
    APP_DIR="$APP_DIR" KOOKR_DIR="$KOOKR_DIR" node <<'NODE'
const { existsSync, readFileSync, statSync } = require('node:fs');
const { join, resolve } = require('node:path');

const appDir = resolve(process.env.APP_DIR ?? process.cwd());
const kookrDir = process.env.KOOKR_DIR;
const statePath = join(kookrDir, 'relay.state.json');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function timestampMs(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

const state = readJson(statePath);
if (!state || state.schemaVersion !== 'relay-lifecycle-state.v1') process.exit(0);
if (resolve(String(state.cwd ?? '')) !== appDir) process.exit(0);

const startedAtMs = timestampMs(state.startedAt);
if (!startedAtMs) process.exit(0);

const artifactPaths = [
  join(appDir, 'dist', 'relay', 'server.js'),
  join(appDir, 'dist', 'build-info.json'),
];
const artifactTimes = artifactPaths
  .filter((path) => existsSync(path))
  .map((path) => statSync(path).mtimeMs);

if (artifactTimes.length === 0) process.exit(0);

const newestArtifactMs = Math.max(...artifactTimes);
if (newestArtifactMs <= startedAtMs) process.exit(0);

console.log(JSON.stringify({
  pid: state.pid,
  startedAt: state.startedAt,
  artifactBuiltAt: new Date(newestArtifactMs).toISOString(),
  relayUrl: state.relayUrl,
}));
process.exit(3);
NODE
  )"
  relay_drift_status=$?
  set -e

  if [[ "$relay_drift_status" != "3" ]]; then
    return 0
  fi

  if [[ "${KOOKR_RESTART_RELAY:-}" == "1" ]]; then
    echo "Relay predates the current build; KOOKR_RESTART_RELAY=1 so restarting relay..."
    if KOOKR_DIR="$KOOKR_DIR" pnpm relay:restart; then
      return 0
    fi
    {
      echo "WARN: relay restart failed after deploy. The main server is live, but"
      echo "      the relay may still be serving stale code; run \`pnpm relay:restart\`."
    } >&2
    return 0
  fi

  {
    echo "WARN: relay process predates the current build and may be serving stale code."
    echo "      ${relay_drift_output}"
    echo "      Run \`pnpm relay:restart\` after deploy, or set KOOKR_RESTART_RELAY=1"
    echo "      to restart the relay automatically during \`pnpm prod:restart\`."
  } >&2
}

capture_predeploy_log_activity() {
  # Record when the OUTGOING server last logged, BEFORE we stop/restart it, so
  # the smoke suite can flag a multi-hour pre-boot silence — a wedged server
  # stops logging (the 07-25 incident went ~2h50m without output). Must run
  # before shutdown: a graceful SIGTERM writes "Shutting down…" which would
  # otherwise refresh the anchor to ~now and mask the silence. Source is
  # path-aware because the two deploy modes log to different places:
  #   - systemd: journald (the unit has no server.log redirect)
  #   - script:  $LOG_FILE (start_server redirects stdout there)
  # Left empty when the source is unavailable, so the continuity check skips
  # rather than guessing. node/journald give cross-platform epoch math (the GNU
  # and BSD coreutils flags for file mtime and date parsing diverge).
  local mode="${1:-script}"
  PREDEPLOY_LOG_MTIME_MS=""
  if [[ "$mode" == "systemd" ]]; then
    command -v journalctl >/dev/null 2>&1 || return 0
    local last_line epoch_s
    last_line="$(journalctl --user -u kookr.service -n 1 -o short-unix --no-pager 2>/dev/null | tail -n 1)" || true
    [[ -n "$last_line" ]] || return 0
    epoch_s="${last_line%% *}" # "1690000000.123456 host unit[pid]: msg" → field 1
    PREDEPLOY_LOG_MTIME_MS="$(
      node -e 'const s = parseFloat(process.argv[1]); process.stdout.write(Number.isFinite(s) ? String(Math.round(s * 1000)) : "");' "$epoch_s" 2>/dev/null || true
    )"
    return 0
  fi
  # node reads the mtime portably (the coreutils mtime flags differ across
  # GNU and BSD).
  [[ -f "$LOG_FILE" ]] || return 0
  PREDEPLOY_LOG_MTIME_MS="$(
    node -e 'try { process.stdout.write(String(require("node:fs").statSync(process.argv[1]).mtimeMs)); } catch { /* absent → empty */ }' "$LOG_FILE" 2>/dev/null || true
  )"
}

run_post_deploy_smoke() {
  # Post-deploy smoke suite (issue #1592) — bounded checks that the startup
  # liveness gate cannot see (health/ready/tasks latency, adapter version-probe
  # sanity, log continuity). Non-zero exit here fails the deploy command; the
  # server is already live, so this is an alarm for an operator, not a rollback.
  local mode="${1:-script}"
  if [[ "${KOOKR_POST_DEPLOY_SMOKE:-1}" != "1" ]]; then
    echo "Skipping post-deploy smoke suite (KOOKR_POST_DEPLOY_SMOKE=${KOOKR_POST_DEPLOY_SMOKE:-1})"
    return 0
  fi
  local script_dir tasks_url smoke_log smoke_log_temp status
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  # Derive the tasks URL from the (already port-correct) HEALTH_URL base rather
  # than letting the node side re-derive it from KOOKR_PORT: on the systemd path
  # PORT comes from the env file into a bash var that is NOT exported, so the
  # node subprocess could otherwise probe the default :4800 while health/ready
  # correctly target the unit's real port.
  tasks_url="${HEALTH_URL%/api/health}/api/tasks?limit=1"
  # Point version-probe at the right log source. Under systemd the server logs
  # to journald (not $LOG_FILE, which is stale/absent), so materialize the
  # unit's recent output — `-o cat` prints the raw MESSAGE, i.e. the same
  # `[startup] adapter=… version=…` lines the script path writes to server.log.
  smoke_log="$LOG_FILE"
  smoke_log_temp=""
  if [[ "$mode" == "systemd" ]]; then
    if command -v journalctl >/dev/null 2>&1; then
      smoke_log_temp="$(mktemp "${TMPDIR:-/tmp}/kookr-smoke-journal.XXXXXX")" || smoke_log_temp=""
      if [[ -n "$smoke_log_temp" ]]; then
        journalctl --user -u kookr.service -n 5000 -o cat --no-pager > "$smoke_log_temp" 2>/dev/null || true
        smoke_log="$smoke_log_temp"
      fi
    else
      # journald unreachable → point at a nonexistent file so version-probe
      # skips safely rather than reading a stale server.log.
      smoke_log="${KOOKR_DIR}/.prod-smoke-no-journald"
    fi
  fi
  echo "Running post-deploy smoke suite (scripts/prod-smoke.ts)..."
  status=0
  KOOKR_SMOKE_HEALTH_URL="$HEALTH_URL" \
  KOOKR_SMOKE_READY_URL="$READY_URL" \
  KOOKR_SMOKE_TASKS_URL="$tasks_url" \
  KOOKR_SMOKE_LOG_FILE="$smoke_log" \
  KOOKR_SMOKE_KOOKR_DIR="$KOOKR_DIR" \
  KOOKR_SMOKE_PREDEPLOY_LOG_MTIME_MS="${PREDEPLOY_LOG_MTIME_MS:-}" \
    node --import tsx "${script_dir}/prod-smoke.ts" || status=$?
  [[ -n "$smoke_log_temp" ]] && rm -f "$smoke_log_temp"
  return "$status"
}

if [[ "${KOOKR_PROD_RESTART_TEST_ONLY:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

# Phase timing anchors (RFC fast-prod-restart R5 / R12).
RESTART_T0=$SECONDS
PHASE_PORT_FREE_S=""
PHASE_M1_S=""
PHASE_M2_S=""
PHASE_SMOKE_S=""

if systemd_unit_active; then
  load_systemd_env_file
  configure_port_derived_values
  capture_predeploy_log_activity systemd
  # Record planned-restart intent before the API goes dark (issue #2410).
  write_restart_intent
  # Drain before systemctl restart so launches in the pre-kill window get 503
  # rather than ECONNREFUSED while the old unit is still listening (#1971).
  enter_drain_before_stop
  restart_systemd_unit
  # systemctl restart is stop+start; port free is approximate at this point
  # (measurement caveat for apiBlackoutSeconds on the systemd path, #1972).
  PHASE_PORT_FREE_S=$((SECONDS - RESTART_T0))
  wait_for_systemd_health
  # API reachable again: clear the marker. Cleared here (after the readiness
  # gate) rather than after the smoke suite on purpose — the marker only exists
  # to explain an UNREACHABLE API to the CLI, and the API is reachable now, so a
  # later smoke failure is a deploy-quality signal, not an outage the marker
  # should keep flagging. A failed readiness gate exits the script before this
  # line, leaving the marker to age into the "failed deploy" reading.
  clear_restart_intent
  run_post_restart_checks
  run_post_deploy_smoke systemd
  PHASE_SMOKE_S=$((SECONDS - RESTART_T0))
  print_restart_phase_timings \
    "${PHASE_PORT_FREE_S:-0}" \
    "${PHASE_M1_S:-${PHASE_PORT_FREE_S:-0}}" \
    "${PHASE_M2_S:-${PHASE_M1_S:-0}}" \
    "${PHASE_SMOKE_S:-${PHASE_M2_S:-0}}" \
    "$((SECONDS - RESTART_T0))"
  write_last_restart_metrics \
    "${PHASE_PORT_FREE_S:-0}" \
    "${PHASE_M1_S:-${PHASE_PORT_FREE_S:-0}}" \
    "${PHASE_M2_S:-${PHASE_M1_S:-0}}" \
    "${PHASE_SMOKE_S:-${PHASE_M2_S:-0}}" \
    "$((SECONDS - RESTART_T0))" \
    "systemd"
  exit 0
fi

capture_predeploy_log_activity script
# Drain before SIGTERM so warm-restart launches hit 503/draining while the old
# process is still up, not only ECONNREFUSED after kill (#1971). Drain state is
# in-memory and cleared by process exit — no post-restart resume needed.
# Record planned-restart intent before the API goes dark (issue #2410).
write_restart_intent
enter_drain_before_stop
stop_existing_server
PHASE_PORT_FREE_S=$((SECONDS - RESTART_T0))
echo "Port ${PORT} free at +${PHASE_PORT_FREE_S}s"
start_server
wait_for_health
# API reachable again: clear the marker (see the systemd path above for why this
# is done at the readiness gate, not after smoke). A failed wait_for_health exits
# the script first, leaving the marker to age into the "failed deploy" reading.
clear_restart_intent
run_post_restart_checks
run_post_deploy_smoke script
PHASE_SMOKE_S=$((SECONDS - RESTART_T0))
print_restart_phase_timings \
  "${PHASE_PORT_FREE_S:-0}" \
  "${PHASE_M1_S:-${PHASE_PORT_FREE_S:-0}}" \
  "${PHASE_M2_S:-${PHASE_M1_S:-0}}" \
  "${PHASE_SMOKE_S:-${PHASE_M2_S:-0}}" \
  "$((SECONDS - RESTART_T0))"
write_last_restart_metrics \
  "${PHASE_PORT_FREE_S:-0}" \
  "${PHASE_M1_S:-${PHASE_PORT_FREE_S:-0}}" \
  "${PHASE_M2_S:-${PHASE_M1_S:-0}}" \
  "${PHASE_SMOKE_S:-${PHASE_M2_S:-0}}" \
  "$((SECONDS - RESTART_T0))" \
  "script"

