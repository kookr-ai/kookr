#!/usr/bin/env bash
# Build dtach from upstream source into ./vendor/dtach/dtach.
#
# Kookr uses dtach as a persistence layer for agent PTY sessions (see
# docs/adr/014-local-dtach-backend.md). Not all distros ship dtach — spike
# C2 in docs/spikes/empirical-validation-v6.md showed Ubuntu/Debian-on-WSL
# doesn't have it in apt. Upstream is ~500 LoC of C with no dependencies
# and builds in 2s. Vendoring in-tree is simpler and more reliable than
# relying on `apt install dtach` / `brew install dtach`.
#
# Usage:
#   scripts/build-dtach.sh               # build if missing
#   scripts/build-dtach.sh --force       # always rebuild
#
# Requires: git, make, gcc (or cc-equivalent). Posts a clear error if any
# is missing.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/dtach"
BIN="$VENDOR_DIR/dtach"
UPSTREAM="https://github.com/crigler/dtach.git"
# Pin to upstream's last release tag (v0.9). Checkout depth=1 is fine since
# we don't track dtach history.
TAG="v0.9"

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | head -n 20
      exit 0
      ;;
  esac
done

if [ "$FORCE" -eq 0 ] && [ -x "$BIN" ]; then
  echo "[build-dtach] $BIN already exists; skipping (use --force to rebuild)"
  exit 0
fi

# Preflight: required tools.
for tool in git make cc; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "[build-dtach] missing required tool: $tool" >&2
    echo "[build-dtach] install build-essential (Debian/Ubuntu) or Xcode CLT (macOS)" >&2
    exit 1
  fi
done

SRC_DIR="$VENDOR_DIR/src"
mkdir -p "$VENDOR_DIR"
if [ ! -d "$SRC_DIR/.git" ]; then
  echo "[build-dtach] cloning upstream ($UPSTREAM @ $TAG) into $SRC_DIR"
  git clone --depth=1 --branch "$TAG" "$UPSTREAM" "$SRC_DIR" 2>&1 | tail -3
else
  echo "[build-dtach] reusing cached clone at $SRC_DIR"
  (cd "$SRC_DIR" && git fetch --depth=1 origin "$TAG" && git checkout "$TAG") >/dev/null 2>&1 || true
fi

echo "[build-dtach] configuring + building"
(
  cd "$SRC_DIR"
  ./configure --prefix="$VENDOR_DIR" >/dev/null 2>&1
  make >/dev/null 2>&1
)
cp "$SRC_DIR/dtach" "$BIN"
chmod +x "$BIN"

echo "[build-dtach] built $BIN"
"$BIN" --help 2>&1 | head -1 || true
