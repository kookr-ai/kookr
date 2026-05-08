# RFC: Ralph Loop Stall Handling

**Status:** Draft (v4 — post-round-3 review of v3)
**Date:** 2026-05-08
**Author:** Jean Ibarz (with Claude)

(See git history for v1, v2, v3 and the round-by-round critic record.)

---

## Problem

A Ralph loop today only terminates on five conditions: iteration cap, predicate exit 0, zero-diff convergence, cost cap, manual cancel. There is no engine-level concept of "the agent tried this target and made no real progress." When the agent decides "I cannot do the work right now and I'll stop," the cycler treats that Stop event as iteration-boundary and re-injects the *same* prompt verbatim.

**Two concrete failure modes observed in production:**

1. **Single-target loop, gating condition never clears.** A `mergeAfterImplementation: true` loop where the PR's required checks stay red. The agent inspects the PR every iteration, decides "not mergeable," stops. Loop spins until iteration cap is consumed.

2. **Multi-target loop, one target burned-out, others slowed.** A `implement-github-issue` batch where one issue has a permanent blocker. v9's `.batch-attempted` retry counter is playbook-internal, dashboard-invisible, ad-hoc per playbook. Live ground-truth at 2026-05-08: `.batch-attempted` contains `149, 154, 153, 154` after one cumulative iteration of engine bookkeeping.

**The engine is missing a vocabulary for stall.** v9's workaround is playbook-internal; a generic engine-level signal is needed.

## Goals

1. **Engine-level stall vocabulary.** A stalled iteration is a first-class outcome with a recorded reason.
2. **Continue-then-skip, don't terminate prematurely.** When a target stalls, the loop keeps running but persists the burnt target.
3. **Single-target safety net** (default-on).
4. **Multi-target safety net.** When all declared targets are burned, terminate cleanly with `all_targets_stalled` instead of spinning to cap.
5. **Two channels: agent-cooperative (verdict file) and engine-only (`stallPredicate`).** Operators with legacy or third-party agents that don't write verdicts still get stall detection.
6. **Per-iteration cost cap as a separate signal.** Decoupled from stall vocabulary; own exit reason; defends the operator's spend without polluting target attribution.
7. **Operability built-in.** Warning counters, audit trails for mutations, dashboard surface in the same PR as the engine work — operator can diagnose without tailing stderr.
8. **Optional opt-in.** Loops without verdict reporting / stall predicate / cost cap behave identically to today.

## Non-Goals

- **Replacing the iteration-as-task reframing** (`rfc-ralph-loop-batch-mode-findings.md`).
- **Auto-recovering from a stalled target.** Operator unblocks via `PATCH burned-targets` (§7) or by the agent reporting `progress`. Optional decay knob is in §11.
- **Stall detection inside a single iteration** (long-running tools, infinite loops).
- **Helper binary `kookr-ralph-verdict`** (still cut — agents write JSON directly).
- **`{{#if}}` template conditionals** (still cut — empty-string substitution + marker-presence opt-in is enough).
- **`skip-target` verdict variant** (still cut — collapsed into `progress`).
- **Atomic-write contract enforcement.** Engine treats partial JSON as malformed; this is contractual on the agent side. The operability-reviewer surfacing makes silent degradation visible (§9).

## Hard prerequisite

This RFC's PRs require `rfc-ralph-loop-redesign.md` to have merged first. Both touch `launchFreshRuntime` in `ralph-loop-service.ts`. The redesign's pre-spawn `ownerSessionId` write and post-spawn cancel-during-launch re-check are correctness-load-bearing. PR1 (additive scaffold only) can ship before redesign; PR2 (cycler integration) blocks on redesign merge.

## Design philosophy

