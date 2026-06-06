# RFC: Pending User Message Visibility

**Status:** Draft (v4 — convergence revision)
**Date:** 2026-06-06
**Author:** Jean Ibarz (with Codex)

---

## Problem

When a user sends a message to a managed coding agent while the agent is still
working, Kookr accepts the message into the terminal input path but the activity
panel does not show it until the agent runtime later emits a `UserPromptSubmit`
hook. For a long-running turn, that delay can be tens of seconds or minutes.

The current UI therefore creates a bad trust gap:

- the response input clears immediately;
- the user sees a "sent" overlay or task advance;
- the activity panel still looks as if no message exists;
- another browser tab or remote viewer cannot tell that input is already
  queued;
- if delivery fails, there is no activity-facing lifecycle explaining what
  happened.

This is visible with Claude Code and Codex tasks that are asked to sleep for 60
seconds: a message submitted during the sleep is queued for the terminal, but
the visible activity timeline does not include the user's message until the
agent reaches the next input boundary and the provider hook fires.

## Current Behavior

Code inspection on `main` shows these relevant paths:

1. Dashboard `respond`, `respondAll`, and `directReply` messages enter
   `AnomalyHandler`.
2. `AnomalyHandler` and `sendDirectAgentInput()` await `adapter.sendInput()`
   before appending `InteractionEvent.user_input`.
3. `Monitor.markInputReceived()` injects a synthetic `input_received` event to
   clear `needs_input` or `permission_blocked`.
4. Activity summaries render provider `AgentEvent.user_prompt`, but ignore
   `input_received` because `user_prompt` is the authoritative provider signal.
5. `TerminalInputCoordinator` serializes terminal writes and tracks prompt
   readiness, but it does not expose message-shaped pending input.

Raw terminal keystrokes are a separate path: `SessionBridge` forwards xterm.js
input frames through `TerminalInputWriterPort`. Those writes are byte-level and
are not currently representable as one clean chat message unless Kookr observes
a later provider `UserPromptSubmit` hook.

## Requirements

- Kookr SHALL show a dashboard-submitted reply in the activity panel as soon as
  the server accepts it for delivery.
- Kookr SHALL expose at least `queued`, `submitted`, and `failed` user-visible
  states.
- Kookr SHALL preserve server-side write ordering per terminal session.
- Kookr SHALL avoid duplicate user messages when the provider later emits
  `UserPromptSubmit` for the same content.
- Kookr SHALL keep the visible pending state consistent across browser tabs and
  remote viewers by deriving it from server state, not from a local optimistic
  React component.
- Kookr SHALL make delivery failure visible without silently clearing the typed
  message forever.
- Kookr SHALL support `respondAll` as independent per-target deliveries with
  partial-failure isolation.
- Kookr SHALL not let pending-input projection affect anomaly detection,
  watchdog state, turn-state derivation, token accounting, or completion
  summaries.
- Kookr SHOULD account for reflection/audit use cases without making durable
  audit storage the live delivery state owner.
- V1 SHALL remain local-first and reuse the existing monitor snapshot,
  activity summary, interaction log, and terminal input coordinator concepts.

## Non-Goals

- Do not make raw terminal typing a perfect chat transcript in V1.
- Do not modify Claude Code or Codex CLI.
- Do not introduce SQLite or a new global message broker.
- Do not expose unbounded raw input payloads in browser snapshots.
- Do not treat a provider `UserPromptSubmit` hook as proof that the model has
  semantically consumed the message. It proves only that the terminal program
  submitted the prompt.
- Do not make `TerminalInputCoordinator` responsible for provider-specific
  text-to-bytes conversion.

## Recommendation

Add a server-owned `UserInputDeliveryService` adjacent to the terminal input
boundary. It owns message-shaped input delivery rows and exposes a bounded
snapshot overlay for the activity panel.

The service is not a replacement for provider events and not a new anomaly
event stream. It is an activity overlay with one job: make Kookr-accepted user
messages visible while they are queued, submitted, or failed.

High-level flow:

1. A message-shaped submit path calls `UserInputDeliveryService.submitMessage()`.
2. The service creates an in-memory delivery row before enqueueing bytes. If
   row creation fails, it returns a structured pre-acceptance error and does
   not write to the PTY.
3. The service calls the existing adapter `sendInput()` path, which keeps
   provider-specific newline and enter behavior.
4. On write success, the row remains user-visible as `queued`. Internally it is
   marked with `ptyAcceptedAt`.
