# RFC: Doctor / Dashboard Surface for Codex-Fork Detection

**Status:** Draft (v3 — post round-2 review, ready for user review)
**Date:** 2026-05-10
**Author:** Jean Ibarz (with Claude)
**Tracking issue:** [#243](https://github.com/kookr-ai/kookr/issues/243)
**Merge prerequisites:** [#241](https://github.com/kookr-ai/kookr/pull/241) and [#242](https://github.com/kookr-ai/kookr/pull/242), both already on `main`.

---

## Problem

PRs [#241](https://github.com/kookr-ai/kookr/pull/241) and [#242](https://github.com/kookr-ai/kookr/pull/242) shipped the Codex `--plugin-dir` adapter wiring with a runtime capability probe. The kookr-fork of Codex (jeanibarz/codex#52) advertises `--plugin-dir` in `codex --help`, so the adapter auto-injects the plugin tree. Stock Codex (`npm i -g @openai/codex`) does not, so the adapter skips injection and emits a one-time `console.warn` pointing at `pnpm codex:rebuild`.

The warn is the only signal a dev gets that their Codex sessions will not see the kookr-toolkit. It fires:

- exactly once per adapter instance, and
- only on the **first** launch attempt that would have injected the plugin dir.

For a developer who installs stock Codex globally, runs Kookr for several Claude tasks, then attempts a Codex task, the warn lands inside a `dist/server` log line that nothing on the dashboard surfaces. They will keep launching Codex tasks that silently miss kookr-toolkit until they happen to read server stderr.

The fix shape is clear: surface the gap proactively somewhere the dev will notice. The design space has at least four reasonable answers, and they are not mutually exclusive. This RFC picks the right surface(s), settles the open questions, and answers them in a way that is consistent with Kookr's "single-tenant local repo, supervisor not coder, simple first" principles.

## Goals

- A first-time Kookr dev who installed stock Codex finds out their setup is incomplete **before** they spend session time wondering why a Codex run is missing the toolkit.
- A returning dev who ran `pnpm codex:rebuild` once and later upgraded stock Codex over the top can detect the regression in under a minute, on demand.
- The signal points at a single recipe (`pnpm codex:rebuild`) and a single issue link (jeanibarz/codex#52), not at adapter internals.

## Non-goals

- No auto-rebuild of the Codex fork. The build is 7+ minutes; offering it from a button click would need progress UI Kookr does not have, and `pnpm codex:rebuild` already handles the case.
- No vendoring of a prebuilt Codex binary (rejected previously — 256 MB × platforms).
- No making the kookr-fork the default install path. "You must use the fork" is a strategic question we do not need to answer to fix discoverability.
- No `pnpm install` time probe. Devs who never use Codex should not pay for the diagnostic.
- No new "system status" dashboard panel. We are answering one onboarding-discoverability question, not designing a generic infrastructure surface.
- No telemetry on whether the warn was seen.

## Surfaces considered

The issue body listed four candidate surfaces:

| # | Surface | When it fires | Cost |
|---|---|---|---|
| 1 | `pnpm doctor` extension | On demand. | ~30 lines in shell + ~25 lines in a shared probe lib. |
| 2 | Server-startup probe (`pnpm dev`) | Every restart. | ~20 lines, but adds noise on every dev cycle. |
| 3 | Dashboard info card | Always rendered when relevant. | New WS message + React component + onboarding-status integration. |
| 4 | Launch-time `console.warn` (already shipped) | First Codex launch only. | Done. |

**Recommendation:** Ship #1 and keep #4. Defer #3, reject #2.

- **Doctor extension** — lowest blast radius, on-demand only, reuses `scripts/doctor.sh`'s established `OK / FAIL / WARN / INFO` row + fix-line shape. New onboarding docs can point to a single command (`pnpm doctor`) rather than four.
- **Launch-time warn** — the only component that *knows for certain* it just skipped injection. The doctor cannot replace it; it is the safety net for the path where the dev never runs `pnpm doctor`.
- **Server-startup probe** — fires the same warn earlier and to stderr; does not improve discoverability for dashboard users; adds noise on every `pnpm dev` restart for negative cost/benefit.
- **Dashboard card** — most discoverable, but premature without a second instance of "external binary capability mismatch." If telemetry from the doctor extension proves it is rarely run, or a second case appears, this becomes a focused follow-up RFC with a real second data point.

## Design

### One source of truth: `scripts/lib/probe-codex-plugin-dir.sh`

The `pnpm doctor` extension and the runtime adapter probe share a *contract*, not just code: same binary, same flag, same expected substring, same env var (`KOOKR_CODEX_BIN`). Two independent implementations of that contract create a drift surface — if the criterion ever changes (flag rename, version-range check, multi-flag probe), both sites must update independently.

To bound the drift surface to one place, ship a small bash library at `scripts/lib/probe-codex-plugin-dir.sh`:

```bash
#!/usr/bin/env bash
# probe-codex-plugin-dir.sh — does the configured Codex CLI advertise --plugin-dir?
#
# Usage (sourced):
#   . "$REPO_ROOT/scripts/lib/probe-codex-plugin-dir.sh"
#   probe_codex_plugin_dir
#   # Sets: PROBE_RESULT in {ok, missing-flag, not-installed}
#   #       PROBE_TIMED_OUT (1 if --help hit the 5s timeout; otherwise unset)
#   #       PROBE_CODEX_BIN (resolved binary, may be an absolute path or PATH lookup)
#
# Editor's note: the function returns 0 in every case and sets PROBE_RESULT
# instead of failing, so callers under `set -euo pipefail` (e.g.
# `prod-restart.sh`) are safe by construction. PROBE_RESULT is a global —
# always reference it immediately after the call, before any branching that
# might short-circuit under `set -u`.

probe_codex_plugin_dir() {
  PROBE_CODEX_BIN="${KOOKR_CODEX_BIN:-codex}"
  unset PROBE_TIMED_OUT

  # Accept either an absolute executable path or a PATH-resolvable name.
  # `command -v` on Bash 4+ returns absolute paths verbatim if the file is
  # executable, but the explicit `-x` check handles edge cases on older
  # shells and non-PATH absolute paths.
  if [ -x "$PROBE_CODEX_BIN" ] || command -v "$PROBE_CODEX_BIN" >/dev/null 2>&1; then
    : # found
  else
    PROBE_RESULT="not-installed"
    return 0
  fi

  # 5-second timeout matches the TS adapter's bound (2s) plus headroom for
  # cold-start cargo/node startup. `timeout` exits 124 on hit. We must
  # capture that exit code WITHOUT letting `|| true` (or pipefail under the
  # caller's settings) swallow it, so bracket with `set +e`/`set -e` and
  # restore the original errexit state afterwards.
  local help_output timeout_status prev_e
  case $- in *e*) prev_e=1 ;; *) prev_e=0 ;; esac
  set +e
  help_output="$(timeout 5 "$PROBE_CODEX_BIN" --help 2>/dev/null)"
  timeout_status=$?
  [ "$prev_e" -eq 1 ] && set -e

  if [ "$timeout_status" -eq 124 ]; then
    PROBE_TIMED_OUT=1
    PROBE_RESULT="not-installed"  # treat as effectively-unusable; doctor renders INFO
    return 0
  fi

  if printf '%s' "$help_output" | grep -q -- '--plugin-dir'; then
    PROBE_RESULT="ok"
  else
    PROBE_RESULT="missing-flag"
  fi
}
```

The timeout case folds into `not-installed` plus a `PROBE_TIMED_OUT` companion flag. Callers that care about the distinction (`doctor.sh`) can render an "INFO — probe timed out" row; callers that do not (`prod-restart.sh`) treat timeout the same as "no Codex on PATH" and stay silent. This collapses the contract to three primary states without losing the timeout-vs-absent distinction at the call site.

**Resolution surface commitment.** The library reads `KOOKR_CODEX_BIN` and falls back to `codex`. This matches `CodexCliAdapter`'s default. `KOOKR_CODEX_BIN` is hereby declared the canonical resolution surface for both the runtime and the diagnostic; the adapter's `options.agentBin` constructor parameter is a test seam, not an alternate config surface, and should not be exposed to documentation as a "way to configure the binary."

**Stderr-only known limitation.** If a future binary emits `--plugin-dir` to stderr only, the probe (which reads stdout) will incorrectly report `missing-flag`. The kookr-fork emits to stdout, so this is not a current issue. The TS adapter has the same limitation, so the two surfaces remain consistent. Documented here so reviewers don't re-flag it.

### `pnpm doctor` extension

`scripts/doctor.sh` sources the library and adds a single check section between the existing optional "NVIDIA GPU" block and the trailing summary:

```bash
# ---------------------------------------------------------------------------
# Optional: Codex CLI fork capability (--plugin-dir)
# ---------------------------------------------------------------------------
. "$REPO_ROOT/scripts/lib/probe-codex-plugin-dir.sh"
probe_codex_plugin_dir
# Version is doctor-only; capture it here, not in the shared library.
CODEX_VERSION="unknown"
if [ "$PROBE_RESULT" != "not-installed" ]; then
  CODEX_VERSION="$(timeout 2 "$PROBE_CODEX_BIN" --version 2>/dev/null \
    | head -n1 | awk '{print $NF}' 2>/dev/null || echo unknown)"
  [ -z "$CODEX_VERSION" ] && CODEX_VERSION="unknown"
fi
case "$PROBE_RESULT" in
  ok)
    print_row "Codex --plugin-dir" "$CODEX_VERSION" "OK" "(kookr-fork)"
    ;;
  missing-flag)
    print_row "Codex --plugin-dir" "$CODEX_VERSION" "WARN" "stock build — toolkit not injected"
    add_fix "Codex sessions launched by Kookr will NOT see kookr-toolkit. Run: pnpm codex:rebuild   (requires the kookr-fork at \$CODEX_SRC, default ~/git/codex; see jeanibarz/codex#52)"
    WARNS=$((WARNS + 1))
    ;;
  not-installed)
    if [ "${PROBE_TIMED_OUT:-0}" = "1" ]; then
      print_row "Codex --plugin-dir" "unknown" "INFO" "probe timed out — re-run pnpm doctor"
    else
      print_row "Codex CLI" "not installed" "INFO" "optional (Codex agent type)"
    fi
    ;;
esac
```

Behavior:

- Codex absent → `INFO` (optional, like Docker without voice).
- Codex present, `--plugin-dir` advertised → `OK`.
- Codex present, `--plugin-dir` missing → `WARN` (matches Docker-not-running tier).
- Probe timeout → `INFO` with a "re-run pnpm doctor" hint (no false WARN on a transient hang).

Doctor's exit code is unaffected in all four states.

**WARN is bounded by definition** to "stock-codex is installed and on PATH." A dev who never installed Codex sees an `INFO` row with no fix line; they pay no recurring noise.

### `prod-restart.sh` integration

`prod-restart.sh` runs with `set -euo pipefail`, so any unguarded probe failure aborts production restart mid-flight. The library function returns 0 in every case (it sets `PROBE_RESULT` instead of failing), so the call site is safe by construction:

```bash
. "$ROOT_DIR/scripts/lib/probe-codex-plugin-dir.sh"
probe_codex_plugin_dir
if [ "$PROBE_RESULT" = "missing-flag" ]; then
  echo "WARN: codex on PATH does not advertise --plugin-dir; kookr-spawned codex sessions" >&2
  echo "      will NOT see the kookr-toolkit. Run \`pnpm codex:rebuild\` to fix." >&2
fi
```

The probe lives at the **end** of `prod-restart.sh`, after `wait_for_health` succeeds. If the server fails to start, the script exits before the probe runs and the WARN is correctly suppressed (the dev has a bigger problem). All other `PROBE_RESULT` values are silent in this surface — the production restart path is not a diagnostic dashboard.

### Why one PR, not two

Round 1's design-minimalist correctly flagged that splitting the change into "PR A: doctor" and "PR B: prod-restart" was bureaucratic — the two call sites are five lines each, no behavior diverges between them, and the shared library makes the second site free. Ship as one PR. Round 1's boundary-critic concern (drift surface) is also addressed by the shared library, which would not have existed in a "doctor only" PR.

### No changes to the runtime probe

The launch-time warn already lives in `CodexCliAdapter` via `probeBinaryFlagSupport` (#242) and remains untouched. The TypeScript probe and the bash library implement the same contract independently; the contract — "find `--plugin-dir` in `<KOOKR_CODEX_BIN> --help` stdout, with a short timeout" — is documented in the bash library's header so future contract changes have one place to look first before propagating.

To bound contract drift further, this RFC adds a one-line cross-reference comment at the top of the `probeBinaryFlagSupport` JSDoc block in `src/adapters/probe-agent-binary.ts`:

```ts
/**
 * Probe whether <bin> --help advertises <flag> on stdout.
 *
 * Diagnostic mirror: scripts/lib/probe-codex-plugin-dir.sh implements the
 * same contract for `pnpm doctor` and `prod-restart.sh`. Keep both probes
 * in sync if the criterion changes (flag rename, version-range check,
 * stderr probing, etc.).
 */
```

This is the only TypeScript change in scope for this RFC.

## Open questions — answers

The issue raised five open questions. Short answers:

1. **Auto-fix?** No. `pnpm doctor` declares "Auto-fixing detected problems" as out of scope per its header (citing #9). Print the recipe; the dev runs it. Revisit only if a separate `pnpm doctor:fix` flag is introduced for *all* checks.
2. **Discoverability vs noise.** Doctor on demand + launch-time warn covers it without alarm fatigue. Always-on banners are rejected (see Surfaces).
3. **Generality.** The bash library is the reusable primitive at the diagnostic layer; `probeBinaryFlagSupport` is the one at the runtime layer. Both are shaped for one binary today; widening to a generic "external binary capability" framework should wait for a second case.
4. **Interaction with `pnpm prod:update`.** Addressed — the probe lands at the end of `prod-restart.sh` (which `prod:update` invokes). Not added to `pnpm prod:setup` (one-time bootstrap; dev reads README) or `pnpm dev` (constant restart cycle; alarm fatigue).
5. **Stock-codex fallback.** Out of scope. If the kookr-fork-only surface area keeps growing (this is the second flag-gap after [#210](https://github.com/kookr-ai/kookr/issues/210)), "stock Codex is supported" becomes a strategic question, not a UX surface call. The doctor row tolerates either answer: WARN today; if the policy flips to "fork required," the same row becomes FAIL with the same fix recipe.

## Acceptance criteria

- `pnpm doctor` with stock Codex on PATH prints a `WARN` row referencing `pnpm codex:rebuild` and the fork link.
- `pnpm doctor` with kookr-fork Codex on PATH prints an `OK` row, no fix line.
- `pnpm doctor` with no Codex on PATH prints an `INFO` row.
- `pnpm doctor` overall exit code is unchanged from current behavior in all three `PROBE_RESULT` states + the timeout sub-case (Codex is optional infra, like Docker).
- `prod-restart.sh` prints the WARN at end-of-restart **only** when `PROBE_RESULT = missing-flag`. No output for `ok` or `not-installed` (timeout or absent — production restart is not a diagnostic surface).
- A 5-second timeout caps the `--help` probe call; a hanging `codex` binary cannot stall doctor or production restart.
- The `console.warn` from #242 still fires unchanged on first Codex launch.
- Test the three primary states (absent / stock / fork) plus timeout by stubbing `KOOKR_CODEX_BIN` at synthetic shell scripts. The test surface lives next to the library at `scripts/lib/probe-codex-plugin-dir.test.sh` (plain bash; assertions via `[ "$PROBE_RESULT" = ... ]` and `${PROBE_TIMED_OUT:-0}`).

## Test plan

- **Library unit (bash):** `scripts/lib/probe-codex-plugin-dir.test.sh` exercises the three primary states + the timeout sub-case by pointing `KOOKR_CODEX_BIN` at four small stub scripts in a temp dir (one absent — point at a non-existent path; one stock — `echo "Usage: codex"`; one fork — `echo "Usage: codex --plugin-dir <DIR>"`; one slow — `sleep 10`). ~40 lines, runnable as `bash scripts/lib/probe-codex-plugin-dir.test.sh`.
- **Doctor smoke:** `bash scripts/doctor.sh` with each of the four stubs on `KOOKR_CODEX_BIN`. Visual inspection of the row + fix line. Optional: parse the output and assert under Vitest if the existing test surface picks it up; otherwise ship the manual checklist.
- **prod-restart smoke:** Manually run `bash scripts/prod-restart.sh` after `KOOKR_CODEX_BIN=/path/to/stock-stub`; verify the WARN lands on stderr and the script exits 0.
- **Regression:** `pnpm test src/adapters/codex-cli-adapter.test.ts` to confirm #242's launch-time path is untouched.

## Out-of-scope follow-ups

- Dashboard surface (issue's surface #3) — defer to a focused RFC if doctor signals prove insufficient or a second binary capability gap appears.
- `pnpm doctor:fix` auto-fix mode — separate UX question that affects all doctor checks.
- Kookr-fork-as-default policy — strategic question outside the UX surface scope.

## Related work

- PR [#241](https://github.com/kookr-ai/kookr/pull/241) — initial `--plugin-dir` adapter wiring (opt-in env var).
- PR [#242](https://github.com/kookr-ai/kookr/pull/242) — runtime capability probe replacing the env-var gate; introduced `probeBinaryFlagSupport`.
- jeanibarz/codex#52 — the Codex fork PR adding the `--plugin-dir` flag.
- Issue [#210](https://github.com/kookr-ai/kookr/issues/210) — second known fork-vs-stock gap (`.agents` vs `.claude/skills` resolution); informs the *Open question 5* stance.
