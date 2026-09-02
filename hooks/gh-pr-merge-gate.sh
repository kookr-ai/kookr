#!/usr/bin/env bash
# GH PR Merge Gate (issue #1968, #2944)
# Claude Code PreToolUse hook (matcher: Bash, if: "Bash(gh pr merge*)" and
# a second registration "Bash(gh api*)" — see scripts/install-hooks.sh).
#
# Blocks direct PR merges from autonomous Kookr-managed sessions when the
# independent-review gate is on (KOOKR_MERGE_REQUIRE_REVIEW default on). Agents
# must use `pnpm merge <PR>` / `bash scripts/kookr-merge.sh <PR>`, which enforces
# the independent-merge-review verdict contract (issue #1717).
#
# Two merge verbs are gated (issue #2944):
#   - `gh pr merge <PR>`
#   - `gh api --method PUT .../pulls/<n>/merge` (the REST merge endpoint, which
#     merges a PR just the same and otherwise slips past a `gh pr merge`-only
#     gate — kookr-merge.sh's old-gh head-pin fallback made it copy-pasteable).
#
# Known residual bypasses (out of scope for #2944, deliberately NOT gated here):
#   - `gh api graphql` with a `mergePullRequest` mutation. It carries no
#     `pulls/<n>/merge` path, needs the PR node id, and is not copy-pasteable
#     from any in-repo wrapper.
#   - a raw `curl` to the REST endpoint with a token.
# Both are far harder to stumble into than the REST verb this hook closes; the
# hook is defense-in-depth, not a sandbox. If either becomes discoverable, gate
# it in a follow-up rather than assuming it is already covered.
#
# Scope:
#   - Active only when KOOKR_TASK_ID is set (Kookr-launched agent session).
#   - Disabled when KOOKR_MERGE_REQUIRE_REVIEW is 0/false (manual merges).
#   - Fail-open on parse errors so a hook crash does not brick all Bash.

set -euo pipefail

fail_open() {
  local msg="${1:-unknown error}"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR gh-pr-merge-gate: $msg" \
    >> "$HOME/.kookr/hook-errors.log" 2>/dev/null || true
  exit 0
}
trap 'fail_open "unexpected crash at line $LINENO"' ERR

mkdir -p "$HOME/.kookr" 2>/dev/null || true

# --- Only gate Kookr-managed agent sessions --------------------------------
if [ -z "${KOOKR_TASK_ID:-}" ]; then
  exit 0
fi

# --- Align with kookr-merge.sh independent-review kill-switch --------------
require="${KOOKR_MERGE_REQUIRE_REVIEW:-1}"
if [ "$require" = "0" ] || [ "$require" = "false" ]; then
  exit 0
fi

INPUT=$(cat)
COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) \
  || fail_open "failed to parse input JSON"

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Defense-in-depth — the `if` matcher already filters, but agents compose
# wrappers (`env FOO=1 gh pr merge`, `command gh pr merge`, etc.).
#
# Evaluate each shell segment independently. The command is a merge if ANY
# segment (split on ; && || | &) is one of:
#   1. `gh pr merge`
#   2. `gh api` PUT to a `.../pulls/<n>/merge` endpoint. Require an explicit
#      PUT method so a read-only `gh api GET .../pulls/<n>/merge` merge-status
#      check (and every non-merge `gh api` call) is left untouched — a merge
#      always spells out `--method PUT` / `-X PUT` (gh defaults to GET).
#
# Judging each segment on its own is what makes this both correct and safe:
#   - it never conflates a `pulls/<n>/merge` path in one call with a PUT flag
#     in an unrelated later `gh api` call (no false-positive on compound
#     `gh api ...merge --jq ... && gh api --method PUT .../labels/...`), and
#   - it cannot be defeated by appending a no-op sanctioned-wrapper segment
#     (`gh api --method PUT .../merge && bash scripts/kookr-merge.sh 999`) — the
#     real merge segment is denied regardless of what follows it.
# The sanctioned wrappers (`pnpm merge`, `bash scripts/kookr-merge.sh <PR>`)
# carry no merge verb in the Bash tool call — their inner `gh api ... PUT` runs
# as a subprocess of the script, invisible here — so they trip no segment and
# need no explicit allow-list (which is itself a bypass vector).
is_merge=0
while IFS= read -r seg; do
  if printf '%s' "$seg" | grep -qE '(^|[[:space:]])gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'; then
    is_merge=1
    break
  fi
  if printf '%s' "$seg" | grep -qE '(^|[[:space:]])gh[[:space:]]+api([[:space:]]|$)' \
    && printf '%s' "$seg" | grep -qE 'pulls/[0-9]+/merge' \
    && printf '%s' "$seg" | grep -qiE '(--method[[:space:]=]+put|-X[[:space:]=]*put)'; then
    is_merge=1
    break
  fi
done <<EOF
$(printf '%s' "$COMMAND" | tr ';&|' '\n')
EOF
if [ "$is_merge" -eq 0 ]; then
  exit 0
fi

REASON='Directly merging a PR (bare `gh pr merge`, or `gh api --method PUT .../pulls/<n>/merge`) is blocked in Kookr-managed sessions while KOOKR_MERGE_REQUIRE_REVIEW is on. Use `pnpm merge <PR>` (or `bash scripts/kookr-merge.sh <PR>`) so the independent-merge-review verdict is enforced. For a deliberate human-driven merge only: KOOKR_MERGE_REQUIRE_REVIEW=0 gh pr merge ...'

if ! jq -n --arg r "$REASON" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $r
  }
}' 2>/dev/null; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Directly merging a PR is blocked in Kookr sessions. Use pnpm merge instead."}}'
fi
exit 0
