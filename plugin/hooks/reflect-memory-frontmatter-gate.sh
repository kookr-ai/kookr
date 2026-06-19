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
  # The Node prefilter lives in a sibling .mjs invoked by path, NOT an inline
  # `node <<'NODE'` heredoc: bash 3.2 (macOS) cannot parse a heredoc nested in
  # this $(...) when the body contains a backtick (the path template does).
  # Resolve the sibling dir with pure bash (no `dirname`) so the hook still
  # works under a minimal PATH that has node but not coreutils.
  HOOK_DIR="${BASH_SOURCE[0]%/*}"
  [ "$HOOK_DIR" = "${BASH_SOURCE[0]}" ] && HOOK_DIR="."
  PREFILTER=$(REFLECT_MEMORY_GATE_PAYLOAD="$PAYLOAD" node "$HOOK_DIR/reflect-memory-prefilter.mjs")
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
