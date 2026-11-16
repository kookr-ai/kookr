#!/usr/bin/env bash
# PreToolUse gate on Bash (issue #3654). In a Kookr task, denies `git add -A`,
# `git add --all` and `git add .`, which stage every untracked file (test
# output, run artifacts, scratch files), and tells the agent to stage named
# paths. See git-add-all-guard.mjs for the rules.
#
# Exit 0 always; a denial is JSON on stdout. Off outside a Kookr task
# (KOOKR_TASK_ID unset) and with KOOKR_GIT_ADD_ALL_GUARD_SKIP=1. Fail-open on
# missing node so ordinary Bash is never blocked by an environment gap.
set -u

[ -n "${KOOKR_TASK_ID:-}" ] || exit 0
[ "${KOOKR_GIT_ADD_ALL_GUARD_SKIP:-}" = "1" ] && exit 0

payload=$(cat)

# Cheap prefilter: nothing to check unless the command mentions git and add.
case "$payload" in
  *git*) ;;
  *) exit 0 ;;
esac
case "$payload" in
  *add*) ;;
  *) exit 0 ;;
esac

command -v node >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/git-add-all-guard.mjs"
exit 0
