#!/usr/bin/env bash
# Regression test (#3646): the kookr-pre-push skill's "Rules a push can fail on"
# list names every check `.hooks/pre-push` runs, in the order it runs them.
#
# Agents read the skill to learn what a push can be rejected for. When the
# hook gains a check the skill does not mention, they find out only from a
# rejected multi-minute push. The expected checks are derived from the real
# hook source: every `pnpm <script>` lane and every `bash <helper>.sh` call.
#
# Run: bash .claude/hooks-tests/pre-push-skill-rule-list.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
PREPUSH="$REPO_ROOT/.hooks/pre-push"
SKILL="$REPO_ROOT/.claude/skills/kookr-pre-push/SKILL.md"

for f in "$PREPUSH" "$SKILL"; do
  if [ ! -f "$f" ]; then
    printf 'FAIL: required file not found at %s\n' "$f" >&2
    exit 1
  fi
done

TMPDIR=$(mktemp -d -t pre-push-skill-rule-list.XXXXXX)
trap 'rm -rf "$TMPDIR"' EXIT

# Hook checks in source order: `pnpm <script>` lanes (minus the non-lane
# install/exec/run tokens, as in verify-script.test.sh) and `bash <path>.sh`
# helper calls (`pnpm` flags such as `-s` are tolerated). Comment and `echo`
# lines are dropped so prose mentions and printed fix-it recipes do not count.
# A helper run through a variable (`bash "$X"`) or another interpreter is not
# seen: call new helpers as `bash <literal path>.sh` so this test covers them.
grep -vE '^[[:space:]]*(#|echo )' "$PREPUSH" \
  | grep -oE 'pnpm( -[-A-Za-z]+)* (run )?[a-z][a-z0-9:._-]*|bash [A-Za-z0-9_./-]+\.sh' \
  | sed -E 's/^pnpm( -[-A-Za-z]+)* (run )?//; s/^bash //' \
  | grep -vxE 'install|exec|run' \
  | awk '!seen[$0]++' \
  > "$TMPDIR/hook-checks"

if [ ! -s "$TMPDIR/hook-checks" ]; then
  printf 'FAIL: parsed zero checks from %s — parser or hook layout changed\n' "$PREPUSH" >&2
  exit 1
fi

# The hook half of the skill's list: from the section heading to the
# "`pnpm verify` only" paragraph, so verify-only lanes cannot satisfy it.
awk '
  /^## Rules a push can fail on/ { on = 1; next }
  on && /pnpm verify` only/ { exit }
  on && /^## / { exit }
  on { print }
' "$SKILL" > "$TMPDIR/skill-section"

if [ ! -s "$TMPDIR/skill-section" ]; then
  printf 'FAIL: "## Rules a push can fail on" section not found in %s\n' "$SKILL" >&2
  exit 1
fi

# Order is judged by the FIRST line of the section that names a check, so do
# not mention a lane in backticks earlier in the list than its own entry.
FAILURES=0
last_line=0
while IFS= read -r check; do
  [ -z "$check" ] && continue
  case "$check" in
    */*) needle="$check" ;;          # helper path, e.g. hooks/skill-placement-gate.sh
    *) needle="pnpm $check\`" ;;     # lane, written as `pnpm <script>` in the skill
  esac
  line=$(grep -nF -- "$needle" "$TMPDIR/skill-section" | head -1 | cut -d: -f1 || true)
  if [ -z "$line" ]; then
    printf 'FAIL: hook check "%s" is not listed in the skill\n' "$check" >&2
    FAILURES=$((FAILURES + 1))
  elif [ "$line" -lt "$last_line" ]; then
    printf 'FAIL: hook check "%s" is listed out of order in the skill\n' "$check" >&2
    FAILURES=$((FAILURES + 1))
  else
    last_line="$line"
  fi
done < "$TMPDIR/hook-checks"

# The reverse direction: every `pnpm <script>` the skill's hook list names must
# still be run by the hook, so a lane removed from the hook cannot linger here.
# `pnpm install` is the node_modules self-heal, which the hook parser skips.
grep -oE '`pnpm [a-z][a-z0-9:._-]*' "$TMPDIR/skill-section" \
  | sed 's/^`pnpm //' | grep -vx install | sort -u > "$TMPDIR/skill-lanes" || true
while IFS= read -r lane; do
  [ -z "$lane" ] && continue
  if ! grep -qxF -- "$lane" "$TMPDIR/hook-checks"; then
    printf 'FAIL: skill lists "pnpm %s" but the hook no longer runs it\n' "$lane" >&2
    FAILURES=$((FAILURES + 1))
  fi
done < "$TMPDIR/skill-lanes"

# The version-bump rule has no pnpm lane or helper script, so pin it by name,
# and pin that it is listed before the first type-check lane (issue #3646).
bump_line=$(grep -nF 'plugin/.claude-plugin/plugin.json' "$TMPDIR/skill-section" | head -1 | cut -d: -f1 || true)
build_line=$(grep -nF 'pnpm build:server`' "$TMPDIR/skill-section" | head -1 | cut -d: -f1 || true)
if [ -z "$bump_line" ]; then
  printf 'FAIL: skill does not list the plugin.json version-bump rule\n' >&2
  FAILURES=$((FAILURES + 1))
elif [ -n "$build_line" ] && [ "$bump_line" -gt "$build_line" ]; then
  printf 'FAIL: skill lists the version-bump rule after pnpm build:server\n' >&2
  FAILURES=$((FAILURES + 1))
fi

if [ "$FAILURES" -ne 0 ]; then
  printf 'Results: %d failed\n' "$FAILURES" >&2
  exit 1
fi
printf 'PASS: skill lists all %d hook checks in hook order\n' "$(wc -l < "$TMPDIR/hook-checks" | tr -d ' ')"
