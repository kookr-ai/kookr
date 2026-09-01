#!/usr/bin/env bash
#
# Build and activate one matched Codex CLI/code-mode-host pair.
#
# The code-mode wire schema is compiled into both executables. A CLI-only
# replacement can therefore run a command and then lose its response while
# decoding an older host frame. This script prepares and validates both
# artifacts before changing the active installation.

set -euo pipefail

CODEX_SRC="${CODEX_SRC:-$HOME/git/codex}"
CODEX_INSTALL_DIR="${CODEX_INSTALL_DIR:-$HOME/bin}"
CODEX_BUILD_PROFILE="${CODEX_BUILD_PROFILE:-kookr-dev}"
CODEX_HOST_FROM_RELEASE="${CODEX_HOST_FROM_RELEASE:-0}"
CODEX_HOST_RELEASE_TAG="${CODEX_HOST_RELEASE_TAG:-}"
CODEX_KEEP_RELEASE_PAIRS="${CODEX_KEEP_RELEASE_PAIRS:-3}"
CODEX_PUBLIC_CLI_NAME="${CODEX_PUBLIC_CLI_NAME-codex}"
MANIFEST="$CODEX_SRC/codex-rs/Cargo.toml"
CODEX_CLI_BIN=codex
CODEX_HOST_BIN=codex-code-mode-host
PAIR_MANIFEST=codex-pair.json

TEMP_DIRS=()

cleanup() {
  local dir
  for dir in "${TEMP_DIRS[@]}"; do
    if [ -n "$dir" ] && [ -d "$dir" ]; then
      rm -rf -- "$dir"
    fi
  done
}
trap cleanup EXIT

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [ ! -f "$MANIFEST" ]; then
  die "Codex fork not found at $CODEX_SRC (expected $MANIFEST)"
fi

case "$CODEX_BUILD_PROFILE" in
  release|kookr-dev) ;;
  *) die "unsupported CODEX_BUILD_PROFILE=$CODEX_BUILD_PROFILE (expected release or kookr-dev)" ;;
esac

case "$CODEX_KEEP_RELEASE_PAIRS" in
  ''|*[!0-9]*|0) die "CODEX_KEEP_RELEASE_PAIRS must be a positive integer" ;;
esac

