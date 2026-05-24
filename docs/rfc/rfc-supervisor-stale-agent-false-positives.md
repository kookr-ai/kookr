# RFC: Eliminate watchdog `stale_agent` false positives during background subagent work and streaming-only LLM turns

**Status:** Draft v2
**Date:** 2026-05-24
**Author:** Jean Ibarz (with Claude)

---

## Problem

The dashboard is showing `stale_agent` findings on parent agents that are actually alive — typically while the agent is waiting on a background subagent or in the middle of a long streaming LLM message with no tool calls. This erodes trust in the supervisor, which is the product.

`rfc-subagent-aware-needs-input.md` shipped suppression of `needs_input` during background subagent work, but only on the event-derived path. The same suppression was not extended to the watchdog tick path, which is the second source of `stale_agent` and `hook_disconnected`. The bug we believed was closed for `needs_input` was open for the two watchdog-only types.

## Empirical Checkpoint (origin/main at draft time, sha `ead9c86a`)

- `Monitor.processEvents` runs `suppressIfSubagentsRunning(rawAnomaly, agentId)` before enqueueing — `src/core/monitor.ts:175`.
- `Monitor.applyWatchdogVerdict` enqueued the watchdog anomaly **directly**, with no subagent check — `src/core/monitor.ts:243–266`.
- `Watchdog.tick` mints `stale_agent` after `staleThresholdMs` (30s) when `paneChanged=false`, `toolInProgress=false`, and `timeSinceTokenActivity ≥ 60s` — `src/core/watchdog.ts:354–363`.
- `Watchdog.tick` mints `hook_disconnected` after `unconditionalStaleThresholdMs` (60s) when `paneChanged=true` and silence persists — `src/core/watchdog.ts:329–339`.
- `Watchdog.recordTokenActivity` was only called when `tokenTracker` observed a finalized `usage` block (every 5s scan; the value only changes when a message *ends*) — `src/server/lifecycle-timers.ts:198–203`.
- Subagent tracking exists and is maintained by `processEvents` via `subagent_start` / `subagent_stop` events — `src/core/monitor.ts:436–443`.
- Subagent eviction TTL is bounded by `SUBAGENT_TTL_MS` (30 min) at `src/core/monitor.ts:101`.
- Existing non-actionable purge path uses a triple-guard (queued + watchdog-owned type + no event anomaly) — `src/core/monitor.ts:280–286`.

Corroborating signals (local install, `~/.kookr/`):

- `coordinator-suppressions.json` shows 7+ user dismissals of supervisor coordinator findings in the past 4 days across both `claude-code` and `codex-cli` agent types.
- `shadow-detection.jsonl` (3.2M heartbeats) confirms the `process_liveness` shadow strategy is degenerate on dtach installs (separate problem — tracked as follow-up).

## Goals

1. Close the watchdog false-positive class (`stale_agent`, `hook_disconnected`) for parent agents waiting on a background subagent.
2. Reduce false positives during long streaming-only LLM turns by counting transcript file growth as freshness — not just finalized usage.
3. Keep the watchdog deterministic and event-shaped — no LLM in the hot path, no probabilistic suppression.
4. Make the fix observable: every suppression decision is recorded in the existing `FindingEvidenceAuditor` so M3/M4 can later measure whether the FP rate dropped.

## Non-Goals

- Do **not** rework the shadow detector pipeline (`process_liveness` brokenness on dtach) — that is a separate RFC.
- Do **not** introduce dismissal-rate-driven auto-suppression. That is a Phase 2 idea and would dilute this RFC.
- Do **not** modify the `permission_blocked` path — a parent agent blocked on permission is genuinely blocked regardless of subagent state.
- Do **not** change the 30s / 60s thresholds. Threshold tuning is a separate, data-driven exercise.

## Requirements

- `R1` — Watchdog-derived `stale_agent` and `hook_disconnected` findings SHALL be suppressed when the parent agent has one or more outstanding background subagents. `permission_blocked` SHALL NOT be suppressed.
- `R2` — Suppression SHALL be cleared automatically when the last outstanding subagent emits `subagent_stop` (or its entry expires via existing `SUBAGENT_TTL_MS` eviction). The bounded TTL caps worst-case missed-detection at ~30 min.
- `R3` — Watchdog `tick` SHALL treat transcript file byte-growth in the last `tokenActivityThresholdMs` as a freshness signal equivalent to a finalized `usage` block update.
- `R4` — Suppression decisions SHALL be observable: every suppressed verdict SHALL produce one `FindingEvidenceAuditor` record marked `verdict: 'possible_false_positive'` with a `notes` entry naming the reason (`subagent_running`).
- `R5` — The `applyWatchdogVerdict` contract SHALL remain a single decision point:
  - No caller of `attentionQueue.enqueue` for watchdog-typed anomalies may bypass the suppressor.
  - A suppressed verdict MAY purge a queued anomaly only if that entry is a watchdog-owned type AND no shadowing event-derived anomaly exists. (Mirrors the existing non-actionable purge guard.)

