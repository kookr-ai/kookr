# RFC: Project Continuous Progress Watchdog

**Status:** Draft (v1 — ready for review)
**Date:** 2026-07-20
**Author:** Jean Ibarz (with Grok Build)
**Related:** schedule API (`src/server/schedule-service.ts`), playbook discovery, Lucy RFC-015/016 backtest playbooks, `kookr-supervise-tasks` skill, playbook-runtime control plane

---

## Problem

High-value local projects (Lucy backtesting methodology first; others later) need **all-day continuous progress**. The human operator is often at work without access to Kookr. Today progress dies whenever:

1. **No worker is running** — a chain finished, crashed, or was never re-spawned.
2. **A worker is stalled** — waiting for permission, operator confirmation, agent quota, missing data, or a “wait for new reports” conclusion.
3. **The worker is busy on the wrong thing** — it chose idle waiting over productive alternate work.
4. **Infra is down** — Lucy prod unhealthy, data pipeline stuck, tickers not armed, so methodology work cannot proceed even if an agent is live.

Existing tools cover pieces of this:

| Tool | What it does | Gap |
|---|---|---|
| Kookr **schedules** | Fire a playbook on cron with dedup/capacity | No project-level “is the *lane* healthy?” judgment |
| **Successor spawn** in playbook-runtime | Chain the next iteration | Only if the current task succeeds at spawning |
| `kookr-supervise-tasks` skill | Human-requested babysitting of running agents | Not scheduled; not project-scoped; no cost envelope |
| Ralph / autonomous-evolution | Bounded iterative loops | Domain-specific; still dies when the outer task dies |

There is **no durable unattended operator** that:

- checks every hour that the *right* work is progressing,
- acts as the operator for routine decisions,
- **refuses to wait** when alternate productive work exists,
- and is hard-capped so it cannot bankrupt the operator while they are offline.

---

## Goals

1. **Liveness of a named progress lane** — at least one healthy, progressing task owns the lane most of the day.
2. **Operator-proxy within a hard safety envelope** — send recommended next steps, approve routine permissions, close+respawn stalled tasks, restart local infra, arm tickers/data jobs that use *existing* budgets.
3. **No idle waiting** — if the primary lane is blocked on an external event (new filings, market open, report publish), start or extend concurrent productive work (methodology questions, data quality, retrieval coverage, measurement repair, tooling bugs) instead of sleeping.
4. **Cheap healthy ticks** — if everything is progressing, the watchdog run exits in minutes with a receipt, so hourly fire is near-free.
5. **Agent interchangeability** — Claude Code, Codex CLI, and Grok Build are treated as fungible workers until their existing plan limits trip; rotate on unavailability without human input.
6. **Explicit non-payment authority** — the watchdog may **never** decide to spend new money (subscribe, top up credits, enable pay-as-you-go, upgrade plans, buy API quota).

## Non-Goals

- Not a general multi-project attention router (see auto-advance RFC).
- Not a replacement for playbook-runtime CAS/leases/budgets inside domain playbooks.
- Not unsupervised production trading / live strategy promotion.
- Not automatic cloud spend or external paid SaaS expansion.
- Not a 24/7 always-on supervisor process (v1 is **cron-fired short tasks**, not a daemon).
- Not changing Kookr’s global `maxActiveTasks` model.

---

## Design principles

