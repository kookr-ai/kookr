#!/usr/bin/env bash
# Tests for plugin/scripts/mutation-check.sh (issue #4105): a mutation check
# that runs in a throwaway git worktree and never writes to the caller's
# checkout.
#
# Hermetic: every case runs the script against a small git repository built in
# a mktemp directory. Nothing here creates a worktree of, or edits, the kookr
# checkout that holds this file.
#
# Run: bash .claude/hooks-tests/mutation-check.test.sh
# Or:  pnpm test:hooks mutation-check

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
MC="$REPO_ROOT/plugin/scripts/mutation-check.sh"

[ -f "$MC" ] || { printf 'FAIL: script not found at %s\n' "$MC" >&2; exit 1; }

# The pre-push gate exports these; they would send the git calls below to the
# pushing checkout instead of the temp repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

PASS=0
fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); printf 'ok - %s\n' "$1"; }

g() { git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false -c core.hooksPath=/dev/null "$@"; }

# A repository whose test checks add(): green at HEAD.
#   calc.sh line 1: a comment the test does not cover
#   calc.sh line 2: add() { echo $(( $1 + $2 )); }
#   calc.sh line 3: a line that contains "x" twice
# test.sh records the directory it ran in (to $RUN_LOG) before testing.
make_repo() {
  local repo="$1"
  mkdir -p "$repo"
  g -C "$repo" init -q
  cat >"$repo/calc.sh" <<'SRC'
# calculator helpers
add() { echo $(( $1 + $2 )); }
xx_unused=x
SRC
  cat >"$repo/test.sh" <<'SRC'
pwd >>"$RUN_LOG"
. ./calc.sh
got=$(add 2 3)
if [ "$got" != 5 ]; then
  echo "AssertionError: expected add 2 3 to be 5, got $got"
  exit 1
fi
echo "1 passed"
SRC
  printf 'notes v1\n' >"$repo/notes.txt"
  printf 'node_modules/\n' >"$repo/.gitignore"
  g -C "$repo" add calc.sh test.sh notes.txt .gitignore
  g -C "$repo" commit -q -m init
}

# A fingerprint of the caller's checkout: status, the uncommitted diff, and the
# content of every untracked file. `M file` stays `M file` even when its content
# is clobbered, so the diff and the content are part of it.
fingerprint() {
  local repo="$1"
  {
    g -C "$repo" status --porcelain --untracked-files=all
    g -C "$repo" diff HEAD
    g -C "$repo" ls-files -z --others --exclude-standard | while IFS= read -r -d '' f; do
      printf '== %s\n' "$f"; cat "$repo/$f"
    done
  } | cksum
}

# run_mc <tmpdir> <args...> — runs the script with TMPDIR set to a directory the
# test owns, so the test can check that nothing is left in it. Sets OUT, ERR, RC.
run_mc() {
  local tmp="$1"; shift
  mkdir -p "$tmp"
  set +e
  OUT=$(TMPDIR="$tmp" bash "$MC" "$@" 2>"$WORK/stderr" </dev/null)
  RC=$?
  set -e
  ERR=$(cat "$WORK/stderr")
}

assert_rc() { [ "$RC" -eq "$1" ] || fail "$2: expected exit $1, got $RC. stdout: $OUT stderr: $ERR"; }
assert_clean_tmp() { # $1 tmpdir, $2 repo, $3 label
  [ -z "$(ls -A "$1")" ] || fail "$3: scratch left behind in TMPDIR: $(ls -A "$1")"
  [ "$(g -C "$2" worktree list | wc -l | tr -d ' ')" = 1 ] || fail "$3: worktree still registered: $(g -C "$2" worktree list)"
}
# The test command ran somewhere other than the caller's checkout, and that
# directory is gone now.
assert_ran_in_removed_worktree() { # $1 run log, $2 repo, $3 label
  [ -s "$1" ] || fail "$3: the test command never ran"
  while IFS= read -r d; do
    [ "$d" != "$2" ] || fail "$3: the test ran in the caller's checkout"
    [ ! -e "$d" ] || fail "$3: worktree $d still exists"
  done <"$1"
}

