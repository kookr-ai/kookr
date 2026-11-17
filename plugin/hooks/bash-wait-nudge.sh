#!/usr/bin/env bash
# Bash wait/test-output nudge (PreToolUse, matcher: Bash). NEVER blocks.
#
# These patterns cost agents real time (umbrella #3691, #4110):
#  (a) `while|until ... pgrep -f ...`: the loop's own shell matches the pattern,
#      so it never exits until the tool timeout.
#  (b) a test/gate command (including `git push`, which runs the pre-push gate)
#      piped to `tail`/`head` with no `tee`, `pipefail` or PIPESTATUS: the full
#      log is lost and the exit code is masked.
#  (c) `pkill -f PATTERN`: the agent's own shell has PATTERN in its command
#      line, so pkill kills the shell running it (and other tasks' processes).
#  (d) `gh issue view N --comments` without `--json`: off a terminal it prints
#      only the comments (nothing at all for an issue without comments).
# On a match the hook adds a one-paragraph suggestion to the agent's context.
# Safe forms stay silent. Every failure path exits 0 with no output.
# Opt out: KOOKR_BASH_WAIT_NUDGE_SKIP=1.
set -u

[ "${KOOKR_BASH_WAIT_NUDGE_SKIP:-}" = "1" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

cmd=$(jq -r 'select(.tool_name == "Bash") | .tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

# Regex held in a variable: an unquoted `&` is a syntax error inside [[ ]].
PIPE_RE='\|&?[[:space:]]*(tail|head)([[:space:]]|$)'
HELPER='${CLAUDE_PLUGIN_ROOT}/hooks/kookr-wait.sh'
# `git push` or `git -C DIR push`: the push runs the pre-push test gate.
GIT_PUSH_RE='(^|[^[:alnum:]_-])git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+push([[:space:]]|$)'
# pkill with an -f style flag (-f, -9 -f, -fi, --full), after any other options.
PKILL_RE='(^|[^[:alnum:]_-])pkill([[:space:]]+[^[:space:];|&]+)*[[:space:]]+(-[a-zA-Z]*f[a-zA-Z]*|--full)([[:space:]]|$)'
GH_VIEW_RE='(^|[^[:alnum:]_-])gh[[:space:]]+issue[[:space:]]+view([[:space:]]|$)'
msg=""

# (a) loop keyword, then pgrep with an -f style flag (-f, -fa, -af, -fl ...).
if [[ "$cmd" =~ (^|[^[:alnum:]_])(while|until)[[:space:]] ]] \
  && [[ "$cmd" =~ pgrep([[:space:]]+[^[:space:];|&]+)*[[:space:]]+(-[a-zA-Z]*f[a-zA-Z]*|--full)([[:space:]]|$) ]]; then
  msg="Wait-loop nudge: \`pgrep -f\` inside a while/until loop matches the loop's own shell (its command line contains the pattern), so the loop never exits. Wait on a PID or an exit-marker file instead: \`$HELPER --pid <PID> --timeout 600\` or \`$HELPER --file \"\$LOG.exit\"\` (job: \`( cmd >\"\$LOG\" 2>&1; echo \$? >\"\$LOG.exit\" ) &\`). For a background Bash task, wait for its completion notification or use Monitor."
fi

# (b) test/gate command piped into tail/head, with no tee/pipefail/PIPESTATUS.
if [ -z "$msg" ] \
  && [[ "$cmd" =~ (pnpm|npm|yarn|bun)[[:space:]]+(run[[:space:]]+)?(test|verify|check|gate|lint|typecheck|merge)|vitest|playwright[[:space:]]+test|scripts/verify\.sh|pre-push|$GIT_PUSH_RE ]] \
  && [[ "$cmd" =~ $PIPE_RE ]] \
  && ! [[ "$cmd" =~ (^|[^[:alnum:]_-])(tee|pipefail|PIPESTATUS)($|[^[:alnum:]_]) ]]; then
  msg="Test-output nudge: piping a test/gate command straight into \`tail\`/\`head\` discards the full log and masks the exit code (a failed run can look like success). Keep both: \`cmd 2>&1 | tee \"\$LOG\" | tail -40; echo \"exit=\${PIPESTATUS[0]}\"\` — then read \$LOG instead of re-running to see a cut-off failure."
fi

# (c) pkill -f: kills the agent's own shell, whose command line holds the pattern.
if [ -z "$msg" ] && [[ "$cmd" =~ $PKILL_RE ]]; then
  msg="pkill nudge: \`pkill -f PATTERN\` also matches the shell running this command (its command line contains PATTERN), so it kills itself and can kill other tasks' processes. Kill by PID instead: start the job with \`cmd & echo \$!\` and run \`kill <PID>\`, or stop a background Bash task by its task id (TaskStop)."
fi

# (d) gh issue view --comments without --json. The --json check covers the
# whole command, not just the gh segment: a false silence beats a false nudge.
if [ -z "$msg" ] && [[ "$cmd" =~ $GH_VIEW_RE ]] \
  && [[ "$cmd" =~ [[:space:]]--comments([[:space:]=]|$) ]] \
  && ! [[ "$cmd" =~ [[:space:]]--json([[:space:]=]|$) ]]; then
  msg="gh nudge: \`gh issue view N --comments\` prints only the comments when its output is not a terminal (nothing at all, exit 0, for an issue without comments), so the issue body is missing. Use \`gh issue view N --json title,body,comments\` to get the body and the comments."
fi

[ -n "$msg" ] || exit 0
jq -n --arg ctx "$msg" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext: $ctx}}' 2>/dev/null
exit 0