1. **Short watchdog, long workers.** The scheduled task is a *controller*. Heavy analysis stays in domain playbooks (`backtest-methodology-inquiry`, `backtest-reliability-evolution`, …).
2. **Act concurrently; never block the controller on a child.** Spawn or nudge, write a receipt, complete. Do not await child completion inside the hourly tick.
3. **Durable receipts outside git.** Every tick appends to `~/.kookr/playbook-state/<project>/progress-watchdog/`.
4. **Allowlist > intelligence.** Dangerous actions are denied by policy even if the model “thinks” they would help.
5. **Prefer existing Kookr capacity; overflow to CLI.** Keep ≤ ~`maxActiveTasks` (today 10) Kookr agents. When fan-out needs more subagents, use CLI subagents *inside* an already-running task, not more Kookr tasks.
6. **Fail closed on cost ambiguity.** If a repair needs paid API calls and remaining budget is unknown, do free/local work and record a blocker — never invent spend authority.

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  Kookr schedule (cron: 0 * * * *)                           │
│  agentType: round-robin | grok-build | claude-code | codex  │
└───────────────────────────┬─────────────────────────────────┘
                            │ fire → short task
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Progress Watchdog playbook (per project)                   │
│  1. Preflight (KB + env)                                    │
│  2. Survey lanes (API + durable state + infra health)       │
│  3. Classify (healthy | stalled | missing | waiting)        │
│  4. Act (allowlisted operator moves) — concurrent, no wait  │
│  5. Receipt + complete                                      │
└───────────────┬─────────────────────────────┬───────────────┘
                │                             │
                ▼                             ▼
     Domain worker tasks              Side-lane workers
     (methodology inquiry,            (data quality, retrieval
      reliability evolution, …)        audit, tooling fixes, …)
```

### Why schedule-of-short-tasks, not a long-lived supervisor

- Survives Kookr restarts (cron re-fires).
- Dedup already skips if previous watchdog tick still active (`skipped_active`).
- Bounds worst-case spend: each tick has its own wall-clock and cost caps.
- Matches existing operational pattern (Codex daily rebase, etc.).

### v1 vs later

| Slice | Ships in | Notes |
|---|---|---|
| Playbook + hourly schedule + Lucy instance | **v1** | Pure playbook/ops; no Kookr core change required |
| Shared “lane health” helper module | v1 optional | Shell/JS script under project or `~/.kookr/` |
| First-class Kookr “watchdog schedules” UI + action audit | v2 | Nice-to-have observability |
| Daemon supervisor with push events | v3 | Only if hourly lag proves too slow |

---

## Lane model

A **progress lane** is a named ongoing workstream with:

| Field | Meaning |
|---|---|
| `id` | Stable string, e.g. `lucy/backtest-methodology` |
| `projectCwd` | Absolute checkout used for playbook launch |
| `primaryPlaybook` | Filename under `<cwd>/.kookr/playbooks/` |
| `match` | How to detect running tasks (playbookId, name prefix, prompt substring, durable state path) |
| `healthyIf` | Progress signals (lease renewed, lastActedCursor advanced, session lastEventAt fresh, successor pending) |
| `stalledAfterMinutes` | Freshness threshold (default 45 for hourly watchdog) |
| `sideLanes[]` | Alternate productive playbooks/tasks when primary is waiting |
| `infraChecks[]` | Optional local health probes (Lucy pm2, disk, data freshness) |

Lucy v1 lanes:

1. **Primary:** `lucy/backtest-methodology` → `backtest-methodology-inquiry.md`
2. **Side:** reliability evolution, retrieval-coverage audit, interaction triage, measurement tooling bugs, ticker/data arming for free local sources
3. **Infra:** Lucy prod health (`pm2` / HTTP), ability to run `npm run backtest:*` offline checks

---

## Tick algorithm (normative)

Each fire MUST:

### Phase 0 — Preflight

1. Resolve `KOOKR_API_BASE_URL` (default `http://127.0.0.1:4800`).
2. `kb search` for operating-environment notes (schedules, capacity, Lucy ops).
3. Load durable watchdog state; refuse to act if a previous tick holds a non-expired action lease (prevent double-intervention).
4. Read cost envelope parameters; if `costCapUsd` blank → **no paid work** this tick.

### Phase 1 — Survey (read-only)

Collect, without mutating:

- `GET /api/tasks` + `GET /api/snapshot` (when available)
- Durable domain state under `~/.kookr/playbook-state/lucy/*`
- Infra probes (allowlisted commands only)
- Recent watchdog receipts (last 24h) to avoid thrash

