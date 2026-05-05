#!/usr/bin/env bash
# Rollback cleanup for dtach-managed agent sessions.
#
# If Kookr has been reverted to the tmux backend, dtach master processes
# and their sockets are orphaned — Kookr no longer knows how to speak to
# them. This script kills every dtach master owned by the current user
# (discovered via the per-instance manifests) with a graceful TERM → wait →
# KILL escalation, then removes the socket tree.
#
# Usage:
#   scripts/rollback-dtach.sh            # clean all instances owned by $USER
#   KOOKR_DTACH_SOCK_DIR=/tmp/foo scripts/rollback-dtach.sh  # override
#
# Idempotent. Safe to run when no orphans exist.
set -euo pipefail

ROOT="${KOOKR_DTACH_SOCK_DIR:-/tmp/kookr-dtach/$(id -u)}"

if [ ! -d "$ROOT" ]; then
  echo "[rollback-dtach] no socket dir at $ROOT; nothing to do"
  exit 0
fi

killed=0
survived=0

# Walk per-instance subdirs. Each has its own manifest.json listing pids.
for instance_dir in "$ROOT"/*/; do
  [ -d "$instance_dir" ] || continue
  manifest="$instance_dir/manifest.json"
  if [ -f "$manifest" ]; then
    # Send TERM to every 'active' pid in this instance's manifest.
    pids=$(jq -r '.entries[]? | select(.status == "active") | .pid' "$manifest" 2>/dev/null || echo "")
    for pid in $pids; do
      [ "$pid" -gt 0 ] 2>/dev/null || continue
      if kill -TERM "$pid" 2>/dev/null; then
        echo "[rollback-dtach] SIGTERM sent to pid $pid"
      fi
    done
    # Wait up to 10s per pid for graceful shutdown.
    for pid in $pids; do
      [ "$pid" -gt 0 ] 2>/dev/null || continue
      for _ in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      # Escalate.
      if kill -0 "$pid" 2>/dev/null; then
        kill -KILL "$pid" 2>/dev/null || true
        sleep 0.5
        if kill -0 "$pid" 2>/dev/null; then
          echo "[rollback-dtach] WARN: pid $pid survived SIGKILL" >&2
          survived=$((survived + 1))
        else
          killed=$((killed + 1))
        fi
      else
        killed=$((killed + 1))
      fi
    done
  fi
  # Remove the instance dir (sockets + manifest).
  rm -rf "$instance_dir"
done

# Fallback: any dtach process whose cmdline still references this root
# (manifest was corrupted or never written) — catch it by cmdline match.
if command -v pkill >/dev/null 2>&1; then
  pkill -f "dtach -n $ROOT" 2>/dev/null || true
fi

# Remove the root if empty.
rmdir "$ROOT" 2>/dev/null || true

echo "[rollback-dtach] killed: $killed, survived: $survived"
[ "$survived" -eq 0 ]
