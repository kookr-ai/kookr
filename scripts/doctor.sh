#!/usr/bin/env bash
# doctor.sh — preflight checks for a Kookr development/runtime environment.
#
# Runs every known compatibility probe and prints a one-screen summary.
# Exits 0 when everything required is OK; non-zero when any required check
# fails. Optional checks (GPU, .env, voice tooling) report status without
# affecting the exit code so a healthy minimal install still passes.
#
# Usage:
#   pnpm doctor
#   scripts/doctor.sh
#
# Output is copy-pasteable into a GitHub issue. On any FAIL the script
# prints the exact command to fix it.
#
# Out of scope (per issue #9):
#   - Auto-fixing detected problems (just report)
#   - Windows checks (Linux + macOS only — see CLAUDE.md)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ANSI colors only when stdout is a TTY. Stripped output stays clean for
# pipes, CI logs, and copy-paste into issues.
if [ -t 1 ]; then
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_DIM=$'\033[2m'
else
  C_RESET=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_DIM=""
fi

FAILS=0
WARNS=0
# Lines printed after the table — one per failure with the exact fix command.
FIX_LINES=()

# print_row LABEL VALUE STATUS [DETAIL]
#
# STATUS is OK / FAIL / WARN / INFO. The LABEL column is fixed-width so
# values line up regardless of length.
print_row() {
  local label="$1"
  local value="$2"
  local status="$3"
  local detail="${4:-}"
  local color
  case "$status" in
    OK)   color="$C_GREEN" ;;
    FAIL) color="$C_RED" ;;
    WARN) color="$C_YELLOW" ;;
    *)    color="$C_DIM" ;;
  esac
  printf "%-22s %-20s ${color}%-4s${C_RESET}  %s\n" "$label" "$value" "$status" "$detail"
}

# add_fix MESSAGE
add_fix() {
  FIX_LINES+=("$1")
}

# Compare semantic versions. Returns 0 if "$1" >= "$2".
version_ge() {
  # Use sort -V (GNU + BSD on macOS Sonoma+ both support it) to pick the
  # higher of the two; if "$2" is the smaller one, "$1" >= "$2".
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]
}

echo
echo "Kookr doctor — environment preflight"
echo "Repo: $REPO_ROOT"
echo

# ---------------------------------------------------------------------------
# Required: Node.js
# ---------------------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
  if version_ge "$NODE_VERSION" "22.0.0"; then
    print_row "Node.js" "v$NODE_VERSION" "OK" "(>= 22)"
  else
    print_row "Node.js" "v$NODE_VERSION" "FAIL" "need >= 22"
    add_fix "Node.js >= 22 required. Install via nvm/asdf or distro package — see README Quick Start."
    FAILS=$((FAILS + 1))
  fi
else
  print_row "Node.js" "missing" "FAIL" "command not found"
  add_fix "Install Node.js >= 22. Linux: curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs. macOS: brew install node@22"
  FAILS=$((FAILS + 1))
fi

# ---------------------------------------------------------------------------
# Required: pnpm
# ---------------------------------------------------------------------------
if command -v pnpm >/dev/null 2>&1; then
  PNPM_VERSION="$(pnpm --version 2>/dev/null)"
  if version_ge "$PNPM_VERSION" "10.0.0"; then
    print_row "pnpm" "$PNPM_VERSION" "OK" "(>= 10)"
  else
    print_row "pnpm" "$PNPM_VERSION" "FAIL" "need >= 10"
    add_fix "pnpm >= 10 required. Run: sudo npm install -g pnpm@latest"
    FAILS=$((FAILS + 1))
  fi
else
  print_row "pnpm" "missing" "FAIL" "command not found"
  add_fix "Install pnpm: sudo npm install -g pnpm@latest (or via corepack: corepack enable && corepack prepare pnpm@latest --activate)"
  FAILS=$((FAILS + 1))
fi

# ---------------------------------------------------------------------------
# Required: git
# ---------------------------------------------------------------------------
if command -v git >/dev/null 2>&1; then
  GIT_VERSION="$(git --version 2>/dev/null | awk '{print $3}')"
  print_row "git" "$GIT_VERSION" "OK"
else
  print_row "git" "missing" "FAIL" "command not found"
  add_fix "Install git. Linux: sudo apt-get install -y git. macOS: xcode-select --install"
  FAILS=$((FAILS + 1))
fi