## Design

### Phase 1.A — Route watchdog verdict through the suppressor, with tightened purge guards

`Monitor.applyWatchdogVerdict` actionable branch now:

1. Calls `suppressIfSubagentsRunning(rawAnomaly, agentId)`.
2. On `null` return: records suppression telemetry, conditionally purges a queued *watchdog-owned* anomaly only when no shadowing event-derived anomaly exists, and emits one `FindingEvidenceAuditor` resolve record with `suppressionReason: 'subagent_running'`.
3. On non-null return: existing path unchanged.

`suppressIfSubagentsRunning` widens its eligible-types set to `{needs_input, stale_agent, hook_disconnected}`. `permission_blocked` is deliberately excluded (R1).

### Phase 1.B — Transcript-growth freshness signal

`TokenTracker.scanGrowth()` returns the set of registered transcripts whose on-disk byte size exceeds the last `scanOne` offset. Implementation reuses the existing `state.offset` (no second `lastSize` field). Cost: one `fs.stat` per registered transcript per 5s tick.

Wired in `lifecycle-timers.ts`'s token-scan tick *before* `scanAll` (so byte-delta is observable before parsing consumes it). For each growth, `watchdog.recordTokenActivity` is called on non-completed/non-aborted sessions of the owning task.

### Phase 1.C — Observability hook (R4)

`FindingEvidenceAuditor.observe` accepts an optional `suppressionReason: 'subagent_running'` field, forwarded to `resolve()`. When set, the resolved record is marked `verdict: 'possible_false_positive'` and its `notes` carry `Finding suppressed: subagent_running.`. Surfaced via the existing `/api/finding-evidence-audit` endpoint with no contract change.

## Test Plan

### Unit (deterministic, no flakes)

`src/core/monitor.test.ts` — new `applyWatchdogVerdict > subagent-aware suppression` describe block:

- `stale_agent` + outstanding subagent → suppressed; `getDetectionStats().suppressed.stale_agent` ≥ 1; resolved record tagged `possible_false_positive` with `subagent_running` note.
- `hook_disconnected` + outstanding subagent → suppressed; suppression counter incremented.
- `permission_blocked` + outstanding subagent → **not** suppressed; queue enqueued. (Anti-regression for R1.)
- `stale_agent` + outstanding subagent + previously-queued `merge_conflict` → suppressed; `merge_conflict` retained. (Anti-regression for R5.)
- `stale_agent` + outstanding subagent + previously-queued `stale_agent` → suppressed; queue purged.
- After `subagent_stop`, the next `stale_agent` verdict enqueues normally.
- After `SUBAGENT_TTL_MS` eviction (fake timers advance 30+ min), `stale_agent` enqueues normally.

`src/core/token-tracker.test.ts` — new `scanGrowth` describe block:

- Reports bytes gained after an append (mid-stream growth).
- Empty when no transcripts grew.
- Skips missing transcript files.
- Skips files that shrank below the prior offset (rotation).

### Integration

Skipped at the E2E layer: the watchdog tick is a server-internal 5s timer with no test injection surface, so an E2E for this regression would either need a 30+ s wall-clock wait (flaky) or a new test endpoint (scope creep). The unit tests above exercise the same seam (`applyWatchdogVerdict`) where the regression lives.

### Calibration measurement (post-merge, not a gate)

- Re-aggregate `~/.kookr/shadow-detection.jsonl` 14 days post-merge against `findingEvidenceAuditor` records.
- Target: ≥80% reduction in audited `stale_agent` records that resolve without user action.
- Seed list from `coordinator-suppressions.json` (manual dismissals are the cheapest FP proxy we already have).

## Risks

1. **Wider `SUPPRESSIBLE` could mask a genuinely hung parent that happens to have a stale subagent entry.** Mitigated by `SUBAGENT_TTL_MS` (30 min) and tested by the eviction unit case.
2. **`hook_disconnected` suppression during long-running subagents (>30 min) delays genuine hook-pipeline breakage detection by up to one TTL window.** Accepted price — real hook-pipeline failures are low base rate; FP cost dominates trust.
3. **Transcript-growth signal could fire on unrelated file activity.** Risk low — transcript path is session-owned, only Claude Code writes to it. `unconditionalStaleThresholdMs` (60s) override remains in place upstream.
4. **Phase 1.B order-of-operations**: `scanGrowth` must run **before** `scanAll` on the same tick. Enforced by call ordering inside the same setInterval body.

## Rollout

- Single PR, single feature branch `feat/supervisor-stale-fp-subagent-suppression`.
- No feature flag — this is a correctness fix in a path that produces user-visible noise. Default-on at merge.
- Calibration measurement scheduled for 14 days post-merge.
