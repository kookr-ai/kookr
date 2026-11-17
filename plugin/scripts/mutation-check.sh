#!/usr/bin/env bash
# mutation-check.sh — check that a test fails when the code it protects is
# changed, without touching the caller's checkout (issue #4105).
#
# A reviewer who wants to know whether a test really catches a regression has
# to change the source and rerun the test. Doing that in the author's checkout
# races the author's edits and pushes, and a hand-built scratch copy tends to
# miss a directory the test config imports. This script does the whole routine
# in a throwaway `git worktree` instead:
#
#   1. checks every argument, before it creates anything;
#   2. creates a detached worktree of --rev (default HEAD) in a new
#      `mktemp -d` directory, so the copy is complete and its name is unique;
#   3. with --with-uncommitted, applies the caller's uncommitted changes to
#      tracked files and copies the untracked, non-ignored files;
#   4. links each node_modules directory the caller has (top level and one
#      level down), or prints the install command when there is none;
#   5. runs the test command; if it is not green, stops with exit 3, because
#      a failure after the change would mean nothing;
#   6. changes exactly one line, addressed by number, and refuses an address
#      that is empty, out of range, or whose text does not match --from;
#   7. reruns the test and prints `killed` (with the failure lines) or
#      `survived`;
#   8. removes the worktree and the scratch directory, also on failure or on
#      Ctrl-C.
#
# Usage:
#   mutation-check.sh [options] --file PATH --line N --from OLD --to NEW -- TEST_COMMAND [ARG...]
#   mutation-check.sh [options] --file PATH --line N --from OLD --to NEW --vitest TEST_FILE [TEST_FILE...]
#
#   --file PATH         file to mutate, relative to the repository root
#   --line N            1-based line number of the line to change (required)
#   --from OLD          text that line N must contain exactly once; it is the
#                       guard against a wrong line number (required, literal,
#                       not a regular expression)
#   --to NEW            replacement for OLD (literal; may be empty to delete it;
#                       must not contain a newline)
#   --repo DIR          the caller's checkout (default: current directory)
#   --rev REV           commit to check out in the worktree (default: HEAD)
#   --with-uncommitted  also apply the caller's uncommitted changes to tracked
#                       files and copy its untracked, non-ignored files
#   --vitest FILE...    run `node_modules/.bin/vitest run` on FILE... with a
#                       generated config that keeps the repository's own
#                       config but drops `globalSetup`, so the run does not
#                       start the suite's host-wide setup and teardown (in
#                       kookr: the relay and dtach process reapers)
#   -- CMD ARG...       any other test command, run from the worktree root
#
# Exit codes:
#   0  killed     the test passed before the change and fails after it
#   1  survived   the test still passes with the change: it does not catch it
#   2  refused    bad arguments, or the change does not address one line
#   3  red        the test already fails before the change
#   4  setup      not a git repository, worktree or patch could not be made
#
# The caller's checkout is never written to: the worktree lives outside it, and
# `git status` there is the same before and after. (git records the worktree
# under .git/worktrees while it exists; the cleanup removes that record.)
#
# Portable to macOS: bash 3.2, BSD coreutils, POSIX awk.

set -u

PROG=mutation-check

die_usage() { printf '%s: %s\n' "$PROG" "$1" >&2; exit 2; }
die_setup() { printf '%s: %s\n' "$PROG" "$1" >&2; exit 4; }
note() { printf '%s: %s\n' "$PROG" "$1" >&2; }

# A caller running inside a git hook exports these; they would point every git
# command below (and the test command) at the caller's repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

FILE=""
LINE=""
LINE_SET=0
FROM=""
FROM_SET=0
TO=""
TO_SET=0
REPO_ARG="."
REV="HEAD"
WITH_UNCOMMITTED=0
MODE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --file) [ "$#" -ge 2 ] || die_usage "--file needs a path"; FILE="$2"; shift 2 ;;
    --line) [ "$#" -ge 2 ] || die_usage "--line needs a number"; LINE="$2"; LINE_SET=1; shift 2 ;;
    --from) [ "$#" -ge 2 ] || die_usage "--from needs text"; FROM="$2"; FROM_SET=1; shift 2 ;;
    --to) [ "$#" -ge 2 ] || die_usage "--to needs text (it may be empty)"; TO="$2"; TO_SET=1; shift 2 ;;
    --repo) [ "$#" -ge 2 ] || die_usage "--repo needs a directory"; REPO_ARG="$2"; shift 2 ;;
    --rev) [ "$#" -ge 2 ] || die_usage "--rev needs a revision"; REV="$2"; shift 2 ;;
    --with-uncommitted) WITH_UNCOMMITTED=1; shift ;;
    --vitest) MODE=vitest; shift; break ;;
    --) MODE=command; shift; break ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die_usage "unknown argument: $1 (the test command goes after --)" ;;
  esac
