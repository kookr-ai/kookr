#!/usr/bin/env bash
# probe-codex-plugin-dir.sh — does the configured Codex CLI advertise --plugin-dir?
#
# Usage (sourced):
#   . "$REPO_ROOT/scripts/lib/probe-codex-plugin-dir.sh"
#   probe_codex_plugin_dir
#   # Sets: PROBE_RESULT in {ok, missing-flag, not-installed}
#   #       PROBE_TIMED_OUT (1 if --help hit the 5s timeout; otherwise unset)
#   #       PROBE_CODEX_BIN (resolved binary path or PATH-resolvable name)
#
# This file owns the diagnostic side of the "does the configured Codex
# binary support --plugin-dir?" contract. The runtime side lives in
# src/adapters/probe-agent-binary.ts (probeBinaryFlagSupport). Keep both
# probes in sync if the criterion changes.
#
# Editor's note: the function returns 0 in every case and sets PROBE_RESULT
# instead of failing, so callers under `set -euo pipefail` (e.g.
# scripts/prod-restart.sh) are safe by construction. PROBE_RESULT is a
# global — always reference it immediately after the call, before any
# branching that might short-circuit under `set -u`.

probe_codex_plugin_dir() {
  PROBE_CODEX_BIN="${KOOKR_CODEX_BIN:-codex}"
  unset PROBE_TIMED_OUT

  # Accept either an absolute executable file or a PATH-resolvable name.
  # `[ -x DIR ]` is true for traversable directories, so guard with `-f`
  # to reject non-files. `command -v` on Bash 4+ returns absolute paths
  # verbatim if the file is executable, covering the PATH-lookup case.
  if { [ -f "$PROBE_CODEX_BIN" ] && [ -x "$PROBE_CODEX_BIN" ]; } || \
     command -v "$PROBE_CODEX_BIN" >/dev/null 2>&1; then
    : # found
  else
    PROBE_RESULT="not-installed"
    return 0
  fi

  # 5-second timeout matches the TS adapter's 2s bound plus headroom for
  # cold-start cargo/node startup. `timeout` exits 124 on hit. Bracket the
  # call with set +e/set -e so we capture the real exit code under callers
  # that run with errexit (prod-restart.sh) — `|| true` would swallow it.
  local help_output timeout_status prev_e
  case $- in *e*) prev_e=1 ;; *) prev_e=0 ;; esac
  set +e
  help_output="$(timeout 5 "$PROBE_CODEX_BIN" --help 2>/dev/null)"
  timeout_status=$?
  [ "$prev_e" -eq 1 ] && set -e

  if [ "$timeout_status" -eq 124 ]; then
    PROBE_TIMED_OUT=1
    PROBE_RESULT="not-installed"  # effectively unusable; callers may render INFO
    return 0
  fi

  if printf '%s' "$help_output" | grep -q -- '--plugin-dir'; then
    PROBE_RESULT="ok"
  else
    PROBE_RESULT="missing-flag"
  fi
}
