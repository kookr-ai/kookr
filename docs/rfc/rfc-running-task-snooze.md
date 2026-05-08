# RFC: Snooze Running Tasks

**Status:** Draft (v4 — post final critic convergence)
**Date:** 2026-05-08
**Author:** Jean Ibarz (with Codex)

---

## Problem

Kookr can currently snooze an agent only after it has become a supervisor finding. That is too narrow for the dashboard's attention-routing model.

The user-facing need is broader:

> "It is only possible to snooze tasks that are in supervisor findings, but we should also be able to snooze running tasks."

In practice, snooze means "do not route my attention to this task for a while." A healthy running task can still be something the user wants to hide temporarily: a long-running implementation, a known background loop, or a task the user checked and intentionally wants out of sight until later.

The current implementation is close:

- `ClientMessage` already has `{ type: 'snooze'; agentId; durationMs; reason? }`.
- `AgentState` already exposes `snoozedUntil`.
- The frontend already separates `snoozed` from `findings` and `healthy` using `snoozedUntil`.
- Existing snoozes are task-keyed when `AttentionQueue` can resolve the session to a task.

The blocker is conceptual and mechanical: `AttentionQueue.snooze()` refuses to store a snooze unless it can attach an `Anomaly`, so snoozing a healthy running task is currently a no-op at the durable attention-state layer.

## Empirical Checkpoint

Round-1 critics raised several load-bearing claims. A design-experimenter checked them against the current code and ran:

```bash
pnpm exec vitest run src/core/attention-queue.test.ts src/core/task-persistence.test.ts
```

The probe passed the existing tests and confirmed:

- `AttentionQueue.enqueue()` reads `this.snoozed.get(key)` before pruning expired snoozes. An expired snooze can still suppress a later enqueue until some other read path calls `restoreExpiredSnoozes()`.
- `completeTask`, `cancelTask`, and termination paths do not currently clear task-keyed snoozes. `deleteTask` can purge when the caller passes `queue`, but the WebSocket delete path appears to omit that dependency.
- `App.tsx` computes `completed` and `snoozed` independently, so a terminal task with `snoozedUntil` can appear in both sections.
- `PersistedSnooze.anomaly` is required today; deserialization uses it for deleted-task logging, fallback agent id, and rebuilding the queue anomaly.

Those findings shape the design: expiry must be authoritative, terminal transitions must purge task-keyed snoozes, display buckets must be exclusive, and optional persisted anomaly handling must be explicit.

## Requirements

- A user SHALL be able to snooze an active running task even when it has no anomaly.
- Running-task snooze SHALL require a real task identity. Session-local no-anomaly snoozes are rejected rather than silently becoming non-durable agent-keyed state.
- Snoozing a running task SHALL hide it from Healthy and place it in Snoozed.
- If a snoozed task later emits a finding before the snooze expires, the finding SHALL remain out of active Findings until the snooze expires or the user resumes the task.
- When the snooze expires:
  - if the task is still healthy, it SHALL return to Healthy;
  - if the task has a stored hidden anomaly, it SHALL surface on the current live session when possible;
  - if the task completed, was cancelled, was terminated, or was deleted, no stale snoozed row SHALL remain.
- Snoozes SHALL remain task-keyed for task-backed rows, so they survive session rotation and crash recovery.
- This feature SHALL NOT introduce a new `TaskStatus`. Snooze is an attention-routing state, not lifecycle.
- Existing snoozed findings persisted in the task file SHALL continue to load.
- V1 SHALL include the escape hatch: a visible Resume now action for user snoozes.
- V1 SHALL broadcast a state update when a snooze expires, even if no agent emits new output at that moment.

## Non-Goals

- Do not pause or stop the agent process. Snooze only changes dashboard attention routing.
- Do not add a second user mode such as "background until blocked." V1 is "hide until duration or resume now."
- Do not change anomaly detection thresholds.
- Do not change auto-suppression thresholds.
- Do not add schedule-like resume actions beyond the existing expiration timestamp.
- Do not add cross-device or cloud persistence.

## State Matrix

The server and frontend should agree on snooze eligibility and display.

