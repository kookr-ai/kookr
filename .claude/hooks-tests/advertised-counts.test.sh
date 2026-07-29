#!/usr/bin/env bash
# Regression guard for issue #1431 item 1: the marketplace card and plugin
# description advertise skill / review-subagent counts that prospective users
# read before installing. A bare number fix re-drifts on the next skill/agent
# added, so this check fails when the *advertised* counts don't match the
# *actual* on-disk counts.
#
# `.claude-plugin/marketplace.json` sits OUTSIDE `plugin/**`, so the version-bump
# gate never covered it — which is why it drifted furthest (#1431).
#
# Actual counts are defined as:
#   - skills:  directories under plugin/skills/ that contain a SKILL.md
#              (the plugin loader's definition of a skill — a stray flat file
#               like plugin/skills/github-labels is NOT a loadable skill)
#   - agents:  plugin/agents/*.md files
#
# Run: bash .claude/hooks-tests/advertised-counts.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

MARKETPLACE="$REPO_ROOT/.claude-plugin/marketplace.json"
PLUGIN_JSON="$REPO_ROOT/plugin/.claude-plugin/plugin.json"
SKILLS_DIR="$REPO_ROOT/plugin/skills"
AGENTS_DIR="$REPO_ROOT/plugin/agents"

PASS=0
FAIL=0

record_pass() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
record_fail() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1" >&2; }

for f in "$MARKETPLACE" "$PLUGIN_JSON"; do
  if [ ! -f "$f" ]; then
    printf 'FAIL: required file not found: %s\n' "$f" >&2
    exit 1
  fi
done

# --- actual on-disk counts -------------------------------------------------
SKILL_COUNT=$(find "$SKILLS_DIR" -mindepth 2 -maxdepth 2 -name SKILL.md -type f | wc -l | tr -d ' ')
AGENT_COUNT=$(find "$AGENTS_DIR" -mindepth 1 -maxdepth 1 -name '*.md' -type f | wc -l | tr -d ' ')

printf 'actual: %s skills, %s review subagents\n' "$SKILL_COUNT" "$AGENT_COUNT"

# --- advertised counts extracted from the shipped text ----------------------
# grep -oE isolates the "<n> skills" / "<n> review subagents" phrases; head -1
# guards against multiple matches in one file.
extract() { grep -oE "$2" "$1" | head -1 | grep -oE '^[0-9]+'; }

MKT_SKILLS=$(extract "$MARKETPLACE" '[0-9]+ skills' || true)
MKT_AGENTS=$(extract "$MARKETPLACE" '[0-9]+ review subagents' || true)
PLUGIN_AGENTS=$(extract "$PLUGIN_JSON" '[0-9]+ review subagents' || true)

assert_count() {
  local label="$1" advertised="$2" actual="$3"
  if [ -z "$advertised" ]; then
    record_fail "$label — could not find advertised count in shipped text"
  elif [ "$advertised" = "$actual" ]; then
    record_pass "$label — advertised $advertised == actual $actual"
  else
    record_fail "$label — advertised $advertised != actual $actual (update the shipped text)"
  fi
}

assert_count "marketplace.json skills"          "$MKT_SKILLS"    "$SKILL_COUNT"
assert_count "marketplace.json review subagents" "$MKT_AGENTS"   "$AGENT_COUNT"
assert_count "plugin.json review subagents"     "$PLUGIN_AGENTS" "$AGENT_COUNT"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
