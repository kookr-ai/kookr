#!/usr/bin/env bash
# RFC 018 M2 context-injection hook
# Claude Code UserPromptSubmit hook
#
# Before an agent turn, run a relevance-gated `kb search` and inject the
# post-gate knowledge-base context into the turn (RFC 018 §11 consumer
# contract). stdout → injected context (Claude Code feeds a UserPromptSubmit
# hook's stdout into the turn); stderr → the gate_verdict debug echo.
#
# OFF BY DEFAULT. Inert unless KOOKR_KB_CONTEXT_INJECT is truthy — RFC 018
# M1 returned a NO-GO for defaulting the gate on, and `kb search --gate`
# invokes an LLM judge that adds latency to every turn. Opt in per-session
# with `KOOKR_KB_CONTEXT_INJECT=1`.
#
# Design: fail-open. The gate never blocks retrieval and a hook crash must
# never break the turn — every path exits 0. The real logic lives in the
# tested TS module src/core/kb-context-injection.ts.
#
# Runtime deps (only when enabled): `node` + `tsx` (resolved from the repo's
# node_modules — run `pnpm install` in the repo this hook symlinks back to)
# and the `kb` CLI on PATH. A missing dep degrades to "inject nothing".
#
# See: docs/hooks-setup.md, RFC 018 §11.

set -u

# Fast env gate — exit before spawning node when the hook is opted out.
# Case-folded so the accepted set matches the TS isHookEnabled() predicate.
_kbci_optin="${KOOKR_KB_CONTEXT_INJECT:-}"
case "${_kbci_optin,,}" in
  1 | true | on | yes) ;;
  *) exit 0 ;;
esac

mkdir -p "$HOME/.kookr" 2>/dev/null || true
ERR_LOG="$HOME/.kookr/hook-errors.log"

log_err() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR kb-context-inject: ${1:-unknown}" \
    >> "$ERR_LOG" 2>/dev/null || true
}

INPUT=$(cat)
[ -z "$INPUT" ] && exit 0

# Resolve this script through its install symlink to the repo it lives in,
# so the TS entry point is found whether run from ~/.claude/hooks/ or in-repo.
SELF=$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")
REPO_DIR=$(cd "$(dirname "$SELF")/.." 2>/dev/null && pwd) || { log_err "repo dir unresolved"; exit 0; }
ENTRY="$REPO_DIR/src/core/kb-context-injection-hook-run.ts"
[ -f "$ENTRY" ] || { log_err "entry not found: $ENTRY"; exit 0; }

command -v node >/dev/null 2>&1 || { log_err "node not on PATH"; exit 0; }

# stdout passes through to Claude Code (injected context); stderr passes
# through as the collapsed debug channel (gate_verdict echo). The TS entry
# always exits 0; the `||` only catches a node/tsx startup failure.
printf '%s' "$INPUT" | (cd "$REPO_DIR" && node --import tsx "$ENTRY") \
  || log_err "hook runner exited non-zero"

exit 0
