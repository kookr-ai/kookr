# State Machine Catalog

## Purpose

Document the major stateful entities in Kookr V1 and their legal state transitions.

## Major Stateful Entities

Core attention-loop stateful entities: **Task**, **Agent Session**, **Attention Event**, and **Snooze Timer**.

> Updated 2026-05-09: The original catalog covered the V1 attention loop. The implemented codebase now also contains operational state machines for checkpoint cycling, Ralph loops, schedules, workspace attempts, quota polling, and watchdog verdicts. Those are summarized in the "Additional Operational State Machines" section below.

**Key distinction:** A Task is the *goal* ("fix the auth bug"). An Agent Session is one *attempt* at that goal. A task may go through multiple agent sessions — an agent can error out, get stuck, or only partially complete the work, and the developer relaunches with a new or modified prompt. This is analogous to GitHub/GitLab issues: the issue exists independently of any branch or PR attempt.

### 1. Task Lifecycle

A task represents a unit of work the developer wants accomplished. It is created when the developer launches an agent, and it persists beyond any individual agent session.

```mermaid
stateDiagram-v2
  [*] --> Open: Developer creates task (launches first agent)

  Open --> InProgress: Agent session started (slot available)
  Open --> Pending: Agent session started (concurrency limit reached)
  Pending --> InProgress: Slot opens (promotePendingTasks)
  Pending --> Cancelled: Launch failure
  InProgress --> Open: Agent session ended without completing the task
  InProgress --> Completed: Developer marks task as done
  InProgress --> Terminated: Reconciliation detects all sessions dead without user ack
  InProgress --> Cancelled: Developer cancels task

  Open --> Terminated: Reconciliation backfill (open task, all sessions dead)
  Open --> Cancelled: Developer cancels before any agent runs

  Terminated --> Completed: Developer acknowledges (ackTerminatedTask)
  Terminated --> Open: Developer reopens task
  Terminated --> Cancelled: Developer cancels

  Completed --> Open: Developer reopens task
  Cancelled --> Open: Developer reopens task
```

**Transition table:**

| From | Event | To | Triggered By | Notes |
|---|---|---|---|---|
| - | create_task | Open | Developer via GUI (launch agent dialog) | Task = prompt + cwd + optional completion criteria |
| Open | agent_launched | InProgress | Agent adapter (agent session starts, slot available) | Task now has an active agent working on it |
| Open | agent_launched_at_capacity | Pending | Server (concurrency limit `MAX_ACTIVE_TASKS` reached) | Task queued; agent will launch when a slot opens |
| Pending | slot_opens | InProgress | Server (`promotePendingTasks` after a task completes/cancels) | Pending task promoted to active |
| Pending | launch_failure | Cancelled | Server (agent launch fails during promotion) | |
| InProgress | agent_session_ended | Open | Agent adapter (session completed/errored) | Task reverts to Open; developer decides next step |
| InProgress | all_sessions_dead | Terminated | Reconciliation (all sessions dead; no user ack yet) | Since rfc-task-loss-prevention the auto-path lands in `terminated`, not `completed`. `reconciliation.ts:147-157` |
| Open | all_sessions_dead | Terminated | Reconciliation backfill (`open` task with only dead sessions is transitioned via `startTask` then `terminateTask` in one pass — `reconciliation.ts:152-156`) | Covers the edge case where a task reverted to Open but all sessions subsequently died. Updated 2026-04-22 |
| InProgress | mark_complete | Completed | Developer via GUI (`completeTask`) | Developer reviewed the work and is satisfied |
| InProgress | cancel | Cancelled | Developer via GUI | Kills active agent if running |
| Terminated | ack_terminated | Completed | Developer via GUI (`ackTerminatedTask`) | User has seen the terminated task and accepts it as done |
| Terminated | reopen | Open | Developer via GUI | User wants to continue — a new session can be launched |
| Terminated | cancel | Cancelled | Developer via GUI | User discards a terminated task outright |
| Open | cancel | Cancelled | Developer via GUI | No agent running; just close the task |
| Completed | reopen | Open | Developer via GUI, **or** crash-recovery (`src/server/crash-recovery.ts:156-157`) auto-reopens a `completed` / `terminated` task when a surviving session is discovered after a Kookr restart | Work wasn't right; needs another attempt |
| Cancelled | reopen | Open | Developer via GUI | Changed mind; task is needed after all |

**Key design notes:**