### Phase 2 — Classify each lane

| Class | Criteria (examples) | Default intent |
|---|---|---|
| `healthy` | Active task + event within `stalledAfterMinutes` + no hard anomaly | **No-op** |
| `stalled` | Active task but idle/permission/stuck past threshold | Unblock or replace |
| `missing` | No matching non-terminal task | Spawn primary playbook task |
| `waiting` | Task or state says blocked on external event | Keep primary if useful; **also** start side-lane |
| `unsafe` | Would require denied action (payment, live promo) | Record blocker; never force |

### Phase 3 — Act (allowlist only)

Actions are drawn from the catalog below. Multiple actions MAY run in one tick **if** capacity allows; each action is logged before execution. The tick MUST NOT `sleep` waiting for child completion.

### Phase 4 — Receipt + complete

Write:

```text
~/.kookr/playbook-state/<project>/progress-watchdog/
  state.json              # last classification, lease, counters
  ticks/<iso>-<uuid>.json # immutable receipt
  ticks.jsonl             # append-only index
```

Then mark the watchdog task complete (`kookr signal completion-ready` when auto-close is on, or exit cleanly).

---

## Action catalog

### Allowed (v1)

| Action | Mechanism | Notes |
|---|---|---|
| **No-op healthy** | Receipt only | Default |
| **Nudge stalled worker** | Terminal input via session (dtach/tmux send) with concrete next-step text | Self-exclude own task id |
| **Approve routine permission** | Send `1` + Enter on standard tool-permission dialogs | Not for payment/upgrade dialogs |
| **Complete zombie task** | `POST /api/tasks/:id/complete` when already done / abandoned | Prefer complete over abort when safe |
| **Abort irrecoverable stall** | `POST /api/tasks/abort` with reason | Then spawn replacement |
| **Spawn primary playbook task** | `POST /api/tasks` with playbook body or documented spawn helper | Prefer Kookr; record `parentTaskId` = watchdog |
| **Spawn side-lane task** | Same | Only when primary is `waiting`/`stalled`/`missing` secondary capacity free |
| **Rotate agent type** | Next spawn uses next available of `grok-build` → `claude-code` → `codex-cli` | Skip types that hard-failed this day |
| **Lucy prod restart** | `bash ~/git/lucy-prod/scripts/prod-update.sh` only if health check fails | Never hand-edit prod worktree |
| **Arm tickers / data jobs** | Project CLI that uses **existing** local/free sources | No new paid market-data subscriptions |
| **KB capitalize** | `kb remember` for durable ops learnings | Appropriate shelf |

### Denied (hard — never)

- Purchase / top-up / subscribe / enable pay-as-you-go / raise billing limits
- Any UI or CLI that clearly requests **new** monetary authorization
- Live strategy promotion or trading-capital changes
- Force-push to shared main, mass delete of data, `rm -rf` of state roots
- Disabling safety hooks globally to “make progress”
- Spawning unbounded tasks past capacity (must respect `maxActiveTasks` and leave headroom ≥ 2 for interactive use)
- Waiting loops (`sleep` > 30s inside the watchdog for external events)

When a useful action is denied, the receipt records `blocked: payment_or_policy` with a one-line operator TODO for evening review.

---

## Cost & capacity envelope

| Knob | Default | Effect |
|---|---|---|
| Schedule cadence | `0 * * * *` (hourly) | Controller frequency |
| Watchdog `maxDurationMinutes` | `25` | Hard wall clock for the tick |
| Watchdog `costCapUsd` | `5` | Soft agent-token budget for the controller itself |
| Worker `costCapUsd` (spawned) | Playbook default (`10`/`25`) | Domain playbooks keep their own caps |
| Max new Kookr tasks per tick | `2` | Prevent fan-out storms |
| Reserved free slots | `2` | Never fill to absolute maxActiveTasks |
| Agent rotation | on spawn failure / auth / rate-limit | Fungible models |

