#!/usr/bin/env bash
# PreToolUse gate on Bash (issue #3803). Denies a pull-request merge that would
# skip the integration branch: `pnpm merge` or `bash .../kookr-merge.sh` with a
# merge script too old to retarget, and bare `gh pr merge` or the REST merge
# endpoint aimed at main, in a repository whose origin/main configures an
# integration branch (.kookr/delivery-gate.json). The denial names the one
# correct command, `kookr merge <PR> --repo <owner/name>`. See
# merge-retarget-guard.mjs for the rules.
#
# Exit 0 always; a denial is JSON on stdout. Fail-open on missing node so
# ordinary Bash is never blocked by an environment gap.
set -u

payload=$(cat)

# Cheap prefilter: nothing to check unless the command mentions a merge.
case "$payload" in
  *merge*) ;;
  *) exit 0 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "merge-retarget-guard: node not on PATH; skipping the merge check." >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/merge-retarget-guard.mjs"
exit 0
