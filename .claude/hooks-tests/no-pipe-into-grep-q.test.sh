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
# catches the pattern and leaves the safe forms alone. It matches the flags-first
# style these suites use; `grep PATTERN -q`, `/usr/bin/grep -q` and `| { grep -q; }`
# slip past it.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAILURES=0

# Print "file:line: text" for each pipe into a quiet grep. A line ending in `|`
# or `\` is joined to the next so a split pipeline is still seen. Comment lines
# are dropped before the join: bash never continues a comment, so one that ends
# in `|` or `\` must not swallow the next line, and one that sits inside a split
# pipeline must not break it. awk with [ \t] (not [[:space:]]) keeps this
# portable to mawk.
scan() {
  awk '
    FNR == 1 { prev = "" }
    {
      if ($0 ~ /^[ \t]*#/) next
      line = prev $0
      if (line ~ /\\$/) { sub(/\\$/, "", line); prev = line " "; next }
      if (line ~ /\|[ \t]*$/) { prev = line " "; next }
      prev = ""
      if (line ~ /(^|[^|])\|[ \t]*(command[ \t]+)?[ef]?grep([ \t]+-[^ \t]*)*[ \t]+(-[A-Za-z]*q[A-Za-z]*|--quiet|--silent)([ \t]|$)/)
        print FILENAME ":" FNR ": " line
    }
  ' "$@"
}

# 1. The real suites are clean (this file included: its fixtures below spell
# the pipe as $P, so it does not match itself).
suites=("$SCRIPT_DIR"/*.test.sh)
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
EOF
want_bad=13
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
EOF
good_hits=$(scan "$TMP/good.sh")
if [ -z "$good_hits" ]; then
  printf 'PASS: scan ignores here-strings, non-quiet greps, || and comments\n'
else
  printf 'FAIL: scan flagged safe lines:\n%s\n' "$good_hits" >&2
  FAILURES=$((FAILURES + 1))
fi

if [ "$FAILURES" -gt 0 ]; then
  printf '%s check(s) failed\n' "$FAILURES" >&2
  exit 1
fi
