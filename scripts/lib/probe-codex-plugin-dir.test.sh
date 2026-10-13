#!/usr/bin/env bash
# probe-codex-plugin-dir.test.sh — exercise the four PROBE_RESULT outcomes.
#
# Usage:
#   bash scripts/lib/probe-codex-plugin-dir.test.sh
#
# Exits 0 on success, 1 on the first failed assertion. No external deps.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
LIB="$SCRIPT_DIR/probe-codex-plugin-dir.sh"

if [ ! -f "$LIB" ]; then
  echo "FAIL: library not found at $LIB" >&2
  exit 1
fi

TMPDIR="$(mktemp -d -t kookr-probe-test.XXXXXX)"
trap 'rm -rf "$TMPDIR"' EXIT

# ---------------------------------------------------------------------------
# Stub binaries — each simulates one Codex CLI variant.
# ---------------------------------------------------------------------------

# Stock codex: --help mentions other flags but NOT --plugin-dir.
cat > "$TMPDIR/codex-stock" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "codex 0.42.0" ;;
  --help)    echo "Usage: codex [OPTIONS]"; echo "      --model <NAME>"; echo "      --full-auto" ;;
esac
EOF
chmod +x "$TMPDIR/codex-stock"

# Kookr-fork codex: --help advertises --plugin-dir.
cat > "$TMPDIR/codex-fork" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "codex 0.42.0-kookr.1" ;;
  --help)    echo "Usage: codex [OPTIONS]"; echo "      --plugin-dir <DIR>"; echo "      --full-auto" ;;
esac
EOF
chmod +x "$TMPDIR/codex-fork"

# Hanging codex: --help sleeps past the 5s probe budget.
cat > "$TMPDIR/codex-slow" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --help) sleep 10 ;;
  *)      echo "codex slow 0.0.0" ;;
esac
EOF
chmod +x "$TMPDIR/codex-slow"

# Absent codex: a path we know does not exist.
ABSENT_PATH="$TMPDIR/codex-does-not-exist"

# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------

PASS=0
FAIL=0

assert_eq() {
  local name="$1"; local expected="$2"; local actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    printf '  ok    %s = %s\n' "$name" "$actual"
  else
    FAIL=$((FAIL + 1))
    printf '  FAIL  %s: expected %s, got %s\n' "$name" "$expected" "$actual" >&2
  fi
}

run_case() {
  local label="$1"
  local bin_path="$2"
  echo
  echo "[case] $label"
  unset PROBE_RESULT PROBE_TIMED_OUT PROBE_CODEX_BIN
  KOOKR_CODEX_BIN="$bin_path"
  export KOOKR_CODEX_BIN
  # shellcheck source=./probe-codex-plugin-dir.sh
  . "$LIB"
  probe_codex_plugin_dir
}

# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

run_case "absent — KOOKR_CODEX_BIN points at non-existent path" "$ABSENT_PATH"
assert_eq "PROBE_RESULT" "not-installed" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_TIMED_OUT (unset)" "" "${PROBE_TIMED_OUT:-}"

# Directory-not-file: `[ -x DIR ]` is true for traversable directories; the
# probe must reject those as not-installed rather than treat them as binaries.
run_case "directory — KOOKR_CODEX_BIN points at a directory" "$TMPDIR"
assert_eq "PROBE_RESULT" "not-installed" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_TIMED_OUT (unset)" "" "${PROBE_TIMED_OUT:-}"

run_case "stock — codex without --plugin-dir" "$TMPDIR/codex-stock"
assert_eq "PROBE_RESULT" "missing-flag" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_TIMED_OUT (unset)" "" "${PROBE_TIMED_OUT:-}"

run_case "fork — codex with --plugin-dir" "$TMPDIR/codex-fork"
assert_eq "PROBE_RESULT" "ok" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_TIMED_OUT (unset)" "" "${PROBE_TIMED_OUT:-}"

run_case "timeout — codex --help hangs" "$TMPDIR/codex-slow"
assert_eq "PROBE_RESULT" "not-installed" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_TIMED_OUT" "1" "${PROBE_TIMED_OUT:-<unset>}"

# Stub that exits non-zero on --help (broken codex install: login required,
# missing config, etc.). Probe must NOT trust the output → not-installed.
cat > "$TMPDIR/codex-broken" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "codex 0.42.0"; exit 0 ;;
  --help)    echo "Error: please run codex login first" >&2; exit 2 ;;
esac
EOF
chmod +x "$TMPDIR/codex-broken"
run_case "broken — codex --help exits non-zero" "$TMPDIR/codex-broken"
assert_eq "PROBE_RESULT" "not-installed" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_TIMED_OUT (unset)" "" "${PROBE_TIMED_OUT:-}"

