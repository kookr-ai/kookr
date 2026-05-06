#!/usr/bin/env bash
# check-portability.sh — flag user-specific absolute paths in changed lines.
#
# Scans only lines added in the current branch's diff vs a base ref so it
# cannot be drowned out by existing intentional references elsewhere in the
# repo. Exits 0 when clean, 1 when violations are found.
#
# Usage:
#   scripts/check-portability.sh [base-ref]
#
# base-ref defaults to origin/main.

set -euo pipefail

BASE="${1:-origin/main}"

if ! git rev-parse --verify --quiet "$BASE" >/dev/null 2>&1; then
  echo "check-portability: base ref '$BASE' not found; skipping." >&2
  exit 0
fi

# User-specific absolute path patterns:
#   /home/<user>/...           Linux
#   /Users/<user>/...          macOS
#   C:\Users\<user>\... or
#   C:/Users/<user>/...        Windows (case-insensitive drive letter,
#                              both separator styles)
#
# The user-name char class deliberately excludes '<' and '>', so literal
# placeholder strings like /home/<user>/foo do not match the pattern at
# all and are silently allowed without needing an EXCLUDE entry.
PATTERN='(/home/[A-Za-z0-9_.-]+/|/Users/[A-Za-z0-9_.-]+/|[Cc]:[\\/]Users[\\/][A-Za-z0-9_.-]+[\\/])'

# Allow lines that explicitly opt out with a `portability-ok` marker
# comment. The marker is treated as substring-anywhere on the line (cheap
# and safe — accidentally matching the literal string in unrelated content
# is vanishingly rare and only loosens the gate, not tightens it).
EXCLUDE='portability-ok'

# Added lines only (`+` prefix, but not the `+++` file headers). Strip the
# leading `+` so the regex doesn't match inside diff metadata. The
# trailing `|| true` converts grep's exit-1-on-no-matches into an empty
# capture without aborting under `set -o pipefail`.
HITS=$( { git diff --unified=0 --no-color "$BASE...HEAD" \
  | grep -E '^\+[^+]' \
  | sed 's/^+//' \
  | grep -nE "$PATTERN" \
  | grep -vE "$EXCLUDE"; } || true )

if [ -z "$HITS" ]; then
  echo "check-portability: no user-specific absolute paths in added lines."
  exit 0
fi

echo "check-portability: FAILED — added lines reference user-specific absolute paths:"
echo
printf '%s\n' "$HITS"
echo
cat <<'EOF'
Replace with portable equivalents where practical:
  - $HOME or ~                            instead of /home/<user>, /Users/<user>
  - Repo-root-relative paths              instead of hardcoded absolute paths
  - Env vars (CODEX_SRC, CODEX_INSTALL_DIR, KOOKR_PLUGIN_DIR, ...) for tool locations
  - Placeholders (/path/to/repo, <USER>)  in docs and examples

Allowed exceptions:
  - Documented canonical Kookr production/dev paths
  - Test fixtures that intentionally exercise path parsing
  - Lines already using $HOME / env vars / placeholders

To intentionally keep a flagged line, append a `portability-ok` comment
or document the justification in the PR description.
EOF
exit 1
