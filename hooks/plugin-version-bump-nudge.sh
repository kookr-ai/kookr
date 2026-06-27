#!/usr/bin/env bash
# Plugin version-bump nudge
# Claude Code PostToolUse hook (matcher: Edit|Write|MultiEdit)
#
# After an edit to bundled plugin content (plugin/** except plugin.json),
# remind the agent to bump plugin.json#version — the same condition the
# pre-push gate (.hooks/pre-push) enforces. This is the in-session
# early-warning layer; the git hook is the hard backstop. It only fires when
# the version is NOT yet bumped vs origin/main, so it won't nag once the
# agent has done the right thing.
#
# Non-blocking: emits hookSpecificOutput.additionalContext on stdout so the
# reminder reaches the model without blocking the tool. Fail-open: any error
# or unmet condition exits 0 silently.
#
# See: docs/hooks-setup.md, .hooks/pre-push (check #3).

set -u

mkdir -p "$HOME/.kookr" 2>/dev/null || true
ERR_LOG="$HOME/.kookr/hook-errors.log"
log_err() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR plugin-version-bump-nudge: ${1:-unknown}" \
    >> "$ERR_LOG" 2>/dev/null || true
}

INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

command -v jq >/dev/null 2>&1 || { log_err "jq not on PATH"; exit 0; }

FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$FILE" ] && exit 0

ROOT=$(git -C "$(dirname "$FILE")" rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$ROOT" ] || exit 0

# Only fire for edits to bundled plugin content, excluding plugin.json itself.
case "$FILE" in
  "$ROOT"/plugin/.claude-plugin/plugin.json) exit 0 ;;
  "$ROOT"/plugin/*) ;;
  *) exit 0 ;;
esac

# Stay silent if the version was already bumped vs origin/main — mirrors the
# pre-push satisfier (compare the version VALUE, not a line-level diff).
PLUGIN_JSON="$ROOT/plugin/.claude-plugin/plugin.json"
VER_RE='"version"[[:space:]]*:[[:space:]]*"[^"]+"'
if git -C "$ROOT" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  OLD_VER=$(git -C "$ROOT" show origin/main:plugin/.claude-plugin/plugin.json 2>/dev/null | grep -oE "$VER_RE" | head -1)
  NEW_VER=$(grep -oE "$VER_RE" "$PLUGIN_JSON" 2>/dev/null | head -1)
  if [ -n "$OLD_VER" ] && [ "$OLD_VER" != "$NEW_VER" ]; then
    exit 0
  fi
fi

REL="${FILE#"$ROOT"/}"
MSG="Heads up: you edited bundled plugin content ($REL) but plugin/.claude-plugin/plugin.json#version is not yet bumped vs origin/main. Bump it before pushing — installed-plugin users only receive updates when the version string changes, and the pre-push gate will reject the push otherwise."

jq -n --arg m "$MSG" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $m
  }
}' 2>/dev/null || { log_err "jq emit failed"; exit 0; }
exit 0
