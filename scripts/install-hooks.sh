#!/usr/bin/env bash
# Installer for Kookr's in-repo Claude Code hooks and companion skills.
#
# Hooks installed today:
#   - oss-stale-scout-gate.sh — blocks gh pr create that references a
#     closed upstream issue. (PreToolUse / Bash)
#   - pr-workflow-gate.sh — blocks gh pr create until the pre-pr-review
#     skill has produced a state file proving pre-PR checks ran.
#     (PreToolUse / Bash)
#   - post-merge-keyword-scan.sh — when the user prompt mentions a merge,
#     scans open PRs in the cwd repo and surfaces ones needing rebase.
#     (UserPromptSubmit)
#
# Skills installed today:
#   - pre-pr-review — the companion skill for pr-workflow-gate.sh. It lives
#     in-repo at .claude/skills/pre-pr-review/ and is symlinked to
#     ~/.claude/skills/pre-pr-review/ so Claude Code loads it from any repo
#     (the hook fires globally, so the skill must be reachable globally).
#
# Usage:
#   bash scripts/install-hooks.sh              # install / refresh all
#   bash scripts/install-hooks.sh --uninstall  # remove all
#
# What it does:
#   1. For each hook listed below, creates a symlink under ~/.claude/hooks/
#      pointing at hooks/<name>.sh in this repo. Re-running overwrites the
#      symlink (safe; `ln -sf`).
#   2. Idempotently adds the PreToolUse registration block to
#      ~/.claude/settings.json via jq. Never duplicates an existing entry.
#   3. For each skill listed below, creates a symlink under
#      ~/.claude/skills/ pointing at .claude/skills/<name>/ in this repo.
#   4. Verifies the installation by running `bash -n` on each hook and
#      printing a short summary.
#
# This script is intentionally a shell script (not a Makefile target) so it
# works identically whether you're in the main checkout or any worktree,
# and so it can be re-run after a `git pull` without side effects.
#
# See: docs/hooks-setup.md

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="$HOME/.claude/hooks"
SKILL_DEST_DIR="$HOME/.claude/skills"
SETTINGS="$HOME/.claude/settings.json"

# Each entry: "hook_name<TAB>event<TAB>matcher<TAB>if_condition"
# event is the Claude Code event type (PreToolUse, PostToolUse,
#   UserPromptSubmit, Stop, Notification, etc.).
# matcher is the tool-name matcher (Bash, Edit, Write, etc.); leave empty
#   for events without a tool matcher (UserPromptSubmit, Stop).
# if_condition is the optional `if` filter (e.g. "Bash(gh pr create*)");
#   leave empty to fire on every matched event.
HOOKS=(
  $'oss-stale-scout-gate.sh\tPreToolUse\tBash\tBash(gh pr create*)'
  $'pr-workflow-gate.sh\tPreToolUse\tBash\tBash(gh pr create*)'
  $'post-merge-keyword-scan.sh\tUserPromptSubmit\t\t'
)

# Each entry: skill directory name under .claude/skills/ in this repo.
# The install step creates ~/.claude/skills/<name> as a symlink to the
# in-repo directory so the skill is available in any repo, not just kookr.
SKILLS=(
  'pre-pr-review'
)

warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

cmd="${1:-install}"

# Guard: never run from a worktree pointing at a branch that isn't merged.
# The user-global symlink would then point at experimental code.
current_branch=$(git -C "$REPO_DIR" symbolic-ref -q --short HEAD 2>/dev/null || echo "")
toplevel=$(git -C "$REPO_DIR" rev-parse --show-toplevel 2>/dev/null || echo "")
common_dir=$(git -C "$REPO_DIR" rev-parse --git-common-dir 2>/dev/null || echo "")
# If the common dir is not inside the current toplevel, we're in a worktree.
if [ -n "$toplevel" ] && [ -n "$common_dir" ]; then
  resolved_common=$(cd "$REPO_DIR" && cd "$common_dir" && pwd -P 2>/dev/null || echo "")
  resolved_top=$(cd "$toplevel" && pwd -P 2>/dev/null || echo "")
  case "$resolved_common" in
    "$resolved_top"/.git|"$resolved_top"/.git/) ;;
    *)
      warn "You appear to be running from a git worktree (not the main checkout)."
      warn "Installing from a worktree means the symlink will point at files in the"
      warn "  worktree branch, not main. If you continue, switch to the main checkout"
      warn "  after merging and re-run this script to repoint the symlink."
      warn "Current repo: $REPO_DIR"
      warn "Current branch: ${current_branch:-<detached>}"
      ;;
  esac
fi

ensure_jq() {
  command -v jq >/dev/null 2>&1 || die "jq is required. Install it (apt / brew / ...) and retry."
}

install_symlink() {
  local name="$1"
  local src="$REPO_DIR/hooks/$name"
  local dest="$DEST_DIR/$name"

  [ -f "$src" ] || die "Source hook not found: $src"
  bash -n "$src" || die "Source hook has syntax errors: $src"

  mkdir -p "$DEST_DIR"
  ln -sf "$src" "$dest"
  printf '  symlink  %-40s -> %s\n' "$dest" "$src"
}

