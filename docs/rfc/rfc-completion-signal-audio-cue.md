# RFC: Audio Cue for Agent Completion Signals

**Status:** Draft (v2 - post critic review)
**Date:** 2026-06-06
**Author:** Jean Ibarz (with Codex)
**Related RFCs:** `rfc-task-chime-browser.md`, `rfc-audio-alert-observability.md`, `rfc-smart-task-speech-summary.md`

---

## Problem

Kookr currently has browser audio plumbing for findings and a task-completion
chime keyed to focused task lifecycle transitions. That lifecycle trigger is
not the UX goal for completion feedback.

The useful moment is earlier and semantically different: the agent has
**signaled that it believes the task is complete**. The user may be in another
window or supervising a different task, and wants a low-friction cue that a task
is ready for review. A manual Complete click is not a useful audio trigger
because the user already caused it.

Kookr already models this distinction:

- `TaskStatus.completed` is persisted lifecycle state, usually set through
  `completeTask`.
- `TurnState.completed_turn` means a live interactive agent emitted a normal
  Stop/final answer and is idle, while the task may remain `inProgress` and
  open for follow-up.
- `CompletionDigest` summarizes closed tasks, but it belongs to lifecycle
  closeout, not realtime "agent signaled done" projection.

The current `useTaskCompletionChime` policy conflates terminal task status with
useful completion feedback. It can chime on user-initiated completion and remain
silent when a background agent finishes a turn and waits for review.

## Requirements

- Kookr SHALL play a soft audio cue when a task receives a new
  `latestCompletionSignal` after initial hydration.
- Kookr SHALL NOT play this cue when the user manually marks a task complete.
- Kookr SHALL NOT require the task to be focused.
- Kookr SHALL dedupe by stable completion-signal identity, not by
  `taskStatus`.
- Kookr SHALL treat "signaled complete" as review-ready state, not delivery
  proof and not lifecycle completion.
- Kookr SHALL visually surface the same state as "Signaled complete" so the
  sound has an inspectable counterpart.
- Kookr SHALL respect the existing sound preference, DND state, browser audio
  rejection handling, and audio-alert observability.
- Kookr SHALL avoid reintroducing the old Stop-hook sound storm: duplicate Stop
  hooks, reconnect snapshots, StrictMode remounts, and unchanged final messages
  SHALL NOT replay the cue.

## Non-Goals

- Automatically marking tasks complete.
- Proving the task's real-world delivery is complete.
- Evaluating completion criteria in v1.
- Playing audio for every normal assistant turn.
- Adding OS desktop notifications in v1.
- Adding new bundled sound assets in v1.
- Changing finding/anomaly audio policy.
- Reusing asynchronous task-closeout metadata generation in realtime snapshot
  projection.

## Terminology

**Manual completion**: the user clicks Complete or invokes `completeTask`. This
transitions task lifecycle and records `task_completed` with
`reason: user_marked`. It is excluded from this RFC's audio trigger.

**Completion signal**: projected evidence that the agent believes it has
completed the current turn and is ready for review. It is a cue, not an
assertion that the task is correctly delivered.

**Delivery completion**: external evidence that requested work is actually
done, such as passing tests, commits, or a PR. V1 may show bounded evidence in
plain UI later, but does not require it for the soft cue.

## V1 Signal Source

V1 has one source: deterministic final-turn projection.

The source is a live managed task whose effective turn state becomes
`completed_turn` after a normal Stop event, with no still-running background
subagent. This is stronger than a raw Stop hook because existing turn-state
logic trims trailing bookkeeping overlays and suppresses completed state while
background subagents remain active.

V1 policy:

- Project `latestCompletionSignal` for an `inProgress` task when its effective
  turn state is `completed_turn`.
- Omit the signal for terminal tasks, `waiting_for_input`, `blocked`,
  `running`, and `unknown`.
- Omit the signal when the effective final message is absent or empty.
- Do not create or update the signal from `completeTask`,
  `task_completed(reason: user_marked)`, `cancelTask`, or `terminateTask`.
- If a subagent is orphaned or TTL-evicted before `SubagentStop` arrives, do
  not play audio from the stale parent Stop. Require a fresh parent Stop after
  the orphan is resolved before emitting an audible signal.

Deferred sources:

- LLM classification of final assistant messages.
- Completion-criteria evaluation.
- Evidence-backed confidence upgrades.
- GitHub/CI confirmation.
- Ralph loop terminal predicate satisfaction.

These can enrich or strengthen future completion signals, but they must not
change the v1 signal id or replay audio for an already-seen turn.

## Design

### 1. Keep Signal Derivation in Core

Add a small core helper next to turn-state derivation, for example
`src/core/completion-signal.ts`:

```ts
export interface CompletionSignalInput {
  taskId: string;
  agentId: string;
  taskStatus?: TaskStatus;
  events: AgentEvent[];
}

export interface LatestCompletionSignal {
  id: string;
}

export function deriveLatestCompletionSignal(
  input: CompletionSignalInput,
): LatestCompletionSignal | undefined;
```

This helper should share the same effective-event logic as `deriveTurnState`.
If needed, extract a common helper such as
`deriveTurnStateWithEffectiveEvent(events)` so completion-signal projection does
not reverse-engineer which Stop produced `completed_turn`.

`src/server/use-cases/get-snapshot.ts` should only project the derived value
onto the client snapshot. It should not own completion semantics.

### 2. Use a Minimal Wire Contract

Add this optional field to the shared wire contract in
`src/shared/contracts/agent-state.ts`:

```ts
latestCompletionSignal?: {
  id: string;
};
```

The core monitor state and shared `AgentState` shape must not drift. If the
core has a local `AgentState` interface, it should import, alias, or extend the
shared field instead of redefining it differently.

V1 intentionally omits `source`, `confidence`, and nested evidence. There is
only one source, and evidence does not affect whether audio plays. Adding those
fields now would encode future policy before the second source exists.

### 3. Stable Identity

The signal id must survive snapshot replay while distinguishing later real Stop
events that repeat the same final message.

V1 identity:

```text
taskId | agentId | turnBoundaryId | stopEventId | lastMessageHash
```

`turnBoundaryId` should identify the current user-prompt-to-final-stop turn. If
there is no durable turn id today, use the most recent user input/prompt event
sequence as the boundary input, plus the effective Stop event sequence and final
message hash. Snapshot replay of the same Stop keeps the same id; a later Stop
event with the same final message receives a new id.

The helper should compute `lastMessageHash` internally from the normalized final
assistant message. It is not part of the wire contract.

### 4. Rewrite Existing Chime Hook In Place

Replace the behavior of `useTaskCompletionChime` rather than running old and new
policies in parallel. The app already has one hook call and one test file; an
atomic rewrite is simpler and prevents the old `task_completion` semantics from
surviving by accident.

New hook behavior:

- Watch every visible agent's `latestCompletionSignal`, not just the selected
  agent.
- Seed seen signal ids on initial hydration without playing audio.
- Use module-scoped per-tab seen state so StrictMode remounts and reconnect
  snapshots do not replay old signals.
- Prune the seen set with a bounded capacity, e.g. 500 ids.
- Do not consult `selectedAgentId`.
- Do not chime for task-status transitions when `latestCompletionSignal` is
  absent.

Sketch:

```ts
const seenSignalIds = new BoundedSet<string>(500);
let hydrated = false;

export function evaluateCompletionSignalChimes(
  agents: AgentState[],
): CompletionSignalChimeDecision {
  const unseen = agents
    .map((agent) => ({ agent, signal: agent.latestCompletionSignal }))
    .filter((item) => item.signal && !seenSignalIds.has(item.signal.id));

  for (const item of unseen) seenSignalIds.add(item.signal.id);

  if (!hydrated) {
    hydrated = true;
    return { audible: false, signals: unseen };
  }

  return { audible: unseen.length > 0, signals: unseen };
}
```

### 5. Batch Simultaneous Signals

If multiple tasks signal complete in the same snapshot/delta window, Kookr
should play at most one audible cue while recording all decisions. This prevents
a burst when several child tasks finish together.

V1 batching rule:

- Collect all unseen completion signals observed in one hook evaluation.
- Record an audio-alert decision for each signal, including its
  `completionSignalId`.
- Schedule at most one audible `maybePlayChime` call per debounce window
  (suggested: 1500 ms).
- The audible context should include the first signal and a `candidateCount`.

### 6. Extend Audio Observability

Extend `AudioAlertSource` with:

```ts
| 'completion_signal'
```

Add optional context/decision fields:

```ts
completionSignalId?: string;
candidateCount?: number;
```

Audio-alert coalescing keys must include `completionSignalId` for completion
signals. Otherwise multiple muted or DND-suppressed completion signals for the
same task could collapse into one repeat and hide what happened.

The existing `task_completion` source should be removed from the production hook
or left only for historical log display/tests that need old records.

### 7. Visual Surface

Keep v1 visual work small:

- Reuse the current completed-turn UI area.
- Rename/copy it as `Signaled complete`.
- Keep the task in the active/in-progress area until the user replies, completes
  it, cancels it, or relaunches it.

Do not add evidence chips or a new detail-panel section in v1. Evidence display
belongs with a later design where evidence changes confidence or user action.

## Files to Change

