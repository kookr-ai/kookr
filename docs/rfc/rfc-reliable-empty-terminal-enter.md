# RFC: Reliable Empty Terminal Enter

## Status

**Draft (v4 - post-round-3 revision)** (2026-05-26)

---

## Problem

Kookr supports an ergonomic shortcut: pressing Enter on an empty agent input
prompt advances attention to the next finding or healthy task instead of
sending an empty message to the selected terminal session.

The shortcut is only safe when Kookr knows the selected terminal input is still
empty. The current implementation is browser-centric: `TerminalPanel` tracks
local typed draft bytes, scans rendered/replayed terminal text for empty
Claude/Codex prompt shapes, and uses a server-derived idle hint to cover
session-switch races before terminal replay has painted.

That approach has the wrong trust boundary:

- the browser cannot inspect Claude Code or Codex CLI's internal composer;
- PTY/WebSocket chunks can split ANSI controls and confuse visible-text
  heuristics;
- another Kookr service can write a draft, paste, retry Enter, STT text, or
  automation response after the browser observed an empty prompt;
- prompt readiness can become false without input bytes, for example when a
  permission dialog appears, a new tool call starts, or a session exits.

The reliable fix is not a better browser ANSI parser. It is a deterministic
server-side input boundary: Kookr should decide whether empty Enter is still
valid based on the serialized history of Kookr-controlled input writes and
server-owned prompt-ready state.

## Assumption

For this RFC, assume all writes to managed agent PTYs go through Kookr:

- browser terminal input;
- Kookr dashboard response input;
- remote relay terminal input;
- STT draft/input flows;
- adapter `sendInput` / `sendKeystroke`;
- launch prompt delivery and retry Enter;
- lifecycle/checkpoint follow-up input.

Direct external attachment to the dtach socket is out of scope. If an external
process writes directly to the PTY, Kookr cannot guarantee empty-input state
without cooperation from the terminal program or a lower-level PTY
instrumentation layer.

## Goals

1. Make empty-terminal Enter reliable under the "Kookr owns all writes"
   assumption.
2. Move the authoritative empty-input decision from browser heuristics to a
   server-side serialized input state machine.
3. Preserve the safe UX: empty prompt Enter advances; non-empty local draft
   Enter submits.
4. Keep Claude Code and Codex CLI unmodified for V1.
5. Make every Kookr PTY input write pass through one mandatory semantic writer
   boundary.
6. Prevent stale prompt-ready observations, stale browser snapshots, concurrent
   writes, duplicate intents, and permission/lifecycle state changes from
   causing accidental task switching.

## Non-Goals

- Do not modify Claude Code or Codex CLI binaries in V1.
- Do not parse full terminal screen state server-side.
- Do not detect input written outside Kookr's write path.
- Do not change terminal sharing authorization or remote controller leasing,
  except to route accepted writes through the same semantic writer.
- Do not make `TerminalBackend` own dashboard navigation semantics.

## Current Write Paths

Code inspection on `main` shows these PTY write surfaces:

- `src/server/session-bridge.ts`
  - browser binary frames and text frames call `backend.write`;
  - paste control frames call `backend.write` with bracketed-paste bytes.
- `src/server/remote-input-adapter.ts`
  - accepted remote submit commands call `terminalBackend.write`.
- `src/adapters/claude-code-adapter.ts`
  - `sendInput` calls `backend.writeSequence`;
  - `sendKeystroke` calls `backend.write`.
- `src/adapters/codex-cli-adapter.ts`
  - `sendInput` calls `backend.writeSequence`;
  - `sendKeystroke` calls `backend.write`.
- `src/adapters/agent-launch-context.ts`
  - launch prompt delivery uses `writeSequence`;
  - retry Enter uses `write`.
- `src/server/lifecycle-timers.ts`
  - checkpoint/automation actions call adapter `sendInput`.
- `src/server/ws-handlers/anomaly-handler.ts`
  - dashboard response input calls adapter `sendInput`;
  - permission keystrokes call adapter `sendKeystroke`.

The backend already serializes byte writes per session. This RFC keeps that
transport responsibility in `TerminalBackend` and adds semantic input state
above it.

