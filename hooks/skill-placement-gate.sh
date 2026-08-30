#!/usr/bin/env bash
# skill-placement-gate.sh — enforce the kookr skill/agent two-home layout.
#
# Checks (per docs/rfc/rfc-skill-agent-distribution.md):
#   1. Every dir in <repo>/.claude/skills/ must start with "kookr-".
#   2. Every file in <repo>/.claude/agents/ must start with "kookr-" (kookr-
#      repo-local agents only — distributed agents go in plugin/agents/).
#   3. Distributed plugin skill/agent names must not start with "kookr-"; the
#      plugin namespace already identifies their origin.
#   4. No name collision between <repo>/.claude/skills/ and <repo>/plugin/skills/.
#   5. No unqualified subagent_type references inside .claude/skills/ or
#      plugin/skills/ — must use the kookr-toolkit:<name> form.
#
# Exits non-zero on any violation. Prints reasons to stderr.
#
# Run: bash hooks/skill-placement-gate.sh [<repo-root>]

set -euo pipefail

REPO_ROOT="${1:-${REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || true)}}"
if [ -z "$REPO_ROOT" ] || [ ! -d "$REPO_ROOT" ]; then
  echo "skill-placement-gate: cannot resolve repo root" >&2
  exit 2
fi

cd "$REPO_ROOT"

BAD=""

# --- Check 1: every dir in .claude/skills/ starts with kookr- -----------------
if [ -d .claude/skills ]; then
  for d in .claude/skills/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    case "$name" in
      kookr-*) ;;
      *) BAD+="${BAD:+$'\n'}  .claude/skills/$name (must start with 'kookr-')" ;;
    esac
  done
fi

# --- Check 2: .claude/agents/ may only hold kookr-* files --------------------
if [ -d .claude/agents ]; then
  for f in .claude/agents/* .claude/agents/.[!.]*; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    case "$name" in
      kookr-*) ;;
      *) BAD+="${BAD:+$'\n'}  .claude/agents/$name (project-scope agents must start with 'kookr-')" ;;
    esac
  done
fi

# --- Check 3: distributed names rely on the plugin namespace -----------------
if [ -d plugin/skills ]; then
  for d in plugin/skills/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    case "$name" in
      kookr-*) BAD+="${BAD:+$'\n'}  plugin/skills/$name (distributed skills must not start with 'kookr-')" ;;
    esac
  done
fi

if [ -d plugin/agents ]; then
  for f in plugin/agents/*.md; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    case "$name" in
      kookr-*) BAD+="${BAD:+$'\n'}  plugin/agents/$name (distributed agents must not start with 'kookr-')" ;;
    esac
  done
fi

# --- Check 4: no name collision .claude/skills/ vs plugin/skills/ -------------
if [ -d .claude/skills ] && [ -d plugin/skills ]; then
  DUPES=$(comm -12 \
    <(ls .claude/skills 2>/dev/null | sort -u) \
    <(ls plugin/skills 2>/dev/null | sort -u) || true)
  if [ -n "$DUPES" ]; then
    while IFS= read -r d; do
      [ -n "$d" ] && BAD+="${BAD:+$'\n'}  $d (in both .claude/skills/ and plugin/skills/)"
    done <<< "$DUPES"
  fi
fi

# --- Check 5: no unqualified subagent_type references inside skill bodies ----
# Pattern matches a quote directly preceded by `subagent_type` context, then the
# bare agent name. The qualified form has `kookr-toolkit:` between the quote
# and the agent name, so the bracketing `["']<name>` only matches unqualified.
#
# Limitation: only matches when subagent_type and the quoted name appear on the
# same line. Multi-line forms slip through. Acceptable at single-tenant scale.
#
# AGENT_NAMES is derived from plugin/agents/*.md filenames (the only agents
# that need namespace qualification). Project-scope agents under .claude/agents/
# (kookr-* names) are NOT in this list — they're called by their bare name and
# should not be qualified. Adding/removing a plugin agent automatically updates
# the gate without code changes.
AGENT_NAMES=""
if [ -d plugin/agents ]; then
  AGENT_NAMES=$(ls plugin/agents/*.md 2>/dev/null \
    | xargs -n1 basename 2>/dev/null \
    | sed 's/\.md$//' \
    | paste -sd'|' - || true)
fi

if [ -n "$AGENT_NAMES" ]; then
  for dir in .claude/skills plugin/skills; do
    [ -d "$dir" ] || continue
    HITS=$(grep -RInE "subagent_type[^a-zA-Z]+[\"']($AGENT_NAMES)[\"']" "$dir" 2>/dev/null || true)
    if [ -n "$HITS" ]; then
      while IFS= read -r line; do
        [ -n "$line" ] && BAD+="${BAD:+$'\n'}  $line"
      done <<< "$HITS"
    fi
  done
fi

if [ -n "$BAD" ]; then
  echo "" >&2
  echo "skill-placement-gate: violations found" >&2
  echo "$BAD" >&2
  echo "" >&2
  echo "See docs/rfc/rfc-skill-agent-distribution.md for the placement rules." >&2
  exit 1
fi

exit 0
