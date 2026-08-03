#!/usr/bin/env bash
# Regression tests for the PR checklist gate in hooks/pr-workflow-gate.sh (P3).
#
# The checklist gate is opt-in (KOOKR_PR_CHECKLIST=1 and/or
# ~/.kookr/pr-checklist-repos.json) and calls `kookr pr-checklist verify`. Here
# `kookr` is a shim whose exit code + stdout we control, so we exercise the
# gate's exit-code branching (allow / deny / fail-open) without the real engine.
#
# Every case overrides $HOME to a tmpdir and uses a command with explicit
# `-R owner/repo --head branch` so the /dev/shm state key is deterministic.
#
# Run: bash .claude/hooks-tests/pr-checklist-gate.test.sh

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/pr-workflow-gate.sh"
[ -f "$HOOK" ] || { printf 'FAIL: hook not found at %s\n' "$HOOK" >&2; exit 1; }

# The hook's pre-PR-review state gate is Linux-bound (STATE_DIR=/dev/shm). On a
# host without /dev/shm (e.g. macOS) the gate can't function, so skip cleanly
# rather than abort mid-suite under `set -e`.
if [ ! -d /dev/shm ]; then
  printf 'SKIP: /dev/shm unavailable — the hook state dir is Linux-only\n'
  exit 0
fi

SUFFIX="c$$-$(date +%s%N 2>/dev/null || date +%s)"
REPO="acme/widget-$SUFFIX"
REPO_BARE="widget-$SUFFIX"
BRANCH="feature-$SUFFIX"
STATE_FILE="/dev/shm/.pr-gate-widget-$SUFFIX-${BRANCH}-pre-done"

PASS=0
FAIL=0
FAILED=()
cleanup() { rm -f "$STATE_FILE" 2>/dev/null || true; }
trap cleanup EXIT

# Issue #1968: empty touch is rejected; mint a producer-token pre-done marker.
write_valid_state() {
  local home="$1"
  mkdir -p "$home/.kookr"
  HOME="$home" KOOKR_REVIEW_MARKER_SECRET_FILE="$home/.kookr/review-marker-secret" \
    bash "$REPO_ROOT/scripts/write-pr-gate-marker.sh" \
      --repo "$REPO_BARE" --branch "$BRANCH" --sha "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" \
      >/dev/null
}

# --- Build a bin dir with the tools the hook needs, minus kookr. -------------
TOOLS_BIN=$(mktemp -d)
# openssl is required by review-marker-auth.sh HMAC verification (issue #1968).
for t in bash sh jq git date tr sed grep head cut dirname basename cat mkdir rm env printf openssl awk readlink; do
  p=$(command -v "$t" 2>/dev/null || true)
  [ -n "$p" ] && ln -sf "$p" "$TOOLS_BIN/$t"
done

# --- Shim `kookr` in its own dir (exit code + output are env-controlled). -----
KOOKR_BIN=$(mktemp -d)
cat > "$KOOKR_BIN/kookr" <<'SHIM'
#!/usr/bin/env bash
touch "${KOOKR_CALLED:-/dev/null}" 2>/dev/null || true
[ -n "${FAKE_KOOKR_OUT:-}" ] && printf '%s\n' "$FAKE_KOOKR_OUT"
exit "${FAKE_KOOKR_RC:-0}"
SHIM
chmod +x "$KOOKR_BIN/kookr"
trap 'rm -rf "$TOOLS_BIN" "$KOOKR_BIN"; cleanup' EXIT

mk_payload() {
  local cmd="$1" cwd="$2"
  jq -n --arg cmd "$cmd" --arg cwd "$cwd" \
    '{tool_name:"Bash", cwd:$cwd, tool_input:{command:$cmd}}'
}

# run_hook <payload> <home> <path> [extra env assignments...]
# Captures stdout+stderr; prints them.
run_hook() {
  local payload="$1" home="$2" path="$3"; shift 3
  (
    export HOME="$home" PATH="$path" "$@"
    printf '%s' "$payload" | bash "$HOOK" 2>&1
  ) || true
}

check() {
  local name="$1" cond="$2"
  if [ "$cond" = "1" ]; then PASS=$((PASS+1)); printf 'ok   - %s\n' "$name"
  else FAIL=$((FAIL+1)); FAILED+=("$name"); printf 'FAIL - %s\n' "$name"; fi
}

CMD="gh pr create -R $REPO --head $BRANCH --body \"- [x] <!-- pr:mbse --> x\""

# ---------------------------------------------------------------------------
# 1. Default OFF (no env, no scope file): gate is a no-op, kookr is never
#    called, and (state file present) the PR is allowed.
# ---------------------------------------------------------------------------
H=$(mktemp -d); mkdir -p "$H/.kookr"; write_valid_state "$H"
CALLED="$H/called"
OUT=$(run_hook "$(mk_payload "$CMD" "$H")" "$H" "$TOOLS_BIN:$KOOKR_BIN" KOOKR_CALLED="$CALLED")
grep -q '"permissionDecision": "deny"' <<<"$OUT" && d=1 || d=0
[ "$d" = "0" ] && [ ! -f "$CALLED" ] && r=1 || r=0
check "default OFF: allow + kookr never spawned" "$r"
rm -rf "$H"; rm -f "$STATE_FILE"

# ---------------------------------------------------------------------------
# 2. Enabled (env) + engine returns 2 → DENY with the checklist reason. No
#    state file needed: the checklist deny exits before the pre-PR-review gate.
# ---------------------------------------------------------------------------
H=$(mktemp -d); mkdir -p "$H/.kookr"
OUT=$(run_hook "$(mk_payload "$CMD" "$H")" "$H" "$TOOLS_BIN:$KOOKR_BIN" \
      KOOKR_PR_CHECKLIST=1 FAKE_KOOKR_RC=2 FAKE_KOOKR_OUT="MBSE-DRIFT-MARKER-mbse-checked-but-not-touched")
