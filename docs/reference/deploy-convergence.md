# Deploy Convergence Reference

**Deploy convergence** is the closed-loop invariant on Kookr's deploy edge:
after a merge to `main`, `kookr-prod` must actually **catch up** to
`origin/main` — not just have the merge land in the repo. Merge velocity without
deploy convergence is inventory, not throughput.

## Why this exists (#1883)

`pnpm prod:update`, the dashboard **Deploy** button, and `POST /api/deploy/trigger`
all move prod _forward_, but nothing asserted prod _caught up_. On 2026-08-02 the
live daemon was serving build `bec9bdcf` — 14 commits behind `origin/main` —
while the queue-feeder levers #1849/#1855 (which fix slot under-drive) had merged
hours earlier and were **not deployed**. The operator's velocity probe still
reported idle capacity and could not tell "feeder not live" from "feeder live but
empty backlog": the diagnosis stayed confounded because prod never advanced.

This mirrors the deploy-convergence discipline lucy already has (its #1842) — see
the related [Lucy Prod Update Watchdog](lucy-prod-update-watchdog.md) spec.

## The invariant

> The commit **kookr-prod is actually serving** includes `origin/main` HEAD in
> its ancestry, within a grace window of the merge that produced it.

The load-bearing detail is _serving_, not _checked-out_: a worktree can be
advanced (`git pull`) but not yet rebuilt/restarted, so only the commit the
running process reports is ground truth. Kookr already publishes that commit on
`GET /api/health` under `build.commitShort` / `build.commitHash` (from
`dist/build-info.json`, baked at build time) — the convergence check reads it
there rather than trusting the repo the check happens to run in.

## Components

| Piece | Path | Role |
| --- | --- | --- |
| Pure classifier | `src/core/deploy-convergence.ts` | `evaluateConvergence` (grace window, divergence-age anchored to the merge commit time, `divergent → redeploy` action); `classifyDelivery` (merged vs delivered); `DEFAULT_CONVERGENCE_THRESHOLDS` (grace **15 min**). No I/O — unit-tested in `src/core/deploy-convergence.test.ts`. |
| Stale residual classifier | `src/core/deploy-stale-residual.ts` | `evaluateDeployStaleResidual`: **behindCount≥1 + deploying=false for ≥T** (default **20 min**) → alert. Pure — issue #2226. |
| In-process controller | `src/server/deploy-convergence-controller.ts` | Lifecycle tick (default every **5 min** on port 4800): past grace → `POST /api/deploy/trigger`; residual → operator signal `deploy:stale-residual`. Does **not** depend on agent schedules (the 2026-08-11 stall was a missing schedule). |
| Probe CLI | `scripts/deploy-convergence-check.ts` (`pnpm deploy:convergence`) | Probes `/api/health` + `git` ancestry against `origin/main`, persists a baseline so divergence age accrues across ticks, exits **0** converged/within-grace · **2** DIVERGENT · **1** probe failure. |
| Schedule playbook | `.kookr/playbooks/kookr-deploy-convergence.md` | Every-15-min belt-and-suspenders. The scheduler execs `probe.command` first (issue #2569) so a converged tick occupies **no** agent slot. Exit 2 still launches the playbook to re-probe and file a P0 if heal fails. Lucy's `lucy-deploy-convergence.md` uses the same cheap path via a well-known-path fallback. |
| Register script | `scripts/register-deploy-convergence-schedule.sh` | Creates/updates that schedule via `POST /api/schedules`. Prefers `kookr-prod` when the main checkout lacks the playbook. |

## Running the probe

```bash
pnpm deploy:convergence
```

Useful flags (see `pnpm deploy:convergence -- --help`):

- `--branch <name>` — deploy branch to track (default `main`).
- `--grace-minutes <n>` — divergence grace before it's an incident (default 15).
- `--act` — on DIVERGENT, POST the canonical redeploy trigger
  (`/api/deploy/trigger` → `prod-update.sh`). Detection is the default;
  triggering a real deploy is opt-in.
- `--no-fetch` — skip the pre-comparison `git fetch origin <branch>`. By default
  the probe fetches first so it never compares against a stale local
  `origin/<branch>` (which would falsely report "converged"); pass this only in
  already-fetched or offline environments.
- `--dry-run` — classify and print without writing the baseline or acting.
- `--base <url>` — serving API base (default `$KOOKR_API_BASE_URL` or
  `http://127.0.0.1:4800`).

Exit codes are the contract the schedule keys off:

| Exit | Meaning | Action |
| --- | --- | --- |
| `0` | Converged, or diverging inside the grace window | none |
| `2` | DIVERGENT past the grace window | redeploy, then P0 if it fails to converge |
| `1` | Probe failure (serving or target SHA unavailable, or a `dev` build) | log, do not escalate on a single blip |

The baseline is persisted at
`~/.kookr/playbook-state/kookr/deploy-convergence/baseline.json`.

## Redeploy trigger

`--act` does **not** run `prod-update.sh` directly. It POSTs
`POST /api/deploy/trigger`, the same path the dashboard **Deploy** button and
`pnpm prod:update` use; the running server owns locating the prod worktree
(`resolveProdDir`) and serializing concurrent deploys (its `deploying` flag → a
`409` when one is already running, which the probe treats as success).

## Scheduling it

With the server running on `127.0.0.1:4800`:

```bash
bash scripts/register-deploy-convergence-schedule.sh
```

This registers the **Kookr Deploy Convergence** schedule (`*/15 * * * *`) bound
to the project-tier playbook. Override via `CONVERGENCE_CRON`,
`CONVERGENCE_GRACE_MINUTES`, `CONVERGENCE_ACT`, `CONVERGENCE_AGENT_TYPE`, or
`CONVERGENCE_DRY_RUN`.

A fire does **not** occupy a Grok/Codex slot when the probe exits 0
(converged / within grace) or 1 (single-tick probe failure). The schedule
ledger records `completed` with reason `probe_quiet` or `probe_blip`. Exit 2
(DIVERGENT past grace) still launches the playbook agent so the existing
redeploy + one-P0-if-heal-fails contract is unchanged. The same cheap path
applies to Lucy's deploy-convergence schedule (matched by playbook basename)
without a Lucy-side change.

## Merged vs delivered

`classifyDelivery` gives completion reporting a `merged` vs `delivered`
distinction: a kookr PR is not "done" until the serving commit includes its merge
commit. Throughput should count delivery, not inventory.