1. **Two parallel stall signals.** A JSON verdict file the agent writes (richest), and a shell `stallPredicate` the engine runs (no agent cooperation needed). Each adds about 30 lines; together they cover both cooperative and uncooperative agents. The user explicitly asked for predicate-semantics revisit; restoring `stallPredicate` honors that.
2. **Engine state on `task.ralphLoop`, not in side files.** Single counter on `BurnedOutTarget.consecutiveStallCount`. No parallel maps.
3. **Verdict parsing at the service layer.** Cycler stays pure-computation; receives parsed verdict via `RalphCyclerHandleStopOptions.verdict`.
4. **Operability is co-equal to mechanism.** Warning counters, interaction-log events, and dashboard chips ship together with the cycler change — not in mythical follow-up RFCs.

## Design

### 1. Verdict file (cooperative-agent channel)

Engine exposes `RALPH_VERDICT_FILE` env var to the agent. Default path: `<task.cwd>/.ralph-verdict-<taskIdShort>.json` where `taskIdShort = task.id.slice(0, 8)`. The per-task suffix removes the v3 shared-cwd 409 refusal (`ambition-amplifier` Finding 5) — two ralph loops in the same workdir get distinct verdict files at zero cost.

Schema:

```ts
type RalphIterationVerdict =
  | { verdict: 'progress'; iteration: number; target?: string; reason?: string }
  | { verdict: 'complete'; iteration: number; reason?: string }
  | { verdict: 'stalled'; iteration: number; target: string; reason: string; blockers?: string[] };
```

**Lifecycle (owned by `ralph-loop-service.ts`):**

1. **Before iteration launch:** `unlink(RALPH_VERDICT_FILE)` (idempotent). Runs on every code path that bumps `loop.currentIteration`. Crash-recovery path also unlinks; if a stale file existed, the recovery emits an interaction-log event `ralph_stale_verdict_unlinked` (§9).
2. **Iteration runs:** agent writes via temp-file-then-rename; canonical pattern is `${RALPH_VERDICT_FILE}.tmp` then rename (sibling on same dirname → same filesystem → atomic).
3. **Stop fires:** `handleStopFingerprint` reads with `fs.lstat` (not `stat` — avoids symlink attack), validates size ≤ 16KB BEFORE allocating, opens with `O_NOFOLLOW`, parses JSON, validates schema + `iteration === loop.currentIteration`. Then unlinks.
4. **Service passes parsed verdict to cycler** via `RalphCyclerHandleStopOptions.verdict`.
5. **No file at Stop:** treated as legacy `continued`. No warning.
6. **Schema mismatch / wrong iteration / oversize / symlink / partial JSON:** increments `loop.verdictWarningCount`, fires interaction-log event `ralph_verdict_warning` with reason, treated as legacy `continued` (§9 operability fix).

### 2. `stallPredicate` (engine-only channel)

A new sibling to `stopPredicate`. Optional shell command, exit 0 = treat the iteration as a stall verdict (single-target attribution since predicate has no target). 5s timeout, same env exposure (`RALPH_ITERATION`, `RALPH_LAST_OUTPUT_FILE`). Reuses the existing `runStopPredicate` infrastructure in `src/core/ralph-predicate.ts`.

```ts
interface RalphLoopState {
  // ... existing ...
  stopPredicate?: string;       // existing
  stallPredicate?: string;      // NEW
}
```

When both signals fire on the same iteration:
- `stopPredicate` exit 0 wins over everything — terminates `predicate_satisfied`.
- Otherwise, verdict file (if present) wins over `stallPredicate`. The verdict carries richer attribution (target, blockers) when it's available.
- If verdict file is absent and `stallPredicate` exits 0, engine records as a single-target stall.

This restores the predicate-semantics revisit the user explicitly asked for and which v2 cut as "subsumed" (`ambition-amplifier` Finding 2).

### 3. Burned-out target tracking