| Task/agent state | Can user snooze? | Display bucket |
|---|---:|---|
| `open`, no anomaly, task id known and live session exists | Yes | Healthy -> Snoozed |
| `open`, anomaly, task id known and live session exists | Yes | Findings -> Snoozed |
| `open`, no live session | No | Healthy/open task display |
| `inProgress`, no anomaly, task id known | Yes | Healthy -> Snoozed |
| `inProgress`, anomaly, task id known | Yes | Findings -> Snoozed |
| `inProgress`, no anomaly, no task id | No | Healthy |
| `inProgress`, anomaly, no task id | No for new user snoozes; legacy/import only | Findings |
| unknown `taskStatus`, anomaly, no task id | No for new user snoozes; legacy/import only | Existing behavior |
| `pending` | No | Pending |
| `completed` | No | Completed |
| `cancelled` | No | Completed |
| `terminated` | No | Completed |
| auto-suppressed liveness state | No normal snooze; separate Resume monitoring behavior | Snoozed/Paused copy |

Frontend section classification SHALL be a partition with this priority:

```text
pending -> terminal/completed -> snoozed_or_suppressed -> active_finding -> healthy
```

This replaces independent filters that allow overlap.

## Design

### 1. Keep Snooze in Core, but Make the State Explicit

Keep the storage in `AttentionQueue` for v1 because it already owns:

- active finding suppression while snoozed;
- task-keyed snooze resolution;
- `getSnoozedUntil()` for snapshots;
- persistence through `serializeSnoozed()`.

Do not add a separate task-store field in this PR.

However, stop relying on "missing anomaly" as the only semantic marker. Change the internal entry shape to carry explicit kind:

```ts
type SnoozeKind = 'finding' | 'task';

interface SnoozeEntry {
  agentId: string;
  key: string;          // taskId for task-backed snoozes; agentId only for legacy/orphan finding snoozes
  kind: SnoozeKind;
  anomaly?: Anomaly;    // present for finding snoozes; may be filled later if a hidden finding appears
  expiresAt: number;
  createdAt: number;
  reason?: string;
}
```

Auto-suppression remains in `SnoozeSuppressionTracker`; it is not stored as a `SnoozeEntry` in this PR.

### 2. Require Task Identity for No-Anomaly Snooze

Current `AttentionQueue` falls back to agent-keyed snoozes when `taskIdFor(agentId)` returns null. V1 should reject new user-visible snoozes that cannot resolve to a task. Agent-keyed snoozes remain only for legacy import/tests and internal compatibility until those paths are removed.

For no-anomaly task snoozes:

- server resolves `taskStore.findTaskBySession(agentId)` before mutating queue;
- task must exist and be `open` or `inProgress`;
- a current live session must resolve to that task;
- duration must be a finite integer in an allowed range;
- if any check fails, do not store a snooze.

The client should include `taskId` on the `snooze` message when it has one:

```ts
| { type: 'snooze'; agentId: string; taskId?: string; durationMs: number; reason?: string; resumeMonitoring?: boolean }
```

`taskId` is a guard against session-rotation races, not a source of trust. The server still verifies that the session belongs to that task.

If `taskId` is present, the server accepts the snooze only when the provided `agentId` is still a current live session for that task. Do not accept "recently belonged" matches in V1. A stale row should fail closed and remain unchanged until the next snapshot gives the frontend the current session.

Allowed durations for V1 are exactly the existing `SnoozeDialog` presets. The server validates that `durationMs` is one of those preset values. Custom duration support can add a min/max later.

### 3. Return a Typed Result from Queue Operations

A boolean is too weak once snoozes can be finding-backed or task-backed.

```ts
type SnoozeResult =
  | { ok: true; entry: SnoozeEntry; taskId: string }
  | { ok: false; reason: 'invalid_duration' | 'unresolved_task' | 'not_snoozable' };

type CancelSnoozeResult =
  | {
      cancelled: true;
      entry: SnoozeEntry;
      restoredActive: boolean;
      restoredAgentId?: string;
      restoredAnomaly?: Anomaly;
    }
  | { cancelled: false };
```

`cancelSnooze()` must not create an active queue entry for a no-anomaly task snooze. If a task snooze contains a hidden anomaly, Resume now follows the same live-session restoration rule as expiry and returns `restoredActive: true`.

### 4. Make Expiry Authoritative

Expired snoozes must not remain in the map and keep suppressing future anomalies.

Add queue APIs that separate pure state popping from server reconciliation:

```ts
expireDue(now: number): SnoozeEntry[]
dropExpiredForAgent(agentId: string, now: number): void
```