# Stock macOS has no GNU `timeout` (or Homebrew `gtimeout`); the probe must
# fall back to a perl alarm instead of failing every probe with 127. Simulate
# that host with a PATH holding only the tools the probe and stubs need.
NO_TIMEOUT_BIN="$TMPDIR/no-timeout-bin"
mkdir -p "$NO_TIMEOUT_BIN"
for tool in bash perl grep sleep; do
  ln -sf "$(command -v "$tool")" "$NO_TIMEOUT_BIN/$tool"
done
SAVED_PATH="$PATH"
PATH="$NO_TIMEOUT_BIN"
run_case "no timeout/gtimeout on PATH — fork still detected" "$TMPDIR/codex-fork"
PATH="$SAVED_PATH"
assert_eq "PROBE_RESULT" "ok" "${PROBE_RESULT:-<unset>}"
PATH="$NO_TIMEOUT_BIN"
run_case "no timeout/gtimeout on PATH — hang still bounded" "$TMPDIR/codex-slow"
PATH="$SAVED_PATH"
assert_eq "PROBE_RESULT" "not-installed" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_TIMED_OUT" "1" "${PROBE_TIMED_OUT:-<unset>}"

# KOOKR_CODEX_BIN unset → fallback to bare `codex` resolved via PATH.
# Synthesize a `codex` binary in $TMPDIR and prepend $TMPDIR to PATH so the
# fallback name resolves to the fork stub.
ln -sf "$TMPDIR/codex-fork" "$TMPDIR/codex"
echo
echo "[case] KOOKR_CODEX_BIN unset — falls back to bare \`codex\` on PATH"
unset PROBE_RESULT PROBE_TIMED_OUT KOOKR_CODEX_BIN
ORIG_PATH="$PATH"
PATH="$TMPDIR:$PATH"
export PATH
. "$LIB"
probe_codex_plugin_dir
PATH="$ORIG_PATH"
export PATH
assert_eq "PROBE_RESULT" "ok" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_CODEX_BIN" "codex" "${PROBE_CODEX_BIN:-<unset>}"

# KOOKR_CODEX_BIN unset in the shell but set in the server's .env: the probe
# must check the .env binary (the one the server launches), not the stock
# `codex` that happens to come first on PATH. Regression: prod-restart.sh
# warned about a stock PATH codex while the server ran the fork from .env.
ln -sf "$TMPDIR/codex-stock" "$TMPDIR/codex"
# The resolution runs through Node's own process.loadEnvFile(), so this file
# uses forms a hand-written parser tends to miss: `export`, spaces around `=`,
# and a trailing comment. The last assignment in one file wins.
cat > "$TMPDIR/server.env" <<EOF
# comment line
OTHER=1
export KOOKR_CODEX_BIN="$TMPDIR/codex-stock"
KOOKR_CODEX_BIN = $TMPDIR/codex-fork   # trailing comment
EOF
echo
echo "[case] KOOKR_CODEX_BIN unset — resolved from the env file, not PATH"
unset PROBE_RESULT PROBE_TIMED_OUT KOOKR_CODEX_BIN
PATH="$TMPDIR:$ORIG_PATH"
export PATH
. "$LIB"
probe_codex_plugin_dir "$TMPDIR/missing.env" "$TMPDIR/server.env"
PATH="$ORIG_PATH"
export PATH
assert_eq "PROBE_RESULT" "ok" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_CODEX_BIN" "$TMPDIR/codex-fork" "${PROBE_CODEX_BIN:-<unset>}"

# Quoted values are unwrapped, and the first env file that sets the key wins.
printf 'KOOKR_CODEX_BIN='"'"'%s'"'"'\n' "$TMPDIR/codex-stock" > "$TMPDIR/first.env"
echo
echo "[case] first env file that sets KOOKR_CODEX_BIN wins"
unset PROBE_RESULT PROBE_TIMED_OUT KOOKR_CODEX_BIN
. "$LIB"
probe_codex_plugin_dir "$TMPDIR/first.env" "$TMPDIR/server.env"
assert_eq "PROBE_RESULT" "missing-flag" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_CODEX_BIN" "$TMPDIR/codex-stock" "${PROBE_CODEX_BIN:-<unset>}"

# An exported KOOKR_CODEX_BIN beats the env file, as with process.loadEnvFile().
run_case "exported KOOKR_CODEX_BIN beats the env file" "$TMPDIR/codex-stock"
probe_codex_plugin_dir "$TMPDIR/server.env"
assert_eq "PROBE_RESULT" "missing-flag" "${PROBE_RESULT:-<unset>}"
unset KOOKR_CODEX_BIN