done

# ---- 1. Check every argument before creating anything ----------------------

[ -n "$MODE" ] || die_usage "no test given: end the options with -- TEST_COMMAND or --vitest TEST_FILE"
[ "$#" -gt 0 ] || die_usage "no test given: put the test command after -- or the test files after --vitest"
[ -n "$FILE" ] || die_usage "--file is required"
[ "$LINE_SET" -eq 1 ] || die_usage "--line is required"
case "$LINE" in
  '') die_usage "--line is empty: an empty address would change every line" ;;
  *[!0-9]*) die_usage "--line must be a positive integer, got '$LINE'" ;;
esac
[ "$LINE" -ge 1 ] 2>/dev/null || die_usage "--line must be a positive integer, got '$LINE'"
[ "$FROM_SET" -eq 1 ] && [ -n "$FROM" ] || die_usage "--from is required and must not be empty: it is the text line $LINE must contain"
[ "$TO_SET" -eq 1 ] || die_usage "--to is required (pass --to '' to delete the --from text)"
NL='
'
case "$TO" in *"$NL"*) die_usage "--to contains a newline: the change must stay on one line" ;; esac
case "$FROM" in *"$NL"*) die_usage "--from contains a newline: it must be text from one line" ;; esac
[ "$FROM" != "$TO" ] || die_usage "--from and --to are the same: that change would do nothing"

REPO=$(git -C "$REPO_ARG" rev-parse --show-toplevel 2>/dev/null) || die_setup "not a git checkout: $REPO_ARG"
REPO=$(cd "$REPO" && pwd -P) || die_setup "cannot enter $REPO"

# Print absolute path $1 relative to $REPO. The directory part is resolved with
# `pwd -P` first, because $REPO is resolved too: on macOS a temp path under /var
# is really under /private/var. Fails when the path is outside $REPO.
repo_rel() {
  local dir base
  dir=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || return 1
  base=$(basename "$1")
  case "$dir/" in "$REPO"/*) ;; *) return 1 ;; esac
  dir=${dir#"$REPO"}
  dir=${dir#/}
  if [ -n "$dir" ]; then printf '%s/%s\n' "$dir" "$base"; else printf '%s\n' "$base"; fi
}

# The file must be a path inside the repository. Accept an absolute path under
# the root, but never one that climbs out or goes through node_modules (that
# directory is a link to the caller's real one inside the worktree).
case "$FILE" in
  /*) FILE=$(repo_rel "$FILE") || die_usage "--file must be inside the repository ($REPO): $FILE" ;;
esac
case "/$FILE/" in
  */../*) die_usage "--file must not contain '..': $FILE" ;;
  */node_modules/*) die_usage "--file must not be under node_modules: $FILE" ;;
esac
FILE=${FILE#./}

REV_SHA=$(git -C "$REPO" rev-parse --verify --quiet "$REV^{commit}") || die_usage "--rev is not a commit: $REV"

if [ "$MODE" = vitest ]; then
  # Test files are passed relative to the worktree root.
  for t in "$@"; do
    case "$t" in -*) die_usage "--vitest takes test files only, got option '$t'" ;; esac
    case "$t" in /*) t=$(repo_rel "$t") || die_usage "--vitest file is outside the repository ($REPO): $t" ;; esac
    set -- "$@" "$t"
    shift
  done
fi

# ---- 2. Scratch directory and worktree -------------------------------------

SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/mutation-check.XXXXXX") || die_setup "mktemp failed"
SCRATCH=$(cd "$SCRATCH" && pwd -P) || die_setup "cannot enter the scratch directory"
WT="$SCRATCH/wt"
WT_ADDED=0

cleanup() {
  if [ "$WT_ADDED" -eq 1 ]; then
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
  fi
  case "$SCRATCH" in
    */mutation-check.*) rm -rf "$SCRATCH" ;;
  esac
  git -C "$REPO" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# core.hooksPath=/dev/null: a post-checkout hook in the caller's repository has
# no business running for a throwaway copy.
if ! git -C "$REPO" -c core.hooksPath=/dev/null worktree add --detach --quiet "$WT" "$REV_SHA" >"$SCRATCH/worktree.log" 2>&1; then
  cat "$SCRATCH/worktree.log" >&2
  die_setup "git worktree add failed"
