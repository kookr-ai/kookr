---
name: Kookr Deploy Convergence
description: Cheap scheduled check that asserts kookr-prod's serving commit includes origin/main HEAD after every merge. Silent when converged; on divergence past the grace window it triggers the canonical redeploy (POST /api/deploy/trigger → prod-update.sh), re-probes, and only if the redeploy fails to converge files a P0 (issue #1883).
cwd: $HOME/git/kookr
deliveryPreAuthorized: true
autoCloseOnSignal: true
tags: [deploy, monitoring, scheduled]
# Scheduler execs this first (issue #2569). Exit 0/1 complete with no agent
# slot; exit 2 still launches this playbook for heal + P0.
probe:
  command: pnpm deploy:convergence -- --branch "{{branch}}" --grace-minutes "{{graceMinutes}}"
  escalateOnExit: 2
parameters:
  - name: branch
    description: 'Deploy branch kookr-prod must track.'
    required: false
    default: 'main'
    type: text
  - name: graceMinutes
    description: 'Minutes kookr-prod may lag origin/main before divergence is an incident.'
    required: false
    default: '15'
    type: text
  - name: act
    description: 'true → on DIVERGENT, POST the canonical redeploy trigger (/api/deploy/trigger → prod-update.sh). false → detect + report only.'
    required: false
    default: 'true'
    type: text
  - name: dryRun
    description: 'true → classify and print; never write the baseline, redeploy, or file an issue.'
    required: false
    default: 'false'
    type: text
checklist:
  - Ran the checked-in probe against the live /api/health serving SHA (never the worktree HEAD)
  - Interpreted exit 0 (converged/within-grace) / 2 (DIVERGENT) / 1 (probe failure) correctly
  - On exit 2 with act=true, triggered exactly one redeploy via POST /api/deploy/trigger
  - Re-probed after the redeploy window before deciding delivered vs still-divergent
  - Filed a P0 issue ONLY when the re-probe was still exit 2 (redeploy failed to converge)
  - Emitted a one-line receipt (converged / diverging / DIVERGENT … action=…) and signalled completion-ready
---

## Objective

You are a **short-lived, cheap deploy-convergence probe** — the closed-loop
invariant on the deploy edge. Merge velocity without deploy convergence is
inventory, not throughput: a window can merge many kookr PRs and still serve
pre-fix code if `kookr-prod` never advances past an old commit (#1883 — on
2026-08-02 the live daemon served build `bec9bdcf`, 14 commits behind
`origin/main`, while the queue-feeder levers #1849/#1855 that fix under-drive sat
merged for hours; the operator's velocity probe could not tell "feeder not live"
from "feeder live but empty backlog"). Your job is to assert **kookr-prod's
serving commit includes `origin/main` HEAD** and treat a stale prod as an
incident, not lag.

