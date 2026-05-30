# System Architecture

> **Design principle:** Reuse existing solutions. Don't reinvent what exists in aegiscore or openclaw. Build only what's unique to Kookr: **intelligent attention routing powered by an AI supervisor agent**.

## Overview

Kookr is a **supervisor agent + GUI** that sits on top of existing agent processes. The supervisor is itself an AI — it reads the coding agents' output, understands what they're doing, detects anomalies, and explains to the developer what needs attention and why.

```
┌──────────────────────────────────────────────────────┐
│              KOOKR                                   │
│                                                      │
│  ┌──────────┐    ┌─────────────────────────────┐     │
│  │ Frontend  │◄──► Backend (local)             │     │
│  │ (Browser) │ WS │                            │     │
│  └──────────┘    │  ┌───────────────────────┐  │     │
│                  │  │ Supervisor Agent (AI)  │  │     │
│                  │  │ - reads agent streams  │  │     │
│                  │  │ - detects anomalies    │  │     │
│                  │  │ - explains problems    │  │     │
│                  │  │ - prioritizes attention │  │     │
│                  │  └───────────────────────┘  │     │
│                  │  Adapter Layer               │     │
│                  └──────────────┬──────────────┘     │
│                                │                     │
│               ┌────────────────┴───────────────┐     │
│               │  Coding Agent Processes         │     │
│               │  (managed terminal sessions)    │     │
│               └────────────────────────────────┘     │
└──────────────────────────────────────────────────────┘
```

---

## The Supervisor Agent

This is Kookr's core differentiator. It's not a hardcoded scoring function — it's an **AI agent that understands context**.

### What it does

The supervisor agent continuously reads structured events from all managed coding agents (via transcript JSONL files and hooks) and:

1. **Detects anomalies** — patterns that indicate a coding agent needs human help:
   - Agent is looping (same tool call or test run repeated N times without change)
   - Agent is asking the user a question (via `AskUserQuestion` tool call)
   - Agent cost is climbing with no progress (budget burn)
   - Agent drifted off the original task
   - Agent is stuck on an error it can't resolve

2. **Explains the situation** — generates a human-readable summary:
   - *"Agent #3 has run `npm test` 12 times. Same assertion error each time: `TypeError: token.verify is not a function`. It keeps editing `auth.ts` but hasn't tried changing the import. Likely needs a hint about the correct module."*

3. **Prioritizes** — which agent needs the developer most urgently, and why

### Monitoring policy

The supervisor uses an **event-driven** strategy: `HookFileWatcher` uses `fs.watch()` on per-agent JSONL hook files and immediately processes new lines as they appear. This provides near-instant anomaly detection without polling overhead.

On each hook event, the supervisor:
1. Appends the event to the agent's sliding event window (capped at `windowSize`)
2. Runs anomaly detection patterns against the accumulated events
3. If an anomaly is detected, enqueues the agent and generates an explanation
4. Broadcasts an updated snapshot to all connected frontends

A separate 5-second liveness interval reconciles session state against the dtach backend (detecting dead sessions), but event monitoring is purely event-driven.

**Ralph-loop startup probe:** `RalphLoopService.reconcileStartupLoops` runs once at server boot for each task whose `ralphLoop.status === 'running'`. It calls `probeStartupLiveness`, a startup-only helper that asks `terminalBackend.isAlive` per session with a 500 ms per-probe timeout. Loops with a probe-confirmed-alive session are preserved; the rest are marked `failed` with `exitReason: 'kookr_crash'`. The probe catches the dtach-master-killed phantom shape (WSL/OS crashes) but not the agent-child-exited shape; the latter still goes through the user-facing Replace dialog (`POST /api/tasks/:taskId/ralph-loop/replace-with-new`). See `docs/rfc/rfc-ralph-loop-crash-restart-recovery.md`.

**Startup replay:** On startup, after reconciliation identifies resumed sessions, hook files are replayed from offset 0 via `HookFileWatcher.watch(sessionId, { replayExisting: true })` to rebuild anomaly state from persisted hook history. This ensures anomalies (e.g., a permission block) are not lost across Kookr restarts. Each resumed session is also registered with the monitor via `monitor.registerAgent(sessionId)` before hook replay begins.

**Stop event suppression:** When an agent's last event is `stop` (indicating the agent finished its turn and is waiting for input), the detector skips `permission_blocked` and `repeated_error` checks. Only `needs_input` detection proceeds after a stop event. This prevents false positives from errors encountered during prior work phases that completed successfully.

**Stopped-agent guard:** When an agent is explicitly stopped (via the UI stop button), the monitor marks it in a `stoppedAgents` set and the hook file watcher is stopped. `processEvents()` silently drops events for stopped agents, preventing a race condition where buffered hook events arriving after `unregisterAgent()` could resurrect the agent in the snapshot. The stopped flag is cleared by `registerAgent()` so that relaunched agents work correctly.

Agents flagged as needing attention are surfaced to the developer in priority order (see F2.8 in [features.md](features.md)).

**GitHub PR/issue awareness:** In addition to agent event monitoring, a periodic scanner detects GitHub references in agent `tool_result` events (e.g., `gh pr create` output containing a PR URL). Extracted references are tracked per task, and the scanner periodically polls GitHub via `gh` CLI for state changes (new review comments, CI failures, review decisions). State changes are diffed against previous snapshots; actionable changes trigger attention alerts through the same attention queue used by agent anomalies. The association between a PR and a task is established at extraction time — the agent's session id maps to its owning task, so all subsequent GitHub events for that PR are routed back to the originating task. See [ADR-012](adr/012-github-pr-awareness.md) and F7 in [features.md](features.md).

> **V2 enhancement:** Transcript JSONL tailing (`transcript-parser.ts` exists but is not yet wired) will provide richer event data including full assistant messages and cost tracking. V1 relies solely on hooks for event delivery.

### How it works

The supervisor agent can be implemented in two tiers:

**Tier 1 (V1 — rule-based with templates):** Heuristic anomaly detection using patterns defined in skill files. No LLM calls for detection — just pattern matching on structured agent events (repeated tool calls, error frequency, idle time). PoC validation ([PoC 001](poc/001-hook-mechanism-validation.md)) confirmed that Claude Code in interactive mode (running in a managed dtach session) provides structured data via two channels: **transcript JSONL files** (`~/.claude/projects/<project>/<session_id>.jsonl`, same format as headless output, file-watchable) and **hooks** (`SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop` — real-time structured JSON events with session_id, tool_name, tool_input, tool_response). The `Stop` hook signals "agent waiting for input"; the `PermissionRequest` hook signals "agent blocked on permission." No ANSI terminal parsing is needed. The "explanation" is a template filled with context.