5. When a matching parent-session provider `user_prompt` arrives, the service
   marks the row `submitted_by_agent`.
6. On pre-write or write failure, the service marks the row `failed`.
7. Snapshots include delivery rows separately from `AgentState.events`.
8. The activity panel merges delivery rows with provider events and suppresses a
   matching provider `user_prompt` once the delivery row is submitted.

This keeps the monitor append-only and prevents pending UI state from changing
the semantics of agent activity used by the supervisor.

## Design

### 1. Delivery Row Contract

Add a shared snapshot DTO, not a provider-style `AgentEvent`:

```ts
type UserInputDeliveryStatus =
  | 'queued'
  | 'submitted_by_agent'
  | 'failed';

interface UserInputDeliverySnapshot {
  deliveryId: string;
  sessionId: string;
  deliverySeq: number;
  source: 'respond' | 'directReply';
  text: string;
  status: UserInputDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  ptyAcceptedAt?: string;
  submittedHookLineId?: string;
  terminalReason?: 'session_ended_before_submit_hook';
  error?: string;
}
```

Users mostly need to know "Kookr has queued this message for the terminal"
until the provider confirms submission. A separate "sent to PTY" label risks
implying that the agent has seen the message, so it remains an implementation
detail represented only by `ptyAcceptedAt`.

For privacy, server projection must cap `text` before it reaches browser
snapshots and never let unknown event projection pass full text by default.
Hashes and byte lengths are server-only matching data in V1 because they can
leak short-message contents. Remote task projections default-deny full text,
raw hashes, byte lengths, and backend error strings; they may expose only a
sanitized status and capped/redacted preview allowed by the existing snapshot
policy.

### 2. State Owner

Introduce `src/server/user-input-delivery-service.ts`.

Responsibilities:

- allocate `deliveryId`;
- allocate monotonic `deliverySeq` per session;
- track active delivery rows outside the monitor event window;
- append existing durable interaction/audit facts after acceptance;
- call `adapter.sendInput()` for message-shaped paths;
- reconcile parent-session provider `user_prompt` events;
- expose `getSnapshot(sessionId)`;
- finalize non-terminal rows on session cleanup.

Non-responsibilities:

- byte-level write implementation;
- prompt-readiness state;
- anomaly detection;
- turn-state derivation;
- token accounting;
- completion summaries;
- raw terminal keystroke transcript reconstruction.

`TerminalInputCoordinator` remains the serialized write/readiness owner.
Adapters remain responsible for provider-specific text-to-bytes behavior.

The delivery service is in-memory in V1. The existing interaction log records
accepted user intent and failure facts, but it is not used to reconstruct live
delivery rows after restart.

### 3. Message-Shaped Sources Only

V1 delivery rows are created only for semantic submit-message operations:

- `respond`;
- `directReply`;
- each per-target item in `respondAll`.

Raw terminal bytes, bracketed paste buffering, permission keystrokes, resize,
and remote input with "append newline false" do not create delivery rows. They
continue to appear only if the provider later emits `user_prompt`.

This boundary prevents false activity rows for half-written terminal drafts.

### 4. Closed Lifecycle

Delivery rows are in-memory records with a small lifecycle:

| From | To | Cause |
|---|---|---|
| none | `queued` | delivery row accepted |
| `queued` | `failed` | pre-PTY or write failure |
| `queued` | `submitted_by_agent` | matching parent `user_prompt` observed |
| `queued` | `queued` + `ptyAcceptedAt` | adapter write resolves |
| `queued` + `ptyAcceptedAt` | `queued` + `terminalReason` | session ends before matching hook |
| any terminal/expired row | removed from overlay | TTL expires or fresh server snapshot omits it |

Terminal states:

- `submitted_by_agent` is terminal.
- `failed` is terminal.
- `queued` with `ptyAcceptedAt` can remain visible until a matching hook
  arrives, a TTL expires, or session cleanup adds `terminalReason`.
- Session end after `ptyAcceptedAt` does not become `failed`; bytes were
  accepted by the PTY, but provider submission was not confirmed.

Late write callbacks must be guarded by a row revision or generation. After
`finalizeSession()` marks a row failed or terminal-reasoned, stale write
resolve/reject callbacks must not resurrect or regress the row.

V1 does not recover transient delivery rows after server restart. A fresh server
snapshot is authoritative: absence of a delivery overlay for a session removes
previous queued/submitted/failed overlay rows held by the frontend.

