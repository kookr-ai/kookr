#!/usr/bin/env bash
# probe-codex-plugin-dir.sh — does the configured Codex CLI advertise --plugin-dir?
#
# Usage (sourced):
#   . "$REPO_ROOT/scripts/lib/probe-codex-plugin-dir.sh"
#   probe_codex_plugin_dir [--ignore-exported] [--base-environ FILE] [ENV_FILE ...]
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
# resolution itself runs in Node with the same `process.loadEnvFile()`, so for
# the server's own `.env` the dotenv parsing and "already set wins" rules
# cannot drift from the server's. (A systemd EnvironmentFile is parsed by
# systemd, not Node; the two agree on the plain KEY=value lines that
# docs/reference/production-server-service.md documents.)
# `--ignore-exported` drops this shell's own KOOKR_CODEX_BIN first, for a
# server (e.g. under systemd) that never inherits this shell's environment.
#
# `--base-environ FILE` (issue #3413, Linux + systemd) reads the running
# server's own environment from a NUL-separated environ dump (e.g.
# /proc/<MainPID>/environ) and uses it as the base the ENV_FILE(s) are applied
# on top of. This is the only faithful source under systemd: it carries every
# systemd environment source (environment.d, `systemctl --user
# import-environment`, unit `Environment=`, `EnvironmentFile=`) AND the PATH the
# server searches, none of which the restart shell shares. A bare codex name is
# then resolved on the SERVER's PATH, not this shell's; when it is not found on
# that PATH the result is `not-installed` (the probe never silently falls back
# to a different `codex` on this shell's PATH). `--base-environ` supersedes both
# the shell's exported value and `--ignore-exported`, since the environ dump
# already holds whatever the server actually inherited.
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

# Node program for --base-environ: start from the running server's own
# environment (a NUL-separated /proc/<pid>/environ dump), apply the env files on
# top exactly as the server's process.loadEnvFile() does (never overriding a key
# already present), then resolve KOOKR_CODEX_BIN || "codex" on the SERVER's PATH.
# argv[1] is the environ dump; argv[2..] are the env files in load order.
# Prints two lines: the resolved absolute path (empty when a bare name is not on
# the server's PATH) and the display name the probe reports. A path (anything
# containing "/") is kept verbatim — the server would exec it as given, and the
# caller's own existence check decides whether it is usable.
_PROBE_CODEX_BIN_BASE_ENVIRON_RESOLVER='
const fs = require("node:fs");
const path = require("node:path");
const [environFile, ...envFiles] = process.argv.slice(1);
for (const key of Object.keys(process.env)) delete process.env[key];
try {
  const raw = fs.readFileSync(environFile, "utf8");
  for (const entry of raw.split("\u0000")) {
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    process.env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
} catch { /* unreadable environ: resolve against an empty base */ }
for (const file of envFiles) {
  try { process.loadEnvFile(file); } catch { /* absent or unreadable: skip */ }
}
const name = process.env.KOOKR_CODEX_BIN || "codex";
let resolved = "";
if (name.includes("/")) {
  resolved = name;
} else {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) { resolved = candidate; break; }
    } catch { /* not in this dir */ }
  }
}
process.stdout.write(resolved + "\n" + name);
'

# Run "$@" with a SECONDS limit; return 124 when the limit is hit, like GNU
# `timeout`. Stock macOS ships no `timeout`, and without this fallback every
# probe there failed with 127 and reported a working fork as not-installed.
# Order: GNU `timeout`, Homebrew's `gtimeout`, then a perl alarm (perl ships
# with macOS). The alarm survives `exec`, so SIGALRM ends the command itself;
# bash reports that as 142 (128 + SIGALRM), mapped to 124 here.
_probe_run_with_timeout() {
  local secs="$1" status
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then
    perl -e 'alarm shift; exec @ARGV or exit 127' "$secs" "$@"
    status=$?
    [ "$status" -eq 142 ] && return 124
    return "$status"
  else
    "$@"
  fi
}

probe_codex_plugin_dir() {
  local ignore_exported=0
  local base_environ=""
  while [ "$#" -gt 0 ]; do
    case "${1:-}" in
      --ignore-exported)
        ignore_exported=1
        shift
        ;;
      --base-environ)
        base_environ="${2:-}"
        shift
        [ "$#" -gt 0 ] && shift
        ;;
      *)
        break
        ;;
    esac
  done

  unset PROBE_TIMED_OUT
  local server_bin_missing=0

  if [ -n "$base_environ" ] && command -v node >/dev/null 2>&1; then
    # Resolve the binary the way the running server did: from its own environ
    # (every systemd source + the server's PATH) with the env files applied on
    # top, and resolve a bare name on the SERVER's PATH — never this shell's.
    local base_out base_resolved base_name
    if base_out="$(node -e "$_PROBE_CODEX_BIN_BASE_ENVIRON_RESOLVER" "$base_environ" "$@" 2>/dev/null)"; then
      base_resolved="${base_out%%$'\n'*}"
      base_name="${base_out#*$'\n'}"
    else
      base_resolved=""
      base_name="codex"
    fi
    if [ -n "$base_resolved" ]; then
      PROBE_CODEX_BIN="$base_resolved"
    else
      # The server's codex is not on the server's PATH. Report it as missing
      # rather than falling back to whatever `codex` this shell's PATH has — that
      # cross-PATH fallback is the mismatch #3413 fixes.
      PROBE_CODEX_BIN="${base_name:-codex}"
      server_bin_missing=1
    fi
  else
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
  fi

  if [ "$server_bin_missing" -eq 1 ]; then
    PROBE_RESULT="not-installed"
    return 0
  fi

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
  # cold-start cargo/node startup. The runner returns 124 on hit. Bracket the
  # call with set +e/set -e so we capture the real exit code under callers
  # that run with errexit (prod-restart.sh) — `|| true` would swallow it.
  local help_output timeout_status prev_e
  case $- in *e*) prev_e=1 ;; *) prev_e=0 ;; esac
  set +e
  help_output="$(_probe_run_with_timeout 5 "$PROBE_CODEX_BIN" --help 2>/dev/null)"
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
