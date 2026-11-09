#!/bin/bash
# opencode-worker entrypoint: `opencode serve` (loopback, password) + the A2A wrapper on :8000.
# Secrets are read from 0600 files in /run/secrets, never from the container environment (so `docker inspect`
# does not show them). They are handed to the two child processes through their own process env.
# Exit codes: 10 opencode never became healthy, 11 opencode exited, 12 A2A wrapper exited,
#             13 missing secret, 14 hook self-test failed; 0 on a clean SIGTERM stop.
#             The container exits when EITHER child dies. Secret charset: [A-Za-z0-9._~+-].
set -u
log() { echo "[entrypoint] $*" >&2; }
SECRETS_DIR="${SECRETS_DIR:-/run/secrets}"
for s in opencode_password a2a_token; do
  [ -r "$SECRETS_DIR/$s" ] || { log "missing secret file $SECRETS_DIR/$s"; exit 13; }
done
OC_PW="$(cat "$SECRETS_DIR/opencode_password")"
A2A_TOKEN="$(cat "$SECRETS_DIR/a2a_token")"
[ -n "$OC_PW" ] && [ -n "$A2A_TOKEN" ] || { log "empty secret"; exit 13; }
case "$A2A_TOKEN$OC_PW" in *[!A-Za-z0-9._~+-]*) log "secrets must match [A-Za-z0-9._~+-]"; exit 13;; esac

WORKSPACE="${WORKSPACE:-/work}"
log "starting (workspace=$WORKSPACE uid=$(id -u))"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"

# Hook self-test: every executable the hook commands need must exist, else the deliverable gate
# would silently pass (a missing command exits 127, and only exit 2 blocks).
MANIFEST="${HOOK_MANIFEST:-/kookr-hooks/MANIFEST}"
if [ -f "$MANIFEST" ]; then
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    [ -r "$p" ] || { log "hook self-test: $p missing or unreadable"; exit 14; }
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
cd "$WORKSPACE" || { log "workspace $WORKSPACE missing"; exit 13; }

export OPENCODE_SERVER_PASSWORD="$OC_PW"
opencode serve --hostname 127.0.0.1 --port 4096 > >(sed -u 's/^/[opencode] /' >&2) 2>&1 &
OC=$!
i=0
until curl -fsS --max-time 2 -u "opencode:$OC_PW" http://127.0.0.1:4096/global/health >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 120 ]; then log "opencode serve not healthy after 60 s"; kill "$OC" 2>/dev/null; exit 10; fi
  kill -0 "$OC" 2>/dev/null || { log "opencode serve exited during startup"; exit 11; }
  sleep 0.5
done

A2A_STATIC_AUTH_CREDENTIALS="[{\"scheme\":\"bearer\",\"token\":\"$A2A_TOKEN\",\"principal\":\"kookr\"}]" \
OPENCODE_BASE_URL=http://127.0.0.1:4096 OPENCODE_AUTH_PASSWORD="$OC_PW" \
OPENCODE_WORKSPACE_ROOT="$WORKSPACE" \
A2A_TASK_STORE_DATABASE_URL="sqlite+aiosqlite:////data/a2a-tasks.db" \
A2A_HOST=0.0.0.0 A2A_PORT=8000 A2A_PUBLIC_URL="${A2A_PUBLIC_URL:-http://127.0.0.1:8000}" \
opencode-a2a serve > >(sed -u 's/^/[a2a] /' >&2) 2>&1 &
A2A=$!
STOPPING=0
trap 'STOPPING=1; kill "$OC" "$A2A" 2>/dev/null' TERM INT
# A signal interrupts `wait -n` (status > 128): loop until a child actually ended or we are stopping.
while :; do
  wait -n "$OC" "$A2A"; st=$?
  [ "$STOPPING" = 1 ] && { wait "$OC" "$A2A" 2>/dev/null; log "stopped by signal"; exit 0; }
  [ "$st" -le 128 ] || [ "$STOPPING" = 1 ] && break
  kill -0 "$OC" 2>/dev/null && kill -0 "$A2A" 2>/dev/null || break
done
if ! kill -0 "$OC" 2>/dev/null; then code=11; else code=12; fi
log "child exited (opencode=$([ $code = 11 ] && echo down || echo up) a2a=$([ $code = 12 ] && echo down || echo up)); stopping container"
kill "$OC" "$A2A" 2>/dev/null || true
exit "$code"
