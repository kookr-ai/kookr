# RFC: Restore Lost Agent Sessions

**Status:** Draft (v4 - convergence review incorporated)
**Date:** 2026-06-20
**Author:** Jean Ibarz (with Codex)

---

## Problem

Kookr can lose the terminal/process for a task while the underlying provider
conversation remains recoverable. A dtach socket can disappear, a task can be
left `inProgress` or `terminated`, and the task/session record can still hold
the cwd, agent type, provider conversation id, transcript path, settings path,
hook wiring, and worktree metadata needed to start a replacement terminal under
the same Kookr task.

Today the operator has to reconstruct that provider command by hand. The
restored runtime then lives outside Kookr's task/session model, hooks, watchdog,
and audit trail.

The product distinction is:

> terminal/process liveness is not the same thing as conversation
> recoverability.

Kookr should expose that distinction as a task-level restore operation.

## Current Behavior

Relevant implementation points on current `main`:

- `SessionInfo` stores `tmuxSession`, `agentType`, `cwd`, `claudeSessionId`,
  `transcriptPath`, `childSessionIds`, `codexHookCapabilities`, git/worktree
  metadata, `crashRecovered`, `relaunchCount`, `lastRelaunchedAt`, and
  `resumedFromCrash`.
- `claudeSessionId` is the historical persisted field name, but both Claude
  and Codex adapters write their parent provider session id into it.
- `TaskStore.addSession()` appends a session and transitions `open` or
  `pending` tasks to `inProgress`.
- `LocalDtachBackend.isAlive(id)` checks terminal liveness. It does not know
  whether the provider conversation is recoverable.
- `reconcile()` marks dead non-terminal sessions terminal and transitions a
  task with no live sessions to `terminated`.
- `recoverCrashedSessions()` can reopen a terminated/completed task and call
  `adapter.launch(task.id, task.prompt, session.cwd, resumeContext)`.
- `ClaudeCodeAdapter.launch()` honors `ResumeContext` by launching
  `claude --resume <id> --fork-session --settings <file>`.
- `CodexCliAdapter.launch()` currently logs and ignores `ResumeContext`,
  launching fresh instead.
- The dashboard lets the operator acknowledge terminated tasks as done. It does
  not offer restore or explain restore blockers.

The existing startup recovery path proves that most launch plumbing already
exists. The missing piece is a user-triggered, auditable, task-scoped restore
workflow.

## Empirical Checkpoint

Round 1 review asked whether the lost-but-resumable shape exists locally and
whether the provider commands are real.

Local scan on 2026-06-20:

- Searched seven local task stores:
  `~/.kookr/tasks.json`, `~/.kookr-4801/tasks.json`, and empty dev-port stores.
- Total scanned: 129 tasks, 132 sessions, 129 sessions with provider
  conversation ids.
- Restore-shaped candidates found: 2 terminated tasks with dead sessions,
  provider conversation ids, and transcript paths.
- Providers: 1 Claude Code, 1 Codex CLI.
- Both candidates had missing cwd/worktree paths, so `missing_cwd` must be a
  first-class blocked reason.

Local CLI help on 2026-06-20 confirmed:

- `claude` supports `--resume <value>`, `--fork-session`, `--settings`,
  `--plugin-dir`, `--dangerously-skip-permissions`, and `--setting-sources`.
- `codex fork [SESSION_ID] [PROMPT]` supports `--settings`, `--prompt-file`,
  `--plugin-dir`, `--cd`, sandbox and approval flags.
- `codex resume [SESSION_ID] [PROMPT]` exists, but V1 deliberately does not
  expose native resume.

Codex prompt-file semantics on restore are not validated. V1 therefore must
not pass the original prompt or a restore note to `codex fork`.

## Goals

1. Detect when a Kookr task has no live terminal session but has enough
   provider metadata to offer restore.
2. Add explicit restore on the task:
   `POST /api/tasks/:id/restore-session` and a dashboard action.
3. Fork the saved provider conversation into a new dtach session under the
   same Kookr task id.
4. Preserve normal hooks, settings, plugin injection, current permission
   policy, cwd, and monitor/watchdog registration.
5. Support Claude Code and Codex CLI deliberately.
6. Persist enough restore-attempt state to recover from crashes around terminal
   spawn and session registration.
