#!/usr/bin/env bash
# Regression test: ANY change to bundled plugin content (skills, agents, hooks,
# playbooks, commands, README, ...) must be accompanied by a bump to the
# plugin.json#version LINE. This guards the recurring failure where plugin
# content ships without a version bump, so installed-plugin users never see it.
#
# Run: bash .claude/hooks-tests/pre-push-plugin-version-bump.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

FAILURES=0

# Build a temp repo whose feature branch edits a plugin playbook. `$1` is extra
# work to run on the feature branch before committing (e.g. bump the version).
# Echoes "STATUS<TAB>OUTPUT" for the caller to assert on.
run_case() {
  local mutate_plugin_json="$1"
  local TMPDIR
  TMPDIR=$(mktemp -d -t pre-push-plugin-version-bump.XXXXXX)

  git init -q -b main "$TMPDIR"
  git -C "$TMPDIR" config user.email "test@example.com"
  git -C "$TMPDIR" config user.name "test"

  mkdir -p "$TMPDIR/plugin/.claude-plugin" "$TMPDIR/plugin/playbooks" "$TMPDIR/bin"
  printf 'base\n' > "$TMPDIR/README.md"
  printf '{\n  "name": "kookr-toolkit",\n  "version": "0.1.0"\n}\n' \
    > "$TMPDIR/plugin/.claude-plugin/plugin.json"
  printf '# Demo playbook\n\noriginal body\n' > "$TMPDIR/plugin/playbooks/demo.md"
  git -C "$TMPDIR" add -A
  git -C "$TMPDIR" commit -q -m "base"
  git -C "$TMPDIR" update-ref refs/remotes/origin/main HEAD

  git -C "$TMPDIR" checkout -q -b feature
  printf '# Demo playbook\n\nchanged body\n' > "$TMPDIR/plugin/playbooks/demo.md"
  if [ "$mutate_plugin_json" = "bump" ]; then
    printf '{\n  "name": "kookr-toolkit",\n  "version": "0.2.0"\n}\n' \
      > "$TMPDIR/plugin/.claude-plugin/plugin.json"
  elif [ "$mutate_plugin_json" = "description-only" ]; then
    printf '{\n  "name": "kookr-toolkit",\n  "version": "0.1.0",\n  "description": "touched"\n}\n' \
      > "$TMPDIR/plugin/.claude-plugin/plugin.json"
  fi
  git -C "$TMPDIR" add -A
  git -C "$TMPDIR" commit -q -m "change plugin playbook"

  local HEAD_SHA
  HEAD_SHA=$(git -C "$TMPDIR" rev-parse HEAD)
  bash "$REPO_ROOT/scripts/write-review-state-marker.sh" \
    --repo-root "$TMPDIR" --status approved --specialists "test" --key "feature" >/dev/null

  printf '#!/usr/bin/env bash\nexit 0\n' > "$TMPDIR/bin/pnpm"
  chmod +x "$TMPDIR/bin/pnpm"

  local OUT STATUS
  set +e
  OUT=$(cd "$TMPDIR" && PATH="$TMPDIR/bin:$PATH" bash "$HOOK" 2>&1)
  STATUS=$?
  set -e
  rm -rf "$TMPDIR"
  printf '%s\t%s' "$STATUS" "$OUT"
}

# Case 1: plugin content changed, no version bump -> rejected.
RESULT=$(run_case "none")
STATUS="${RESULT%%	*}"
OUT="${RESULT#*	}"
if [ "$STATUS" -eq 0 ]; then
  printf 'FAIL: plugin change without version bump was accepted\n' >&2
  FAILURES=$((FAILURES + 1))
elif ! printf '%s' "$OUT" | grep -q 'without bumping plugin.json#version'; then
  printf 'FAIL: rejection did not cite the missing version bump\n%s\n' "$OUT" >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'PASS: plugin change without version bump is rejected\n'
fi

# Case 2: plugin.json touched but version line unchanged (description-only) -> rejected.
RESULT=$(run_case "description-only")
STATUS="${RESULT%%	*}"
OUT="${RESULT#*	}"
if [ "$STATUS" -eq 0 ]; then
  printf 'FAIL: touching plugin.json without changing the version line was accepted\n' >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'PASS: plugin.json edit that leaves the version line unchanged is rejected\n'
fi

# Case 3: plugin content changed WITH a version bump -> allowed.
RESULT=$(run_case "bump")
STATUS="${RESULT%%	*}"
OUT="${RESULT#*	}"
if [ "$STATUS" -ne 0 ]; then
  printf 'FAIL: plugin change with version bump was rejected\n%s\n' "$OUT" >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'PASS: plugin change with version bump is allowed\n'
fi

if [ "$FAILURES" -ne 0 ]; then
  printf 'Results: %d failed\n' "$FAILURES" >&2
  exit 1
fi
printf 'Results: all passed\n'
