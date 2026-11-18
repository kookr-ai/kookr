#!/usr/bin/env bash
# Guard: no hook test may pipe output into `grep -q`.
#
# Under `set -o pipefail`, `printf '%s' "$out" | grep -q X` is flaky. `grep -q`
# exits at its first match; if the writer still has bytes to send, it is killed
# by SIGPIPE (exit 141), pipefail makes the whole pipeline fail, and an `if`
# takes the wrong branch even though the output did contain X. A loaded host
# makes the race likely: a hook test once reported "expected=deny got=allow"
# while its printed output showed the deny.
#
# Feed the text with a here-string instead, so no writer process can be killed:
#   grep -q X <<<"$out"
# For a chain such as `... | tail -n 3 | grep -q X`, capture the earlier stages
# first: grep -q X <<<"$(tail -n 3 <<<"$out")".
#
# This suite scans every *.test.sh in this directory (the suites
# scripts/run-hook-tests.sh runs), then checks on fixtures that the scan
# catches the pattern and leaves the safe forms alone. NO_PIPE_GREP_Q_DIR
# overrides the scanned directory; the suite uses it to run itself on a planted
# suite, so the real-directory scan is tested too.
#
# The scan reads text, not bash syntax, so a pipe into `grep -q` inside a quoted
# string or a trailing comment is flagged too (say, a hook payload such as
# 'gh issue view 5 | grep -q x'). To keep such a line, end it with the marker
#   # pipe-into-grep-q: ok
# (on the last line of a split pipeline), or spell the pipe as a variable
# ($P below, with P='|'), as this file does for its own fixtures. Arguments of
# -e and -f are skipped, so `grep -e -q`, `grep -F -e -q` and `grep -- -q` (all
# searches for the text -q) are not flagged.
#
# Known misses: the scan matches the flags-first style these suites use, so
# `grep PATTERN -q`, `/usr/bin/grep -q`, `| { grep -q; }` and a long option that
# takes a separate argument before -q (`grep --regexp x -q`) slip past it. So
# does a pipeline whose first line ends in a comment after the pipe
# (`cmd | # note`, then `grep -q x` on the next line), and a pipe after a
# backslash continuation that ends inside a quoted string
# when the next line starts with `#`:
#   echo "foo\
#   #bar" | grep -q bar
# bash reads `#bar` as string text, but the scan drops any line whose first
# non-blank character is `#` as a comment, because it does not track quotes. No
# suite has this shape; tracking quotes across lines would cost more than the
# rare miss.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAILURES=0

