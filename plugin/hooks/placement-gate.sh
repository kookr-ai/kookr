#!/usr/bin/env bash
# Advisory PreToolUse gate for placement-sensitive Kookr Toolkit artifacts.
#
# The gate is intentionally path-only. It warns before new files are created in
# locations that commonly indicate a skill/agent placement mistake, but it does
# not infer intent from file contents.

set -u

if [ "${KOOKR_PLACEMENT_GATE_SKIP:-}" = "1" ]; then
  exit 0
fi

if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  exit 0
fi

payload=$(cat)
if [ "${#payload}" -gt 65536 ]; then
  echo "placement-gate: hook event over 64KB; skipping placement check." >&2
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  echo "placement-gate: node not on PATH; skipping placement check." >&2
  exit 0
fi

# The path-extraction program lives in a sibling .mjs file rather than an
# inline `node <<'NODE'` heredoc. A heredoc nested inside this `$(...)` cannot
# be parsed by macOS's default bash 3.2 when the body contains a backtick,
# which previously made this hook fail to parse and block every tool call.
HOOK_DIR=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)
candidate_paths=$(PLACEMENT_GATE_PAYLOAD="$payload" node "$HOOK_DIR/placement-gate.mjs")

if [ -z "$candidate_paths" ]; then
  exit 0
fi

is_kookr_repo=0
if [ -f "$REPO_ROOT/plugin/.claude-plugin/plugin.json" ] \
  && grep -q '"name"[[:space:]]*:[[:space:]]*"kookr-toolkit"' "$REPO_ROOT/plugin/.claude-plugin/plugin.json"; then
  is_kookr_repo=1
fi

strict=0
common_dir=$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || true)
if [ -n "$common_dir" ]; then
  case "$common_dir" in
    /*) common_abs="$common_dir" ;;
    *) common_abs="$REPO_ROOT/$common_dir" ;;
  esac
  if [ -f "$common_abs/../.kookr-placement-gate-strict" ]; then
    strict=1
  fi
fi

warnings=""

while IFS= read -r raw_path; do
  [ -n "$raw_path" ] || continue

  case "$raw_path" in
    /*)
      case "$raw_path" in
        "$REPO_ROOT"/*) rel=${raw_path#"$REPO_ROOT"/} ;;
        "$REPO_ROOT") continue ;;
        *) continue ;;
      esac
      ;;
    *) rel=$raw_path ;;
  esac

  rel=${rel#./}

  case "$rel" in
    node_modules/*|dist/*|build/*|target/*|.next/*|.svelte-kit/*) continue ;;
    .claude/worktrees/*) [ "$is_kookr_repo" = 1 ] && continue ;;
  esac

  if git -C "$REPO_ROOT" ls-files --error-unmatch -- "$rel" >/dev/null 2>&1; then
    continue
  fi

  case "$rel" in
    .claude/skills/*/*)
      skill=${rel#".claude/skills/"}
      skill=${skill%%/*}
      if [ "$is_kookr_repo" = 1 ]; then
        case "$skill" in
          kookr-*) ;;
          *)
            warnings="${warnings}
- $rel: project-scope Kookr skills must start with 'kookr-'. If agents need this outside the Kookr repo, use plugin/skills/$skill/ instead."
            ;;
        esac
      fi
      if [ -d "$REPO_ROOT/plugin/skills/$skill" ]; then
        warnings="${warnings}
- $rel: plugin/skills/$skill/ already exists; this project-scope skill would shadow or duplicate the plugin skill."
      fi
      ;;
    .claude/agents/*)
      if [ "$is_kookr_repo" = 1 ]; then
        agent=${rel#".claude/agents/"}
        agent=${agent%%/*}
        agent=${agent%.md}
        case "$agent" in
          kookr-*) ;;
          *)
            warnings="${warnings}
- $rel: project-scope Kookr agents must start with 'kookr-'. Distributed agents belong in plugin/agents/."
            ;;
        esac
      fi
      ;;
  esac
done <<EOF
$candidate_paths
EOF

if [ -z "$warnings" ]; then
  exit 0
fi

cat >&2 <<EOF
placement-gate: possible placement mismatch detected.
$warnings

Canonical picker: kookr-toolkit:placement-picker.
Set KOOKR_PLACEMENT_GATE_SKIP=1 for a deliberate one-off bypass.
EOF

if [ "$strict" = 1 ]; then
  exit 2
fi

exit 0
