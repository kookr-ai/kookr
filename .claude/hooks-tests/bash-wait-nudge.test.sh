#!/usr/bin/env bash
# Tests for plugin/hooks/bash-wait-nudge.sh and plugin/hooks/kookr-wait.sh (#3693).
# The nudge fires on self-matching `pgrep -f` loops and on test output piped to
# tail/head without tee/pipefail; it stays silent on safe forms and never blocks.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/plugin/hooks/bash-wait-nudge.sh"
WAIT="$REPO_ROOT/plugin/hooks/kookr-wait.sh"
HOOKS_JSON="$REPO_ROOT/plugin/hooks/hooks.json"
PASS=0; FAIL=0
TMP=$(mktemp -d); trap "rm -rf '$TMP'" EXIT

check() { local l="$1"; shift; if "$@"; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$l"; else FAIL=$((FAIL+1)); printf 'FAIL: %s\n' "$l" >&2; fi; }

run() { jq -n --arg c "$1" --arg t "${2:-Bash}" '{tool_name:$t,tool_input:{command:$c}}' | "$HOOK"; }
nudges() { local out; out=$(run "$@"); printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName=="PreToolUse" and (.hookSpecificOutput.additionalContext|test("nudge"))' >/dev/null 2>&1; }
silent() { local out rc=0; out=$(run "$@") || rc=$?; [ "$rc" -eq 0 ] && [ -z "$out" ]; }
says() { local out; out=$(run "$1"); [[ "$out" == *"$2"* ]]; }

# (a) pgrep -f loops
check "while pgrep -f nudges" nudges 'while pgrep -f "vitest run"; do sleep 5; done'
check "until ! pgrep -fa nudges" nudges 'until ! pgrep -fa codex; do sleep 2; done'
check "multi-line loop nudges" nudges $'while true; do\n  pgrep -f foo || break\n  sleep 1\ndone'
check "pgrep -a -f nudges" nudges 'while pgrep -a -f x; do sleep 1; done'
check "pgrep -u USER -f nudges" nudges 'while pgrep -u $USER -f x; do sleep 1; done'
check "|& tail nudges" nudges 'pnpm test |& tail -5'
check "'guarantee' is not tee" nudges 'pnpm test -- --grep guarantee | tail -5'
check "pgrep nudge names the helper" says 'while pgrep -f x; do sleep 1; done' 'kookr-wait.sh'
check "pgrep -f outside a loop is silent" silent 'pgrep -f sleepy | head -1'
check "pgrep -x in a loop is silent" silent 'while pgrep -x node; do sleep 1; done'
check "while kill -0 is silent" silent 'while kill -0 123 2>/dev/null; do sleep 1; done'
check "a word containing 'while' is silent" silent 'echo meanwhile; pgrep -f x'

# (b) test output piped to tail/head
check "pnpm test | tail nudges" nudges 'pnpm test 2>&1 | tail -40'
check "vitest | head nudges" nudges 'npx vitest run src/a.test.ts | head -50'
check "scripts/verify.sh | tail nudges" nudges 'bash scripts/verify.sh 2>&1 | tail -20'
check "tail nudge shows the safe form" says 'pnpm test | tail -5' 'PIPESTATUS'
check "tee is silent" silent 'pnpm test 2>&1 | tee "$LOG" | tail -40; echo "exit=${PIPESTATUS[0]}"'
check "pipefail is silent" silent 'set -o pipefail; pnpm test 2>&1 | tail -40'
check "non-test command | tail is silent" silent 'git log --oneline | tail -5'
check "test command without a pipe is silent" silent 'pnpm test'

# never blocks / fails open
check "non-Bash tool is silent" silent 'while pgrep -f x; do :; done' Edit
check "empty command is silent" silent ''
check "malformed JSON exits 0, no output" bash -c "printf 'not json' | '$HOOK' | wc -c | grep -qx 0"
check "SKIP env silences the hook" bash -c "jq -n '{tool_name:\"Bash\",tool_input:{command:\"pnpm test | tail\"}}' | KOOKR_BASH_WAIT_NUDGE_SKIP=1 '$HOOK' | wc -c | grep -qx 0"
check "registered for Bash in hooks.json" jq -e '.hooks.PreToolUse[]|select(.matcher=="Bash")|.hooks[]|select(.command|endswith("bash-wait-nudge.sh"))' "$HOOKS_JSON"

# kookr-wait.sh
sleep 30 & P=$!
check "wait --pid times out while alive" bash -c "'$WAIT' --pid $P --timeout 1 --interval 1 2>/dev/null; [ \$? -eq 124 ]"
kill $P 2>/dev/null; wait $P 2>/dev/null || true
check "wait --pid returns 0 for a dead pid" "$WAIT" --pid "$P" --timeout 5
( sleep 1; echo 7 >"$TMP/m" ) &
check "wait --file prints the marker's first line" bash -c "[ \"\$('$WAIT' --file '$TMP/m' --timeout 10 --interval 1)\" = 7 ]"
check "wait --file times out when absent" bash -c "'$WAIT' --file '$TMP/none' --timeout 1 --interval 1 2>/dev/null; [ \$? -eq 124 ]"
check "wait accepts a leading-zero interval" bash -c "'$WAIT' --file '$TMP/none' --interval 08 --timeout 1 2>/dev/null; [ \$? -eq 124 ]"
check "wait rejects missing target" bash -c "'$WAIT' --pid 2>/dev/null; [ \$? -eq 2 ]"
check "wait rejects non-numeric timeout" bash -c "'$WAIT' --pid 1 --timeout x 2>/dev/null; [ \$? -eq 2 ]"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