Rules:

- `expireDue(now)` removes all expired snoozes and returns their entries.
- `dropExpiredForAgent(agentId, now)` removes an expired snooze for the resolved key only when that snooze has no hidden anomaly.
- `enqueue()` SHALL call `dropExpiredForAgent()` before checking for a live snooze entry.
- `getSnoozedUntil()`, `peek()`, `getAnomaly()`, `getSnoozed()`, and `cancelSnooze()` SHALL not treat expired entries as live.

Regression requirement: an expired no-anomaly snooze followed by a new anomaly enqueue SHALL produce an active queue entry immediately.

Merge order requirement:

- If an expired snooze has no hidden anomaly, `enqueue()` drops it and enqueues the new anomaly normally.
- If an expired snooze has a hidden anomaly, `enqueue()` leaves the expired entry for the server expiry driver and enqueues the new anomaly normally. The new post-expiry anomaly must not be suppressed merely because a pending restoration still exists.

The server owns timed expiry side effects. It keeps a small "next snooze expiry" timer, reschedules it on snooze/cancel/import, calls `expireDue(Date.now())`, reconciles hidden anomalies to live sessions, and broadcasts a fresh snapshot. This prevents the UI from remaining snoozed past expiry when no new agent output arrives. V1 does not log explicit snooze-ended events; that avoids duplicate/missed logging while expiry can be triggered by both timers and queue reads.

### 5. Hidden Findings During Snooze

There are two competing instincts:

- Design-minimalist: no-anomaly snooze should be a pure suppression marker; do not turn it into a second anomaly buffer.
- Failure/state critics: if a finding appears during snooze and the detector is one-shot or event-derived, relying on later re-detection can permanently lose it.

This RFC chooses the safer state-machine behavior: if an anomaly arrives while a task is snoozed, store it as `anomaly` on the snooze entry and keep it out of active Findings until expiry or Resume now.

To avoid ghost session ids, task-keyed expiry SHALL restore the stored anomaly onto a current live session for that task, not the old `agentId`.

`AttentionQueue` should not decide which session is current. Expiry returns the snooze entry to the server/monitor layer, and that layer resolves the task's current live session.

If no live session exists when an anomaly-backed task snooze expires:

- if the task is terminal/deleted, end the snooze and do not restore a finding;
- if the task is still `open` or `inProgress` but temporarily has no live session during startup/reconciliation/session rotation, keep a pending restoration record keyed by task id until reconciliation completes or the task becomes terminal.

Pending restoration must be durable and idempotent. Keep the anomaly-backed snooze in persisted `snoozes` with `expiredPendingRestore: true` until the hidden anomaly is restored to a current live session or the task is terminal/deleted. Startup recovery should replay these pending restorations instead of dropping them as ordinary expired snoozes.

Hidden anomaly merge rule: latest anomaly replaces the prior hidden anomaly, preserving original `detectedAt` only when the anomaly type is unchanged. This matches the current queue behavior for active entries.

### 6. Persistence Format

Write a new neutral field and read the legacy field:

```ts
interface TaskFileEnvelope {
  version: 2;
  lifetimeSpendUsd: number;
  tasks: Task[];
  snoozes?: PersistedSnooze[];
  snoozedFindings?: LegacyPersistedSnooze[]; // legacy read only
  suppressionState?: PersistedSuppressionEntry[];
}

interface LegacyPersistedSnooze {
  taskId: string;
  anomaly: PersistedAnomaly;
  expiresAt: number;
  reason?: string;
}

interface PersistedSnooze {
  taskId: string;
  agentId?: string;       // best-known session at snooze time
  kind: 'finding' | 'task';
  anomaly?: PersistedAnomaly;
  expiresAt: number;
  createdAt: number;
  expiredPendingRestore?: boolean;
  reason?: string;
}
```

Read behavior:

- Load `snoozes` if present.
- Also load legacy `snoozedFindings` by mapping each entry to `kind: 'finding'`. `createdAt` is not available for legacy rows, so use `Date.now()` only for in-memory metadata. Do not rewrite legacy shape except through the next normal save.
- For no-anomaly persisted snoozes, restore by task id when task exists and is `open` or `inProgress`, even if session reconciliation has not yet attached a current live session.
- Drop expired, terminal, or deleted no-anomaly snoozes with a warning.
- For anomaly-backed snoozes, keep existing best-known-session fallback, but guard every `entry.anomaly` read.
- For anomaly-backed expired snoozes with `expiredPendingRestore: true`, keep and retry restoration until a current live session appears or the task becomes terminal/deleted.

