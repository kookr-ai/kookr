#!/usr/bin/env bash
# placement-gate.sh — kookr-toolkit plugin hook for placement violations.
#
# A per-write reactive gate (different from the tree-scanner `skill-placement-
# gate.sh` at <repo>/hooks/ which runs at push time). Receives the Claude Code
# / Codex CLI PreToolUse JSON event on stdin, decides whether the tool call
# would create a misplaced file, and prints a warning to stderr.
#
# Exit codes:
#   0  → allow (advisory mode default; strict mode if no violation)
#   2  → block (strict mode + violation)
#   *  → fail-open: never block on parser errors, always exit 0 with stderr note
#
# Strict mode is opt-in via a sentinel file `.kookr-placement-gate-strict`
# placed at the git common-dir's parent (so worktrees inherit consistently).
# The sentinel is in `.gitignore` to prevent accidental commit-to-shared-repo
# propagation.
#
# See: docs/rfc/rfc-unified-placement-picker.md §C for the design.

set -uo pipefail   # NOTE: no `-e` — we WANT graceful continuation on parse glitches

# ------------------------------------------------------------------------------
# Fail-open dependencies. The gate is advisory by default; missing tools must
# NEVER block a write. If something is unavailable, log and allow.
# ------------------------------------------------------------------------------

if ! command -v jq >/dev/null 2>&1; then
  echo "placement-gate: jq not available; skipping" >&2
  exit 0
fi

# ------------------------------------------------------------------------------
# Read the hook event JSON from stdin.
# ------------------------------------------------------------------------------

PAYLOAD=$(cat 2>/dev/null || true)
if [ -z "$PAYLOAD" ]; then
  exit 0
fi

TOOL_NAME=$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null || true)
CWD=$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null || true)
[ -z "$CWD" ] && CWD="$PWD"

# ------------------------------------------------------------------------------
# Extract candidate paths from the tool input. Up to a few paths per call
# (cp/mv/rename produce two paths; here-docs are one; etc.).
# ------------------------------------------------------------------------------

declare -a CANDIDATE_PATHS=()

case "$TOOL_NAME" in
  Write|Edit|MultiEdit)
    # Claude Code Write/Edit: single file_path in the tool_input.
    P=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)
    [ -n "$P" ] && CANDIDATE_PATHS+=("$P")
    ;;
  Bash)
    # Codex CLI (and any Claude Bash call): parse the command string for
    # write-shaped invocations targeting watched paths.
    #
    # Bounded scope (per RFC §C residual-gap acknowledgement): we only handle
    # commands matching unambiguous write patterns. Variable-expanded paths,
    # interpreter-internal writes (python -c, node -e), `dd of=`, and
    # `git checkout -- <path>` are NOT covered. The gate is best-effort here.
    CMD=$(printf '%s' "$PAYLOAD" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
    if [ -n "$CMD" ]; then
      # Pattern A: redirection operators `>` / `>>` followed by an unquoted path.
      # Pattern B: `tee [-a] <path>`, `cp <src> <path>`, `mv <src> <path>`.
      # Pattern C: heredoc form `cat > <path> <<EOF` / `cat > <path> <<'EOF'`.
      #
      # grep -oE returns ALL matches; we extract the final-arg path of each.
      while IFS= read -r match; do
        # match looks like: `> /abs/path` or `tee /abs/path` etc.
        # Strip leading operator/command and quoting.
        P=$(printf '%s' "$match" \
          | sed -E 's/^[[:space:]]*(>>?|tee[[:space:]]+-?a?|cp|mv)[[:space:]]+//' \
          | sed -E 's/^["'\'']//; s/["'\'']$//' \
          | awk '{print $NF}')
        [ -n "$P" ] && CANDIDATE_PATHS+=("$P")
      done < <(printf '%s' "$CMD" \
        | grep -oE "(>>?|tee[[:space:]]+-?a?|cp|mv)[[:space:]]+['\"]?[^[:space:]<>|;&'\"]+(\.md|\.json|\.sh|\.ts|\.tsx|\.js|\.py)['\"]?" \
        2>/dev/null || true)
    fi
    ;;
  *)
    # Tool not in our watch list.
    exit 0
    ;;
esac

# No paths extracted → nothing to check.
if [ "${#CANDIDATE_PATHS[@]}" -eq 0 ]; then
  exit 0
fi

# ------------------------------------------------------------------------------
# Strict-mode resolution via git common-dir (one sentinel covers all worktrees
# of the same repo). Per RFC §C — addresses round-2 failure-mode R3.
# ------------------------------------------------------------------------------

