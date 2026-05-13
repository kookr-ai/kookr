# RFC: Audio Alert Observability

**Status:** Draft (v2 — post round-1 critic incorporation)
**Date:** 2026-05-13
**Author:** Jean Ibarz (with Claude)

---

## Problem

When Kookr plays a sound, the operator currently has to infer why from scattered
state:

- which process owns `localhost:4800`
- which frontend bundle is loaded
- whether the sound toggle and DND are enabled
- which agents have active findings
- whether a task completion transition was observed while focused
- whether browser autoplay rejected or allowed `AudioContext`

The production incident that motivated this RFC was a repeated sound from
`localhost:4800`. The diagnosis required process inspection, source tracing, and
manual WebSocket snapshot probes. The likely answer was "Kookr's browser chime
is enabled and active findings exist", but Kookr itself had no first-class
"last chime reason" or "audio alert decision trail" to confirm that from the UI.

This is an observability gap. The alert system makes decisions in the browser,
then discards the useful diagnostic context.

## Current State

Relevant existing code:

- `src/frontend/audio/sound.ts` owns `kookr-sound-enabled`, checks DND, creates
  `AudioContext`, and plays the two-tone chime through `maybePlayChime()`.
- `src/frontend/hooks/useAudibleAlert.ts` reduces finding changes to a boolean
  `shouldChime`; it dedupes by `(agentId, anomaly.type, anomaly.detectedAt)`.
- `src/frontend/hooks/useTaskCompletionChime.ts` reduces focused task status
  transitions to a boolean `shouldChime`.
- `src/frontend/hooks/useDnd.ts` already has a robust external-store pattern
  for localStorage failures, expiration, and cross-tab synchronization.
- `src/frontend/telemetry.ts` already buffers client telemetry over the
  WebSocket, but telemetry event types are sourced from `src/core/telemetry.ts`
  and mirrored in `src/shared/contracts/client-message-schema.ts`.
- `src/frontend/components/StatusBar.tsx` already owns the sound toggle UI.
- `src/frontend/components/OperationsPanel.tsx` already hosts diagnostics
  surfaces such as `DetectionStatsPanel`.

The missing piece is a structured browser-local **audio alert decision** that
survives long enough to inspect.

## Goals

1. Make every attempted alert chime explainable: scheduled, muted, DND-blocked,
   or rejected by the browser audio path.
2. Make the most recent alert cause visible from the UI without devtools.
3. Preserve a short in-browser ring buffer for local diagnosis.
4. Keep privacy boundaries tight: no raw transcript, no full tool input/output,
   and no unnecessary server persistence in v1.
5. Keep v1 small enough that the first implementation issue solves the observed
   incident class by itself.

## Non-Goals (v1)

- Changing when Kookr should chime. This RFC observes the existing policy first.
- Logging every "why did this finding not chime?" dedupe/cooldown decision.
- Adding server telemetry or `/api/telemetry/report` aggregation in v1.
- Adding STT/microphone lifecycle observability in v1. STT is input capture, not
  an alert-output decision.
- Adding new sound assets or per-event melodies.
- Proving the OS or speaker emitted audible sound. The browser can only report
  Web Audio scheduling state.
- Adding server-side authority over browser audio. The browser remains the
  source of truth for alert-gate and AudioContext state.

## Requirements

- Kookr SHALL record an audio alert decision whenever production code calls
  `maybePlayChime(context)`.
- Kookr SHALL distinguish at least these v1 outcomes:
  `scheduled`, `suppressed_muted`, `suppressed_dnd`,
  `audio_context_unavailable`, and `audio_context_error`.
- `scheduled` SHALL mean "Kookr passed mute/DND gates and successfully scheduled
  the Web Audio graph." It SHALL NOT claim that audible output reached the
  operator's speakers.
- Alert records SHALL include the source: `finding`, `task_completion`, or
  `manual_test`.
- Finding-trigger records SHALL include `agentId`, `taskId` when available,
  `anomaly.type`, `anomaly.severity`, `anomaly.detectedAt`, the dedupe key, and
  a `candidateCount` when multiple findings caused one chime attempt.
- Task-completion records SHALL include `agentId`, `taskId`, previous status,
  next status, selected agent id, and whether the task was focused.