# ---- killed, with an uncommitted edit and an untracked file in the caller ----
R="$WORK/r1"; make_repo "$R"
printf 'notes v2 (uncommitted)\n' >"$R/notes.txt"
printf 'draft\n' >"$R/untracked.txt"
BEFORE=$(fingerprint "$R")
export RUN_LOG="$WORK/run1.log"
run_mc "$WORK/t1" --repo "$R" --file calc.sh --line 2 --from '$1 + $2' --to '$1 - $2' -- sh test.sh
assert_rc 0 "killed"
[ "$(head -n 1 <<<"$OUT")" = killed ] || fail "killed: first stdout line is not 'killed': $OUT"
grep -q 'AssertionError: expected add 2 3 to be 5, got -1' <<<"$OUT" || fail "killed: failing assertion not shown: $OUT"
[ "$(fingerprint "$R")" = "$BEFORE" ] || fail "killed: caller checkout changed"
[ "$(grep -c . "$RUN_LOG")" = 2 ] || fail "killed: expected a baseline run and a mutant run, got $(cat "$RUN_LOG")"
grep -q '^add() { echo \$(( \$1 + \$2 )); }$' "$R/calc.sh" || fail "killed: caller's calc.sh was changed"
assert_clean_tmp "$WORK/t1" "$R" "killed"
assert_ran_in_removed_worktree "$RUN_LOG" "$R" "killed"
ok "killed: prints the failing assertion, caller status unchanged, worktree removed"

# ---- survived ----------------------------------------------------------------
export RUN_LOG="$WORK/run2.log"
run_mc "$WORK/t2" --repo "$R" --file calc.sh --line 1 --from 'calculator' --to 'adder' -- sh test.sh
assert_rc 1 "survived"
[ "$OUT" = survived ] || fail "survived: stdout should be 'survived': $OUT"
[ "$(fingerprint "$R")" = "$BEFORE" ] || fail "survived: caller checkout changed"
assert_clean_tmp "$WORK/t2" "$R" "survived"
assert_ran_in_removed_worktree "$RUN_LOG" "$R" "survived"
ok "survived: a change the test does not cover"

# ---- refusal: empty line address ---------------------------------------------
export RUN_LOG="$WORK/run3.log"
run_mc "$WORK/t3" --repo "$R" --file calc.sh --line '' --from '+' --to '-' -- sh test.sh
assert_rc 2 "empty address"
grep -q -- '--line is empty' <<<"$ERR" || fail "empty address: wrong message: $ERR"
[ ! -e "$RUN_LOG" ] || fail "empty address: the test ran"
assert_clean_tmp "$WORK/t3" "$R" "empty address"
ok "refused: empty line address"

run_mc "$WORK/t3b" --repo "$R" --file calc.sh --line 0 --from '+' --to '-' -- sh test.sh
assert_rc 2 "line 0"
run_mc "$WORK/t3c" --repo "$R" --file calc.sh --line 2x --from '+' --to '-' -- sh test.sh
assert_rc 2 "line 2x"
assert_clean_tmp "$WORK/t3c" "$R" "line 2x"
ok "refused: line 0 and a non-numeric line"

# ---- refusal: the replacement matches no line --------------------------------
export RUN_LOG="$WORK/run4.log"
run_mc "$WORK/t4" --repo "$R" --file calc.sh --line 2 --from 'multiply' --to 'divide' -- sh test.sh
assert_rc 2 "--from not on the line"
grep -q 'matches no line' <<<"$ERR" || fail "--from not on the line: wrong message: $ERR"
grep -q 'add() {' <<<"$ERR" || fail "--from not on the line: the addressed line is not shown: $ERR"
[ ! -e "$RUN_LOG" ] || fail "--from not on the line: the test ran"
assert_clean_tmp "$WORK/t4" "$R" "--from not on the line"
ok "refused: --from text not on the addressed line (worktree removed)"

run_mc "$WORK/t5" --repo "$R" --file calc.sh --line 9 --from '+' --to '-' -- sh test.sh
assert_rc 2 "line past the end"
grep -q 'past the end' <<<"$ERR" || fail "line past the end: wrong message: $ERR"
assert_clean_tmp "$WORK/t5" "$R" "line past the end"
ok "refused: line past the end of the file"

