#!/bin/sh
# Starts `opencode serve` (loopback only, password-protected) then the A2A wrapper on :8000.
# If either dies the container exits so the supervisor sees a real failure.
# Inputs (env): OPENCODE_SERVER_PASSWORD, A2A_BEARER_TOKEN, A2A_PUBLIC_URL, WORKSPACE (default /work)
set -eu
: "${OPENCODE_SERVER_PASSWORD:?required}" "${A2A_BEARER_TOKEN:?required}"
WORKSPACE="${WORKSPACE:-/work}"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"
# /cfg (read-only mount: opencode.json, plugins/, AGENTS.md) is copied to a writable dir because
# opencode installs @opencode-ai/plugin into its config dir at boot.
if [ -d /opt/seed/node_modules ]; then
  mkdir -p "$XDG_CONFIG_HOME/opencode"
  ln -sfn /opt/seed/node_modules "$XDG_CONFIG_HOME/opencode/node_modules"
  cp /opt/seed/package.json /opt/seed/package-lock.json /opt/seed/.gitignore "$XDG_CONFIG_HOME/opencode/" 2>/dev/null || true
fi
if [ -d /cfg ]; then
  mkdir -p "$HOME/cfg" && cp -r /cfg/. "$HOME/cfg/"
  # seeded plugin deps: link the baked read-only copy instead of installing 63 MB at boot
  if [ -d /opt/seed/node_modules ] && [ ! -e "$HOME/cfg/node_modules" ]; then
    ln -s /opt/seed/node_modules "$HOME/cfg/node_modules"
    cp /opt/seed/package.json /opt/seed/package-lock.json "$HOME/cfg/" 2>/dev/null || true
  fi
  export OPENCODE_CONFIG_DIR="$HOME/cfg"
  [ -f "$HOME/cfg/opencode.json" ] && export OPENCODE_CONFIG="$HOME/cfg/opencode.json"
fi
cd "$WORKSPACE"
opencode serve --hostname 127.0.0.1 --port 4096 &
OC=$!
i=0
until curl -fsS --max-time 2 -u "opencode:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:4096/global/health >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -gt 120 ] && { echo "opencode serve not healthy" >&2; kill "$OC" 2>/dev/null; exit 1; }
  kill -0 "$OC" 2>/dev/null || { echo "opencode serve exited" >&2; exit 1; }
  sleep 0.5
done
A2A_STATIC_AUTH_CREDENTIALS="[{\"scheme\":\"bearer\",\"token\":\"$A2A_BEARER_TOKEN\",\"principal\":\"kookr\"}]" \
OPENCODE_BASE_URL=http://127.0.0.1:4096 OPENCODE_AUTH_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
OPENCODE_WORKSPACE_ROOT="$WORKSPACE" \
A2A_TASK_STORE_DATABASE_URL="sqlite+aiosqlite:////data/a2a-tasks.db" \
A2A_HOST=0.0.0.0 A2A_PORT=8000 A2A_PUBLIC_URL="${A2A_PUBLIC_URL:-http://127.0.0.1:8000}" \
opencode-a2a serve &
A2A=$!
trap 'kill $OC $A2A 2>/dev/null' TERM INT
wait -n "$OC" "$A2A" 2>/dev/null || wait "$OC"
echo "child exited; stopping container" >&2
kill "$OC" "$A2A" 2>/dev/null || true
exit 1