`task-persistence.ts` should parse and serialize shapes only. Restore/drop/reconcile policy belongs in startup recovery or a dedicated restore-snoozes use case that has access to `TaskStore`, queue import APIs, and session reconciliation state.

Write behavior:

- Write only `snoozes`.
- Do not write new no-anomaly snoozes under `snoozedFindings`.

### 7. Terminal and Delete Cleanup

Task-keyed snoozes must end when the task lifecycle ends.

On terminal transitions:

- complete
- cancel
- terminate
- acknowledge terminated as completed if it routes through a terminal cleanup path
- delete
- clear completed

call `queue.purgeTask(taskId)` or ensure `serializeSnoozed()` drops terminal-task snoozes before writing.

Preferred v1: do both where practical.

- Runtime cleanup in lifecycle handlers prevents stale UI and reopen leakage.
- Serialization guard prevents stale persisted state if a path is missed.

The empirical checkpoint found that REST delete can purge when passed `queue`, but the WebSocket delete path likely omits `queue` through `getLifecycleDeps()`. This should be fixed in the same PR.

### 8. Server Handling Boundary

No-anomaly snooze is not anomaly triage. The current handler can still route the message in v1, but the behavior should move into a neutral use case to prevent finding-specific side effects from spreading:

`src/server/use-cases/snooze-attention.ts`

Responsibilities:

- validate duration;
- resolve and validate task/session identity;
- read current anomaly from queue/monitor;
- call queue;
- return a discriminated result for logging and UI side effects.

`AnomalyHandler` can call this use case for the existing `snooze` message and then perform only finding-specific side effects when the result is `kind: 'finding'`.

### 9. Acknowledgement, Logging, Telemetry, and Achievements

#### Client state updates

Because the server can reject stale or invalid task snoozes, the frontend must not permanently hide a row based only on send success.

V1 should not add a new `snoozeResult` server message. On successful snooze, cancel, or expiry, the server broadcasts the normal authoritative snapshot. On rejection, state remains unchanged; the UI may show a lightweight alert/toast if needed.

The frontend should not optimistically hide Healthy-row snoozes or Resume-now actions in V1. It should wait for the next authoritative snapshot.

`cancelSnooze` should accept `taskId?: string` so Resume now is task-keyed and survives session rotation:

```ts
| { type: 'cancelSnooze'; agentId: string; taskId?: string }
```

#### Interaction log

V1 should not rename the telemetry/reporting surface. That is analytics churn, not required for the behavior fix.

Keep the existing `finding_snoozed` and `finding_resolved` behavior for anomaly-backed snoozes. For no-anomaly task snoozes, do not append `finding_snoozed` and do not append `finding_resolved`.

Do not add `snooze_started`, `snooze_ended`, `SnoozeEffect`, achievement-copy changes, or broad report/friction migrations in V1. Generic task-snooze telemetry can be designed after the core state transition is stable.

Audit these consumers before adding generic telemetry/reporting changes:

- `src/core/friction-analyzer.ts`
- `src/core/interaction-log.ts`
- `src/core/telemetry.ts`
- `src/core/telemetry-report.ts`
- `src/server/ws-connection-handler.ts`
- `src/shared/contracts/client-message-schema.ts`

Achievement behavior can remain finding-snooze-only in V1. Success-based task-snooze achievements are a follow-up, not part of the requested behavior.

### 10. Frontend Controls

#### Healthy Row

Add a small `Snooze` button to `HealthyRow` near `Reply`.

Behavior:

- Stop propagation like `Reply`.
- Open the existing `SnoozeDialog`.
- On selection, send `{ type: 'snooze', agentId, taskId, durationMs }`.
- Wait for the authoritative server snapshot before hiding the row.

The row should not gain Skip or Flag FP.

#### Detail Panel

Defer direct-reply DetailPanel Snooze from V1. It is useful, but Healthy-row Snooze plus Snoozed-row Resume covers the requested behavior with less layout churn. DetailPanel Snooze should use the same `canSnoozeTask(agent)` predicate when added.

#### Snoozed Row

Add `Resume now` for manual snoozes.