# ---- refusal: ambiguous or multi-line changes --------------------------------
run_mc "$WORK/t6" --repo "$R" --file calc.sh --line 3 --from 'x' --to 'y' -- sh test.sh
assert_rc 2 "--from twice on the line"
grep -q 'more than once' <<<"$ERR" || fail "--from twice: wrong message: $ERR"
run_mc "$WORK/t6b" --repo "$R" --file calc.sh --line 2 --from '+' --to "-
" -- sh test.sh
assert_rc 2 "--to with a newline"
run_mc "$WORK/t6c" --repo "$R" --file calc.sh --line 2 --from '+' --to '+' -- sh test.sh
assert_rc 2 "no-op change"
run_mc "$WORK/t6d" --repo "$R" --file ../calc.sh --line 2 --from '+' --to '-' -- sh test.sh
assert_rc 2 "--file with .."
grep -q -- "--file must not contain '..'" <<<"$ERR" || fail "--file with ..: wrong message: $ERR"
run_mc "$WORK/t6e" --repo "$R" --file calc.sh --line 2 --from '+' --to '-'
assert_rc 2 "no test command"
assert_clean_tmp "$WORK/t6" "$R" "--from twice"
assert_clean_tmp "$WORK/t6b" "$R" "--to newline"
[ "$(fingerprint "$R")" = "$BEFORE" ] || fail "refusals: caller checkout changed"
ok "refused: --from twice on a line, newline in --to, no-op, '..' path, no test"

# ---- refusal: a path that leaves the worktree through a symbolic link ---------
R4="$WORK/r4"; make_repo "$R4"
mkdir -p "$WORK/ext"
printf 'outside\n' >"$WORK/ext/y.sh"
ln -s calc.sh "$R4/link.sh"
ln -s "$WORK/ext" "$R4/linkdir"
g -C "$R4" add link.sh linkdir
g -C "$R4" commit -q -m "symlinks"
export RUN_LOG="$WORK/run6f.log"
run_mc "$WORK/t6f" --repo "$R4" --file link.sh --line 2 --from '+' --to '-' -- sh test.sh
assert_rc 2 "symlinked file"
grep -q -- '--file is a symbolic link' <<<"$ERR" || fail "symlinked file: wrong message: $ERR"
run_mc "$WORK/t6g" --repo "$R4" --file linkdir/y.sh --line 1 --from 'outside' --to 'MUTATED' -- sh test.sh
assert_rc 2 "symlinked directory"
grep -q -- '--file resolves outside the worktree' <<<"$ERR" || fail "symlinked directory: wrong message: $ERR"
[ "$(cat "$WORK/ext/y.sh")" = outside ] || fail "symlinked directory: the file outside the worktree was written"
[ ! -e "$RUN_LOG" ] || fail "symlink refusals: the test ran"
assert_clean_tmp "$WORK/t6g" "$R4" "symlinked directory"
ok "refused: a symlinked file, and a path through a symlinked directory (nothing written outside)"

# ---- red before the change ---------------------------------------------------
R2="$WORK/r2"; make_repo "$R2"
# Commit a broken add(), then fix it without committing: HEAD is red, the
# caller's working tree is green.
sed 's/\$1 + \$2/$1 * $2/' "$R2/calc.sh" >"$WORK/calc.broken"
cp "$WORK/calc.broken" "$R2/calc.sh"
g -C "$R2" commit -q -am "break add"
g -C "$R2" show HEAD~1:calc.sh >"$R2/calc.sh"
printf 'extra test data\n' >"$R2/new-fixture.txt"
BEFORE2=$(fingerprint "$R2")
export RUN_LOG="$WORK/run7.log"
run_mc "$WORK/t7" --repo "$R2" --file calc.sh --line 2 --from '$1 * $2' --to '$1 - $2' -- sh test.sh
assert_rc 3 "red baseline"
[ "$(head -n 1 <<<"$OUT")" = red ] || fail "red baseline: first stdout line is not 'red': $OUT"
grep -q 'AssertionError: expected add 2 3 to be 5, got 6' <<<"$OUT" || fail "red baseline: failure not shown: $OUT"
[ "$(grep -c . "$RUN_LOG")" = 1 ] || fail "red baseline: the mutant must not run after a red baseline"
assert_clean_tmp "$WORK/t7" "$R2" "red baseline"
assert_ran_in_removed_worktree "$RUN_LOG" "$R2" "red baseline"
[ "$(fingerprint "$R2")" = "$BEFORE2" ] || fail "red baseline: caller checkout changed"
ok "red before the change: exit 3, mutant not run, worktree removed after the failure"

