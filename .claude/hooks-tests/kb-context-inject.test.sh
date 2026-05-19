#!/usr/bin/env bash
# Regression tests for hooks/kb-context-inject.sh
#
# The hook fires on UserPromptSubmit. When KOOKR_KB_CONTEXT_INJECT is truthy
# it runs a relevance-gated `kb search` and injects the post-gate
# knowledge-base context (RFC 018 §11). These cases exercise the shell
# wrapper end-to-end: each runs the hook with a sandboxed HOME and a `kb`
# shim on PATH that returns a canned JSON payload. The TS logic itself is
# unit-tested in src/core/kb-context-injection.test.ts.
#
# Run: bash .claude/hooks-tests/kb-context-inject.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/hooks/kb-context-inject.sh"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook script not found at %s\n' "$HOOK" >&2
  exit 1
fi

PASS=0
FAIL=0
FAILED_CASES=()

record_pass() { PASS=$((PASS + 1)); printf '  [OK]   %s\n' "$1"; }
record_fail() {
  FAIL=$((FAIL + 1))
  FAILED_CASES+=("$1")
  printf '  [FAIL] %s\n' "$1"
  [ -n "${2:-}" ] && printf '         %s\n' "$2"
}

# A gate_verdict in the given state, plus one result snippet.
# $2 (optional) sets low_confidence (default false).
gate_payload() {
  local state="$1" low="${2:-false}"
  jq -n --arg state "$state" --argjson low "$low" '{
    results: [{source: "kb/atomic-save.md", content: "FAISS saves swap a symlink atomically."}],
    gate_verdict: {
      schema_version: "kb.relevance-gate.v1", state: $state, low_confidence: $low,
      input_count: 3, output_count: 1, dropped: [], judge: {status: "succeeded"},
      empty_verdict_enabled: true
    }
  }'
}

# Run the hook with a sandboxed HOME and a `kb` shim returning $payload
# (or failing when $kb_fail is non-empty). $enabled gates the opt-in env var.
run_hook() {
  local stdin="$1" enabled="$2" payload="$3" kb_fail="${4:-}"
  local tmp; tmp=$(mktemp -d)
  mkdir -p "$tmp/bin"
  if [ -n "$kb_fail" ]; then
    printf '#!/usr/bin/env bash\nexit 3\n' > "$tmp/bin/kb"
  else
    printf '%s' "$payload" > "$tmp/payload.json"
    printf '#!/usr/bin/env bash\ncat %q\n' "$tmp/payload.json" > "$tmp/bin/kb"
  fi
  chmod +x "$tmp/bin/kb"
  local out
  out=$(
    cd "$REPO_ROOT"
    export HOME="$tmp"
    export PATH="$tmp/bin:$PATH"
    if [ -n "$enabled" ]; then export KOOKR_KB_CONTEXT_INJECT=1; else unset KOOKR_KB_CONTEXT_INJECT; fi
    printf '%s' "$stdin" | bash "$HOOK" 2>/dev/null
  ) || true
  rm -rf "$tmp"
  printf '%s' "$out"
}

ups_event() {
  jq -n --arg p "${1:-how does atomic save work}" \
    '{hook_event_name: "UserPromptSubmit", session_id: "t", cwd: "/tmp", prompt: $p}'
}

printf '\nRunning kb-context-inject tests\n\n'

# 1. Opt-out (default) → silent, kb never consulted.
out=$(run_hook "$(ups_event)" "" "$(gate_payload injected)")
if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
  record_pass "1: disabled by default → silent"
else
  record_fail "1: disabled by default → silent" "got: $(printf '%s' "$out" | head -c 200)"
fi

# 2. Enabled + injected verdict → inject the post-gate snippet, and the hook
#    must have invoked `kb` with --gate and --format=json. Standalone (not
#    via run_hook) so the recorded-argv file can be read before cleanup.
case_2() {
  local tmp; tmp=$(mktemp -d)
  mkdir -p "$tmp/bin"
  gate_payload injected > "$tmp/payload.json"
  printf '#!/usr/bin/env bash\nprintf "%%s " "$@" > %q\ncat %q\n' \
    "$tmp/kb-args.log" "$tmp/payload.json" > "$tmp/bin/kb"
  chmod +x "$tmp/bin/kb"
  local out args
  out=$(
    cd "$REPO_ROOT"
    export HOME="$tmp" PATH="$tmp/bin:$PATH" KOOKR_KB_CONTEXT_INJECT=1
    printf '%s' "$(ups_event)" | bash "$HOOK" 2>/dev/null
  ) || true
  args=$(cat "$tmp/kb-args.log" 2>/dev/null || true)
  rm -rf "$tmp"
  if printf '%s' "$out" | grep -q '<system-reminder>' \
     && printf '%s' "$out" | grep -q 'FAISS saves swap a symlink' \
     && printf '%s' "$args" | grep -q -- '--gate' \
     && printf '%s' "$args" | grep -q -- '--format=json'; then
    record_pass "2: enabled + injected → context injected via gated kb search"
  else
    record_fail "2: enabled + injected → context injected via gated kb search" \
      "out: $(printf '%s' "$out" | head -c 120) | kb args: $args"
  fi
}
case_2

# 3. Enabled + no-relevant-context → inject nothing (RFC §11).
out=$(run_hook "$(ups_event)" "1" "$(gate_payload 'no-relevant-context')")
if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
  record_pass "3: enabled + no-relevant-context → injects nothing"
else
  record_fail "3: enabled + no-relevant-context → injects nothing" "got: $(printf '%s' "$out" | head -c 200)"
fi

# 4. Enabled but `kb` fails → fail-open, inject nothing.
out=$(run_hook "$(ups_event)" "1" "" "fail")
if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
  record_pass "4: kb failure → fail-open silent"
else
  record_fail "4: kb failure → fail-open silent" "got: $(printf '%s' "$out" | head -c 200)"
fi

# 5. Empty stdin → silent.
out=$(run_hook "" "1" "$(gate_payload injected)")
if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
  record_pass "5: empty stdin → silent"
else
  record_fail "5: empty stdin → silent" "got: $(printf '%s' "$out" | head -c 200)"
fi

# 6. Non-UserPromptSubmit event → silent.
out=$(run_hook "$(jq -n '{hook_event_name: "Stop", session_id: "t"}')" "1" "$(gate_payload injected)")
if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
  record_pass "6: non-UserPromptSubmit event → silent"
else
  record_fail "6: non-UserPromptSubmit event → silent" "got: $(printf '%s' "$out" | head -c 200)"
fi

# 7. Enabled + empty-index → inject nothing (RFC §11, distinct from suppression).
out=$(run_hook "$(ups_event)" "1" "$(gate_payload 'empty-index')")
if [ -z "$(printf '%s' "$out" | tr -d '[:space:]')" ]; then
  record_pass "7: enabled + empty-index → injects nothing"
else
  record_fail "7: enabled + empty-index → injects nothing" "got: $(printf '%s' "$out" | head -c 200)"
fi

# 8. Enabled + low_confidence → injected snippet carries the [low-confidence] flag.
out=$(run_hook "$(ups_event)" "1" "$(gate_payload injected true)")
if printf '%s' "$out" | grep -q '\[low-confidence\]'; then
  record_pass "8: enabled + low_confidence → snippet flagged"
else
  record_fail "8: enabled + low_confidence → snippet flagged" "got: $(printf '%s' "$out" | head -c 200)"
fi

printf '\nResults: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed: %s\n' "${FAILED_CASES[*]}"
  exit 1
fi
exit 0
