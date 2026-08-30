#!/usr/bin/env bash
# Path-lint for bundled assets.
#
# Catches new bundled-asset references to user-global paths
# (~/.claude/, ~/.codex/, ~/.kookr/, /home/jean/) that aren't on the
# inline allowlist below. Designed to prevent regression of bundled
# skills silently degrading on coworker machines because they reference
# personal paths the coworker doesn't have.
#
# Each allowlist entry has a "# follow-up:" label naming the deferred
# cleanup track, or the literal "NONE — load-bearing personal path"
# (e.g. meta-skills that document Claude Code's own filesystem
# conventions).
#
# Run: bash .claude/hooks-tests/no-personal-paths.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT"

# --- Inline allowlist ---------------------------------------------------------
# Each entry: "<repo-relative-path> # follow-up: <ref>"
# <ref> is either "NONE — <reason>" or a free-form deferred-work label.
ALLOWLIST=(
  # Kookr-internal skills/playbooks/agents that legitimately reference runtime
  # user-global paths: transient distillation state at ~/.claude/{slug}-pr-lessons/,
  # Kookr config at ~/.kookr/{rate-limits,oss-repos,...}.json, and the installed
  # hook locations at ~/.claude/hooks/<name>.sh. The OSS-extension files
  # themselves are now bundled under plugin/ (issue #90), so the previous
  # "deferred OSS extension distribution" tag no longer applies — what remains
  # are universal runtime paths, not maintainer-specific ones.
  ".claude/skills/kookr-pre-push/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/kookr-oss-pr-state/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/kookr-oss-issue-scout/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/kookr-oss-repo-recon/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/kookr-oss-contribution-gate/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/kookr-oss-dashboard-verify/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/kookr-codex-pr-state/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/playbooks/oss-contribute.md # follow-up: NONE — load-bearing personal path"
  ".claude/agents/kookr-oss-issue-scout.md # follow-up: NONE — load-bearing personal path"

  # Meta-skills that legitimately document the agent runtime's filesystem
  # conventions (~/.claude/ for Claude Code, ~/.codex/ for Codex CLI,
  # ~/.kookr/ for Kookr itself). These references are universal for any
  # user of those tools, not personal to the maintainer.
  ".claude/skills/claude-code-hooks/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/claude-code-metrics-analysis/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/claude-code-permissions/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/kookr-codex-claude-compatibility/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/hook-driven-workflow-enforcement/SKILL.md # follow-up: NONE — load-bearing personal path"
  "plugin/skills/playbook-authoring/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/self-reflect/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/kookr-session-reflect/SKILL.md # follow-up: NONE — load-bearing personal path"
  ".claude/skills/kookr-shadow-detection/SKILL.md # follow-up: NONE — load-bearing personal path"

  # Distributed skills may document portable user-scope state and configuration
  # for the runtimes they support. Scanning plugin skills keeps maintainer-only
  # paths gated while these universal ~/.claude, ~/.codex, and ~/.kookr
  # contracts remain explicit.
  "plugin/skills/agent-efficiency-retrofit/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/claude-code-hooks/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/claude-code-metrics-analysis/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/claude-code-permissions/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/codex-pr-distill/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/codex-pr-plan/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/codex-pr-threshold/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/github-issue-workflow/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/hook-driven-workflow-enforcement/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/oss-fork-manager/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/oss-pr-critic/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/oss-pr-distill/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/oss-pr-plan/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/oss-pr-threshold/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/placement-picker/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/pr-contribution-excellence/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/pre-pr-review/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/reviewer-distillation-predict/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/reviewer-distillation-select/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/self-reflect/SKILL.md # follow-up: NONE — load-bearing user-scope path"
  "plugin/skills/task-feedback-reflect/SKILL.md # follow-up: NONE — load-bearing user-scope path"

  # Project CLAUDE.md: Persistence Picker section documents the Claude Code
  # filesystem convention paths (~/.claude/hooks/, ~/.claude/CLAUDE.md,
  # ~/.claude/projects/<proj>/memory/) and Kookr's own ~/.kookr/hooks/
  # log location. Universal, not maintainer-specific.
  "CLAUDE.md # follow-up: NONE — load-bearing personal path"
  "AGENTS.md # follow-up: NONE — load-bearing personal path"
)

# --- Allowlist lookups -------------------------------------------------------
# macOS ships bash 3.2, which has no associative arrays. Derive membership and
# labels by scanning the flat ALLOWLIST array instead.
is_allowed() {  # is_allowed <path>
  local entry
  for entry in "${ALLOWLIST[@]}"; do
    [ "${entry%% #*}" = "$1" ] && return 0
  done
  return 1
}