7. Surface stable blocked reasons for missing metadata, live sessions, missing
   cwd/transcript, unsupported provider capability, and provider lookup failure.
8. Keep existing persisted tasks valid.

## Non-Goals

- Do not auto-restore every terminated task. Restore is explicit in V1.
- Do not restore intentionally completed, cancelled, or deleted tasks.
- Do not expose native provider resume in V1.
- Do not expose fresh fallback. Fresh relaunch is a separate operation.
- Do not infer provider session ids by scraping arbitrary transcripts when
  Kookr never recorded a parent provider session id.
- Do not restore across machines. Provider stores, cwd/worktrees, and dtach
  sockets are local state.
- Do not introduce new terminal statuses in V1.
- Do not adopt unregistered orphan dtach sessions in V1.
- Do not add periodic lost-session detection in V1.
- Do not implement this design in the RFC PR.

## Recommendation

Ship V1 as a bodyless, fork-only, task-scoped endpoint:

```http
POST /api/tasks/:id/restore-session
```

The server selects the newest eligible lost provider conversation for that task
and asks the adapter to fork it into a new managed terminal session. Frontend
eligibility is advisory only; the locked server-side planner is authoritative.

Do not overload `AgentAdapter.launch()` further. Add an explicit adapter
restore contract that owns provider/backend launch but not TaskStore mutation:

```ts
type RestoreMode = 'fork';

type RestoreBlockedReason =
  | 'task_not_found'
  | 'task_status_not_restorable'
  | 'live_session_exists'
  | 'restore_already_in_progress'
  | 'session_already_replaced'
  | 'missing_conversation_id'
  | 'missing_transcript'
  | 'missing_cwd'
  | 'cwd_guard_failed'
  | 'unsupported_agent'
  | 'provider_capability_missing'
  | 'provider_session_not_found'
  | 'binary_not_found'
  | 'workflow_owner_unsupported'
  | 'launch_uncertain'
  | 'launch_failed';

interface ProviderExecutionIdentity {
  resolvedBinary: string;
  version?: string;
  helpHash?: string;
  settingsPath: string;
  pluginDir?: string;
  permissionMode: string;
}

interface RestoreLaunchRequest {
  taskId: string;
  cwd: string;
  fromSessionId: string;
  providerConversationId: string;
  transcriptPath?: string;
  expectedSessionId: string;
  attemptId: string;
  mode: 'fork';
  providerIdentity: ProviderExecutionIdentity;
}

interface RestorePreparedLaunch {
  expectedSessionId: string;
  settingsPath: string;
  redactedArgv: string[];
}

interface RestoreSpawnResult {
  sessionId: string;
}

interface AgentAdapter {
  planRestore?(request: RestorePlanInput): Promise<AdapterRestorePlan>;
  prepareRestoreLaunch?(request: RestoreLaunchRequest, opts?: AdapterLaunchOptions): Promise<RestorePreparedLaunch>;
  restore?(request: RestoreLaunchRequest, opts?: AdapterLaunchOptions): Promise<RestoreSpawnResult>;
}
```

The restore service owns task/session state. Adapters own provider-specific
planning, settings generation, argv/env construction, internal adapter maps,
and `backend.createSession()`. The service then registers the restored session
through a TaskStore helper.

## Provider-Neutral Eligibility

The restore service chooses the newest unreplaced session whose provider
conversation is lost from Kookr but potentially recoverable. Eligibility is
based on conversation lineage, not only `lastStatus`.

Provider-neutral checks:

1. Task exists.
2. Task status is `inProgress` or `terminated`.
3. Workflow policy allows generic restore. Ralph loops return
   `workflow_owner_unsupported` via a `WorkflowRestorePolicy`, not by direct
   Ralph-field inspection in the restore service.
4. No active restore attempt exists, and the latest restore attempt is not an
   unacknowledged `uncertain` result. The durable `activeRestoreAttempt` is the
   primary lock; the in-process lock only serializes concurrent calls before
   the durable compare-and-set.
5. No live non-terminal session exists after a fresh backend liveness probe.
6. Candidate session is not already replaced (`replacedBySessionId` absent).
7. Candidate session has a provider conversation id.
8. Candidate cwd exists and passes worktree guardrails.

Then the service asks the adapter for provider-specific planning:

