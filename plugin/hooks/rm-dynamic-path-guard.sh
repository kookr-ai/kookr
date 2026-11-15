#!/usr/bin/env bash
# PreToolUse gate on Bash (issue #3867). Denies a recursive `rm` whose target is
# a variable or a command substitution (`rm -rf "$(cat f)"`, `rm -r -- $X`).
# Claude Code asks a human before running such a command even in bypass mode,
# so an unattended task would wait for an hour; the denial tells the agent to
# delete by literal path instead. See rm-dynamic-path-guard.mjs for the rules.
#
# Exit 0 always; a denial is JSON on stdout. Fail-open on missing node so
# ordinary Bash is never blocked by an environment gap.
set -u

payload=$(cat)

# Cheap prefilter: nothing to check unless the command mentions rm and an
# expansion ($ or a backtick).
case "$payload" in
  *rm*) ;;
  *) exit 0 ;;
esac
case "$payload" in
  *'$'* | *'`'*) ;;
  *) exit 0 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "rm-dynamic-path-guard: node not on PATH; skipping the rm check." >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/rm-dynamic-path-guard.mjs"
exit 0
