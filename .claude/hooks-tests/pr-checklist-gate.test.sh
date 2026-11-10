#!/usr/bin/env bash
# Regression tests for the PR checklist gate in hooks/pr-workflow-gate.sh (P3).
#
# The checklist gate is template-driven (the repo's PR template declares
# kookr:check markers, or a tracked .kookr/pr-checklist.json; legacy opt-ins:
# KOOKR_PR_CHECKLIST=1 and ~/.kookr/pr-checklist-repos.json) and calls `kookr pr-checklist verify`. Here
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
for t in bash sh jq git date tr sed grep head cut dirname basename cat mkdir rm env printf openssl awk readlink touch; do
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

# ---------------------------------------------------------------------------
# 8-13. Template-driven opt-in: no env, no scope file; the session cwd is a repo
#       dir. Markers in the PR template (any accepted location / legacy pr:), or
#       a .kookr/pr-checklist.json, enable the gate; a marker-less template or
#       no template leaves it OFF (kookr never spawned).
# ---------------------------------------------------------------------------
# mk_repo <dir> [remote-slug]: a real git repo (the hook resolves toplevel + remotes).
mk_repo() {
  mkdir -p "$1"
  git -C "$1" init -q
  git -C "$1" remote add origin "https://github.com/${2:-$REPO}.git"
}
tpl_case() { # <name> <relative template/config path> <content> <expect: deny|off> [session subdir] [command]
  local name="$1" rel="$2" content="$3" expect="$4" sub="${5:-}" cmd="${6:-$CMD}"
  local H; H=$(mktemp -d); mkdir -p "$H/.kookr"
  mk_repo "$H/repo"; mkdir -p "$H/repo/$(dirname "$rel")" "$H/repo/$sub"
  write_valid_state "$H"
  printf '%s\n' "$content" > "$H/repo/$rel"
  local called="$H/called" out
  out=$(run_hook "$(mk_payload "$cmd" "$H/repo/$sub")" "$H" "$TOOLS_BIN:$KOOKR_BIN" \
        KOOKR_CALLED="$called" FAKE_KOOKR_RC=2 FAKE_KOOKR_OUT="TPL-DRIFT-MARKER")
  local r=0
  if [ "$expect" = "deny" ]; then
    grep -q '"permissionDecision": "deny"' <<<"$out" && grep -q 'TPL-DRIFT-MARKER' <<<"$out" && [ -f "$called" ] && r=1
  else
    ! grep -q 'PR checklist verification failed' <<<"$out" && [ ! -f "$called" ] && r=1
  fi
  check "$name" "$r"
  rm -rf "$H"; rm -f "$STATE_FILE"
}
MARK='- [ ] <!-- kookr:check:tests --> tests'
tpl_case "template markers (.github/pull_request_template.md, no env/scope): gate ON, deny on exit 2" \
  .github/pull_request_template.md "$MARK" deny
tpl_case "template markers (root PULL_REQUEST_TEMPLATE.md): gate ON" PULL_REQUEST_TEMPLATE.md "$MARK" deny
tpl_case "template markers (docs/ location): gate ON" docs/pull_request_template.md "$MARK" deny
tpl_case "legacy <!-- pr:id --> marker in template: gate ON" .github/PULL_REQUEST_TEMPLATE.md \
  '- [ ] <!-- pr:mbse --> mbse' deny
tpl_case "tracked .kookr/pr-checklist.json alone: gate ON" .kookr/pr-checklist.json '{"disable":[]}' deny
tpl_case "template WITHOUT markers: gate OFF, kookr never spawned" .github/pull_request_template.md \
  '## Summary' off

tpl_case "session cwd in a repo SUBDIRECTORY still finds the toplevel template: gate ON" \
  .github/pull_request_template.md "$MARK" deny src/deep
tpl_case "foreign repo via -R (cwd repo has a marker template): no opinion, gate OFF" \
  .github/pull_request_template.md "$MARK" off "" \
  "gh pr create -R upstream/oss-$SUFFIX --head me:fix --title x --body \"plain oss body\""

# 13b. Marker template in the session repo but --head worktree unmappable → fail OPEN, logged.
H=$(mktemp -d); mkdir -p "$H/.kookr"; mk_repo "$H/repo"; mkdir -p "$H/repo/.github"; write_valid_state "$H"
printf '%s\n' "$MARK" > "$H/repo/.github/pull_request_template.md"
GHOST="gh pr create -R $REPO --head ghost-branch --body-file b.md"
OUT=$(run_hook "$(mk_payload "$GHOST" "$H/repo")" "$H" "$TOOLS_BIN:$KOOKR_BIN")
# (the separate pre-PR-review state gate may still deny a branch with no marker; only the checklist deny matters here)
grep -q 'PR checklist verification failed' <<<"$OUT" && d=1 || d=0
grep -q 'effective checklist cwd unavailable' "$H/.kookr/pr-checklist-degrade.log" 2>/dev/null && l=1 || l=0
[ "$d" = "0" ] && [ "$l" = "1" ] && r=1 || r=0
check "marker template + unmappable --head worktree: fail OPEN with a degrade-log record" "$r"
rm -rf "$H"; rm -f "$STATE_FILE"

# 14. Kill-switch still wins over a marker template.
H=$(mktemp -d); mkdir -p "$H/.kookr"; mk_repo "$H/repo"; mkdir -p "$H/repo/.github"; write_valid_state "$H"
printf '%s\n' "$MARK" > "$H/repo/.github/pull_request_template.md"
CALLED="$H/called"
OUT=$(run_hook "$(mk_payload "$CMD" "$H/repo")" "$H" "$TOOLS_BIN:$KOOKR_BIN" KOOKR_PR_CHECKLIST=0 KOOKR_CALLED="$CALLED" FAKE_KOOKR_RC=2)
grep -q '"permissionDecision": "deny"' <<<"$OUT" && d=1 || d=0
[ "$d" = "0" ] && [ ! -f "$CALLED" ] && r=1 || r=0
check "kill-switch =0 overrides a marker template: OFF" "$r"
rm -rf "$H"; rm -f "$STATE_FILE"

# 15. Marker template + kookr missing → still fail OPEN with degrade log + note.
H=$(mktemp -d); mkdir -p "$H/.kookr"; mk_repo "$H/repo"; mkdir -p "$H/repo/.github"; write_valid_state "$H"
printf '%s\n' "$MARK" > "$H/repo/.github/pull_request_template.md"
OUT=$(run_hook "$(mk_payload "$CMD" "$H/repo")" "$H" "$TOOLS_BIN")
grep -q '"permissionDecision": "deny"' <<<"$OUT" && d=1 || d=0
grep -q 'checklist gate degraded' <<<"$OUT" && s=1 || s=0
[ -f "$H/.kookr/pr-checklist-degrade.log" ] && grep -q '"event":"fail-open"' "$H/.kookr/pr-checklist-degrade.log" && l=1 || l=0
[ "$d" = "0" ] && [ "$s" = "1" ] && [ "$l" = "1" ] && r=1 || r=0
check "marker template + no kookr binary: fail OPEN + note + degrade log" "$r"
rm -rf "$H"; rm -f "$STATE_FILE"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed: %s\n' "${FAILED[*]}" >&2
  exit 1
fi
