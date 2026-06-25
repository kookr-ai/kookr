#!/usr/bin/env bash
# PreToolUse gate on Bash. When Claude Code's auto memory is disabled
# (CLAUDE_CODE_DISABLE_AUTO_MEMORY set), block Bash commands that WRITE or DELETE
# under a `.claude/projects/*/memory/` path and redirect durable knowledge to
# `kb remember`. Reads (cat/grep/ls/head/find) are allowed. This complements the
# Write|Edit|MultiEdit gate (parse-frontmatter.ts), which Bash redirects bypass.
#
# No-op when CLAUDE_CODE_DISABLE_AUTO_MEMORY is unset — default toolkit behavior
# (operators who use auto memory are unaffected).
#
# Exit: 0 = allow, 2 = block. Fail-open on missing node so ordinary Bash is never
# blocked by an environment gap.
set -u

# Fast opt-out: only active when the operator has retired the memory system.
[ -n "${CLAUDE_CODE_DISABLE_AUTO_MEMORY:-}" ] || exit 0

payload=$(cat)

# Only inspect events that mention a memory path at all.
case "$payload" in
  *"/memory/"*) ;;
  *) exit 0 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "block-memory-bash-writes: node not on PATH; skipping Bash memory-write check." >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf '%s' "$payload" | node "$SCRIPT_DIR/block-memory-bash-writes.mjs"