**Payment rule (normative):** “Use existing plan until limit” is allowed. “Buy more” is forbidden. When a provider returns quota-exceeded, rotate agent type; if all exhausted, stop spawning and leave a high-priority evening blocker.

---

## Anti-thrash rules

1. Do not abort+respawn the same lane more than **twice per 6 hours**.
2. Do not restart Lucy prod more than **once per 2 hours**.
3. Do not re-nudge a task within **20 minutes** of the last nudge (unless permission dialog is actively showing).
4. If last 3 ticks all classified the same hard blocker, escalate to receipt `needs_operator` and no-op further identical actions until state changes.
5. Schedule dedup: if previous watchdog tick still `inProgress`, cron yields `skipped_active` — good; do not disable this.

---

## Continuous-progress rule (critical)

> **Waiting is not a strategy.**

If classification is `waiting` (e.g. “need new earnings reports before the next scorecard row”):

1. Leave or spawn a **cheap monitor** only if it does free polling/data arming.
2. **Immediately** start or ensure a **side-lane** that improves methodology, data quality, tooling, or retrieval **without** that missing data.
3. Never end the tick with “blocked on reports” as the sole outcome if any side-lane has free capacity.

This is the efficiency requirement that makes daytime unattended work worthwhile.

---

## Lucy v1 instance (first consumer)

### Schedule (proposal)

```json
{
  "name": "Lucy Backtest Progress Watchdog",
  "cron": "0 * * * *",
  "cwd": "$HOME/git/lucy",
  "agentType": "round-robin",
  "playbook": {
    "path": "backtest-progress-watchdog.md",
    "parameters": {
      "costCapUsd": "5",
      "maxDurationMinutes": "25",
      "maxNewTasks": "2"
    }
  },
  "enabled": true
}
```

Notes:

- `cwd` is the **Lucy primary checkout** so the schedule resolver finds `.kookr/playbooks/backtest-progress-watchdog.md` (project tier).
- `agentType: round-robin` (or explicit rotation in the playbook) spreads load across Grok Build / Claude / Codex under existing plans. Current server default agent is `grok-build`.
- Playbook file is tracked in the Lucy repo (with the other backtest playbooks).

### Primary worker

Prefer launching `backtest-methodology-inquiry` (autoFix default true, delivery pre-authorized for non-live repairs). Fall back / side-lane to `backtest-reliability-evolution` when methodology state says waiting on data.

### Infra

- Health: process up + optional local HTTP/status if documented.
- Restart path: only `bash "$HOME/git/lucy-prod/scripts/prod-update.sh"` after failed health — never edit `lucy-prod` files by hand.

---

## Observability

Each tick receipt includes:

- `classified`: map lane → class
- `actions[]`: `{type, target, result, deniedReason?}`
- `capacity`: `{active, max, reserved}`
- `agentAttempts[]`
- `needsOperator[]` (payment/policy blockers only)
- `durationMs`

Dashboard v1: operator reads receipts via filesystem or a future Schedules “last watchdog” badge (v2).

---

## Security & safety

- Runs with the same local authority as any Kookr agent (filesystem, git, network as permitted by agent settings).
- **Payment denial is prompt-enforced** in v1 (playbook HARD-RULES). v2 may add a server-side action gateway if thrash/abuse appears.
- Secrets: never copy `.env` into receipts; use playbook-runtime redaction patterns where JSON is written.
- Self-exclusion: never send terminal input to `KOOKR_TASK_ID` of the watchdog itself.

---

## Requirements

