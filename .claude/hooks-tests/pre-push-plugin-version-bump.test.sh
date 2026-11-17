#!/usr/bin/env bash
# Regression test: without an integration branch, ANY change to bundled plugin
# content (skills, agents, hooks, playbooks, commands, README, ...) must be
# accompanied by a bump to the plugin.json#version LINE. This guards the
# recurring failure where plugin content ships without a version bump, so
# installed-plugin users never see it. With an integration branch configured in
# .kookr/delivery-gate.json the integration train bumps the version instead
# (issue #3793), and the push must not demand it.
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
# Echoes "STATUS<TAB>LANES<TAB>OUTPUT" for the caller to assert on, where LANES
# is the comma-separated list of pnpm lanes the hook ran (install excluded).
run_case() {
  local mutate_plugin_json="$1"
  local integration="${2:-}"
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
  if [ -n "$integration" ]; then
    mkdir -p "$TMPDIR/.kookr"
    printf '{"integrationBranch":"%s"}\n' "$integration" > "$TMPDIR/.kookr/delivery-gate.json"
  fi
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

  # The stub logs every lane it is asked to run, so a case can assert which
  # lanes (if any) ran before the hook decided.
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$PNPM_LOG"\nexit 0\n' > "$TMPDIR/bin/pnpm"
  chmod +x "$TMPDIR/bin/pnpm"

  local OUT STATUS LANES
  set +e
  OUT=$(cd "$TMPDIR" && PNPM_LOG="$TMPDIR/pnpm.log" PATH="$TMPDIR/bin:$PATH" bash "$HOOK" 2>&1)
  STATUS=$?
  set -e
  # `pnpm install` (node_modules self-heal) is setup, not a check lane.
  LANES=$(grep -v '^install' "$TMPDIR/pnpm.log" 2>/dev/null | awk '{print $1}' | paste -sd, - || true)
  rm -rf "$TMPDIR"
  printf '%s\t%s\t%s' "$STATUS" "$LANES" "$OUT"
}

# Case 1: plugin content changed, no version bump -> rejected.
RESULT=$(run_case "none")
STATUS="${RESULT%%	*}"
REST="${RESULT#*	}"
LANES="${REST%%	*}"
OUT="${REST#*	}"
if [ "$STATUS" -eq 0 ]; then
  printf 'FAIL: plugin change without version bump was accepted\n' >&2
  FAILURES=$((FAILURES + 1))
elif ! grep -q 'without bumping plugin.json#version' <<<"$OUT"; then
  printf 'FAIL: rejection did not cite the missing version bump\n%s\n' "$OUT" >&2
  FAILURES=$((FAILURES + 1))
elif [ -n "$LANES" ]; then
  # Issue #3646: the bump check is a millisecond git read, so it must reject
  # before any type-check or test lane spends minutes.
  printf 'FAIL: missing version bump was rejected only after lanes ran: %s\n' "$LANES" >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'PASS: plugin change without version bump is rejected before any lane runs\n'
fi

# Case 2: plugin.json touched but version line unchanged (description-only) -> rejected.
RESULT=$(run_case "description-only")
STATUS="${RESULT%%	*}"
REST="${RESULT#*	}"
LANES="${REST%%	*}"
OUT="${REST#*	}"
if [ "$STATUS" -eq 0 ]; then
  printf 'FAIL: touching plugin.json without changing the version line was accepted\n' >&2
  FAILURES=$((FAILURES + 1))
elif [ -n "$LANES" ]; then
  printf 'FAIL: unchanged version line was rejected only after lanes ran: %s\n' "$LANES" >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'PASS: plugin.json edit that leaves the version line unchanged is rejected\n'
fi

# Case 3: plugin content changed WITH a version bump -> allowed.
RESULT=$(run_case "bump")
STATUS="${RESULT%%	*}"
REST="${RESULT#*	}"
LANES="${REST%%	*}"
OUT="${REST#*	}"
if [ "$STATUS" -ne 0 ]; then
  printf 'FAIL: plugin change with version bump was rejected\n%s\n' "$OUT" >&2
  FAILURES=$((FAILURES + 1))
elif ! grep -qx 'test' <<<"$(tr ',' '\n' <<<"$LANES")"; then
  printf 'FAIL: bumped plugin change passed without running the test lanes: %s\n' "$LANES" >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'PASS: plugin change with version bump is allowed\n'
fi

# Case 4: integration branch configured on origin/main -> the train bumps the
# version, so an unbumped plugin change is allowed (issue #3793).
RESULT=$(run_case "none" "staging")
STATUS="${RESULT%%	*}"
REST="${RESULT#*	}"
LANES="${REST%%	*}"
OUT="${REST#*	}"
if [ "$STATUS" -ne 0 ]; then
  printf 'FAIL: unbumped plugin change was rejected although the train bumps the version\n%s\n' "$OUT" >&2
  FAILURES=$((FAILURES + 1))
elif grep -q 'without bumping plugin.json#version' <<<"$OUT"; then
  printf 'FAIL: the version-bump rule fired with an integration branch configured\n%s\n' "$OUT" >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'PASS: with an integration branch, an unbumped plugin change is allowed\n'
fi

# Case 5: a delivery-gate file without an integration branch keeps the rule.
RESULT=$(run_case "none" "")
STATUS="${RESULT%%	*}"
if [ "$STATUS" -eq 0 ]; then
  printf 'FAIL: plugin change without version bump was accepted with no integration branch\n' >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'PASS: without an integration branch the bump is still required\n'
fi

if [ "$FAILURES" -ne 0 ]; then
  printf 'Results: %d failed\n' "$FAILURES" >&2
  exit 1
fi
printf 'Results: all passed\n'
