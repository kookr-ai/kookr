#!/usr/bin/env bash
# PostToolUse note on Bash (issue #3913). After `gh pr create` opens a pull
# request in a repository that merges through an integration branch
# (.kookr/delivery-gate.json on origin/main), tells the agent that a base of
# `main` is expected, that `kookr merge <PR>` retargets and merges it, and what
# the integration train does next. See pr-create-delivery-note.mjs for the
# rules.
#
# Never blocks: exit 0 always, and a missing node prints nothing.
set -u

payload=$(cat)

# Cheap prefilter: this runs after every Bash call. Nothing to say unless the
# call mentions `create` and its output holds a pull-request URL.
case "$payload" in
  *create*) ;;
  *) exit 0 ;;
esac
case "$payload" in
  */pull/*) ;;
  *) exit 0 ;;
esac

command -v node >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/pr-create-delivery-note.mjs" 2>/dev/null
exit 0