**Tier 2 (V2 — LLM-powered):** Feed recent parsed agent output to an LLM (e.g., Claude Haiku for cost efficiency) and ask: "Is this agent behaving normally? If not, explain what's wrong and what the developer should do." This enables nuanced detection that rules can't catch (trajectory drift, subtle errors, strategic dead ends).

### Anomaly detection patterns

> **V1 implementation:** Detection patterns are pure functions in `anomaly-detector.ts`, co-located with tests for simplicity. The SKILL.md approach described below is a V2 direction for community-contributable patterns.

Patterns could be defined as skill files (following the SKILL.md convention), making them discoverable and community-contributable:

```markdown
# Example: .claude/skills/detect-stuck-loop/SKILL.md
---
name: detect-stuck-loop
description: Detect when a coding agent is repeating the same action without progress
---

## Pattern
Agent has executed the same tool (e.g., Bash with `npm test`) more than 5 times
in the last 10 minutes with similar or identical output each time.

## Signals
- Same tool name repeated N times (threshold: 5)
- Output similarity > 80% across repetitions
- No file edits between repetitions, OR edits are reverted

## Explanation template
"Agent {name} has run `{tool}` {count} times in {duration}. The output is
nearly identical each time: {truncated_output}. It appears stuck in a loop
without changing its approach."

## Suggested developer action
Review the error output and provide a hint about an alternative approach.
```

Other anomaly patterns: `detect-budget-burn` (V2), `detect-trajectory-drift` (V2), `detect-repeated-error`, `detect-idle-agent`.

> **Updated 2026-05-12 — current anomaly catalogue.** The live `AnomalyType` union is defined in `src/shared/contracts/anomalies.ts` and re-exported through `src/core/types.ts`:
> `needs_input`, `permission_blocked`, `repeated_error`, `merge_conflict`, `stale_agent`, `hook_disconnected`, `hook_missing`, `tmux_unresponsive`, `api_error`, `budget_exceeded`.
> `needs_input` subsumes both `stop` and `ask_user_question` (via `Anomaly.subType`). `budget_exceeded` is emitted by `src/core/budget-checker.ts` when a task crosses its configured per-task USD threshold (F4.9). `stuck_loop` was removed; the aspirational `detect-stuck-loop` and `detect-trajectory-drift` patterns above remain V2 directions, not V1 code. Note: `tmux_unresponsive` is the symbol the code emits today; V8 Main C rename to `backend_unreachable` is pending.

---

## Components

### 1. Backend (Node.js local process)

**What it does:**
- Manages coding agents in terminal sessions (see [ADR-007](adr/007-managed-terminal-sessions.md))
- Reads structured events from transcript JSONL files and hooks for each agent
- Feeds normalized events to the supervisor agent
- Receives anomaly detections + explanations from the supervisor
- **Stores task metadata** locally: task description (the launch prompt), optional completion criteria, agent ID, timestamps. Stored in a JSON file on disk (`~/.kookr/tasks.json`) — lightweight, no database needed for V1. Data directory is `~/.kookr/` for the default port (4800) or `~/.kookr-{port}/` for non-default ports, enabling isolated dev/production instances
- **Persists agent session state** inline in `~/.kookr/tasks.json` alongside task metadata. On startup, reconciles session data with live dtach sessions the backend reports in its manifest to recover after crashes. Hook output files are written to `~/.kookr/hooks/` as append-only JSONL
- Serves the frontend SPA
- Pushes real-time updates + supervisor insights via WebSocket

### 2. Frontend (SPA served by backend, opened in browser) — [Proposal 33](spikes/gui-proposals/33-supervisor-first-triage.html)

**Chosen design:** Supervisor-first triage layout. The UI is organized around the supervisor's **findings** (anomalies detected) rather than a flat agent list. Two-panel layout: findings feed (left), interactive terminal (right).

**What it does:**
- Displays supervisor findings as rich cards with severity, explanation, and inline quick-reply — findings are the primary UI element, not the agent list
- Shows the selected agent's interactive terminal (xterm.js bridged to the agent's dtach session via `SessionBridge`) as the main content area
- Provides "Send & Next" as the primary action — responds and auto-advances to the next finding
- Tracks triage progress with queue dots in the top bar
- Collapses healthy agents into a compact section below findings
- Shows "all clear" when no agents need attention

### 3. Agent Adapter Layer

**What it does:**
- Wraps each agent type (Claude Code, Codex CLI) behind a common `AgentAdapter` interface. `RoutingAgentAdapter` dispatches to the concrete adapter by `agentType` (`claude-code-adapter.ts` or `codex-cli-adapter.ts`)
- Spawns and controls agent sessions through `LocalDtachBackend` — creation, byte-level write for input delivery, termination. The backend owns one persistent attach per session, a 64 KB ring buffer, a per-session write mutex, and lazy re-attach with a 3-per-60-s cap. Transport-level failures surface as structured `BackendError` events wired into the anomaly queue and `/api/health`
- Tails the agent's **transcript JSONL file** for structured events — same AgentEvent normalization for both agents, sourced from structured data rather than parsed terminal text
- Receives **hook events** via per-session JSONL files in `~/.kookr/hooks/`. Full event set is `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `PermissionRequest`, `Notification`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `SessionEnd` — see `HookEventName` in `src/core/hook-events.ts`. Codex CLI advertises its supported subset via `codexHookCapabilities` on `session_start`. Hooks are configured per agent via a Kookr-generated settings file (Claude Code `--settings`, Codex CLI config file); they are additive to the user's own hooks. See [PoC 001](poc/001-hook-mechanism-validation.md)
- Uses **`backend.captureBytes`** for clean terminal display snapshots (shown in the GUI, not used for anomaly detection)
- Delivers developer input as byte-level writes to the managed dtach session via `backend.write` / `backend.writeSequence`

**Five data channels per agent:**

| Channel | Purpose | Mechanism |
|---------|---------|-----------|
| Transcript JSONL | Structured session history, anomaly detection | File tail (watch for new entries) |
| Hooks | Real-time event notifications (session start, tool use, permission requests, stop) | Claude Code hook scripts invoked per event, configured via `--settings` flag |
| `backend.captureBytes` | Terminal display for GUI | Lock-free snapshot of the 64 KB ring buffer |
| GitHub state | PR/issue status, review comments, CI checks | Periodic polling via `gh` CLI ([ADR-012](adr/012-github-pr-awareness.md)) |
| Interaction log | Developer actions (inputs, skips, snoozes) for reflection | Append-only JSONL per session ([ADR-010](adr/010-session-reflection-workflow.md)) |

**Reuse strategy:**
- Fork aegiscore's `StuckDetector` as a baseline for rule-based anomaly detection — detection concepts apply directly since input is now structured events (same as aegiscore's JSONL-based approach)
- Adapt aegiscore's driver patterns for dtach session management (spawning, signal handling)

---

## Agent Session Lifecycle

> **Constraint: one task = one session.** Each task has exactly one agent session. There are no multi-session tasks. Completing or cancelling a task kills its session. Relaunching creates a new task (with a new session), preserving the original for history.

```mermaid
stateDiagram-v2
    [*] --> Starting: Launched by Kookr (terminal session)
    Starting --> Running: Terminal session active

    Running --> Stuck: Supervisor detects anomaly
    Running --> Errored: Agent error
    Running --> Completed: Agent finished
    Running --> Snoozed: Developer snoozes agent

    Stuck --> Running: Developer sends input (keystrokes to session)
    Stuck --> Snoozed: Developer snoozes agent
    Snoozed --> Running: Snooze timer expires
    Snoozed --> Completed: Agent finishes while snoozed
    Errored --> [*]: Developer acknowledges

    Completed --> [*]
