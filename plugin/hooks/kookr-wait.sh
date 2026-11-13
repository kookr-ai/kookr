#!/usr/bin/env bash
# kookr-wait: wait for a background job WITHOUT `pgrep -f`.
#
# `while pgrep -f "<pattern>"; do sleep 5; done` matches its own shell (that
# shell's command line contains the pattern), so it never exits. This helper
# waits on something that cannot match itself: a PID or an exit-marker file.
#
# Usage:
#   kookr-wait.sh --pid PID  [--timeout SECS] [--interval SECS]
#   kookr-wait.sh --file PATH [--timeout SECS] [--interval SECS]
#
# --pid   waits until `kill -0 PID` fails (the process is gone).
# --file  waits until PATH exists; if it is non-empty its first line is printed
#         (convention: the job writes its exit code there, see below).
#
# Exit codes: 0 = finished, 124 = timed out, 2 = bad usage.
# Default timeout 600s, interval 5s. A timeout is always stated, never infinite.
#
# Exit-marker convention for a job you start yourself:
#   LOG=$(mktemp); ( pnpm test >"$LOG" 2>&1; echo $? >"$LOG.exit" ) &
#   kookr-wait.sh --file "$LOG.exit" --timeout 900   # prints the exit code
set -u

mode=""; target=""; timeout=600; interval=5
while [ $# -gt 0 ]; do
  case "$1" in
    --pid|--file) mode="${1#--}"; target="${2:-}"; shift 2 || break ;;
    --timeout) timeout="${2:-}"; shift 2 || break ;;
    --interval) interval="${2:-}"; shift 2 || break ;;
    *) echo "kookr-wait: unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$timeout$interval" in *[!0-9]*|'') echo "kookr-wait: --timeout/--interval must be whole seconds" >&2; exit 2 ;; esac
if [ -z "$mode" ] || [ -z "$target" ]; then
  echo "usage: kookr-wait.sh (--pid PID | --file PATH) [--timeout SECS] [--interval SECS]" >&2
  exit 2
fi
if [ "$mode" = pid ]; then
  case "$target" in *[!0-9]*) echo "kookr-wait: --pid needs a number" >&2; exit 2 ;; esac
fi
[ "$interval" -gt 0 ] || interval=1

elapsed=0
while :; do
  if [ "$mode" = pid ]; then
    kill -0 "$target" 2>/dev/null || exit 0
  elif [ -e "$target" ]; then
    [ -s "$target" ] && head -n1 "$target"
    exit 0
  fi
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "kookr-wait: timed out after ${timeout}s waiting on $mode $target" >&2
    exit 124
  fi
  sleep "$interval"
  elapsed=$((elapsed + interval))
done