- Claude Code requires a provider conversation id and a readable transcript.
- Codex CLI can plan from provider conversation id if the resolved binary
  exposes `fork`; it may return `provider_session_not_found` if the Codex
  session index cannot resolve the id.
- Provider capability cache is keyed by resolved binary path plus
  version/help hash.
- `planRestore()` returns the `ProviderExecutionIdentity` that `restore()` must
  use or revalidate immediately before spawn.

Blocked reason priority:

1. task/workflow status (`task_not_found`, `task_status_not_restorable`,
   `workflow_owner_unsupported`);
2. concurrency/liveness (`restore_already_in_progress`,
   `live_session_exists`);
3. missing local prerequisites (`missing_conversation_id`,
   `missing_transcript`, `missing_cwd`, `cwd_guard_failed`);
4. adapter/provider capability (`unsupported_agent`, `binary_not_found`,
   `provider_capability_missing`, `provider_session_not_found`);
5. launch/runtime failure (`launch_uncertain`, `launch_failed`).

## Durable Attempt State

V1 uses a small task-level attempt record. It is the authoritative restore
lock across restarts.

```ts
type RestoreAttemptStatus =
  | 'planned'
  | 'spawning'
  | 'session_registered'
  | 'succeeded'
  | 'failed'
  | 'uncertain';

interface TaskSessionRestoreAttempt {
  id: string;
  status: RestoreAttemptStatus;
  startedAt: string;
  updatedAt: string;
  ownerInstanceId: string;
  ownerPid: number;
  timeoutAt: string;
  previousTaskStatus: TaskStatus;
  fromSessionId: string;
  expectedSessionId: string;
  providerConversationId: string;
  agentType: AgentType;
  cwd: string;
  mode: 'fork';
  providerIdentity: ProviderExecutionIdentity;
  settingsPath?: string;
  redactedArgv?: string[];
  failureReason?: RestoreBlockedReason;
}

interface Task {
  activeRestoreAttempt?: TaskSessionRestoreAttempt;
  lastRestoreAttempt?: TaskSessionRestoreAttempt;
}
```

Transition table:

| From | To | Meaning |
|---|---|---|
| none | `planned` | compare-and-set reserved an attempt and expected session id |
| `planned` | `spawning` | settings/argv identity persisted; adapter is about to spawn |
| `spawning` | `session_registered` | TaskStore appended the restored session |
| `session_registered` | `succeeded` | TaskStore finalized lineage and old-session replacement |
| `planned`/`spawning`/`session_registered` | `failed` | deterministic failure before or after spawn |
| `spawning` | `uncertain` | provider command may have run, but no registered session exists and no safe retry is possible |

`activeRestoreAttempt` stores only nonterminal attempts:
`planned`, `spawning`, and `session_registered`. Terminal attempts are moved to
`lastRestoreAttempt` and clear the active lock. A retry after `failed` starts a
new attempt id from `none -> planned`. An `uncertain` attempt also moves to
`lastRestoreAttempt` and clears the active lock, but a new restore remains
blocked while the latest attempt is unacknowledged and uncertain.

Invariants:

- `planned` and later always have `fromSessionId`, `expectedSessionId`,
  `previousTaskStatus`, and provider execution identity.
- `session_registered` and later imply `task.sessions` contains
  `expectedSessionId`.
- `succeeded` implies one atomic TaskStore operation has:
  - marked the old session `lastStatus: 'completed'`;
  - set old session `replacedAt` and `replacedBySessionId`;
  - added new session `restoredFromSessionId`, `restoredFromConversationId`,
    `restoreAttemptId`, and `restoreMode`;
  - transitioned the task to `inProgress`;
  - marked the attempt `succeeded`.
- `failed` preserves or restores `previousTaskStatus` when no new session was
  registered, moves the attempt to `lastRestoreAttempt`, and clears
  `activeRestoreAttempt`.
- `uncertain` moves the attempt to `lastRestoreAttempt`, clears
  `activeRestoreAttempt`, and blocks retry through the unacknowledged
  last-attempt reason until an operator acknowledges or a future cleanup tool
  proves whether the provider fork happened.

Startup cleanup:

- corrupt `planned` missing expected session id: mark failed, move to
  `lastRestoreAttempt`, clear the active lock, restore `previousTaskStatus`,
  and log a cleanup warning.