# Deny key present, the boilerplate reason present, AND the engine's own findings
# text survived into the reason (guards against a dropped ${findings} interpolation).
grep -q '"permissionDecision": "deny"' <<<"$OUT" \
  && grep -q 'PR checklist verification failed' <<<"$OUT" \
  && grep -q 'MBSE-DRIFT-MARKER-mbse-checked-but-not-touched' <<<"$OUT" && r=1 || r=0
check "enabled + exit 2: fail CLOSED (deny) with checklist reason + findings text" "$r"
rm -rf "$H"

# ---------------------------------------------------------------------------
# 3. Enabled (env) + engine returns 0 → allow (state file lets pre-PR gate pass).
# ---------------------------------------------------------------------------
H=$(mktemp -d); mkdir -p "$H/.kookr"; write_valid_state "$H"
OUT=$(run_hook "$(mk_payload "$CMD" "$H")" "$H" "$TOOLS_BIN:$KOOKR_BIN" \
      KOOKR_PR_CHECKLIST=1 FAKE_KOOKR_RC=0)
grep -q '"permissionDecision": "deny"' <<<"$OUT" && r=0 || r=1
check "enabled + exit 0: allow" "$r"
rm -rf "$H"; rm -f "$STATE_FILE"

# ---------------------------------------------------------------------------
# 4. Enabled (env) + kookr NOT on PATH → fail OPEN: allowed, a visible degrade
#    line on stderr, and a JSONL record in pr-checklist-degrade.log.
# ---------------------------------------------------------------------------
H=$(mktemp -d); mkdir -p "$H/.kookr"; write_valid_state "$H"
OUT=$(run_hook "$(mk_payload "$CMD" "$H")" "$H" "$TOOLS_BIN" KOOKR_PR_CHECKLIST=1)
grep -q '"permissionDecision": "deny"' <<<"$OUT" && d=1 || d=0
grep -q 'checklist gate degraded' <<<"$OUT" && s=1 || s=0
LOG="$H/.kookr/pr-checklist-degrade.log"
[ -f "$LOG" ] && grep -q '"event":"fail-open"' "$LOG" && l=1 || l=0
[ "$d" = "0" ] && [ "$s" = "1" ] && [ "$l" = "1" ] && r=1 || r=0
check "enabled + no binary: fail OPEN + stderr note + degrade log" "$r"
rm -rf "$H"; rm -f "$STATE_FILE"

# ---------------------------------------------------------------------------
# 5. Kill-switch KOOKR_PR_CHECKLIST=0 wins even when the scope file lists the
#    repo → gate OFF, kookr never called.
# ---------------------------------------------------------------------------
H=$(mktemp -d); mkdir -p "$H/.kookr"; write_valid_state "$H"
printf '["%s"]\n' "$REPO" > "$H/.kookr/pr-checklist-repos.json"
CALLED="$H/called"
OUT=$(run_hook "$(mk_payload "$CMD" "$H")" "$H" "$TOOLS_BIN:$KOOKR_BIN" \
      KOOKR_PR_CHECKLIST=0 KOOKR_CALLED="$CALLED")
grep -q '"permissionDecision": "deny"' <<<"$OUT" && d=1 || d=0
[ "$d" = "0" ] && [ ! -f "$CALLED" ] && r=1 || r=0
check "kill-switch =0 overrides scope list: OFF, kookr never spawned" "$r"
rm -rf "$H"; rm -f "$STATE_FILE"

# ---------------------------------------------------------------------------
# 6. Scope list opt-in (no env) + engine returns 2 → DENY (proves the scope
#    file alone enables the gate).
# ---------------------------------------------------------------------------
H=$(mktemp -d); mkdir -p "$H/.kookr"
printf '["%s"]\n' "$REPO" > "$H/.kookr/pr-checklist-repos.json"
OUT=$(run_hook "$(mk_payload "$CMD" "$H")" "$H" "$TOOLS_BIN:$KOOKR_BIN" \
      FAKE_KOOKR_RC=2 FAKE_KOOKR_OUT="SCOPE-DRIFT-MARKER")
grep -q '"permissionDecision": "deny"' <<<"$OUT" \
  && grep -q 'PR checklist verification failed' <<<"$OUT" \
  && grep -q 'SCOPE-DRIFT-MARKER' <<<"$OUT" && r=1 || r=0
check "scope list opt-in (no env): enabled, deny on exit 2 + findings text" "$r"
rm -rf "$H"

# ---------------------------------------------------------------------------
# 7. Scope file present but this repo NOT listed (no env) → gate OFF, kookr
#    never called (the scope "out" branch).
# ---------------------------------------------------------------------------
H=$(mktemp -d); mkdir -p "$H/.kookr"; write_valid_state "$H"
printf '["someone/other-repo"]\n' > "$H/.kookr/pr-checklist-repos.json"
CALLED="$H/called"
OUT=$(run_hook "$(mk_payload "$CMD" "$H")" "$H" "$TOOLS_BIN:$KOOKR_BIN" KOOKR_CALLED="$CALLED")
grep -q '"permissionDecision": "deny"' <<<"$OUT" && d=1 || d=0
[ "$d" = "0" ] && [ ! -f "$CALLED" ] && r=1 || r=0
check "scope file present but repo not listed: OFF, kookr never spawned" "$r"
rm -rf "$H"; rm -f "$STATE_FILE"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed: %s\n' "${FAILED[*]}" >&2
  exit 1
fi