## Recommendation

Introduce a `TerminalInputCoordinator` plus a narrow
`TerminalInputWriterPort`.

Split capability ports from browser-visible DTOs:

- `src/core/ports/terminal-input-writer-port.ts` owns
  `TerminalInputWriterPort`. This is a backend/application capability and must
  not be imported by frontend code.
- `src/shared/terminal-input-contract.ts` owns DTOs shared with the browser:
  input snapshots and `empty-enter-intent` request/response types.

The server composition root wires the coordinator as the port implementation.

```ts
interface TerminalInputWriterPort {
  writeInput(
    sessionId: string,
    bytes: Uint8Array,
    meta?: { reason?: string },
  ): Promise<TerminalInputWriteResult>;

  writeInputSequence(
    sessionId: string,
    payloads: Uint8Array[],
    meta?: { reason?: string },
  ): Promise<TerminalInputWriteResult>;
}
```

The closed write-kind taxonomy from earlier drafts is intentionally removed.
For the reliability invariant, every PTY byte write is input-affecting by
default. Resize is the explicit non-input exception and stays on
`TerminalBackend`.

`readinessVersion` is the single freshness watermark for the session input
state. It increments on every accepted input write and on every explicit
server-owned event that invalidates prompt readiness. A failed write does not
roll the version back. Empty Enter cannot advance again until a fresh
server-owned prompt-ready event marks the current version ready.

V1 readiness invalidators are explicit lifecycle/hook facts only:

- accepted input write;
- `UserPromptSubmit`;
- `PreToolUse` / tool start;
- `PermissionRequest`;
- `StopFailure`;
- `SessionEnd`;
- terminal disconnect, kill, unregister, or cleanup.

Generic terminal-output parsing is deferred. The implementation should not
classify arbitrary PTY output as readiness-affecting unless a later RFC defines
an authoritative signal.

## State Model

Each live terminal session has a small coordinator state:

```ts
type PromptStatus =
  | { kind: 'unknown' }
  | { kind: 'ready'; readinessVersion: number }
  | {
      kind: 'blocked';
      reason: 'permission' | 'running' | 'terminated' | 'disconnected';
    };

interface TerminalInputState {
  sessionId: string;
  inputStateEpoch: string;
  readinessVersion: number;
  prompt: PromptStatus;
}
```

`inputStateEpoch` is generated when the coordinator registers a session. It
changes after Kookr restart, session recreation, or any explicit coordinator
state reset. Browser intents and delayed prompt-ready marks must include both
epoch and readiness version.

Pending write queues, timestamps, and write-failure diagnostics are
implementation details. They do not belong in the public state model. A failed
write still leaves `prompt = { kind: 'unknown' }` and requires a fresh
server-owned ready mark before empty Enter can advance.

## Prompt-Ready Source

V1 prompt-ready marks use one conservative source:

> A parent-session `Notification(idle_prompt)` hook event marks prompt-ready for
> the current coordinator epoch/version, if no blocking state is active and no
> input write is queued or in-flight.

This signal is already documented as "confirmed idle" / waiting-for-input, and
the Codex fork documents Notification support for idle waiting. Plain `Stop` is
not a V1 prompt-ready source because it may be earlier than the actual
interactive prompt. A faster Stop-derived path can be added later only after a
canary proves, per provider, that the CLI composer is interactively ready before
Kookr marks readiness.

The prompt-ready source must capture the coordinator's current
`inputStateEpoch` and `readinessVersion` at observation time and pass them as
`observedEpoch` and `observedReadinessVersion`. The coordinator discards the
mark if either value is no longer current when processed.

Frontend pane semantics can decide whether the UI should attempt an
empty-enter intent, but frontend evidence must not call `markPromptReady`.

## Attention Selection Authority

Because the server owns the actual attention advance, the server must also own
the selection version it validates.

Each dashboard WebSocket connection gets server-side selection state:

```ts
interface DashboardSelectionState {
  connectionId: string;
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  selectionVersion: number;
}
```