- **Pending state** (added 2026-03-29): When the concurrency limit is reached, new tasks enter `Pending` instead of `InProgress`. They are promoted automatically when a slot opens. This prevents resource exhaustion when many tasks are launched simultaneously.
- **InProgress → Open (not Completed)** when an agent session ends. The agent finishing its process does not mean the task is done — the developer must explicitly mark the task as complete. This avoids false positives where the agent ran to completion but produced wrong results.
- **Terminated state** (added 2026-04-22 to this catalog to match long-standing code; state itself introduced by `rfc-task-loss-prevention.md`). When reconciliation finds every session for an `InProgress` / `Open` task dead, the task transitions to `Terminated` — *not* `Completed`. This split exists so silent tmux/dtach deaths (WSL glitches, OOM kills, external `tmux kill-server`) cannot propagate through "Clear completed" and permanently delete work the user never saw. The user then `ackTerminatedTask`s (→ `Completed`), reopens (→ `Open`), or cancels (→ `Cancelled`). See `docs/architecture.md` § "Task lifecycle — `completed` vs `terminated`" and `src/core/tasks.ts:103-110, 194-199` for the allowed transitions.
- **Multiple agent sessions per task.** A task in Open state can have a new agent launched against it (retry with modified prompt, different approach, etc.). The task tracks its history of agent sessions.
- **Completion criteria** are optional hints. When provided, the supervisor can flag "agent completed but criteria not met" as an attention event. But the developer always has final say.
- **Cleanup:** "Clear completed" sweeps `Completed` and `Cancelled` tasks. `Terminated` tasks are NOT swept by default — the user must opt in via the confirmation checkbox — for the same data-loss reason the state was introduced.
- **Resolved 2026-04-10:** the previously-documented `Pending → InProgress` promotion bug is fixed. `addSession()` (`src/core/tasks.ts:235-249`) auto-transitions both `'open'` and `'pending'` tasks to `'inProgress'`, and `promotePendingTasks` (`src/server/agent-lifecycle.ts:273-309`) drives the promotion loop up to `MAX_ACTIVE_TASKS`.

### 2. Agent Session Lifecycle

An agent session is one execution attempt against a task. Launched by Kookr in a managed terminal session (ADR-007).

```mermaid
stateDiagram-v2
  [*] --> Starting: Launch from GUI (linked to a task)

  Starting --> Running: Terminal output detected (agent active)

  Running --> WaitingForInput: Agent blocks waiting for developer input
  Running --> Stuck: Supervisor detects anomaly (loop, repeated error)
  Running --> Errored: Agent error event
  Running --> Completed: Agent process exits in terminal session
  Running --> Snoozed: Developer snoozes agent

  WaitingForInput --> Running: Developer sends terminal input bytes
  WaitingForInput --> Snoozed: Developer snoozes agent

  Stuck --> Running: Developer sends terminal input bytes
  Stuck --> Snoozed: Developer snoozes agent

  Snoozed --> Running: Snooze timer expires, supervisor resumes polling
  Snoozed --> Completed: Agent finishes while snoozed (process exit still detected)

  Errored --> [*]: Developer acknowledges
  Completed --> [*]

  note right of Snoozed
    Supervisor pauses polling.
    Process keeps running.
    Exit still detected.
  end note
```

**Transition table:**

| From | Event | To | Triggered By | Notes |
|---|---|---|---|---|
| - | launch | Starting | Developer via GUI | Always linked to a task; creates terminal session |
| Starting | terminal_output_detected | Running | Agent adapter (first terminal output) | |
| Running | waiting_for_input | WaitingForInput | Agent adapter (agent blocks for input) | Interactive mode: agent natively blocks |
| Running | anomaly_detected | Stuck | Supervisor (rule-based check) | |
| Running | error_event | Errored | Agent adapter (terminal error output) | |
| Running | process_exit | Completed | Agent adapter (process exits in terminal) | |
| Running | snooze | Snoozed | Developer via GUI | Optional reason + duration |
| WaitingForInput | input_sent | Running | Developer via GUI -> `AgentAdapter.sendInput()` | Input delivered to running agent via terminal backend byte write |
| WaitingForInput | snooze | Snoozed | Developer via GUI | |
| Stuck | input_sent | Running | Developer via GUI -> `AgentAdapter.sendInput()` | Input delivered to running agent via terminal backend byte write |
| Stuck | snooze | Snoozed | Developer via GUI | |
| Snoozed | snooze_expired | Running | Snooze timer | Supervisor resumes polling, re-evaluates |
| Snoozed | process_exit | Completed | Agent adapter (process exit in terminal) | Terminal session still monitored during snooze |