```ts
interface RalphLoopState {
  // ... existing ...
  burnedOutTargets?: BurnedOutTarget[];
  stallConfig?: RalphStallConfig;
  verdictWarningCount?: number;        // NEW (operability)
  iterationCostWarningCount?: number;  // NEW (operability for §6)
}

interface BurnedOutTarget {
  /** Canonicalized target string. */
  target: string;
  /**
   * CONSECUTIVE stall count for this target. Resets to 0 on any `progress`
   * verdict for the same canonicalized target, OR on any `progress`/`stalled`
   * verdict for a DIFFERENT target in this loop's lifetime — see §3 reset rule.
   */
  consecutiveStallCount: number;
  /** Total lifetime stall count, monotone-incrementing. Surfaced to dashboard. */
  totalStallCount: number;
  firstStalledAtIteration: number;
  lastStallReason: string;
  lastStallBlockers: string[];
  /** True once `consecutiveStallCount >= consecutiveStallsPerTarget`. */
  burned: boolean;
  /** Iteration at which this target was last attempted (for decay — §11). */
  lastAttemptedIteration: number;
}

interface RalphStallConfig {
  /** Default 2. */
  consecutiveStallsPerTarget?: number;
  /** Default 'single-target' (fail-safe). */
  loopShape?: 'single-target' | 'multi-target';
  /** Default 3. Only single-target. */
  consecutiveStallsForSingleTargetTermination?: number;
  /**
   * For multi-target loops only. When all declared targets are in burnedOutTargets,
   * the engine terminates with `all_targets_stalled` instead of spinning to cap.
   * Without this list, multi-target loops have no all-burned signal.
   */
  declaredTargets?: string[];
  /**
   * Optional: number of iterations a target stays burned without being attempted
   * before its consecutiveStallCount resets. Default undefined (no decay).
   */
  burnedTargetDecayIterations?: number;
  /**
   * Optional: per-iteration cost cap in USD. Decoupled from stall machinery.
   * Two consecutive iterations exceeding the cap → terminate with `iteration_cost_cap`.
   */
  iterationCostCapUsd?: number;
  /** Default 2. Threshold of consecutive over-cap iterations before terminating. */
  consecutiveIterationCostCapHits?: number;
}
```

**Single counter, single source of truth.** `BurnedOutTarget.consecutiveStallCount` is the authoritative stall counter; `totalStallCount` is for dashboard display only. The v3 `perTargetStallCount: Record<string, number>` parallel map is dropped.

**Reset rule (specifies the v3 contradiction `ambition-amplifier` Finding 7 caught):**
- `progress` verdict for canonicalized target X → reset `consecutiveStallCount` for X to 0; remove from `burnedOutTargets`. (Un-burn.)
- `progress` verdict with no `target` field → no resets (iteration-level progress signal).
- `stalled` verdict for target X → if X already in `burnedOutTargets`, increment its `consecutiveStallCount` and `totalStallCount`. Otherwise create a row.
- `stalled` for target X does NOT reset target Y's counter. Different targets are independent.

This is "consecutive *for that target's stall events*," not "consecutive across all events." The semantic the field name implies, now matched in the spec.

**Target canonicalization:** `target.trim().toLowerCase().replace(/^#/, '')`.

**Default `loopShape: 'single-target'`** (fail-safe — production-observed failure shape; operator notices fast if accidentally defaulted, vs. silent spin to cap).

**Validation at attach** in `validateRalphLoopRequest`: `loopShape` ∈ {`single-target`, `multi-target`}; thresholds positive integers; `iterationCostCapUsd` positive finite number; `declaredTargets` is an array of unique canonicalized strings if present.

### 4. Stall threshold logic

Decision order in the cycler (cheapest-first):