### 5. Ordering

`deliverySeq` is monotonic per session and assigned when the row is accepted.
Snapshot ordering uses `(sessionId, deliverySeq)`, not array position or
timestamp alone.

V1 does not add a dashboard idempotency contract. If a browser retries a
`respond` after an uncertain WebSocket send, duplicate PTY input remains
possible. That is a separate reliability problem; this RFC only makes accepted
deliveries visible and failures honest.

### 6. Reconciliation With Provider `user_prompt`

Extend `AgentEvent.user_prompt` to include a stable hook identity when
available:

```ts
{
  type: 'user_prompt';
  sessionId: string;
  prompt: string;
  cwd?: string;
  hookLineId?: string;
}
```

When `event-pipeline.ts` sees a parent-session `user_prompt`, it should call:

```ts
userInputDeliveries.observeProviderUserPrompt(sessionId, {
  prompt: event.prompt,
  hookLineId: event.hookLineId,
  observedAt: nowISO(),
});
```

Matching rules:

- If `hookLineId` was already observed, do nothing.
- Prefer the oldest non-terminal delivery for the same session whose normalized
  text equals the provider prompt.
- Normalize only transport artifacts Kookr controls: trailing CR/LF,
  bracketed-paste wrappers, and one final submit newline.
- If multiple pending rows have the same text, reconcile by FIFO.
- If no exact safe match exists, leave the provider `user_prompt` as a normal
  authoritative user message and keep unmatched delivery rows unchanged.

The service should reconcile only provider prompts observed after the delivery
row was created. If hook replay support is active while live rows exist, the
service needs a hook high-watermark at delivery creation and must ignore replay
records at or below that watermark.

V1 does not attempt to reason about raw terminal drafts. If raw terminal input
causes a provider prompt that does not exactly equal a delivery row, both rows
render. This is deliberately conservative.

### 7. Activity Projection

Add a shared pure projector for visible activity:

```ts
buildActivityItems({
  providerEvents,
  userInputDeliveries,
  deliverySuppressions,
}): ActivityItem[]
```

This projector owns dedupe and ordering policy. The frontend should not
reimplement matching between provider `user_prompt` events and delivery rows.

Rules:

- render delivery rows by `deliveryId`;
- suppress provider `user_prompt` events linked by `submittedHookLineId`;
- retain a short-lived suppression tombstone after a submitted delivery row
  expires, long enough for the corresponding provider event to age out of the
  frontend activity history;
- if no link exists, render both rows rather than guessing.

### 8. Snapshot Projection

Extend client-facing `AgentState` with a bounded overlay:

```ts
interface AgentState {
  // existing fields
  userInputDeliveries?: UserInputDeliverySnapshot[];
}
```

`getSnapshotAgentsForClient()` asks the delivery service for active rows per
session and applies projection caps. Active rows include:

- all non-terminal rows;
- failed rows until TTL or retry;
- submitted rows until a short TTL so the activity panel can merge them with
  the provider event and avoid flicker.

The frontend activity history must merge delivery overlays by `deliveryId`, not
by `JSON.stringify(event)`. This avoids duplicate rows when status changes.
Fresh server snapshots are authoritative for overlay presence: a row absent
from a fresh snapshot is removed from the client overlay cache for that
session.

The monitor remains append-only. Delivery rows are not fed into anomaly
detection or token/completion processors.

### 9. Submit Acknowledgement and Interaction Log Semantics

The submit path needs an explicit acknowledgement contract so the frontend does
not clear input forever when the server cannot accept the delivery row.

Minimum contract:

- pre-acceptance failure returns an alert or structured reply that tells the
  frontend the message was not accepted;
- the frontend should restore or preserve the typed text on pre-acceptance
  failure;
- post-acceptance failure is represented by a failed delivery row.

Keep `InteractionEvent.user_input` as the durable reflection/audit fact and
append it at server acceptance time with optional additive fields:

```ts
{
  type: 'user_input';
  agentId: string;
  content: string;
  deliveryId?: string;
  timestamp: string;
}
```

Do not persist mutable live status in the interaction log. Reflection and
friction analysis should count accepted user intent. Durable failure analytics
can be added later if reflection/reporting needs them.

If the interaction log append fails after an in-memory delivery row is accepted,
do not block PTY delivery in V1. Emit a diagnostic warning; the activity overlay
still protects the user-visible trust gap. The interaction log is audit support,
not a live delivery veto.

### 10. `respondAll`

