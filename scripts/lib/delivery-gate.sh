#!/usr/bin/env bash
# Delivery-gate configuration reader (issue #3788).
#
# One tracked file, `.kookr/delivery-gate.json`, turns on the fast pre-push gate
# and names the integration branch that pull requests merge into:
#
#   { "integrationBranch": "staging", "prePushGate": "fast" }
#
# The file is absent by default, which means the legacy behaviour everywhere:
# the full suite runs on every push and pull requests merge into their own base.
#
# The copy on `origin/main` wins over the working tree. `main` only ever holds
# fully verified commits, so reverting the file there turns the feature off for
# every worktree at its next fetch, including worktrees cut before the revert.
# The working-tree copy is used only when `origin/main` does not exist.
#
# Kill switch: a file named `kookr-full-gate` in the git common directory forces
# the full pre-push gate in every worktree of this clone at once, without a
# commit. It does not change the integration branch.
#
# Source this file; it defines functions and runs nothing.

# Prints the config JSON, or nothing when the feature is off.
delivery_gate_config_json() {
  local json=""
  if git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    json=$(git show origin/main:.kookr/delivery-gate.json 2>/dev/null || true)
  else
    local root
    root=$(git rev-parse --show-toplevel 2>/dev/null || true)
    if [ -n "$root" ] && [ -f "$root/.kookr/delivery-gate.json" ]; then
      json=$(cat "$root/.kookr/delivery-gate.json")
    fi
  fi
  [ -n "$json" ] && printf '%s\n' "$json"
  return 0
}

# Prints the integration branch name, or nothing when none is configured.
delivery_gate_integration_branch() {
  local json branch
  json=$(delivery_gate_config_json)
  [ -n "$json" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  branch=$(printf '%s' "$json" | jq -r '.integrationBranch // empty' 2>/dev/null || true)
  # A branch name, not a ref expression: reject anything git would parse oddly.
  case "$branch" in
    ''|-*|*..*|*[!A-Za-z0-9._/-]*) return 0 ;;
  esac
  printf '%s\n' "$branch"
}

# Prints "fast" or "full". Anything unreadable or unknown is "full".
delivery_gate_prepush_mode() {
  local common json mode
  common=$(git rev-parse --git-common-dir 2>/dev/null || true)
  if [ -n "$common" ] && [ -e "$common/kookr-full-gate" ]; then
    printf 'full\n'
    return 0
  fi
  json=$(delivery_gate_config_json)
  if [ -n "$json" ] && command -v jq >/dev/null 2>&1; then
    mode=$(printf '%s' "$json" | jq -r '.prePushGate // empty' 2>/dev/null || true)
    if [ "$mode" = "fast" ]; then
      printf 'fast\n'
      return 0
    fi
  fi
  printf 'full\n'
}