```
manual cancel/pause                     → noop                              (today)
iteration cap                           → terminate(iteration_cap)          (today)
stopPredicate exit 0                    → terminate(predicate_satisfied)    (today)
verdict.complete + predicate ok         → terminate(predicate_satisfied)    [NEW]
verdict.complete + predicate exit≠0     → continue, fire ralph_predicate_disagree event [NEW]
verdict.complete + predicate err/timeout → terminate(predicate_satisfied)   [NEW]
verdict.stalled  (multi-target)         → record stall, check all-burned    [NEW]
verdict.stalled  (single-target ≥ N)    → terminate(target_stalled)         [NEW]
stallPredicate exit 0  (no verdict)     → record single-target stall        [NEW]
multi-target: all declaredTargets burned → terminate(all_targets_stalled)   [NEW]
iteration cost cap (Nth consecutive)    → terminate(iteration_cost_cap)     [NEW]
cost cap (cumulative)                   → terminate(cost_cap)               (today)
zero-diff                               → terminate(zero_diff_convergence)  (today)
else                                    → continue                          (today)
```

**Three new exit reasons:** `target_stalled`, `all_targets_stalled`, `iteration_cost_cap`. (`ambition-amplifier` Finding 4 restored `all_targets_stalled` — multi-target loops with all-burned would otherwise silently spin to cap, recreating the original problem.)

### 5. Predicate × verdict precedence

Same matrix as v3 §4 (already specified for `predicate_error` / `predicate_timeout`). Predicate exit 0 wins over verdict; clean non-zero exit blocks `verdict.complete`; error/timeout lets verdict win.

`stallPredicate` runs only if `stopPredicate` did not exit 0 and a verdict.stalled was not already produced. This keeps semantics deterministic.

### 6. Per-iteration cost cap (decoupled from stall machinery)

`stallConfig.iterationCostCapUsd` is the soft per-iteration limit. Each iteration's cost delta is `stop.cumulativeCostUsd - lastIteration.cumulativeCostUsd`. If the delta is unknown (`null` from cost source), no signal fires (fails closed, same as cumulative cap). If the delta exceeds the cap:

- Increment `loop.iterationCostWarningCount` and fire `ralph_iteration_cost_warning` interaction-log event with the iteration's actual cost.
- Track consecutive-over-cap count.
- After `consecutiveIterationCostCapHits` (default 2): terminate with new exit reason `iteration_cost_cap`.

Crucially this does NOT touch `BurnedOutTarget` data — v1's mistake was attributing iteration overspend to the agent's target choice and treating it as a stall. v4 keeps the two concerns orthogonal: cost cap is a budget signal with its own counter, threshold, exit reason, and interaction-log event.

### 7. Per-iteration prompt templating

Same as v3: marker-presence opt-in (regex `/\{\{ralph\.[a-z_]+\}\}/`), unconditional substitution with empty-string fallback, no `{{#if}}`. Tokens:

- `{{ralph.iteration}}`
- `{{ralph.cumulativeIterations}}`
- `{{ralph.burnedOutTargets}}` — comma-separated; `(none)` when empty (so prose like "Burned: {{ralph.burnedOutTargets}}" reads naturally either way).
- `{{ralph.lastStallReason}}`
- `{{ralph.recentVerdicts}}` — last 5 from `ralph-iterations.jsonl`.

Renderer is a pure function in `src/core/ralph-iteration-template.ts`, called from `ralph-loop-service.ts:launchFreshRuntime` *before* invoking `launchFreshTaskSession`.

### 8. Operator API

**Read:**
- `GET /api/tasks/:id/ralph-loop` — NEW dedicated route that returns just `task.ralphLoop` with resolved `stallConfig` (defaults merged in so the operator sees what the loop is actually running with). Avoids reading the JSONL log just for state inspection.
- `GET /api/tasks/:id/ralph-loop/iterations` — existing. PR2 also updates `parseIterationRecord` to extract the new `verdict` field (operability-reviewer MEDIUM 5).

**Mutate:**
- `PATCH /api/tasks/:id/ralph-loop/burned-targets`
  ```json
  { "remove": ["154"], "clear": false }
  ```
  Returns 200 with the updated array. **Audit trail:** every PATCH fires a `ralph_burned_targets_modified` interaction-log event with `taskId`, `removed`, `cleared`, `previousBurnedOutTargets` (full snapshot), `timestamp`, and `actor` (session/IP if available). (operability-reviewer HIGH 2.)

