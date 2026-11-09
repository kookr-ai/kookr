#!/bin/bash
# Operator-run live checks for the opencode-worker image (needs docker; not part of the PR gate).
#   deploy/opencode-worker/test-container.sh <image>
# Verifies: healthy (HEALTHCHECK), read-only root, missing-secret exit 13, hook self-test exit 14,
# and that the container exits (11 / 12) when EITHER child is killed. Only touches containers it
# names `ocw-test-*` and a temp dir it creates.
set -u
IMG="${1:?usage: test-container.sh <image>}"
T=$(mktemp -d /tmp/ocw-test.XXXXXX); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/secrets" "$T/work" "$T/data"; chmod 777 "$T/data" "$T/work"
echo "pw$RANDOM$RANDOM" > "$T/secrets/opencode_password"; echo "tok$RANDOM$RANDOM" > "$T/secrets/a2a_token"; chmod 0644 "$T/secrets/"*
git -C "$T/work" init -q; echo x > "$T/work/f"
fail=0; ok() { echo "ok   $*"; }; bad() { echo "FAIL $*"; fail=1; }
run() { # name [extra docker args...]
  local n=$1; shift
  docker run -d --name "$n" --init --read-only --cap-drop ALL --security-opt no-new-privileges --memory 2g --pids-limit 512 \
    --user "$(id -u):$(id -g)" --tmpfs /tmp:rw,size=128m --tmpfs /home/worker:rw,size=512m,uid="$(id -u)" \
    -v "$T/data":/data -v "$T/work":/work -v "$T/secrets":/run/secrets:ro "$@" "$IMG" >/dev/null
}
wait_status() { # name want timeout
  for _ in $(seq 1 "$3"); do [ "$(docker inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = "$2" ] && return 0; sleep 1; done; return 1
}
cleanup() { for n in "$@"; do docker rm -f "$n" >/dev/null 2>&1; done; }
N=ocw-test-main
run $N -e HOME=/home/worker
wait_status $N healthy 90 && ok "healthcheck reaches healthy" || bad "never healthy"
docker exec $N sh -c 'touch /x 2>/dev/null' && bad "root fs writable" || ok "root fs read-only"
docker logs $N 2>&1 | grep -q '^\[opencode\]' && docker logs $N 2>&1 | grep -q '^\[entrypoint\]' && ok "log prefixes" || bad "log prefixes missing"
docker exec $N pkill -f 'opencode-a2a serve'; sleep 4
c=$(docker inspect -f '{{.State.ExitCode}}' $N); [ "$c" = 12 ] && ok "a2a death -> exit 12" || bad "a2a death exit=$c (want 12)"
cleanup $N
run $N -e HOME=/home/worker; wait_status $N healthy 90 || bad "second start never healthy"
docker exec $N pkill -f 'opencode serve'; sleep 4
c=$(docker inspect -f '{{.State.ExitCode}}' $N); [ "$c" = 11 ] && ok "opencode death -> exit 11" || bad "opencode death exit=$c (want 11)"
cleanup $N
docker run --rm --name ocw-test-nosecret --read-only --user "$(id -u):$(id -g)" --tmpfs /home/worker:uid="$(id -u)" -v "$T/data":/data "$IMG" >/dev/null 2>&1; c=$?
[ "$c" = 13 ] && ok "missing secret -> exit 13" || bad "missing secret exit=$c (want 13)"
mkdir -p "$T/hooks"; echo /kookr-hooks/does-not-exist.js > "$T/hooks/MANIFEST"
docker run --rm --name ocw-test-hook --read-only --user "$(id -u):$(id -g)" --tmpfs /home/worker:uid="$(id -u)" -v "$T/data":/data -v "$T/work":/work -v "$T/secrets":/run/secrets:ro -v "$T/hooks":/kookr-hooks:ro "$IMG" >/dev/null 2>&1; c=$?
[ "$c" = 14 ] && ok "hook self-test fail -> exit 14" || bad "hook self-test exit=$c (want 14)"
cleanup ocw-test-main ocw-test-nosecret ocw-test-hook
exit $fail