- Records SHALL include local browser state: sound enabled, DND enabled, DND
  expiry if known, page visibility, `document.hasFocus()`, client session id,
  client tab id, and app build sha when available.
- AudioContext records SHOULD include initial context state, final/sampled state
  after scheduling when cheap, whether `resume()` was attempted, and whether it
  rejected.
- Repeated identical suppressed outcomes SHALL be coalesced locally with
  `repeatCount`, `firstSeenAt`, and `lastSeenAt`. Console breadcrumbs SHALL use
  the same coalescing rule.
- The StatusBar sound toggle SHALL expose the last alert decision in its
  title/tooltip.
- Existing chime behavior SHALL remain unchanged unless a follow-up issue
  explicitly changes policy.

## Design

### 1. Add a browser-local audio alert log

Add a new frontend module:

`src/frontend/audio/audio-alert-log.ts`

The module owns a bounded in-memory ring buffer and a React-friendly subscription
boundary:

```ts
export function recordAudioAlertDecision(decision: LocalAudioAlertDecision): void;
export function getAudioAlertSnapshot(): AudioAlertSnapshot;
export function subscribeAudioAlertLog(listener: () => void): () => void;
export function useAudioAlertLog(limit?: number): AudioAlertSnapshot;
```

`useAudioAlertLog` should be implemented with `useSyncExternalStore`, matching
the pattern in `useDnd.ts`, so UI consumers do not hand-roll stale snapshot
management.

Default ring-buffer capacity: 100. The buffer should retain recent scheduled or
error outcomes preferentially when coalescing repeated suppressions, so a noisy
mute/DND state does not hide the last useful alert cause.

### 2. Model local decisions precisely

Sketch:

```ts
export type AudioAlertSource = 'finding' | 'task_completion' | 'manual_test';

export type AudioAlertOutcome =
  | 'scheduled'
  | 'suppressed_muted'
  | 'suppressed_dnd'
  | 'audio_context_unavailable'
  | 'audio_context_error';

export interface LocalAudioAlertDecision {
  id: string;
  timestamp: string;
  source: AudioAlertSource;
  outcome: AudioAlertOutcome;
  reason: string;

  agentId?: string;
  taskId?: string;
  taskName?: string;
  anomalyType?: string;
  severity?: 'info' | 'warning' | 'critical';
  detectedAt?: string;
  dedupeKey?: string;
  previousStatus?: string;
  nextStatus?: string;
  selectedAgentId?: string | null;
  focused?: boolean;

  evaluationId?: string;
  candidateCount?: number;
  primaryCause?: 'first_candidate' | 'highest_severity' | 'task_completion' | 'manual_test';

  soundEnabled: boolean;
  soundStateSource: 'localStorage' | 'default' | 'memory_fallback';
  soundStorageAvailable: boolean;
  dndEnabled: boolean;
  dndExpiresAt?: number | null;
  pageVisibility: DocumentVisibilityState;
  documentHasFocus: boolean;
  activeFindingsCount?: number;

  clientSessionId: string;
  clientTabId: string;
  appBuildSha?: string;

  audioContextInitialState?: AudioContextState;
  audioContextFinalState?: AudioContextState;
  resumeAttempted?: boolean;
  resumeFailed?: boolean;

  repeatCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
}
```

Local UI may show `taskName` because it is already visible in the dashboard. Any
future telemetry DTO must be separate and redacted; see Future Work.

### 3. Make sound preference observable and safe

`src/frontend/audio/sound.ts` currently reads and writes `localStorage`
directly. Before surfacing audio state in more UI, extract sound preference into
an external store colocated with the audio module:

```ts
export interface SoundPreferenceState {
  enabled: boolean;
  storageAvailable: boolean;
  source: 'localStorage' | 'default' | 'memory_fallback';
}

export function getSoundPreferenceState(): SoundPreferenceState;
export function setSoundEnabled(enabled: boolean): void;
export function useSoundPreference(): SoundPreferenceState & {
  setEnabled: (enabled: boolean) => void;
};
```

This should mirror the DND implementation:

- safe localStorage reads/writes
- in-memory fallback when storage throws
- cross-tab synchronization through the `storage` event
- one source of truth for `StatusBar`, `SettingsDialog`, and `maybePlayChime`

### 4. Make `maybePlayChime` contextual and result-bearing

Change `src/frontend/audio/sound.ts` from:

```ts
export function maybePlayChime(): void
```

to:

```ts
export function maybePlayChime(context: AudioAlertContext): LocalAudioAlertDecision
```

`maybePlayChime` should:

1. Read sound and DND state once.
2. Return and record `suppressed_muted` when sound is off.
3. Return and record `suppressed_dnd` when DND is active.
4. Return and record `audio_context_unavailable` if no browser AudioContext API
   exists.
5. Try to create and schedule the Web Audio chime.
6. Record AudioContext state and any `resume()` attempt.
7. Return and record `scheduled` on successful graph scheduling.
8. Return and record `audio_context_error` on rejection or synchronous failure.

It should also emit a redacted `console.debug` breadcrumb for each non-coalesced
decision:

```ts
console.debug('[kookr.audio]', redactAudioAlertDecision(decision));
```

Full local details should stay available in the UI ring buffer. Console output
should avoid dumping task names by default.

### 5. Preserve aggregate finding-chime behavior

Today `useAudibleAlert()` calls `maybePlayChime()` at most once per React effect
tick, even if multiple findings become candidates. That behavior should remain.

Refactor only enough to pass context:

```ts
interface FindingChimeEvaluation {
  shouldChime: boolean;
  evaluationId: string;
  candidateCount: number;
  primaryCandidate?: AgentState;
}
```

Selection rule for the primary candidate:

1. highest severity (`critical` before `warning`)
2. earliest `detectedAt`
3. stable `agentId` lexical tie-breaker

Status text should support multiple causes:

`Last alert: stale_agent warning on Task A (+2 more)`

V1 SHALL NOT record every dedupe/cooldown suppression from `evaluateChime()`.
That can be added later if "why did this not chime?" becomes a real incident
class.

### 6. Add task-completion context without changing policy

Extend `evaluateCompletionChime()` with a reason enum:

```ts
type CompletionChimeReason =
  | 'no_selection'
  | 'unknown_agent'
  | 'focus_changed_prime'
  | 'status_unchanged'
  | 'previous_terminal'
  | 'next_not_terminal'
  | 'terminal_transition';
```

Only `terminal_transition` calls `maybePlayChime()`. Non-chiming reasons may be
kept in test assertions, but they are not part of the v1 audio log unless they
call `maybePlayChime()`.

### 7. Add small operator UI

#### Status bar

Enrich the existing sound toggle in `StatusBar`:

- title when no decision exists: current "Mute alert sounds" / "Unmute alert sounds"
- title when a decision exists:
  `Last alert: <source> -> <outcome>, <reason>, <relative time>`

The status bar shows the last **alert chime decision**, not STT or other audio
activity.

#### Operations panel

Create `src/frontend/components/AudioAlertsPanel.tsx` and mount it from
`OperationsPanel.tsx`, beside `DetectionStatsPanel` and `CircuitBreakerPanel`.
Do not add browser-local audio rendering inside `DetectionStatsPanel`.

The panel can ship in the second issue if the MVP keeps the first issue small.
It should show:

- sound preference state and source
- DND state and expiry
- current tab id
- last scheduled alert
- last 20 alert decisions
- counts by outcome for the current tab
- coalesced repeat counts

Label the data as "current browser tab" unless BroadcastChannel support is
implemented.

### 8. Add manual tests

Add a deliberate "Test alert policy" action in the operations panel or settings:

```ts
maybePlayChime({ source: 'manual_test', reason: 'operator_test' });
```

This respects Kookr mute and DND and verifies policy plus AudioContext behavior.

A separate "Test audio device" action that bypasses Kookr mute/DND may be useful,
but it should be follow-up work because it changes operator expectations. If
added later, it must require an explicit user click and record a distinct
`manual_test_bypass` event.

## Files to Change

Likely v1/MVP files:

