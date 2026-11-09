#!/bin/sh
# Build the opencode-worker image (and optionally the Kookr toolchain layer).
#   deploy/opencode-worker/build.sh [tag]     -> opencode-worker:<tag> (default: git short sha)
#   WITH_KOOKR_TOOLCHAIN=1 ...                -> also opencode-worker-kookr:<tag>
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tag="${1:-$(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo dev)}"
docker build -t "opencode-worker:$tag" "$here"
if [ "${WITH_KOOKR_TOOLCHAIN:-0}" = 1 ]; then
  docker build -f "$here/toolchains/kookr.Dockerfile" --build-arg "BASE=opencode-worker:$tag" -t "opencode-worker-kookr:$tag" "$here"
fi
echo "built opencode-worker:$tag"