Frontend selection changes are sent to the server. The server records the new
selected task/session and increments `selectionVersion`, then publishes the
snapshot back to the frontend. An `empty-enter-intent` is bound to the WebSocket
connection that sent it; the server must not trust a client-supplied
`connectionId`.

The attention advance use case must expose a compare-and-swap operation:

```ts
advanceIfSelectionStill({
  connectionId,
  taskId,
  sessionId,
  selectionVersion,
  intentId,
});
```

The selection check, duplicate-intent check, advance, and selection-version
increment happen in one serialized controller/store operation. Even if the
advance is a no-op because there is no next task, the operation consumes the
intent and advances the connection's `selectionVersion`. This prevents duplicate
valid intents from producing duplicate advances.

## Invariants

The core invariant is:

> Empty Enter may advance attention only when the WebSocket connection's current
> selected task/session/version, the terminal input-state epoch, and the
> readiness version all match the server's current state, and the prompt status
> is `ready`.

More concretely:

- `writeInput` and `writeInputSequence` always invalidate prompt readiness by
  advancing `readinessVersion` and setting `prompt = { kind: 'unknown' }`.
- explicit lifecycle invalidators advance `readinessVersion` and set `prompt =
  blocked` or `unknown`.
- recovery transitions also advance `readinessVersion`; a prompt-ready mark
  captured during a blocked state cannot become valid after recovery.
- `markPromptReady` can only install `ready` when the caller passes
  `observedEpoch` and `observedReadinessVersion` captured at observation time,
  and both still equal the current coordinator state.
- prompt-ready marks are rejected while a backend write is still queued or
  in-flight for the session.
- empty-enter intent, prompt-ready mark, input write acceptance, and readiness
  invalidation are serialized through the same per-session coordinator queue.
- stale, mismatched, unauthorized, unwritable, blocked, unknown, or session-gone
  empty-enter intents never write Enter and never advance.
- server attention advancement is atomic compare-and-swap on
  `(connectionId, taskId, sessionId, selectionVersion, intentId)`.

## Transitions

| Event | Precondition | State change | Notes |
|---|---|---|---|
| `registerSession` | new live session | new `inputStateEpoch`, readiness version `0`, prompt `unknown` | Kookr restart starts with no ready mark |
| `writeInputAccepted` | live writable session | readiness version `+1`, prompt `unknown` | Runs before backend write; internal queue tracks completion |
| `writeSucceeded` | pending write | no public state change | Does not restore prompt readiness |
| `writeFailed` | pending write | prompt `unknown` | Conservative; no rollback |
| `userPromptSubmitted` | authoritative hook event | readiness version `+1`, prompt `unknown` | Covers user input accepted by the CLI |
| `toolStarted` / `preToolUse` | authoritative hook event | readiness version `+1`, prompt `blocked(running)` | Running never forwards Enter |
| `permissionBlocked` | authoritative hook event | readiness version `+1`, prompt `blocked(permission)` | Empty Enter rejects |
| `stopFailure` | authoritative hook event | readiness version `+1`, prompt `unknown` | API/error state is not prompt-ready |
| `sessionDisconnected` / `sessionEnded` / `terminated` | any | readiness version `+1`, prompt `blocked(disconnected/terminated)` | Intents reject |
| `permissionResolved` | `blocked(permission)` or `unknown` | readiness version `+1`, prompt `unknown` | A later ready mark must observe the new version |
| `turnStopped` | `blocked(running)` or `unknown` | readiness version `+1`, prompt `unknown` | Stop is not enough for V1 readiness |
| `idlePromptObserved` | parent `Notification(idle_prompt)`; matching epoch/version; no queued/in-flight write; not blocked | prompt `ready(version)` | V1 prompt-ready source |
| `markPromptReady` stale | epoch or readiness version differs; write pending; or blocked | no ready mark | Log/drop |
| `emptyEnterIntent` valid | connection selection matches; prompt ready matches epoch/version | returns `valid-empty-enter` to application controller | Coordinator does not navigate |
| `emptyEnterIntent` stale/not-ready/blocked/mismatched | any mismatch, unknown prompt, blocked prompt, no state, unauthorized, unwritable, or session gone | returns explicit reject | Does not write Enter |
| `cleanupSession` | terminal lifecycle exit | delete coordinator state | Late intents for missing sessions reject |