- `src/frontend/audio/sound.ts`
- `src/frontend/audio/audio-alert-log.ts` (new)
- `src/frontend/audio/audio-alert-log.test.ts` (new)
- `src/frontend/hooks/useAudibleAlert.ts`
- `src/frontend/hooks/useAudibleAlert.test.ts`
- `src/frontend/hooks/useTaskCompletionChime.ts`
- `src/frontend/hooks/useTaskCompletionChime.test.ts`
- `src/frontend/components/StatusBar.tsx`
- `src/frontend/components/SettingsDialog.tsx`

Likely follow-up UI files:

- `src/frontend/components/AudioAlertsPanel.tsx` (new)
- `src/frontend/components/OperationsPanel.tsx`
- associated component tests

Likely follow-up telemetry files:

- `src/core/telemetry.ts` (source of truth for `TelemetryEventType`)
- `src/shared/contracts/client-message-schema.ts` (Zod mirror)
- `src/core/telemetry-report.ts`
- telemetry schema/report tests

## Edge Cases

- **Initial page load with active findings:** existing behavior decides whether
  a chime is attempted. If attempted, record the decision.
- **Multiple findings in one effect tick:** record one scheduled/suppressed
  alert attempt with `candidateCount` and a deterministic primary cause.
- **React StrictMode double effects:** tests should cover no duplicate
  `scheduled` decisions for one logical transition.
- **Multiple tabs:** v1 ring buffer is per tab. Add `clientTabId` to every
  decision and label UI as current-tab data. BroadcastChannel cross-tab merging
  is future work.
- **DND expires while finding remains active:** if policy attempts a chime after
  expiry, record the new decision with current DND state.
- **Sound muted:** record `suppressed_muted`; do not call `AudioContext`.
- **Autoplay/suspended context:** record AudioContext state. Do not claim audible
  output.
- **Private browsing/localStorage failures:** sound preference falls back to
  memory/default state and records `soundStateSource`.
- **No AudioContext API:** record `audio_context_unavailable`.

## Alternatives Considered

### Console-only logging

Cheap, but insufficient. The operator should not need devtools to answer why
the product made noise.

### Server-side audio decisions

Incorrect boundary. The server can know findings and task state, but only the
browser knows sound preference, DND state, tab visibility, autoplay behavior,
and actual AudioContext state.

### Telemetry-first implementation

Useful for historical analysis, but it delays the first useful answer. The
observed incident was diagnosable from the active browser tab. V1 should solve
that locally before adding server report aggregation.

### Recording every suppressed finding decision

This would answer "why did this not chime?", but it adds volume and complexity.
V1 only records actual chime attempts and final gate/audio outcomes.

## Test Plan

- Unit-test `audio-alert-log` ring buffer capacity, ordering, coalescing, and
  `useSyncExternalStore` snapshot behavior.
- Unit-test sound preference safe storage, memory fallback, and cross-tab sync.
- Unit-test `maybePlayChime()` outcomes for scheduled, muted, DND,
  AudioContext unavailable, and AudioContext failure.
- Unit-test `useAudibleAlert` preserves one chime attempt per effect tick and
  records `candidateCount` / primary cause deterministically.
- Unit-test `useTaskCompletionChime` still only chimes on focused
  non-terminal-to-terminal transitions.
- Component-test `StatusBar` title text for no decision, scheduled decision,
  muted suppression, and DND suppression.
- If `AudioAlertsPanel` ships, component-test empty state, recent decisions, and
  coalesced counts.
- Manual browser check:
  1. load Kookr with sound on and DND off
  2. use "Test alert policy"
  3. confirm StatusBar shows `manual_test -> scheduled`
  4. mute sound and test again
  5. confirm `suppressed_muted`
  6. enable DND and test again
  7. confirm `suppressed_dnd`
  8. trigger or simulate a warning finding in development/staging
  9. confirm the last alert reason names the finding source and candidate count

## Rollout Plan

Ship in three focused issues:

1. **Local chime diagnosis MVP**
   Add `AudioAlertDecision`, `audio-alert-log`, safe sound preference store,
   contextual `maybePlayChime`, finding/task-completion context, StatusBar last
   decision, console breadcrumbs, and focused tests. This issue should satisfy
   the incident acceptance bar.

