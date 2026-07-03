#!/usr/bin/env bash
# Regression test: pnpm verify runs the push-free pre-push lanes in order.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
VERIFY_SCRIPT="$REPO_ROOT/scripts/verify.sh"

if [ ! -f "$VERIFY_SCRIPT" ]; then
  printf 'FAIL: verify script not found at %s\n' "$VERIFY_SCRIPT" >&2
  exit 1
fi

TMPDIR=$(mktemp -d -t verify-script.XXXXXX)
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

mkdir -p "$TMPDIR/bin"
cat > "$TMPDIR/bin/pnpm" <<'PNPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_LOG"
exit 0
PNPM
chmod +x "$TMPDIR/bin/pnpm"

PNPM_LOG="$TMPDIR/pnpm.log" PATH="$TMPDIR/bin:$PATH" bash "$VERIFY_SCRIPT" >/dev/null

cat > "$TMPDIR/expected.log" <<'EOF'
build:server
check:e2e
validate:skills
validate:docs-commands
validate:requirements
test
EOF

if ! cmp -s "$TMPDIR/expected.log" "$TMPDIR/pnpm.log"; then
  printf 'FAIL: verify lanes did not match expected order\n' >&2
  printf '%s\n' '--- expected ---' >&2
  cat "$TMPDIR/expected.log" >&2
  printf '%s\n' '--- actual ---' >&2
  cat "$TMPDIR/pnpm.log" >&2
  exit 1
fi

printf 'PASS: verify script runs pre-push lanes in order\n'