- For user snoozes, send `{ type: 'cancelSnooze', agentId }`.
- Include `taskId` when present: `{ type: 'cancelSnooze', agentId, taskId }`.
- Wait for the authoritative server snapshot before moving the row.
- For auto-suppressed rows, do not show the same button unless it is wired to the existing resume-monitoring behavior and labeled distinctly.

Hidden-finding indicators are deferred from V1, but the model should expose enough state later to render them. If V1 restores hidden findings only at expiry/resume, the row can stay visually simple.

### 11. Frontend Classification

Add one pure display classifier for V1:

- `classifyAgentDisplay(agent): { bucket: 'pending' | 'completed' | 'snoozed' | 'finding' | 'healthy'; mode?: 'manual_snooze' | 'auto_suppressed' }`
- `isActiveFinding(agent)`
- `isHealthyRunning(agent)`
- `isSnoozedAttentionItem(agent)`
- `canSnoozeTask(agent)`

Use the classifier in `App.tsx` for the main section partition in V1. Migrate triage navigation and project sidebar fallback only if tests show they need the same fix in this PR; otherwise handle them in a cleanup.

This prevents the immediate completed/snoozed overlap while keeping the first implementation smaller.

## Files to Change

Core:

- `src/core/attention-queue.ts`
- `src/core/attention-queue.test.ts`
- `src/core/task-persistence.ts`
- `src/core/task-persistence.test.ts`
- `src/core/types.ts`

Server:

- `src/server/use-cases/snooze-attention.ts`
- `src/server/ws-handlers/anomaly-handler.ts`
- server-side snooze expiry timer near lifecycle/background services
- `src/server/agent-lifecycle.ts` or lifecycle handlers that own terminal transitions
- `src/server/use-cases/delete-task.ts`
- `src/server/ws.ts` / lifecycle deps if needed so WebSocket delete can purge task snoozes
- `src/server/ws.test.ts`
- `src/server/startup-recovery.ts`

Frontend:

- `src/frontend/App.tsx`
- `src/frontend/components/FindingsPanel.tsx`
- `src/frontend/store/finding-helpers.ts`
- `src/frontend/store/useStore.test.ts`
- `src/shared/contracts/messages.ts`
- `src/shared/contracts/client-message-schema.ts`
- one E2E or integration test for the UI happy path

Optional docs:

- `docs/features.md` if snooze is described as findings-only.

## Edge Cases

### Healthy task snoozed, then anomaly appears

`enqueue()` sees a live snooze entry, stores the anomaly on that entry, and does not add an active finding. V1 does not need to render a hidden-finding indicator, but the stored state preserves the finding for expiry/resume.

### Healthy task snoozed, then anomaly appears after expiry

`enqueue()` must drop an expired no-anomaly snooze before checking suppression. The anomaly enters the active queue immediately.

### Expired snooze with hidden anomaly, then a new anomaly appears

`enqueue()` must not suppress the new post-expiry anomaly. It leaves the pending hidden anomaly for the server expiry driver and enqueues the new anomaly normally.

### Snoozed task with hidden anomaly expires

If the task is still active and has a live session, restore the hidden anomaly under the current live agent id. If the task is still `open` or `inProgress` but no live session is available during startup/reconciliation/session rotation, keep a durable pending restoration keyed by task id. Drop only when the task is terminal or deleted.

### Open task snooze

An `open` task with a current live session can be snoozed the same way as an `inProgress` task. An `open` task without a live session cannot be snoozed.

### Healthy task snoozed, then completes before expiry

Terminal transition purges the task-keyed snooze. The task appears only in Completed.

### Running task snoozed, then session rotates

The snooze is task-keyed. The next live session inherits `snoozedUntil`. If a hidden anomaly must surface at expiry, use live-session resolution rather than the stale session id.

### Running task snoozed, then deleted

Delete purges the task-keyed snooze on every delete path, including WebSocket delete.

### Suppressed liveness findings

Manual snooze and auto-suppression remain distinct. A healthy task snooze does not call `SnoozeSuppressionTracker.recordSnooze()`. Auto-suppressed rows need separate copy and resume-monitoring behavior.

### Invalid duration

Server rejects non-finite, non-integer, non-positive, or excessive durations. Use the existing preset range as the allowed envelope; if custom durations are later added, define a max before accepting them.

