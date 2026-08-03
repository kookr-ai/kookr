#!/usr/bin/env bash
#
# Rebuild and install the Codex CLI binaries from Kookr's forked repo.
#
# Installs both:
#   - codex                  (main CLI)
#   - codex-code-mode-host   (sibling helper required for shell/tool exec)
#
# Prerequisites:
#   - Rust toolchain with nightly-2025-06-13 (or the version pinned in rust-toolchain.toml)
#   - Node.js (used to parse cargo metadata)
#   - The Codex fork checked out at CODEX_SRC (default: ~/git/codex)
#   - curl + tar (only needed for the host download fallback)
#
# Usage:
#   scripts/rebuild-codex.sh                                # fast optimized build + install
#   CODEX_BUILD_PROFILE=release scripts/rebuild-codex.sh   # full upstream-style release build
#   CODEX_SRC=/path/to/fork scripts/rebuild-codex.sh
#   CODEX_INSTALL_DIR=/usr/local/bin scripts/rebuild-codex.sh
#   CODEX_HOST_FROM_RELEASE=1 scripts/rebuild-codex.sh     # force host from GitHub release
#   CODEX_HOST_RELEASE_TAG=rust-v0.145.0 scripts/rebuild-codex.sh

set -euo pipefail

CODEX_SRC="${CODEX_SRC:-$HOME/git/codex}"
CODEX_INSTALL_DIR="${CODEX_INSTALL_DIR:-$HOME/bin}"
CODEX_BUILD_PROFILE="${CODEX_BUILD_PROFILE:-kookr-dev}"
# When set to 1, skip building the host from source and always fetch the
# matching (or CODEX_HOST_RELEASE_TAG) GitHub release asset. Useful when the
# local v8/rusty_v8 prebuilt archive is unavailable (ptrcomp+sandbox 404).
CODEX_HOST_FROM_RELEASE="${CODEX_HOST_FROM_RELEASE:-0}"
CODEX_HOST_RELEASE_TAG="${CODEX_HOST_RELEASE_TAG:-}"
MANIFEST="$CODEX_SRC/codex-rs/Cargo.toml"

# Binaries Codex needs side-by-side. The main CLI resolves the host as a sibling
# of the `codex` executable (`install-context`); a half-install (CLI only) boots
# but fails every shell/tool call with:
#   failed to spawn code-mode host <install-dir>/codex-code-mode-host: No such file or directory
CODEX_CLI_BIN=codex
CODEX_HOST_BIN=codex-code-mode-host

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

resolve_target_dir() {
  cargo $TOOLCHAIN metadata \
    --manifest-path "$MANIFEST" \
    --no-deps \
    --format-version 1 |
    node -e 'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).target_directory));'
}

# Derive a GitHub release tag (rust-vX.Y.Z) from the fork's Cargo workspace
# version so the downloaded host roughly matches the CLI we just built.
derive_host_release_tag() {
  if [ -n "$CODEX_HOST_RELEASE_TAG" ]; then
    printf '%s\n' "$CODEX_HOST_RELEASE_TAG"
    return
  fi
  local version
  version=$(cargo $TOOLCHAIN metadata \
    --manifest-path "$MANIFEST" \
    --no-deps \
    --format-version 1 |
    node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => input += c);
      process.stdin.on("end", () => {
        const meta = JSON.parse(input);
        const pkg = (meta.packages || []).find((p) => p.name === "codex-cli")
          || (meta.packages || []).find((p) => p.name === "codex-core")
          || (meta.packages || [])[0];
        if (!pkg || !pkg.version) { process.exit(2); }
        // 0.145.0-alpha.4 → 0.145.0
        const base = String(pkg.version).split("-")[0];
        process.stdout.write("rust-v" + base);
      });
    ') || true
  if [ -z "${version:-}" ]; then
    echo "ERROR: could not derive host release tag from cargo metadata; set CODEX_HOST_RELEASE_TAG" >&2
    exit 1
  fi
  printf '%s\n' "$version"
}