2. **Audio alerts operations panel**
   Add `AudioAlertsPanel` under `OperationsPanel`, showing recent current-tab
   decisions, counts, coalescing, sound state, and DND state.

3. **Historical telemetry and reporting**
   Optional follow-up if local diagnosis is insufficient. Add `audio_decision`
   to `src/core/telemetry.ts`, mirror it in
   `src/shared/contracts/client-message-schema.ts`, add it to `ALL_EVENT_TYPES`,
   and extend `src/core/telemetry-report.ts`.

STT lifecycle breadcrumbs and cross-tab BroadcastChannel merging are separate
future work unless a later incident proves they are needed.

## Future Work

### Redacted telemetry DTO

If telemetry is added, split local and telemetry models:

- local UI may show `taskName`, raw `agentId`, raw `taskId`, and raw `dedupeKey`
  because those are already visible in the dashboard
- telemetry should omit `taskName`
- telemetry should use `agentIdHash`, `taskIdHash`, and `dedupeKeyHash`
- telemetry should sample suppressed outcomes by low-cardinality fields such as
  `(source, outcome, anomalyType, severity, pageVisibility, soundEnabled, dndEnabled)`
- telemetry should enforce hard per-minute caps per tab

`/api/telemetry/report` should include an `audioDecisionSummary` with
`lastScheduled`, `lastRejected`, `recentScheduled` capped at 20,
`countsByOutcome`, and `countsBySource`. Recent entries should remain redacted
unless the report is explicitly scoped to local operator-only data.

### STT lifecycle observability

If operators confuse microphone capture with alert sounds, add a separate
`AudioActivityEvent` union:

```ts
type AudioActivityEvent =
  | { kind: 'alert_decision'; decision: LocalAudioAlertDecision }
  | { kind: 'stt_lifecycle'; phase: 'started' | 'stopped' | 'error' | 'timeout'; inputIdHash?: string; errorCode?: string };
```

STT error codes should be sanitized:
`permission_denied`, `permission_unavailable`, `ws_error`, `ws_closed`,
`audio_context_error`, `processing_timeout`, `unmount_cleanup`.

Do not log transcript text, audio levels, STT URL, raw browser error messages,
or unredacted input ids.

### Cross-tab decision sharing

Add `BroadcastChannel('kookr-audio-decisions')` so the operations panel can show
recent decisions from sibling Kookr tabs. This should not change chime policy;
it only improves diagnosis when the user inspects a different tab than the one
that made the sound.

### Device-level test

Add a "Test audio device" action that bypasses Kookr mute/DND but only after a
deliberate user click. It should record a distinct manual test event so it is
not confused with normal alert policy.

## Conclusion

The root fix is not "more logs everywhere." The useful abstraction is an
**audio alert decision**: a small, structured browser-local record created when
Kookr decides whether an alert chime should be scheduled.

V1 should be intentionally narrow: contextual `maybePlayChime`, a coalescing
local ring buffer, safe sound preference state, a last-reason tooltip on the
existing sound toggle, and tests. That is enough for the next incident to be
answerable from Kookr itself:

> Last alert: `finding` -> `scheduled`, `stale_agent` warning on
> `Deduplicate Chunk Embeddings in Indexing Operation` (+1 more), sound enabled,
> DND off, at 18:13.

That should be the acceptance bar before creating implementation issues.

## Critic Feedback Incorporated

- `design-minimalist` 2026-05-13: incorporated. Cut STT, server telemetry, and
  expanded operations UI from v1; made the first issue deliver the operator
  answer directly.
- `failure-mode/privacy` 2026-05-13: incorporated. Renamed `played` to
  `scheduled`, added AudioContext state fields, local coalescing, sound storage
  fallback, tab provenance, and redacted future telemetry guidance.
- `operability` 2026-05-13: incorporated. Added candidate-count/primary-cause
  correlation, current-tab labeling, deterministic manual test requirements,
  and explicit production-test criteria.
- `boundary/module-interface` 2026-05-13: incorporated. Clarified telemetry
  source of truth, kept STT out of alert-decision v1, required aggregate
  finding behavior preservation, added `useSyncExternalStore` snapshot API, and
  placed `AudioAlertsPanel` beside rather than inside `DetectionStatsPanel`.
