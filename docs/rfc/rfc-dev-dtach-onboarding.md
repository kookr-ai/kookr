# RFC: Self-Healing Dev/Start Scripts For The Vendored dtach Binary

## Status

**Draft (v1 — initial proposal)**

**Date:** 2026-05-24
**Author:** Jean Ibarz (with Claude)

---

## Problem

A user who follows the README Quick Start verbatim —

```bash
git clone …
cd kookr
pnpm install
pnpm dev
```

— can still hit `[fatal] dtach binary not found` at server startup. The vendored binary at `vendor/dtach/dtach` is only built by:

1. The `prepare` lifecycle script (runs during `pnpm install`), or
2. An explicit `pnpm build:dtach`, or
3. The umbrella `pnpm build`.

The `dev` and `dev:server` entries in `package.json` do **not** build it. That's fine when `prepare` runs to completion, but `prepare` is skipped or fails to build dtach in several real first-run scenarios:

- **`ignore-scripts=true`** in the user's `~/.npmrc` (a fairly common security setting), or `pnpm install --ignore-scripts`.
- **`pnpm install --frozen-lockfile` in CI-flavoured invocations** that some users copy from contributor docs.
- **A clone made before `prepare` was added to `package.json`**, followed by `git pull` and `pnpm dev` (lifecycle scripts only run on `install`, not on pull).
- **Build toolchain not yet installed** at the moment of `pnpm install` — `prepare` then fails, the user installs `build-essential`, and never re-runs `pnpm install` because the README's flow doesn't say to.

In all four cases the user has a working install, a working `pnpm` invocation, and a dashboard URL — and then a fatal error during `pnpm dev` whose remediation message points at a *different* command (`pnpm build:dtach`). The friction lands squarely at "first try Kookr." The production-style path (`pnpm prod:setup`) avoids this because it ends with `pnpm build`, which transitively builds dtach.

Two related symptoms make this worse:

- The fatal message lands *after* the user has invested ~20s waiting for the dev server. The cost of one extra command is small; the surprise is the bad part.
- The `prepare` script also configures `core.hooksPath`. If `prepare` fails halfway (e.g., dtach build error), the pre-push hook is still configured, but the user doesn't know which half of `prepare` failed.

## Requirements

- **R1.** A user who runs `pnpm install && pnpm dev` against a clean checkout must reach a running dev server with a working dtach binary, with no extra command, even if `prepare` did not run.
- **R2.** The fix must not add measurable latency to the normal warm-cache path. The idempotent check in `scripts/build-dtach.sh` already exits early in <50ms when the binary exists; adding it as a prefix is acceptable, polling for it in TS is not.
- **R3.** The fix must surface a clear actionable error when the binary cannot be built (e.g., missing `cc`/`make`), not a silent swallow.
- **R4.** The fix must not require changes to the published `bin/kookr.js` UX. `npx kookr` is already gated behind `pnpm build` having produced `dist/`, so dtach is already a precondition there.
- **R5.** `pnpm test`, `pnpm test:smoke`, and `pnpm doctor` behavior must be unchanged. None of them assume an absent dtach binary, but none should start auto-building either — they are diagnostic and CI surfaces.

## Non-goals

- **Not** auto-building dtach at runtime inside the Node server (`src/server/start.ts`). That would couple the server boot path to a shell build invocation, with timing and exit-code semantics that don't belong there. The dev-script prefix is enough.
- **Not** removing the existing fatal error in `start.ts`. The error is still the correct end-state when both the dev prefix and `prepare` fail to produce a binary (e.g., no `cc` on the box). Keeping the error preserves the production safety net.
- **Not** changing the `prepare` script. It still does the right thing on the happy path; we are adding a second line of defense, not replacing the first.
- **Not** vendoring a prebuilt binary. Earlier ADR-014 explicitly chose the build-from-source path; this RFC doesn't revisit that.
- **Not** adding a watcher that rebuilds dtach when source changes. The pin is a tag (`v0.9`); rebuilds are rare and `--force` exists for them.
- **Not** changing `pnpm prod:setup`. It already runs `pnpm build` which builds dtach.

## Design

### Shape of the fix

Three small changes to `package.json` scripts:

```jsonc
"dev":        "pnpm build:dtach && KOOKR_PORT=4801 node --import tsx --watch-path=src/server --watch-path=src/core --watch-path=src/adapters src/server/start.ts & vite & wait",
"dev:server": "pnpm build:dtach && KOOKR_PORT=4801 node --import tsx --watch-path=src/server --watch-path=src/core --watch-path=src/adapters src/server/start.ts",
"start":      "pnpm build:dtach && node dist/server/start.js",
```