### 8.1. `extraEnv` precedence

`AdapterLaunchOptions.extraEnv` overrides any colliding key from `buildAgentLaunchContext`. Caller-wins is the documented direction: callers passing an explicit env override know what they want, and silently dropping their request would surprise them. Adapters that need to defend a required key set it via `extraEnv` at the call site rather than privileging `launchContext.env`. PR1's per-adapter contract tests pin this direction.

### 9. Operability surface (in this RFC's PRs, not deferred)

**`RalphLoopState` operability fields:**
- `verdictWarningCount: number` — increments on each malformed verdict (operability-reviewer HIGH 1).
- `iterationCostWarningCount: number` — increments on each over-cap iteration.
- `lastVerdictWarningReason?: string` — the most recent reason, for quick triage.

**New interaction-log event types** in `src/core/interaction-log.ts`:
- `ralph_verdict_warning` — fired on each malformed verdict; carries iteration, reason, raw size.
- `ralph_predicate_disagree` — fired when verdict.complete + clean non-zero predicate exit (operability-reviewer MEDIUM 6).
- `ralph_burned_targets_modified` — PATCH audit (operability-reviewer HIGH 2).
- `ralph_stale_verdict_unlinked` — on crash-recovery path when the pre-launch unlink found a leftover file (operability-reviewer MEDIUM 7).
- `ralph_iteration_cost_warning` — over-cap iteration.
- `ralph_target_burned` — when a target's consecutiveStallCount first reaches the threshold.
- `ralph_target_unburned` — when `progress` un-burns a target or `PATCH` removes one.

**Dashboard panel** (in `src/frontend/components/RalphLoopPanel.tsx`, ~50 lines):
- Burned-targets row in the existing summary grid: shows comma-separated list and counts; `Clear` button → `PATCH burned-targets {clear: true}` with a confirm modal.
- Verdict-warning badge: shows `verdictWarningCount` if non-zero, click → opens the iterations panel filtered to warning records.
- Effective `stallConfig` row: shows resolved values (defaults merged).
- Per-iteration cost spark line is OUT — no per-iteration cost field on the iteration record yet; defer to a small follow-up that adds `costUsd` to `RalphIterationRecord` (~10 lines, can ship in PR2 if budget allows).

The user "lives in the dashboard." The minimal panel (~50 lines of React) ships in PR2 — not a separate "follow-up."

### 10. Workdir contract

Same as v3: agent reads `$RALPH_VERDICT_FILE`, atomic-writes via sibling tmp, engine resolves absolute path. v4 adds: per-task suffix in the default file name (`.ralph-verdict-<taskIdShort>.json`) so two ralph loops in the same cwd are safe and the v3 attach-time 409 refusal is removed (`ambition-amplifier` Finding 5).

### 11. Decay (Q1 from v3)

Optional config: `stallConfig.burnedTargetDecayIterations`. When non-undefined, at the top of each iteration the engine checks each `burnedOutTarget`: if `loop.currentIteration - target.lastAttemptedIteration >= burnedTargetDecayIterations`, reset `consecutiveStallCount` to 0 and `burned` to false. Default undefined = no decay.

This addresses the CI-flake scenario the `ambition-amplifier` review flagged: a transient blocker permanently burned a target in v3. Decay gives operators a knob to retry burned targets after N iterations of no attempts. Cost: ~15 lines.

### 12. Migration

- Verdict file: optional. Loops that don't write it behave as today.
- `.batch-attempted` (v9 batch-mode): kept for one release. PR3 removes it from `implement-github-issue.md`. **Concrete merge gate:** PR3 ships when `ralph_verdict_warning` interaction-log events have been below 1% of iterations for 14 consecutive days in production usage. Documented in PR3's description; implementor verifies via interaction-log query before merging. (`ambition-amplifier` Finding 8.)
- Existing `stopPredicate` loops: untouched.
- New exit reasons: PR1 lands the parser update first; partial rollback (revert PR2 only) preserves audit-log readability.

