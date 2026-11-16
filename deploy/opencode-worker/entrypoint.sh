#!/bin/bash
# opencode-worker entrypoint: `opencode serve` (loopback, password) + the A2A wrapper on :8000.
# Secrets are read from 0600 files in /run/secrets, never from the container environment (so `docker inspect`
# does not show them). They are handed to the two child processes through their own process env.
# Exit codes: 10 opencode never became healthy, 11 opencode exited, 12 A2A wrapper exited,
#             13 missing, empty or group/other-readable secret, 14 hook self-test failed, 15 workspace missing;
#             0 on a SIGTERM/SIGINT stop (also during startup).
#             The container exits when EITHER child dies. Secret charset: [A-Za-z0-9._~+-].
set -u
log() { echo "[entrypoint] $*" >&2; }
SECRETS_DIR="${SECRETS_DIR:-/run/secrets}"
for s in opencode_password a2a_token; do
  [ -r "$SECRETS_DIR/$s" ] || { log "missing secret file $SECRETS_DIR/$s"; exit 13; }
  # The files must be 0600 (or stricter): a group/other-readable secret was written by something careless.
  case "$(stat -L -c %a "$SECRETS_DIR/$s")" in *00) ;; *) log "secret file $SECRETS_DIR/$s is readable by group/other (want 0600)"; exit 13;; esac
done
OC_PW="$(cat "$SECRETS_DIR/opencode_password")"
A2A_TOKEN="$(cat "$SECRETS_DIR/a2a_token")"
[ -n "$OC_PW" ] && [ -n "$A2A_TOKEN" ] || { log "empty secret"; exit 13; }
case "$A2A_TOKEN$OC_PW" in *[!A-Za-z0-9._~+-]*) log "secrets must match [A-Za-z0-9._~+-]"; exit 13;; esac

WORKSPACE="${WORKSPACE:-/work}"
log "starting (workspace=$WORKSPACE uid=$(id -u))"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"

# Hook self-test: every executable the hook commands need must exist and be executable, else the deliverable gate
# would silently pass (a missing command exits 127, a non-executable one 126, and only exit 2 blocks).
MANIFEST="${HOOK_MANIFEST:-/kookr-hooks/MANIFEST}"
if [ -f "$MANIFEST" ]; then
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    [ -f "$p" ] && [ -x "$p" ] || { log "hook self-test: $p missing or not executable"; exit 14; }
  done < "$MANIFEST"
  log "hook self-test ok ($(grep -c . "$MANIFEST") entries)"
fi

# /cfg (read-only: opencode.json, plugins/, AGENTS.md) is copied to a writable dir: opencode installs
# @opencode-ai/plugin into its config dir at boot unless the baked seed is linked.
if [ -d /opt/seed/node_modules ]; then
  mkdir -p "$XDG_CONFIG_HOME/opencode"
  ln -sfn /opt/seed/node_modules "$XDG_CONFIG_HOME/opencode/node_modules"
  cp /opt/seed/package.json /opt/seed/package-lock.json /opt/seed/.gitignore "$XDG_CONFIG_HOME/opencode/" 2>/dev/null || true
fi
if [ -d /cfg ]; then
  mkdir -p "$HOME/cfg" && cp -r /cfg/. "$HOME/cfg/"
  if [ -d /opt/seed/node_modules ] && [ ! -e "$HOME/cfg/node_modules" ]; then
    ln -s /opt/seed/node_modules "$HOME/cfg/node_modules"
    cp /opt/seed/package.json /opt/seed/package-lock.json "$HOME/cfg/" 2>/dev/null || true
  fi
  export OPENCODE_CONFIG_DIR="$HOME/cfg"
  [ -f "$HOME/cfg/opencode.json" ] && export OPENCODE_CONFIG="$HOME/cfg/opencode.json"
fi
cd "$WORKSPACE" 2>/dev/null || { log "workspace $WORKSPACE missing"; exit 15; }