- `spawning` with expected dtach session but no task session record: kill that
  expected dtach session, mark failed, move to `lastRestoreAttempt`, and clear
  the active lock. V1 does not adopt unregistered orphans.
- `spawning` with no expected dtach session and no task session record: mark
  `uncertain` and move to `lastRestoreAttempt` because the provider command may
  have created a provider-side fork before Kookr crashed.
- `spawning` with expected session already in `task.sessions`: advance to
  `session_registered` and finalize or fail based on liveness.
- `session_registered`: ensure lifecycle registration exists for only the
  expected session, then reconcile liveness. If live, finalize lineage; if
  registration cannot be repaired or the terminal is dead, mark failed and keep
  old session unreplaced.
- `succeeded` whose lineage invariant is false: repair lineage if possible;
  otherwise mark `uncertain`.
- Attempts past `timeoutAt` are failed only for `planned`; `spawning` without a
  registered session becomes `uncertain`; `session_registered` first probes the
  expected session liveness.

## Session Schema

Keep session metadata lineage-focused and avoid new terminal statuses in V1:

```ts
interface SessionInfo {
  replacedAt?: string;
  replacedBySessionId?: string;
  restoredFromSessionId?: string;
  restoredFromConversationId?: string;
  restoreAttemptId?: string;
  restoreMode?: 'fork';
}
```

The old session keeps existing terminal status semantics. On successful
restore, set `lastStatus: 'completed'` plus replacement lineage; UI/read-model
code derives "Replaced" from `replacedBySessionId`, not from a new status.

New restore code should not use `claudeSessionId` directly outside a small
domain accessor:

```ts
function providerConversationId(session: SessionInfo): string | undefined {
  return session.claudeSessionId;
}
```

The persisted field stays for backward compatibility; new code speaks in terms
of provider conversation id.

## Service Flow

Create `src/server/restore-session-service.ts` with one public operation:

```ts
restoreTaskSession(deps, taskId): Promise<RestoreResult | RestoreBlocked>
```

Use a restore-local per-task mutex plus the durable attempt compare-and-set.
Do not hold that mutex while waiting for hooks or long-running external work.

Flow:

1. Acquire restore-local per-task mutex.
2. Re-read task and re-probe backend liveness.
3. Run provider-neutral planning and workflow policy.
4. Ask adapter `planRestore()` for provider prerequisites and execution
   identity.
5. Preallocate `expectedSessionId` and `restoreAttemptId`.
6. `TaskStore.beginRestoreAttempt()` atomically verifies every persisted
   precondition: no active attempt; no unacknowledged uncertain last attempt;
   task status still restorable; selected source session still exists, is
   unreplaced, and has the same provider conversation id; no existing restored
   session already targets that source; and `expectedSessionId` is unused. It
   then stores `planned` and records `previousTaskStatus`.
7. Release mutex while any slow provider planning that is safe to repeat has
   already completed; reacquire before state transitions.
8. Ask adapter `prepareRestoreLaunch()` to create the settings file and compute
   the exact redacted argv/env that will be used for spawn. This step must not
   create the backend session or mutate TaskStore.
9. `TaskStore.markRestoreSpawning()` persists `spawning`, settings path,
   redacted argv, and timeout immediately before adapter spawn.
10. Release the mutex before external spawn. Concurrent restore calls during
    this window observe `activeRestoreAttempt.status === 'spawning'` and return
    `restore_already_in_progress`.
11. Call `adapter.restore()`. The adapter creates the backend session using the
    prepared launch artifacts but does not mutate TaskStore.
12. Reacquire mutex and call
    `TaskStore.addRestoredSessionAndMarkRegistered(attemptId, session)`. This
    appends the new session with lineage fields and moves the attempt to
    `session_registered`.
13. Register only the restored session with the lifecycle registry. Do not call
    a broad task-level registration helper that re-registers the dead source
    session.
14. Probe the expected session liveness once. If registration failed or the
    terminal is dead, mark the restore failed and keep the old source session
    unreplaced.
15. If live, call `TaskStore.finalizeRestoreAttempt(attemptId)`, which
    atomically marks old session replacement, verifies new-session lineage,
    transitions the task to `inProgress`, marks the attempt `succeeded`, moves
    it to `lastRestoreAttempt`, and clears `activeRestoreAttempt`.