fi
WT_ADDED=1

# ---- 3. The caller's uncommitted changes -----------------------------------

if [ "$WITH_UNCOMMITTED" -eq 1 ]; then
  # Pin the patch format: the caller's config (diff.noprefix, color.ui=always,
  # an external diff driver) would otherwise produce a patch git apply rejects.
  git -C "$REPO" diff --binary --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ HEAD \
    >"$SCRATCH/uncommitted.patch" || die_setup "git diff failed in $REPO"
  if [ -s "$SCRATCH/uncommitted.patch" ]; then
    if ! git -C "$WT" apply --binary --whitespace=nowarn "$SCRATCH/uncommitted.patch" 2>"$SCRATCH/apply.log"; then
      cat "$SCRATCH/apply.log" >&2
      die_setup "the uncommitted changes (taken against HEAD) do not apply to --rev $REV"
    fi
  fi
  # Untracked files that are not ignored: an author's new test file is the
  # usual case. `git diff` does not include them.
  git -C "$REPO" ls-files -z --others --exclude-standard >"$SCRATCH/untracked.list" || die_setup "git ls-files failed in $REPO"
  while IFS= read -r -d '' u; do
    [ -n "$u" ] || continue
    mkdir -p "$WT/$(dirname "$u")" && cp -p "$REPO/$u" "$WT/$u" || die_setup "could not copy untracked file $u"
  done <"$SCRATCH/untracked.list"
fi

