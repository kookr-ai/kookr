#!/usr/bin/env bash
# kb-scout SubagentStop hook (log-only)
#
# Copies the kb-scout subagent's transcript to
# ~/.kookr/scout-invocations/<ts>.jsonl for later spot-checks.
#
# Fires on every SubagentStop (no matcher in settings.json) and
# filters by `agent_type == kb-scout` in this script. This is more
# robust than relying on the matcher field for custom agent names —
# we can switch to a settings-side matcher later if it turns out to
# work for non-builtin agents.
#
# Fail-open: any error is logged to ~/.kookr/hook-errors.log and
# the hook exits 0 so the parent Agent tool call is never broken.

set -euo pipefail

KOOKR_DIR="${KOOKR_HOOKS_DIR:-$HOME/.kookr}"
SCOUT_DIR="$KOOKR_DIR/scout-invocations"
ERROR_LOG="$KOOKR_DIR/hook-errors.log"

mkdir -p "$SCOUT_DIR" 2>/dev/null || true

fail_open() {
  local msg="${1:-unknown error}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) kb-scout-stop: $msg" \
    >> "$ERROR_LOG" 2>/dev/null || true
  exit 0
}
trap 'fail_open "crash at line $LINENO"' ERR

if ! command -v jq >/dev/null 2>&1; then
  fail_open "jq not found"
fi

payload="$(cat)"

agent_type="$(printf '%s' "$payload" | jq -r '.agent_type // empty')"
transcript_path="$(printf '%s' "$payload" | jq -r '.agent_transcript_path // empty')"

if [[ "$agent_type" != "kb-scout" ]]; then
  exit 0
fi

if [[ -z "$transcript_path" ]]; then
  fail_open "agent_transcript_path missing for kb-scout"
fi

src="${transcript_path/#\~/$HOME}"

if [[ ! -f "$src" ]]; then
  fail_open "transcript file not found: $src"
fi

ts="$(date -u +%Y%m%dT%H%M%SZ)"
dst="$SCOUT_DIR/$ts.jsonl"

cp -- "$src" "$dst" 2>/dev/null || fail_open "cp failed: $src -> $dst"

exit 0