# ---------------------------------------------------------------------------
# Required: build tools (cc, make)
# (git is already verified above; build-dtach.sh requires cc + make + git.)
# ---------------------------------------------------------------------------
MISSING_BUILD=()
for tool in cc make; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    MISSING_BUILD+=("$tool")
  fi
done
if [ "${#MISSING_BUILD[@]}" -eq 0 ]; then
  print_row "build tools" "cc, make" "OK"
else
  print_row "build tools" "missing: ${MISSING_BUILD[*]}" "FAIL"
  add_fix "Install build tools. Linux: sudo apt-get install -y build-essential. macOS: xcode-select --install"
  FAILS=$((FAILS + 1))
fi

# ---------------------------------------------------------------------------
# Required: dtach binary (vendored, built by `pnpm install` via prepare hook)
# ---------------------------------------------------------------------------
DTACH_BIN="$REPO_ROOT/vendor/dtach/dtach"
if [ -x "$DTACH_BIN" ]; then
  print_row "dtach binary" "vendor/dtach/dtach" "OK"
else
  print_row "dtach binary" "vendor/dtach/dtach" "FAIL" "not built"
  add_fix "Build the vendored dtach: pnpm build:dtach (or rerun pnpm install)"
  FAILS=$((FAILS + 1))
fi

# ---------------------------------------------------------------------------
# Optional: Docker (only required for KOOKR_STT / KOOKR_TTS voice features)
# ---------------------------------------------------------------------------
DOCKER_OK=0
if command -v docker >/dev/null 2>&1; then
  DOCKER_VERSION="$(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"
  # `docker info` exits non-zero if the daemon is not reachable. Probe it
  # without asking for output we don't need.
  if docker info >/dev/null 2>&1; then
    print_row "Docker" "$DOCKER_VERSION" "OK"
    DOCKER_OK=1
  else
    print_row "Docker" "$DOCKER_VERSION" "WARN" "daemon not running"
    add_fix "Docker is installed but the daemon is not reachable. Start Docker Desktop, or: sudo systemctl start docker. Required only for KOOKR_STT / KOOKR_TTS."
    WARNS=$((WARNS + 1))
  fi
else
  print_row "Docker" "not installed" "INFO" "optional (voice features)"
fi

# ---------------------------------------------------------------------------
# Optional: Docker Compose v2 (subcommand on modern installs)
# ---------------------------------------------------------------------------
if [ "$DOCKER_OK" -eq 1 ]; then
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_VERSION="$(docker compose version --short 2>/dev/null || echo unknown)"
    print_row "Docker Compose" "v$COMPOSE_VERSION" "OK"
  else
    print_row "Docker Compose" "missing" "WARN" "needed for voice features"
    add_fix "Install Docker Compose v2. It ships with Docker Desktop and recent Docker Engine builds. See https://docs.docker.com/compose/install/"
    WARNS=$((WARNS + 1))
  fi
fi

# ---------------------------------------------------------------------------
# Optional: NVIDIA GPU (default STT profile uses CUDA)
# ---------------------------------------------------------------------------
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -n1)"
  if [ -n "$GPU_NAME" ]; then
    print_row "NVIDIA GPU" "detected" "OK" "($GPU_NAME)"
  else
    print_row "NVIDIA GPU" "nvidia-smi present" "WARN" "no device reported"
  fi
else
  print_row "NVIDIA GPU" "not detected" "INFO" "STT default needs CUDA; CPU fallback available (see README)"
fi

# ---------------------------------------------------------------------------
# Optional: Codex CLI fork capability (--plugin-dir)
#
# Stock @openai/codex does not advertise --plugin-dir. Kookr's
# CodexCliAdapter silently skips toolkit injection in that case (with a
# one-time console.warn at first launch). Surface the gap on demand here.
# Mirrors the runtime probe in src/adapters/probe-agent-binary.ts —
# see scripts/lib/probe-codex-plugin-dir.sh for the shared contract.
# ---------------------------------------------------------------------------
. "$REPO_ROOT/scripts/lib/probe-codex-plugin-dir.sh"
probe_codex_plugin_dir
CODEX_VERSION_DISPLAY="unknown"
if [ "$PROBE_RESULT" != "not-installed" ]; then
  CODEX_VERSION_DISPLAY="$(timeout 2 "$PROBE_CODEX_BIN" --version 2>/dev/null \
    | head -n1 | awk '{print $NF}' 2>/dev/null || echo unknown)"
  [ -z "$CODEX_VERSION_DISPLAY" ] && CODEX_VERSION_DISPLAY="unknown"
