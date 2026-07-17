# Testing

This page is the durable entry point for "what testing means in Kookr." It explains the suite inventory, which workflow runs which command, how to interpret the coverage number that CI publishes, where to find live numbers on a PR, and what to do when something looks wrong.

For the design history, see [RFC: Testing Surfacing and Coverage Visibility](rfc/rfc-testing-surfacing.md).

## Suite Inventory

| Command | What it runs | Where it runs |
| --- | --- | --- |
| `pnpm test` | Vitest unit tests under `src/**/*.test.ts` (no coverage). | Local. CI uses `--coverage`. |
| `pnpm test:coverage` | Vitest with V8 coverage. | Local. |
| `pnpm test:watch` | Vitest watch mode. | Local. |
| `pnpm check:e2e` | TypeScript check for Playwright tests. | Local + CI (`test` job). |
| `pnpm validate:docs-commands` | Verifies documented package scripts, local CLI binaries, and repo-local command entrypoints exist. | Local + CI (`test` job). |
| `pnpm exec playwright test` | Browser E2E. | Local + CI (`build` job, Playwright container). |
| `pnpm test:hooks` | Shell regression tests for project hooks. | Local + CI (`test` job). |
| `CANARY=1 pnpm exec playwright test e2e/canary.spec.ts` | Real-agent canary, validates mock event fixtures against real Claude Code (Haiku). Local/manual due to API cost. | Local only. |

`e2e/accessibility-smoke.spec.ts` adds axe-backed structural scans for the dashboard shell and core dialogs. It disables axe's `color-contrast` rule because the existing dark theme has broad contrast debt that would make the smoke layer noisy; do not add broader suppressions without documenting the reason here.

## Focused Regression Coverage

Some UI regressions are covered below the Playwright layer because they are data-shaping or component-lifecycle bugs:

- Prompt display hygiene: `src/server/launch-service.test.ts` verifies launches preserve the user-authored prompt separately from injected worktree guidance, `src/core/monitor.test.ts` verifies snapshots expose display-safe prompt text for both new and legacy tasks, and `src/frontend/components/Tooltip.test.ts` verifies hidden tooltip portals do not keep long prompt text mounted.
- Reliable empty-terminal Enter: `src/server/terminal-input-coordinator.test.ts` covers readiness versions, blocked/unknown/stale intent rejection, and the no-forward-Enter invariant; `src/server/dashboard-selection-controller.test.ts` covers atomic selection CAS and duplicate intents; `src/server/terminal-input-boundary.test.ts` guards direct raw backend writes outside the input boundary; `src/frontend/components/DetailPanel.empty-enter.test.ts` covers the frontend intent path.

## CI Mapping

| Workflow | Triggers | Jobs |
| --- | --- | --- |
| `.github/workflows/ci.yml` | Push to `main`, PRs targeting `main`. | `test` (typecheck, skill validation, playbook validation, Vitest + coverage, smoke gates, hook tests), `build` (Playwright). On PRs, both jobs path-filter: code-heavy steps are skipped when the PR touches no code paths (docs/skills-only PRs run just the validators). Push to `main` always runs everything. |
| `.github/workflows/e2e.yml` | Manual `/run-e2e` PR comment. | Full Playwright run, uploads HTML report on every run, comments result on the PR. |
| `.github/workflows/staging.yml` | Staging-branch flow. | Plain `pnpm test` (no coverage). The testing-surfacing RFC defers staging coverage to a later phase. |

### Artifacts

| Artifact | Job | When uploaded | Retention |
| --- | --- | --- | --- |
| `coverage` (`coverage-summary.json` + `lcov.info`) | `test` | Every code-touching PR run, pass or fail (Vitest is invoked with `--coverage.reportOnFailure`); skipped on docs/skills-only PRs. | 14 days |
| `playwright-report` | `build` | Failed runs only on `ci.yml`; every run on `e2e.yml`. | 7 days |

## Finding the Live Coverage Numbers on a PR

The README links here, not to a live number. The numbers are produced per-PR by CI. To find them:

1. Open the PR's **Checks** tab.
2. Click the **`test`** job.
3. In the left sidebar, click **`Summary`**.
4. Scroll to the **Coverage summary** section at the bottom of the job summary.

The summary shows:

- A four-row metric table (Lines, Statements, Branches, Functions).
- A breakdown by the five risk layers the RFC names: orchestration, hooks, process lifecycle, terminal sessions, WebSocket state.
- Top-10 lists of files by uncovered lines/branches, suppressed when totals are healthy to avoid noise.

If the **`test`** job failed before coverage finalized, the summary will say "Coverage data unavailable" and a GitHub Actions `::notice::` annotation will surface in the Checks UI.

## Interpretation Rules