install_skill_symlink() {
  local name="$1"
  local src="$REPO_DIR/.claude/skills/$name"
  local dest="$SKILL_DEST_DIR/$name"

  [ -d "$src" ] || die "Source skill not found: $src"
  [ -f "$src/SKILL.md" ] || die "Skill missing SKILL.md: $src"

  mkdir -p "$SKILL_DEST_DIR"
  # If the destination is an existing non-symlink directory the user created
  # or installed some other way, leave it alone rather than clobber real files.
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    warn "Refusing to overwrite non-symlink at $dest. Move it aside and re-run."
    return 1
  fi
  # -n keeps ln from dereferencing an existing symlink-to-dir target.
  ln -sfn "$src" "$dest"
  printf '  skill    %-40s -> %s\n' "$dest" "$src"
}

uninstall_skill_symlink() {
  local name="$1"
  local dest="$SKILL_DEST_DIR/$name"
  if [ -L "$dest" ]; then
    rm -f "$dest"
    printf '  removed  %s\n' "$dest"
  elif [ -e "$dest" ]; then
    warn "Not a symlink, leaving alone: $dest"
  fi
}

register_hook() {
  local name="$1"
  local event="$2"
  local matcher="$3"
  local if_cond="$4"
  local dest="$DEST_DIR/$name"

  # Build the entry we want to ensure exists. `if` is a reserved word in jq,
  # so we set the "if" key via index assignment instead of object-literal syntax.
  local entry
  if [ -n "$if_cond" ]; then
    entry=$(jq -n \
      --arg matcher "$matcher" \
      --arg cmd "$dest" \
      --arg ifc "$if_cond" \
      '{matcher: $matcher, hooks: [{type: "command", command: $cmd} | .["if"] = $ifc]}')
  else
    entry=$(jq -n \
      --arg matcher "$matcher" \
      --arg cmd "$dest" \
      '{matcher: $matcher, hooks: [{type: "command", command: $cmd}]}')
  fi

  if [ ! -f "$SETTINGS" ]; then
    printf '{"hooks":{}}' > "$SETTINGS"
  fi

  # Idempotently add the entry under hooks.<event> (create if missing).
  local tmp
  tmp=$(mktemp)
  # Note: jq's `//` has lower precedence than `==`, so the equality needs its
  # own parens or `"" == $cmd` evaluates first and the `//` short-circuits
  # on any non-null command.
  jq --argjson entry "$entry" --arg cmd "$dest" --arg event "$event" '
    .hooks = (.hooks // {})
    | .hooks[$event] = (.hooks[$event] // [])
    | if any(.hooks[$event][]?;
              (((.hooks // [])[0].command) // "") == $cmd)
      then .
      else .hooks[$event] += [$entry]
      end
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"

  printf '  settings registered: event=%s matcher=%s if=%s cmd=%s\n' \
    "$event" "${matcher:-<none>}" "${if_cond:-<none>}" "$dest"
}

unregister_hook() {
  local name="$1"
  local event="$2"
  local dest="$DEST_DIR/$name"
  [ -f "$SETTINGS" ] || return 0
  local tmp
  tmp=$(mktemp)
  jq --arg cmd "$dest" --arg event "$event" '
    if (.hooks[$event] // null) then
      .hooks[$event] |= map(select(
        (((.hooks // [])[0].command) // "") != $cmd
      ))
    else . end
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
  printf '  settings unregistered: event=%s cmd=%s\n' "$event" "$dest"
}

case "$cmd" in
  install)
    ensure_jq
    printf 'Installing Kookr hooks from %s\n' "$REPO_DIR"
    for row in "${HOOKS[@]}"; do
      IFS=$'\t' read -r name event matcher if_cond <<<"$row"
      install_symlink "$name"
      register_hook "$name" "$event" "$matcher" "$if_cond"
    done
    for skill in "${SKILLS[@]}"; do
      install_skill_symlink "$skill"
    done
    printf '\nDone.\n\nVerify with:\n'
    printf '  ls -l %s/\n' "$DEST_DIR"
    printf '  ls -l %s/\n' "$SKILL_DEST_DIR"
    printf '  jq .hooks %s\n' "$SETTINGS"
    printf '  pnpm test:hooks\n'
    ;;
  --uninstall|uninstall)
    ensure_jq
    printf 'Uninstalling Kookr hooks\n'
    for row in "${HOOKS[@]}"; do
      IFS=$'\t' read -r name event matcher if_cond <<<"$row"
      if [ -L "$DEST_DIR/$name" ] || [ -f "$DEST_DIR/$name" ]; then
        rm -f "$DEST_DIR/$name"
        printf '  removed  %s\n' "$DEST_DIR/$name"
      fi
      unregister_hook "$name" "$event"
    done
    for skill in "${SKILLS[@]}"; do
      uninstall_skill_symlink "$skill"
    done
    printf '\nDone.\n'
    ;;
  *)
    die "Usage: $0 [install|--uninstall]"
    ;;
esac
