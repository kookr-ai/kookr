#!/usr/bin/env bash
# PreToolUse gate for reflect-task spawns. Reads the Claude Code hook event
# payload from stdin, dispatches to the TypeScript frontmatter parser, and
# exits with the parser's verdict.
#
# Behavior:
#   exit 0  → allow (Claude Code proceeds with the tool call)
#   exit 2  → block (Claude Code aborts the tool call; agent sees the message)
#   exit *  → fail-closed: treated as block by Claude Code
#
# We deliberately do NOT parse YAML in bash. The bash entrypoint only filters
# out non-memory paths before requiring Bun, so ordinary edits in toolkit-user
# repos are not blocked by a missing Bun install.

set -euo pipefail

PAYLOAD=$(cat)

if command -v node >/dev/null 2>&1; then
  PREFILTER=$(REFLECT_MEMORY_GATE_PAYLOAD="$PAYLOAD" node <<'NODE'
const home = process.env.HOME || '';
let event;
try {
  event = JSON.parse(process.env.REFLECT_MEMORY_GATE_PAYLOAD || '{}');
} catch {
  console.log('memory');
  process.exit(0);
}
const toolName = event.tool_name || '';
if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
  console.log('skip');
  process.exit(0);
}
const input = event.tool_input || {};
const filePath = typeof input.file_path === 'string' ? input.file_path : '';
if (home && filePath.startsWith(`${home}/.claude/projects/`) && filePath.includes('/memory/')) {
  console.log('memory');
} else {
  console.log('skip');
}
NODE
)
  if [ "$PREFILTER" != "memory" ]; then
    exit 0
  fi
else
  case "$PAYLOAD" in
    *"\"file_path\""*"$HOME/.claude/projects/"*"/memory/"*) ;;
    *) exit 0 ;;
  esac
fi

# Fail-closed for memory paths if bun is missing.
if ! command -v bun >/dev/null 2>&1; then
  echo "reflect-memory-frontmatter-gate: bun not on PATH; blocking memory write to be safe." >&2
  exit 2
fi

# Resolve the parser sibling-relative to this script. realpath -e ensures we
# follow any symlinks; the script may be invoked via plugin path injection.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARSER="$SCRIPT_DIR/parse-frontmatter.ts"

if [[ ! -f "$PARSER" ]]; then
  echo "reflect-memory-frontmatter-gate: parser not found at $PARSER; blocking." >&2
  exit 2
fi

# Pipe the hook event JSON to the parser. The parser decides allow/block.
printf '%s' "$PAYLOAD" | bun run "$PARSER"