**Implementation note (updated 2026-05-09):** The diagram above is conceptual only. The `AgentStatus` type exists in `src/core/types.ts` but is **not used as a live state machine** in the current implementation. The supervisor's actual agent state is expressed through:
1. `AgentState.anomaly` in `monitor.ts` — presence/absence and type of the current anomaly
2. `AgentState.snoozedUntil` — set via `AttentionQueue.getSnoozedUntil()`
3. `SessionInfo.lastStatus` in `tasks.ts` — used only for terminal session states (`'completed'`, `'aborted'`)

The documented state machine above represents historical **conceptual design**, not executable transition logic. In practice, `WaitingForInput` is not a member of the `AgentStatus` union — the `needs_input` anomaly type serves this role instead. `Snoozed` is tracked as a queue-level property (`snoozedUntil`), not as an `AgentStatus` value. The `Starting → Running` transition has no code path — agents are registered directly with the monitor. See `subsystems/supervisor-agent/03-state-machines.md` for the implementation state model.

**Key design implications:**
- **Snooze** is managed at the attention queue level, not as an agent status transition. The agent process continues running in its terminal session. Process exit is still detected because the adapter monitors the terminal session independently.
- The distinction between `WaitingForInput` and `Errored` is expressed through anomaly types (`repeated_error`, `needs_input`, `permission_blocked`) rather than `AgentStatus` transitions. Stuck-loop detection is deferred to V2 AI supervisor.
- **`'aborted'` is a production `SessionInfo.lastStatus` value** written by `cancelTask` (`src/server/agent-lifecycle.ts:196-199`). Reconciliation (`src/server/reconciliation.ts:65`) and `tasks.ts:352` both branch on it to avoid treating cancelled sessions as live. It is NOT in the `AgentStatus` union in `src/core/types.ts:191-197`; it only exists in the extended `SessionInfo.lastStatus` type at `src/core/tasks.ts:34`. Treat the session-level lifecycle as `{'completed' | 'aborted'}` in `lastStatus`, independently of the conceptual `AgentStatus` transitions above.

**Relationship to tasks:**
- Every agent session belongs to exactly one task.
- When an agent session ends normally, lifecycle code can return the parent task to `Open` so the developer can mark complete, relaunch, or cancel.
- When reconciliation finds every session for an `Open` or `InProgress` task dead without user acknowledgement, the task transitions to `Terminated`.
- Killing an agent (via stop or task cancel) marks the session `aborted` and prevents reconciliation from treating that session as live.

### 3. Attention Event Lifecycle

An anomaly detected by the supervisor that requires developer attention. The developer can respond, skip, or snooze.

```mermaid
stateDiagram-v2
  [*] --> Pending: Supervisor raises alert

  Pending --> Viewed: Developer navigates to agent
  Pending --> Resolved: Agent self-resolves (status changes)
  Pending --> Stale: Agent completed before developer saw it

  Viewed --> Resolved: Developer responds
  Viewed --> Skipped: Developer skips (back of queue)
  Viewed --> Snoozed: Developer snoozes (removed from queue + timer)
  Viewed --> Resolved: Agent self-resolves

  Skipped --> Viewed: Developer returns to this agent (queue cycles back)
  Skipped --> Resolved: Agent self-resolves while skipped
  Skipped --> Resolved: New anomaly detected (resets skip, re-enters at normal priority)

  Snoozed --> Pending: Snooze timer expires (supervisor re-evaluates)
  Snoozed --> Resolved: Agent completes while snoozed

  Stale --> [*]
  Resolved --> [*]
```

**Transition table:**

| From | Event | To | Triggered By |
|---|---|---|---|
| - | anomaly_detected | Pending | Supervisor |
| Pending | developer_navigates | Viewed | SPA navigation |
| Pending | agent_status_change | Resolved | Agent moved on |
| Pending | agent_completed | Stale | Agent finished before developer saw alert |
| Viewed | response_sent | Resolved | Developer responds via terminal backend byte write |
| Viewed | developer_skips | Skipped | Developer clicks Skip; auto-advance to next |
| Viewed | developer_snoozes | Snoozed | Developer clicks Snooze + picks duration; auto-advance |
| Viewed | agent_status_change | Resolved | Agent self-resolves |
| Skipped | queue_cycles_back | Viewed | All higher-priority alerts handled; this one resurfaces |
| Skipped | agent_status_change | Resolved | Agent state changed while skipped |
| Skipped | new_anomaly | Resolved | New anomaly replaces old one (skip count resets) |
| Snoozed | snooze_expired | Pending | Timer fires; supervisor re-polls and decides if alert is still valid |
| Snoozed | agent_completed | Resolved | Process exited while snoozed |