# Exported but EMPTY also beats the env file: loadEnvFile() never overrides a
# variable that exists, and the server then falls back to `codex` on PATH.
echo
echo "[case] exported-but-empty KOOKR_CODEX_BIN beats the env file"
unset PROBE_RESULT PROBE_TIMED_OUT
KOOKR_CODEX_BIN=""; export KOOKR_CODEX_BIN
PATH="$TMPDIR:$ORIG_PATH"; export PATH
. "$LIB"
probe_codex_plugin_dir "$TMPDIR/server.env"
PATH="$ORIG_PATH"; export PATH
assert_eq "PROBE_CODEX_BIN" "codex" "${PROBE_CODEX_BIN:-<unset>}"
assert_eq "PROBE_RESULT" "missing-flag" "${PROBE_RESULT:-<unset>}"
unset KOOKR_CODEX_BIN

# --ignore-exported: a server that never inherits this shell (systemd) must be
# probed from its env files only, even when this shell exports a value.
run_case "--ignore-exported drops the shell's value" "$TMPDIR/codex-stock"
probe_codex_plugin_dir --ignore-exported "$TMPDIR/server.env"
assert_eq "PROBE_CODEX_BIN" "$TMPDIR/codex-fork" "${PROBE_CODEX_BIN:-<unset>}"
assert_eq "PROBE_RESULT" "ok" "${PROBE_RESULT:-<unset>}"
assert_eq "caller's KOOKR_CODEX_BIN untouched" "$TMPDIR/codex-stock" "${KOOKR_CODEX_BIN:-<unset>}"
unset KOOKR_CODEX_BIN

# ---------------------------------------------------------------------------
# --base-environ: resolve against the running server's own environment dump
# (issue #3413). Emulates /proc/<pid>/environ with NUL-separated KEY=VALUE.
# ---------------------------------------------------------------------------

# NUL-separated environ dump, one KEY=VALUE per argument.
make_environ() {
  local pair
  for pair in "$@"; do
    printf '%s\0' "$pair"
  done
}

# Server PATH dirs holding exactly one `codex` each.
SERVER_FORK_BIN="$TMPDIR/server-fork-bin"
SERVER_STOCK_BIN="$TMPDIR/server-stock-bin"
mkdir -p "$SERVER_FORK_BIN" "$SERVER_STOCK_BIN"
ln -sf "$TMPDIR/codex-fork" "$SERVER_FORK_BIN/codex"
ln -sf "$TMPDIR/codex-stock" "$SERVER_STOCK_BIN/codex"

# A stock `codex` first on THIS shell's PATH, so a probe that leaked onto the
# shell PATH (the #3413 bug) would answer missing-flag.
ln -sf "$TMPDIR/codex-stock" "$TMPDIR/codex"

# item 1: KOOKR_CODEX_BIN unset → a bare `codex` resolves on the SERVER's PATH
# (fork), not this shell's PATH (stock first).
make_environ "PATH=$SERVER_FORK_BIN" > "$TMPDIR/environ-fork-path"
echo
echo "[case] --base-environ: bare codex resolves on the server's PATH, not the shell's"
unset PROBE_RESULT PROBE_TIMED_OUT KOOKR_CODEX_BIN
PATH="$TMPDIR:$ORIG_PATH"; export PATH
. "$LIB"
probe_codex_plugin_dir --base-environ "$TMPDIR/environ-fork-path"
PATH="$ORIG_PATH"; export PATH
assert_eq "PROBE_RESULT" "ok" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_CODEX_BIN" "$SERVER_FORK_BIN/codex" "${PROBE_CODEX_BIN:-<unset>}"

# item 2: KOOKR_CODEX_BIN set in the server environ (e.g. after
# `systemctl --user import-environment`) is honored even when this shell exports
# a different value and .env points elsewhere.
make_environ "PATH=$SERVER_STOCK_BIN" "KOOKR_CODEX_BIN=$TMPDIR/codex-fork" \
  > "$TMPDIR/environ-with-bin"