# --- Validate allowlist labels ----------------------------------------------
LABEL_FAIL=0
for entry in "${ALLOWLIST[@]}"; do
  path="${entry%% #*}"
  label="${entry#*# }"
  case "$label" in
    "follow-up: NONE"*|"follow-up: NONE — "*)
      ;;
    "follow-up: "*)
      ;;
    *)
      printf 'FAIL: allowlist entry for %q has invalid label: %q\n' "$path" "$label" >&2
      printf '      Must start with "follow-up: "\n' >&2
      LABEL_FAIL=1
      ;;
  esac
done

if [ "$LABEL_FAIL" -ne 0 ]; then
  printf '\nPath-lint allowlist validation failed.\n' >&2
  exit 1
fi

# --- Scan targets ------------------------------------------------------------
PATTERN='(~|\$HOME|\$\{HOME\}|/home/jean)/\.(claude|codex|kookr)/'
MAINTAINER_HOME_PATTERN='/home/jean/'  # portability-ok (test fixture)

TARGETS=()
[ -e "CLAUDE.md" ] && TARGETS+=("CLAUDE.md")
[ -e "AGENTS.md" ] && TARGETS+=("AGENTS.md")
while IFS= read -r f; do TARGETS+=("$f"); done < <(find .claude/skills   -name 'SKILL.md' -type f 2>/dev/null | sort)
while IFS= read -r f; do TARGETS+=("$f"); done < <(find plugin/skills   -name 'SKILL.md' -type f 2>/dev/null | sort)
while IFS= read -r f; do TARGETS+=("$f"); done < <(find .claude/agents    -name '*.md'     -type f 2>/dev/null | sort)
while IFS= read -r f; do TARGETS+=("$f"); done < <(find .claude/playbooks -name '*.md'     -type f 2>/dev/null | sort)

VIOLATIONS=0
for f in "${TARGETS[@]}"; do
  if grep -qE "$PATTERN" "$f"; then
    if ! is_allowed "$f"; then
      printf 'FAIL: %s references personal paths but is not on the allowlist.\n' "$f" >&2
      grep -nE "$PATTERN" "$f" | head -3 | sed 's/^/    /' >&2
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  fi
done

# These files are distributed directly to users or surfaced in the launcher.
# They must never carry maintainer-machine paths, even if another allowlist
# entry permits runtime-global paths such as ~/.claude elsewhere.
STRICT_TARGETS=()
[ -e ".env.example" ] && STRICT_TARGETS+=(".env.example")
while IFS= read -r f; do STRICT_TARGETS+=("$f"); done < <(git ls-files '.kookr/playbooks/*.md' 2>/dev/null | sort)
while IFS= read -r f; do STRICT_TARGETS+=("$f"); done < <(git ls-files '.claude/agents/*.md' 2>/dev/null | sort)

for f in "${STRICT_TARGETS[@]}"; do
  if grep -qF "$MAINTAINER_HOME_PATTERN" "$f"; then
    printf 'FAIL: %s contains maintainer-specific path %s.\n' "$f" "$MAINTAINER_HOME_PATTERN" >&2
    grep -nF "$MAINTAINER_HOME_PATTERN" "$f" | head -3 | sed 's/^/    /' >&2
    VIOLATIONS=$((VIOLATIONS + 1))
  fi
done

# --- Stale allowlist entries (informational, not failing) -------------------
STALE=()
for entry in "${ALLOWLIST[@]}"; do
  path="${entry%% #*}"
  if [ -e "$path" ] && ! grep -qE "$PATTERN" "$path"; then
    STALE+=("$path")
  fi
done

if [ "$VIOLATIONS" -ne 0 ]; then
  printf '\nPath-lint failed: %d file(s) with unallowlisted personal-path references.\n' "$VIOLATIONS" >&2
  printf 'Either remove the references or add the file to the allowlist with a justification.\n' >&2
  exit 1
fi

if [ "${#STALE[@]}" -gt 0 ]; then
  printf 'INFO: %d allowlist entry/entries no longer have matches and could be removed:\n' "${#STALE[@]}"
  printf '    %s\n' "${STALE[@]}"
fi

printf 'Path-lint passed: %d files scanned, %d allowlisted, 0 violations.\n' "${#TARGETS[@]}" "${#ALLOWLIST[@]}"