## Data model

```ts
// src/core/tasks.ts — additions to RalphLoopState
interface RalphLoopState {
  // ... existing fields ...
  stallPredicate?: string;
  burnedOutTargets?: BurnedOutTarget[];
  stallConfig?: RalphStallConfig;
  verdictWarningCount?: number;
  iterationCostWarningCount?: number;
  lastVerdictWarningReason?: string;
}

// src/core/ralph-iteration-log.ts — additions
type RalphIterationExitReason =
  | 'continued'
  | 'predicate_satisfied'
  | 'predicate_timeout'
  | 'predicate_error'
  | 'iteration_cap'
  | 'cost_cap'
  | 'zero_diff_convergence'
  | 'kookr_crash'
  | 'target_stalled'           // NEW
  | 'all_targets_stalled'      // NEW
  | 'iteration_cost_cap';      // NEW

interface RalphIterationRecord {
  // ... existing fields ...
  verdict?: RalphIterationVerdict;
  costDeltaUsd?: number;       // NEW (per-iteration delta if known)
}

// src/core/interaction-log.ts — new event variants in InteractionEvent union
//   ralph_verdict_warning, ralph_predicate_disagree, ralph_burned_targets_modified,
//   ralph_stale_verdict_unlinked, ralph_iteration_cost_warning,
//   ralph_target_burned, ralph_target_unburned
```

## PR split

**PR1: Additive scaffold (~220 lines).**

| File | Diff | What |
|---|---|---|
| `src/core/ralph-iteration-verdict.ts` | +110 (new) | Schema, reader (lstat + size cap + O_NOFOLLOW + iteration validation), writer (engine pre-launch unlink). |
| `src/core/ralph-iteration-log.ts` | ~25 | Add 3 new exit reasons to `EXIT_REASONS`; extract `verdict` field in `parseIterationRecord`; round-trip tests. |
| `src/core/tasks.ts` | ~40 | `RalphStallConfig` + nested types; `BurnedOutTarget`; counter fields. |
| `src/core/interaction-log.ts` | ~30 | New event variants + serialization. |
| `src/server/ralph-loop-service.ts` | ~25 | Extend `validateRalphLoopRequest` (loopShape, thresholds, declaredTargets, iterationCostCapUsd). Drop the v3 shared-cwd 409 refusal — per-task verdict path makes it safe. |
| `src/server/routes/task-routes.ts` | +50 | New `GET /ralph-loop` route; new `PATCH /ralph-loop/burned-targets` route with audit-log event on every mutation. |
| `src/shared/contracts/ralph.ts` | ~40 | Type exports. |
| Adapter env contract test | ~15 | Per-adapter test that `extraEnv` reaches process. |

**PR2: Cycler integration + dashboard + playbook adoption (~360 lines).** Lands after PR1 + redesign RFC.