- `docs/rfc/rfc-completion-signal-audio-cue.md`
- `src/core/completion-signal.ts`
- `src/core/completion-signal.test.ts`
- `src/core/turn-state.ts` if common effective-event extraction is needed
- `src/core/monitor.ts`
- `src/shared/contracts/agent-state.ts`
- `src/frontend/audio/audio-alert-log.ts`
- `src/frontend/hooks/useTaskCompletionChime.ts`
- `src/frontend/hooks/useTaskCompletionChime.test.ts`
- Task row/detail presentation components that render completed-turn state

## Test Plan

Core tests:

- `completed_turn` on an `inProgress` task projects
  `latestCompletionSignal`.
- Terminal tasks do not project `latestCompletionSignal`.
- `waiting_for_input`, `blocked`, `running`, and `unknown` do not project it.
- Stop followed by trailing `notification` or `subagent_stop` preserves the
  same effective signal semantics as `deriveTurnState`.
- Stop while a background subagent is still running does not project an audible
  signal.
- Lost/TTL-evicted subagent state does not emit audio from an old parent Stop;
  a fresh parent Stop is required.
- Duplicate Stop hooks with the same final assistant message and no intervening
  user input produce the same signal id.
- A follow-up user input followed by a new Stop produces a new signal id.
- Manual `completeTask` does not create a new completion signal.
- Final messages like "I could not finish" or a final answer that is still a
  question are covered by tests and remain eligible only if v1 policy explicitly
  chooses to treat all final turns as review-ready. The UI must not label them
  as delivery success.

Frontend tests:

- Initial hydration with existing signals seeds the seen cache and does not
  chime.
- Hook remount/StrictMode does not replay seeded signals.
- Reconnect full snapshot does not replay seeded signals.
- A new signal on any task, focused or not, schedules one chime.
- Replayed snapshot/delta for the same signal id does not chime.
- Multiple new signals in one evaluation schedule at most one audible cue and
  record every signal decision.
- A second signal id for the same task after follow-up schedules another cue.
- Manual `completeTask` status update without `latestCompletionSignal` does not
  chime.
- Mute and DND suppress audio but still record decisions with distinct
  `completionSignalId` values.

Regression tests:

- Existing finding audio remains unchanged.
- The audio-alert observability panel displays `completion_signal` decisions.
- Old status-transition `task_completion` tests are removed or rewritten so they
  cannot preserve the wrong policy.

## Edge Cases

- **Agent says it failed:** this may still be a final-turn review signal, but UI
  copy must avoid "success" language. The cue means "review this result."
- **Agent asks a final question:** classify as `waiting_for_input` when possible;
  otherwise the visual preview should make the uncertainty obvious.
- **Dashboard reconnects after tasks signaled complete:** no audio on hydration
  or replay; visual indicators remain.
- **Many parallel tasks signal complete at once:** one chime per debounce window,
  all signal decisions logged.
- **Task is manually completed immediately after signal:** no second chime.
- **Task is terminal before projection:** omit `latestCompletionSignal`; terminal
  lifecycle rows already have completion digest UI.

## Alternatives Considered

### A. Keep the existing task-status transition chime

Rejected. It fires on lifecycle closure, including manual user action, and misses
the background case where an agent has finished a turn and waits for review
while the task remains `inProgress`.

### B. Frontend derives from `turnState === completed_turn`

Rejected. It would be simple, but it spreads completion semantics into the UI
and lacks a stable signal identity. Core already owns the effective turn-state
logic and should derive the completion signal alongside it.

### C. Add a `completion_signaled` transport event

Rejected for v1. Snapshot projection is enough for the existing UI and avoids
adding a second lifecycle/event surface. The field is named
`latestCompletionSignal` to make clear that it is current projected state, not an
append-only event stream.

### D. Require evidence-backed completion before audio

Rejected for v1. The user asked to know when the task is signaled complete. The
cue should mean "agent says it is ready," while UI wording makes clear whether
delivery evidence exists.

### E. OS notification instead of audio

Deferred. Audio is lower-friction for a local dashboard and already has
preference/DND plumbing. OS notifications can be added later.

## Critic Feedback Incorporated

- `design-minimalist` 2026-06-06: reduced v1 to a minimal
  `latestCompletionSignal` field; removed `source`, `confidence`, nested
  evidence, evidence chips, and parallel migration.
- `failure-mode-analyst` 2026-06-06: changed identity away from `eventSeq`
  alone; added duplicate Stop, hydration/remount/reconnect, batching, weak final
  message, subagent orphan, and muted/DND coalescing requirements.
- `boundary-critic` 2026-06-06: clarified snapshot state vs event semantics;
  moved derivation ownership into `src/core`; named the shared `AgentState`
  contract; forbade realtime projection from calling async lifecycle closeout
  metadata generation.