`respondAll` should not be one shared delivery. It should:

1. allocate one delivery row per target session;
2. attempt each write independently;
3. dedupe duplicate session targets by default unless the caller explicitly
   submits multiple ordered messages;
4. isolate failures with `Promise.allSettled`-style semantics;
5. emit an aggregate alert after all target writes settle;
6. preserve per-agent activity rows even if another target fails.

Do not add a write deadline in V1 unless the underlying write can be cancelled.
Marking a row failed while the terminal write may still complete would invite
duplicate retries. Rely on the existing terminal backend write timeout/error
behavior for failed writes.

The delivery service owns only one message to one terminal session.

### 11. Cleanup

The session lifecycle orchestrator owns cleanup ordering. Monitor and terminal
modules must not call the delivery service directly.

Before terminal coordinator cleanup or monitor unregister removes session state,
the orchestrator calls:

```ts
userInputDeliveries.finalizeSession(sessionId, reason);
```

Rules:

- queued rows without `ptyAcceptedAt` become `failed`;
- queued rows with `ptyAcceptedAt` remain user-facing `queued` with
  `terminalReason: 'session_ended_before_submit_hook'`.
- `submitted_by_agent` and `failed` remain unchanged.
- Finalized rows remain visible long enough for the next snapshot and then
  expire by TTL.
- stale write callbacks after finalization are ignored by row revision guard.

## Files to Change

- `src/server/user-input-delivery-service.ts` (new)
- `src/shared/contracts/user-input-delivery.ts` (new)
- `src/shared/contracts/agent-state.ts`
- `src/shared/contracts/agent-events.ts`
- `src/shared/contracts/activity-summary.ts`
- `src/shared/contracts/activity-delivery-projector.ts` (new or refactor)
- `src/server/ws-handlers/anomaly-handler.ts`
- `src/server/use-cases/agent-input.ts`
- `src/server/event-pipeline.ts`
- `src/server/use-cases/get-snapshot.ts`
- `src/server/event-projection.ts`
- `src/core/interaction-log.ts`
- `src/frontend/store/activity-history.ts`
- `src/frontend/components/ActivityPanel.tsx`
- focused Vitest coverage for delivery service, activity summary merge,
  WebSocket respond/directReply/respondAll, cleanup finalization, projection
  caps, stale write callbacks, and provider reconciliation
- one Playwright test for delayed agent submission, ideally parameterized over
  Claude Code and Codex when both binaries are available

## Edge Cases

- **Agent still running:** show a queued row immediately after server
  acceptance. Keep it queued until provider `user_prompt` confirms submission.
- **Write succeeds but provider hook is missing:** keep queued until TTL or
  session cleanup; do not invent a submitted state.
- **Write fails before PTY acceptance:** mark failed, keep row visible, and
  alert the user.
- **Session dies before write success:** mark failed.
- **Session dies after write success but before provider hook:** keep queued
  with `session_ended_before_submit_hook`.
- **Multiple rapid messages:** preserve FIFO by `deliverySeq`; reconcile
  duplicate text by oldest safe non-terminal row.
- **Duplicate WebSocket retry:** V1 does not dedupe uncertain retries. If a
  duplicate submit is accepted, it should create a second visible delivery row
  rather than silently writing twice.
- **`respondAll`:** allocate independent delivery ids and statuses per target;
  one failure or hung write must not stop remaining deliveries. Duplicate
  session targets are deduped by default.
- **Large or multiline reply:** cap WebSocket projection; keep local audit
  owner-only; avoid raw full-text exposure in remote projections.
- **Raw terminal typing:** do not create delivery rows. Coordinated writes
  prevent byte-level interleaving inside a single write sequence, but separate
  raw keystroke frames can still logically combine with dashboard replies by
  queue order. If the provider prompt does not exactly match a delivery row,
  render both rather than guessing.
- **Kookr restart:** V1 drops transient delivery overlays. A fresh server
  snapshot without delivery rows clears stale client overlay rows for that
  session.
- **Late write callback after cleanup:** row revision guards prevent stale
  resolve/reject callbacks from mutating finalized rows.
- **Hook replay:** V1 reconciles only provider prompts observed after delivery
  creation and above the delivery's hook high-watermark.
- **Provider echo differences:** matching must be conservative; if the provider
  normalizes content differently, show both rows rather than incorrectly merging
  different messages.

## Alternatives Considered

### A. Frontend-Only Optimistic Echo