# Download the official musl host binary for linux-x86_64 from openai/codex
# releases. Static-pie musl builds run on glibc hosts and avoid the local
# rusty_v8 prebuilt gap (ptrcomp+sandbox archive often 404s).
install_host_from_release() {
  local tag arch url tmp archive extracted
  tag=$(derive_host_release_tag)
  arch="x86_64-unknown-linux-musl"
  url="https://github.com/openai/codex/releases/download/${tag}/codex-code-mode-host-${arch}.tar.gz"
  echo "Fetching code-mode host from release ${tag} ..."
  echo "  $url"
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" RETURN
  archive="$tmp/host.tgz"
  if ! curl -fsSL -o "$archive" "$url"; then
    echo "ERROR: failed to download code-mode host from $url" >&2
    echo "       Set CODEX_HOST_RELEASE_TAG to a published rust-v* tag, or fix the" >&2
    echo "       local v8 prebuilt (RUSTY_V8_ARCHIVE) and rebuild without CODEX_HOST_FROM_RELEASE." >&2
    exit 1
  fi
  tar -xzf "$archive" -C "$tmp"
  extracted=$(find "$tmp" -type f \( -name 'codex-code-mode-host' -o -name 'codex-code-mode-host-*' \) ! -name '*.tgz' | head -1)
  if [ -z "$extracted" ] || [ ! -f "$extracted" ]; then
    echo "ERROR: release archive did not contain codex-code-mode-host" >&2
    tar -tzf "$archive" >&2 || true
    exit 1
  fi
  install -m 755 "$extracted" "$CODEX_INSTALL_DIR/$CODEX_HOST_BIN"
  echo "Installed: $CODEX_INSTALL_DIR/$CODEX_HOST_BIN (from ${tag})"
}

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

# Always build the CLI from the fork (carries kookr patches).
cargo $TOOLCHAIN build \
  --manifest-path "$MANIFEST" \
  -p codex-cli \
  --bin codex \
  --release

HOST_BUILT_FROM_SOURCE=0
if [ "$CODEX_HOST_FROM_RELEASE" != "1" ]; then
  echo "Building code-mode host from source ..."
  if cargo $TOOLCHAIN build \
    --manifest-path "$MANIFEST" \
    -p codex-code-mode-host \
    --bin codex-code-mode-host \
    --release
  then
    HOST_BUILT_FROM_SOURCE=1
  else
    echo "WARNING: source build of codex-code-mode-host failed (often a rusty_v8" >&2
    echo "         prebuilt 404 for ptrcomp+sandbox). Falling back to GitHub release." >&2
  fi
fi

# --- Install ------------------------------------------------------------------

TARGET_DIR=$(resolve_target_dir)
CLI_BUILT="$TARGET_DIR/release/$CODEX_CLI_BIN"
if [ ! -f "$CLI_BUILT" ]; then
  echo "ERROR: Build succeeded but binary not found at $CLI_BUILT" >&2
  exit 1
fi
install -m 755 "$CLI_BUILT" "$CODEX_INSTALL_DIR/$CODEX_CLI_BIN"
echo "Installed: $CODEX_INSTALL_DIR/$CODEX_CLI_BIN"

if [ "$HOST_BUILT_FROM_SOURCE" = "1" ]; then
  HOST_BUILT="$TARGET_DIR/release/$CODEX_HOST_BIN"
  if [ ! -f "$HOST_BUILT" ]; then
    echo "ERROR: Host build reported success but binary not found at $HOST_BUILT" >&2
    exit 1
  fi
  install -m 755 "$HOST_BUILT" "$CODEX_INSTALL_DIR/$CODEX_HOST_BIN"
  echo "Installed: $CODEX_INSTALL_DIR/$CODEX_HOST_BIN (from source)"
else
  install_host_from_release
fi

# --- Verify -------------------------------------------------------------------

INSTALLED="$CODEX_INSTALL_DIR/$CODEX_CLI_BIN"
HOST_INSTALLED="$CODEX_INSTALL_DIR/$CODEX_HOST_BIN"
VERSION=$("$INSTALLED" --version 2>&1 || true)
echo ""
echo "Installed CLI:  $INSTALLED"
echo "Installed host: $HOST_INSTALLED"
echo "Version:        $VERSION"
echo ""
if [ ! -x "$HOST_INSTALLED" ]; then
  echo "ERROR: code-mode host is not executable at $HOST_INSTALLED" >&2
  exit 1
fi
# Fail closed: CLI and host must share a parent directory so install-context
# resolves the sibling path the running binary expects.
if [ "$(dirname -- "$INSTALLED")" != "$(dirname -- "$HOST_INSTALLED")" ]; then
  echo "ERROR: CLI and host must be installed in the same directory" >&2
  exit 1
fi
echo "Make sure KOOKR_CODEX_BIN points to $INSTALLED (or that it is on PATH)."
echo "The host must remain a sibling of the CLI binary so Codex can spawn it."