Normal terminal input, including pressing Enter with a non-empty local draft,
does not use `emptyEnterIntent`; it goes through `writeInput`. That path still
increments readiness version and clears readiness.

## Empty Enter Protocol

The browser sends a structured request over the terminal WebSocket:

```json
{
  "type": "empty-enter-intent",
  "intentId": "uuid",
  "taskId": "task-123",
  "sessionId": "kookr-session-123",
  "selectionVersion": 17,
  "inputStateEpoch": "epoch-abc",
  "observedReadinessVersion": 42
}
```

The coordinator returns an input decision. It does not return or send a
navigation command:

```ts
type EmptyEnterDecision =
  | {
      kind: 'valid-empty-enter';
      intentId: string;
      taskId: string;
      sessionId: string;
      inputStateEpoch: string;
      decisionReadinessVersion: number;
    }
  | {
      kind: 'rejected';
      intentId: string;
      sessionId: string;
      reason:
        | 'stale-epoch'
        | 'stale-readiness-version'
        | 'not-ready'
        | 'blocked'
        | 'not-writable'
        | 'unauthorized'
        | 'session-gone';
    };
```

The server application/controller layer above the coordinator owns attention
routing. It handles `empty-enter-intent` by:

1. reading the sender connection's server-owned selection state;
2. rejecting immediately if the request task/session/selection version do not
   match that state;
3. asking the coordinator for an `EmptyEnterDecision`;
4. invoking `advanceIfSelectionStill` only for `valid-empty-enter`.

The coordinator never imports dashboard navigation or attention-queue logic.
The frontend never advances attention from a coordinator response; it waits for
the normal application state update. This removes stale browser navigation from
the authority path while keeping navigation out of the coordinator itself.

## Frontend Contract

`TerminalPanel` receives a dedicated `TerminalInputSnapshot`, not raw fields
folded into general task state:

```ts
interface TerminalInputSnapshot {
  sessionId: string;
  taskId: string;
  selectionVersion: number;
  inputStateEpoch: string;
  readinessVersion: number;
  promptReady: boolean;
}
```

This snapshot is composed at the WebSocket/API boundary for the selected
session. It is not persisted in `TaskStore`.

On Enter:

1. If local draft bytes are non-empty, send normal Enter through the terminal
   input path.
2. Otherwise send `empty-enter-intent` with the latest snapshot selection
   version, epoch, and readiness version.
3. If the response is `rejected`, do nothing locally for stale/gone cases unless
   diagnostics are enabled.
4. Wait for the normal application snapshot to reflect any server-side attention
   advance.

Frontend pane semantics can remain as a display hint or an optimization to avoid
obviously wrong intents, but it is not authoritative.

## Backend Contract

`TerminalInputCoordinator` responsibilities:

- implement `TerminalInputWriterPort`;
- wrap `TerminalBackend.write` and `writeSequence`;
- serialize write acceptance, prompt-ready marks, readiness invalidators, and
  empty-enter intents through one per-session queue;
- increment readiness version before backend writes are attempted;
- consume authoritative lifecycle/hook events that invalidate readiness;
- expose `markPromptReady(sessionId, { observedEpoch,
  observedReadinessVersion })`;
- expose invalidators and recovery methods for
  permission/running/terminated/disconnected states;
- expose `getSnapshot(sessionId)` for API/WebSocket composition;
- expose `handleEmptyEnterIntent(request)` returning `EmptyEnterDecision`;
- delete state on all terminal lifecycle exits.

The coordinator should not own:

- terminal process lifecycle;
- raw PTY attach mechanics;
- attention queue selection;
- dashboard navigation;
- permission authorization policy.

## Boundary Enforcement

Reliability depends on every Kookr PTY input write passing through the
coordinator. This is a requirement, not an open question.

Implementation should enforce the boundary in three ways:

1. Composition: only `TerminalInputCoordinator` receives an input-capable
   backend writer. Application modules receive `TerminalInputWriterPort` plus
   separate read/capture/lifecycle capabilities when needed.