| File | Diff | What |
|---|---|---|
| `src/core/ralph-cycler.ts` | ~110 | Decision matrix: verdict.complete × predicate, verdict.stalled, stallPredicate, all-burned check, cost-cap-consecutive check. Verdict comes in via options. |
| `src/core/ralph-iteration-template.ts` | +40 (new) | Pure renderer with marker-presence opt-in. |
| `src/server/ralph-loop-service.ts` | ~70 | Pre-launch unlink on every `currentIteration`-bump path; read-then-unlink on Stop with full warning emission; pass parsed verdict to cycler; render template before launch; inject `extraEnv: { RALPH_VERDICT_FILE }`. |
| `src/server/launch-service.ts` | ~10 | Plumb `extraEnv` from caller into `AdapterLaunchOptions`. |
| `src/adapters/agent-adapter.ts` | ~5 | Add `extraEnv?: Record<string, string>` to `AdapterLaunchOptions`. |
| `src/adapters/claude-code-adapter.ts` | ~10 | Merge `extraEnv` in `buildAgentLaunchContext`. |
| `src/adapters/codex-cli-adapter.ts` | ~10 | Same. |
| `src/frontend/components/RalphLoopPanel.tsx` | ~50 | Burned-targets row + Clear button + verdict-warning badge + effective stallConfig row. |
| `.kookr/playbooks/implement-github-issue.md` | ~50 | Verdict reporting at end of each phase; `{{ralph.burnedOutTargets}}` in Phase 0d's exclusion check. Keep `.batch-attempted` for one release. |
| `.kookr/playbooks/ralph-loop.md` | ~30 | Document verdict + template variables + `RALPH_VERDICT_FILE` + `stallPredicate`. |
| Tests | ~150 | Cycler tests; template tests; canonicalization tests; verdict-file contract tests; pre-launch-unlink path enumeration; predicate × verdict matrix; all-burned termination; iteration-cost-cap consecutive; decay test. |

**PR3** (concrete gate, no schedule): remove `.batch-attempted` from playbook after 14 days of <1% verdict warning rate.

## Recovery contract

Every code path that bumps `loop.currentIteration` MUST run pre-launch unlink. PR2 includes a unit test enumerating each path:

| Path | File | Bumps iteration? | Unlinks? |
|---|---|---|---|
| Continuing iteration | `launchFreshRuntime` | Yes | Yes |
| Resume after pause | `resumeLoop` → `catchUpFromLatestStop` → `launchFreshRuntime` | Yes (via continuing) | Yes |
| Crash recovery | `reconcileStartupLoops` | Per-loop policy | Yes if relaunching; emits `ralph_stale_verdict_unlinked` if a stale file existed |

## Edge cases

(Same as v3 plus:)
- **Two ralph loops in same cwd.** Per-task verdict file naming makes them independent. No 409 at attach.
- **All declared multi-target targets burned.** Engine terminates `all_targets_stalled`. Without `declaredTargets` in config, multi-target loops have no all-burned signal — same behavior as v3, but documented as "operator must declare targets to get the safety net."
- **Iteration cost over cap, then under cap, then over again.** Two non-consecutive over-cap hits do NOT terminate; the consecutive counter resets. Same semantics as `consecutiveStallsPerTarget`.
- **`stallPredicate` exit 0 + verdict.stalled with target X.** Verdict wins (richer attribution). The predicate is a fallback for when the verdict file is absent.
- **`stallPredicate` exit 0 + no verdict file.** Engine records single-target stall (no target field).
- **`progress` un-burns a target that was decayed-and-already-removed.** No-op; idempotent.
- **`PATCH burned-targets` with empty body.** No-op; returns 200; no interaction-log event.

## Open questions

- **Q1 (resolved):** Decay knob added (§11).
- **Q2:** Verdict file path configurable? Still no — fixed default with per-task suffix.
- **Q3 (resolved):** Dashboard panel ships in PR2 (§9).
- **Q4 (defer):** Default `loopShape: 'single-target'` correctness — re-evaluate after one month of production data. Could collect telemetry from `ralph_target_burned` events.
- **Q5 (defer):** Iteration-mismatch warning rate caps. Per-task dedup ships in PR2; if logs become noisy, add a sample rate.
- **Q6 (new):** Should `ralph_predicate_disagree` events have a count threshold before terminating? Currently they only continue + warn. If the predicate keeps disagreeing for many iterations, the loop spins. Could add `consecutivePredicateDisagreementsBeforeTermination` knob — defer.

## Critic feedback incorporated