16. Append success audit event and broadcast snapshot.

If launch fails before the new session is registered, call
`TaskStore.failRestoreAttempt()` and compensate task status from
`previousTaskStatus`. If the provider command may have run but no registered
session exists, use `uncertain` rather than silently retrying.

## Adapter Restore Contract

### Shared Requirements

Both adapters:

- use `expectedSessionId` as the new dtach session id;
- write normal Kookr hook settings for that new session;
- preserve current server policy for permission bypass, plugin injection,
  workspace trust, and settings. V1 does not promise historical launch policy
  if operator config changed since the original session;
- do not deliver the original task prompt again;
- prepare launch artifacts before spawn and return only spawn identity after
  spawn; they do not write TaskStore restore lineage themselves.

### Claude Code

Command shape:

```txt
claude \
  [current permission flags] \
  [--plugin-dir <kookr-plugin>] \
  [--append-system-prompt <checkpoint-instruction>] \
  --resume <provider-session-id> \
  --fork-session \
  --settings <settings-path>
```

Claude restore planning requires `transcriptPath` to be present and readable.
The adapter keeps its existing transcript existence check as defense in depth.

### Codex CLI

Command shape:

```txt
codex fork <provider-session-id> \
  -c features.codex_hooks=true \
  <current permission flag> \
  --settings <settings-path> \
  [--plugin-dir <kookr-plugin>]
```

No prompt argument and no `--prompt-file` in V1. That avoids duplicating the
original prompt or appending an unvalidated restore note.

Codex restore planning probes:

- binary exists;
- `codex fork` is available;
- hook settings are supported;
- plugin support if a plugin dir is configured.

The probe result includes resolved binary path and version/help hash, and
`restore()` revalidates that it is launching the same binary identity.

## API

`POST /api/tasks/:id/restore-session`

Request body: empty or `{}`. Unknown fields are rejected in V1.

Success:

```json
{
  "ok": true,
  "task": { "...": "normalized task snapshot" },
  "restoredSessionId": "kookr-abcd1234",
  "restoredFromSessionId": "kookr-dead1234",
  "restoreAttemptId": "..."
}
```

Blocked:

```json
{
  "ok": false,
  "code": "missing_cwd",
  "message": "This task cannot be restored because the original working directory no longer exists."
}
```

Status codes:

- `404`: task not found.
- `409`: live session exists, restore already in progress, or restore
  uncertain.
- `422`: task/session exists but lacks restore prerequisites.
- `500`: adapter launch failed after the attempt began.

Uncertain attempts have an explicit V1 operator resolution path:

```http
POST /api/tasks/:id/restore-session/acknowledge-uncertain
```

Request body: empty or `{}`. Unknown fields are rejected. The endpoint
succeeds only when `lastRestoreAttempt.status === 'uncertain'` and no live
expected session exists. It records acknowledgement metadata, clears the retry
block, and returns the normalized task snapshot. It does not adopt or kill
provider conversations. After acknowledgement, the operator can invoke restore
again and receive a new attempt id.

## Dashboard Workflow

The frontend may show **Restore session** when the snapshot suggests:

- task status is `inProgress` or `terminated`;
- no session appears live from the latest snapshot;
- at least one unreplaced session has a provider conversation id.

On click, the server planner rechecks everything and returns the authoritative
result.

Confirmation:

> Restore this task in a new terminal session?
>
> Kookr will fork the saved agent conversation, keep the same task, and mark
> the old terminal session as replaced.

After success:

- select the new terminal session for the same task;
- show the old session as "Replaced by <new-session-id>";
- show restore mode and source provider conversation id in Details.

Do not render a persistent disabled "Cannot restore" state in V1. If the
server blocks restore, show the precise server reason inline or as a toast.
For `launch_uncertain`, show an acknowledgement action that explains Kookr
cannot prove whether the provider fork happened and that acknowledging permits
a later restore attempt without adopting any unmanaged provider conversation.

## Restore vs Startup Crash Recovery

Manual restore and startup crash recovery share low-level helpers but not
policy:

- Startup recovery is automatic, bulk, and best-effort during boot.
- Manual restore is explicit, task-scoped, and returns actionable HTTP errors.

Precedence:

- Startup cleanup resolves active restore attempts before startup crash
  recovery considers those tasks.