Rejected. It fixes only the current tab and creates inconsistencies across
refreshes, multiple dashboard clients, remote viewers, and delivery failures.
It also cannot know when the server accepted or failed the terminal write.

### B. Render Existing `input_received`

Rejected as the primary design. `input_received` currently means "Kookr cleared
an anomaly because input was attempted"; it has no content, no idempotency key,
and no delivery lifecycle. Extending it could be smaller, but it would still
mix anomaly-clearing events with activity overlay state.

### C. Mutable `user_input_delivery` Agent Events

Rejected after review. `AgentEvent` feeds anomaly detection, watchdogs,
turn-state, completion summaries, and client projection. A mutable delivery
event would require monitor upsert semantics and frontend merge changes while
still risking event-window eviction before reconciliation.

### D. Wait for Provider `UserPromptSubmit`

Rejected. This is the current behavior and is exactly what hides queued
messages during long-running turns.

### E. Make the Interaction Log Drive the Activity Panel

Rejected for V1. The interaction log is session-level audit/reflection data,
not the live per-agent activity projection. It should record accepted user
intent, but the activity panel should use the delivery service snapshot plus
provider events.

## Empirical Validation Plan

Round-1 empirical checkpoint against local code found:

- supported: monitor windows are capped at 50 events and unsuitable as the
  pending-delivery source of truth;
- supported: frontend activity history currently merges by event JSON, so
  mutable event rows would duplicate unless keyed by delivery id;
- supported: `respond` and `directReply` currently write before `user_input`
  interaction logging;
- supported: `respondAll` currently fans out sequentially, so one thrown write
  can stop later targets;
- corrected: raw terminal input is byte-level, but the current coordinator
  serializes writes, so the risk is logical draft mixing by queue order rather
  than byte interleaving inside a coordinated write sequence.

Before implementation, verify the user-visible failure and the fix with both
supported agent types when binaries are available:

1. Launch a Claude Code task that blocks inside a long turn, such as `sleep 60`
   before returning to the prompt.
2. Submit a dashboard reply while the task is sleeping.
3. Assert the activity panel shows the reply within one WebSocket snapshot,
   marked queued, before any provider `UserPromptSubmit`.
4. Repeat with Codex CLI.
5. Force a backend write failure with a fake terminal backend and assert the
   row becomes failed.
6. Force a hook-missing path and assert the row never becomes submitted.

Tests that wait on WebSocket updates must filter by message type and predicate,
not by "next message", because Kookr broadcasts background status updates.

## Open Questions

- Should failed rows include a retry button in the activity panel, or should
  retry live only in the response input area?
- Should owner-reviewed remote input proposals appear as pending activity only
  after the owner applies them, or also while waiting for owner review?

## Critic Feedback Incorporated

- design-minimalist 2026-06-06: removed mutable `user_input_delivery`
  `AgentEvent` and monitor upsert from the recommendation; scoped V1 to
  message-shaped submit paths.
- boundary-critic 2026-06-06: split state ownership into a
  `UserInputDeliveryService` adjacent to, but not inside,
  `TerminalInputCoordinator`; excluded delivery overlays from anomaly,
  watchdog, turn-state, token, and completion processors.
- state-machine-verifier 2026-06-06: added closed transition table,
  `deliverySeq`, `hookLineId` requirement, and session cleanup finalization.
- failure-mode-analyst 2026-06-06: added fail-closed row creation, snapshot
  overlay outside the capped monitor window, conservative exact matching,
  `respondAll` partial-failure handling, restart-state constraints, and
  explicit projection privacy caps.
- design-minimalist round 2 2026-06-06: made V1 live delivery rows explicitly
  in-memory, removed restart-recovery persistence, collapsed internal delivery
  states into public status plus `ptyAcceptedAt`, and removed `batchId`.
- state-machine-verifier round 2 2026-06-06: added overlay expiry semantics,
  suppression tombstones and stale write-callback guards.
- failure-mode-analyst round 2 2026-06-06: added submit acknowledgement
  behavior, fresh-snapshot overlay reset, hook high-watermark protection,
  and stricter remote projection privacy.
- boundary-critic round 2 2026-06-06: named lifecycle orchestration and shared
  activity projection as explicit ownership boundaries.
- round 3 convergence 2026-06-06: cut remote-submit support, dashboard
  idempotency, global terminal input sequencing, and uncancellable write
  deadlines from V1; kept conservative exact reconciliation and duplicate
  rendering when uncertain.