**Round 1** (3 critics): `design-minimalist`, `failure-mode-analyst`, `socratic-challenger`.
**Round 2** (3 critics): `boundary-critic`, `delivery-pragmatist`, `failure-mode-analyst` follow-up.
**Round 3** (2 critics): `operability-reviewer`, `ambition-amplifier`.

**v1 → v2** (10 cuts, 8 hardenings): cache file, `{{#if}}`, `stallPredicate`, `skip-target`, `iterationCostCapUsd`, helper binary, two exit reasons, ring buffer, dashboard, plus workdir-pin, iteration-tag, canonicalization, fail-safe shape default, predicate-wins, fs.stat, progress-reset.

**v2 → v3** (verdict parsing moved to service; per-target counter collapsed; env-injection traced; EXIT_REASONS update first; PR split; templating opt-in; default `loopShape: 'single-target'`; shared-cwd refusal; predicate × error/timeout matrix; un-burn semantics; lstat + O_NOFOLLOW; per-task tmp pinning; pre-launch unlink contract enumeration; PATCH burned-targets route).

**v3 → v4 changes** (this revision):

*Scope-restoration items the user explicitly asked for (`ambition-amplifier`):*
- **Restore `iterationCostCapUsd`** — but decoupled from stall machinery. Own counter, own threshold, own exit reason `iteration_cost_cap`, own interaction-log event. The v1 false-positive (multi-target loops mis-terminated) was about coupling cost overage to target attribution; decoupled, it's a clean budget signal (Finding 1).
- **Restore `stallPredicate`** — engine-only stall channel for legacy/uncooperative agents. Reuses `runStopPredicate` infrastructure. Verdict file beats predicate when both fire (Finding 2).
- **Restore `all_targets_stalled` exit reason** — multi-target loops with `declaredTargets` config now have an all-burned safety net. Without this, the multi-target case re-creates the original failure mode at the all-burned boundary (Finding 4).
- **Per-task verdict file naming** — drops the v3 shared-cwd 409 refusal at zero cost. `ambition-amplifier` Finding 5.
- **Dashboard panel ships in PR2** — ~50 lines in the existing `RalphLoopPanel.tsx`. Operator who lives in the dashboard gets visibility on day one. Finding 5 / Finding 4.
- **`consecutiveStallCount` field name now matches semantic** — explicit reset rule (Finding 7).
- **PR3 has a concrete merge gate** — 14-day window of <1% verdict warning rate (Finding 8).
- **Decay knob added** — `burnedTargetDecayIterations` for transient-blocker recovery (Finding 3).

*Operability items (`operability-reviewer`):*
- **`verdictWarningCount` + `lastVerdictWarningReason` on RalphLoopState** — durable counter visible via API and dashboard badge (HIGH 1).
- **Interaction-log events** for verdict warnings, predicate disagreement, burned-targets PATCH audit, stale-verdict-unlinked, iteration cost warning, target burn / unburn (HIGH 2 + MEDIUM 6 + 7).
- **`parseIterationRecord` extracts `verdict` field** — closes the contract gap that would have left verdict payloads invisible to API readers (MEDIUM 5).
- **Effective `stallConfig` exposed in API** — defaults merged so operator sees actual values (MEDIUM 4).
- **New `GET /ralph-loop` route** for state-only inspection (LOW 8).
- **`ralph_target_burned` and `ralph_target_unburned` events** — operator can trace why a target is burned and when it was unburned.

**Empirical validation across rounds:**
- Live task inspection confirmed production failure mode (issue 154 attempted twice).
- Verified `EXIT_REASONS` is a hard allowlist; PR1 update is mandatory.
- Verified `parseIterationRecord` ignores unknown fields; PR1 must extract `verdict`.
- Verified `RalphLoopPanel.tsx` is 256 lines; ~50-line addition is realistic.
- Verified `runStopPredicate` is reusable for `stallPredicate`.
- Verified two adapters exist (`claude-code-adapter.ts`, `codex-cli-adapter.ts`) for env-propagation contract tests.
