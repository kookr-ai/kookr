#!/usr/bin/env bash
#
# Rebuild and install the Grok Build binary from Jean's forked repo.
# Mirrors scripts/rebuild-codex.sh for the Codex fork.
#
# Prerequisites:
#   - Rust toolchain pinned by the fork's rust-toolchain.toml (rustup
#     installs it automatically on first build)
#   - protoc: the fork resolves bin/protoc (dotslash) or a protoc on PATH
#   - The Grok Build fork checked out at GROK_SRC (default: ~/git/grok-build)
#
# Usage:
#   scripts/rebuild-grok.sh                                # fast optimized build + install
#   GROK_BUILD_PROFILE=release scripts/rebuild-grok.sh     # full upstream-style release build
#   GROK_SRC=/path/to/fork scripts/rebuild-grok.sh
#   GROK_INSTALL_DIR=/usr/local/bin scripts/rebuild-grok.sh

set -euo pipefail

GROK_SRC="${GROK_SRC:-$HOME/git/grok-build}"
GROK_INSTALL_DIR="${GROK_INSTALL_DIR:-$HOME/bin}"
GROK_BUILD_PROFILE="${GROK_BUILD_PROFILE:-kookr-dev}"
MANIFEST="$GROK_SRC/Cargo.toml"

# WSL quirk shared with the codex rebuild: /run/user/1000 may not be writable
# for snap-provided cargo; a tmp XDG_RUNTIME_DIR is always safe here.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"

# --- Pre-flight checks -------------------------------------------------------

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: Grok Build fork not found at $GROK_SRC" >&2
  echo "       Expected Cargo.toml at $MANIFEST" >&2
  echo "       Set GROK_SRC to the correct path." >&2
  exit 1
fi

mkdir -p "$GROK_INSTALL_DIR"

case "$GROK_BUILD_PROFILE" in
  release|kookr-dev)
    ;;
  *)
    echo "ERROR: Unsupported GROK_BUILD_PROFILE=$GROK_BUILD_PROFILE" >&2
    echo "       Expected one of: release, kookr-dev" >&2
    exit 1
    ;;
esac

# Detect the Rust toolchain from the fork's rust-toolchain.toml if present,
# otherwise fall back to the stable default.
TOOLCHAIN_FILE="$GROK_SRC/rust-toolchain.toml"
if [ -f "$TOOLCHAIN_FILE" ]; then
  CHANNEL=$(sed -n 's/^channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TOOLCHAIN_FILE" 2>/dev/null | head -1)
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

if [ "$GROK_BUILD_PROFILE" = "kookr-dev" ]; then
  echo "Building Grok Build (kookr-dev profile) from $GROK_SRC ..."
  echo "Using fast local release overrides: thin LTO, incremental, higher codegen parallelism"
  export CARGO_PROFILE_RELEASE_LTO=thin
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
  export CARGO_PROFILE_RELEASE_INCREMENTAL=true
else
  echo "Building Grok Build (release) from $GROK_SRC ..."
fi

# The binary crate is xai-grok-pager-bin; its artifact is xai-grok-pager
# (official installs ship it as `grok` — see the fork README).
cargo $TOOLCHAIN build \
  --manifest-path "$MANIFEST" \
  -p xai-grok-pager-bin \
  --release

# --- Install ------------------------------------------------------------------

TARGET_DIR=$(cargo $TOOLCHAIN metadata \
  --manifest-path "$MANIFEST" \
  --no-deps \
  --format-version 1 |
  node -e 'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).target_directory));')
BUILT_BIN="$TARGET_DIR/release/xai-grok-pager"

if [ ! -f "$BUILT_BIN" ]; then
  echo "ERROR: Build succeeded but binary not found at $BUILT_BIN" >&2
  exit 1
fi

install -m 755 "$BUILT_BIN" "$GROK_INSTALL_DIR/grok"

# --- Verify -------------------------------------------------------------------

INSTALLED="$GROK_INSTALL_DIR/grok"
VERSION=$("$INSTALLED" version 2>&1 || true)
echo ""
echo "Installed: $INSTALLED"
echo "Version:   $VERSION"
echo ""
echo "Make sure KOOKR_GROK_BIN points to $INSTALLED (or that it is on PATH)."
