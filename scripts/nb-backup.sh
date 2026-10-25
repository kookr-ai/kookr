#!/usr/bin/env bash
# Daily backup for the Agent Notebook store (~/.kookr/notebooks by default).
#
# Mirrors the knowledge-bases auto-backup pattern (~/.claude/scripts/auto-backup.sh),
# with one deliberate difference: the Agent Notebook commits on EVERY mutation
# (see bin/nb.js), so the daily job's job is to PUSH that accumulated history —
# it must push even when the working tree is clean. It also commits any
# straggler changes first (defensive, in case per-change auto-commit was off).
#
# Designed for cron (daily) and manual invocation. Idempotent: a no-op when
# there is nothing new to commit and nothing unpushed.
#
# Env:
#   NB_DIR   notebook repo (default ~/.kookr/notebooks)
# Logs:
#   $NB_DIR/.nb-backup.log  (rotated by size)
# Lock:
#   /tmp/kookr-nb-backup.lock  (prevents cron + manual concurrent runs)

set -uo pipefail

NB_DIR="${NB_DIR:-${HOME}/.kookr/notebooks}"
LOG_FILE="${NB_DIR}/.nb-backup.log"
LOCK_FILE="/tmp/kookr-nb-backup.lock"
TIMESTAMP="$(date -Iseconds)"
DATESTAMP="$(date -I)"

log() { printf "[%s] %s\n" "$TIMESTAMP" "$*" >> "$LOG_FILE" 2>/dev/null || true; }

if [ ! -d "${NB_DIR}/.git" ]; then
    echo "nb-backup: ${NB_DIR} is not a git repo — nothing to back up" >&2
    exit 0
fi

mkdir -p "$NB_DIR" 2>/dev/null || true

# Rotate the log if >1 MB so it never grows unbounded. `wc -c` is portable
# (BSD + GNU); the GNU-only byte-size flag for stat is deliberately avoided.
if [ -f "$LOG_FILE" ] && [ "$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)" -gt 1048576 ]; then
    mv "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null || true
fi

# Single-instance lock (non-blocking; skip if another run holds it). `flock` is
# util-linux-only; where it is absent (e.g. macOS) run WITHOUT the lock rather
# than treating the missing command as "already locked" and no-opping forever.
if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        log "another nb-backup run is in progress; skipping"
        exit 0
    fi
fi

cd "$NB_DIR" || { log "cd failed: $NB_DIR"; exit 1; }

# Determine the branch to push (defaults to the checked-out branch).
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"

# 1) Commit any straggler changes (per-change auto-commit may be disabled).
git add -A 2>>"$LOG_FILE"
if ! git diff --cached --quiet; then
    if git commit --quiet -m "nb-backup ${DATESTAMP}" 2>>"$LOG_FILE"; then
        log "committed straggler changes"
    else
        log "COMMIT FAILED — see log"
    fi
fi

# 2) Push. Unlike the KB backup, push even when nothing was committed this run:
#    per-change commits accumulate between daily pushes. No --force; a rejected
#    push means someone pushed manually — log and bail for manual resolution.
if [ -z "$(git remote 2>/dev/null)" ]; then
    log "no git remote configured — commits retained locally, nothing pushed"
    exit 0
fi

if git push --quiet origin "$BRANCH" 2>>"$LOG_FILE"; then
    log "pushed ${BRANCH} OK"
else
    log "PUSH FAILED — local commits retained, will retry next run"
    exit 1
fi
