#!/usr/bin/env bash
# check-shell-portability.sh — flag GNU-only / bash-4-only shell idioms in
# changed lines so they don't break on macOS (BSD coreutils + bash 3.2).
#
# macOS ships bash 3.2 (frozen at GPLv2) and BSD variants of sed/grep/stat/
# date/readlink/find/xargs. Idioms that work on Debian/Linux silently fail or
# misbehave there. This catches the *statically detectable* class — GNU-only
# flags and bash-4-only syntax — at zero cost on every PR. It cannot catch
# runtime-only issues (missing /proc, exec-bit loss, sun_path limits, empty
# array expansion under `set -u`); those are the macOS CI job's responsibility.
#
# Scans only lines ADDED in the current branch's diff vs a base ref, so it
# cannot be drowned out by pre-existing references. Exits 0 when clean, 1 on
# violations, 2 on a bad explicit base ref. The script is itself bash-3.2 /
# set -u safe so it executes on macOS — but its grep `\b` word boundaries
# assume GNU grep, so the authoritative run is the GNU-grep CI gate; a local
# macOS run (BSD grep) is advisory and may under-match.
#
# Usage:
#   scripts/check-shell-portability.sh [base-ref]
#
# With no arg, base-ref defaults to origin/main and the check is SKIPPED if
# that ref is absent (local dev). An explicit base-ref that cannot be resolved
# is a hard error (exit 2) — a CI gate must never pass vacuously.
#
# Optional caller restriction:
#   SHELL_PORTABILITY_PATHS_FILE=/tmp/paths scripts/check-shell-portability.sh
#
# The file is newline-delimited git pathspecs selected by the caller. This lets
# hooks restrict the scan to shell/subprocess files while keeping this script's
# default base-ref semantics.
#
# Optional full-tree scan:
#   SHELL_PORTABILITY_SCAN_ALL=1 scripts/check-shell-portability.sh
#
# This is for first-push/fresh-clone hooks where every committed file is the
# publication set and no merge base exists yet.
#
# Opt out a single intentional line by appending a `portability-ok` comment.

set -uo pipefail

# Distinguish "no base given" (default + skip-if-absent, for local dev) from
# "an explicit base was given but is unresolvable" (hard error). The latter
# means a CI invocation passed a bad/empty ref — failing loudly beats a
# silent exit-0 that lets violations through the gate.
if [ "${SHELL_PORTABILITY_SCAN_ALL:-}" = "1" ]; then
  BASE=""
elif [ "$#" -ge 1 ]; then
  BASE="$1"
  if [ -z "$BASE" ] || ! git rev-parse --verify --quiet "$BASE" >/dev/null 2>&1; then
    echo "check-shell-portability: explicit base ref '$BASE' is empty or unresolvable." >&2
    exit 2
  fi
else
  BASE="origin/main"
  if ! git rev-parse --verify --quiet "$BASE" >/dev/null 2>&1; then
    echo "check-shell-portability: base ref '$BASE' not found; skipping." >&2
    exit 0
  fi
fi

PATHS=(.)
if [ -n "${SHELL_PORTABILITY_PATHS_FILE:-}" ]; then
  if [ ! -f "$SHELL_PORTABILITY_PATHS_FILE" ]; then
    echo "check-shell-portability: paths file '$SHELL_PORTABILITY_PATHS_FILE' not found." >&2
    exit 2
  fi

  PATHS=()
  while IFS= read -r pathspec || [ -n "$pathspec" ]; do
    [ -z "$pathspec" ] && continue
    PATHS+=("$pathspec")
  done < "$SHELL_PORTABILITY_PATHS_FILE"

  if [ "${#PATHS[@]}" -eq 0 ]; then
    echo "check-shell-portability: no caller-selected paths to scan."
    exit 0
  fi
fi

# Added lines only (`+` prefix, not the `+++` headers), with the leading `+`
# stripped and any `portability-ok` opt-out lines removed up front.
#
# Excluded paths:
#   - *.md — Markdown is prose, not executed shell. Docs (skills, READMEs,
#     this catalog) legitimately *quote* the very idioms we flag.
#   - the linter's own source and test — they contain the idioms in regexes,
#     messages, and fixtures, so scanning them would make the gate self-flag.
if [ -n "$BASE" ]; then
  ADDED=$( { git diff --unified=0 --no-color "$BASE...HEAD" -- \
      "${PATHS[@]}" \
      ':(exclude)*.md' \
      ':(exclude)*check-shell-portability.sh' \
      ':(exclude)*check-shell-portability.test.sh' \
    | grep -E '^\+[^+]' \
    | sed 's/^+//' \
    | grep -vE 'portability-ok'; } || true )