# Print "file:line: text" for each pipe into a quiet grep. A line ending in `|`
# or `\` is joined to the next so a split pipeline is still seen. Comment lines
# are dropped before the join: bash never continues a comment, so one that ends
# in `|` or `\` must not swallow the next line, and one that sits inside a split
# pipeline must not break it. Before the quiet flag, the first e or f in an
# option cluster takes the rest of the cluster, or else the next word, as its
# argument, so `grep -e -q` (a search for -q) is not read as quiet, nor is `-eq`
# (-e with pattern q); `grep -edone -q` still is. awk with [ \t] (not [[:space:]])
# keeps this portable to mawk; LC_ALL=C keeps the letter ranges case-exact.
scan() {
  LC_ALL=C awk '
    FNR == 1 { prev = "" }
    {
      if ($0 ~ /^[ \t]*#/) next
      line = prev $0
      if (line ~ /\\$/) { sub(/\\$/, "", line); prev = line " "; next }
      if (line ~ /\|[ \t]*$/) { prev = line " "; next }
      prev = ""
      if (line ~ /#[ \t]*pipe-into-grep-q:[ \t]*ok[ \t]*$/) next
      if (line ~ /(^|[^|])\|[ \t]*(command[ \t]+)?[ef]?grep([ \t]+(-[A-Za-dg-z0-9]*[ef]([ \t]+)?[^ \t]+|--[A-Za-z][^ \t]*|-[A-Za-dg-z0-9]+))*[ \t]+(-[A-Za-dg-z0-9]*q[A-Za-z]*|--quiet|--silent)([ \t]|$)/)
        print FILENAME ":" FNR ": " line
    }
  ' "$@"
}

# 1. The real suites are clean (this file included: its fixtures below spell
# the pipe as $P, so it does not match itself).
SCAN_DIR=${NO_PIPE_GREP_Q_DIR:-$SCRIPT_DIR}
suites=("$SCAN_DIR"/*.test.sh)
hits=$(scan "${suites[@]}")
if [ -n "$hits" ]; then
  printf 'FAIL: hook tests pipe output into grep -q (SIGPIPE flake under pipefail).\n' >&2
  printf 'Use a here-string instead: grep -q PATTERN <<<"$out"\n%s\n' "$hits" >&2
  FAILURES=$((FAILURES + 1))
else
  printf 'PASS: no hook test pipes output into grep -q (%s suites scanned)\n' "${#suites[@]}"
fi

# 2. The scan flags each unsafe form...
P='|'
cat > "$TMP/bad.sh" <<EOF
if printf '%s' "\$out" $P grep -q 'deny'; then :; fi
if ! echo "\$out" $P grep -qE "\$re"; then :; fi
printf '%s\n' "\$x" $P tr ',' '\n' $P grep -qx test
printf '%s' "\$x" $P grep -E -q foo
printf '%s' "\$x" $P grep -Fxq foo
printf '%s' "\$x" $P egrep --quiet foo
printf '%s' "\$x" $P command grep --silent foo
printf '%s' "\$x" $P
  grep -q foo
printf '%s' "\$x" $P \\
  grep -qi foo
printf '%s' "\$x" $P grep \\
  -q foo
# a comment that ends in a pipe $P
printf '%s' "\$x" $P grep -q after-pipe-comment
# a comment that ends in a backslash \\
printf '%s' "\$x" $P grep -q after-backslash-comment
printf '%s' "\$x" $P
  # a comment inside a split pipeline
  grep -q foo
printf '%s' "\$x" $P grep -e foo -q
printf '%s' "\$x" $P grep -F --line-regexp -e foo -qi
printf '%s' "\$x" $P grep -m1 -q foo
printf '%s' "\$x" $P grep -A2 -q foo
printf '%s' "\$x" $P grep -e"\$re" -q
printf '%s' "\$x" $P grep -edone -q
printf '%s' "\$x" $P grep -fe -q
printf '%s' "\$x" $P grep -5 -q foo
printf '%s' "\$x" $P grep -e -x -q
EOF
want_bad=22
got_bad=$(scan "$TMP/bad.sh" | wc -l | tr -d ' ')
if [ "$got_bad" = "$want_bad" ]; then
  printf 'PASS: scan flags every unsafe pipe-into-grep-q form (%s)\n' "$got_bad"
else
  printf 'FAIL: scan flagged %s of %s unsafe lines:\n%s\n' "$got_bad" "$want_bad" "$(scan "$TMP/bad.sh")" >&2
  FAILURES=$((FAILURES + 1))
fi

# 3. ...and leaves the safe forms alone.
cat > "$TMP/good.sh" <<EOF
if grep -q 'deny' <<<"\$out"; then :; fi
grep -qx test <<<"\$(tr ',' '\n' <<<"\$x")"
printf '%s' "\$x" $P grep -c foo
printf '%s' "\$x" $P grep -o 'q' $P head -1
printf '%s' "\$x" $P grep foo $P sort
grep -q foo file.txt $P$P true
cmd $P$P grep -q foo file.txt
# printf '%s' "\$x" $P grep -q foo   (a comment)
printf '%s' "\$x" $P grep -- -q
printf '%s' "\$x" $P grep -F -e -q
printf '%s' "\$x" $P grep -Fe -q file
printf '%s' "\$x" $P grep -eq
check "piped payload" silent 'gh issue view 5 $P grep -q x'  # pipe-into-grep-q: ok
printf '%s' "\$x" $P
  grep -q foo # pipe-into-grep-q: ok
EOF
good_hits=$(scan "$TMP/good.sh")
if [ -z "$good_hits" ]; then
  printf 'PASS: scan ignores here-strings, non-quiet greps, -e/-- arguments, ||, comments and the ok marker\n'
else
  printf 'FAIL: scan flagged safe lines:\n%s\n' "$good_hits" >&2
  FAILURES=$((FAILURES + 1))
fi

# 4. The scan of the real directory is wired up: run this file on a planted
# directory through NO_PIPE_GREP_Q_DIR. A bad suite must fail it and be named;
# a clean one must pass. Skipped inside that nested run.
if [ -z "${NO_PIPE_GREP_Q_DIR:-}" ]; then
  self="$SCRIPT_DIR/$(basename "$0")"
  mkdir -p "$TMP/planted-bad" "$TMP/planted-good"
  printf 'printf "%%s" "$out" %s grep -q deny\n' "$P" > "$TMP/planted-bad/planted.test.sh"
  printf 'grep -q deny <<<"$out"\n' > "$TMP/planted-good/planted.test.sh"
  if out=$(NO_PIPE_GREP_Q_DIR="$TMP/planted-bad" bash "$self" 2>&1); then
    printf 'FAIL: the guard passed on a directory whose suite pipes into grep -q:\n%s\n' "$out" >&2
    FAILURES=$((FAILURES + 1))
  elif ! grep -q 'planted.test.sh:1:' <<<"$out"; then
    printf 'FAIL: the guard failed on the planted directory without naming the suite:\n%s\n' "$out" >&2
    FAILURES=$((FAILURES + 1))
  elif ! out=$(NO_PIPE_GREP_Q_DIR="$TMP/planted-good" bash "$self" 2>&1); then
    printf 'FAIL: the guard failed on a clean planted directory:\n%s\n' "$out" >&2
    FAILURES=$((FAILURES + 1))
  elif ! grep -q '(1 suites scanned)' <<<"$out"; then
    printf 'FAIL: the guard did not scan the planted directory:\n%s\n' "$out" >&2
    FAILURES=$((FAILURES + 1))
  else
    printf 'PASS: the guard scans the directory it is pointed at and fails on a planted pipe into grep -q\n'
  fi
fi

if [ "$FAILURES" -gt 0 ]; then
  printf '%s check(s) failed\n' "$FAILURES" >&2
  exit 1
fi