2. Type/API split: modules that do not own terminal input cannot retain raw
   `TerminalBackend` just because they also need non-write backend operations.
3. Static guard: add an AST/type-aware source regression test that rejects
   direct `.write` / `.writeSequence` calls on `TerminalBackend` or concrete
   backend implementations outside:
   - terminal backend implementations;
   - `TerminalInputCoordinator`;
   - backend-focused tests/fakes.

The static guard must include fixtures for aliasing and concrete-backend
bypasses. An ESLint rule can replace or supplement the test later if direct
write regressions become common. Resize, capture, lifecycle, and subscription
capabilities stay separate from the write port.

## Thin Vertical Slice

The first implementation should not ship partial coordinator plumbing while the
frontend still has final authority. Ship one vertical slice, optionally behind a
feature flag:

1. Add `TerminalInputWriterPort`, browser protocol types, and
   `TerminalInputCoordinator`.
2. Add server-owned dashboard connection selection state plus
   `advanceIfSelectionStill`.
3. Route known write paths through the coordinator.
4. Add hook/lifecycle invalidators and conservative
   `Notification(idle_prompt)` prompt-ready marks.
5. Add `TerminalInputSnapshot` for the selected session.
6. Add `empty-enter-intent` request/response and server-controller routing.
7. Update `TerminalPanel` to send the structured intent and wait for state.
8. Add type/API boundary enforcement and focused regression tests.

## Acceptance Criteria

- Every accepted PTY input write path increments `readinessVersion` before
  attempting the backend write.
- Empty Enter with stale epoch/version, blocked prompt, unknown prompt, wrong
  task/session, stale selection, missing session, unauthorized session, or
  unwritable session rejects and does not write `\r`.
- Empty Enter never forwards Enter. Normal Enter uses the standard terminal
  input path only when the local draft is non-empty.
- Only parent `Notification(idle_prompt)` can mark prompt-ready in V1.
- Stop-derived readiness is disabled unless a provider-specific canary proves
  the interactive empty prompt is available before the ready mark.
- Selection advance uses atomic compare-and-swap and consumes duplicate intents.
- Boundary tests fail if any non-allowlisted module writes directly to a raw or
  concrete terminal backend.

## Edge Cases

### Another Kookr Service Writes Draft Text

The write is accepted through the coordinator, readiness version advances, and
prompt-ready clears. A browser empty-enter intent that observed the old version
is rejected instead of advancing or forwarding Enter.

### Prompt-Ready Signal Arrives Late

The observer captured epoch `E` and readiness version `V`, but a write or
invalidating lifecycle event advanced the coordinator before the mark is
processed. The coordinator rejects the ready mark.

### Ready Mark Captured During Blocked State

Recovery from `blocked(running)` or `blocked(permission)` increments
`readinessVersion` before returning to `unknown`. A delayed ready mark captured
while blocked no longer matches and is rejected.

### Remote Write Races Empty Enter

Both operations are serialized through the coordinator queue. If the write is
ordered first, empty Enter is stale and cannot advance. If empty Enter is
ordered first and valid, the server application controller attempts the
selection CAS; a later write then invalidates future prompt-ready state.

### Duplicate Empty-Enter Intents

Two identical valid intents can both receive coordinator approval, but only one
can win `advanceIfSelectionStill`. The first accepted advance consumes the
intent and increments `selectionVersion`; the second sees a stale selection or
duplicate intent and does not advance.

### Permission Prompt Appears Without Input

The server invalidator sets `prompt = blocked(permission)` and increments
`readinessVersion`. Empty Enter rejects until the permission state resolves and
a new server-owned `Notification(idle_prompt)` prompt-ready mark is accepted.

### Running State Recovers

`PreToolUse` sets `blocked(running)`. `Stop` moves the session back to
`unknown`, not directly to `ready`; a fresh `Notification(idle_prompt)` mark
must still pass epoch/version checks.

### User Switches Task While Intent Is In Flight

