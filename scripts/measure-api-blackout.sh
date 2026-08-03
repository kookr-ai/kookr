#!/usr/bin/env bash
# measure-api-blackout.sh — external 10ms-interval probe of API blackout duration.
#
# Independent of scripts/prod-restart.sh's built-in apiBlackoutSeconds metric.
# Operators run this in one terminal while restarting in another to verify the
# <1s ideal / <5s SLO claim with a high-frequency curl loop (KB literature
# measures downtime at ~10ms intervals).
#
# Measurement-only: do not gate CI on absolute times (machine-dependent).
#
# Usage:
#   scripts/measure-api-blackout.sh
#   scripts/measure-api-blackout.sh --url http://127.0.0.1:4800/api/health
#   scripts/measure-api-blackout.sh --interval-ms 10 --once
#   # terminal A:  scripts/measure-api-blackout.sh --once
#   # terminal B:  pnpm prod:restart
#
# See: docs/reference/api-blackout-probe.md

set -euo pipefail

URL=""
INTERVAL_MS=10
TIMEOUT_S=0
MAX_EVENTS=0
ONCE=0
# Require this many consecutive failed probes before counting DOWN. Debounces
# single slow /api/health samples under load without hiding real blackouts
# (connection refused fails fast for every sample in a true outage).
FAIL_THRESHOLD=2

usage() {
  cat <<'EOF'
Usage: scripts/measure-api-blackout.sh [options]

Measure how long GET /api/health is unreachable during a restart (API blackout).
Polls at a fixed interval (default 10ms), detects UP→DOWN→UP transitions, and
prints each blackout duration in milliseconds.

Options:
  --url URL           Health URL to probe
                      (default: http://127.0.0.1:${KOOKR_PORT:-4800}/api/health)
  --interval-ms N     Probe interval in milliseconds (default: 10)
  --timeout-s N       Stop after N seconds of wall time (default: 0 = until Ctrl+C)
  --max-events N      Stop after N blackout events (default: 0 = unlimited)
  --once              Equivalent to --max-events 1 (exit after first blackout)
  --fail-threshold N  Consecutive failed probes before counting DOWN (default: 2)
  -h, --help          Show this help and exit

Typical workflow (two terminals):

  # Terminal A — start the probe first
  scripts/measure-api-blackout.sh --once

  # Terminal B — restart production-style instance
  pnpm prod:restart

Output lines (machine-readable prefix):

  blackout_ms=<integer>  down_at_ms=<epoch_ms>  up_at_ms=<epoch_ms>

Targets (from operator SLO; not CI gates):
  ideal  < 1000 ms
  max    < 5000 ms

Notes:
  - Measurement-only. Absolute times vary by host load, speech cold-start path,
    and whether the systemd unit is active. Do not fail CI on blackout_ms.
  - Complements prod-restart's own apiBlackoutSeconds printout and
    GET /api/deploy/status → lastRestart.apiBlackoutSeconds (issue #1972).
  - Probes liveness only (/api/health). Drain mode still returns 200 while the
    process is up; blackout is the window when the listener is gone.

Environment:
  KOOKR_PORT   Used when --url is omitted (default 4800)
EOF
}

die() {
  echo "measure-api-blackout: $*" >&2
  exit 2
}

# Millisecond epoch. Prefer node (always present in this repo), then python3.
# Avoid GNU-only date +%s%3N for macOS portability.
now_ms() {
  if command -v node >/dev/null 2>&1; then
    node -e 'process.stdout.write(String(Date.now()))'
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time() * 1000))'
  else
    # Second resolution only — still reports a number, just coarser.
    echo $(($(date +%s) * 1000))
  fi
}

# Sleep INTERVAL_MS without requiring bash 4 or GNU sleep features beyond
# fractional seconds (supported on Linux GNU coreutils and modern macOS).
sleep_interval() {
  local ms="$1"
  if [ "$ms" -le 0 ]; then
    return 0
  fi
  # awk formats seconds with a leading 0 when needed (e.g. 0.010).
  local sec
  sec="$(awk -v ms="$ms" 'BEGIN { printf "%.3f", ms / 1000 }')"
  sleep "$sec"
}