printf 'KOOKR_CODEX_BIN=%s\n' "$TMPDIR/codex-stock" > "$TMPDIR/base-env-dotenv-stock.env"
echo
echo "[case] --base-environ: KOOKR_CODEX_BIN from the environ beats the shell and .env"
unset PROBE_RESULT PROBE_TIMED_OUT
KOOKR_CODEX_BIN="$TMPDIR/codex-stock"; export KOOKR_CODEX_BIN
probe_codex_plugin_dir --base-environ "$TMPDIR/environ-with-bin" "$TMPDIR/base-env-dotenv-stock.env"
assert_eq "PROBE_RESULT" "ok" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_CODEX_BIN" "$TMPDIR/codex-fork" "${PROBE_CODEX_BIN:-<unset>}"
assert_eq "caller's KOOKR_CODEX_BIN untouched" "$TMPDIR/codex-stock" "${KOOKR_CODEX_BIN:-<unset>}"
unset KOOKR_CODEX_BIN

# .env applies on top of the environ when the environ does not set the key, with
# the server's own process.loadEnvFile() semantics.
make_environ "PATH=$SERVER_STOCK_BIN" > "$TMPDIR/environ-no-bin"
printf 'KOOKR_CODEX_BIN=%s\n' "$TMPDIR/codex-fork" > "$TMPDIR/base-env-dotenv-fork.env"
echo
echo "[case] --base-environ: .env sets KOOKR_CODEX_BIN when the environ does not"
unset PROBE_RESULT PROBE_TIMED_OUT KOOKR_CODEX_BIN
probe_codex_plugin_dir --base-environ "$TMPDIR/environ-no-bin" "$TMPDIR/base-env-dotenv-fork.env"
assert_eq "PROBE_RESULT" "ok" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_CODEX_BIN" "$TMPDIR/codex-fork" "${PROBE_CODEX_BIN:-<unset>}"

# A bare name the server's PATH cannot resolve is not-installed — the probe must
# NOT fall back to a `codex` on this shell's PATH (which here is the fork).
make_environ "PATH=$TMPDIR/empty-server-path" > "$TMPDIR/environ-empty-path"
ln -sf "$TMPDIR/codex-fork" "$TMPDIR/codex" # shell PATH fork would be a false OK
echo
echo "[case] --base-environ: bare codex absent from the server's PATH is not-installed"
unset PROBE_RESULT PROBE_TIMED_OUT KOOKR_CODEX_BIN
PATH="$TMPDIR:$ORIG_PATH"; export PATH
. "$LIB"
probe_codex_plugin_dir --base-environ "$TMPDIR/environ-empty-path"
PATH="$ORIG_PATH"; export PATH
assert_eq "PROBE_RESULT" "not-installed" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_CODEX_BIN (display name)" "codex" "${PROBE_CODEX_BIN:-<unset>}"

# An absent/unreadable environ dump (e.g. the server exited before the probe
# read /proc/<pid>/environ) resolves against an empty base → bare `codex` with
# no PATH → not-installed, never a shell-PATH fallback.
ln -sf "$TMPDIR/codex-fork" "$TMPDIR/codex" # a false OK if the shell PATH leaked
echo
echo "[case] --base-environ: a missing environ dump is not-installed"
unset PROBE_RESULT PROBE_TIMED_OUT KOOKR_CODEX_BIN
PATH="$TMPDIR:$ORIG_PATH"; export PATH
. "$LIB"
probe_codex_plugin_dir --base-environ "$TMPDIR/environ-does-not-exist"
PATH="$ORIG_PATH"; export PATH
assert_eq "PROBE_RESULT" "not-installed" "${PROBE_RESULT:-<unset>}"
assert_eq "PROBE_CODEX_BIN (display name)" "codex" "${PROBE_CODEX_BIN:-<unset>}"

# Errexit-safety invariant: when the probe completes via the timeout block
# (i.e. through the set +e/set -e bracket — NOT via the early `[ -f ]` exit),
# the caller's errexit state must be preserved. Use the fork stub so the
# function reaches and exits the bracketed block.
echo
echo "[case] errexit preserved across the timeout block"
( set -euo pipefail
  unset PROBE_RESULT PROBE_TIMED_OUT
  KOOKR_CODEX_BIN="$TMPDIR/codex-fork"; export KOOKR_CODEX_BIN
  . "$LIB"
  probe_codex_plugin_dir
  case $- in *e*) exit 0 ;; *) exit 1 ;; esac )
errexit_kept=$?
assert_eq "errexit still on after timeout-block path" "0" "$errexit_kept"

# And the same invariant for the early-exit path (absent binary).
( set -euo pipefail
  unset PROBE_RESULT PROBE_TIMED_OUT
  KOOKR_CODEX_BIN="$ABSENT_PATH"; export KOOKR_CODEX_BIN
  . "$LIB"
  probe_codex_plugin_dir
  case $- in *e*) exit 0 ;; *) exit 1 ;; esac )
errexit_kept_early=$?
assert_eq "errexit still on after early-exit path" "0" "$errexit_kept_early"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
