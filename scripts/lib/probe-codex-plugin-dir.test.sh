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
