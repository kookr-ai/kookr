#!/usr/bin/env bash
#
# Rebuild and install the Codex CLI binary from Kookr's forked repo.
#
# Prerequisites:
#   - Rust toolchain with nightly-2025-06-13 (or the version pinned in rust-toolchain.toml)
#   - Node.js (used to parse cargo metadata)
#   - The Codex fork checked out at CODEX_SRC (default: ~/git/codex)
#
# Usage:
#   scripts/rebuild-codex.sh                                # fast optimized build + install
#   CODEX_BUILD_PROFILE=release scripts/rebuild-codex.sh   # full upstream-style release build
#   CODEX_SRC=/path/to/fork scripts/rebuild-codex.sh
#   CODEX_INSTALL_DIR=/usr/local/bin scripts/rebuild-codex.sh

set -euo pipefail

CODEX_SRC="${CODEX_SRC:-$HOME/git/codex}"
CODEX_INSTALL_DIR="${CODEX_INSTALL_DIR:-$HOME/bin}"
CODEX_BUILD_PROFILE="${CODEX_BUILD_PROFILE:-kookr-dev}"
MANIFEST="$CODEX_SRC/codex-rs/Cargo.toml"

# --- Pre-flight checks -------------------------------------------------------

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: Codex fork not found at $CODEX_SRC" >&2
  echo "       Expected Cargo.toml at $MANIFEST" >&2
  echo "       Set CODEX_SRC to the correct path." >&2
  exit 1
fi

mkdir -p "$CODEX_INSTALL_DIR"

case "$CODEX_BUILD_PROFILE" in
  release|kookr-dev)
    ;;
  *)
    echo "ERROR: Unsupported CODEX_BUILD_PROFILE=$CODEX_BUILD_PROFILE" >&2
    echo "       Expected one of: release, kookr-dev" >&2
    exit 1
    ;;
esac

# Detect the Rust toolchain from the fork's rust-toolchain.toml if present,
# otherwise fall back to the stable default.
TOOLCHAIN_FILE="$CODEX_SRC/codex-rs/rust-toolchain.toml"
if [ -f "$TOOLCHAIN_FILE" ]; then
  CHANNEL=$(grep -oP '(?<=channel\s=\s")[^"]+' "$TOOLCHAIN_FILE" 2>/dev/null || true)
  if [ -n "$CHANNEL" ]; then
    TOOLCHAIN="+$CHANNEL"
    echo "Using toolchain from rust-toolchain.toml: $CHANNEL"
  else
    TOOLCHAIN=""
  fi
else
  TOOLCHAIN=""
fi

# --- Build --------------------------------------------------------------------

if [ "$CODEX_BUILD_PROFILE" = "kookr-dev" ]; then
  echo "Building Codex CLI (kookr-dev profile) from $CODEX_SRC ..."
  echo "Using fast local release overrides: thin LTO, incremental, higher codegen parallelism"
  export CARGO_PROFILE_RELEASE_LTO=thin
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
  export CARGO_PROFILE_RELEASE_INCREMENTAL=true
else
  echo "Building Codex CLI (release) from $CODEX_SRC ..."
fi

cargo $TOOLCHAIN build \
  --manifest-path "$MANIFEST" \
  -p codex-cli \
  --bin codex \
  --release

# --- Install ------------------------------------------------------------------

TARGET_DIR=$(cargo $TOOLCHAIN metadata \
  --manifest-path "$MANIFEST" \
  --no-deps \
  --format-version 1 |
  node -e 'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).target_directory));')
BUILT_BIN="$TARGET_DIR/release/codex"

if [ ! -f "$BUILT_BIN" ]; then
  echo "ERROR: Build succeeded but binary not found at $BUILT_BIN" >&2
  exit 1
fi

install -m 755 "$BUILT_BIN" "$CODEX_INSTALL_DIR/codex"

# --- Verify -------------------------------------------------------------------

INSTALLED="$CODEX_INSTALL_DIR/codex"
VERSION=$("$INSTALLED" --version 2>&1 || true)
echo ""
echo "Installed: $INSTALLED"
echo "Version:   $VERSION"
echo ""
echo "Make sure KOOKR_CODEX_BIN points to $INSTALLED (or that it is on PATH)."
