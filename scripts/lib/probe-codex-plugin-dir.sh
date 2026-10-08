#!/usr/bin/env bash
# probe-codex-plugin-dir.sh — does the configured Codex CLI advertise --plugin-dir?
#
# Usage (sourced):
#   . "$REPO_ROOT/scripts/lib/probe-codex-plugin-dir.sh"
#   probe_codex_plugin_dir [--ignore-exported] [ENV_FILE ...]
#   # Sets: PROBE_RESULT in {ok, missing-flag, not-installed}
#   #       PROBE_TIMED_OUT (1 if --help hit the 5s timeout; otherwise unset)
#   #       PROBE_CODEX_BIN (resolved binary path or PATH-resolvable name)
#
# Which binary is probed: the one the Kookr server will actually launch. The
# server runs `process.loadEnvFile()` on the `.env` in its working directory,
# which never overrides a variable already in its environment, and then uses
# `KOOKR_CODEX_BIN || 'codex'` (src/server/start.ts). A shell script usually
# has NOT loaded that `.env`, so probing `${KOOKR_CODEX_BIN:-codex}` alone
# checks whatever `codex` comes first on PATH — often a stock install — and
# warns about a binary the server never runs.
#
# Pass the env files the server will load, in the order it loads them. The
# resolution itself runs in Node with the same `process.loadEnvFile()`, so the
# dotenv parsing and "already set wins" rules cannot drift from the server's.
# `--ignore-exported` drops this shell's own KOOKR_CODEX_BIN first, for a
# server (e.g. under systemd) that never inherits this shell's environment.
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

# Node program that mirrors the server's KOOKR_CODEX_BIN resolution: load each
# env file in order (missing files are skipped; a variable that is already set,
# even to "", is never overridden), then print the value. An empty result means
# the server falls back to `codex`.
_PROBE_CODEX_BIN_RESOLVER='
for (const file of process.argv.slice(1)) {
  try { process.loadEnvFile(file); } catch { /* absent or unreadable: skip */ }
}
process.stdout.write(process.env.KOOKR_CODEX_BIN || "");
'

probe_codex_plugin_dir() {
  local ignore_exported=0
  if [ "${1:-}" = "--ignore-exported" ]; then
    ignore_exported=1
    shift
  fi

  if [ "$ignore_exported" -eq 1 ]; then
    PROBE_CODEX_BIN=""
  else
    PROBE_CODEX_BIN="${KOOKR_CODEX_BIN:-}"
  fi
  # Without node (or without env files) keep the plain-shell answer above.
  local resolved
  if [ "$#" -gt 0 ] && command -v node >/dev/null 2>&1; then
    if [ "$ignore_exported" -eq 1 ]; then
      if resolved="$(env -u KOOKR_CODEX_BIN node -e "$_PROBE_CODEX_BIN_RESOLVER" "$@" 2>/dev/null)"; then
        PROBE_CODEX_BIN="$resolved"
      fi
    elif resolved="$(node -e "$_PROBE_CODEX_BIN_RESOLVER" "$@" 2>/dev/null)"; then
      PROBE_CODEX_BIN="$resolved"
    fi
  fi
  PROBE_CODEX_BIN="${PROBE_CODEX_BIN:-codex}"
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

  # Require exit 0 for a meaningful "did help advertise the flag?" answer.
  # A non-zero exit means codex itself failed (login required, broken
  # install, etc.) — we cannot trust the help text we read, so render the
  # binary as "not-installed" rather than risk a false WARN on a fork
  # binary that happens to exit non-zero, or a false OK on a stock binary
  # whose error-message text contains the substring "--plugin-dir".
  if [ "$timeout_status" -ne 0 ]; then
    PROBE_RESULT="not-installed"
    return 0
  fi

  if printf '%s' "$help_output" | grep -q -- '--plugin-dir'; then
    PROBE_RESULT="ok"
  else
    PROBE_RESULT="missing-flag"
  fi
}