# ---- --with-uncommitted: the caller's fix and untracked files are applied ----
export RUN_LOG="$WORK/run8.log"
run_mc "$WORK/t8" --repo "$R2" --with-uncommitted --file calc.sh --line 2 --from '$1 + $2' --to '$1 - $2' -- sh -c 'test -f new-fixture.txt && sh test.sh'
assert_rc 0 "--with-uncommitted"
[ "$(head -n 1 <<<"$OUT")" = killed ] || fail "--with-uncommitted: expected killed: $OUT"
[ "$(fingerprint "$R2")" = "$BEFORE2" ] || fail "--with-uncommitted: caller checkout changed"
cmp -s "$R2/calc.sh" <(g -C "$R2" show HEAD~1:calc.sh) || fail "--with-uncommitted: caller's uncommitted fix was lost"
assert_clean_tmp "$WORK/t8" "$R2" "--with-uncommitted"
assert_ran_in_removed_worktree "$RUN_LOG" "$R2" "--with-uncommitted"
ok "--with-uncommitted: applies the caller's diff and untracked files, caller unchanged"

# The caller's git config must not change the patch format.
export RUN_LOG="$WORK/run8b.log"
GIT_CONFIG_COUNT=3 GIT_CONFIG_KEY_0=diff.noprefix GIT_CONFIG_VALUE_0=true \
  GIT_CONFIG_KEY_1=color.ui GIT_CONFIG_VALUE_1=always GIT_CONFIG_KEY_2=color.diff GIT_CONFIG_VALUE_2=always \
  run_mc "$WORK/t8b" --repo "$R2" --with-uncommitted --file calc.sh --line 2 --from '$1 + $2' --to '$1 - $2' -- sh test.sh
assert_rc 0 "--with-uncommitted with diff.noprefix and color.ui=always"
assert_clean_tmp "$WORK/t8b" "$R2" "--with-uncommitted with diff config"
[ "$(fingerprint "$R2")" = "$BEFORE2" ] || fail "--with-uncommitted with diff config: caller checkout changed"
ok "--with-uncommitted ignores diff.noprefix and color.ui=always in the caller's config"

# ---- an inherited GIT_DIR does not redirect the script -------------------------
export RUN_LOG="$WORK/run9.log"
mkdir -p "$WORK/t9"
set +e
OUT=$(cd "$R" && GIT_DIR="$R2/.git" GIT_WORK_TREE="$R2" TMPDIR="$WORK/t9" bash "$MC" --file calc.sh --line 2 --from '$1 + $2' --to '$1 - $2' -- sh test.sh 2>"$WORK/stderr")
RC=$?
set -e
ERR=$(cat "$WORK/stderr")
assert_rc 0 "inherited GIT_DIR"
assert_clean_tmp "$WORK/t9" "$R" "inherited GIT_DIR"
[ "$(fingerprint "$R")" = "$BEFORE" ] || fail "inherited GIT_DIR: caller checkout changed"
[ "$(fingerprint "$R2")" = "$BEFORE2" ] || fail "inherited GIT_DIR: the other repository changed"
ok "an inherited GIT_DIR/GIT_WORK_TREE is ignored; --repo defaults to the current directory"

# ---- setup failure: not a git checkout -----------------------------------------
mkdir -p "$WORK/not-a-repo"
run_mc "$WORK/t10" --repo "$WORK/not-a-repo" --file calc.sh --line 2 --from '+' --to '-' -- sh test.sh
assert_rc 4 "not a git checkout"
[ -z "$(ls -A "$WORK/t10")" ] || fail "not a git checkout: scratch left behind"
ok "setup failure: exit 4 outside a git checkout"

