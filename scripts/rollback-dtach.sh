#!/usr/bin/env bash
# Rollback cleanup for dtach-managed agent sessions.
#
# If Kookr has been reverted to the tmux backend, dtach master processes
# and their sockets are orphaned — Kookr no longer knows how to speak to
# them. This script kills every dtach master owned by the current user
# (discovered via the per-instance manifests) with a graceful TERM → wait →
# KILL escalation, then removes the socket tree.
#
# The sweep is best-effort and continues past a stuck instance rather than
# aborting mid-run. A live dtach-backed Kookr server re-creates and
# repopulates its instance dir on its next write (immediate for manifest
# updates, within one ring-flush tick — ~2s — for scrollback snapshots; see
# #3042), so `rm -rf` can lose a race against the writer and fail with
# ENOTEMPTY. When that happens the script retries the removal a bounded
# number of times, and if the tree keeps refilling it records the instance
# and moves on to the others instead of aborting the whole sweep (issue
# #3043) — aborting on the first failure would leave every later instance's
# masters alive with no report.
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
# Instances whose dir could not be removed (still being written to).
not_removed=()

# Remove an instance dir, retrying a bounded number of times to ride out a
# live writer re-creating it. Returns 0 if the dir is gone, 1 otherwise.
remove_instance_dir() {
  local dir="$1"
  for _ in 1 2 3 4 5; do
    # `rm -rf` may return non-zero (ENOTEMPTY) if a child reappears between
    # its unlink pass and the final rmdir; the existence check is the real
    # postcondition. Both are guarded by `if`, so `set -e` won't abort here.
    if rm -rf "$dir" 2>/dev/null && [ ! -e "$dir" ]; then
      return 0
    fi
    sleep 0.2
  done
  [ ! -e "$dir" ]
}

# Walk per-instance subdirs. Each has its own manifest.json listing pids.
for instance_dir in "$ROOT"/*/; do
  [ -d "$instance_dir" ] || continue
  manifest="$instance_dir/manifest.json"
  if [ -f "$manifest" ]; then
    # TERM every master this instance's manifest lists. Terminated sessions
    # are dropped from the manifest, so every remaining entry — 'active',
    # 'pending', or 'recovered' — names a master that may still be running the
    # ring-flush timer that repopulates the dir (issue #3043). Killing all
    # entries rather than an 'active'-only allowlist also covers 'pending' and
    # 'recovered' and stays correct if a new live status is ever added. The
    # `[ "$pid" -gt 0 ]` guard below skips the sentinel pid -1 that an
    # unspawned 'pending' entry or a PID-less 'recovered' entry (e.g. macOS
    # without /proc) carries, so it never reaches `kill -TERM -1` — which
    # would signal every process the user owns. Masters skipped that way are
    # still caught by the cmdline pkill fallback after the loop.
    pids=$(jq -r '.entries[]? | .pid' "$manifest" 2>/dev/null || echo "")
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
  # Remove the instance dir (sockets + manifest). Survive a failure for one
  # instance and keep sweeping the rest (issue #3043).
  if ! remove_instance_dir "$instance_dir"; then
    echo "[rollback-dtach] WARN: could not remove $instance_dir (a live server may be re-creating it)" >&2
    not_removed+=("$instance_dir")
  fi
done

# Fallback: any dtach process whose cmdline still references this root
# (manifest was corrupted or never written) — catch it by cmdline match.
if command -v pkill >/dev/null 2>&1; then
  pkill -f "dtach -n $ROOT" 2>/dev/null || true
fi

# Remove the root if empty.
rmdir "$ROOT" 2>/dev/null || true

echo "[rollback-dtach] killed: $killed, survived: $survived"
if [ "${#not_removed[@]}" -gt 0 ]; then
  echo "[rollback-dtach] not removed (${#not_removed[@]}):" >&2
  for dir in "${not_removed[@]}"; do
    echo "[rollback-dtach]   $dir" >&2
  done
fi

# Postcondition: every master killed and every instance dir removed.
[ "$survived" -eq 0 ] && [ "${#not_removed[@]}" -eq 0 ]
