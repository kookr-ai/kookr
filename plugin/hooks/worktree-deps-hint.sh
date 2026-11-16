#!/usr/bin/env bash
# PostToolUse note on Bash (issue #3652). After `git worktree add` creates a
# worktree with a JavaScript lockfile but no node_modules, tells the agent the
# exact install command for it (it never runs the install). See
# worktree-deps-hint.mjs for the rules.
#
# Never blocks: exit 0 always, and a missing node prints nothing. Off with
# KOOKR_WORKTREE_DEPS_HINT_SKIP=1.
set -u

[ "${KOOKR_WORKTREE_DEPS_HINT_SKIP:-}" = "1" ] && exit 0

payload=$(cat)

# Cheap prefilter: this runs after every Bash call.
case "$payload" in
  *worktree*) ;;
  *) exit 0 ;;
esac

command -v node >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/worktree-deps-hint.mjs" 2>/dev/null
exit 0