- **R1.** An hourly (configurable) Kookr schedule SHALL launch a short progress-watchdog playbook for a configured project lane set.
- **R2.** If the primary lane is `healthy`, the tick SHALL no-op after writing a receipt and complete within the duration cap.
- **R3.** If the primary lane is `missing` or `stalled` beyond threshold, the tick SHALL take an allowlisted recovery action or record why it could not.
- **R4.** If the primary lane is `waiting` on an external event, the tick SHALL ensure at least one productive side-lane is active when capacity allows — pure waiting is non-compliant.
- **R5.** The watchdog SHALL NOT perform any action in the Denied catalog, including all forms of new monetary authorization.
- **R6.** The watchdog SHALL respect `maxActiveTasks`, reserve ≥2 free slots, and create at most `maxNewTasks` tasks per tick.
- **R7.** Agent types `grok-build`, `claude-code`, and `codex-cli` SHALL be treated as interchangeable under existing plans; rotation on unavailability is required before declaring all-agents-blocked.
- **R8.** Every tick SHALL append an immutable receipt under `~/.kookr/playbook-state/<project>/progress-watchdog/`.
- **R9.** Lucy prod restarts SHALL only use the documented `prod-update.sh` path and only after a failed health check.
- **R10.** The watchdog task itself SHALL NOT await child task completion.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Abort thrash | Anti-thrash counters; max 2 respawns / 6h |
| Quiet cost burn via workers | Worker playbooks keep costCapUsd; watchdog spawn budget small |
| Filling all 10 slots | Reserve 2; max 2 new / tick |
| “Helpful” payment attempt | Hard deny list + receipt blocker |
| Wrong restart of Lucy | Health-check gate + rate limit |
| Silent schedule breakage | Playbook must exist at fire time; post-create `POST .../run` smoke |

---

## Implementation plan

### PR-A (this change set) — design + Lucy instance

1. This RFC in Kookr `docs/rfc/`.
2. Lucy playbook `backtest-progress-watchdog.md`.
3. Optional tiny helper script for classification (or pure shell in playbook).
4. Operator steps to `POST /api/schedules` (and optional one-shot run).
5. KB note for ops environment.

### PR-B (optional follow-up)

- Extract shared lane-health helpers if a second project adopts the pattern.
- Dashboard badge for last watchdog receipt.

### PR-C (only if needed)

- Server-side denied-action gateway / structured watchdog schedule type.

---

## Alternatives considered

1. **Long-lived supervise task instead of hourly cron** — higher continuous cost; dies with session; harder to bound. Rejected for v1.
2. **System crontab calling curl only (no agent)** — cannot judge stalls or write good nudges. Rejected as sole mechanism; may later complement with pure probes.
3. **Fold into domain playbook successors only** — fails when the chain dies; no infra restart; no side-lane when waiting. Insufficient alone.
4. **Full autonomous multi-agent swarm** — capacity and cost risk while operator is offline. Rejected; keep maxNewTasks tiny.

---

## Open questions for the operator

1. Prefer `agentType: "round-robin"` at schedule level, or always `grok-build` first with playbook-level failover?
2. Should reliability evolution be co-primary (always one of methodology **or** reliability) or strictly a side-lane?
3. Evening digest (Telegram/email) for `needsOperator` blockers — wanted in v1 or later?
4. OK to enable the hourly schedule immediately after merge, or dry-run for 24h with `enabled: false` + manual `POST .../run`?

---

## Appendix A — Example healthy receipt (abbreviated)

```json
{
  "tickId": "…",
  "at": "2026-07-20T12:00:12Z",
  "classified": { "lucy/backtest-methodology": "healthy" },
  "actions": [{ "type": "noop_healthy", "target": "lucy/backtest-methodology" }],
  "capacity": { "active": 4, "max": 10, "reserved": 2 },
  "needsOperator": [],
  "durationMs": 48000
}
```

## Appendix B — Example waiting+side-lane receipt

```json
{
  "classified": {
    "lucy/backtest-methodology": "waiting",
    "lucy/retrieval-coverage": "missing"
  },
  "actions": [
    { "type": "nudge", "target": "task:…", "result": "sent_next_steps" },
    { "type": "spawn_side_lane", "target": "retrieval-coverage-audit", "result": "spawned", "taskId": "…" }
  ],
  "needsOperator": []
}
```