else
  ADDED=$( { git grep -hI -e . -- \
      "${PATHS[@]}" \
      ':(exclude)*.md' \
      ':(exclude)*check-shell-portability.sh' \
      ':(exclude)*check-shell-portability.test.sh' \
    | grep -vE 'portability-ok'; } || true )
fi

FOUND=0

# report REGEX MESSAGE — print any added lines matching REGEX with MESSAGE.
report() {
  local regex=$1
  local message=$2
  local matches
  matches=$( printf '%s\n' "$ADDED" | grep -nE "$regex" || true )
  if [ -n "$matches" ]; then
    FOUND=1
    echo "  ✗ $message"
    printf '%s\n' "$matches" | sed 's/^/      /'
    echo
  fi
}

if [ -n "$ADDED" ]; then
  # --- BSD vs GNU coreutils flags ---
  report 'grep[[:space:]]+(-[a-zA-Z]*P|--perl-regexp)' \
    'grep -P / --perl-regexp: BSD grep has no PCRE. Use a POSIX ERE (grep -E) or perl/awk.'
  report '\breadlink[[:space:]]+(-[a-zA-Z]*f|--canonicalize)' \
    'readlink -f: unsupported on older macOS readlink. Use a portable realpath helper or python/perl.'
  report '\bstat[[:space:]]+(-c|--format|--printf)' \
    'stat -c/--format: GNU-only. BSD stat uses -f with different specifiers (gate on uname).'
  report '\bdate[[:space:]]+(-d|--date)\b' \
    'date -d/--date: GNU-only. BSD date uses -v or -j -f (gate on uname).'
  # Flag clusters too: -rn / -nr (not just bare -r). `sed -E` has no `r`, so
  # it is not matched. `sed -i` / `-i.bak` have no `r` either.
  report '\bsed[[:space:]]+-[a-zA-Z]*r' \
    'sed -r (incl. -rn/-nr): GNU-only. Use sed -E (supported by both GNU and BSD).'
  report '\bfind\b.*-printf' \
    'find -printf: GNU-only. Use -exec / -print0 + a formatter instead.'
  # Clusters: -r, -0r, -rn1, ... (digits + other flags around the r).
  report '\bxargs[[:space:]]+(-[a-zA-Z0-9]*r|--no-run-if-empty)' \
    'xargs -r/--no-run-if-empty: GNU-only. Guard the input instead (BSD xargs lacks -r).'

  # --- sed -i: GNU `sed -i` takes no suffix; BSD requires one (sed -i '') ---
  # Portable forms exempted: -i.suffix, -i'' / -i"" (attached empty), and the
  # space-separated two-arg -i '' / -i "" form.
  sed_hits=$( printf '%s\n' "$ADDED" \
    | grep -nE '\bsed[[:space:]]+-i' \
    | grep -vE "sed[[:space:]]+-i(''|\"\"|\.[A-Za-z0-9_]+|[[:space:]]+(''|\"\"))" \
    || true )
  if [ -n "$sed_hits" ]; then
    FOUND=1
    echo "  ✗ sed -i without an explicit suffix: GNU edits in place, BSD treats the next"
    echo "    token as the backup suffix. Use 'sed -i.bak ... && rm' or a tmpfile, and for"
    echo "    no-backup BSD use the two-arg 'sed -i \"\" ...' form."
    printf '%s\n' "$sed_hits" | sed 's/^/      /'
    echo
  fi

  # --- bash 4+ syntax (macOS system bash is 3.2) ---
  report '\b(mapfile|readarray)\b' \
    'mapfile/readarray: bash 4+. Read into an array with a while-read loop for bash 3.2.'
  report '\$\{[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?(,,|\^\^|,|\^)[^}]*\}' \
    '${var,,} / ${var^^} case conversion: bash 4+. Use tr for bash 3.2.'
  report '\b(declare|local|typeset)[[:space:]]+-[a-zA-Z]*A\b' \
    'declare -A (associative arrays): bash 4+. Not available on macOS bash 3.2.'
  # Match flag clusters containing e or n: -e, -n, -en, -ne.
  report '\becho[[:space:]]+-[a-zA-Z]*[en]' \
    'echo -e/-n (incl. -en/-ne): not portable (literal under POSIX /bin/sh). Use printf.'
fi

if [ "$FOUND" -eq 0 ]; then
  echo "check-shell-portability: no GNU-only / bash-4-only idioms in added lines."
  exit 0
fi

cat <<'EOF'
check-shell-portability: FAILED — added lines use idioms that break on macOS.

macOS ships bash 3.2 and BSD coreutils. Fix the lines above, or if a line is
intentional (e.g. gated behind a `uname` check) append a `portability-ok`
comment to it. See plugin/skills/shell-subprocess-safety for the full catalog.
EOF
exit 1
