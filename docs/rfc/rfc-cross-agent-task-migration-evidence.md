# Evidence Pack — Cross-Agent Task Migration RFC

> Shared evidence pack for the critic panel. **Every item is a claim to verify,
> not settled fact.** Re-read the cited source if a claim is load-bearing for
> your review. Assembled 2026-08-12 from three code-mapping passes over
> `origin/main` (base commit `0f0924f6`).

## 1. Pipeline map (files that matter for this RFC)

### Task model & lifecycle
- `src/core/task-read-model.ts:103` — canonical `Task`: `id` (UUID), `prompt`,
  `userPrompt?` (original user-authored prompt), `cwd`, `criteria?`,
  `agentType: AgentType`, `status: TaskStatus`, `sessions: SessionInfo[]`,
  `parentTaskId?/childTaskIds?`, `metadata?` (`launchSource`), `ralphLoop?`,
  `createdAt/updatedAt/finishedAt?/terminatedAt?`. **No worktree/branch on the
  task** — those are per-session.
- `src/core/session-read-model.ts:35` — `SessionInfo`: `tmuxSession`,
  `agentType`, `cwd`, `gitBranch?`, `gitCommit?`, `gitDir?`, `gitIsWorktree?`,
  `worktreeHealth?`, `claudeSessionId?` (provider runtime session id — same
  field holds Claude/Codex/Grok ids), `transcriptPath?`, `lastStatus?`,
  `lastTurnState?`, `crashRecovered?`, `resumedFromCrash?`, `relaunchCount?`.
- `src/shared/contracts/task-status.ts:9` — `TaskStatus = open | pending |
  inProgress | completed | terminated | cancelled`. Terminal = `completed |
  terminated | cancelled` (`:17`). `AgentStatus` (`:1`) and `TurnState` (`:41`)
  are separate unions (session-level).
- `src/core/tasks.ts:89` — `VALID_TRANSITIONS`. Relevant: `terminated → open,
  completed, cancelled`; `cancelled → open`; `completed → open`. Illegal moves
  throw `InvalidTransitionError` (`tasks.ts:58`).

### Launch & agent resolution
- `src/server/launch-service.ts:647` — resolution precedence:
  `opts.agentType ?? deps.getDefaultAgentType?.() ?? adapterRegistry.getDefaultType() ?? DEFAULT_AGENT_TYPE`.
- `src/server/launch-service.ts:760` — backpressure: spawn-burst limit,
  pending-queue depth, per-source spawn budgets (commit `8751c4b6`).
- `src/server/launch-service.ts:954` — `launchFreshTaskSession` relaunches an
  existing task via `adapterRegistry.get(task.agentType).launch(...)` — i.e.
  the **stored** concrete type. No path today launches an existing task under a
  *different* agent.
- `src/adapters/agent-adapter.ts:120` — `AgentAdapter` (identity
  `readonly agentType`), `launch(taskId, prompt, cwd, resume?, opts?)`.
  `ResumeContext` (`:33`) carries a provider session id for `--resume`.
- `src/shared/contracts/agent-types.ts:2` — `AGENT_TYPES = ['claude-code',
  'codex-cli', 'grok-build']`; `DEFAULT_AGENT_TYPE = 'claude-code'` (`:41`);
  `AgentSelection` adds `round-robin` sentinel (`:28`), resolved to concrete
  **before** the task record is created.

### Default-agent setting (the "make it default" mechanism already ships)
- `src/core/settings-store.ts:45` — `defaultAgentType: AgentSelection` on
  `KookrSettings`; default `:193`; validated/normalized on load `:380`;
  companion `roundRobinIndex` cursor `:51`.
- On disk: `~/.kookr[-port]/settings.json` (`create-core-stores.ts:119`).
- `GET/PUT /api/settings` (`src/server/routes/settings-routes.ts:7/16`);
  live getter `getDefaultAgentType` wired to launch (`src/server/index.ts:497`).
- Frontend edit: `SettingsDialog.tsx:681` (`AgentTypeSelector`).
- Shipped + accepted: `docs/rfc/rfc-default-agent-selection.md` (incl.
  round-robin extension).

### Stop / interrupt / recovery
- `src/server/agent-lifecycle.ts` — `completeTask` (`:427`, →`completed`),
  `terminateTask` (`:477`, →`terminated`, crash disposition, awaits user ack),
  `cancelTask` (`:512`, →`cancelled`, user abort). All call `adapter.stop` →
  `backend.killSession` (process-tree kill).