- Replaced sessions are not crash-recovery candidates.
- Failed restore attempts can be retried manually after the planner rechecks
  liveness and prerequisites.
- Uncertain attempts block automatic retry until operator acknowledgement or a
  future cleanup tool resolves them.

Extract provider conversation planning helpers from `crash-recovery.ts`, but
keep crash-loop dedup and prompt-hash dedup local to startup recovery.

## Audit And Observability

Use the existing central interaction log as the audit sink. Add structured
events with a correlation id:

```ts
type InteractionEvent =
  | {
      type: 'task_session_restore_planned';
      restoreAttemptId: string;
      taskId: string;
      fromSessionId: string;
      expectedSessionId: string;
      providerConversationId: string;
      agentType: AgentType;
      providerIdentity: ProviderExecutionIdentity;
      previousTaskStatus: TaskStatus;
      timestamp: string;
    }
  | {
      type: 'task_session_restored';
      restoreAttemptId: string;
      taskId: string;
      fromSessionId: string;
      newSessionId: string;
      providerConversationId: string;
      agentType: AgentType;
      providerIdentity: ProviderExecutionIdentity;
      settingsPath: string;
      redactedArgv: string[];
      durationMs: number;
      timestamp: string;
    }
  | {
      type: 'task_session_restore_uncertain';
      restoreAttemptId: string;
      taskId: string;
      fromSessionId: string;
      expectedSessionId: string;
      providerConversationId: string;
      agentType: AgentType;
      providerIdentity: ProviderExecutionIdentity;
      settingsPath?: string;
      redactedArgv?: string[];
      cleanupAction: 'none' | 'killed_expected_session' | 'marked_uncertain';
      message: string;
      timestamp: string;
    }
  | {
      type: 'task_session_restore_failed';
      restoreAttemptId?: string;
      taskId: string;
      fromSessionId?: string;
      expectedSessionId?: string;
      code: RestoreBlockedReason;
      fromAttemptStatus?: RestoreAttemptStatus;
      toAttemptStatus?: RestoreAttemptStatus;
      providerIdentity?: ProviderExecutionIdentity;
      settingsPath?: string;
      redactedArgv?: string[];
      cleanupAction?: 'none' | 'killed_expected_session' | 'marked_uncertain' | 'restored_previous_status';
      message: string;
      timestamp: string;
    };
```

Do not store transcript contents, terminal output, raw prompts, or hook payloads
in these events. `ProviderExecutionIdentity` and `redactedArgv` must already be
scrubbed of secrets and raw prompt text before they are persisted. V1 uses
structured logs and interaction-log events; dedicated metrics can follow once
restore frequency justifies them.

## Files To Change

- `src/core/session-read-model.ts` - restore lineage fields.
- `src/core/task-read-model.ts` - `activeRestoreAttempt` and
  `lastRestoreAttempt`.
- `src/core/tasks.ts` - atomic helpers:
  `beginRestoreAttempt`, `markRestoreSpawning`,
  `addRestoredSessionAndMarkRegistered`, `finalizeRestoreAttempt`,
  `failRestoreAttempt`, `acknowledgeUncertainRestoreAttempt`, and provider
  conversation accessor.
- `src/adapters/agent-adapter.ts` - explicit restore planning/spawn contract.
- `src/adapters/claude-code-adapter.ts` - implement fork restore.
- `src/adapters/codex-cli-adapter.ts` - implement `codex fork` restore.
- `src/server/restore-session-service.ts` - planner, restore-local mutex,
  durable attempt state, audit, compensation.
- `src/server/routes/task-routes.ts` - register restore and uncertain
  acknowledgement endpoints.
- `src/server/crash-recovery.ts` - skip/reconcile active restore attempts and
  share provider conversation helper.
- `src/server/agent-lifecycle.ts` - use a shared live-registerable session
  predicate if needed.
- `src/frontend/components/DetailPanel.tsx` - restore action, uncertain
  acknowledgement action, and result display.
- `src/frontend/store/useStore.ts` or existing REST client layer - call restore
  endpoint and select the restored session.
- `docs/architecture.md` and `docs/features.md` - document restore behavior.

## Edge Cases

- **Task has a live session.** Return `live_session_exists`; do not fork.
- **Task is `terminated`.** Keep it effectively terminal until
  `addRestoredSessionAndMarkRegistered()` can atomically append the new session
  and move toward `inProgress`; do not expose an `open` no-session window.