fi
case "$PROBE_RESULT" in
  ok)
    print_row "Codex --plugin-dir" "$CODEX_VERSION_DISPLAY" "OK" "(kookr-fork)"
    ;;
  missing-flag)
    print_row "Codex --plugin-dir" "$CODEX_VERSION_DISPLAY" "WARN" "stock build — toolkit not injected"
    add_fix "Codex sessions launched by Kookr will NOT see kookr-toolkit. Run: pnpm codex:rebuild   (requires the kookr-fork at \$CODEX_SRC, default ~/git/codex; see jeanibarz/codex#52)"
    WARNS=$((WARNS + 1))
    ;;
  not-installed)
    if [ "${PROBE_TIMED_OUT:-0}" = "1" ]; then
      print_row "Codex --plugin-dir" "unknown" "INFO" "probe timed out — re-run pnpm doctor"
    else
      print_row "Codex CLI" "not installed" "INFO" "optional (Codex agent type)"
    fi
    ;;
  *)
    # Defensive default — if a future probe state is added but a doctor
    # update is forgotten, surface that as an unknown state rather than a
    # silently dropped row.
    print_row "Codex --plugin-dir" "$PROBE_RESULT" "WARN" "unknown probe state"
    ;;
esac

# ---------------------------------------------------------------------------
# Optional: free TCP ports
# Try `ss` first (Linux), fall back to `lsof` (macOS / minimal containers).
# A port being held isn't fatal — KOOKR_PORT can override 4800. Report as WARN.
# ---------------------------------------------------------------------------
port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 2
  fi
}

check_port() {
  local port="$1"
  local label="$2"
  local fix="$3"
  port_in_use "$port"
  case $? in
    0)
      print_row "Port $port" "in use" "WARN" "$label"
      add_fix "Port $port is in use. $fix"
      WARNS=$((WARNS + 1))
      ;;
    1)
      print_row "Port $port" "free" "OK" "$label"
      ;;
    *)
      print_row "Port $port" "unknown" "INFO" "install ss or lsof to probe"
      ;;
  esac
}

check_port 4800 "default backend" "Override with KOOKR_PORT=<n> or KOOKR_PORT=auto (issue #13)."
check_port 5173 "Vite dev server" "Stop the existing dev server, or run pnpm dev:frontend -- --port <n>."

# ---------------------------------------------------------------------------
# Optional: .env file (informational only)
# ---------------------------------------------------------------------------
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_FILE" ]; then
  # Summarize a few well-known feature flags without leaking the full file.
  ENV_FLAGS=()
  for key in KOOKR_STT KOOKR_TTS KOOKR_BYPASS_ALL_PERMISSIONS; do
    val="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2-)"
    if [ -n "$val" ]; then
      ENV_FLAGS+=("$key=$val")
    fi
  done
  if [ "${#ENV_FLAGS[@]}" -gt 0 ]; then
    print_row ".env file" "present" "OK" "(${ENV_FLAGS[*]})"
  else
    print_row ".env file" "present" "OK" "(no flags set)"
  fi
else
  print_row ".env file" "not present" "INFO" "optional; copy .env.example to enable voice/Telegram/etc."
fi

# ---------------------------------------------------------------------------
# Summary + actionable fixes
# ---------------------------------------------------------------------------
echo
if [ "$FAILS" -eq 0 ] && [ "$WARNS" -eq 0 ]; then
  printf "${C_GREEN}All checks passed.${C_RESET}\n"
  exit 0
fi

if [ "$FAILS" -eq 0 ]; then
  printf "${C_YELLOW}Required checks passed; %d optional warning(s).${C_RESET}\n" "$WARNS"
else
  printf "${C_RED}%d required check(s) failed${C_RESET}" "$FAILS"
  if [ "$WARNS" -gt 0 ]; then
    printf "${C_YELLOW}; %d warning(s)${C_RESET}" "$WARNS"
  fi
  printf ".\n"
fi

if [ "${#FIX_LINES[@]}" -gt 0 ]; then
  echo
  echo "Suggested fixes:"
  for line in "${FIX_LINES[@]}"; do
    printf "  - %s\n" "$line"
  done
fi

[ "$FAILS" -eq 0 ]
