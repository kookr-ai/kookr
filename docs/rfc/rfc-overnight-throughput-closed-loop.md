# RFC: Overnight Throughput Closed Loop

**Status:** Draft (v4 — post consensus-attack; success = product throughput, not only #1715 actuation)
**Date:** 2026-08-03
**Author:** Jean Ibarz (with Grok Build)
**Evidence pack:** `docs/rfc/rfc-overnight-throughput-closed-loop-evidence.md`
**Related:** #1714 (machine-readable batch outcome), #1715 (pipeline-starvation refill), #1526 (schedule capacity/dead-man), #1921 / #1952 (agent rotation), #1955 (hungSuspect reclaim), `src/core/pipeline-starvation.ts`, `src/server/pipeline-starvation-service.ts`

---

## Problem

On 2026-08-03 production spent ~5 hours with **no new implementable issues and no new PRs** on primary autonomous repos, despite Kookr up, schedules ticking, and free capacity returning.

### What we thought

A greenfield “throughput controller” was needed because “nothing auto-refilled.”

### What forensics + code review actually show

**Issue #1715 already implements a closed loop:**

```text
parallel-issue-batch → outcome blocked-empty
  → POST /api/pipeline-starvation/handle
  → evaluatePipelineStarvationRefill (pure)
  → optional on-demand idea-scout (workloadSize hardcoded full-day)
  → optional pipeline-starvation alert (2nd empty in 12h)
  → durable ~/.kookr/playbook-state/pipeline-starvation/<repo>.json
```

Overnight evidence for **jeanibarz/lucy**:

| Finding | Evidence |
|---|---|
| Handle **did** run (some empties) | State `handledRunKeys` + `blockedEmptyAt` updated; alert at `2026-08-03T04:10:00Z` |
| **No** starvation scout spawn audited | `audit.jsonl` has only `pipeline_starvation_alert` for 08-02/03 — **zero** `pipeline_starvation_scout_spawn` / `_spawn_failed` |
| State has **no** `lastStarvationScoutAt` | Scout never recorded as spawned for this episode |
| Several `blocked-empty` runKeys **not** in `handledRunKeys` | e.g. early-night empties — playbook did not always POST handle |
| Success lookback is **content-blind** | `findRecentSuccessfulIdeationAtMs` treats any DONE scout in 4h as “refilled,” even if zero *implementable* issues |
| No batch re-entry after scout | Lucy scheduled scout ~06:00 UTC; PRs only after next batch cron (~08:07) — multi-hour lag |
| Launch failures separate | kookr batch 00:23Z `quota_exhausted`; orchestrator prompt-ack storms; messages **are** on the ledger |
| Schedule dead-man blind | Healthy fires that complete `blocked-empty` do not look like schedule starvation |

So the gap is **not** “missing architecture.” It is:

1. **#1715 did not spawn (or never recorded) a starvation scout** during the empty window — likely skip via successful-ideation lookback / incomplete handle coverage / unlogged skip.
2. **Even when issues appear, nothing kicks implement** until the next fixed batch cron.
3. **Launch substrate** dropped some producer fires (quota, Grok ack) independently of refill.
4. **Observability** under-surfaces why #1715 chose skip vs spawn (no skip audit rows).

Designing a **second** controller playbook would race #1715, thrash capacity, and still depend on the flaky agent launch path for the control plane itself.

---

## Goals

**Primary product goal (user-visible):** reduce multi-hour windows where free capacity is high and **no PRs / no eligible single-PR work** appear on primary autonomous repos overnight.

#1715 is the **mechanism**, not the goal. A night with perfect audits and zero PRs is still a failure of the *product* goal (it may be a success of *observability* only).

1. **Close the product loop overnight** — free ∧ eligible≈0 → either create *batch-eligible* supply and re-enter implement, or honest `cannot_refill` / `waiting_on_open_prs` without thrashing.
2. **Re-enter implementation after refill** without multi-hour batch cron lag (including after *scheduled* scouts).
3. **Make #1715 decisions auditable** — every handle logs spawn / skip / cannot_refill with inputs.
4. **Keep product-metric discipline** — no low-product invent; feeder skip-invent stays correct.
5. **Launch remediation** on the fire path (parallel track) so producer fires are not dropped.
6. **Cheap healthy path** when eligible work exists.
7. **Phased delivery** — PR slices that both diagnose and shrink the drought.

## Non-Goals

- Not a new always-on supervisor daemon.
- Not a parallel `throughput-controller` playbook as the primary actuator (v1).
- Not removing idea-scout emission budgets or product-metric gates.
- Not auto-spending money / plan upgrades on quota exhaustion.
- Not replacing parallel-issue-batch / idea-scout / queue-feeder wholesale.
- Not folding orchestrator zombie reaping into the product-starvation owner (separate issue if still needed).
- Not multi-tenant orchestration.

---

## Requirements

### R1 — Single product-throughput owner (SHALL)

The **only** automated product-refill actuator remains `PipelineStarvationService` + `evaluatePipelineStarvationRefill` (+ batch POST handle). Any new behavior extends that boundary.

### R2 — Auditable decisions (SHALL)

Every `POST /api/pipeline-starvation/handle` path (including `alreadyHandled`, non-applicable if POSTed, and skips) SHALL append `pipeline_starvation_decision` with:

- **Outputs:** `runKey`, `outcome`, `spawnScout`, `spawnSkipReason`, `spawnedTaskId` / `spawnError`, `emitStarvationAlert`, `consecutiveBlockedEmpty`, `followOnAction` (when present)
- **Inputs (for forensics):** `scoutInFlight`, `recentEligibleIdeationAt` (or null), `issueCreatedCountInLookback` (if known), capacity snapshot fields used (`free` / `freeForGeneralSources` if gated), `disqualifierSummary`

Batch-kick and reconcile paths SHALL also audit (see R5–R6) — silent side paths are incomplete design.

### R3 — Implementability-aware success (SHALL)

Tighten the **single** lookback helper (do not keep two parallel APIs):

- Count as “successful ideation” only when a scout run dir has **≥1 `issue-created.json`** (or equivalent publish receipt) inside the lookback window.
- DONE+mtime alone is **not** success (content-blind overnight failure mode).
- **v1 heuristic floor:** `issue-created ≥ 1` **and** title does not match `/umbrella/i` (cheap; matches overnight disqualifier language). Prefer not setting `lastRefillProducedEligibleHint` for umbrella-only publish.
- **Post-kick learning:** if a batch kicked after “eligible hint” immediately returns `blocked-empty` with no new single-PR-safe unit, clear the hint, record `refill_quality=false`, and do **not** re-arm 4h suppress from that scout (anti thrash: max N empty kicks / 6h then `cannot_refill` for the episode).
- Zero-yield scout (DONE, 0 issue-created): does **not** arm 4h suppress; re-scout after **45–60m** anti-storm cooldown.
- Persist `lastRefillProducedEligibleHint` + timestamp on scout terminal for kick decisions.

### R4 — Light suppress (SHOULD in first ship; expand later)

**First ship:** optional pure check — if **all** itemized disqualifiers match “already has open PR” (prefix), set `followOnAction=cannot_refill` / class `waiting_on_open_prs` and **do not** spawn scout.

**Later (not first PR):** richer `umbrella_only` / feeder residual / merge-watchdog. Feeder residual stays **out of** the starvation actuator until Phase 4 — starvation may *signal* class, not reimplement feeder policy.

### R5 — Batch re-entry (SHALL)

Two triggers (both required for the Lucy lag pattern):

1. **Scout-complete kick:** when any idea-scout for the repo completes with eligible hint true **while** the repo has an open starvation episode (recent blocked-empty / pending kick flag), capacity-gated batch kick.
2. **Handle-time `batch_kick_only`:** when handle would skip spawn *because* recent eligible ideation already exists, **immediately** attempt batch kick (do not wait for another scout completion — this is the scheduled-scout → implement gap).

Guards (must be **named and proven** in code, not assumed):

- Per-repo concurrent batch single-flight (taskStore playbookId scan or shared admission helper used by schedules **and** kicks — build if missing).
- freeForGeneralSources / same capacity gate as schedules.
- Per-repo kick cooldown; clear pending kick flag on scout terminal **success and failure** + max age TTL.
- Feature flag `KOOKR_PIPELINE_BATCH_KICK` (default off until dry-run night).

Audit: `pipeline_starvation_batch_kick` with `result` enum. Persist only `lastBatchKickAt` (+ optional last result in audit, not a state forest).

### R6 — Handle coverage (SHALL, after concurrent hygiene)

1. Playbook: retry handle once on non-2xx; prefer hard-fail (non-zero) if handle still fails after retry (stop soft `|| true` as the only policy).
2. Server safety net: on **batch task terminal**, if `outcome.json` is product `blocked-empty` and runKey ∉ handledRunKeys → invoke handle once (`source=reconcile_terminal`). Prefer this over a free-running dir scan.
3. Optional bound scan only if Phase 0 metrics still show high unhandled rate.
4. **Never** enable reconcile before concurrent NO-OPs stop counting as product `blocked-empty` (server must ignore or accept `emptyClass=concurrent` / `blocked-concurrent` **before** playbook emits it).

### R7 — Launch message surfacing (SHALL, thin)

Surface truncated ledger `message` in schedule UI / health. Full `errorClass` taxonomy + redispatch is **same RFC Phase 3 / sibling track**, not on the product-loop critical path (overnight Lucy gap was primarily empty eligible + no kick; kookr 00:23 quota is parallel).

### R8 — Launch remediation (SHOULD after forensics; Phase 3)

| Subclass | Policy |
|---|---|
| `quota_exhausted` | Prove schedule fire hits rotation; same-period redispatch on healthy alternate agent |
| `prompt_ack_timeout` / launch_timeout | Health-aware backoff; do not rotate into known-bad agent |
| all unhealthy | `launch_blocked` on health; alert once |

### R9 — No busywork (SHALL)

Auto-refill MUST NOT invent low-product ops leaves. Explicit `cannot_refill` is a valid terminal. Feeder skip-invent remains correct.

### R10 — Observability (SHALL)

- Health projection of pipeline-starvation state: last skip reason, consecutive empties, last scout task id, last batch kick time, **episode open/recovered**.
- Alert: keep single key `pipeline:starvation:<repo>`; **severity by class** (warning only when refillable loop failed to actuate; info/no-page for policy `cannot_refill` / `waiting_on_open_prs`); emit **`recovered`** when eligible work returns or batch kick starts after an episode.
- Decision audits are the forensic source of truth; durable state only holds fields that change **future** decisions (skip reason, eligible hint, kick pending/at).

---

## Design

### Principle

**Extend #1715; do not rebuild it.**  
Control plane stays **in-process** (service + pure core). Agents run only for idea quality / implement work.

### Package split (same module family — avoid god-service)

| Module | Owns |
|---|---|
| `pipeline-starvation` (core) | pure decide: spawn/skip, light class, lookback |
| `PipelineStarvationService` | handle POST, audit decision, scout spawn, state save |
| `PipelineStarvationReconciler` | terminal missed-handle only (not schedule-runner body) |
| `PostRefillBatchKick` | pending flag, completion hook, shared concurrent/capacity admission |

### Component A — Decision + state (core)

1. Decision: keep `spawnScout`; add optional `followOnAction` including **`batch_kick_only`** when eligible ideation already exists.
2. State fields that change future decisions only: `lastSpawnSkipReason`, `lastRefillProducedEligibleHint` + at, `kickBatchWhenScoutCompletes`, `lastBatchKickAt`, existing scout task ids.
3. **Loader allowlist co-requisite:** any new durable field updates `loadPipelineStarvationState` + round-trip tests in the **same PR** (today unknown fields are dropped).
4. Ideation: **one** tightened function — success requires `issue-created` ≥1.

### Component B — Service + kick + reconcile

1. Always audit decisions (R2).
2. Scout params: keep `full-day` until spawn path proven; retune later.
3. Wire **explicit** scout/task completion filter (playbookId + repo + pending flag) — do not assume a free-form “terminal bus” already exists; name the subscribe API in the implementing PR.
4. Shared `tryKickBatch(repo)` admission helper for schedules and kicks.
5. Reconcile: terminal path first; optional dir scan later.

### Component C — Playbook hygiene

1. Handle retry + prefer hard-fail after retry.
2. Concurrent NO-OP: **server-first** accept `emptyClass=concurrent` or ignore reason prefix; then playbook emit (two-step deploy). Until then, concurrent empties must not drive product spawn if detectable server-side.
3. Record handle response in `state.md`.

### Component D — Launch path (later track)

Message surfacing first; `errorClass` optional field later; dead-man stays on `launch_error` family.

### Component E — Health + alerts

```json
"pipelineStarvation": {
  "jeanibarz/lucy": {
    "consecutiveBlockedEmpty": 3,
    "lastBlockedEmptyAt": "…",
    "lastSpawnSkipReason": "successful ideation within last 4h",
    "lastStarvationScoutTaskId": null,
    "lastBatchKickAt": null,
    "episode": "open|recovered",
    "episodeOpenedAt": "…"
  }
}
```

### Explicitly removed / deferred

| Element | Disposition |
|---|---|
| throughput-controller playbook actuator | Cut |
| Parallel throughput/ state tree | Cut |
| Event spool | Cut |
| Full class/feeder action table in first ship | Delay |
| Free-running reconcile as primary | Prefer terminal reconcile |
| Orchestrator zombie / cross-repo | Separate issues |
| Second alert family | Cut; recover existing alert |

### Ambition retained

| Hard part | Where |
|---|---|
| Batch re-entry including scheduled-scout path | R5 `batch_kick_only` + complete kick |
| Content-blind lookback | R3 |
| Missed handle coverage | R6 after concurrent hygiene |
| Launch reliability | Phase 3 / parallel track |

---

## Phased delivery (PR slices)

### PR1 — Audit + eligible lookback + health (first merge)

**Must ship together** (vertical slice that both explains *and* can unstick spawn):

1. R2 decision audit (all paths) + inputs
2. State: `lastSpawnSkipReason` with **loader allowlist update** + tests
3. R3: issue-created ≥1 lookback; 45–60m zero-yield cooldown
4. Health: last skip + consecutive + scout task id
5. Surface schedule ledger `message` (optional same PR)

**Out:** class matrix, reconcile, batch kick, errorClass, workloadSize retune.

**Exit:** DONE+0 issues no longer suppresses; operator sees skip reasons in audit; next drought is smaller *or* clearly diagnosed.

### PR2 — Concurrent hygiene + handle coverage

1. Server accepts concurrent empty distinction (before playbook emits new kind)
2. Playbook handle retry / hard-fail after retry
3. Terminal reconcile for unhandled product blocked-empty
4. Alert recovered semantics (if not in PR1)

**Exit:** handledRunKeys coverage ≥99% within 15m; concurrent siblings do not inflate product starvation.

### PR3 — Light class + optional scout budget

- all-open-PR suppress; optional umbrella_only string class in audit only
- optional `quick-shortlist` for starvation spawn

### PR4 — Batch kick (flagged)

- R5 both triggers; shared concurrent admission; `KOOKR_PIPELINE_BATCH_KICK=0` default
- Dry-run night → enable

**Exit:** p95 blocked-empty → batch started ≤45m when free and eligible issues exist (including after scheduled scout).

### PR5 — Launch track (parallel OK)

- errorClass + rotation proof for 00:23-class fires
- Does not gate PR1–4 success for Lucy product loop

### Later

Feeder residual, merge nudge, cross-repo fill, dashboard badge, free-running reconcile scan.

---

## Files to change

| Path | Change |
|---|---|
| `src/core/pipeline-starvation.ts` | class, decision fields, lookback policy hooks |
| `src/core/pipeline-starvation-ideation.ts` | eligible ideation detection via issue-created |
| `src/core/pipeline-starvation-state.ts` | schema fields |
| `src/core/pipeline-starvation*.test.ts` | fixtures from overnight disqualifiers + skip matrix |
| `src/server/pipeline-starvation-service.ts` | audit skips, scout params, batch kick, reconcile |
| `src/server/pipeline-starvation-service.test.ts` | integration-style with fake launcher |
| `src/server/schedule-runner.ts` | errorClass mapping |
| `src/shared/contracts/schedule.ts` | optional `errorClass` field |
| health builder / routes | `pipelineStarvation` projection |
| `plugin/playbooks/parallel-issue-batch.md` | handle retry; concurrent outcome distinction |
| schedule UI (optional Phase 0) | show message + errorClass |

---

## Edge cases

| Case | Handling |
|---|---|
| Scout creates issues batch still rejects | Eligible hint false; shorter cooldown allows re-scout; class may stay umbrella_only; `cannot_refill` after N attempts |
| Concurrent batch NO-OP | Do not count as product blocked-empty |
| Handle called twice | alreadyHandled idempotent (existing) |
| Free capacity 0 | no spawn / no kick; receipt |
| free ledger >0 but freeForGeneralSources=0 | use schedule’s capacity gate fields |
| All agents quota/ack unhealthy | launch_blocked on health; #1715 still records product class |
| Reconciliation finds old outcome (>12h) | ignore outside alert window |
| Feeder skip-invent correct | class may be cannot_refill; alert explains; no invent |

---

## Alternatives considered

### A. New throughput-controller playbook (draft v1)

**Rejected for v1 actuator.** Duplicates #1715, depends on flaky agent launch for control, races event path. May return later as **read-only “explain last night” diagnostics**.

### B. Only densify idea-scout crons

Helpful supplement, insufficient alone (launch failures, missed handle, no batch kick, content-blind 4h). May still add a Lucy overnight scout hour as ops config without code.

### C. Always invent feeder leaves when free≥3

Rejected (product hygiene).

### D. Overload ScheduleDeadManSwitch with blocked-empty

Rejected as primary. Different domain (schedule fire vs product pipeline). Keep alert tuning on #1715.

### E. Long-lived supervisor daemon

Rejected for v1; in-process service + short tasks suffice if event path works.

### F. Depend only on Cross-Repo Orchestrator

Rejected; overnight it was the flakiest schedule.

---

## Risks

| Risk | Mitigation |
|---|---|
| Double scout (#1715 + scheduled + kick) | Shared dedup keys; audit; max 1 starvation scout / 4h remains unless eligible-failure reopens |
| Batch kick stampede | Concurrent guard + per-repo kick cooldown + capacity gate |
| Eligible heuristic wrong | Prefer issue-created count; tune with fixtures; fail open to scout rather than permanent suppress |
| Launch subclass brittle | Tests with exact overnight strings; typed errors preferred |
| Reconciliation expensive | Bound to recent N outcome dirs / time window |

---

## Success metrics (7 nights post PR4)

**Product (primary — do not game with class carve-outs alone):**

1. **Max consecutive hours with freeForGeneralSources≥3 and zero new merged PRs on the tracked repo during overnight window** — target ≤1h for Lucy-class nights (incident ~5h). If class is `waiting_on_open_prs` / policy `cannot_refill`, the hour still counts unless merge-watchdog was invoked or an explicit human/ops hold is set.
2. **Max consecutive hours with free≥3 and last batch `eligibleCount=0`** — target ≤1h when class is refillable; for excused classes, require explicit episode terminal in audit.

**Mechanism (secondary):**

3. **blocked-empty runKeys in handledRunKeys within 15m** — ≥99%.
4. **Handle paths with decision audit** — 100%.
5. **Time from scout complete (with true eligible hint) → batch task created** — p50 ≤15m, p95 ≤45m.
6. **Empty kicks after false eligible hint / 6h** — target 0 after post-kick learning.
7. **Duplicate starvation scouts / repo / 6h** — target 0 (zero-yield re-scout cooldown is intentional and counted separately).
8. Launch classification (after PR5) — track separately; does not redefine product metrics.

---

## Open questions

1. Exact eligible-hint heuristic: issue-created count only, or also exclude titles matching `/[Uu]mbrella/`?
2. Should reconciliation live on the 60s schedule tick or a 5m timer?
3. Merge-watchdog nudge on `waiting_on_open_prs` — enable in Phase 4 or with Phase 1?
4. Grok prompt-ack vs terminalBackend root fix — track as dependency issue; does not block Phases 0–2.
5. Confirm overnight skip reason once R2 audit ships (cannot reconstruct skip reason retroactively — **no skip rows exist today**).

---

## Critic feedback incorporated

### Round 1 panel (2026-08-03)

Critics: `boundary-critic`, `failure-mode-analyst`, `design-minimalist`, `socratic-challenger`, `ambition-amplifier`.

| Source | Finding | Disposition |
|---|---|---|
| **All five (consensus)** | #1715 already owns blocked-empty → scout; draft v1 designed a parallel loop | **Incorporated** — full redesign around extend-#1715 |
| boundary, failure-mode, minimalist | LLM/playbook controller as actuator is wrong dependency direction | **Incorporated** — in-process service only |
| boundary, minimalist, socratic | Dual `throughput/` vs `pipeline-starvation/` state | **Incorporated** — single state document |
| failure-mode, socratic | Prove overnight #1715 behavior before new design | **Incorporated** — forensics section + Phase 0; confirmed no scout_spawn audit; missing handles |
| failure-mode, socratic | `overnight-topup` not a valid workloadSize | **Incorporated** — use existing `quick-shortlist` / `half-day` |
| minimalist, ambition (agree) | Missing batch re-kick is the real closed-loop gap | **Incorporated** — R5 SHALL |
| ambition | R4 was SHOULD; hard part deferred | **Incorporated** — batch kick SHALL; phase order still observes first |
| ambition | Event path demoted to polish while it already exists | **Incorporated** — event path is primary; reconcile is safety net |
| failure-mode | Content-blind 4h successful ideation | **Incorporated** — R3 |
| failure-mode | Caps don’t compose with full producer mesh | **Incorporated** — shared dedup; no second controller |
| boundary | Launch remediation belongs on fire path | **Incorporated** — R7–R8 |
| boundary, minimalist | Prefer errorClass vs reason-code enum sprawl | **Incorporated** — Option B-style |
| boundary, minimalist | Drop orchestrator zombie / cross-repo from v1 primary | **Incorporated** — deferred |
| design-minimalist vs ambition | Soft-first vs hard-first phase order | **Resolved:** Phase 0 observability+forensics (unblocks ops) then Phase 1–2 hard #1715 effectiveness (batch kick, lookback) before Phase 3 launch polish. Ambition wins on *what* is SHALL; minimalist wins on *not building a second system*. |
| socratic | Maybe cron densify alone? | **Partial** — allowed as ops supplement; not sufficient alone |
| ambition-amplifier 2026-08-03 | novel finding: treat #1715 spine + batch kick as core | recorded |

### Empirical checkpoint (post R1)

Probes against live state + code (not another opinion round):

1. **#1715 code exists and matches pack** — confirmed `evaluatePipelineStarvationRefill`, 4h dedup, full-day spawn, alert on 2nd empty.
2. **Overnight scout spawn** — **no** `pipeline_starvation_scout_spawn` audit rows; state lacks `lastStarvationScoutAt` → scout path did not successfully actuate.
3. **Handle partial coverage** — some blocked-empty runKeys never entered `handledRunKeys`.
4. **Skip reasons not auditable** — service only audits spawn success/fail and alert, not skips → R2 mandatory.
5. **Launch messages populated** — earlier “null message” claim was false; taxonomy is classification/surfacing, not capture.

These probes **falsified** draft v1’s premise (“no closed loop”) and **confirmed** critics’ extend-#1715 direction.

### Round 2 panel (2026-08-03)

Critics: `boundary-critic`, `failure-mode-analyst`, `design-minimalist`, `operability-reviewer`, `delivery-pragmatist`.

| Source | Finding | Disposition |
|---|---|---|
| failure-mode, ambition residual | R5 missed **scheduled-scout → implement** lag; need `batch_kick_only` on handle when spawn skipped for eligible ideation | **Incorporated** — R5 two triggers |
| failure-mode, delivery | Concurrent empty vs product empty; R6 before hygiene amplifies false starvation | **Incorporated** — PR2 order; server-first |
| failure-mode, boundary | “Existing concurrent-batch guard” / terminal bus unproven | **Incorporated** — prove or build; name subscribe API |
| design-minimalist, delivery | Phase 0 observe-only too soft; first PR must include R3 | **Incorporated** — PR1 = audit+lookback+health |
| design-minimalist | Full class table / errorClass / free reconcile overbuilt for 5h hole | **Incorporated** — light R4; launch delayed; terminal reconcile |
| boundary | Split god-service; feeder residual out of v1 actuator | **Incorporated** — package table; feeder Phase 4 |
| operability | Alert fire-only no recover; audit inputs; kick/reconcile silent | **Incorporated** — R2 inputs; R5/R6 audit; recovered alert |
| delivery | State loader drops unknown fields; outcome enum two-step deploy; kick kill-switch | **Incorporated** — loader co-requisite; flag; server-first concurrent |
| failure-mode | issue-created alone can still be umbrellas | **Acknowledged** — v1 floor; optional title filter; fixtures; not perfection blocker |

### Round 2 empirical / code notes

- `loadPipelineStarvationState` allowlists fields — new state requires same-PR loader update.
- Playbook handle uses soft fail pattern — coverage cannot rely on agent alone.
- No free “terminal listener for all playbooks” assumed; implementers must wire filter explicitly.

### Consensus attack (2026-08-03, general-purpose)

`general-purpose 2026-08-03: consensus-attack — shared assumption: issue-created ≈ implementable supply / incident = #1715 actuation failure only`

| Finding | Disposition |
|---|---|
| Panel optimized “#1715 closes on its signals” more than “overnight PRs recover” | **Incorporated** — Goals lead with product goal; success metrics 1–2 are PR/eligible hours without pure class carve-out gaming |
| R3 floor `issue-created≥1` still admits umbrellas → kick thrash | **Incorporated** — umbrella title filter; post-kick learning clears false hint; empty-kick cap → `cannot_refill` |
| Scheduled-scout lag fix is solid but does not prove starvation scout quality | **Acknowledged** — R5 still ships for lag; product metrics catch quality failure |

**Question answered:** a night of perfect audits and zero PRs with free capacity is **not** product success — only observability success.

---

## Appendix A — Incident timeline (condensed)

| UTC | Event |
|---|---|
| 00:09 | capacity_gate free=1 active=15 |
| 00:23 | kookr parallel batch **dispatch_failed** quota_exhausted |
| 01:0x | kookr scheduled idea-scout; ~10 issues |
| 02:10+ | lucy batches blocked-empty; not all handled |
| 02:26–03:39 | **manual** kookr batch delivers 10 PRs |
| 04:10 | #1715 alert (2nd empty); **no scout_spawn audit** |
| 06:14 | lucy scheduled idea-scout issues |
| 06:40 / 08:39 | further handled empties (some concurrent no-ops) |
| 08:07+ | lucy batch resumes; PRs merge |
| overnight | orchestrator prompt_ack / confirm failures |

## Appendix B — Mapping original improvement list → v2

| Original suggestion | v2 location |
|---|---|
| Starvation→refill coupling | Already #1715; fix effectiveness R3–R6 |
| Surface launch_error messages | R7 Phase 0 (messages exist) |
| Launch taxonomy / root cause | R7–R8 Phase 0 forensics + Phase 3 |
| hungSuspect / terminal | Correlate open Q4; #1955 separate |
| Cross-repo fill | Deferred Phase 4 |
| Closed loop free∧eligible=0 | #1715 + batch kick R5 |
| Product vs ops leaf policy | R9 + class table |
| Observability | R2, R10, Phase 0 |