TARGET="$WT/$FILE"
if [ -L "$TARGET" ]; then die_usage "--file is a symbolic link: $FILE"; fi
if [ ! -f "$TARGET" ]; then die_usage "--file is not a file in the worktree of $REV: $FILE"; fi
# A tracked symbolic link to a directory on the path would send the write
# outside the worktree, possibly into a real directory of the caller's.
TARGET_DIR=$(cd "$(dirname "$TARGET")" && pwd -P) || die_setup "cannot enter the directory of $FILE"
case "$TARGET_DIR/" in
  "$WT"/*) ;;
  *) die_usage "--file resolves outside the worktree (a directory on its path is a symbolic link to $TARGET_DIR): $FILE" ;;
esac

# ---- 6a. Build the mutant now, so a bad address is refused before any test run

ORIG="$SCRATCH/original"
MUTANT="$SCRATCH/mutant"
cp -p "$TARGET" "$ORIG" || die_setup "could not copy $FILE"

# awk reads the strings from the environment: `awk -v` would turn `\n` or `\\`
# in them into other characters. index()/substr() compare literally.
# Exit 3: line out of range. Exit 4: --from not on the line. Exit 5: --from
# more than once on the line.
LAST_NL=1
if [ -s "$ORIG" ] && [ -n "$(tail -c 1 "$ORIG")" ]; then LAST_NL=0; fi
MC_LINE="$LINE" MC_FROM="$FROM" MC_TO="$TO" MC_LAST_NL="$LAST_NL" awk '
  BEGIN { target = ENVIRON["MC_LINE"] + 0; from = ENVIRON["MC_FROM"]; to = ENVIRON["MC_TO"]; status = 0 }
  {
    if (NR == target) {
      p = index($0, from)
      if (p == 0) { status = 4 }
      else {
        rest = substr($0, p + length(from))
        if (index(rest, from) > 0) { status = 5 }
        else { $0 = substr($0, 1, p - 1) to rest }
      }
    }
    lines[NR] = $0
  }
  END {
    if (status == 0 && NR < target) status = 3
    if (status != 0) exit status
    for (i = 1; i <= NR; i++) {
      if (i < NR || ENVIRON["MC_LAST_NL"] == "1") print lines[i]
      else printf "%s", lines[i]
    }
  }
' "$ORIG" >"$MUTANT"
AWK_STATUS=$?
case "$AWK_STATUS" in
  0) ;;
  3) die_usage "--line $LINE is past the end of $FILE ($(wc -l <"$ORIG" | tr -d ' ') lines): the change would match no line" ;;
  4) die_usage "line $LINE of $FILE does not contain the --from text, so the change matches no line. The line is: $(sed -n "${LINE}p" "$ORIG")" ;;
  5) die_usage "line $LINE of $FILE contains the --from text more than once: use a longer --from" ;;
  *) die_setup "awk failed building the mutant (status $AWK_STATUS)" ;;
esac

# The change must touch exactly one line and keep the line count.
ORIG_LINES=$(wc -l <"$ORIG" | tr -d ' ')
MUTANT_LINES=$(wc -l <"$MUTANT" | tr -d ' ')
CHANGED=$(diff "$ORIG" "$MUTANT" | grep -c '^[<>]')
if [ "$ORIG_LINES" != "$MUTANT_LINES" ] || [ "$CHANGED" != 2 ]; then
  die_usage "the change touches $((CHANGED / 2)) line(s) and the file goes from $ORIG_LINES to $MUTANT_LINES lines; it must change exactly one line"
fi

# ---- 4. node_modules --------------------------------------------------------

for nm in "$REPO/node_modules" "$REPO"/*/node_modules; do
  [ -d "$nm" ] || continue
  rel=${nm#"$REPO"/}
  parent=$(dirname "$WT/$rel")
  [ -d "$parent" ] || continue
  [ -e "$WT/$rel" ] && continue
  ln -s "$nm" "$WT/$rel" || die_setup "could not link $rel"
done
if [ ! -d "$REPO/node_modules" ]; then
  if [ -f "$WT/pnpm-lock.yaml" ]; then hint="pnpm install --frozen-lockfile"
  elif [ -f "$WT/package-lock.json" ]; then hint="npm ci"
  elif [ -f "$WT/yarn.lock" ]; then hint="yarn install --frozen-lockfile"
  elif [ -f "$WT/package.json" ]; then hint="npm install"
  else hint=""; fi
  if [ -n "$hint" ]; then
    note "no node_modules in $REPO to link. If the test needs dependencies, run '$hint' there first."
  fi
fi

# ---- 5./7. Test runs --------------------------------------------------------

if [ "$MODE" = vitest ]; then
  VITEST="$WT/node_modules/.bin/vitest"
  [ -x "$VITEST" ] || die_setup "--vitest: no node_modules/.bin/vitest in $REPO (install the dependencies first)"
  BASE_CONFIG=""
  for c in vitest.config.mts vitest.config.ts vitest.config.mjs vitest.config.js; do
    if [ -f "$WT/$c" ]; then BASE_CONFIG="$c"; break; fi
  done
  # The generated config sits in the worktree root so its import of the base
  # config, and the base config's own imports, resolve as they do in the
  # repository. It keeps setupFiles and env, and drops globalSetup and the
  # project split. cacheDir keeps Vitest from writing its cache through the
  # node_modules link into the caller's tree.
  MC_CONFIG="$WT/mutation-check.vitest.config.mjs"
  {
    if [ -n "$BASE_CONFIG" ]; then
      printf "import base from './%s';\n" "$BASE_CONFIG"
    else
      printf 'const base = {};\n'
    fi
    cat <<'JS'
const resolved = typeof base === 'function' ? await base({ command: 'serve', mode: 'test' }) : base;
const test = { ...(resolved.test ?? {}) };
delete test.projects;
delete test.workspace;
test.globalSetup = [];
export default { ...resolved, cacheDir: process.env.MUTATION_CHECK_CACHE_DIR, test };
JS
  } >"$MC_CONFIG"
  set -- "$VITEST" run --config "$MC_CONFIG" "$@"
fi
export MUTATION_CHECK_CACHE_DIR="$SCRATCH/vite-cache"

# Lines that usually carry the failed assertion; the tail of the log when none
# match.
failure_excerpt() { # $1 = log file
  if grep -nE 'AssertionError|Assertion|[Ee]xpected|FAIL|✗|×|not ok|Error:' "$1" >"$SCRATCH/excerpt" 2>/dev/null; then
    head -n 25 "$SCRATCH/excerpt"
  else
    tail -n 25 "$1"
  fi
}

note "baseline: running the test on the unchanged copy"
if ! (cd "$WT" && "$@") >"$SCRATCH/baseline.log" 2>&1 </dev/null; then
  printf 'red\n'
  failure_excerpt "$SCRATCH/baseline.log" | sed 's/^/  /'
  note "the test fails before any change, so a failure after the change would prove nothing (exit 3)"
  exit 3
fi

cp "$MUTANT" "$TARGET" || die_setup "could not write the mutant"
note "mutant: $FILE:$LINE  '$FROM' -> '$TO'"
if (cd "$WT" && "$@") >"$SCRATCH/mutant.log" 2>&1 </dev/null; then
  printf 'survived\n'
  note "the test still passes with the change: it does not catch this regression"
  exit 1
fi
printf 'killed\n'
failure_excerpt "$SCRATCH/mutant.log" | sed 's/^/  /'
exit 0