# ---- --vitest: node_modules is linked, globalSetup is dropped -------------------
R3="$WORK/r3"; make_repo "$R3"
cat >"$R3/vitest.config.mts" <<'SRC'
export default { test: { globalSetup: ['./reaper.global.ts'], projects: [{ test: { name: 'unit' } }] } };
SRC
printf '{"name":"fixture"}\n' >"$R3/package.json"
g -C "$R3" add vitest.config.mts package.json
g -C "$R3" commit -q -m "vitest config"
mkdir -p "$R3/node_modules/.bin"
# A stand-in vitest: records its arguments, the generated config and where the
# cache goes, then reports a pass.
cat >"$R3/node_modules/.bin/vitest" <<'SRC'
#!/bin/sh
printf '%s\n' "$*" >>"$VITEST_ARGS"
for a in "$@"; do case "$a" in *.mjs) cp "$a" "$VITEST_CONFIG_COPY" ;; esac; done
printf '%s\n' "$MUTATION_CHECK_CACHE_DIR" >>"$VITEST_CACHE"
pwd >>"$RUN_LOG"
echo "1 passed"
SRC
chmod +x "$R3/node_modules/.bin/vitest"
BEFORE3=$(fingerprint "$R3")
export VITEST_ARGS="$WORK/vitest.args" VITEST_CONFIG_COPY="$WORK/vitest.config.copy" VITEST_CACHE="$WORK/vitest.cache" RUN_LOG="$WORK/run11.log"
# Absolute paths given through a symbolic link to the repository (as macOS
# temp paths under /var are) must still count as inside it.
ln -s "$R3" "$WORK/r3-link"
run_mc "$WORK/t11" --repo "$WORK/r3-link" --file "$WORK/r3-link/calc.sh" --line 2 --from '$1 + $2' --to '$1 - $2' --vitest "$WORK/r3-link/test.sh"
assert_rc 1 "--vitest"
[ "$OUT" = survived ] || fail "--vitest: expected survived from the stand-in: $OUT"
[ "$(grep -c . "$VITEST_ARGS")" = 2 ] || fail "--vitest: expected two vitest runs: $(cat "$VITEST_ARGS")"
while IFS= read -r args; do
  case "$args" in
    "run --config "*/wt/mutation-check.vitest.config.mjs" test.sh") ;;
    *) fail "--vitest: unexpected vitest arguments: $args" ;;
  esac
done <"$VITEST_ARGS"
grep -q "^import base from './vitest.config.mts';" "$VITEST_CONFIG_COPY" || fail "--vitest: config does not import the repository config"
grep -q '^test.globalSetup = \[\];' "$VITEST_CONFIG_COPY" || fail "--vitest: config does not drop globalSetup"
grep -q '^delete test.projects;' "$VITEST_CONFIG_COPY" || fail "--vitest: config keeps the project split"
case "$(head -n 1 "$VITEST_CACHE")" in */mutation-check.*/vite-cache) ;; *) fail "--vitest: cache dir is not in the scratch directory: $(cat "$VITEST_CACHE")" ;; esac
[ "$(fingerprint "$R3")" = "$BEFORE3" ] || fail "--vitest: caller checkout changed"
[ -x "$R3/node_modules/.bin/vitest" ] || fail "--vitest: the caller's node_modules was removed"
assert_clean_tmp "$WORK/t11" "$R3" "--vitest"
assert_ran_in_removed_worktree "$RUN_LOG" "$R3" "--vitest"
ok "--vitest: links node_modules, passes a config without globalSetup, keeps the cache in scratch, accepts paths through a symlink"

# ---- no node_modules: the install hint is printed --------------------------------
rm -rf "$R3/node_modules"
printf 'lockfileVersion: 9\n' >"$R3/pnpm-lock.yaml"
g -C "$R3" add pnpm-lock.yaml
g -C "$R3" commit -q -m lock
export RUN_LOG="$WORK/run12.log"
run_mc "$WORK/t12" --repo "$R3" --file calc.sh --line 2 --from '$1 + $2' --to '$1 - $2' -- sh test.sh
assert_rc 0 "no node_modules"
grep -q "run 'pnpm install --frozen-lockfile' there first" <<<"$ERR" || fail "no node_modules: install hint missing: $ERR"
assert_clean_tmp "$WORK/t12" "$R3" "no node_modules"
ok "no node_modules: prints the install command and still runs"

printf '\nmutation-check: %d checks passed\n' "$PASS"