**Schedule:** every 15 minutes (`*/15 * * * *`, server TZ). The scheduler
runs the `probe.command` frontmatter first and **does not launch this
playbook** on a converged or probe-failure tick (issue #2569). You only wake
when the probe exits 2 (DIVERGENT past grace). Never run deep reasoning from
this playbook. The only issue you ever file is the P0 in Phase 3, and only
after a redeploy failed to converge.

## §0 Hard rules

- **Probe the process that does the work.** The serving commit comes from the
  live `GET /api/health` endpoint of the running server (`build.commitShort`),
  **not** from the repo this check runs in. A worktree can be advanced but not
  yet rebuilt/restarted; only the served commit tells the truth.
- **Cheap only.** One HTTP GET + a couple of `git rev-parse`/`merge-base` calls
  via the checked-in probe. No max-effort subagent, no PR browsing.
- **Silent on green.** Converged or within the grace window → print the receipt,
  file nothing, `kookr signal completion-ready`, exit.
- **Escalate only past the grace window.** DIVERGENT (exit 2) → trigger the
  redeploy (Phase 2), then verify convergence; only if the redeploy fails to
  converge do you file a P0 (Phase 3).
- **The redeploy trigger is the supported chokepoint** (`POST /api/deploy/trigger`
  → `prod-update.sh`). Do **not** run `prod-update.sh` / `prod:restart` by hand
  from this task; let the running server own locating the prod worktree and
  serializing concurrent deploys.
- `{{dryRun}}` = `true` → classify/print only; no baseline write, no redeploy, no
  filing.

## Documented threshold (explicit contract)

The default lives in `src/core/deploy-convergence.ts`
(`DEFAULT_CONVERGENCE_THRESHOLDS`) and is overridable via the `graceMinutes`
parameter / `--grace-minutes` flag. Change it in code + this table together.

| Signal         | Trip condition                                                                                     | Default                     |
| -------------- | -------------------------------------------------------------------------------------------------- | --------------------------- |
| Divergence age | serving commit does **not** include `origin/{{branch}}` HEAD **and** the miss is older than N min  | **15 min** (`graceMinutes`) |

Notes:

- **Age, not mere inequality.** A prod a few minutes behind a just-merged PR is
  normal deploy latency; a miss older than the grace window is not.
- Divergence age is anchored to the **merge commit time** of `origin/{{branch}}`
  HEAD when available (so "within N minutes of any merged kookr PR" holds even if
  the check missed ticks), falling back to the first tick that observed the miss
  via the persisted baseline.
- Baseline path:
  `~/.kookr/playbook-state/kookr/deploy-convergence/baseline.json`.

## Phase 1 — Cheap probe

From the kookr checkout (cwd of the schedule):

```bash
pnpm deploy:convergence -- \
  --branch "{{branch}}" \
  --grace-minutes "{{graceMinutes}}"
# add --act on a live schedule so a DIVERGENT tick also POSTs the redeploy
# trigger; add --dry-run to classify without side effects.
```

Interpret the JSON stdout + exit code:

| Exit | Meaning                         | Next                                                           |
| ---- | ------------------------------- | -------------------------------------------------------------- |
| `0`  | converged, or within grace      | Phase 4 silent complete                                        |
| `2`  | DIVERGENT past grace            | Phase 2 redeploy + verify (→ Phase 3 only if it fails)         |
| `1`  | probe failure (SHA unavailable) | Log error; **do not** escalate on a single blip; complete      |

A dev build (`build.commitShort === 'dev'`) is an un-checkable gap → exit 1, not
a divergence. If the script is missing, fall back to a manual `curl` of
`$KOOKR_API_BASE_URL/api/health` for the `build.commitShort` field and
`git rev-parse --short origin/{{branch}}`, comparing by ancestry — still no deep
reasoning.

## Phase 2 — Trigger redeploy (only when exit 2), then verify

1. Run the probe with `--act` (or, if it was run without it, re-run with `--act`)
   so it POSTs `POST /api/deploy/trigger`, which the running server dispatches to
   the canonical `prod-update.sh`. A `409` means a deploy is already running —
   also fine. **Do not** run `prod-update.sh` / `prod:restart` by hand.
2. Wait for the redeploy window (`prod-update.sh` fetches, builds, restarts, and
   health-checks; it typically completes in a couple of minutes but can take
   longer on a cold build), then **re-probe**:

   ```bash
   sleep 240
   pnpm deploy:convergence -- --branch "{{branch}}" --grace-minutes "{{graceMinutes}}"
   ```

   - Exit `0` (converged) → the redeploy delivered. Note it in the receipt and go
     to Phase 4. This is the happy path — no issue filed.
   - Still exit `2` → the redeploy **failed to converge**. Go to Phase 3.

## Phase 3 — Redeploy failed: file a P0 (only when re-probe is still exit 2)

The self-heal redeploy did not close the gap. This is now a P0: prod cannot be
advanced to `origin/{{branch}}` automatically, so every merged fix is stranded.

File one P0 issue (this is the only issue this playbook ever files):

```bash
gh issue create --repo kookr-ai/kookr \
  --title "P0: deploy convergence failed — kookr-prod stuck below origin/{{branch}}" \
  --label "P0" \
  --body "$(cat <<EOF
Automated redeploy did not converge kookr-prod to origin/{{branch}}.

- Serving commit: <servingSha>
- origin/{{branch}} HEAD: <targetSha>
- Divergence age: <age>m (grace {{graceMinutes}}m)
- Redeploy triggered via POST /api/deploy/trigger at <ts>; re-probe after the
  redeploy window still DIVERGENT.
- Last prod-update log: check the kookr-prod server log (~/.kookr/server.log)
  and \`pnpm prod:logs\`.

Merged fixes are not reaching production until this converges. Filed by
kookr-deploy-convergence (#1883).
EOF
)"
```

## Phase 4 — Complete

Write a one-line receipt (`converged`, `diverging`, or `DIVERGENT … action=…`).
Then `kookr signal completion-ready --note "<receipt>"`. Free the slot — never
hold overnight.