- **Task is user-completed or cancelled.** Block.
- **Session has no provider conversation id.** Block.
- **Transcript path missing.** Claude blocks. Codex may proceed by id only if
  the provider resolves it.
- **Cwd/worktree removed.** Block with `missing_cwd`; do not recreate
  worktrees in V1.
- **Provider fork succeeds but `SessionStart` never arrives.** Restore success
  does not depend on first `SessionStart`; normal hook ingestion can fill the
  new provider id later. If the terminal is live and registered, restore
  succeeds with source lineage recorded.
- **Crash after attempt is planned but before spawn.** Startup cleanup marks
  failed and restores previous task status.
- **Crash after backend spawn but before session registration.** Startup
  cleanup kills the expected unregistered dtach session if present; if no
  expected session exists, mark the attempt `uncertain`.
- **Crash after session registration but before finalization.** Startup cleanup
  finalizes if the expected session is live, otherwise fails and keeps old
  session unreplaced.
- **Two tabs click restore.** One wins the durable attempt compare-and-set; the
  other gets `restore_already_in_progress`.
- **Ralph loop task.** Generic restore returns `workflow_owner_unsupported` via
  workflow policy. A future Ralph restore path must transfer owner session and
  verdict env deliberately.
- **Server config changed since original launch.** Restore uses current server
  policy. Audit records the current adapter/provider context.

## Alternatives Considered

### A. Only improve startup crash recovery

Rejected. Startup recovery helps after server restart but not when the operator
discovers a lost task during a running Kookr process.

### B. Relaunch from the original prompt

Rejected as the default. It discards provider conversation state and can repeat
side effects. Fresh relaunch should be explicit and separate.

### C. Print a copy-paste command in the dashboard

Rejected. It keeps the restored runtime outside Kookr's task/session model,
hooks, watchdog, and audit trail.

### D. Add a new task for the restored runtime

Rejected. The operator is recovering a task, not starting a different one.

### E. Keep using `AgentAdapter.launch()` with `ResumeContext`

Rejected after round 1. Fresh launch, crash recovery, manual fork restore, and
future native resume have different prompt and audit semantics. A dedicated
adapter restore method prevents accidental prompt replay.

### F. Expose native resume or fresh fallback in V1

Rejected. Fork-only is safer and easier to audit. Native resume and fresh
fallback can become separate admin operations after provider semantics are
tested.

### G. No durable restore attempt state

Rejected. Simpler, but unsafe across crashes around backend spawn, session
registration, lineage finalization, and server restart.

### H. Adopt unregistered orphan dtach sessions during startup cleanup

Rejected for V1. Adoption requires a stronger launch manifest and can be added
later. Kill-only cleanup is simpler and safer for unregistered terminals.

## Test Plan

### Unit

- Provider-neutral planner prioritizes stable blocked reasons.
- Planner treats reconciled terminal sessions with provider ids as eligible
  lost conversations, not only non-terminal sessions.
- Planner blocks live sessions after a fresh backend probe.
- TaskStore restore attempt transitions reject invalid state combinations.
- `beginRestoreAttempt()` CAS revalidates task status, source-session
  existence, unreplaced lineage, provider conversation id, unused expected
  session id, and absence of prior restored sessions for the same source.
- Terminal restore attempts move to `lastRestoreAttempt` and clear
  `activeRestoreAttempt`; `uncertain` prevents automatic retry until
  acknowledged.
- `acknowledgeUncertainRestoreAttempt()` clears only the uncertain retry block
  and does not mutate session lineage.
- `providerConversationId(session)` shields new code from the
  `claudeSessionId` field name.
- `finalizeRestoreAttempt()` atomically marks old-session replacement,
  verifies new-session lineage, transitions task status, and marks attempt
  `succeeded`.
- Pre-RFC task fixtures without restore fields load unchanged.
- Mixed Claude/Codex provider ids stored in `claudeSessionId` are exposed
  through the provider conversation accessor.

### Adapter

- Claude restore emits `--resume <id> --fork-session --settings <path>` and
  does not deliver the original prompt.
- Claude restore blocks without readable transcript.
- Codex restore emits `codex fork <id>` with hooks, settings, cwd, current
  permission flag, and plugin flag when supported.
