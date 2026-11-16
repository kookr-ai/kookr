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
check "malformed JSON exits 0, no output" bash -c "[ \"\$(printf 'not json' | '$HOOK' | wc -c)\" -eq 0 ]"
check "SKIP env silences the hook" bash -c "[ \"\$(jq -n '{tool_name:\"Bash\",tool_input:{command:\"pnpm test | tail\"}}' | KOOKR_BASH_WAIT_NUDGE_SKIP=1 '$HOOK' | wc -c)\" -eq 0 ]"
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

# #4110: pkill -f, git push piped to tail/head, gh issue view --comments without --json.
# warns(): a nudge with exit 0 and no permission decision (never blocks).
warns() { local out rc=0; out=$(run "$1") || rc=$?; [ "$rc" -eq 0 ] && [ -n "$out" ] \
  && jq -e '(.hookSpecificOutput.additionalContext|test("nudge")) and (.hookSpecificOutput.permissionDecision == null)' >/dev/null 2>&1 <<<"$out" \
  && ! grep -q deny <<<"$out"; }
check "pkill -f warns without blocking" warns 'pkill -f "node server.js"'
check "pkill -9 -f warns" warns 'pkill -9 -f vitest'
check "pkill -fi warns" warns 'sleep 1; pkill -fi codex'
check "pkill --full warns" warns 'pkill --full "pnpm dev"'
check "pkill nudge suggests killing by PID" says 'pkill -f x' 'kill <PID>'
check "pkill without -f is silent" silent 'pkill node'
check "kill by PID is silent" silent 'kill 12345'
check "git push | tail warns without blocking" warns 'git push origin HEAD 2>&1 | tail -20'
check "git push | head warns" warns 'git push -u origin feat/x | head -5'
check "git -C dir push | tail warns" warns 'git -C ../wt push 2>&1 | tail -30'
check "git push nudge suggests tee" says 'git push 2>&1 | tail -5' 'tee'
check "git push without a pipe is silent" silent 'git push origin HEAD'
check "git push piped through tee is silent" silent 'git push origin HEAD 2>&1 | tee "$LOG" | tail -20'
check "gh issue view --comments warns without blocking" warns 'gh issue view 2765 --comments'
check "gh issue view -R repo --comments warns" warns 'gh issue view 12 -R o/r --comments 2>&1'
check "gh nudge suggests --json title,body,comments" says 'gh issue view 1 --comments' '--json title,body,comments'
check "gh issue view --comments --json is silent" silent 'gh issue view 2765 --comments --json title,body,comments'
check "gh issue view --json comments is silent" silent 'gh issue view 2765 --json comments'
check "gh issue view without --comments is silent" silent 'gh issue view 2765'
check "gh pr view --comments is silent" silent 'gh pr view 5 --comments'

# #4121: `-c` is gh's short form of --comments; only the gh segment's own -c counts.
check "gh issue view -c warns without blocking" warns 'gh issue view 4121 -c'
check "gh issue view -R repo -c 2>&1 warns" warns 'gh issue view 12 -R o/r -c 2>&1'
check "gh issue view -c after 2>&1 warns" warns 'gh issue view 12 2>&1 -c'
check "gh issue view -wc (combined short flags) warns" warns 'gh issue view 7 -wc'
check "gh issue view -cw (combined short flags) warns" warns 'gh issue view 7 -cw'
check "second gh issue view -c on the line warns" warns 'gh issue view 1 -R o/r; gh issue view 2 -c'
check "gh -c nudge suggests --json title,body,comments" says 'gh issue view 1 -c' '--json title,body,comments'
check "gh issue view -c --json is silent" silent 'gh issue view 4121 -c --json title,body,comments'
check "grep -c after gh issue view is silent" silent 'gh issue view 5 --json body && grep -c x f'
check "grep -c after plain gh issue view is silent" silent 'gh issue view 5 | grep -c x'
check "git -c before gh issue view is silent" silent 'git -c core.pager=cat log -1; gh issue view 5'
check "bash -c wrapping a later command is silent" silent "gh issue view 5; bash -c 'echo hi'"
check "gh issue view -R with a c-prefixed value is silent" silent 'gh issue view 5 -R cool/repo'
check "gh pr view -c is silent" silent 'gh pr view 5 -c'
check "git -c after gh issue view is silent" silent 'gh issue view 5 && git -c k=v log'
check "grep -c on the next line is silent" silent $'gh issue view 5\ngrep -c x f'
check "gh issue view -c on a later line warns" warns $'echo hi\ngh issue view 5 -c'
check "sort -c after a gh issue view process substitution is silent" silent 'diff <(gh issue view 5) <(sort -c f)'
check "grep -c after a gh issue view command substitution is silent" silent 'x=`gh issue view 5` && grep -c y f'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