**Implementation note (updated 2026-03-29):** The `Viewed` and `Stale` states are **not implemented** in the current code. In practice:
- **Viewed** has no tracking — `navigate` messages log to the interaction log but do not change queue state. Skip/snooze/respond work from any state, not just Viewed.
- **Stale** has no distinct representation — when an agent completes before the developer sees the alert, `queue.remove()` is called (same as Resolved). The distinction exists only in this documentation.
- Both `Pending` and `Skipped` are implicit states: `Pending` = entry in queue with `skipped: false`; `Skipped` = entry with `skipped: true`.

### 4. Snooze Timer

Lightweight entity: just a `(agentId, expiresAt, reason?)` tuple managed by the attention router.

```mermaid
stateDiagram-v2
  [*] --> Active: Developer snoozes agent

  Active --> Expired: Timer fires
  Active --> Cancelled: Developer manually wakes agent, or agent completes

  Expired --> [*]
  Cancelled --> [*]
```

**Implementation note (updated 2026-04-10):** The `Active → Cancelled` transition via "developer manually wakes agent" is implemented end-to-end. The `cancelSnooze` WebSocket message (`src/shared/contracts/messages.ts:87`) is handled in `src/server/ws.ts:375` and calls `AttentionQueue.cancelSnooze(agentId)` (`src/core/attention-queue.ts:74`). A snooze can therefore be cancelled by (a) the developer manually, (b) agent completion (`unregisterAgent` → `remove`), or (c) the timer firing.

**Implementation note (updated 2026-05-09):** Snooze does **not** pause supervisor monitoring. Hook events and watchdog verdicts continue flowing through `Monitor`; `AttentionQueue.enqueue()` updates the stored snoozed anomaly and keeps it out of the active queue until expiry/manual wake/purge.

### Additional Operational State Machines

| Entity | States | Owner | Notes |
|---|---|---|---|
| Checkpoint cycle | `idle`, `prompting`, `compacting` plus session-scoped `gaveUp` | `src/core/checkpoint-cycler.ts` | Sends the checkpoint prompt when transcript context crosses the trigger ratio, then sends `/compact` after a Stop event. Repeated no-progress compact attempts set `gaveUp` for that session |
| Ralph loop | `running`, `paused`, `completed`, `failed`, `cancelled` | `src/core/ralph-cycler.ts`, `src/server/ralph-loop-service.ts` | Terminal states prevent further iteration injection. `paused` preserves the loop but does not launch a fresh runtime until explicitly resumed |
| Schedule execution receipt | `reserved`, `accepted`, `terminal`, `unknown_after_restart` | `src/core/schedule.ts`, `src/server/schedule-runner.ts` | Latest execution outcomes further classify queued/running/completed/cancelled/deduplicated/skipped/failed states for the UI |
| Workspace attempt | `running`, `passed`, `blocked`, `timed_out`, `cancelled`, `superseded`, `completed` | `src/core/workspace-attempt-repository.ts` | Durable cleanup/preflight/diagnostic attempt records, separate from task lifecycle |
| Quota poller | `idle`, `polling`, `healthy`, `backoff`, `auth_failed`, `disabled` | `src/adapters/quota-adapter.ts` | Polling state for Anthropic OAuth usage quota, with backoff on 429/network/schema failures |
| Watchdog verdict | `healthy`, `grace_period`, `needs_input`, `permission_blocked`, `tool_running`, `quiet_working`, `mcp_starting`, `stale_agent`, `hook_disconnected` | `src/core/watchdog.ts` | Verdict union is converted into queue anomalies by `Monitor.applyWatchdogVerdict()` when actionable |

## Transition Ownership Table

| Entity | Owner of transitions | Persistence |
|---|---|---|
| Task | Core (tasks.ts) — developer actions + agent session events | Persisted (tasks.json) |
| Agent Session | Agent adapter (raw events) + Supervisor (derived states) | Persisted (inline in tasks.json) — ADR-008 |
| Attention Event | Supervisor (creation) + Attention Router (skip/snooze/resolution) | In-memory |
| Snooze Timer | Attention Router | In-memory |

**Startup reconciliation (ADR-008, updated for ADR-014 on 2026-04-22; tmux removed 2026-04-24):** On startup, session state is reconciled from tasks.json (which includes inline session metadata) + `TerminalBackend` liveness queries. Reconciliation queries only `LocalDtachBackend` (see `src/server/reconciliation.ts`) — V8 removed the tmux backend and `src/server/start.ts` hard-rejects `KOOKR_BACKEND=tmux`. Sessions with a live dtach socket are reconnected; sessions without one are marked `terminated` (per rfc-task-loss-prevention). Snooze timers and attention events are ephemeral and rebuilt from reconciled session states.

