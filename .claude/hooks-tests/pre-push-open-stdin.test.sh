#!/usr/bin/env bash
# Regression test for issue #4108: the pre-push hook bounds its read of the
# ref list. Run by hand from an agent's background shell, the hook gets a
# stdin pipe that stays open and never sends anything; it used to `cat` that
# pipe until the caller's tool timed out. It must now give up after its read
# bound and run the full gate, as it does when stdin is a terminal.
#
# The delete-only fast path through git is covered unchanged by
# pre-push-delete-only-skip.test.sh.
#
# Run: bash .claude/hooks-tests/pre-push-open-stdin.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

# The hook waits PRE_PUSH_STDIN_TIMEOUT_S (3s) for the ref list. The stubbed
# gate below adds a few seconds of git work. A hook still stuck on stdin after
# this deadline is killed and the test fails instead of hanging.
DEADLINE_S=30

# mktemp -d (no -t template): GNU and BSD/macOS agree on the bare form.
TMPDIR=$(mktemp -d)
HOLDER_PID=""
HOOK_PID=""
cleanup() {
  [ -n "$HOOK_PID" ] && kill "$HOOK_PID" 2>/dev/null || true
  [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null || true
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

repo="$TMPDIR/repo"
git init -q -b main "$repo"
git -C "$repo" config user.email "test@example.com"
git -C "$repo" config user.name "test"
mkdir -p "$repo/node_modules" "$repo/bin" "$repo/src"
cat > "$repo/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
exit 0
PNPM
chmod +x "$repo/bin/pnpm"
printf 'base\n' > "$repo/README.md"
printf 'code\n' > "$repo/src/index.ts"
git -C "$repo" add README.md src/index.ts
git -C "$repo" commit -q -m "base"
git -C "$repo" update-ref refs/remotes/origin/main HEAD
git -C "$repo" checkout -q -b feature
printf 'change\n' > "$repo/src/index.ts"
git -C "$repo" add src/index.ts
git -C "$repo" commit -q -m "change"
bash "$REPO_ROOT/scripts/write-review-state-marker.sh" \
  --repo-root "$repo" --status approved --specialists "test" --key "feature" >/dev/null

ZERO_SHA="0000000000000000000000000000000000000000"
UPDATE_SHA="1111111111111111111111111111111111111111"

# Run the hook with stdin connected to a FIFO whose write end a background
# writer holds open forever after writing $2 (possibly nothing): the hook's
# stdin is a pipe, not a terminal, and never reaches end of input, like an
# agent's background shell. Asserts the hook finishes within DEADLINE_S, prints
# the timeout notice, skips the delete-only fast path and runs the full gate.
run_open_stdin_case() {
  local name="$1"
  local stdin_data="$2"
  local fifo="$TMPDIR/$name.fifo"
  local out_file="$TMPDIR/$name.out"
  local start hook_status elapsed out lane

  : > "$repo/pnpm.log"
  mkfifo "$fifo"
  if [ -n "$stdin_data" ]; then
    { printf '%s\n' "$stdin_data"; exec sleep 600; } > "$fifo" &
  else
    sleep 600 > "$fifo" &
  fi
  HOLDER_PID=$!

  start=$(date +%s)
  (cd "$repo" && PNPM_LOG="$repo/pnpm.log" PATH="$repo/bin:$PATH" exec bash "$HOOK") \
    < "$fifo" > "$out_file" 2>&1 &
  HOOK_PID=$!

  while kill -0 "$HOOK_PID" 2>/dev/null; do
    if [ $(( $(date +%s) - start )) -ge "$DEADLINE_S" ]; then
      printf 'FAIL(%s): hook still running after %ss with an open stdin pipe\n' "$name" "$DEADLINE_S" >&2
      cat "$out_file" >&2
      exit 1
    fi
    sleep 1
  done
  hook_status=0
  wait "$HOOK_PID" || hook_status=$?
  HOOK_PID=""
  elapsed=$(( $(date +%s) - start ))
  kill "$HOLDER_PID" 2>/dev/null || true
  HOLDER_PID=""
  out=$(cat "$out_file")

  if [ "$hook_status" -ne 0 ]; then
    printf 'FAIL(%s): hook exited %s (expected 0 from the stubbed gate)\n' "$name" "$hook_status" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi

  # The hook must have waited out its read bound, not skipped it.
  if ! grep -q "no ref list on stdin within" <<<"$out"; then
    printf 'FAIL(%s): timeout notice not printed\n' "$name" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi

  # It fell through to the full gate rather than the delete-only fast path.
  if grep -q "delete-only push" <<<"$out"; then
    printf 'FAIL(%s): open stdin took the delete-only fast path\n' "$name" >&2
    printf '%s\n' "$out" >&2
    exit 1
  fi
  for lane in "build:server" "test"; do
    if ! grep -Fxq "$lane" "$repo/pnpm.log"; then
      printf 'FAIL(%s): expected gate lane "pnpm %s" to run\n' "$name" "$lane" >&2
      printf '%s\n' '--- pnpm.log ---' >&2
      cat "$repo/pnpm.log" >&2
      exit 1
    fi
  done

  printf 'PASS(%s): hook ran the full gate after its read bound (%ss total)\n' "$name" "$elapsed"
}

# --- Case 1: the pipe stays open and sends nothing -------------------------
run_open_stdin_case "silent" ""

# --- Case 2: a delete line arrives, then the pipe stays open ----------------
# The list may be incomplete (a later line could be an update), so the hook
# must discard it on timeout and run the gate, not take the delete-only path.
run_open_stdin_case "partial-delete" "(delete) $ZERO_SHA refs/heads/feature $UPDATE_SHA"

printf 'PASS: an open stdin pipe never hangs the hook or skips the gate\n'