- `src/server/reconciliation.ts:191` — dead-session tasks auto-transition:
  clean turn → `completeTask`, else → `terminateTask`. `reconcileStaleOpenLaunches`
  (`:250`) terminates open launches that never attached.
- `src/server/crash-recovery.ts:59` — `recoverCrashedSessions` relaunches via
  `claude --resume <id> --fork-session` (**same agent**, provider fork), guards
  crash-loops (`CRASH_LOOP_WINDOW_MS ~60s`) and duplicate prompts.

### Restore (existing, adjacent, NOT this RFC)
- `docs/rfc/rfc-restore-lost-agent-sessions.md` (Draft v4) — `POST
  /api/tasks/:id/restore-session`, **same-agent, fork-only** (`claude --resume
  --fork-session` / `codex fork`), single-task. **Explicit non-goals:** cross
  machine, no fresh fallback, no native resume. It does **not** cover
  cross-agent or batch. Provider fork preserves the conversation; it cannot
  cross vendors.

### Batch / bulk precedents
- `POST /api/tasks/abort` (`src/server/routes/task-routes.ts:749`) —
  `batchAbortTasks`, body `{taskIds: string[], reason?}`, `MAX_BATCH_ABORT_TASKS`
  cap, supervisor-token gated.
- `POST /api/tasks/completion-ready/ack-all` (`:806`) — bulk drain.
- Frontend `AbortActiveButton` (`FindingsPanel.tsx:1539`) — confirm dialog +
  `send({type:'batchAbortTasks', taskIds})`. Scope computed by
  `computeAbortActiveTaskIds` (`src/frontend/abort-active-tasks.ts:13`).
- **No general per-row multi-select checkbox exists today** — bulk actions
  operate over derived scopes ("all active", "all completed").

### CLI & GUI surfaces
- CLI: `bin/kookr.js` hand-rolled dispatch (help `:9`, branches `:73+`). Thin
  HTTP client against the running server (`bin/kookr-spawn.js:507` `postTask`,
  `resolveBaseUrl`/`probeHealth` `:433`). CLI modules under `src/cli/`
  (`kookr-maintenance.ts`, `kookr-doctor.ts`, ...). `kookr spawn -a/--agent`.
- Routes: Hono, `createRoutes` (`src/server/routes.ts:44`), `registerTaskRoutes`
  (`task-routes.ts:74`).
- GUI: React + Zustand (`src/frontend/store/useStore.ts`). Task list
  `FindingsPanel.tsx`. Mutations over WebSocket (`reconnecting-socket.ts`,
  handlers `src/server/ws-handlers/lifecycle-handler.ts`); reads via `fetch`.

### Persistence
- `~/.kookr[-port]/tasks.json`, envelope v2 (`src/core/task-persistence.ts:28`,
  atomic temp+fsync+rename, snapshot rotation). In-memory `TaskStore` map
  (`tasks.ts:110`). Interaction/audit log `~/.kookr/audit.jsonl`.

## 2. Telemetry / measurements

- Grok Build is a first-class agent type already (`agent-types.ts:2`), added by
  `docs/rfc/rfc-grok-build-agent-integration.md` (Accepted). That RFC lists
  "xAI service or subscription limits stop sessions" as a known failure mode
  whose mitigation is only "normalize provider errors and preserve
  terminal/session evidence" — no failover.
- Grok exposes **no** validated effort levels (`agent-types.ts` Grok block);
  cross-agent migration must re-resolve effort/model against the *target*
  agent, not carry the source's.
- Live local task stores exist at `~/.kookr/tasks.json` and
  `~/.kookr-4801/tasks.json` (per the restore RFC's empirical scan: 129 tasks /
  132 sessions on 2026-06-20). A POC can scan these read-only to count real
  interrupted/migratable candidates and per-agent breakdown.

## 3. The load-bearing design claim (verify hardest)

**Cross-vendor conversation state is NOT portable.** A Grok Build conversation
cannot be `--resume`d into Claude Code. Therefore "resume an interrupted task
with another agent" **cannot** be a provider fork. The only portable state is:
(a) the task's `userPrompt` + `criteria`, and (b) the **worktree** it was
running in (`SessionInfo.cwd` + `gitBranch/gitCommit/gitDir/gitIsWorktree`),
which physically holds the work-in-progress files and commits. The design
therefore reconstructs a **continuation brief** from portable state and launches
a **fresh session** under the new agent in the same worktree — a context
hand-off, not a conversation transplant. Everything downstream depends on this
being true and on the continuation brief being good enough to resume useful
work.