The request includes `selectionVersion` and is bound to the sender WebSocket
connection. `advanceIfSelectionStill` checks and updates selection atomically.
Late intents after manual selection changes reject as stale selection and do
not advance.

### Kookr Restart

The coordinator registers sessions with a new `inputStateEpoch` and no
prompt-ready mark. Old client intents with a previous epoch reject and do not
write Enter.

### Write Failure

Readiness version is not rolled back. Prompt-ready remains unknown. If
diagnostics are enabled, Kookr records the failed input attempt. A fresh
server-owned prompt observation is required before empty Enter can advance
again.

### Session Cleanup

Cleanup deletes coordinator state for completed tasks, aborted tasks, deleted
records, adapter exits, backend detach/session-gone events, kill/unregister, and
server restart recovery. Late intents for missing sessions reject as
`session-gone`.

## Testing Strategy

Coordinator unit tests:

- write acceptance increments readiness version and clears readiness;
- resize/non-input operations do not affect readiness version;
- hook/lifecycle invalidators increment readiness version and invalidate ready;
- prompt-ready mark accepts only matching epoch and readiness version;
- prompt-ready mark rejects while a write is queued or in-flight;
- permission/running/terminated invalidators block advancement without writes;
- `Stop` and `permissionResolved` recover only to `unknown` and increment
  readiness version;
- parent `Notification(idle_prompt)` can mark ready;
- child, foreign, or stale `Notification(idle_prompt)` events cannot mark ready;
- valid empty-enter intent returns `valid-empty-enter`;
- stale version, stale epoch, wrong session, and wrong task intents reject and
  do not write Enter;
- empty-enter intent for unknown or blocked prompt rejects and does not write
  Enter;
- concurrent write vs empty-enter intent is serialized deterministically;
- failed write keeps readiness version advanced and clears prompt-ready;
- cleanup rejects late intents.

Routing/controller tests:

- `SessionBridge` binary/text/paste input uses the coordinator;
- `remote-input-adapter` submit uses the coordinator;
- Claude/Codex adapter `sendInput` and `sendKeystroke` use the port;
- launch prompt delivery and retry Enter use the port;
- server records per-connection selection state and increments
  `selectionVersion` on selection changes;
- `advanceIfSelectionStill` advances only when selection still matches;
- duplicate valid intents produce at most one attention advance;
- selection changing after coordinator approval but before advance causes CAS
  rejection.

Frontend tests:

- local draft non-empty sends normal Enter;
- empty local draft sends intent with selection version, epoch, and readiness
  version;
- rejected stale/blocked/not-ready responses do not locally navigate;
- frontend does not run the attention advance handler directly.

Boundary tests:

- scan source with AST/type awareness for direct writes on raw
  `TerminalBackend` or concrete backend types outside the allowlist;
- include fixtures for method aliasing and concrete backend variables;
- assert mixed read/write modules receive `TerminalInputWriterPort` plus
  separate non-write capabilities instead of raw backend write access.

## Alternatives Considered

### Keep Improving Browser Pane Heuristics

Rejected as the primary fix. Heuristics can reduce unnecessary intents but
cannot prove no Kookr writer changed the composer after the browser observation.

### Modify Claude Code And Codex CLI

Deferred. A true semantic API from each TUI, such as "composer buffer is empty",
would be stronger but requires maintaining fork/tool-specific behavior. The
coordinator solves the current reliability target under the Kookr-owned-writes
assumption.

### Put Generation Tracking Inside `TerminalBackend`

Rejected for V1. `TerminalBackend` is the byte-level session I/O hub. It should
not understand prompt-ready state or empty-enter navigation. The coordinator
above it owns semantic input invalidation while delegating byte transport to the
backend.

### Rely On Remote Command `baseRevision`

Insufficient. Remote input already has revision checks, but local browser input,
adapter retry Enter, launch prompt delivery, and dashboard input are outside the
remote command protocol. Empty-enter needs session-wide readiness tracking.

### Forward Enter On Stale Empty-Enter Intent

Rejected. A stale intent means the user intended navigation from an observation
Kookr can no longer prove. Forwarding Enter could submit hidden text, accept a
permission prompt, or send an empty message. Normal Enter remains available only
through the standard terminal input path, for example when the local draft is
non-empty.

