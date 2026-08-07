# Evidence pack — Overnight Throughput Closed Loop

**Date:** 2026-08-03  
**Incident window:** ~2026-08-03T01:00Z–08:20Z (issue drought ~5h; PR drought ~03:40–08:20Z)  
**Sources:** live prod API `:4800`, `~/.kookr/schedules.json`, playbook-state, GitHub `gh` timelines.  
**Treat as claims to verify, not settled fact.**

---

## Pipeline map

```text
cron schedules (Europe/Paris)
  │
  ├─ repository-idea-scout (kookr nightly 03:00; lucy 08:00/16:00)
  │     → opens idea-scout issues (budgeted emission)
  │
  ├─ queue-feeder (half-hourly when free≥3)
  │     → decomposes umbrellas into product-metric leaf issues
  │     → skip-invent for low-product residual umbrellas
  │
  ├─ parallel-issue-batch (lucy every 2h; kookr 02:23/14:23)
  │     → selects safe single-PR units → spawn implementers → merge
  │     → outcome blocked-empty when eligibleCount=0
  │     → writes ~/.kookr/playbook-state/pipeline-starvation/<repo>.json
  │
  ├─ Cross-Repo Autonomous Orchestrator (xx:13, xx:43)
  │     → supposed cross-repo fill / rebalance
  │
  └─ schedule-runner (60s tick)
        → launch-service → agent adapter (grok-build / claude / codex)
        → execution ledger (outcome + reasonCode + message)
        → ScheduleDeadManSwitch (schedule-level starvation only)
```

### Load-bearing modules (source pointers)

