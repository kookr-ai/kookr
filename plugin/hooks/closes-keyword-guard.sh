#!/usr/bin/env bash
# PreToolUse gate on Bash (issue #4185; the check itself is from issue #3642).
# On `gh pr create` / `gh pr edit`, denies a pull-request body whose closing
# keyword (Closes/Fixes/Resolves #N) appears only inside inline code or a code
# block, where GitHub ignores it, and warns when the branch's issue is
# mentioned only as an inline `(#N)` reference. See closes-keyword-guard.mjs
# for the rules.
#
# Exit 0 always; a denial or warning is JSON on stdout. Fail-open on missing
# node so ordinary Bash is never blocked by an environment gap.
set -u

payload=$(cat)

# Cheap prefilter: nothing to check unless the command mentions a pull request.
case "$payload" in
  *gh*pr*) ;;
  *) exit 0 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "closes-keyword-guard: node not on PATH; skipping the closing-keyword check." >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/closes-keyword-guard.mjs"
exit 0
