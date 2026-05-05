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
# We deliberately do NOT parse YAML in bash. Memory gate decisions must be
# precise, and shell YAML parsing is a known footgun. The bash entrypoint only:
#   - verifies `bun` is available (fail-closed if not)
#   - tee's stdin to the TS parser

set -euo pipefail

# Fail-closed if bun is missing — better to block than to allow with no parser.
if ! command -v bun >/dev/null 2>&1; then
  echo "reflect-memory-frontmatter-gate: bun not on PATH; blocking write to be safe." >&2
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
exec bun run "$PARSER"