| Area | Path | Notes |
|---|---|---|
| Schedule outcomes / reason codes | `src/shared/contracts/schedule.ts` | `dispatch_failed`, `launch_error`, ledger `message?` already exists |
| Fire + error mapping | `src/server/schedule-runner.ts` ~312–381 | `mapErrorToReasonCode`; always passes `message` to `markExecutionOutcome` |
| Launch timeout | `src/server/launch-service.ts` | `LaunchTimeoutError` → `launch_error` |
| Schedule dead-man | `src/server/schedule-dead-man.ts` | consecutive dispatch failures OR no healthy fire in window; **alert-only**, not pipeline-aware |
| Capacity ledger | `src/core/capacity-ledger.ts` | `hungSuspect` class; PR #1955 reclaim TTL merged 2026-08-03 |
| Agent rotation on quota | engine (recent #1921 schedule rotation, #1952 spawn rotation) | present but orchestrator still launch-failed overnight |

### Playbook-state contracts (runtime, not git)

| Path | Role |
|---|---|
| `~/.kookr/playbook-state/parallel-issue-batch/<repo>/<runKey>/outcome.json` | `outcome: done \| blocked-empty`, reason, disqualified |
| `~/.kookr/playbook-state/pipeline-starvation/<repo>.json` | `blockedEmptyAt[]`, lastStarvationAlertAt |
| `~/.kookr/playbook-state/queue-feeder/decisions.jsonl` | free, emitted, skip-invent reasons |
| `~/.kookr/playbook-state/repository-idea-scout/<repo>/<runKey>/` | emission plan, issue-created.json |

---

## Telemetry / incident findings (2026-08-02 night → 2026-08-03 morning)

### A. Throughput gap (GitHub)

| Repo | Issues | PRs |
|---|---|---|
| kookr-ai/kookr | last new issues ~01:12Z; then dry until later | continuous until ~03:38Z (10 PRs in manual batch), then dry |
| jeanibarz/lucy | last idea-scout burst ~06:14Z (08:14 CEST) | continuous until ~02:45Z; **gap until ~08:20Z** |

### B. Pipeline starvation (primary)

Lucy parallel-issue-batch outcomes overnight (sample):

```text
2026-08-03T02:10Z blocked-empty — No safe, unblocked, single-PR issue remains
2026-08-03T04:10Z blocked-empty — same
2026-08-03T06:10Z blocked-empty — same
```

`pipeline-starvation/jeanibarz-lucy.json`:

```json
{
  "blockedEmptyAt": [
    "2026-08-03T04:10:00.876Z",
    "2026-08-03T06:40:17.059Z",
    "2026-08-03T08:39:43.049Z"
  ]
}
```

Open issue count stayed ~18–22; almost all umbrellas or already-had-open-PR.

### C. Queue feeder free-but-empty

```text
2026-08-03T07:39Z free=10 emitted=[] 
  reason=needsAuthoring-low-product-signal-skip
  notes: product umbrellas already have 4–5 CLOSED leaf children;
         residual pool is ops/harness/docs; will not invent low-product leaves
```

### D. Idea-scout cadence

| Scout | Cron (Paris) | Overnight result |
|---|---|---|
| Kookr | 03:00 | completed; ~10 issues filed (~01:00 UTC window) |
| Lucy | 08:00, 16:00 | next fill only at 06:00 UTC — **~5–8h after implementable backlog drained** |

### E. Launch failures (messages ARE populated)

Kookr parallel batch scheduled fire:

```text
2026-08-03T00:23:43Z dispatch_failed / launch_error
msg= Anthropic plan quota is exhausted (utilization 100% ≥ threshold 90%)
     Retry after binding window resets 2026-08-04T12:00:00Z
```

Cross-Repo Orchestrator overnight cluster:

```text
repeated launch_error:
  - Grok did not acknowledge initial prompt within 10000ms (UserPromptSubmit)
  - Initial prompt submission was not confirmed after 3 attempts
  - Agent launch timed out after 180s
```

A **manual** kookr batch (`2976b697`, provenance=manual) still delivered 10 merged PRs ~02:26–03:39Z despite degraded terminalBackend (parent-implementer fallback).

### F. Capacity / terminal

```text
2026-08-03T00:09Z capacity_gate free=1 freeForGeneralSources=0 active=15
health ~09:08Z: hungSuspect=2, terminalBackend degraded
  lastError kind=session-recovery-unverified id=kookr-9d9ec5d9
```

### G. What schedule dead-man does NOT cover

`ScheduleDeadManSwitch` watches **schedule fire outcomes**, not “eligible implementable work = 0 while free capacity high”.  
Completed `blocked-empty` batch runs count as healthy schedule executions — so the dead man stays quiet while product throughput is zero.

---

## #1715 overnight forensics (post R1 — verified)

### Code (exists)

- `src/core/pipeline-starvation.ts` — pure `evaluatePipelineStarvationRefill`; adaptive scout dedup (baseline 4h, halving per 2 consecutive blocked-empty to a 30m floor — #2171); 4h successful-ideation lookback; alert on 2nd empty in 12h.
- `src/server/pipeline-starvation-service.ts` — `POST` handle consumer; spawns idea-scout with **`workloadSize: 'full-day'`** hardcoded; audits **spawn** and **alert** only (not skips).
- `src/core/pipeline-starvation-ideation.ts` — success = state.md DONE marker + mtime within lookback (**content-blind** to issue-created).
- Playbook contract: every `blocked-empty` should `POST /api/pipeline-starvation/handle`.

### Live state 2026-08-03 (~morning)

`~/.kookr/playbook-state/pipeline-starvation/jeanibarz-lucy.json`:

```json
{
  "blockedEmptyAt": ["…04:10Z", "…06:40Z", "…08:39Z"],
  "handledRunKeys": ["68a389e0…", "cac61263…", "1b76c0f3…"],
  "lastStarvationAlertAt": "2026-08-03T04:10:00.876Z"
}
```

**Missing:** `lastStarvationScoutAt`, `lastStarvationScoutTaskId`.

### audit.jsonl

- `pipeline_starvation_alert` at 2026-08-02T10:21Z and 2026-08-03T04:10Z for lucy.
- **Zero** `pipeline_starvation_scout_spawn` / `_spawn_failed` rows for 2026-08-02/03.
- Therefore: handle ran for some empties and alerted, but **did not successfully spawn** a starvation scout (skip path with no audit, or never spawnScout=true).

### Incomplete handle coverage

Several overnight `blocked-empty` outcome runKeys (e.g. early 02:10 / 06:10 batch dirs) are **not** in `handledRunKeys` — playbook POST was skipped or failed without reconciliation.

### Design implications (for critics to stress-test)

1. **Extend #1715** — do not invent a parallel controller.
2. **Audit skips** — without them nights are un-debuggable.
3. **Implementability-aware lookback** + **batch kick after scout** close the product loop.
4. **Launch reliability** is fire-path taxonomy + rotation verification, not a second policy engine.
5. **Orchestrator thrash** is secondary; loop must work with orchestrator disabled.
