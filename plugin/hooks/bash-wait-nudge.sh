#!/usr/bin/env bash
# Bash wait/test-output nudge (PreToolUse, matcher: Bash). NEVER blocks.
#
# Two patterns cost agents real time (umbrella #3691):
#  (a) `while|until ... pgrep -f ...`: the loop's own shell matches the pattern,
#      so it never exits until the tool timeout.
#  (b) a test/gate command piped to `tail`/`head` with no `tee`, `pipefail` or
#      PIPESTATUS: the full log is lost and the exit code is masked.
# On a match the hook adds a one-paragraph suggestion to the agent's context.
# Safe forms stay silent. Every failure path exits 0 with no output.
# Opt out: KOOKR_BASH_WAIT_NUDGE_SKIP=1.
set -u

[ "${KOOKR_BASH_WAIT_NUDGE_SKIP:-}" = "1" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

cmd=$(jq -r 'select(.tool_name == "Bash") | .tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

HELPER='${CLAUDE_PLUGIN_ROOT}/hooks/kookr-wait.sh'
msg=""

# (a) loop keyword, then pgrep with an -f style flag (-f, -fa, -af, -fl ...).
if [[ "$cmd" =~ (^|[^[:alnum:]_])(while|until)[[:space:]] ]] \
  && [[ "$cmd" =~ pgrep[[:space:]]+(-[a-zA-Z]*f[a-zA-Z]*|--full)([[:space:]]|$) ]]; then
  msg="Wait-loop nudge: \`pgrep -f\` inside a while/until loop matches the loop's own shell (its command line contains the pattern), so the loop never exits. Wait on a PID or an exit-marker file instead: \`$HELPER --pid <PID> --timeout 600\` or \`$HELPER --file \"\$LOG.exit\"\` (job: \`( cmd >\"\$LOG\" 2>&1; echo \$? >\"\$LOG.exit\" ) &\`). For a background Bash task, wait for its completion notification or use Monitor."
fi

# (b) test/gate command piped into tail/head, with no tee/pipefail/PIPESTATUS.
if [ -z "$msg" ] \
  && [[ "$cmd" =~ (pnpm|npm|yarn|bun)[[:space:]]+(run[[:space:]]+)?(test|verify|check|gate|lint|typecheck|merge)|vitest|playwright[[:space:]]+test|scripts/verify\.sh|pre-push ]] \
  && [[ "$cmd" =~ \|[[:space:]]*(tail|head)([[:space:]]|$) ]] \
  && ! [[ "$cmd" =~ (tee|pipefail|PIPESTATUS) ]]; then
  msg="Test-output nudge: piping a test/gate command straight into \`tail\`/\`head\` discards the full log and masks the exit code (a failed run can look like success). Keep both: \`cmd 2>&1 | tee \"\$LOG\" | tail -40; echo \"exit=\${PIPESTATUS[0]}\"\` — then read \$LOG instead of re-running to see a cut-off failure."
fi

[ -n "$msg" ] || exit 0
jq -n --arg ctx "$msg" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}' 2>/dev/null
exit 0