case "$CODEX_PUBLIC_CLI_NAME" in
  ''|.|..|*/*|codex-code-mode-host|.codex-current|.codex-releases|.codex-legacy-pair)
    die "CODEX_PUBLIC_CLI_NAME must be a non-reserved filename distinct from codex-code-mode-host"
    ;;
esac

mkdir -p "$CODEX_INSTALL_DIR"

# Use the checkout's pinned toolchain. The sed expression works with both GNU
# and BSD sed; the previous PCRE-based grep failed on macOS.
TOOLCHAIN_FILE="$CODEX_SRC/codex-rs/rust-toolchain.toml"
CHANNEL=""
if [ -f "$TOOLCHAIN_FILE" ]; then
  CHANNEL=$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$TOOLCHAIN_FILE" | head -1)
fi
CARGO=(cargo)
if [ -n "$CHANNEL" ]; then
  CARGO+=("+$CHANNEL")
  printf 'Using toolchain from rust-toolchain.toml: %s\n' "$CHANNEL"
fi

resolve_target_dir() {
  "${CARGO[@]}" metadata \
    --manifest-path "$MANIFEST" \
    --no-deps \
    --format-version 1 |
    node -e 'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(input).target_directory));'
}

derive_host_release_tag() {
  if [ -n "$CODEX_HOST_RELEASE_TAG" ]; then
    printf '%s\n' "$CODEX_HOST_RELEASE_TAG"
    return
  fi
  "${CARGO[@]}" metadata \
    --manifest-path "$MANIFEST" \
    --no-deps \
    --format-version 1 |
    node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const metadata = JSON.parse(input);
        const pkg = (metadata.packages || []).find(candidate => candidate.name === "codex-cli");
        if (!pkg?.version) process.exit(2);
        process.stdout.write(`rust-v${pkg.version}`);
      });
    '
}

# A release host is safe only when its code-mode implementation is identical to
# the checkout being built. Version strings alone are insufficient because the
# fork can absorb protocol changes while retaining the same prerelease version.
validate_release_host_compatibility() {
  local tag="$1"
  local tag_commit
  tag_commit=$(git -C "$CODEX_SRC" rev-parse --verify "refs/tags/$tag^{commit}" 2>/dev/null) || {
    printf 'ERROR: release tag %s is not available in %s\n' "$tag" "$CODEX_SRC" >&2
    printf '       Fetch the exact tag or build codex-code-mode-host from source.\n' >&2
    return 1
  }
  if ! git -C "$CODEX_SRC" diff --quiet "$tag_commit" -- \
    codex-rs/code-mode-protocol \
    codex-rs/code-mode-host \
    codex-rs/code-mode-runtime
  then
    printf 'ERROR: release host %s does not match the checkout code-mode protocol\n' "$tag" >&2
    printf '       Build codex-code-mode-host from the same checkout instead.\n' >&2
    return 1
  fi
}

download_release_host() {
  local tag="$1"
  local output="$2"
  local target url download_dir archive extracted
  target=$(resolve_host_release_target) || return 1
  url="https://github.com/openai/codex/releases/download/${tag}/codex-code-mode-host-${target}.tar.gz"
  download_dir=$(mktemp -d "${TMPDIR:-/tmp}/kookr-codex-host.XXXXXX")
  TEMP_DIRS+=("$download_dir")
  archive="$download_dir/host.tgz"
  printf 'Fetching compatible code-mode host from release %s ...\n' "$tag"
  curl -fsSL -o "$archive" "$url" || die "failed to download code-mode host from $url"
  tar -xzf "$archive" -C "$download_dir"
  extracted=$(find "$download_dir" -type f \( -name 'codex-code-mode-host' -o -name 'codex-code-mode-host-*' \) ! -name '*.tgz' | head -1)
  [ -n "$extracted" ] && [ -f "$extracted" ] || die "release archive did not contain codex-code-mode-host"
  install -m 755 "$extracted" "$output"
}

resolve_host_release_target() {
  local platform machine
  platform=$(uname -s)
  machine=$(uname -m)
  case "$platform:$machine" in
    Linux:x86_64) printf '%s\n' 'x86_64-unknown-linux-musl' ;;
    Linux:aarch64|Linux:arm64) printf '%s\n' 'aarch64-unknown-linux-musl' ;;
    Darwin:x86_64) printf '%s\n' 'x86_64-apple-darwin' ;;
    Darwin:arm64|Darwin:aarch64) printf '%s\n' 'aarch64-apple-darwin' ;;
    *)
      printf 'ERROR: no code-mode host release target for %s %s\n' "$platform" "$machine" >&2
      return 1
      ;;
  esac
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

validate_pair_directory() {
  PAIR_DIRECTORY="$1" \
  PAIR_EXPECTED_COMMIT="$SOURCE_COMMIT" \
  PAIR_EXPECTED_SOURCE="$HOST_SOURCE" \
  PAIR_EXPECTED_CLI_SHA256="$CLI_SHA256" \
  PAIR_EXPECTED_HOST_SHA256="$HOST_SHA256" \
    node -e '
      const crypto = require("node:crypto");
      const fs = require("node:fs");
      const path = require("node:path");
      const directory = process.env.PAIR_DIRECTORY;
      const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "codex-pair.json"), "utf8"));
      const cli = path.join(directory, "codex");
      const host = path.join(directory, "codex-code-mode-host");
      if (manifest.schemaVersion !== 1
        || manifest.sourceCommit !== process.env.PAIR_EXPECTED_COMMIT
        || manifest.source !== process.env.PAIR_EXPECTED_SOURCE
        || manifest.cliSha256 !== process.env.PAIR_EXPECTED_CLI_SHA256
        || manifest.hostSha256 !== process.env.PAIR_EXPECTED_HOST_SHA256
        || hash(cli) !== process.env.PAIR_EXPECTED_CLI_SHA256
        || hash(host) !== process.env.PAIR_EXPECTED_HOST_SHA256
        || (fs.statSync(cli).mode & 0o111) === 0
        || (fs.statSync(host).mode & 0o111) === 0) {
        process.exit(2);
      }
    '
}

activate_symlink() {
  local target="$1"
  local link="$2"
  local next="${link}.next.$$"
  rm -f -- "$next"
  ln -s "$target" "$next"
  PAIR_NEXT_LINK="$next" PAIR_LINK="$link" node -e '
    const fs = require("node:fs");
    fs.renameSync(process.env.PAIR_NEXT_LINK, process.env.PAIR_LINK);
  '
}

if [ "$CODEX_BUILD_PROFILE" = "kookr-dev" ]; then
  printf 'Building matched Codex pair with fast local release overrides from %s ...\n' "$CODEX_SRC"
  export CARGO_PROFILE_RELEASE_LTO=thin
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
  export CARGO_PROFILE_RELEASE_INCREMENTAL=true
else
  printf 'Building matched Codex pair with the release profile from %s ...\n' "$CODEX_SRC"
fi

"${CARGO[@]}" build \
  --manifest-path "$MANIFEST" \
  -p codex-cli \
  --bin codex \
  --release

TARGET_DIR=$(resolve_target_dir)
CLI_ARTIFACT="$TARGET_DIR/release/$CODEX_CLI_BIN"
[ -x "$CLI_ARTIFACT" ] || die "CLI build succeeded but $CLI_ARTIFACT is not executable"

HOST_SOURCE=source-build
HOST_ARTIFACT="$TARGET_DIR/release/$CODEX_HOST_BIN"
if [ "$CODEX_HOST_FROM_RELEASE" != "1" ]; then
  printf 'Building code-mode host from the same checkout ...\n'
  if ! "${CARGO[@]}" build \
    --manifest-path "$MANIFEST" \
    -p codex-code-mode-host \
    --bin codex-code-mode-host \
    --release
  then
    printf 'WARNING: source build of codex-code-mode-host failed; checking a release fallback.\n' >&2
    CODEX_HOST_FROM_RELEASE=1
  fi
fi

if [ "$CODEX_HOST_FROM_RELEASE" = "1" ]; then
  HOST_TAG=$(derive_host_release_tag) || die "could not derive a code-mode host release tag"
  validate_release_host_compatibility "$HOST_TAG" || exit 1
  HOST_DOWNLOAD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/kookr-codex-host-artifact.XXXXXX")
  TEMP_DIRS+=("$HOST_DOWNLOAD_DIR")
  HOST_ARTIFACT="$HOST_DOWNLOAD_DIR/$CODEX_HOST_BIN"
  download_release_host "$HOST_TAG" "$HOST_ARTIFACT"
  HOST_SOURCE="release:$HOST_TAG"
fi

[ -x "$HOST_ARTIFACT" ] || die "code-mode host was not prepared at $HOST_ARTIFACT"

# Nothing under the public executable names changes until both artifacts exist.
SOURCE_COMMIT=$(git -C "$CODEX_SRC" rev-parse --verify HEAD)
CLI_SHA256=$(sha256_file "$CLI_ARTIFACT")
HOST_SHA256=$(sha256_file "$HOST_ARTIFACT")
PAIR_ID="$(printf '%.12s' "$SOURCE_COMMIT")-$(printf '%.12s' "$CLI_SHA256")-$(printf '%.12s' "$HOST_SHA256")"
RELEASES_DIR="$CODEX_INSTALL_DIR/.codex-releases"
PAIR_DIR="$RELEASES_DIR/$PAIR_ID"
mkdir -p "$RELEASES_DIR"

if [ ! -d "$PAIR_DIR" ]; then
  STAGING_DIR=$(mktemp -d "$RELEASES_DIR/.staging.XXXXXX")
  TEMP_DIRS+=("$STAGING_DIR")
  install -m 755 "$CLI_ARTIFACT" "$STAGING_DIR/$CODEX_CLI_BIN"
  install -m 755 "$HOST_ARTIFACT" "$STAGING_DIR/$CODEX_HOST_BIN"
  PAIR_MANIFEST_PATH="$STAGING_DIR/$PAIR_MANIFEST" \
  PAIR_SOURCE_COMMIT="$SOURCE_COMMIT" \
  PAIR_SOURCE="$HOST_SOURCE" \
  PAIR_CLI_SHA256="$CLI_SHA256" \
  PAIR_HOST_SHA256="$HOST_SHA256" \
    node -e '
      const fs = require("node:fs");
      const manifest = {
        schemaVersion: 1,
        sourceCommit: process.env.PAIR_SOURCE_COMMIT,
        source: process.env.PAIR_SOURCE,
        cliSha256: process.env.PAIR_CLI_SHA256,
        hostSha256: process.env.PAIR_HOST_SHA256,
      };
      fs.writeFileSync(process.env.PAIR_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    '
  mv "$STAGING_DIR" "$PAIR_DIR"
fi

validate_pair_directory "$PAIR_DIR" \
  || die "runtime pair directory failed manifest, hash, or executable validation: $PAIR_DIR"

CURRENT_LINK="$CODEX_INSTALL_DIR/.codex-current"
INSTALLED_CLI="$CODEX_INSTALL_DIR/$CODEX_PUBLIC_CLI_NAME"
INSTALLED_HOST="$CODEX_INSTALL_DIR/$CODEX_HOST_BIN"
MANAGED_LINKS=0
PARTIAL_MANAGED_LINKS=0
if [ -L "$INSTALLED_CLI" ] && [ -L "$INSTALLED_HOST" ] \
  && [ "$(readlink "$INSTALLED_CLI")" = ".codex-current/$CODEX_CLI_BIN" ] \
  && [ "$(readlink "$INSTALLED_HOST")" = ".codex-current/$CODEX_HOST_BIN" ]
then
  MANAGED_LINKS=1
elif [ -L "$INSTALLED_CLI" ] \
  && [ "$(readlink "$INSTALLED_CLI")" = ".codex-current/$CODEX_CLI_BIN" ] \
  && [ ! -e "$INSTALLED_HOST" ] && [ ! -L "$INSTALLED_HOST" ]
then
  PARTIAL_MANAGED_LINKS=1
elif [ -L "$INSTALLED_HOST" ] \
  && [ "$(readlink "$INSTALLED_HOST")" = ".codex-current/$CODEX_HOST_BIN" ] \
  && [ ! -e "$INSTALLED_CLI" ] && [ ! -L "$INSTALLED_CLI" ]
then
  PARTIAL_MANAGED_LINKS=1
fi

# Existing managed installs switch both executables with one pointer rename. If
# one managed public link is missing, restore both stable links before that
# switch. For a legacy install, first route both public names through a
# preserved copy of the old pair; the final pointer switch remains the only
# behavior change.
if [ "$MANAGED_LINKS" = "1" ]; then
  activate_symlink ".codex-releases/$PAIR_ID" "$CURRENT_LINK"
elif [ "$PARTIAL_MANAGED_LINKS" = "1" ]; then
  activate_symlink ".codex-current/$CODEX_HOST_BIN" "$INSTALLED_HOST"
  activate_symlink ".codex-current/$CODEX_CLI_BIN" "$INSTALLED_CLI"
  activate_symlink ".codex-releases/$PAIR_ID" "$CURRENT_LINK"
else
  if [ -e "$INSTALLED_CLI" ] || [ -e "$INSTALLED_HOST" ]; then
    [ -x "$INSTALLED_CLI" ] && [ -x "$INSTALLED_HOST" ] \
      || die "cannot migrate a partial legacy install; both codex executables must be present and executable"
    LEGACY_DIR="$CODEX_INSTALL_DIR/.codex-legacy-pair"
    if [ ! -e "$LEGACY_DIR" ]; then
      LEGACY_STAGING=$(mktemp -d "$CODEX_INSTALL_DIR/.codex-legacy-staging.XXXXXX")
      TEMP_DIRS+=("$LEGACY_STAGING")
      install -m 755 "$INSTALLED_CLI" "$LEGACY_STAGING/$CODEX_CLI_BIN"
      install -m 755 "$INSTALLED_HOST" "$LEGACY_STAGING/$CODEX_HOST_BIN"
      mv "$LEGACY_STAGING" "$LEGACY_DIR"
    fi
    [ -x "$LEGACY_DIR/$CODEX_CLI_BIN" ] && [ -x "$LEGACY_DIR/$CODEX_HOST_BIN" ] \
      || die "cannot recover migration because $LEGACY_DIR is not a complete executable pair"
    activate_symlink ".codex-legacy-pair" "$CURRENT_LINK"
  fi
  activate_symlink ".codex-current/$CODEX_HOST_BIN" "$INSTALLED_HOST"
  activate_symlink ".codex-current/$CODEX_CLI_BIN" "$INSTALLED_CLI"
  activate_symlink ".codex-releases/$PAIR_ID" "$CURRENT_LINK"
fi

PAIR_DIR_REAL=$(PAIR_CLI="$INSTALLED_CLI" PAIR_HOST="$INSTALLED_HOST" node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const cli = fs.realpathSync(process.env.PAIR_CLI);
  const host = fs.realpathSync(process.env.PAIR_HOST);
  if (path.dirname(cli) !== path.dirname(host)) process.exit(2);
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(cli), "codex-pair.json"), "utf8"));
  if (manifest.schemaVersion !== 1) process.exit(3);
  process.stdout.write(path.dirname(cli));
') || die "installed Codex paths do not resolve to one valid runtime pair"

# Keep a small rollback window without accumulating multi-gigabyte CLI builds.
# Only directories created by this installer and carrying a valid manifest are
# eligible; unknown files and directories are left untouched.
PAIR_RELEASES_DIR="$RELEASES_DIR" \
PAIR_ACTIVE_ID="$PAIR_ID" \
PAIR_KEEP_COUNT="$CODEX_KEEP_RELEASE_PAIRS" \
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.env.PAIR_RELEASES_DIR;
    const active = process.env.PAIR_ACTIVE_ID;
    const keep = Number(process.env.PAIR_KEEP_COUNT);
    const namePattern = /^[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{12}$/;
    const pairs = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && namePattern.test(entry.name))
      .flatMap(entry => {
        const directory = path.join(root, entry.name);
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(directory, "codex-pair.json"), "utf8"));
          const hex40 = /^[0-9a-f]{40}$/;
          const hex64 = /^[0-9a-f]{64}$/;
          if (manifest.schemaVersion !== 1
            || !hex40.test(manifest.sourceCommit)
            || typeof manifest.source !== "string"
            || manifest.source.length === 0
            || !hex64.test(manifest.cliSha256)
            || !hex64.test(manifest.hostSha256)) return [];
          return [{ name: entry.name, directory, mtimeMs: fs.statSync(directory).mtimeMs }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => {
        if (a.name === active) return -1;
        if (b.name === active) return 1;
        return b.mtimeMs - a.mtimeMs;
      });
    for (const pair of pairs.slice(keep)) {
      fs.rmSync(pair.directory, { recursive: true, force: true });
      process.stdout.write(`Removed old Codex runtime pair: ${pair.directory}\n`);
    }
  '

VERSION=$("$INSTALLED_CLI" --version 2>&1 || true)
printf '\nActivated Codex runtime pair: %s\n' "$PAIR_DIR_REAL"
printf 'Installed CLI:  %s\n' "$INSTALLED_CLI"
printf 'Installed host: %s\n' "$INSTALLED_HOST"
printf 'Version:        %s\n' "$VERSION"
printf 'Source:         %s\n' "$HOST_SOURCE"
