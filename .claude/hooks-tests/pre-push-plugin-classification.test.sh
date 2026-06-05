#!/usr/bin/env bash
# Regression test for issue #195: guarded Kookr runtime references still make
# plugin-tier content Kookr-specific and must be rejected.
#
# Run: bash .claude/hooks-tests/pre-push-plugin-classification.test.sh
# Or:  pnpm test:hooks

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
HOOK="$REPO_ROOT/.hooks/pre-push"

if [ ! -f "$HOOK" ]; then
  printf 'FAIL: hook not found at %s\n' "$HOOK" >&2
  exit 1
fi

TMPDIR=$(mktemp -d -t pre-push-plugin-classification.XXXXXX)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

git init -q -b main "$TMPDIR"
git -C "$TMPDIR" config user.email "test@example.com"
git -C "$TMPDIR" config user.name "test"

printf 'base\n' > "$TMPDIR/README.md"
git -C "$TMPDIR" add README.md
git -C "$TMPDIR" commit -q -m "base"
git -C "$TMPDIR" update-ref refs/remotes/origin/main HEAD

mkdir -p "$TMPDIR/plugin/playbooks" "$TMPDIR/node_modules" "$TMPDIR/bin"
cat > "$TMPDIR/plugin/playbooks/guarded.md" <<'PLAYBOOK'
# Guarded Kookr integration

```bash
if [ -n "${KOOKR_API_BASE_URL:-}" ]; then
  curl "$KOOKR_API_BASE_URL/api/issue-claims"
fi
```
PLAYBOOK

git -C "$TMPDIR" checkout -q -b feature
git -C "$TMPDIR" add plugin/playbooks/guarded.md
git -C "$TMPDIR" commit -q -m "add guarded plugin playbook"

HEAD_SHA=$(git -C "$TMPDIR" rev-parse HEAD)
mkdir -p "$TMPDIR/.review-state"
printf '{"sha":"%s","status":"approved"}\n' "$HEAD_SHA" > "$TMPDIR/.review-state/feature.json"

cat > "$TMPDIR/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
exit 0
PNPM
chmod +x "$TMPDIR/bin/pnpm"

set +e
OUT=$(cd "$TMPDIR" && PATH="$TMPDIR/bin:$PATH" bash "$HOOK" 2>&1)
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  printf 'FAIL: expected pre-push to reject guarded Kookr reference in plugin/\n' >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

if ! printf '%s' "$OUT" | grep -q 'Guarded or fallback-only Kookr integrations still make the file Kookr-specific'; then
  printf 'FAIL: rejection did not explain guarded Kookr references\n' >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

printf 'PASS: guarded Kookr reference in plugin/ is rejected\n'