- Codex restore does not pass the original prompt or `--prompt-file` in V1.
- Codex capability cache is keyed by binary identity and revalidated at spawn.

### Server / Integration

- Endpoint success appends a new session to the same task, marks old session
  replaced before lifecycle registration, registers only the new session,
  broadcasts a snapshot, and emits audit events with `restoreAttemptId`.
- Terminated task restore does not leave an `open` no-session window on
  adapter failure.
- Concurrent restore calls return one success/in-progress result and one 409.
- API rejects unknown request fields for both restore endpoints and accepts
  empty or `{}` bodies.
- API status-code tests cover every `RestoreBlockedReason`, including
  `launch_uncertain`.
- Failpoint tests cover: planned, spawning, unregistered expected session,
  session_registered, targeted lifecycle registration, finalize, and audit
  append.
- `session_registered` recovery repairs lifecycle registration for the expected
  session only, or kills/fails the expected session if registration cannot be
  repaired.
- Startup cleanup kills unregistered expected sessions and never adopts
  unregistered orphans in V1.
- Startup crash recovery waits for restore-attempt cleanup before handling the
  same task.

### Frontend

- Restore button appears from coarse snapshot eligibility.
- Stale eligibility is handled by server blocked response.
- Success selects the restored session and shows old session lineage.
- Uncertain attempt response shows the acknowledgement action, not a retryable
  generic error.

### Manual

- Kill a Claude Code dtach session with recorded provider id and transcript;
  restore from dashboard; verify hooks flow under the same task.
- Kill a Codex CLI dtach session with recorded provider id; restore with
  `codex fork`; verify hooks flow under the same task.
- Remove cwd/worktree and confirm `missing_cwd`.
- Remove Claude transcript and confirm `missing_transcript`.

## Open Questions

1. Should native provider resume ever be exposed, or is fork always the right
   user-facing restore mode?
2. Should `claudeSessionId` be renamed to `providerConversationId` in a later
   persistence migration?
3. Should a future Codex restore pass a checkpoint-only prompt file after a POC
   confirms prompt-file append semantics?
4. Should Kookr run a periodic lost-session detector while the process is
   alive, or is restore-on-user-action enough for V1?

## Critic Feedback Incorporated

### Round 1

- **boundary-critic** - split provider-neutral restore planning from
  adapter-owned provider planning; replaced overloaded `launch()` reuse with a
  dedicated adapter restore contract; added provider conversation accessor and
  workflow-owner veto.
- **design-minimalist** - narrowed V1 to a bodyless fork-only endpoint; removed
  `allowFreshFallback`, public native resume, explicit session selection, and
  restore prompt notes.
- **failure-mode-analyst** - added durable restore attempts with previous task
  status, expected session id, capability-cache identity, compensation, and
  failpoint tests.
- **socratic-challenger** - added empirical scan results; reframed eligibility
  around lost provider conversations; clarified startup recovery precedence;
  stated restore uses current server policy; made frontend eligibility
  advisory.
- **operability-reviewer/state-machine-verifier** - added attempt transition
  table, invariants, audit correlation id, more blocked reasons, and
  rollback/failure tests.

### Round 2

- **boundary-critic** - removed TaskStore mutation from adapter restore; the
  adapter now prepares launch artifacts before spawn and the service/TaskStore
  owns restored session registration and attempt transitions; narrowed
  lifecycle locking language to restore-local phases and workflow policy.
- **failure-mode-analyst** - made durable attempt the primary lock; added
  provider execution identity to planning and restore; made finalization atomic;
  added `uncertain` for possibly-spawned provider-side forks with no registered
  session.
- **design-minimalist** - removed new terminal statuses, orphan adoption,
  provider-identity timeout state, broad shared lifecycle mutex, and V1 runtime
  counters.
- **operability-reviewer/state-machine-verifier** - specified persisted
  `spawning`, kill-only startup cleanup, exact TaskStore transition helpers,
  central audit sink, and explicit task-state compensation.

### Round 3

- **convergence reviewers** - split active and historical restore attempts;
  added pre-spawn launch preparation; widened the TaskStore CAS to all
  persisted preconditions; made lifecycle registration target only the restored
  session; added uncertain acknowledgement; and expanded audit/API/backcompat
  tests.
