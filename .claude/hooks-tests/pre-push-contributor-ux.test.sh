#!/usr/bin/env bash
# Regression test (#1369): the `.hooks/pre-push` rejection UX is self-sufficient
# for a contributor who is NOT using Claude Code.
#
#   AC4 — every `.claude/...` path the hook PRINTS resolves on disk (the old
#         message pointed at `.claude/skills/pre-push/SKILL.md`, which does not
#         exist; the skill is `.claude/skills/kookr-pre-push/`).
#   AC5 — the rejection message alone lets a contributor produce a VALID bypass
#         marker (right sha, status, non-empty reason) — no skill run required.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
PREPUSH="$REPO_ROOT/.hooks/pre-push"

if [ ! -f "$PREPUSH" ]; then
  printf 'FAIL: pre-push hook not found at %s\n' "$PREPUSH" >&2
  exit 1
fi

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# --- AC4: every printed `.claude/...` path resolves ------------------------
# Only inspect lines the hook actually prints (echo/printf), not comments.
PRINTED_CLAUDE_PATHS=$(grep -E '(echo|printf)' "$PREPUSH" \
  | grep -oE '\.claude/[A-Za-z0-9._/-]+' \
  | sed 's/[.,)]*$//' \
  | sort -u)

# The hook MUST point contributors at the kookr-pre-push skill; an empty set
# means that guidance was dropped (a regression in itself), so fail rather than
# no-op past it.
[ -n "$PRINTED_CLAUDE_PATHS" ] || fail "pre-push prints no .claude/ skill pointer (marker guidance regressed)"

while IFS= read -r p; do
  [ -z "$p" ] && continue
  if [ ! -e "$REPO_ROOT/$p" ]; then
    fail "pre-push prints .claude path that does not resolve: $p"
  fi
done <<< "$PRINTED_CLAUDE_PATHS"

# Specifically guard the #1369 regression: the dead `.claude/skills/pre-push/`
# pointer (real skill is `.claude/skills/kookr-pre-push/`).
grep -q 'kookr-pre-push' <<< "$PRINTED_CLAUDE_PATHS" \
  || fail "pre-push no longer points at the kookr-pre-push skill"

printf 'PASS(AC4): all printed .claude/ paths resolve:\n'
printf '  - %s\n' $PRINTED_CLAUDE_PATHS

# --- AC5: the printed bypass recipe produces a valid marker ----------------
command -v jq >/dev/null 2>&1 || fail "jq required for AC5 marker validation"

TMPDIR=$(mktemp -d -t pre-push-ux.XXXXXX)
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# Sample values the hook substitutes at runtime.
HEAD_SHA="0123456789abcdef0123456789abcdef01234567"
MARKER_DIR="$TMPDIR/.review-state"
MARKER_FILE="$MARKER_DIR/branch.json"

# Pull the two recipe lines the hook echoes and render them exactly as a
# contributor would see them, then execute the rendered commands.
MKDIR_ECHO=$(grep -E 'echo "  mkdir -p .*MARKER_DIR' "$PREPUSH" | head -1)
PRINTF_ECHO=$(grep -E "echo \"  printf '\\{" "$PREPUSH" | head -1)

[ -n "$MKDIR_ECHO" ] || fail "could not find the printed 'mkdir -p \$MARKER_DIR' recipe line"
[ -n "$PRINTF_ECHO" ] || fail "could not find the printed bypass 'printf ... > \$MARKER_FILE' recipe line"

# `eval` the echo -> the rendered command a contributor copies; eval that ->
# actually run it. If the printed recipe isn't a runnable command, this fails.
RENDERED_MKDIR=$(eval "$MKDIR_ECHO")
RENDERED_PRINTF=$(eval "$PRINTF_ECHO")
eval "$RENDERED_MKDIR"
eval "$RENDERED_PRINTF"

[ -f "$MARKER_FILE" ] || fail "bypass recipe did not create the marker file"
jq -e . "$MARKER_FILE" >/dev/null 2>&1 || fail "bypass recipe produced invalid JSON"

GOT_SHA=$(jq -r '.sha // empty' "$MARKER_FILE")
GOT_STATUS=$(jq -r '.status // empty' "$MARKER_FILE")
GOT_REASON=$(jq -r '.reason // empty' "$MARKER_FILE")

[ "$GOT_SHA" = "$HEAD_SHA" ] || fail "marker sha ($GOT_SHA) != HEAD ($HEAD_SHA)"
[ "$GOT_STATUS" = "bypass" ] || fail "marker status is '$GOT_STATUS', expected 'bypass'"
[ -n "$GOT_REASON" ] || fail "marker reason is empty (bypass requires a reason)"

printf 'PASS(AC5): printed bypass recipe yields a valid SHA-bound marker\n'
printf 'PASS: pre-push contributor UX is self-sufficient\n'
