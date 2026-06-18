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
CODEX_REPO_URL="${CODEX_REPO_URL:-https://github.com/jeanibarz/codex.git}"
CODEX_BRANCH="${CODEX_BRANCH:-feat/claude-compat}"
MANIFEST="$CODEX_SRC/codex-rs/Cargo.toml"

# --- Pre-flight checks -------------------------------------------------------

# A fresh onboarding machine has no fork checkout. Clone it on first run so
# `pnpm codex:rebuild` works end-to-end from a clean install instead of
# erroring out. An existing checkout is built as-is — update it yourself
# (see docs/codex-cli-setup.md "Updating the fork").
if [ ! -f "$MANIFEST" ]; then
  if [ -e "$CODEX_SRC" ] && [ ! -d "$CODEX_SRC/.git" ]; then
    echo "ERROR: $CODEX_SRC exists but is not a git checkout of the Codex fork." >&2
    echo "       Expected Cargo.toml at $MANIFEST." >&2
    echo "       Move it aside or set CODEX_SRC to a different path." >&2
    exit 1
  fi

  if ! command -v git >/dev/null 2>&1; then
    echo "ERROR: git is required to clone the Codex fork but was not found on PATH." >&2
    exit 1
  fi

  if [ ! -d "$CODEX_SRC/.git" ]; then
    echo "Codex fork not found at $CODEX_SRC."
    echo "Cloning $CODEX_REPO_URL (branch $CODEX_BRANCH) ..."
    git clone --branch "$CODEX_BRANCH" "$CODEX_REPO_URL" "$CODEX_SRC"
  else
    echo "Codex fork at $CODEX_SRC is missing $MANIFEST; checking out $CODEX_BRANCH ..."
    git -C "$CODEX_SRC" fetch origin "$CODEX_BRANCH"
    git -C "$CODEX_SRC" checkout "$CODEX_BRANCH"
  fi
fi

if [ ! -f "$MANIFEST" ]; then
  echo "ERROR: Codex fork still missing Cargo.toml at $MANIFEST after clone/checkout." >&2
  echo "       Set CODEX_SRC to the correct path, or check CODEX_REPO_URL/CODEX_BRANCH." >&2
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
  # Portable parse of `channel = "..."`. The previous `grep -oP` is GNU-only;
  # BSD/macOS grep rejects -P, so the pin was silently dropped on macOS.
  CHANNEL=$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TOOLCHAIN_FILE" 2>/dev/null | head -n1 || true)
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
