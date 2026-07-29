#!/usr/bin/env bash
# Regression test (#1369): `pnpm verify` runs every lane the `.hooks/pre-push`
# gate runs, in the same relative order.
#
# The previous version of this test diffed verify.sh against a HARDCODED
# lane heredoc, so it passed straight through the drift it was supposed to
# catch (four CI lanes were missing from verify.sh). This version derives the
# expected lanes from the real `.hooks/pre-push` source, so adding a lane to
# the pre-push gate without adding it to verify.sh fails here.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
VERIFY_SCRIPT="$REPO_ROOT/scripts/verify.sh"
PREPUSH="$REPO_ROOT/.hooks/pre-push"

for f in "$VERIFY_SCRIPT" "$PREPUSH"; do
  if [ ! -f "$f" ]; then
    printf 'FAIL: required file not found at %s\n' "$f" >&2
    exit 1
  fi
done

TMPDIR=$(mktemp -d -t verify-script.XXXXXX)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

# Stub `pnpm` so running verify.sh just logs each lane instead of executing it.
mkdir -p "$TMPDIR/bin"
cat > "$TMPDIR/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
exit 0
PNPM
chmod +x "$TMPDIR/bin/pnpm"

PNPM_LOG="$TMPDIR/pnpm.log" PATH="$TMPDIR/bin:$PATH" bash "$VERIFY_SCRIPT" >/dev/null

# verify.sh lanes, in execution order (the stub logs the full arg string; the
# first token is the pnpm script name).
awk '{print $1}' "$TMPDIR/pnpm.log" > "$TMPDIR/verify-lanes"

# pre-push lanes, in source order. Parse idiom-agnostically: ANY `pnpm
# <script>` invocation (not just the current `if ! pnpm <script>; then` form),
# so rewording a gate to `pnpm x || { … }` does not silently drop it from the
# required set. Drop comment lines and the non-lane `install`/`exec`/`run`
# tokens, then dedup preserving first-seen order.
grep -vE '^[[:space:]]*#' "$PREPUSH" \
  | grep -oE 'pnpm (run )?[a-z][a-z0-9:._-]*' \
  | sed -E 's/^pnpm (run )?//' \
  | grep -vxE 'install|exec|run' \
  | awk '!seen[$0]++' \
  > "$TMPDIR/prepush-lanes"

if [ ! -s "$TMPDIR/prepush-lanes" ]; then
  printf 'FAIL: parsed zero lanes from %s — parser or hook layout changed\n' "$PREPUSH" >&2
  exit 1
fi

# Assert every pre-push lane appears in verify.sh as an in-order subsequence,
# so both membership and relative order are enforced.
missing=()
last_line=0
while IFS= read -r lane; do
  [ -z "$lane" ] && continue
  match_line=$(awk -v want="$lane" -v after="$last_line" \
    'NR > after && $0 == want { print NR; exit }' "$TMPDIR/verify-lanes")
  if [ -z "$match_line" ]; then
    missing+=("$lane")
  else
    last_line="$match_line"
  fi
done < "$TMPDIR/prepush-lanes"

if [ "${#missing[@]}" -gt 0 ]; then
  printf 'FAIL: pre-push lanes missing from verify.sh (or out of order):\n' >&2
  printf '  - %s\n' "${missing[@]}" >&2
  printf '%s\n' '--- pre-push lanes (expected subsequence) ---' >&2
  cat "$TMPDIR/prepush-lanes" >&2
  printf '%s\n' '--- verify.sh lanes (actual order) ---' >&2
  cat "$TMPDIR/verify-lanes" >&2
  exit 1
fi

printf 'PASS: verify.sh runs every pre-push lane, in order\n'