```

> **Note:** `AskUserQuestion` is blocking in interactive mode — the agent waits for input naturally. This makes it a reliable "needs input" signal: when an agent emits a question and stops producing output, the supervisor can detect this as an attention-needed event. The developer can respond via Kookr's GUI (which sends keystrokes to the terminal session) or by attaching to the session directly. See [ADR-007](adr/007-managed-terminal-sessions.md).

---

## Communication

### Backend ↔ Frontend: WebSocket

> **Canonical source: `src/shared/contracts/messages.ts`** (re-exported from `src/shared/protocol.ts`). The inline type snippet that used to live here drifted from code; rather than keep two copies in sync, the doc defers to the contract file. The protocol is a tagged-union of messages keyed by a short `type` string.
>
> **ServerMessage families** (roughly grouped):
>
> - Core state push: `snapshot`, `update`, `alert`, `suggestion`
> - Playbook surface: `playbooks`
> - Multi-project surface: `projectSummaries`, `contributionWarning`
> - Achievements: `achievement:unlocked`, `achievement:reset:ack`
> - Infrastructure health: `quotaStatus`, `resourceStatus`, `circuitBreakerStatus`, `diagnosticReport`
> - Scheduled tasks: `schedules`, `scheduleFired`
> - GitHub PR/issue awareness: `githubUpdate`
> - Workspace / contribution workspace: `workspaceView`, `workspaceCleanupDetail`, `workspaceSweepComplete`, `workspaceSweepBusy`
> - OSS attempts: `ossAttempts`
>
> **ClientMessage families:**
>
> - Respond / triage: `respond`, `respondAll`, `directReply`, `navigate`, `getNext`, `skip`, `skipAll`, `snooze`, `cancelSnooze`, `stop`, `findingFeedback`
> - Task lifecycle: `launch`, `completeTask`, `setTaskFeedback`, `requestTaskReflect`, `relaunch`, `cancelTask`, `reopenTask`, `deleteTask`, `renameTask`, `clearCompleted`, `ackTerminatedTask`, `permissionChoice`
> - Playbooks: `listPlaybooks`, `launchPlaybook`
> - Session reflection: `reflect`
> - Projects: `setProjectConfig`, `selectProject`
> - Achievements: `achievement:reset`, `achievement:setEnabled`
> - Infrastructure: `rearmCircuitBreaker`, `telemetry`
> - Workspace: `workspace:getView`, `workspace:getCleanupDetail`, `workspace:cleanupCandidate`, `workspace:bulkSafeCleanup`, `workspace:runCleanupDiagnostic`, `workspace:sweep`

The `alert` message carries the supervisor's **explanation** of what's wrong with an agent. The `suggestion` message provides AI-generated response predictions and quick-action buttons when an agent needs input. The `playbooks` message returns discovered playbook templates for a given CWD. The `projectSummaries` message broadcasts per-project aggregated state (PRs, agents, contribution limits). The `contributionWarning` message alerts when a project approaches or exceeds its contribution rate limit. The `quotaStatus` and `circuitBreakerStatus` messages expose infrastructure health; the `workspaceView` family drives the contribution workspace UI.

### Backend ↔ Coding Agents: Managed Terminal Sessions + Structured Data

Agents run in managed dtach sessions (see [ADR-014](adr/014-local-dtach-backend.md)). The adapter layer reads structured data through three channels: **transcript JSONL** (file tail for session history), **hooks** (real-time event callbacks), and **`backend.captureBytes`** (ring-buffer snapshot for the GUI). Input is delivered as byte-level writes to the session via `backend.write` / `backend.writeSequence`.

> **Canonical source: `src/core/types.ts`.** The `AgentEvent` union has grown and is no longer mirrored inline here. The current variants are: `session_start`, `tool_use`, `tool_result`, `tool_error`, `subagent_start`, `subagent_stop`, `stop`, `stop_failure`, `permission_request`, `notification`, `user_prompt`, `session_end`, `error`, `input_received`. The `session_start` variant carries optional `codexHookCapabilities` so the monitor can adapt hook-missing detection to the Codex CLI subset.
>
> Events are derived from structured sources: transcript JSONL files (same format as headless output) and per-session hook JSONL files (`~/.kookr/hooks/<session>.jsonl`). No terminal output parsing is needed.
>
> **Event routing:** the active adapter emits `(sessionId, event)` — the server routes by `sessionId` (stable across restarts, the same value used as the dtach socket filename and as the `tmuxSession` field retained for legacy-schema reasons), not by agent-supplied session IDs (which require `SessionStart` to be processed first). The monitor owns anomaly detection and attention queue. Session metadata (task ID, agent type, paths, last status) is persisted inline in `tasks.json` alongside task data. Attention events remain in-memory and are rebuilt on startup from reconciled session states via hook replay; snoozes are serialized in the task-file envelope and re-imported into the queue.
>
> **`AgentStatus` note:** `AgentStatus = 'starting' | 'running' | 'stuck' | 'errored' | 'completed' | 'snoozed'` is kept for metadata on persisted sessions (`SessionInfo.lastStatus`) but is **not** used as a live state machine. Live agent state is expressed through `AgentState.anomaly` and `AgentState.snoozedUntil` in `monitor.ts`. See [`docs/system-models/05-state-machine-catalog.md`](system-models/05-state-machine-catalog.md#2-agent-session-lifecycle) for the authoritative discussion.

### Task lifecycle — `completed` vs `terminated`

`TaskStatus` has two distinct end states for a non-cancelled task:

- **`completed`** — user-acknowledged done. Reached via `completeTask()` (user clicks Complete / Mark as done), via crash-recovery reopen-then-complete, or via the upcoming OSS-playbook flow. Tasks in this state are what the "Clear completed" button sweeps by default.
- **`terminated`** — all sessions died without an explicit user acknowledgement. Reached via `reconcile()` when every session for an `inProgress` / `open` task is no longer alive. Tasks in this state are NOT swept by "Clear completed" unless the user opts in via the confirmation checkbox. The user can `ackTerminatedTask` (→ completed), reopen (→ open), or cancel (→ cancelled).

The split exists so that silent session deaths — WSL glitches, OOM kills, the dtach attach child being reaped out from under the backend — cannot propagate through a single "Clear completed" click and permanently delete work the user never saw. The Stop-hook signal was considered as a "user acknowledgement" proxy and rejected as unreliable.

### `tasks.json` snapshots

The task-persistence layer writes two kinds of on-disk snapshot alongside `tasks.json`:

- `tasks.json.daily.YYYYMMDD` — first successful save of each local day, 7-day retention.
- `tasks.json.predelete.YYYYMMDDTHHMMSS` — taken immediately before `clearCompleted` deletes any task, last 5 retained.

Snapshots run after a successful `saveTasks()` from the durable file, so a failed save never overwrites a snapshot with stale content. Snapshot errors are logged at warn level and swallowed — the primary save path must never fail because of a snapshot error.

**Restore procedure** (server must be stopped first):

```
ls -lt ~/.kookr/tasks.json.daily.* ~/.kookr/tasks.json.predelete.*
# Pick the desired snapshot
cp ~/.kookr/tasks.json.predelete.YYYYMMDDTHHMMSS ~/.kookr/tasks.json
# Restart the server
```

**Rollback caveat:** rolling back the backend to a pre-RFC version with persisted `'terminated'` tasks leaves them un-actionable by the old code. Prefer forward-fix or restore from a pre-upgrade `tasks.json.daily.*` over a `jq` status rewrite, because the rewrite replays the original data-loss pipeline on the rolled-back codebase.

---

## Module Structure (V1)

> **Rewritten 2026-04-10** to match the current code. The tree below groups files by capability instead of listing every module individually — use the source tree as the authoritative file list. Major subsystems that were missing in the previous version: Codex CLI support, circuit breakers, workspace-cleanup / worktree leases, scheduled tasks, split route modules, the server `use-cases/` layer, and the Zustand slice architecture on the frontend.
>
> **Drift-reconcile 2026-04-22** added the OSS-attempts cluster: `oss-attempts-routes.ts` (server route), `oss-attempts-slice.ts` (Zustand slice), `oss-trends.ts` (frontend aggregation), and the OSS-dashboard components `OssProductivityView`, `OssWeeklyBars`, `OssTrendsErrorBoundary`, plus `DiffPane` and `markdown.ts`, which were live in code but missing from the tree.
>
> **Drift-reconcile 2026-05-09** refreshed the grouped inventory for Ralph loops, checkpoint cycling, workspace cleanup, Telegram/STT integration, frontend onboarding/effective-hooks controls, and shared contract modules. The tree remains capability-grouped; it is not an exhaustive file manifest.
>
> **Drift-reconcile 2026-05-19** added the remote session-sharing module, newer route/event-processor files, dtach manifest/ring stores, frontend audio/task-sharing controls, and removed stale component/file names that no longer exist (`ralph-stop.ts`, `LaunchDialog`, `AgentExecutionConfig`, `CapacityGauge`).

```
kookr/
├── src/
│   ├── shared/                            # Cross-boundary contracts (server + frontend both import here)
│   │   ├── protocol.ts                    # Re-exports ServerMessage/ClientMessage + shared core types
│   │   ├── contracts/messages.ts          # Canonical WS protocol tagged-union
│   │   ├── contracts/client-message-schema.ts # Runtime client-message validation helpers
│   │   ├── contracts/agent-*.ts           # Shared agent event/state/type contracts
│   │   ├── contracts/anomalies.ts         # Canonical AnomalyType/Anomaly contract
│   │   ├── contracts/task*.ts             # Task, task-status, and completion contracts
│   │   ├── contracts/playbook.ts          # Shared playbook DTOs
│   │   ├── contracts/ralph.ts             # Ralph loop request/response contracts
│   │   ├── contracts/ralph-iteration-log.ts # Ralph iteration-log DTOs
│   │   ├── contracts/session-sharing-*.ts # Public/owner/recovery sharing contracts
│   │   ├── contracts/relay-connection.ts  # Hosted relay connection contract
│   │   ├── contracts/workspace.ts         # Workspace cleanup/start-work contracts
│   │   └── repo-slug.ts                   # GitHub `owner/repo` normalization
│   │
│   ├── server/                            # HTTP (Hono) + WebSocket server
│   │   ├── index.ts                       # Bootstrap: HTTP/WS, graceful shutdown
│   │   ├── start.ts                       # Startup, config parsing, signal handling
│   │   ├── config.ts                      # Server config surface
│   │   ├── bootstrap/                     # Background-service startup sequencing
│   │   ├── startup-recovery.ts            # Reconcile crashed-state on boot
│   │   ├── crash-recovery.ts              # Relaunch agents that died after a crash
│   │   ├── routes.ts                      # Hono app assembly
│   │   ├── routes/                        # Split route modules:
│   │   │   ├── task-routes.ts             #   task CRUD + lifecycle
│   │   │   ├── project-routes.ts          #   project summaries
│   │   │   ├── schedule-routes.ts         #   scheduled-task CRUD
│   │   │   ├── settings-routes.ts         #   settings / prefs
│   │   │   ├── deploy-routes.ts           #   prod-update helpers
│   │   │   ├── diagnostics-routes.ts      #   self-diagnostic
│   │   │   ├── contact-share-routes.ts    #   contact-share management
│   │   │   ├── relay-connection-routes.ts #   hosted relay connection state
│   │   │   ├── share-routes.ts            #   task/session sharing endpoints
│   │   │   ├── session-sharing-recovery-routes.ts # recovery/status endpoints
│   │   │   ├── oss-attempts-routes.ts     #   OSS contribution attempts + trends API
│   │   │   └── shared.ts                  #   common helpers
│   │   ├── use-cases/                     # Server business logic (agent-input, delete-task,
│   │   │                                  #   get-snapshot, playbook-launch,
│   │   │                                  #   workspace-cleanup-*, workspace-context, ...)
│   │   ├── ws.ts                          # Thin WS dispatcher (delegates to ws-handlers/*)
│   │   ├── ws-connection-handler.ts       # Per-connection lifecycle
│   │   ├── ws-handlers/                   # Per-message-type WS handlers (split from ws.ts):
│   │   │   ├── anomaly-handler.ts         #   respondToAnomaly / skip / snooze / cancelSnooze
│   │   │   ├── config-handler.ts          #   settings + config updates
│   │   │   ├── launch-result.ts           #   launch acknowledgements
│   │   │   ├── lifecycle-handler.ts       #   task start/stop/complete/cancel/reopen/ack
│   │   │   ├── playbook-handler.ts        #   listPlaybooks / launchPlaybook
│   │   │   ├── reflection-handler.ts      #   reflection request/ack
│   │   │   ├── sweep-handler.ts           #   cross-project workspace cleanup sweep
│   │   │   └── workspace-handler.ts       #   workspace cleanup messages
│   │   ├── event-processors/              # Per-event side effects:
│   │   │                                  #   GitHub events,
│   │   │                                  #   permission quick actions/alerts,
│   │   │                                  #   response assist, session activity,
│   │   │                                  #   stop-token scanning, token accounting
│   │   ├── event-projection.ts            # Strip transport-unused AgentEvent fields
│   │   ├── oss-attempts-snapshot.ts       # Serialize OSS attempts for WS snapshot
│   │   ├── hook-watcher.ts                # Tail per-session hook JSONL files
│   │   ├── reconciliation.ts              # Startup reconciliation of tasks vs live backend sessions
│   │   ├── session-bridge.ts              # Bridge xterm.js ↔ TerminalBackend byte stream
│   │   ├── fake-terminal-bridge.ts        # Fake terminal for E2E / demo mode
│   │   ├── agent-lifecycle.ts             # Agent launch/stop/cleanup + pending-task promotion
│   │   ├── agent-preflight.ts             # Agent binary availability/version preflight
│   │   ├── launch-service.ts              # High-level launch orchestration
│   │   ├── event-pipeline.ts              # Wires adapter events into monitor/tracker/watchdog
│   │   ├── lifecycle-timers.ts            # Periodic timers: liveness, reconciliation, task save
│   │   ├── ralph-loop-service.ts          # Ralph iteration-loop orchestration
│   │   ├── ralph/                         # Ralph HTTP routes and stop-event ownership
│   │   │   ├── routes.ts
│   │   │   ├── stop-event-ownership.ts
│   │   │   └── stop-event-processor.ts
│   │   ├── schedule-runner.ts             # Cron-driven scheduled tasks
│   │   ├── schedule-service.ts            # Schedule CRUD + persistence
│   │   ├── schedule-validator.ts          # Cron / schedule validation
│   │   ├── reflection-task.ts             # Session reflection background task (ADR-010)
│   │   ├── diagnostic-runner.ts           # Self-diagnostic job runner
│   │   ├── oss-refresh.ts                 # OSS contribution PR/linked-issue refresh
│   │   ├── oss-source-watcher.ts          # Watches OSS source files for refresh triggers
│   │   ├── achievement-watcher.ts         # Detect achievement unlocks, persist
│   │   ├── ledger-watcher.ts              # Watch OSS contribution ledger
│   │   ├── resource-status-service.ts     # System resource sampling surface
│   │   ├── system-resource-sampler.ts     # CPU/memory/disk sampling
│   │   ├── task-share-service.ts          # Task sharing service boundary
│   │   ├── relay-*.ts                     # Hosted relay lifecycle/client/connection stores
│   │   ├── remote-*.ts                    # Remote command/input adapters
│   │   ├── share-*.ts                     # Share projection/diagnostics services
│   │   ├── worktree-guardrails.ts         # Enforce worktree safety invariants
│   │   ├── settings-side-effects.ts       # React to settings changes
│   │   ├── hash-prompt.ts                 # Prompt hashing helper
│   │   ├── prompt-file-paths.ts           # Per-agent prompt file resolution
│   │   ├── stt-manager.ts                 # Docker lifecycle for bundled STT
│   │   └── tts-manager.ts                 # Docker lifecycle for bundled TTS
│   │
│   ├── core/                              # Pure logic — no I/O
│   │   # Types + contracts
│   │   ├── types.ts                       # AgentEvent, AgentStatus, TaskStatus, Anomaly, HookEventName
│   │   ├── agent-types.ts                 # AgentType + AVAILABLE_AGENT_TYPES
│   │   ├── activity-summary.ts            # Activity summarizer + tool categorization (frontend-facing)
│   │   ├── completion-digest.ts           # Task completion summary
│   │   ├── build-info.ts                  # Build metadata (commit, branch, timestamp)
│   │   # Tasks + sessions
│   │   ├── tasks.ts                       # In-memory task store + state machine
│   │   ├── task-persistence.ts            # Atomic JSON file persistence
│   │   ├── task-read-model.ts             # Read DTOs for tasks
│   │   ├── task-status.ts                 # TaskStatus / AgentStatus / TurnState unions
│   │   ├── session-read-model.ts          # Session DTOs
│   │   ├── task-naming.ts                 # AI task naming via LLM (F4.8)
│   │   ├── token-tracker.ts               # Token/cost tracking per session (F4.9)
│   │   # Supervisor: detection + queue
│   │   ├── monitor.ts                     # Event-driven supervisor orchestrator
│   │   ├── anomaly-detector.ts            # Pure detection patterns
│   │   ├── detection-stats.ts             # Detector counters, suppression stats, false-positive feedback
│   │   ├── attention-queue.ts             # Priority queue, snooze, cancelSnooze
│   │   ├── snooze-suppression.ts          # Suppress re-alerts during snooze
│   │   ├── budget-checker.ts              # Emits budget_exceeded anomalies
│   │   ├── watchdog.ts                    # Heartbeat watchdog for stale agents
│   │   ├── process-liveness.ts            # Process liveness / crash detection
│   │   ├── hook-parser.ts                 # Parse hook JSON → AgentEvent
│   │   ├── transcript-parser.ts           # Transcript JSONL → AgentEvent[] (exists, not yet wired)
│   │   ├── pane-patterns.ts               # Terminal pane semantic cross-validation
│   │   ├── permission-actions.ts          # Permission-prompt quick-action extraction
│   │   ├── http-push-tracker.ts           # HTTP push latency tracker for shadow detection
│   │   ├── shadow-detector.ts             # Shadow mode for detection strategies
│   │   ├── combined-shadow-strategy.ts    # Shadow strategy orchestrator
│   │   ├── shadow-report.ts               # Offline shadow report generator
│   │   ├── self-diagnostic.ts             # Runtime self-diagnostic
│   │   ├── turn-state.ts                  # Current-turn state derivation
│   │   ├── activity-ledger.ts             # Persistent activity log
│   │   ├── attention-miss-review.ts       # Attention miss review helpers
│   │   ├── finding-evidence-audit.ts      # Evidence audit model
│   │   ├── finding-evidence-review.ts     # Finding evidence review logic
│   │   # Response assist + suggestions
│   │   ├── context-feedback.ts            # Context-window feedback helpers
│   │   ├── response-assist.ts             # Quick-action extraction (F3.8)
│   │   ├── response-suggest.ts            # AI response suggestions (F3.9)
│   │   ├── suggestion-telemetry.ts        # Suggestion telemetry aggregation
│   │   ├── feedback-bundle.ts             # Immutable per-task reflection bundle
│   │   # Reflection + friction
│   │   ├── interaction-log.ts             # User interaction event log (F8, ADR-010)
│   │   ├── friction-analyzer.ts           # Rule-based friction pattern detection (F8)
│   │   ├── reflection-recommendation.ts   # Recommendations emitted by reflection
│   │   # LLM clients
│   │   ├── llm-client.ts                  # Provider-agnostic LLM interface + fallback
│   │   ├── anthropic-client.ts            # Anthropic SDK implementation
│   │   ├── google-client.ts               # Google Gemini implementation
│   │   ├── groq-client.ts                 # Groq implementation
│   │   ├── openrouter-client.ts           # OpenRouter (OpenAI-compatible) implementation
│   │   ├── llm-factory.ts                 # Provider selection
│   │   ├── llm-types.ts                   # Provider DTOs
│   │   ├── circuit-breaker.ts             # Generic circuit-breaker primitive
│   │   ├── circuit-breaker-llm-client.ts  # LLM client wrapped in a breaker
│   │   # GitHub awareness (F7 / ADR-012)
│   │   ├── github-types.ts
│   │   ├── github-reference-scanner.ts
│   │   ├── github-state-store.ts
│   │   ├── github-state-differ.ts
│   │   ├── github-scanner-service.ts
│   │   ├── github-alerts.ts
│   │   ├── launch-dependency-preflight.ts # Launch dependency checks
│   │   ├── contact-share.ts               # Contact-share domain model
│   │   # Telemetry + training data
│   │   ├── telemetry.ts                   # Session telemetry event log
│   │   ├── telemetry-report.ts            # Telemetry aggregation
│   │   ├── training-data-logger.ts        # JSONL logger for future local model
│   │   # Projects + contributions
│   │   ├── project-summary.ts             # Per-project aggregated state
│   │   ├── project-identity.ts            # Git remote → canonical project ID
│   │   ├── project-config-store.ts        # Per-project configuration persistence
│   │   ├── oss-attempt-store.ts           # OSS contribution attempt records + ledger
│   │   ├── ledger-analytics.ts            # Analytics over OSS contribution ledger
│   │   ├── repo-policy-resolver.ts        # Per-repo contribution policy resolver
│   │   ├── repo-tags.ts                   # Repo tag helpers
│   │   ├── project-sidebar-store.ts       # Project sidebar persisted state
│   │   ├── skill-tracked-repo-discovery.ts# Skill-tracked repo sidebar source
│   │   ├── pr-lessons-discovery.ts        # Discover PR-lesson playbooks
│   │   # Playbooks + scheduling
│   │   ├── playbook.ts                    # Playbook type definitions (F6)
│   │   ├── playbook-parser.ts             # Frontmatter parse + parameter interpolation
│   │   ├── playbook-discovery.ts          # Scan .kookr/playbooks/ and repos for playbooks
│   │   ├── schedule.ts                    # Schedule types
│   │   ├── cron.ts                        # Cron expression helpers
│   │   # Workspace cleanup + worktree leases
│   │   ├── workspace-types.ts             # Shared workspace contracts
│   │   ├── workspace-attempt-repository.ts# Persistent attempt records
│   │   ├── workspace-cleanup-policy.ts    # Cleanup safety policy
│   │   ├── worktree-lease-service.ts      # Worktree lease allocation
│   │   ├── worktree-protection.ts         # Worktree safety enforcement
│   │   ├── git-helpers.ts                 # Git helpers shared by server
│   │   ├── persistence-utils.ts           # Atomic/persistent file utilities
│   │   ├── settings-store.ts              # Server settings persistence
│   │   ├── achievement-catalog.ts         # Achievement definitions
│   │   ├── pricing-tables.ts              # Provider pricing metadata
│   │   ├── plugin-paths.ts                # Plugin path resolution helpers
│   │   ├── hook-*.ts                      # Hook event/spec/path helpers
│   │   └── kb-*.ts                        # KB context injection + lesson classification
│   │
│   ├── adapters/                          # I/O boundaries (ports-and-adapters pattern)
│   │   ├── terminal-backend.ts            # TerminalBackend interface (dtach-only post-V8)
│   │   ├── local-dtach-backend.ts         # Real dtach-backed TerminalBackend
│   │   ├── fake-terminal-backend.ts       # In-memory fake for tests
│   │   ├── keystroke.ts                   # Keystroke encoding helpers for terminal input
│   │   ├── agent-adapter.ts               # Common AgentAdapter interface
│   │   ├── routing-agent-adapter.ts       # Dispatches by agentType
│   │   ├── claude-code-adapter.ts         # Managed Claude Code sessions
│   │   ├── codex-cli-adapter.ts           # Managed Codex CLI sessions
│   │   ├── codex-config.ts                # Codex CLI config/settings emission
│   │   ├── codex-rollout-scanner.ts       # Codex rollout metadata discovery
│   │   ├── effective-hook-settings.ts     # Persist/read effective hook settings per session
│   │   ├── agent-launch-context.ts        # Per-launch env + paths
│   │   ├── dtach-manifest-store.ts        # Durable dtach manifest
│   │   ├── dtach-ring-store.ts            # Durable ring-buffer state
│   │   ├── file-based-agents.ts           # File-backed agent inventory helpers
│   │   ├── probe-agent-binary.ts          # Agent binary probe helpers
│   │   ├── quota-adapter.ts               # Usage-quota surface for LLM providers
│   │   ├── github-fetcher.ts              # `gh` CLI wrapper (REST + GraphQL)
│   │   ├── circuit-breaker-github-fetcher.ts    # Circuit-breaker wrapper
│   │   ├── git-info.ts                    # Git branch/commit from filesystem
│   │   ├── git-worktree-registry.ts       # Worktree registry
│   │   ├── git-worktree.ts                # Git worktree create/cleanup
│   │   └── worktree-marker.ts             # Protected-worktree markers
│   │
│   ├── integrations/                      # Optional integration surfaces
│   │   └── telegram/                      # Telegram voice/text ingestion and STT bridge
│   │       ├── index.ts                   # Integration entrypoint
│   │       ├── api-client.ts              # Telegram API wrapper
│   │       ├── parse-task.ts              # Message -> launch-task parsing
│   │       ├── transcribe.ts              # Voice transcription bridge
│   │       ├── rephrase.ts                # Prompt rephrasing
│   │       ├── safety.ts                  # Launch safety checks
│   │       ├── audit.ts                   # Audit logging
│   │       ├── warmup.ts                  # STT warmup
│   │       └── fake-telegram-server.ts    # Test/dev fake server
│   │
│   ├── remote/                            # Session-sharing / hosted-relay domain
│   │   ├── share-policy.ts                # Share/mutation policy
│   │   ├── grants.ts                      # Access grants
│   │   ├── handshake.ts                   # Relay handshake
│   │   ├── launch-allowlist.ts            # Remote launch allowlist
│   │   ├── launch-broker.ts               # Supervised remote launches
│   │   ├── command-pipeline.ts            # Remote command validation + dispatch
│   │   ├── command-journal.ts             # Durable command journal
│   │   ├── permission-broker.ts           # Remote permission decisions
│   │   ├── session-stream-publisher.ts    # Terminal/event publication
│   │   ├── terminal-frame-crypto.ts       # Terminal frame encryption
│   │   ├── terminal-publication-gate.ts   # Publication policy gate
│   │   ├── policy-*.ts                    # Policy cache/sync
│   │   ├── projections.ts                 # Public/private projections
│   │   ├── push.ts                        # Push transport helpers
│   │   └── stream-events.ts               # Remote stream event contracts
│   │
│   └── frontend/                          # SPA (React + Vite — ADR-002)
│       ├── App.tsx                        # Root component with keyboard shortcuts
│       ├── main.tsx                       # Entry point
│       ├── index.html                     # HTML shell
│       ├── styles.css                     # Dark theme CSS
│       ├── presentation.ts                # Pure presentation helpers
│       ├── telemetry.ts                   # Frontend telemetry client
│       ├── agent-buckets.ts               # Agent grouping helpers
│       ├── derive-project-cwd.ts          # Project CWD helpers
│       ├── resource-status.ts             # Resource status presentation
│       ├── terminal-send.ts               # Terminal send helpers
│       ├── terminal-paste.ts              # Terminal paste helpers
│       ├── audio/                         # Browser sound preferences + alert log
│       ├── group-findings.ts              # Finding grouping for FindingsPanel
│       ├── markdown.ts                    # Markdown rendering helpers
│       ├── oss-trends.ts                  # OSS contribution trend aggregation for the dashboard
│       ├── components/                    # React components — see `src/frontend/components/`
│       │   # Triage surface: FindingsPanel, DetailPanel, TerminalPanel, TopBar, StatusBar,
│       │   #                 SnoozeDialog, SnoozeGroup, SentOverlay, Toasts, Tooltip,
│       │   #                 ConfirmDialog, CompleteDialogFooter, ShortcutsHelp, AchievementToast,
│       │   #                 DiffPane, DndPill
│       │   # Launch / playbooks: LaunchTaskDialog, PlaybookBrowser, PlaybookSelector,
│       │   #                     PlaybookParameterForm, QuickLaunch,
│       │   #                     AgentTypeSelector
│       │   # Projects + GitHub: ProjectSidebar, ProjectSidebarManager, ProjectDetailDrawer,
│       │   #                    GitHubPanel, ContributionWorkspace, CleanupCandidateTable
│       │   # Sharing: TaskShareModal, TaskIdCopyButton
│       │   # OSS trends dashboard: OssProductivityView, OssWeeklyBars, OssTrendsErrorBoundary
│       │   # Ralph + onboarding: RalphLoopPanel, OnboardingTour, OnboardingLayoutDiagram
│       │   # Infra + diagnostics: OperationsPanel, AudioAlertsPanel, CircuitBreakerPanel, DetectionStatsPanel,
│       │   #                      ActivityPanel, AchievementsPanel, SettingsDialog,
│       │   #                      ScheduleSection, SchedulesDialog, VoiceInputButton,
│       │   #                      EffectiveHookSettingsModal, HookInventorySection,
│       │   #                      SweepButton, FilterableSelect
│       │   # Component helpers: cleanup-row-format, detail-panel-focus,
│       │   #                    detail-panel-visibility, onboarding-tour-targets
│       ├── hooks/                         # useWebSocket, useNotifications, useAudibleAlert,
│       │                                  # useSTT, useEscapeToClose, useDnd, usePersistedCollapsed
│       └── store/                         # Zustand store
│           ├── useStore.ts                # Root store composed of slices
│           ├── store-types.ts             # Store-wide types
│           ├── slices/                    # achievements-system, project-sidebar,
│           │                              # transport-session, triage-navigation, workspace,
│           │                              # oss-attempts, system-status
│           ├── onboarding-store.ts        # Onboarding tour state
│           ├── onboarding-status.ts       # Onboarding persistence state
│           ├── launch-task-dialog-draft.ts# Launch dialog draft persistence
│           ├── finding-helpers.ts         # Finding-related selectors
│           ├── playbook-params.ts         # Playbook parameter form state
│           ├── playbook-source-resolver.ts# Resolve playbook source URLs
│           ├── playbook-usage.ts          # Playbook recency/pinning tracker
│           ├── project-sidebar-prefs.ts   # Sidebar prefs (localStorage)
│           └── recent-paths.ts            # MRU path list
├── package.json
├── tsconfig.json
└── vite.config.ts
```

> **Note on `src/shared/`:** The `shared/` layer contains the `ServerMessage`/`ClientMessage` protocol types used by both the server and frontend. The canonical definitions live in `src/shared/contracts/messages.ts` and are re-exported from `src/shared/protocol.ts`. The frontend also imports some pure `src/core/*` types/helpers directly (`Task`, `AgentEvent`, playbook DTOs, workspace DTOs, etc.); what remains forbidden is importing server or adapter I/O internals into the SPA.
>
> **Note on `GitInfo`:** The `GitInfo` interface lives in `src/core/types.ts`. The `src/adapters/git-info.ts` module re-exports it alongside the I/O function `getGitInfo()`, keeping the core layer free of adapter dependencies.
>
> **Note on agent adapters:** Kookr supports two coding-agent CLIs — Claude Code and the forked Codex CLI — through a `RoutingAgentAdapter` that dispatches by `agentType`. The Codex fork lives at `~/git/codex` and is rebuilt via `pnpm codex:rebuild`. See the project `CLAUDE.md` for the build/deploy workflow.

> **Design note:** The original architecture envisioned a monolithic `supervisor.ts` module. In implementation, the supervisor logic was split into three focused modules — `anomaly-detector.ts` (detection), `attention-queue.ts` (prioritization), and `monitor.ts` (orchestration). This separation improves testability (each module is a pure function or small class) and follows the single-responsibility principle.
>
> **Design note:** Anomaly detection patterns are implemented as pure functions in `anomaly-detector.ts` rather than as SKILL.md files. The SKILL.md approach (community-contributable, discoverable patterns) remains a valid V2 direction, but V1 keeps detection logic co-located with its tests for simplicity.

## OSS tracking: manual recovery

The OSS refresher (`src/server/oss-refresh.ts`) caches the verified state of each PR's linked issue in `~/.kookr/oss-attempts.json` under `linkedIssue.state`. Once a linked issue is cached as `closed`, the refresher never re-polls it — a rare reopen is accepted latency in exchange for bounded `gh api` cost.

If you need to force a re-check (e.g. a linked issue was reopened and a PR is still legitimately in flight), edit the snapshot directly with `jq` and trigger a refresh:

```bash
# Clear linkedIssue on ONE record (owner/repo#NNN → the attempt id):
jq '(.attempts[] | select(.id == "owner/repo#1234") | .linkedIssue) = null' \
  ~/.kookr/oss-attempts.json > /tmp/x && mv /tmp/x ~/.kookr/oss-attempts.json

# Clear linkedIssue on EVERY record:
jq '.attempts |= map(.linkedIssue = null)' \
  ~/.kookr/oss-attempts.json > /tmp/x && mv /tmp/x ~/.kookr/oss-attempts.json
```

Then hit the dashboard's **Refresh** button (or restart the server). The refresher re-populates `linkedIssue` for every `pr_open` record that has a `Fixes/Closes/Resolves #N` in its body.

The dashboard also surfaces an amber warning banner whenever the last refresh had one or more issue-state fetch errors. The banner is sourced from the store snapshot's `lastRefreshIssueCheckErrors` field, so it is visible regardless of which refresh path (manual button, startup refresh, future timer) produced the errors.

---

## What We Deferred (and why)

| Element | Why deferred | When to add |
|---------|-------------|-------------|
| Agent discovery via session files | Managed terminal sessions are Kookr-created; discovering externally-started agents is a separate problem | When "take over" makes discovered agents actionable |
| ~~Monitoring mechanism decision~~ | **Validated by PoC:** hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`) + transcript JSONL file tailing provide structured data — no terminal parsing needed. Hook configuration: Kookr generates a per-agent settings JSON file passed via `--settings` flag. Hooks are additive to user settings. See [PoC 001](poc/001-hook-mechanism-validation.md) | ~~Phase 1 PoC~~ Done |
| ~~Terminal multiplexer choice~~ | **Validated and migrated:** dtach replaced tmux ([ADR-014](adr/014-local-dtach-backend.md)). Agents run under dtach-backed sessions; `backend.captureBytes` provides display snapshots from the ring buffer | Done |
| LLM-powered supervisor (Tier 2) | Start with rule-based detection; add LLM when rules aren't enough | When rule-based detection misses real anomalies |
| Plugin system | No users, no plugins needed | When community requests extensions |
| Session history / analytics DB | Inline session metadata in tasks.json provides the foundation; full history and analytics still need a database | When users want cross-session history or usage analytics |
| Monorepo structure | One package is simpler | When we have 3+ distinct packages |
| Cloud deployment | Local-first solves the VPN problem | When there's demand |
| Gemini CLI adapter | Focus on Claude Code first | After V1 stabilizes |
| Windows support | Linux + macOS first | When there's demand |

---

## Reuse Map

| Component | Source | How we reuse it |
|-----------|--------|----------------|
| Stuck detector (baseline) | aegiscore `stuck-detector.ts` | Fork as starting point for supervisor's rule-based tier. Detection concepts apply directly — input is structured events from transcript JSONL and hooks, same paradigm as aegiscore's JSONL-based approach |
| Agent output patterns | aegiscore `claude-code-runner.ts`, `codex-cli-driver.ts` | Study output format knowledge to inform transcript JSONL parsing and hook event handling |
| Process spawning patterns | aegiscore drivers | Adapt spawn + clean env + signal handling for dtach session creation via node-pty |
| WebSocket frame pattern | openclaw gateway protocol | Simplified version (no RPC, just events) |
| Skill file format | Claude Code `.claude/skills/` | Follow SKILL.md convention for anomaly patterns |