- **Coverage is a trend and gap-finding signal, not a target.** A high percent does not mean the code is well-tested; it means the lines were executed.
- **The published number is server/core only.** `vitest.config.ts` excludes `src/frontend/**` from V8 coverage. The step summary subtitles the number `(server/core; frontend excluded)` so reviewers do not read it as whole-repo coverage. A frontend coverage strategy needs its own RFC.
- **Branch coverage matters more for orchestration code.** For hooks, lifecycle handlers, and WebSocket dispatch, branch coverage is the earliest warning that a code path is untested.
- **Browser report artifacts are for failure investigation.** Default CI uploads them only on failure; the manual `/run-e2e` workflow uploads on every requested run.

## Local Commands

Reproduce CI locally:

```bash
pnpm install --frozen-lockfile
pnpm test:coverage           # vitest --coverage; reporter list lives in vitest.config.ts
pnpm coverage:summary        # renders coverage/coverage-summary.json to Markdown
```

`pnpm coverage:summary` prints the same Markdown that CI writes to the GitHub Actions step summary, so you can preview the layer breakdown before pushing.

Open the HTML report locally with:

```bash
pnpm test:coverage
xdg-open coverage/index.html   # or `open coverage/index.html` on macOS
```

The HTML report is not uploaded by CI by default (it is large and noisy on routine runs).

### Capturing a Playwright trace on a local E2E failure

CI captures a trace via `trace: 'on-first-retry'`, but locally `retries` is `0` (`playwright.config.ts`), so that path never fires and a failing spec produces no trace. Opt in with the `KOOKR_E2E_TRACE` env var to retain a trace (and screenshots) on any local failure:

```bash
KOOKR_E2E_TRACE=1 pnpm exec playwright test        # retain trace.zip + screenshots on failure
pnpm exec playwright show-trace test-results/<failed-test>/trace.zip
```

When `KOOKR_E2E_TRACE` is set, the config switches to `trace: 'retain-on-failure'` and `screenshot: 'only-on-failure'`, writing artifacts under `test-results/`. The env var is unset by default, so default local runs (no trace) and CI behavior/cost (`on-first-retry`, one retry) are unchanged.

## Troubleshooting

### Coverage artifact missing on a PR

The `Run tests with coverage` step likely exited before finalizing the report. With `--coverage.reportOnFailure` set, this should be rare; if it happens, check the test step logs for an early crash (process killed, OOM, native module failure).

### Step summary shows "Coverage data unavailable" or is blank

The summary script printed the unavailable notice because `coverage/coverage-summary.json` did not exist. This usually means the test step itself failed early. Inspect the `Run tests with coverage` step output for the upstream cause.

### `::error::` annotation in the Checks UI from the summary script

The script distinguishes three error paths:

- "Coverage JSON malformed at ..." — the file exists but cannot be parsed. Rerun the job or inspect the uploaded artifact.
- "Coverage JSON has no `total` key" — the reporter output is incompatible. Likely a version bump in `@vitest/coverage-v8` or `istanbul-reports` changed the schema.
- "coverage-summary.ts crashed: ..." — unexpected runtime error. The annotation text includes the error message.

### Coverage numbers look implausibly low or high

Check `vitest.config.ts` `include` and `exclude` lists. The most common cause is the frontend exclusion (`src/frontend/**` is omitted by design); the second most common is a new directory under `src/` that has no `*.test.ts` siblings yet.

### Preview the summary locally before pushing

```bash
pnpm test:coverage
pnpm coverage:summary
```

This prints the Markdown to your terminal so you can see the per-layer breakdown before relying on CI.

### `git-repo-guard: a test corrupted the shared git repository config`

`pnpm test` installs a vitest `globalSetup` (`test/git-repo-guard.ts`) that snapshots the shared `.git/config` before the suite and, on teardown, checks whether a test left the config poisoned — a test-domain `user.email` (e.g. `*@example.com`), a `core.bare` flip, or a bare-repo skeleton at the repo root. It **always heals the config automatically** (the actual prevention — nothing durable survives the run).

By default it **warns** but does not fail the run. Set `KOOKR_GIT_GUARD_STRICT=1` to make it fail (via `process.exitCode`) so CI/pre-push block on a poisoner. The default is lenient because the guard was rolled out on a codebase that already had a pre-existing poisoner; once that is located and fixed, strict mode becomes the default.

Cause: a git command in a test ran with a `cwd` that resolved into the real repo instead of an isolated temp dir. Worktrees share `.git/config`, so the write hit the whole repo. Fix the offending test to operate on a `mkdtemp` repo — pass `git -C <tmpdir> …` (or `cwd: tmpdir`) and set any identity there only, never in the ambient checkout.