`pnpm build:dtach` is already idempotent — `scripts/build-dtach.sh` short-circuits with `[build-dtach] vendor/dtach/dtach already exists; skipping` when the binary is present. On a typical box the warm path is <100ms (one shell + one `[ -x ]` test). The cold path (first dev start) is ~2s, the same time the user would otherwise spend reading the fatal error and copy-pasting `pnpm build:dtach`.

`start` is included for the case where a user has run `pnpm build` but later wipes `vendor/dtach/` (e.g., a `git clean -fdx` from a different worktree). It is also a fast no-op when the binary exists.

`dev:frontend` is **not** modified — it only runs Vite, never invokes dtach.

### Why scripts, not Node-level auto-build

Three alternatives were considered:

1. **Node-level auto-build at startup (in `start.ts`).** Rejected: introduces a side-effecting subprocess spawn into the server boot path, with platform-specific behavior (Windows shell semantics, signal handling under PM2), and makes the failure mode "did the server start" mean two different things. Keeping the build out of the Node entry point preserves clean `start.ts` semantics.
2. **`predev` / `prestart` pnpm lifecycle hooks.** pnpm runs `pre*` for arbitrary scripts only when `enable-pre-post-scripts=true`, which is **off by default in pnpm ≥ 7**. Relying on it would silently no-op for most users.
3. **A `scripts/run-dev.sh` wrapper.** Adds a file and another indirection layer. The two-token `pnpm build:dtach &&` prefix is half the cognitive load and reuses an already-documented entry point.

### Failure semantics

If `pnpm build:dtach` fails (e.g., missing `cc`/`make`), the script aborts before `node ...` starts. The user sees the dtach build script's own error, which already points at `build-essential` / Xcode CLT. This is strictly better than today: the failure point moves from "30s into server startup" to "second 1 of dev."

The vestigial `[fatal] dtach binary not found` path in `start.ts` is retained for cases where someone runs `node dist/server/start.js` directly (bypassing the pnpm script) — e.g., PM2, systemd, docker. The error remains the production safety net.

### Documentation updates

- **`docs/getting-started.md`** — note that `pnpm dev` ensures the dtach binary even if `prepare` didn't run. The existing call-out to `pnpm doctor` stays as the diagnostic path.
- **`docs/troubleshooting.md`** — "dtach Problems" section adds a one-liner: "`pnpm dev` and `pnpm start` now build dtach on demand; you should not normally need to run `pnpm build:dtach` directly."
- **`docs/development.md`** — the existing line that says `pnpm install` runs `prepare` stays accurate; we add that `dev` is now also self-healing as a second line of defense.

`README.md` is **not** changed — its Quick Start was already correct on the happy path, and this RFC only widens which paths are happy.

## Process commitments

- The RFC ships in the same PR as the fix (a 4-line `package.json` change + 3 short doc edits). No separate review cycle is warranted.
- After merge, the next person who hits a fresh-machine onboarding error opens an issue that links back to this RFC so we can catch the residual edge cases.

## Alternatives considered

| Option | Why rejected |
| --- | --- |
| Node auto-build in `start.ts` | Couples server boot to shell build; bad failure-mode signal-vs-noise (non-goal). |
| Add `predev`/`prestart` hooks | pnpm disables them by default in ≥7; would silently no-op. |
| Print warning + run, no build | dtach is a hard requirement; warn-and-continue would only delay the failure. |
| Ship prebuilt dtach binary in npm package | Out of scope and contradicts ADR-014. |
| Rely on `pnpm install` `prepare` only | Doesn't cover `--ignore-scripts`, post-pull, or partial-failure cases (the actual reported issue). |

## Risk assessment

- **Risk:** `pnpm build:dtach` becomes slow over time (e.g., dependency added that re-clones every run). *Mitigation:* the script's first action is `[ -x "$BIN" ]` short-circuit; any regression there is its own bug.
- **Risk:** Users who deliberately want to run `node dist/server/start.js` from `dist/` without rebuilding dtach. *Mitigation:* they bypass `pnpm start` anyway; behavior unchanged.
- **Risk:** CI invocations that call `pnpm dev` (unlikely — CI uses `test`/`test:smoke`/`build`) would now also build dtach. *Mitigation:* CI already runs `pnpm install` which runs `prepare`; the second build is the idempotent skip path.

## Out-of-scope follow-ups

- A `pnpm verify` aggregate that runs `doctor` + `build:dtach` + `build:server` for OSS contributors in one command.
- Switching `prepare` to a script that logs to a file so partial failures are easier to diagnose.

Both are nice-to-haves; this RFC narrowly fixes the reported first-run failure.