## Alternatives Considered

### Add `TaskStatus = 'snoozed'`

Rejected. A task can be running while snoozed. Lifecycle answers "what is the task doing?" Snooze answers "should the dashboard route attention to it?"

### Store task snoozes in `TaskStore`

Rejected for v1. It makes durability obvious, but splits behavior: findings are suppressed by `AttentionQueue`, while running-task snoozes would live elsewhere. The queue already has the right task-keying and enqueue-suppression behavior.

### Create a new `SnoozeRegistry`

Deferred. Boundary critique correctly notes that `AttentionQueue` is becoming a broader attention-state store. A separate registry may be cleaner long-term, but for v1 it would require wider rewiring of monitor snapshots, persistence, and queue suppression. This RFC keeps state in `AttentionQueue` but makes the semantics explicit with `kind` and typed results.

### Treat healthy snooze as a fake anomaly

Rejected. It pollutes detection metrics and makes a healthy task look like a supervisor finding.

### Do not store hidden anomalies

Rejected. It is simpler, but can lose one-shot or edge-triggered findings that appear during a snooze. Storing a hidden anomaly is more state, but it is the only way to satisfy the requirement that an anomaly present during snooze resurfaces reliably at expiry.

### Keep `snoozedFindings` as the write field

Rejected after boundary review. This PR is where the concept stops being finding-only. Read the old field, write a neutral `snoozes` field.

## Test Plan

### Unit

- `AttentionQueue.snooze()` stores a no-anomaly task snooze only when task identity resolves.
- `AttentionQueue.enqueue()` drops expired no-anomaly snoozes before suppressing.
- Expired no-anomaly snooze followed by enqueue produces an active finding.
- `enqueue()` while live snoozed stores a hidden anomaly and keeps it out of active queue.
- Expired hidden-anomaly snooze does not suppress a new post-expiry anomaly and remains pending for server restoration.
- Expired task-keyed hidden anomaly restores onto the current live session id.
- `cancelSnooze()` on a no-anomaly task snooze returns `kind: 'task'` and does not create an active queue entry.
- `cancelSnooze()` on a task snooze with a hidden anomaly restores under the current live session id.
- `serializeSnoozed()` writes `snoozes` with `kind` and optional `anomaly`.
- `deserializeSnoozed()` reads both `snoozes` and legacy `snoozedFindings`.
- No-anomaly persisted snooze for terminal/deleted task drops with warning; `open`/`inProgress` no-session restore waits for reconciliation.
- Expired pending restoration marker survives restart until restored or terminally dropped.
- Terminal lifecycle transitions purge task-keyed snoozes.
- `classifyAgentDisplayBucket()` table covers `TaskStatus x anomaly x snoozedUntil x suppressed`.

### Server

- Healthy/open running task snooze stores task snooze and does not log finding events.
- Finding snooze keeps existing finding-resolution behavior.
- No-anomaly snooze for pending, terminal, deleted, unknown, or unresolved-task agents is rejected.
- `cancelSnooze` on no-anomaly task snooze does not log `finding_resolved`.
- `cancelSnooze` on task snooze with hidden anomaly restores the finding to the current live session.
- WebSocket delete and REST delete both purge task snoozes.

### Frontend

- Healthy row shows `Reply` and `Snooze`, not `Skip` or `Flag FP`.
- Snoozed row shows `Resume now` for manual snoozes.
- Terminal task with `snoozedUntil` appears only in Completed.

### Integration / E2E

- Launch a task that stays running.
- Assert it appears in Healthy.
- Snooze from Healthy.
- Assert it disappears from Healthy and appears in Snoozed with a countdown.
- Resume now.
- Assert it returns to Healthy.

Add integration-level coverage for the riskier state transitions:

- no-anomaly snooze survives save/load;
- snooze follows a rotated session;
- completed/cancelled/terminated task clears snooze before persistence;
- expired no-anomaly snooze does not suppress a newly enqueued anomaly;
- expired hidden-anomaly pending restoration survives save/load and does not suppress a newly enqueued anomaly.

## Shipping Plan

V1 PR:

1. Core queue supports typed task/finding snoozes, hidden anomaly preservation, and authoritative expiry primitives.
2. Persistence reads legacy `snoozedFindings` and writes neutral `snoozes`.
3. Server validates no-anomaly snooze eligibility, drives expiry with a timer, and broadcasts normal snapshots after successful snooze/cancel/expiry.
4. Terminal/delete paths purge task-keyed snoozes.
5. Frontend exposes Snooze for healthy running tasks and Resume now for manual snoozes.
6. Frontend display classification becomes exclusive in `App.tsx`.
7. Tests cover queue, persistence, server validation, expiry timer behavior, display classification, and one UI happy path.

Deferred follow-ups:

- Direct-reply DetailPanel Snooze.
- Hidden-finding indicators and severity sorting inside the Snoozed section.
- Generic frontend telemetry event renames and friction-analyzer/report migrations.
- Success-based task-snooze achievement updates.
- Broad migration of triage navigation and project-sidebar fallback to the shared classifier if V1 tests do not require it.

## Open Questions

- Should a later feature introduce a separate "Background" action with a wake-on-finding policy? This RFC keeps V1 to duration-based snooze.
- Should a later telemetry migration add generic task-snooze events, and should they replace or wrap the existing finding-specific events?

## Critic Feedback Incorporated

- `design-minimalist` 2026-05-08: incorporated smaller scope pressure where it removed low-value branches, but rejected "do not store hidden anomalies" because failure/state review showed one-shot findings could be lost. Round 2 further reduced V1 by deferring DetailPanel Snooze, hidden-finding indicators, broad analytics migration, and broad selector migration.
- `ambition-amplifier` 2026-05-08: incorporated Resume now in v1, explicit kind metadata, and neutral persistence field. Deferred wake policies and hidden-finding indicators to future work.
- `boundary-critic` 2026-05-08: incorporated neutral snooze use case, typed queue results, task identity requirement for no-anomaly snooze, neutral persistence field, frontend classifier centralization, and event-consumer audit.
- `failure-mode-analyst` 2026-05-08: incorporated expiry-aware enqueue, terminal purge, no-anomaly persistence restore rules, server-side validation, session-rotation guard via `taskId`, logging constraints, and restart/rotation tests.
- `socratic-challenger` 2026-05-08: incorporated explicit state matrix, section precedence, duration validation, achievement deferral, and task-keyed no-orphan rule.
- `state-machine-verifier` 2026-05-08: incorporated authoritative expiry across queue observers, current-live-session restoration for hidden anomalies, terminal purge requirements, exclusive display bucket classifier, and typed `cancelSnooze` result.
- `design-experimenter` 2026-05-08: empirical checkpoint confirmed stale expired snooze risk, terminal-transition purge gap, frontend bucket overlap, and required-anomaly persistence assumptions. Existing `attention-queue` and `task-persistence` tests passed before RFC revision.
- `boundary-critic` round 2 2026-05-08: incorporated task/hidden-anomaly cancel result, server-owned expiry reconciliation instead of queue-owned live-session lookup, restore policy outside `task-persistence`, and narrowed telemetry side effects.
- `failure-mode-analyst` round 2 2026-05-08: incorporated server-side expiry timer, startup/reconciliation-safe restore, task-keyed `cancelSnooze`, authoritative-snapshot UI updates, and hidden-anomaly merge policy.
- `socratic-challenger` round 2 2026-05-08: incorporated explicit `cancelSnooze` hidden-anomaly behavior, no-session crash-recovery decision, exact V1 duration source, and removal of undefined `hidden` display bucket.
- `state-machine-verifier` round 2 2026-05-08: incorporated no-task anomaly rows in the state matrix, task-keyed resume behavior, and deferred explicit snooze-ended logging until there is one side-effect owner.
- `ambition-amplifier` round 2 2026-05-08: incorporated expiry as a live server/UI event; deferred hidden-finding severity indicators and global shortcut expansion.
- Final convergence round 2026-05-08: cut V1 `snoozeResult`, broad telemetry, and achievement changes; added legacy persistence shape separation, `open` task handling, fail-closed stale-session validation, and durable pending hidden-anomaly restoration.

### Rejected or Deferred Feedback

- Deferred a full `SnoozeRegistry` extraction. The boundary is real, but v1 can stay smaller by making `AttentionQueue`'s snooze semantics explicit.
- Deferred wake policies such as "wake on any finding" or "wake on critical finding." They describe a likely follow-up feature, not the requested duration snooze.
- Rejected using only re-detection after expiry for hidden findings. The current anomaly sources are not proven level-triggered.