## Illegal Or Ambiguous Transitions

| Transition | Why Illegal/Ambiguous |
|---|---|
| Agent Session: Completed -> Running | Final state for a session. To retry, launch a new session against the same task |
| Task: InProgress -> Completed (automatic) | Not allowed. Reconciliation transitions to `Terminated`, not `Completed`, when every session dies without user ack — see the transition table and the "Terminated state" design note. The only auto-completion is the `Terminated → Completed` user-driven `ackTerminatedTask` |
| Task: Completed/Cancelled/Terminated -> InProgress | Must reopen first (-> Open), then launch agent (Open -> InProgress) |
| Task: Terminated -> Pending / InProgress directly | Not allowed. `Terminated` exits via `ackTerminatedTask`, `reopen`, or `cancel` only — see `src/core/tasks.ts:108` |
| Snoozed -> Stuck | Not allowed directly. Snooze expiry transitions to Running; the supervisor then re-evaluates on next poll cycle and may re-detect an anomaly |
| Skip while Snoozed | Not applicable — snoozed agents are not in the queue |

## Deferred Edge Cases

| Edge Case | Why Deferred |
|---|---|
| Developer skips all agents without snoozing | Skipped agents cycle after the active tier is empty. No distinct `AllSkipped` state is implemented; automatic dampening deferred to later |
| Auto-complete tasks based on completion criteria | V1 always requires explicit developer confirmation. Auto-complete based on criteria matching is a V2 supervisor feature |

## Known Issues Affecting This Model

| Issue | Impact | Status |
|---|---|---|
| **#3** AskUserQuestion is non-blocking | **Resolved by ADR-007.** Interactive mode is natively blocking — agent waits for input. WaitingForInput is now a first-class state | Resolved (ADR-007) |
| **#5** Session ID mismatch on error | **Resolved by ADR-007.** No more session resume; agents run continuously in terminal sessions | Resolved (ADR-007) |
| **#6** Resume cost accumulation | **Resolved by ADR-007.** No more `--resume` calls — agent runs in a single continuous interactive session | Resolved (ADR-007) |
| **#9** Resume race conditions | **Resolved by ADR-007.** No more resume subprocess — input delivered through the terminal backend's byte-write path to the running process | Resolved (ADR-007) |

## Evidence

- `docs/architecture.md` — Agent Session Lifecycle section (state diagram)
- `docs/architecture.md` — AgentStatus type definition (Backend ↔ Coding Agents section)
- `docs/architecture.md` — Backend section (task storage design)
- `docs/features.md:60-73` — F2 anomaly detection features
- `docs/features.md:76-85` — F3 respond & advance
- `docs/features.md:88-95` — F4 agent lifecycle, task storage, completion criteria
- `docs/adr/006-permission-mode-feasibility.md` — AskUserQuestion behavior (superseded by ADR-007 for interaction model)
- `docs/adr/007-managed-terminal-sessions.md` — managed terminal sessions (ADR-007)
- `docs/adr/008-tmux-session-management.md` — session persistence and startup reconnection (ADR-008)
- GitHub issues #3, #5, #6, #9 — resolved by ADR-007

## Observed Smells

1. **AgentStatus type exists but is not used as a live state machine** (updated 2026-03-29). The supervisor expresses agent state through `AgentState.anomaly` and `AgentState.snoozedUntil` rather than transitioning `AgentStatus` values. The type serves only as metadata on persisted sessions. Either implement `AgentStatus` transitions or simplify the type to match its actual role.
2. ~~**Archived state was a permanent tombstone**~~ — Removed 2026-03-31. The `archived` status had no distinct behavior from completed/cancelled and was removed entirely.
3. **Viewed/Stale attention event states are design-only** (updated 2026-03-29). Neither state is tracked in code. The queue operates with simpler Pending/Skipped/Snoozed/Resolved semantics.
4. ~~**Archive unreachable from frontend**~~ — Resolved 2026-03-31. The `archived` status was removed entirely (no distinct behavior from completed/cancelled).
5. ~~**`Pending → InProgress` promotion broken**~~ — Resolved 2026-04-10. `addSession()` now auto-transitions both `'open'` and `'pending'` tasks to `'inProgress'`, so `promotePendingTasks` drives the concurrency limit correctly.
6. ~~**`stuck_loop` anomaly type is dead code**~~ — Fixed 2026-03-31. Removed from `AnomalyType` and all references. Stuck-loop detection deferred to V2 AI supervisor.