### Use Stop As V1 Prompt-Ready

Rejected for the reliable V1 path. `Stop` proves the agent turn ended; it does
not by itself prove the TUI composer has returned to an interactive empty
prompt. `Stop` can be used later only with provider-specific empirical proof.

## Files To Change

- `src/core/ports/terminal-input-writer-port.ts`: define
  `TerminalInputWriterPort`.
- `src/shared/terminal-input-contract.ts`: define `TerminalInputSnapshot` and
  empty-enter protocol DTOs.
- `src/server/terminal-input-coordinator.ts`: new coordinator.
- server dashboard selection/controller module: add per-connection selection
  state and `advanceIfSelectionStill`.
- `src/server/session-bridge.ts`: route terminal input frames and
  `empty-enter-intent`.
- `src/server/bootstrap/start-http-and-websockets.ts`: wire coordinator and
  selection controller.
- `src/server/remote-input-adapter.ts`: depend on semantic writer port.
- `src/adapters/claude-code-adapter.ts` and `src/adapters/codex-cli-adapter.ts`:
  receive/use the writer port without importing server modules.
- `src/adapters/agent-launch-context.ts`: route launch writes through the port.
- `src/server/use-cases/agent-input.ts` and
  `src/server/ws-handlers/anomaly-handler.ts`: ensure dashboard input uses the
  same boundary.
- hook/event pipeline integration points: emit invalidators and parent
  `Notification(idle_prompt)` prompt-ready marks.
- `src/frontend/components/TerminalPanel.tsx`: send intent and stop local
  navigation.
- Tests around each changed module plus the boundary guard.

## Empirical Checkpoint

Round 1 and round 2 claims are structural design claims plus direct code-path
inspection. Round 3 prompted one concrete code/doc check: Kookr already parses
`Notification(idle_prompt)`, treats it as a confirmed idle overlay, and repo
docs describe Codex fork Notification support for idle waiting. The
implementation task should still run an adapter canary for both Claude Code and
Codex CLI before enabling the shortcut.

## Critic Feedback Incorporated

- `design-minimalist` 2026-05-26 round 1: incorporated. Collapsed the four-phase
  plan into one thin vertical slice, removed the closed `TerminalInputKind`
  taxonomy, removed diagnostic endpoints, made same-WS intent response the
  default protocol, and downgraded frontend pane semantics from authority to
  hint.
- `boundary-critic` 2026-05-26 round 1: incorporated. Moved navigation ownership
  out of the coordinator, clarified server-owned prompt-ready evidence,
  introduced a port outside `src/server` for adapter dependency direction, made
  write-boundary enforcement a requirement, and separated
  `TerminalInputSnapshot` from `TaskStore`.
- `failure-mode-analyst` 2026-05-26 round 1: incorporated. Added non-input
  invalidators, observed-generation rejection for delayed marks, per-session
  serialization, epoch matching, stale response binding, explicit reject
  outcomes, conservative write failure behavior, pending-write handling, and
  broad lifecycle cleanup.
- `state-machine-verifier` 2026-05-26 round 1: incorporated. Added explicit state
  model, invariants, transition table, epoch/generation matching, blocking
  prompt status, serialized operations, and model-style test requirements.
- Round 2 incorporated: selected a shared contract module for browser DTOs,
  removed public pending/write-status fields, deferred backend pane semantics,
  deleted tombstones, added stale-observation freshness, epoch-bound ready
  marks, reject-only stale empty-enter handling, transient blocked recovery
  transitions, server-controller navigation, and source-scan boundary
  enforcement as the first guard.
- Round 3 incorporated: collapsed input/output freshness into one
  `readinessVersion`, deferred generic terminal-output freshness, removed
  diagnostic `observedAt` from state, split backend capability ports from shared
  browser DTOs, added server-owned per-connection selection state, required
  atomic `advanceIfSelectionStill`, chose parent `Notification(idle_prompt)` as
  the V1 readiness source, required type/API boundary enforcement, and added
  duplicate-intent and blocked-recovery tests.