# Each child's output goes through a FIFO to a `sed` prefixer whose pid we keep, so the last lines can be drained
# before the container exits (a `> >(sed ...)` process substitution cannot be waited on).
LOGDIR="$(mktemp -d /tmp/worker-logs.XXXXXX)" || { log "cannot create the log FIFO dir"; exit 10; }
mkfifo "$LOGDIR/opencode" "$LOGDIR/a2a"
sed -u 's/^/[opencode] /' < "$LOGDIR/opencode" >&2 & OC_LOG=$!
sed -u 's/^/[a2a] /' < "$LOGDIR/a2a" >&2 & A2A_LOG=$!
OC=""; A2A=""
# Stop every child, wait (bounded, ~2 s) for the prefixers to flush the last lines, then exit with $1.
finish() {
  # shellcheck disable=SC2086 # unset pids expand to nothing
  [ -n "$OC$A2A" ] && kill $OC $A2A 2>/dev/null
  # A child that never started leaves its prefixer blocked in open(); a read-write open (never blocks on Linux)
  # releases it, and closing it gives the prefixer EOF.
  [ -z "$OC" ] && : 1<> "$LOGDIR/opencode"
  [ -z "$A2A" ] && : 1<> "$LOGDIR/a2a"
  for _ in $(seq 1 20); do
    kill -0 "$OC_LOG" 2>/dev/null || kill -0 "$A2A_LOG" 2>/dev/null || break
    sleep 0.1
  done
  kill "$OC_LOG" "$A2A_LOG" 2>/dev/null
  exit "$1"
}
# Startup phase: a stop request now is a clean stop, not a child death (it would otherwise exit 10/11/143).
trap 'log "stopped by signal during startup"; finish 0' TERM INT

export OPENCODE_SERVER_PASSWORD="$OC_PW"
opencode serve --hostname 127.0.0.1 --port 4096 > "$LOGDIR/opencode" 2>&1 &
OC=$!
# The password goes to curl on stdin (-K -), never in its argv (visible in `ps` inside the container).
i=0
until printf 'user = "opencode:%s"\n' "$OC_PW" | curl -fsS --max-time 2 -K - http://127.0.0.1:4096/global/health >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 120 ]; then log "opencode serve not healthy after 60 s"; finish 10; fi
  kill -0 "$OC" 2>/dev/null || { log "opencode serve exited during startup"; finish 11; }
  sleep 0.5
done

A2A_STATIC_AUTH_CREDENTIALS="[{\"scheme\":\"bearer\",\"token\":\"$A2A_TOKEN\",\"principal\":\"kookr\"}]" \
OPENCODE_BASE_URL=http://127.0.0.1:4096 OPENCODE_AUTH_PASSWORD="$OC_PW" \
OPENCODE_WORKSPACE_ROOT="$WORKSPACE" \
A2A_TASK_STORE_DATABASE_URL="sqlite+aiosqlite:////data/a2a-tasks.db" \
A2A_HOST=0.0.0.0 A2A_PORT=8000 A2A_PUBLIC_URL="${A2A_PUBLIC_URL:-http://127.0.0.1:8000}" \
opencode-a2a serve > "$LOGDIR/a2a" 2>&1 &
A2A=$!
STOPPING=0
trap 'STOPPING=1; kill "$OC" "$A2A" 2>/dev/null' TERM INT
# A signal interrupts `wait -n` (status > 128): loop until a child actually ended or we are stopping.
while :; do
  wait -n "$OC" "$A2A"; st=$?
  [ "$STOPPING" = 1 ] && { wait "$OC" "$A2A" 2>/dev/null; log "stopped by signal"; finish 0; }
  [ "$st" -le 128 ] || [ "$STOPPING" = 1 ] && break
  kill -0 "$OC" 2>/dev/null && kill -0 "$A2A" 2>/dev/null || break
done
if ! kill -0 "$OC" 2>/dev/null; then code=11; else code=12; fi
log "child exited (opencode=$([ $code = 11 ] && echo down || echo up) a2a=$([ $code = 12 ] && echo down || echo up)); stopping container"
finish "$code"