STRICT=0
COMMON_DIR=$(git -C "$CWD" rev-parse --git-common-dir 2>/dev/null || true)
if [ -n "$COMMON_DIR" ]; then
  # --git-common-dir returns ".git" (relative) for non-worktree checkouts and an
  # absolute path for worktrees. Resolve to absolute first.
  case "$COMMON_DIR" in
    /*) ABS_COMMON="$COMMON_DIR" ;;
    *)  ABS_COMMON="$CWD/$COMMON_DIR" ;;
  esac
  if [ -f "$ABS_COMMON/../.kookr-placement-gate-strict" ]; then
    STRICT=1
  fi
fi

# Per-call escape hatch (rare; documented in plugin/hooks/README.md).
if [ "${KOOKR_PLACEMENT_GATE_SKIP:-0}" = "1" ]; then
  exit 0
fi

# ------------------------------------------------------------------------------
# Deny-list (early-return per round-2 failure-mode R2 — checked FIRST).
# These paths NEVER trigger warnings.
# ------------------------------------------------------------------------------

is_denied() {
  local path="$1"
  case "$path" in
    */node_modules/*|*/dist/*|*/build/*|*/target/*|*/.next/*|*/.svelte-kit/*) return 0 ;;
    "$HOME/.kookr/"*) return 0 ;;
    */.claude/worktrees/*) return 0 ;;
  esac
  return 1
}

# ------------------------------------------------------------------------------
# New-file detection (per round-2 failure-mode R5 — `--cached A` was wrong
# tense). Use `git ls-files --error-unmatch` to detect tracked files; missing
# tracking ⇒ new write (or untracked existing). Either way, fire on these.
# ------------------------------------------------------------------------------

is_new_file() {
  local path="$1"
  local repo_root
  repo_root=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || return 1
  # Make path relative to repo_root for git ls-files.
  case "$path" in
    "$repo_root"/*) rel_path="${path#$repo_root/}" ;;
    /*)             return 1 ;;  # path outside this repo → not our concern (handled by host-path checks)
    *)              rel_path="$path" ;;
  esac
  if git -C "$repo_root" ls-files --error-unmatch -- "$rel_path" >/dev/null 2>&1; then
    return 1  # tracked → edit, not new
  fi
  return 0
}

# ------------------------------------------------------------------------------
# The four path-prefix checks (RFC §C).
# Each prints a warning to WARNINGS[] and a remediation hint.
# Check 1 and Check 4 (kookr-prefix enforcement) only fire inside the kookr
# repo itself — non-kookr repos use their own conventions.
# ------------------------------------------------------------------------------

is_kookr_repo() {
  local repo_root
  repo_root=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || return 1
  [ -f "$repo_root/plugin/.claude-plugin/plugin.json" ] || return 1
  local plugin_name
  plugin_name=$(jq -r '.name // empty' "$repo_root/plugin/.claude-plugin/plugin.json" 2>/dev/null || true)
  [ "$plugin_name" = "kookr-toolkit" ]
}

declare -a WARNINGS=()

check_path() {
  local path="$1"

  # Resolve to absolute.
  case "$path" in
    /*) abs="$path" ;;
    *)  abs="$CWD/$path" ;;
  esac

  # Deny-list FIRST.
  if is_denied "$abs"; then
    return 0
  fi

  # Compute repo-relative form (for the prefix matches below).
  local repo_root rel
  repo_root=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null) || return 0
  case "$abs" in
    "$repo_root"/*) rel="${abs#$repo_root/}" ;;
    *)              return 0 ;;
  esac

  # New-file-only filter (skip edits to existing tracked files).
  if ! is_new_file "$abs"; then
    return 0
  fi

  local in_kookr=0
  is_kookr_repo && in_kookr=1

  # --- Check 1: .claude/skills/<name>/ must start with kookr- (kookr repo only) ----
  if [ "$in_kookr" = 1 ]; then
    case "$rel" in
      .claude/skills/*/*)
        name=$(echo "$rel" | awk -F'/' '{print $3}')
        case "$name" in
          kookr-*) ;;
          *) WARNINGS+=("Check 1: .claude/skills/$name/ should start with 'kookr-' or move to plugin/skills/$name/ for general utility.") ;;
        esac
        ;;
    esac
  fi

  # --- Check 2: plugin/skills/kookr-<name>/ is banned ----------------------------
  case "$rel" in
    plugin/skills/kookr-*/*)
      name=$(echo "$rel" | awk -F'/' '{print $3}')
      WARNINGS+=("Check 2: plugin/skills/$name/ — 'kookr-' prefix is banned in plugin/. Rename without the prefix, or move to .claude/skills/.")
      ;;
  esac

  # --- Check 3: .claude/skills/<name>/ shadows plugin/skills/<name>/ -------------
  case "$rel" in
    .claude/skills/*/*)
      name=$(echo "$rel" | awk -F'/' '{print $3}')
      if [ -d "$repo_root/plugin/skills/$name" ]; then
        WARNINGS+=("Check 3: .claude/skills/$name/ collides with plugin/skills/$name/. Rename one or delete one — user-scope shadows kill the canonical copy silently.")
      fi
      ;;
  esac

  # --- Check 4: .claude/agents/<name>.md must start with kookr- (kookr repo only)
  if [ "$in_kookr" = 1 ]; then
    case "$rel" in
      .claude/agents/*.md)
        name=$(echo "$rel" | awk -F'/' '{print $3}' | sed 's/\.md$//')
        case "$name" in
          kookr-*) ;;
          *) WARNINGS+=("Check 4: .claude/agents/$name.md should start with 'kookr-' or move to plugin/agents/$name.md for general agents.") ;;
        esac
        ;;
    esac
  fi
}

for p in "${CANDIDATE_PATHS[@]}"; do
  check_path "$p"
done

# ------------------------------------------------------------------------------
# Print results.
# ------------------------------------------------------------------------------

if [ "${#WARNINGS[@]}" -eq 0 ]; then
  exit 0
fi

echo "" >&2
echo "[placement-gate] $TOOL_NAME would create misplaced file:" >&2
for w in "${WARNINGS[@]}"; do
  echo "  - $w" >&2
done
echo "" >&2
echo "See: kookr-toolkit:placement-picker skill (or <kookr>/CLAUDE.md routing table)." >&2
echo "Suppress this call: prepend KOOKR_PLACEMENT_GATE_SKIP=1 to env." >&2

if [ "$STRICT" = 1 ]; then
  echo "[placement-gate] STRICT MODE (sentinel present) — blocking." >&2
  exit 2
fi

exit 0
