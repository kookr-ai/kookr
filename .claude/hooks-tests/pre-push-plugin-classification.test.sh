#!/usr/bin/env bash
# Regression test for the current plugin pre-push policy: runtime Kookr
# environment references are allowed in bundled plugin content, but hardcoded
# machine-specific home paths are still rejected.
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

OUT=$(cd "$TMPDIR" && PATH="$TMPDIR/bin:$PATH" bash "$HOOK" 2>&1)
if printf '%s' "$OUT" | grep -q 'Push rejected'; then
  printf 'FAIL: guarded Kookr runtime reference should be allowed in plugin/\n' >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

printf 'PASS: guarded Kookr runtime reference in plugin/ is allowed\n'

cat > "$TMPDIR/plugin/playbooks/absolute-path.md" <<'PLAYBOOK'
# Hardcoded local checkout

```bash
cd /home/alice/git/kookr
```
PLAYBOOK
git -C "$TMPDIR" add plugin/playbooks/absolute-path.md
git -C "$TMPDIR" commit -q -m "add hardcoded plugin path"
HEAD_SHA=$(git -C "$TMPDIR" rev-parse HEAD)
printf '{"sha":"%s","status":"approved"}\n' "$HEAD_SHA" > "$TMPDIR/.review-state/feature.json"

set +e
OUT=$(cd "$TMPDIR" && PATH="$TMPDIR/bin:$PATH" bash "$HOOK" 2>&1)
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  printf 'FAIL: expected pre-push to reject hardcoded home path in plugin/\n' >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

if ! printf '%s' "$OUT" | grep -q 'plugin/ contains a hardcoded absolute home path'; then
  printf 'FAIL: rejection did not explain hardcoded home paths\n' >&2
  printf '%s\n' "$OUT" >&2
  exit 1
fi

printf 'PASS: hardcoded home path in plugin/ is rejected\n'