# Probe once. Exit 0 when the health endpoint is reachable with HTTP 2xx/3xx
# under curl -f; non-zero when connection fails, times out, or HTTP is 4xx/5xx.
probe_up() {
  # Bounded so a hung server cannot stall the loop forever. Keep generous
  # enough that a single slow health sample under load is not a false DOWN
  # (true blackouts fail with connection-refused in milliseconds).
  curl -fsS \
    --connect-timeout 0.2 \
    --max-time 1.0 \
    -o /dev/null \
    "$URL" 2>/dev/null
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --url)
      [ "$#" -ge 2 ] || die "--url requires a value"
      URL="$2"
      shift 2
      ;;
    --interval-ms)
      [ "$#" -ge 2 ] || die "--interval-ms requires a value"
      INTERVAL_MS="$2"
      shift 2
      ;;
    --timeout-s)
      [ "$#" -ge 2 ] || die "--timeout-s requires a value"
      TIMEOUT_S="$2"
      shift 2
      ;;
    --max-events)
      [ "$#" -ge 2 ] || die "--max-events requires a value"
      MAX_EVENTS="$2"
      shift 2
      ;;
    --once)
      ONCE=1
      shift
      ;;
    --fail-threshold)
      [ "$#" -ge 2 ] || die "--fail-threshold requires a value"
      FAIL_THRESHOLD="$2"
      shift 2
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

if [ "$ONCE" -eq 1 ]; then
  MAX_EVENTS=1
fi

case "$INTERVAL_MS" in
  '' | *[!0-9]*) die "--interval-ms must be a non-negative integer" ;;
esac
case "$TIMEOUT_S" in
  '' | *[!0-9]*) die "--timeout-s must be a non-negative integer" ;;
esac
case "$MAX_EVENTS" in
  '' | *[!0-9]*) die "--max-events must be a non-negative integer" ;;
esac
case "$FAIL_THRESHOLD" in
  '' | *[!0-9]*) die "--fail-threshold must be a positive integer" ;;
esac
if [ "$FAIL_THRESHOLD" -lt 1 ]; then
  die "--fail-threshold must be >= 1"
fi

if [ -z "$URL" ]; then
  URL="http://127.0.0.1:${KOOKR_PORT:-4800}/api/health"
fi

if ! command -v curl >/dev/null 2>&1; then
  die "curl is required"
fi

started_ms="$(now_ms)"
deadline_ms=0
if [ "$TIMEOUT_S" -gt 0 ]; then
  deadline_ms=$((started_ms + TIMEOUT_S * 1000))
fi

echo "# measure-api-blackout: probing ${URL} every ${INTERVAL_MS}ms" >&2
echo "# targets: ideal <1000ms, max <5000ms (not CI gates)" >&2
echo "# start a restart in another terminal (e.g. pnpm prod:restart)" >&2

# state: "up" | "down" | "unknown"
state="unknown"
down_at_ms=0
events=0
samples=0
consec_fail=0

while true; do
  if [ "$deadline_ms" -gt 0 ]; then
    now="$(now_ms)"
    if [ "$now" -ge "$deadline_ms" ]; then
      echo "# timeout after ${TIMEOUT_S}s (${events} blackout event(s), ${samples} samples)" >&2
      if [ "$events" -eq 0 ]; then
        exit 1
      fi
      exit 0
    fi
  fi

  if probe_up; then
    consec_fail=0
    sample_up=1
  else
    consec_fail=$((consec_fail + 1))
    sample_up=0
  fi
  samples=$((samples + 1))
  ts="$(now_ms)"

  # Debounced "up": any success clears the fail streak and counts as up.
  # Debounced "down": only after FAIL_THRESHOLD consecutive failures.
  if [ "$sample_up" -eq 1 ]; then
    if [ "$state" = "down" ]; then
      blackout_ms=$((ts - down_at_ms))
      if [ "$blackout_ms" -lt 0 ]; then
        blackout_ms=0
      fi
      printf 'blackout_ms=%s  down_at_ms=%s  up_at_ms=%s\n' \
        "$blackout_ms" "$down_at_ms" "$ts"
      if [ "$blackout_ms" -gt 5000 ]; then
        echo "# WARN: blackout ${blackout_ms}ms exceeds 5s SLO (ideal <1s)" >&2
      elif [ "$blackout_ms" -gt 1000 ]; then
        echo "# note: blackout ${blackout_ms}ms above ideal <1s (still under 5s max)" >&2
      fi
      events=$((events + 1))
      if [ "$MAX_EVENTS" -gt 0 ] && [ "$events" -ge "$MAX_EVENTS" ]; then
        echo "# done: ${events} blackout event(s)" >&2
        exit 0
      fi
    fi
    state="up"
  elif [ "$consec_fail" -ge "$FAIL_THRESHOLD" ]; then
    if [ "$state" != "down" ]; then
      down_at_ms="$ts"
      if [ "$state" = "up" ]; then
        echo "# DOWN at ${down_at_ms} (was up)" >&2
      else
        echo "# started while DOWN at ${down_at_ms}" >&2
      fi
    fi
    state="down"
  fi

  sleep_interval "$INTERVAL_MS"
done
