#!/usr/bin/env bash
# Restore the executable bit on node-pty's macOS `spawn-helper`.
#
# node-pty spawns PTYs on macOS by exec'ing a bundled `spawn-helper` binary.
# pnpm's content-addressable store drops the executable bit when it links the
# prebuilt binary into node_modules, so node-pty fails at runtime with
# "posix_spawnp failed." and Kookr cannot launch ANY agent terminal on macOS
# (the dtach master spawns, but the node-pty attach to it cannot exec). This
# is invisible on Linux, which does not use spawn-helper.
#
# Re-apply the bit after install. Idempotent; a no-op when no spawn-helper is
# present. Wired into `prepare` so it runs on every `pnpm install`.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fixed=0
while IFS= read -r helper; do
  [ -n "$helper" ] || continue
  if [ ! -x "$helper" ]; then
    chmod +x "$helper" 2>/dev/null && fixed=$((fixed + 1))
  fi
done < <(find "$REPO_ROOT/node_modules" -path '*node-pty*' -name spawn-helper 2>/dev/null)

if [ "$fixed" -gt 0 ]; then
  echo "[fix-native-perms] restored executable bit on $fixed node-pty spawn-helper(s)"
fi
exit 0
