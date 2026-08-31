# Requirements Specification

Structured, testable requirements derived from [features.md](features.md), [architecture.md](architecture.md), [roadmap.md](roadmap.md), ADRs, and the current implementation.

**Conventions:**
- **SHALL** — mandatory for V1 (MVP "must have")
- **SHOULD** — desired for V1 (MVP "nice to have")
- **MAY** — deferred (V2+)
- **Feature ref** — links to [features.md](features.md) feature IDs (F1.1–F5.5)
- **Status** — `done` (implemented + tested), `partial` (partially implemented), `todo` (not started), `deferred` (explicitly out of V1 scope)

---

## R1: Agent Monitoring

### R1.1: Show Agent Status [F1.2] — SHALL — `done`

The system SHALL display the current status of each Kookr-managed agent, updated in real time.

**Acceptance criteria:**
- Each agent shows one of: `starting`, `running`, `stuck`, `errored`, `completed`, `snoozed`
- Status updates are pushed to the frontend via WebSocket within 1 polling cycle
- Status is derived from hook events and anomaly detection, not terminal output parsing

**Evidence:** `src/core/types.ts` (AgentStatus union), `src/core/monitor.ts` (polling loop), `src/server/ws.ts` (broadcast), `src/frontend/store/useStore.ts` (state handling). 133 tests pass.

### R1.2: Show Current Activity [F1.3] — SHOULD — `partial`

The system SHOULD display each agent's current activity: tool calls, files being modified, last assistant message.

**Acceptance criteria:**
- Tool use events (from `PreToolUse`/`PostToolUse` hooks) shown in agent detail panel
- Last assistant message available from `Stop` hook payload
- Activity updates in real time via WebSocket
- Healthy rail rows show a compact current-tool label (via `toolLabel`) only when the latest event is `tool_use`; any later event (including `stop` / `session_end`) hides it so idle rows cannot keep a stale tool name
**Evidence:** Hook parser (`src/core/hook-parser.ts`) extracts tool_use events. Real-time hook tailing via `src/server/hook-watcher.ts`. Agent activity is visible through the interactive terminal panel. Healthy rows render `healthyCurrentToolLabel` next to duration.

### R1.3: Show Agent Metadata [F1.4] — SHOULD — `partial`

The system SHOULD display agent metadata: display name, agent type, working directory, session duration.

**Acceptance criteria:**
- Display name derived from task prompt (collapsed to a single line and sent in full up to a 200-char payload cap; the finding card / healthy row truncates it to the available width via CSS ellipsis) shown in finding cards, healthy rows, detail header, and response placeholder — falling back to `agentId` when no task is linked
- Working directory shown in detail header (provided at launch)
- Agent type shown in detail header (Claude Code for V1)
- Session duration shown in finding card header (`Xm`), detail header, healthy rows, and status bar — computed from session `startedAt` relative to now, except the detail header freezes at `finishedAt` for terminal (completed/cancelled/terminated) tasks (#2737)
- `AgentState` carries `taskName`, `cwd`, `agentType`, and `startedAt` fields populated from the task store via `Monitor.getSnapshot()`
- Healthy agent rows show a status dot: green for running agents, grey for completed agents (last event is `stop` with no anomaly)

**Evidence:** Task store (`src/core/tasks.ts`) holds `cwd`, `agentType`, `createdAt`. The display name is projected in `src/server/use-cases/snapshot-projection.ts` (`promptTitle`, single-line, 200-char cap). Frontend components render metadata in FindingsPanel and DetailPanel.

### R1.4: Auto-discover Running Agents [F1.1] — MAY — `deferred`

The system MAY auto-discover Claude Code, Codex CLI, and Gemini CLI processes already running on the machine.

**Rationale for deferral:** V1 manages its own agents. Discovery adds no value without "take over" support. See [ADR-005](adr/005-discovered-agent-degradation.md).

### R1.5: Detect New and Exited Agents [F1.5] — MAY — `deferred`

The system MAY automatically detect when new agents start or existing agents exit outside of Kookr's management.

**Rationale for deferral:** Depends on R1.4 (agent discovery). V1 tracks only Kookr-launched agents.

### R1.6: Reconcile Agent Worktree Health [F1.4] — SHOULD — `partial`

The system SHOULD reconcile Kookr-managed task sessions against the live `git worktree list` registry.

**Acceptance criteria:**
- At startup, the backend refreshes the worktree registry before task/session reconciliation.
- While dashboard clients are connected, the backend refreshes the registry on the liveness tick.
- A live session whose `cwd` is absent from the refreshed registry is marked `missing_unexpectedly` without stopping the terminal session.
- Successful completed tasks that previously observed missing worktree state surface `cleaned_up` instead of an ambiguous missing state.
- A prunable worktree or failed registry refresh is surfaced as stale metadata in the agent snapshot.
- Agent snapshots carry worktree health so the frontend can render a compact warning near project/branch metadata.
- Agent snapshots carry a server-computed project display label so per-agent badges do not re-derive project identity from `cwd` basenames.
- Worktrees owned by tasks that reconcile drove to a terminal state (completed/terminated) are reaped through the same safety-gated cleanup as manual completion — on both the boot reconcile and the liveness-tick reconcile. The completed subset honors the `cleanupWorktreeOnComplete` setting; the terminated subset is always reaped; dirty, unmerged, and worktrees still shared by a live task are preserved; and a task a live session has re-adopted (user reopen or boot crash-recovery relaunch) is skipped.

**Evidence:** `src/adapters/git-worktree-registry.ts`, `src/adapters/git-worktree.ts` (`cleanupReconciledTaskWorktrees`), `src/server/reconciliation.ts`, `src/server/lifecycle-timers.ts`, `src/server/index.ts`, `src/core/monitor.ts`, `src/frontend/components/DetailPanel.tsx`, `src/frontend/components/FindingsPanel.tsx`.

### R1.7: Preserve Completed Task Implementation Metadata [F1.4] — SHOULD — `done`

The system SHOULD preserve enough closeout metadata for completed Kookr-managed tasks to support later supervision and reflection without reopening transcripts manually.

**Acceptance criteria:**
- Completed Codex CLI tasks include branch, commit SHA(s), PR URL(s), and final diff files in `completionDigest` when available
- Verification commands run by the agent are preserved in `completionDigest`
- Codex rollout token totals and cost are included when available and priceable
- Missing Codex token/cost data is represented with an explicit quality/reason instead of silent all-zero totals

**Evidence:** `src/core/completion-digest.ts`, `src/server/completion-metadata.ts`, `src/server/ws-handlers/lifecycle-handler.ts`, `src/server/ralph-loop-service.ts`, `src/core/completion-digest.test.ts`, `src/server/completion-metadata.test.ts`.

### R1.8: Acknowledge User Completion Quickly [F4.4] — SHOULD — `done`

The system SHOULD acknowledge a user-initiated task completion before slow terminal teardown or closeout metadata enrichment finishes.

**Acceptance criteria:**
- Clicking Complete transitions the task to `completed` without waiting for the terminal backend's graceful kill timeout.
- Completion digest and token/cost enrichment continue in the background and update the completed task when available.
- Ralph iteration completion MAY remain synchronous when the terminal Stop hook is required to advance the loop.

**Evidence:** `src/server/agent-lifecycle.ts`, `src/server/ws-handlers/lifecycle-handler.ts`, `src/server/agent-lifecycle.test.ts`.

---

## R2: Anomaly Detection

### R2.1: Detect "Needs Input" State [F2.1] — SHALL — `done`

The system SHALL detect when a managed agent is waiting for developer input.

**Acceptance criteria:**
- Detection triggered by (1) the `Stop` hook event (agent finished its turn), OR (2) a `tool_use` event with `toolName === 'AskUserQuestion'` (agent explicitly asks for input)
- `last_assistant_message` from the Stop payload captured for context
- Agent enters the attention queue with anomaly type `needs_input`
- Severity: `info` for Stop events, `warning` for AskUserQuestion (higher urgency since the agent is explicitly asking)
- AskUserQuestion anomaly is cleared when a subsequent `tool_result` event is received (question was answered)
- A Stop-derived `needs_input` state remains active when trailing bookkeeping or overlay events arrive after the Stop, including `SubagentStop` and `Notification(idle_prompt)`, until real user input, new tool activity, or session end changes the agent state

**Evidence:** `src/core/hook-parser.ts` (Stop → stop event, PreToolUse → tool_use event), `src/core/anomaly-detector.ts` (needs_input via detectNeedsInput + detectAskUserQuestion), `src/core/monitor.ts` (event → queue), `src/core/monitor.test.ts` ("Stop event enters attention queue as needs_input", "Stop followed by SubagentStop and idle notification remains queued as needs_input", "AskUserQuestion tool enters queue as needs_input with warning severity"). Validated by [PoC 001](poc/001-hook-mechanism-validation.md).

### R2.2: Detect Stuck Loops [F2.2] — SHOULD — `deferred`

The system SHOULD detect when an agent is repeating the same action without meaningful change.

**Status:** Deferred to V2. Deterministic detection (counting consecutive same-tool calls) produces false positives — e.g., an agent reading 20 files is normal exploration, not a stuck loop. The `stuck_loop` anomaly type was removed from the codebase. V2 will re-introduce stuck-loop detection via the AI supervisor agent, which can apply semantic understanding of agent behavior.

### R2.3: Detect Repeated Errors [F2.3] — SHOULD — `done`

The system SHOULD detect when an agent keeps hitting the same error without changing approach.

**Acceptance criteria:**
- Same normalized error fingerprint repeated ≥ threshold (default: 3) times triggers `repeated_error` anomaly
- Different normalized error templates do not trigger the anomaly
- Anomaly explanation includes the latest raw repeated error message and the anomaly includes the count
- **Stop event suppression:** When the last event is `stop`, repeated_error detection is suppressed

**Evidence:** `src/core/anomaly-detector.ts` (repeated_error fingerprinting, threshold = 3, stop suppression), `src/core/anomaly-detector.test.ts` ("same error 3 times produces repeated_error", "near-identical errors with volatile tokens produce repeated_error", "different normalized error templates produce no anomaly", "stop after repeated errors → needs_input not repeated_error").

### R2.4: Detect Permission Blocks [F2.4] — SHOULD — `done`

The system SHOULD detect when an agent is blocked on a tool permission prompt.

**Acceptance criteria:**
- Detection triggered by the `PermissionRequest` hook event
- Payload includes `tool_name`, `tool_input`, and `permission_suggestions`
- Agent enters the attention queue with anomaly type `permission_blocked`
- **Stop event suppression:** When the last event is `stop`, permission_blocked detection is suppressed (the agent has moved past the permission dialog)

**Evidence:** `src/core/hook-parser.ts` (PermissionRequest parsing), `src/core/anomaly-detector.ts` (permission_blocked, stop suppression), `src/core/monitor.test.ts` ("PermissionRequest event enters queue as permission_blocked"), `src/core/anomaly-detector.test.ts` ("stop after permission_request → needs_input not permission_blocked"). Validated by [PoC 001](poc/001-hook-mechanism-validation.md).

### R2.5: Detect Budget Burn [F2.5] — MAY — `partial`

The system MAY detect when agent cost is climbing with no progress.

**Acceptance criteria:**
- A configured per-task cost threshold emits a `budget_exceeded` supervisor finding when observed spend crosses the warning threshold
- A critical finding emits when observed spend reaches 2x the warning threshold
- Budget alerts are reactive to observed transcript/token accounting and clearly communicate that an agent may overshoot by one turn
- A diagnostics-only progress-aware sampler records cost/token deltas, task status stability, agent event activity, repeated-error state, and permission-block state without inserting findings into the attention queue
- User-facing progress-aware "cost climbing with no progress" findings remain deferred until replay/precision evidence justifies promotion

**Evidence:** `src/core/budget-checker.ts` (reactive threshold checker), `src/core/progress-budget-burn-diagnostics.ts` (diagnostics-only progress-aware sampler), `src/server/lifecycle-timers.ts` (token scan emits budget findings and advisory diagnostics), `src/core/budget-checker.test.ts`, `src/core/progress-budget-burn-diagnostics.test.ts`, `src/server/lifecycle-timers.test.ts`. User-facing progress-aware budget-burn findings remain a V2 enhancement.

### R2.6: Detect Trajectory Drift [F2.6] — MAY — `deferred`

The system MAY detect when an agent has drifted off its original task.

**Rationale for deferral:** Requires LLM-powered analysis (Tier 2 supervisor). V2 feature.

### R2.7: Explain Anomalies [F2.7] — SHOULD — `done`

The system SHOULD generate a human-readable explanation for each detected anomaly.

**Acceptance criteria:**
- Each anomaly includes an `explanation` string describing what went wrong
- Explanation includes contextual details (tool name, error message, count)
- Explanation is delivered to the frontend via WebSocket `alert` message

**Evidence:** `src/core/anomaly-detector.ts` (explanation templates per anomaly type), `src/server/ws.ts` (alert broadcast), `src/frontend/components/Toasts.tsx` (toast display).

### R2.8: Prioritize by Urgency [F2.8] — SHALL — `done`

The system SHALL prioritize agents by urgency when multiple need attention.

**Acceptance criteria:**
- The attention queue surfaces critical findings before warning findings before info findings
- Critical `budget_exceeded` findings outrank warning findings
- Warning findings include `budget_exceeded` warning threshold alerts, `permission_blocked`, `repeated_error`, and `needs_input/AskUserQuestion`; same-severity findings preserve queue order rather than applying a separate anomaly-type ranking
- Stop-derived `needs_input` findings use info severity and rank after warning findings
- Priority recalculated as anomalies are detected or resolved
- **Stop event suppression** means only `needs_input` survives when agent completes its turn — stuck/error/permission anomalies from prior phases don't persist after stop

**Evidence:** `src/core/anomaly-detector.ts` (severity ranking, stop suppression + `prioritize()` function), `src/core/attention-queue.ts` (priority-sorted queue), `src/core/anomaly-detector.test.ts` ("multiple anomalies sorted by severity").

### R2.9: Notify When Attention Needed [F2.9] — SHOULD — `done`

The system SHOULD alert the user when an agent needs attention.

**Acceptance criteria:**
- Visual alert displayed in the UI (toast notification) when an anomaly is detected
- Optional browser notification with explanation summary

**Evidence:** `src/frontend/components/Toasts.tsx` (in-app toasts), `src/frontend/hooks/useNotifications.ts` (Browser Notification API fallback), `src/frontend/App.tsx` (notification hook mounted at dashboard root), `src/frontend/hooks/useNotifications.test.ts`.

### R2.10: Suppress Stale Terminal Session Findings [F2.9] — SHALL — `done`

The system SHALL exclude stale anomaly state from completed, cancelled, terminated, and completed-session agent records when computing supervisor findings.

**Acceptance criteria:**
- Completed, cancelled, and terminated tasks do not appear in the active findings list even if an old session still has anomaly state in memory
- Completed Ralph iteration sessions do not appear as active findings after a successor owner session starts
- Terminal tasks remain visible in the completed section with their completion metadata
- Detection statistics do not display a per-hour rate during the initial startup window, when the rate would be dominated by restart timing rather than useful detector behavior

**Evidence:** `src/core/monitor.test.ts` (terminal/Ralph session snapshot filtering), `src/frontend/store/finding-helpers.test.ts` (terminal active-finding filtering), `src/frontend/components/DetectionStatsPanel.test.ts` (startup-window rate formatting).

### R2.11: Audit Finding Evidence Over Time [F2.10] — SHOULD — `done`

The system SHOULD capture bounded evidence snapshots for surfaced supervisor findings so false positives and timing-sensitive alerts can be reviewed without guessing from source code alone.

**Acceptance criteria:**
- When a finding is surfaced, Kookr records an initial evidence audit with anomaly type, subtype, explanation, event count, latest event, and timestamp
- Watchdog ticks append follow-up observations with terminal pane hash and a bounded pane excerpt when pane capture succeeds
- Quick findings that clear inside the timing grace window are classified as `transient_too_fast`, not durable detector failures
- Active findings with later terminal or event activity that no longer matches the blocking condition are classified as `possible_false_positive`
- Evidence audit records are visible in raw snapshots and through `/api/finding-evidence-audit` for low-cost sampling or small-model review

**Evidence:** `src/core/finding-evidence-audit.ts`, `src/core/monitor.ts`, `src/server/lifecycle-timers.ts`, `src/server/routes/diagnostics-routes.ts`, `src/core/finding-evidence-audit.test.ts`, `src/core/monitor.test.ts`.

### R2.12: Persist Finding Evidence Review Diagnostics [F2.11] — SHOULD — `done`

The system SHOULD persist manual finding-evidence review outcomes in an append-only diagnostics log that is separate from runtime task state.

**Acceptance criteria:**
- Deleting the review log does not affect runtime supervision or startup recovery
- Valid reviews and invalid model attempts are appended as JSONL records under the Kookr state directory
- Malformed or partial log lines are skipped when reading diagnostics
- Invalid attempts are stored as non-verdict records with failure kind, raw output hash, reviewer metadata, prompt version, and input hash
- Model-generated diagnostic text is capped before it is stored or returned

**Evidence:** `src/server/review-log-store.ts`, `src/server/finding-evidence-review-service.ts`, `src/server/routes/diagnostics-routes.ts`, `src/server/review-log-store.test.ts`, `src/server/finding-evidence-review-service.test.ts`, `src/server/routes/diagnostics-routes.test.ts`.

### R2.13: Report Detector Proposal Candidates [F2.12] — SHOULD — `done`

The system SHOULD turn repeated finding-evidence review outcomes into advisory detector proposal reports without changing live detector behavior automatically.

**Acceptance criteria:**
- Reports are grouped by detector target, candidate kind, input schema version, prompt version, and app build version
- Reports include review counts, false-positive / false-negative / invalid / unclear populations, confidence distribution, input hashes, and evidence references
- Generated proposals are advisory only and cannot execute commands or mutate detector configuration
- Diagnostics cap and escape model-controlled text before returning it

**Evidence:** `src/server/detector-proposal-report.ts`, `src/server/review-log-store.ts`, `src/server/routes/diagnostics-routes.ts`, `src/server/detector-proposal-report.test.ts`, `src/server/routes/diagnostics-routes.test.ts`.

### R2.14: Preserve Coordinator Suppressions Across Agent Types [#1378] — SHALL — `done`

The system SHALL validate coordinator suppression agent types from the shared concrete-agent contract and preserve valid suppressions across persistence round-trips.

**Acceptance criteria:**
- A suppression for every concrete `AgentType`, including `grok-build`, survives a store write/read round-trip and remains active.
- An unknown agent type is rejected before a suppression is written.
- An invalid persisted suppression is ignored and the rejection is logged for diagnosis.

**Evidence:** `src/shared/contracts/agent-types.ts`, `src/server/coordinator/suppression-store.ts`, `src/server/routes/coordinator-routes.ts`, `src/server/coordinator/suppression-store.test.ts` (`TS-COORD-001` through `TS-COORD-003`).

---

## R3: The Loop — Respond & Advance

### R3.1: View Blocked Agent's Context [F3.1] — SHALL — `done`

The system SHALL display the blocked agent's context when navigated to.

**Acceptance criteria:**
- Agent detail panel shows the agent's interactive terminal session
- Anomaly explanation banner shown when an anomaly is active
- The supervisor's explanation in the findings panel provides context for the anomaly

**Evidence:** `src/frontend/components/DetailPanel.tsx` (terminal view, anomaly banner, response input), `src/frontend/components/FindingsPanel.tsx` (anomaly explanations).

### R3.2: Respond to Agent [F3.2] — SHALL — `done`

The system SHALL allow the developer to type a response and deliver it to the agent.

**Acceptance criteria:**
- Input box in the agent detail panel accepts text
- On submit, text is sent via WebSocket `respond` message to the backend
- Backend delivers the text via byte-level writes to the agent's dtach session (`backend.write` / `backend.writeSequence`)
- Response includes a trailing Enter keystroke to submit

**Evidence:** `src/frontend/components/DetailPanel.tsx` (input box), `src/server/ws.ts` (respond handler), `src/adapters/claude-code-adapter.ts` (sendInput delegates to the dtach backend), `src/adapters/local-dtach-backend.ts` (write/writeSequence), `src/server/ws.test.ts` ("client sends respond - input delivered to agent").

### R3.3: Auto-advance After Response [F3.3] — SHALL — `done`

The system SHALL automatically navigate to the next agent needing attention after the developer responds.

**Acceptance criteria:**
- After sending a response, the current agent is removed from the attention queue
- The frontend auto-selects the next highest-priority agent
- If no agents need attention, the "all clear" state is shown

**Evidence:** `src/core/attention-queue.ts` (respondAndAdvance), `src/core/loop.test.ts` ("agent stops -> user responds -> auto-advance to next", "3 agents, 2 stuck -> respond to #1 -> advance to #2 -> respond -> all clear").

### R3.3a: Reliable Empty-Terminal Enter [F3.3] — SHALL — `done`

The system SHALL treat Enter on an empty managed terminal input as a server-authorized attention-advance intent, not as raw PTY Enter.

**Acceptance criteria:**
- Every Kookr-controlled PTY input write flows through a terminal input writer boundary that advances `readinessVersion` before attempting the write.
- Empty-terminal Enter carries a server terminal-input epoch/readiness snapshot and the server-owned dashboard selection version.
- The server rejects stale epoch, stale readiness, unknown prompt, blocked prompt, missing session, and stale selection intents without forwarding `\r`.
- Only parent `Notification(idle_prompt)` marks a prompt ready in V1; `Stop` returns the prompt state to unknown.
- Duplicate or stale empty-enter intents are consumed/rejected by an atomic selection compare-and-swap.

**Evidence:** `src/server/terminal-input-coordinator.ts`, `src/server/dashboard-selection-controller.ts`, `src/server/session-bridge.ts`, `src/frontend/components/DetailPanel.tsx`, `src/server/terminal-input-coordinator.test.ts`, `src/server/dashboard-selection-controller.test.ts`, `src/server/terminal-input-boundary.test.ts`, `src/frontend/components/DetailPanel.empty-enter.test.ts`.

### R3.4: "All Clear" State [F3.4] — SHOULD — `partial`

The system SHOULD display a clear "all agents working autonomously" state when no agents need attention.

**Acceptance criteria:**
- When the attention queue is empty, the UI shows an "all clear" message
- Distinct from "no agents running" state

**Evidence:** `src/core/attention-queue.ts` tracks queue emptiness. Frontend rendering of this state exists in `DetailPanel.tsx` but may need polish.

### R3.5: Manual Navigation [F3.5] — SHOULD — `done`

The system SHOULD allow the developer to manually select any agent from the list.

**Acceptance criteria:**
- Clicking an agent in the agent list selects it, regardless of anomaly status
- Selected agent's detail panel is shown

**Evidence:** `src/frontend/components/FindingsPanel.tsx` (click handler), `src/frontend/store/useStore.ts` (selectAgent action).

### R3.6: Skip Agent [F3.6] — SHALL — `done`

The system SHALL allow the developer to deprioritize an agent to the back of the queue.

**Acceptance criteria:**
- Skip action removes the agent from the current queue position
- Supervisor keeps monitoring — if the agent's state changes, it re-enters the queue
- Frontend auto-advances to the next agent after skip

**Evidence:** `src/core/attention-queue.ts` (skip), `src/server/ws.ts` (skip handler), `src/core/loop.test.ts` ("skip agent -> advance to next -> skipped agent gets new anomaly -> re-enters queue").

### R3.7: Snooze Agent [F3.7] — SHALL — `done`

The system SHALL allow the developer to snooze a finding or active running task for a chosen duration.

**Acceptance criteria:**
- Snooze action removes the agent from attention routing for the specified duration (milliseconds)
- Snooze action is available for active running tasks even when they have no supervisor finding
- Snoozing a no-anomaly running task requires a real task identity; unresolved agent-only task snoozes are rejected
- Optional reason can be attached
- On timer expiry, supervisor re-evaluates and re-queues if anomaly persists
- If a finding appears while a running task is snoozed, it remains hidden until the snooze expires or the user resumes monitoring
- Agent that completes while snoozed stays completed (no re-entry)
- User snoozes can be ended early with Resume now

**Evidence:** `src/core/attention-queue.ts` (task/finding snooze state), `src/server/ws-handlers/anomaly-handler.ts` (snooze handler), `src/core/attention-queue.test.ts`, `src/core/task-persistence.test.ts`, `src/server/ws.test.ts`.

### R3.8: Sent Confirmation Overlay — SHOULD — `done`

The system SHOULD display a brief confirmation overlay after sending a response.

**Acceptance criteria:**
- After Send & Next, a confirmation overlay appears for ~1.5 seconds
- Overlay shows the name of the agent the hint was sent to
- Overlay auto-dismisses after the timeout

**Evidence:** `src/frontend/store/useStore.ts` (sentOverlay state), `src/frontend/components/SentOverlay.tsx` (overlay component), `src/frontend/components/DetailPanel.tsx` (triggers overlay on send).

### R3.9: Batch Respond to Identical Pending Prompts — SHOULD — `done`

The system SHOULD reduce approval-gate load by grouping agents waiting on the same unresolved prompt.

**Acceptance criteria:**
- Identical pending prompts are grouped only when at least two active findings share the same normalized pending prompt
- Completed-turn findings are excluded from blind batch approval
- `AskUserQuestion`, permission request, transcript prompt, and anomaly explanation fallbacks are fingerprinted deterministically
- Policy-covered low-risk prompts may expose one-click "Approve matching"; merge, scope, delete/remove, destructive, permission, credential, and secret prompts remain manual
- Non-auto-approved identical groups expose "Reply to matching", selecting only that matching subset for a shared response

**Evidence:** `src/frontend/group-findings.ts`, `src/frontend/components/FindingsPanel.tsx`, `src/frontend/group-findings.test.ts`, `src/frontend/components/FindingsPanel.performance.test.tsx`.

### R3.10: Findings Rail Type-Filter Chips [#2445] — SHOULD — `done`

The findings rail SHOULD let the operator show only selected anomaly types with clickable header chips.

**Acceptance criteria:**
- The rail header renders one chip per anomaly type currently present on the rail
- Chips are multi-select OR; an empty selection shows every finding
- Clicking a chip hides cards of other types; clicking it again restores them
- The selected set persists in `localStorage` (`kookr:findingsPanel.typeFilter`)
- Existing CLI, API, command-palette, and "N active" count defaults stay unfiltered
- No new global keyboard shortcut is added

**Evidence:** `src/frontend/finding-type-filter.ts`, `src/frontend/components/FindingsPanel.tsx`, `src/frontend/finding-type-filter.test.ts`, `src/frontend/components/FindingsPanel.type-filter.test.ts`.

### R3.11: Activity Transcript Role-Filter Chips [#2576] — SHOULD — `done`

The activity panel SHOULD let the operator show only one role of the running transcript: what they typed, what the agent said, or the tool stream.

**Acceptance criteria:**
- The panel header renders exclusive All / You / Agent / Tools chips
- You keeps operator-typed rows; Agent keeps assistant text; Tools keeps tool groups; All keeps every row
- While a turn is still running, the live "agent is working" row stays visible even when Tools is hidden
- The last chip choice persists in `localStorage` (`kookr:activityPanel.roleFilter`) per browser, not per task
- When a non-All filter matches nothing, the panel shows "No matching activity" and a control that returns to All
- Selecting Tools hides user and assistant rows and keeps tool rows

**Evidence:** `src/frontend/activity-role-filter.ts`, `src/frontend/components/ActivityPanel.tsx`, `src/frontend/activity-role-filter.test.ts`, `src/frontend/components/ActivityPanel.role-filter.test.ts`.

---

## R4: Agent Lifecycle

### R4.1: Launch New Agent [F4.1] — SHALL — `done`

The system SHALL allow launching a new agent from the GUI with a task description and working directory.

**Acceptance criteria:**
- Launch dialog accepts: task prompt (required), working directory (required), completion criteria (optional)
- When launch admission permits, the agent is started in a managed dtach session in interactive mode (see [ADR-014](adr/014-local-dtach-backend.md)); confirmed degradation follows R4b.12 and starts no session
- Claude Code launched with `--settings` flag pointing to Kookr-generated hook settings
- Hook settings are additive to user's existing settings
- Launch, relaunch, and playbook messages accept every concrete agent type advertised by the server, including `grok-build`
- WebSocket client and server schemas validate concrete agent types consistently with the shared `AgentType` contract
- An admitted task is created as `open` and transitions to `inProgress` on agent start; a confirmed-degraded task is persisted as `pending` until R4b.12 recovery admission succeeds

**Evidence:** `src/frontend/components/LaunchTaskDialog.tsx` (dialog UI), `src/server/ws.ts` (launch handler), `src/shared/contracts/agent-types.ts` (concrete agent contract), `src/shared/contracts/client-message-schema.ts` and `src/shared/contracts/server-message-schema.ts` (WebSocket validation), `src/adapters/claude-code-adapter.ts` (settings generation, launch wiring), `src/adapters/local-dtach-backend.ts` (dtach session creation), `src/server/ws.test.ts` ("client sends launch - new task started"), `src/shared/contracts/client-message-schema.test.ts` and `src/shared/contracts/server-message-schema.test.ts` (agent-type validation), `src/adapters/claude-code-adapter.test.ts` (settings with hooks).

### R4.1a: Actionable Grok Launch Authentication Preflight [F4.1] — SHALL — `done`

For `grok-build` launches, the system SHALL validate the launch-scoped `auth.json` before creating a managed terminal session and SHALL report missing, unreadable, malformed, unusable, or expired credentials with an actionable re-authentication command without exposing credential values.

**Acceptance criteria:**
- Given a missing, malformed, unusable, or expired Grok credential file, when a `grok-build` launch is requested, Kookr refuses before creating a dtach session and reports `grok login --device-code` (or an equivalent supported login action)
- Given a valid cached Grok credential, launch proceeds through the existing isolated `GROK_HOME` composition and managed terminal path
- Auth diagnostics never include access tokens, refresh tokens, or other credential values
- If auth preflight passes but Grok does not acknowledge the initial prompt, the failure identifies the terminal/PTY or hook-readiness path rather than presenting the result as an auth failure

**Evidence:** `src/adapters/grok-auth-preflight.ts`, `src/adapters/grok-auth-preflight.test.ts`, `src/adapters/grok-build-adapter.ts`, and `src/server/ws-handlers/launch-result.ts`.

### R4.1b: Surface Grok Auth Preflight in the Launch Dialog [F4.1] — SHALL — `done`

The system SHALL show operators the Grok credential-cache verdict in the Launch dialog before they submit, using the same offline `inspectGrokAuthFile` preflight the adapter already runs, without exposing secrets or changing launch billing or API-key auth.

**Acceptance criteria:**
- Given Grok Build is selected (or would be the next round-robin pick) and the shared credential cache is missing, expired, or invalid, when the Launch dialog is open, then a banner is visible and contains `grok login`
- Given the same cache is usable (`ok`), when the Launch dialog is open, then no Grok auth banner is shown
- Given a failing preflight, when the operator would launch `grok-build`, then Launch is disabled; other agent selections (including round-robin, which skips Grok) stay launchable
- The status payload never includes access tokens, refresh tokens, API keys, or other credential values
- Existing CLI and `POST /api/tasks` launch defaults stay unchanged

**Evidence:** `src/shared/contracts/grok-auth-status.ts`, `src/adapters/grok-auth-status.ts`, `src/server/routes/grok-auth-routes.ts`, `src/frontend/components/GrokAuthPreflightBanner.tsx`, `src/frontend/components/LaunchTaskDialog.tsx`, `src/frontend/components/LaunchTaskDialog.grok-auth.test.ts`.

### R4.1c: Warn on Active Duplicate Prompts in the Launch Dialog [F17.4] — SHALL — `done`

The system SHALL warn in the Launch dialog and Quick Launch bar before submit when an active task already uses the same prompt, working directory, and agent type, using the same equality `kookr spawn` uses, without changing CLI or REST defaults.

**Acceptance criteria:**
- Given two in-memory active tasks and a matching prompt + cwd + agent, when the Launch dialog or Quick Launch bar is open, then a warning banner is visible with Open existing and Launch anyway
- Given the operator clicks Launch anyway, when the form submits, then the launch is sent with `disableDedup` and `metadataIntent` `keep_as_duplicate`
- Given a non-matching prompt, when the operator clicks Launch, then the payload is sent without those duplicate-preserving fields
- Existing CLI (`kookr spawn --dedupe`) and `POST /api/tasks` defaults stay unchanged

**Evidence:** `src/shared/launch-duplicate.ts`, `src/frontend/components/LaunchDuplicateBanner.tsx`, `src/frontend/components/LaunchTaskDialog.tsx`, `src/frontend/components/QuickLaunch.tsx`, `src/frontend/components/LaunchTaskDialog.duplicate.test.ts`, `src/frontend/components/QuickLaunch.duplicate.test.ts`.

### R4.1d: Warn When Claude Plan Quota Will Rotate or Deny [F4.1] — SHALL — `done`

The system SHALL warn in the Launch dialog before submit when the existing Claude plan-quota gate would rotate the launch to a fallback agent or deny it, without changing admission, the settings threshold, billing, or spending limits.

**Acceptance criteria:**
- Given 5-hour (or 7-day) utilization at or above the configured `quotaHeadroomThreshold` and Claude Code selected (or next in round-robin), when the Launch dialog is open, then a quota banner is visible before submit
- The banner names current utilization, which window bound, and the reset time when present, and says submit will rotate to the configured fallback
- The banner is hidden when the evaluator would admit, when quota data is missing, or when the chosen agent cannot be Claude Code
- When the quota sample is older than five minutes, the banner mentions that the reading is stale
- Server admission and `quotaHeadroomThreshold` stay unchanged; Launch stays enabled (warning only)

**Evidence:** `src/shared/quota-headroom-admission.ts`, `src/shared/launch-quota-warning.ts`, `src/shared/launch-quota-warning.test.ts`, `src/frontend/components/LaunchQuotaBanner.tsx`, `src/frontend/components/LaunchTaskDialog.tsx`, `src/frontend/components/LaunchTaskDialog.quota.test.ts`.

### R4.1e: Warn When the Launch Directory Already Has Live Agents [F4.1] — SHALL — `done`

The system SHALL warn in the Launch dialog when the chosen working directory already has one or more live tasks (not completed, cancelled, or terminated), even when those tasks use different prompts, without changing `kookr spawn` or REST launch defaults.

**Acceptance criteria:**
- Given two in-memory in-progress tasks in `/tmp/demo` with different prompts, when the Launch dialog cwd is `/tmp/demo`, then a busy-directory banner is visible with the live count and those task names, plus Open existing and Launch anyway
- Given a live task in `/tmp/other` only, when the Launch dialog cwd is `/tmp/demo`, then the busy-directory banner is not shown
- Trailing slashes do not split one directory (`/tmp/demo` ≡ `/tmp/demo/`)
- Matching uses each task's launch directory, not a session that later moved into a linked worktree
- Given the operator clicks Launch anyway, when the form is complete, then the launch message is sent
- Given the operator clicks Open existing, then one live task is selected (oldest when several) and no launch is sent
- The prompt-duplicate banner from R4.1c still appears when prompt and directory also match
- Submit is not blocked by the busy-directory warning alone; `kookr spawn` defaults stay unchanged

**Evidence:** `src/shared/launch-duplicate.ts`, `src/frontend/components/LaunchBusyDirectoryBanner.tsx`, `src/frontend/components/LaunchTaskDialog.tsx`, `src/shared/launch-duplicate.test.ts`, `src/frontend/components/LaunchTaskDialog.busy-directory.test.ts`.

### R4.2: Stop Agent [F4.2] — SHOULD — `done`

The system SHOULD allow terminating a running agent from the GUI.

**Acceptance criteria:**
- Stop action kills the agent's dtach session
- Task status transitions appropriately (agent session ends, task returns to `open`)
- Detail header includes a Stop button that sends a `stop` message via WebSocket
- `stop` message type included in `ClientMessage` union, handled by `MessageRouter`

**Evidence:** `src/adapters/claude-code-adapter.ts` and `src/adapters/local-dtach-backend.ts` (stop method kills session). `src/server/ws.ts` (stop message handler). `src/frontend/components/DetailPanel.tsx` (Stop button in header).

### R4.3: Relaunch Agent [F4.3] — SHOULD — `done`

The system SHALL allow relaunching a task with the same or modified prompt and working directory. Relaunch creates a new task (preserving the original for history) rather than restarting in-place.

**Acceptance criteria:**
- Relaunch action available from the task/finding context menu
- Original task is preserved; relaunch produces a new task with its own session lifecycle
- Prompt and working directory can be edited before launch
- New task is linked to the original via `parentTaskId` for traceability

**Evidence:** `src/core/tasks.ts` (relaunch creates child task), `src/server/ws.ts` (`relaunch` message handler), `src/frontend/components/LaunchTaskDialog.tsx` (relaunch flow), `src/server/ws.test.ts` (relaunch protocol coverage).

### R4.4: Task Lifecycle Management [F4.4] — SHALL — `done`

The system SHALL manage tasks across `open`, `pending`, `inProgress`, `completed`, `cancelled`, and `terminated`: launches may enter `pending` before a session exists, admitted sessions enter `inProgress`, failed recovery probes return to `pending`, and terminal/user transitions select the appropriate end state.

**Acceptance criteria:**
- Tasks are the unit of work (distinct from agent sessions)
- A task may go through multiple agent sessions
- Agent session ending returns the task to `open` — user must explicitly mark complete
- Tasks are persisted locally in JSON (`~/.kookr/tasks.json`)
- Persistence uses atomic writes (temp file → rename)
- On startup, tasks are loaded from disk and reconciled with live dtach sessions

**Evidence:** `src/core/tasks.ts` (state machine, CRUD), `src/core/task-persistence.ts` (atomic JSON I/O), `src/server/reconciliation.ts` (startup recovery), `src/core/tasks.test.ts`, `src/core/task-persistence.test.ts`, `src/server/reconciliation.test.ts`.

### R4.5: Completion Criteria [F4.5] — SHOULD — `partial`

The system SHOULD allow the user to provide optional completion criteria when launching an agent.

**Acceptance criteria:**
- Launch dialog includes an optional "definition of done" field
- Criteria stored with the task
- Supervisor can reference criteria when evaluating agent completion (V2: auto-evaluate)

**Evidence:** `src/frontend/components/LaunchTaskDialog.tsx` (criteria field in dialog), `src/core/tasks.ts` (criteria stored in task). Auto-evaluation not implemented.

### R4.6: Attach to Agent Terminal [F4.6] — SHOULD — `done`

The system SHOULD allow the developer to open an agent's managed dtach session directly from an external terminal when needed. Kookr no longer exposes a GUI button for attach: the in-browser xterm.js terminal (R5.2) already provides full interactive access, and an external attach is available via `dtach -a <socket>` for power users.

**Acceptance criteria:**
- The dtach socket path is stable per session (under `/tmp/kookr-dtach/<uid>/<instanceId>/<sessionId>.sock`) so an external `dtach -a <socket>` always works
- Developer can interact with the agent outside Kookr without disrupting in-browser monitoring
- Agent monitoring (hook tailing, anomaly detection) continues while an external client is attached

**Evidence:** `src/adapters/local-dtach-backend.ts` (socket path layout, attach-safe), `src/frontend/components/TerminalPanel.tsx` (in-browser xterm.js bridge satisfies F4.6 fully). The previous "Attach" button + clipboard copy was removed (see commit `80100d0`).

### R4.7: Configure Task Completion Cleanup [F4.4] — SHOULD — `done`

The system SHOULD let the developer choose whether completing a task should clean up its task-owned Git worktree and branch, with a per-task override.

**Acceptance criteria:**
- Completing a task opens a confirmation dialog containing a cleanup checkbox.
- The dialog names each task-owned worktree and states whether it can be removed, from the same inspection the completion cleanup itself runs.
- The cleanup checkbox defaults to the saved completion-cleanup setting when a worktree is removable.
- The developer can override the checkbox for the current task completion without changing the saved setting, unless no worktree is removable — in which case the checkbox is unchecked and disabled, and completion states the refusal explicitly rather than leaving the saved default to decide.
- The developer can re-run the inspection from the dialog while it is open, except where the reason can never change.
- When cleanup is selected, Kookr removes eligible task-owned worktrees, prunes Git's worktree registry, and deletes eligible merged or patch-equivalent local branches using the existing safety checks.
- When cleanup is not selected, task completion still performs non-worktree lifecycle cleanup, including session teardown, queue cleanup, lease release, and issue-claim release.
- Dirty, unique-commit, protected, or shared worktrees remain preserved; merged or patch-equivalent branches are eligible for cleanup and are reported through the existing interaction log.
- When the inspection cannot be completed, removability is reported as unknown and the saved setting still applies.

**Evidence:** `src/adapters/git-worktree.ts` (`inspectWorktreeCleanup`, `inspectTaskWorktrees`), `src/shared/contracts/worktree-cleanup-verdict.ts`, `src/frontend/components/CleanupWorktreeOption.tsx`, `src/frontend/cleanup-override.ts`.

**Linked tests:** `TS-CLEANUP-001` through `TS-CLEANUP-004`.

### R4.8: Reclaim Orphaned Atomic-Write Temporary Files [F4.4] — SHALL — `done`

The system SHALL reclaim abandoned root-level temporary files created by its
atomic-write paths before data-directory disk admission is exhausted.

**Acceptance criteria:**
- Stale files are matched only by an explicit allowlist of Kookr atomic-write names and a conservative age threshold.
- Fresh files and files held open by a live process are preserved; the sweep fails closed when open-file verification is unavailable.
- Dry-run output reports candidates, counts, and reclaimable bytes, while live runs report each deletion and bytes actually reclaimed.
- A failed atomic write removes its temporary file when cleanup is still safe to perform.

**Evidence:** `src/core/maintenance-prune.ts`, `src/core/persistence-utils.ts`, `src/cli/kookr-maintenance.ts`.

**Linked tests:** `maintenance-prune.test.ts`, `persistence-utils.test.ts`, `kookr-maintenance.test.ts`.

---

## R4b: Task Launch UX

### R4b.1: Default Path from Kookr's CWD — SHALL — `done`

The system SHALL pre-fill the launch dialog's path field with the working directory Kookr was started from.

**Acceptance criteria:**
- Server sends its own CWD to the frontend on WebSocket connect (e.g., in the `snapshot` message or a dedicated `config` message)
- Launch dialog uses this CWD as the initial value for the path field
- User can still override the value
- If path field already has a user-entered value (from recent paths), CWD serves as fallback only on first launch

**Rationale:** Eliminates the path field entirely for single-repo workflows. Near-zero effort.

**Evidence:** `src/server/ws.ts` (snapshot includes `serverCwd`), `src/server/index.ts` (passes `process.cwd()`), `src/frontend/store/useStore.ts` (stores `serverCwd`), `src/frontend/hooks/useWebSocket.ts` (passes `serverCwd` from snapshot), `src/frontend/components/LaunchTaskDialog.tsx` (uses `serverCwd` as fallback). Tests in `ws.test.ts` and `useStore.test.ts`.

### R4b.2: Recent Paths Dropdown with Autocomplete — SHALL — `done`

The system SHALL remember recently used paths and offer them in an autocomplete dropdown when launching a new task.

**Acceptance criteria:**
- Last 10 unique paths stored in `localStorage` (MRU order)
- Path input is a combo field: free-text input with a dropdown of recent paths
- Typing filters the dropdown (case-insensitive substring match)
- Most recently used path is pre-selected on dialog open
- Selecting a path from the dropdown fills the input field
- New paths are added to the list on successful launch
- List persists across browser sessions (localStorage)

**Rationale:** Developers typically work across 2–5 repos. MRU dropdown covers multi-repo workflows without a filesystem browser.

**Evidence:** `src/frontend/store/recent-paths.ts` (RecentPaths class with MRU, filter, persistence), `src/frontend/store/recent-paths.test.ts` (11 tests), `src/frontend/components/LaunchTaskDialog.tsx` (combo input with dropdown, keyboard navigation, onBlur dismiss).

### R4b.3: Re-launch from Task History — SHOULD — `done`

The system SHOULD allow re-launching a previous task, pre-filling the launch dialog with the original task's prompt, path, and criteria.

**Acceptance criteria:**
- Completed, cancelled, or failed tasks show a "Re-launch" action in the UI
- Clicking re-launch opens the launch dialog pre-filled with the original task's `prompt`, `cwd`, and `criteria`
- User can edit any field before confirming
- The re-launched task is a new task (new ID), not a mutation of the original

**Rationale:** "Run the same thing again with a tweak" is extremely common. The data already exists in `tasks.ts` — this is purely a UI affordance. The WebSocket protocol already defines a `relaunch` message type.

**Evidence:** `src/frontend/store/useStore.ts` (relaunchTask state, setRelaunchTask/clearRelaunchTask actions), `src/frontend/store/useStore.test.ts` (2 tests), `src/frontend/components/DetailPanel.tsx` (Re-launch button fetches the single task's full detail via `GET /api/tasks/:id`), `src/frontend/App.tsx` (opens LaunchTaskDialog pre-filled when relaunchTask is set).

### R4b.4: Quick-launch Shortcut — SHOULD — `done`

The system SHOULD provide a minimal quick-launch mode that inherits the path from the currently selected agent.

**Acceptance criteria:**
- Keyboard shortcut (e.g., `Ctrl+L`) opens a prompt-only input bar (not the full dialog)
- Path is inherited from the currently selected agent's working directory
- If no agent is selected, falls back to Kookr's CWD (R4b.1)
- Enter submits, Escape cancels
- Launched task uses the inherited path and entered prompt

**Rationale:** When running multiple agents in the same repo, the path is always the same. Removing the dialog entirely for this case cuts launch time to a single keystroke + prompt.

**Evidence:** `src/frontend/components/QuickLaunch.tsx` (prompt-only input bar, resolves CWD from selected agent → recent paths → serverCwd), `src/frontend/App.tsx` (Ctrl+L opens QuickLaunch, TopBar button opens full LaunchTaskDialog), `src/frontend/styles.css` (quick-launch-bar styling).

### R4b.5: Telegram Agent Selection — SHOULD — `done`

The system SHOULD allow authorized Telegram users to choose the coding agent used for remotely launched tasks.

**Acceptance criteria:**
- `/agent status` reports the authorized user's current default agent
- `/agent claude` persists Claude Code as that user's default agent
- `/agent codex` persists Codex CLI as that user's default agent only when `KOOKR_REMOTE_CHAT_ALLOW_CODEX=1`
- Free-text and transcribed voice messages may resolve an explicit agent request, such as "use codex", into structured `agentType` metadata
- `/task` accepts an explicit `--agent <claude|codex>` option without invoking the LLM
- Confirmation messages display the resolved agent before spawn
- Telegram-spawned Codex tasks are rejected when `KOOKR_REMOTE_CHAT_ALLOW_CODEX` is not enabled

**Rationale:** Remote task launch should support the same agent choices as the rest of Kookr while keeping Codex remote spawn behind an explicit operator-controlled safety flag.

**Evidence:** `src/integrations/telegram/index.ts` (`/agent` command, confirmation text, launch call), `src/integrations/telegram/rephrase.ts` (structured `agentType` schema), `src/integrations/telegram/parse-task.ts` (`--agent` parser), `src/integrations/telegram/safety.ts` (persistent per-user defaults), `src/server/launch-service.ts` (`KOOKR_REMOTE_CHAT_ALLOW_CODEX` trust-boundary guard), tests in `src/integrations/telegram/*.test.ts` and `src/server/launch-service.test.ts`.

### R4b.5a: Dashboard Default Agent Selection — SHOULD — `done`

The system SHOULD allow the user to set a dashboard-wide default coding agent for launches that do not provide an explicit agent type.

**Acceptance criteria:**
- Settings exposes a Default agent control listing server-supported agent types, plus a **Round robin** option when at least two agents are available.
- The selected default is persisted in Kookr settings and survives server restart.
- Manual Launch, Quick Launch, Playbook launch, Schedule creation, REST API launch, and `kookr-spawn` inherit the persisted default when they do not provide an explicit agent type.
- When the resolved selection is Round robin, the system rotates across the registered agent types (Claude Code, Codex CLI, and grok-build when its binary preflight passed); the rotation cursor is persisted and survives server restart. An agent whose recent boot latency is unhealthy is deprioritized (skipped) while a healthy alternative remains registered, and self-heals back into rotation once its boots recover or age out; when every available agent is deprioritized the full rotation is used. Each launched task records a concrete agent type, never the round-robin sentinel.
- Round robin is also selectable as an explicit per-launch choice in every launch surface.
- Explicit per-launch agent choices override the persisted default.
- Telegram launches keep the stricter `KOOKR_REMOTE_CHAT_ALLOW_CODEX=1` guard when the default resolves to Codex CLI.

**Rationale:** Agent-spawned child tasks and CLI launches cannot read browser-local preferences. A server-side default keeps Kookr's UI, API, and child-task behavior coherent. Round robin lets users on both a Claude plan and a Codex plan spread launch usage across both.

**Evidence:** `src/core/settings-store.ts`, `src/shared/contracts/agent-types.ts`, `src/core/agent-boot-latency.ts`, `src/server/launch-service.ts`, `src/server/index.ts`, `src/frontend/components/SettingsDialog.tsx`, tests in `src/core/settings-store.test.ts`, `src/core/agent-types.test.ts`, `src/core/agent-boot-latency.test.ts`, `src/server/settings-api.test.ts`, `src/server/launch-service.test.ts`, and `src/frontend/components/SettingsDialog.test.ts`.

### R4b.5b: Telegram Task Read-Back — SHOULD — `done`

The system SHOULD let authorized Telegram users read the state of active tasks without opening the web dashboard.

**Acceptance criteria:**
- `/tasks` replies with the active (non-terminal) tasks and each task's most-relevant blocker (an explicit stuck reason, else the agent's pending signal, else a declared dependency edge).
- Terminal tasks (completed, terminated, cancelled) are excluded; a no-active-tasks state returns a clear message.
- The read-back is scoped to the projects the user may spawn against, so it does not leak out-of-scope task names or blockers.
- The reply is length-bounded and each row passes through the existing secret redactor.
- A failure to read task state returns an explicit error rather than a misleading empty result.

**Rationale:** After spawning work from a phone, the remote surface was spawn-only; an operator had to open the dashboard to learn whether an agent was blocked. `/tasks` closes that read-back gap while keeping the same allowlist/rate-limit/redaction guards as the rest of the integration.

**Evidence:** `src/integrations/telegram/tasks-command.ts` (parse/select/format/fetch), `src/integrations/telegram/index.ts` (`/tasks` dispatch + project scoping + help text), `src/integrations/telegram/audit.ts` (`tasks_replied`/`tasks_query_failed` events), tests in `src/integrations/telegram/tasks-command.test.ts` and `src/integrations/telegram/index.test.ts`.

### R4b.6: Looped Playbook Conflict Guidance [F6.7] — SHOULD — `done`

The system SHOULD surface actionable inline guidance when a looped playbook launch cannot start because an existing Kookr loop or standalone Ralph plugin conflicts with it.

**Acceptance criteria:**
- A duplicate active loop response includes a typed `conflictKind` and the existing task's loop snapshot
- A standalone `ralph-wiggum@*` plugin response includes a typed `conflictKind`, matched settings files, and plain-language reasons
- When both conflicts are present, the launch response prioritizes the existing Kookr loop so the user can open it
- The launch dialog renders duplicate-loop conflicts with "Replace it (start fresh)" and "Open the running loop" actions
- The launch dialog renders standalone-plugin conflicts inline with the matched settings file and a retry affordance

**Evidence:** `src/server/use-cases/looped-playbook-launch.ts` (conflict ordering and typed payloads), `src/frontend/components/PlaybookBrowser.tsx` (inline conflict rendering), `src/server/use-cases/looped-playbook-launch.test.ts`, `src/frontend/components/PlaybookBrowser.loopable.test.ts`.

### R4b.7: Ralph Verdict Runtime Environment — SHALL — `done`

The system SHALL expose the full Ralph verdict environment to every loop iteration runtime, including the first runtime created before the loop record is attached.

**Acceptance criteria:**
- Initial Ralph launches receive `RALPH_VERDICT_FILE` and `RALPH_ITERATION=0`.
- Subsequent Ralph launches receive `RALPH_VERDICT_FILE` and `RALPH_ITERATION` equal to the current loop iteration.
- Looped implementation playbooks define non-automatable issue labels that Phase 0 skips before implementation.
- Looped implementation playbooks define an automation-quarantine path for trusted, non-implementable issue targets.
- GitHub issue implementation playbooks rename the running task from the generic playbook name to `#<issue> <title>` after target resolution.
- Ralph issue iteration verdicts preserve the resolved issue title and the Ralph panel exposes that target metadata in iteration history.

**Evidence:** `src/server/launch-service.ts`, `src/server/ralph-loop-service.ts`, `src/server/routes/task-routes.ts`, `plugin/playbooks/implement-github-issue.md`, `src/frontend/components/RalphLoopPanel.tsx`, `src/server/launch-service.test.ts`, `src/server/ralph-loop-service.test.ts`, `src/server/routes/task-routes.test.ts`, `src/core/implement-github-issue-playbook.test.ts`, `src/frontend/components/RalphLoopPanel.test.ts`.

### R4b.8: Project-Targeted Catalog Playbooks [F6.2, F6.6] — SHALL — `done`

The system SHALL allow playbooks discovered from Kookr's catalog cwd to launch tasks in a selected tracked project's local checkout.

**Acceptance criteria:**
- Project-drawer playbook launch keeps playbook discovery rooted at Kookr's catalog cwd when the selected project has no `.kookr/playbooks/`
- Project-drawer launch target defaults to `ProjectSummary.localPath`, then agent-derived cwd, then an unresolved empty target
- Project-drawer target cwd never falls back to draft cwd, recent cwd, or server cwd
- The selected playbook detail lets the user edit target cwd without losing selected playbook, parameters, or loop mode
- Standard, looped, and replace-loop playbook launches send separate playbook source cwd and task target cwd
- Server launch preparation reads the playbook from source cwd and launches the task in target cwd
- Legacy playbook launches that send only `cwd` remain backward-compatible, including frontmatter `cwd:` precedence
- Project-drawer launches include selected project id, and server-side validation rejects conflicting project attribution
- Catalog listing excludes a playbook whose frontmatter `cwd:` resolves to a different repository identity than the browsed project, while retaining unpinned playbooks and pins that resolve to another checkout of the same repository

**Evidence:** `src/frontend/App.tsx` (localPath-first project target), `src/frontend/components/LaunchTaskDialog.tsx` (catalog source vs target cwd), `src/frontend/components/PlaybookBrowser.tsx` (split standard/looped/replace payloads and inline target editing), `src/server/ws-handlers/playbook-handler.ts`, `src/server/use-cases/playbook-list.ts` (pinned-project catalog filtering), `src/server/use-cases/playbook-launch.ts` (source/target normalization, pinned-cwd conflict, projectId validation), `src/server/routes/task-routes.ts` (split HTTP payloads), `src/server/use-cases/looped-playbook-launch.ts`. Tests: `src/shared/contracts/client-message-schema.test.ts`, `src/server/use-cases/playbook-list.test.ts`, `src/server/use-cases/playbook-launch.test.ts`, `src/server/use-cases/looped-playbook-launch.test.ts`, `src/server/routes/task-routes.test.ts`, `src/server/ws.test.ts`, `src/frontend/components/PlaybookBrowser.loopable.test.ts`, `src/frontend/components/LaunchTaskDialog.project-cwd.test.ts`.

### R4b.9: Per-Task Effort and Model Pickers on Launch [F4.1] — SHALL — `done`

The system SHALL let the operator pin reasoning effort and model on a dashboard launch when the selected agent accepts those pins.

**Acceptance criteria:**
- Launch dialog and Quick Launch expose optional effort and model selects for the resolved agent
- Chosen values are forwarded on the WebSocket `launch` payload into the existing `LaunchOpts` contract
- Leaving a select on "Agent default" omits that field so the server default still applies
- Agents that reject a raw per-task model pin (currently Codex CLI and Grok Build) hide the model select
- Agents with no validated effort levels (currently Grok Build) hide the effort select

**Rationale:** The launch pipeline already validates per-task effort (#681) and model (#1518). Without dashboard controls, operators could only pin those values via CLI or API.

**Evidence:** `src/frontend/components/LaunchTaskDialog.tsx`, `src/frontend/components/QuickLaunch.tsx`, `src/frontend/components/LaunchEffortModelPickers.tsx`, `src/shared/contracts/messages.ts`, `src/server/ws-handlers/lifecycle-handler.ts`. Tests: `src/frontend/components/LaunchTaskDialog.effort-model.test.ts`, `src/frontend/components/launch-effort-model.test.ts`, `src/frontend/components/QuickLaunch.defaults.test.ts`, `src/server/ws-handlers/lifecycle-handler.test.ts`, `src/shared/contracts/client-message-schema.test.ts`.

### R4b.10: Remember Last Launch Effort and Model [F4.1] — SHALL — `done`

The system SHALL remember the last effort and model pins sent from dashboard Launch or Quick Launch and restore them on the next open when the current agent still accepts them.

**Acceptance criteria:**
- Closing and reopening Launch after a pinned launch shows the same effort and model in the dropdowns
- Switching to an agent that does not accept a stored pin falls back to "Agent default" for that pin
- A failed send (not connected) does not write the new values
- Last-used agent-type persistence is unchanged
- Effort and model are stored as separate localStorage keys
- Server and CLI defaults are unchanged

**Rationale:** Operators who routinely pin a higher effort or non-default model otherwise re-select those menus on every launch. First-run stays on "Agent default" when nothing is stored.

**Evidence:** `src/frontend/store/last-launch-pins.ts`, `src/frontend/components/launch-effort-model.ts`, `src/frontend/components/LaunchTaskDialog.tsx`, `src/frontend/components/QuickLaunch.tsx`. Tests: `src/frontend/store/last-launch-pins.test.ts`, `src/frontend/components/launch-effort-model.test.ts`, `src/frontend/components/LaunchTaskDialog.effort-model.test.ts`, `src/frontend/components/QuickLaunch.defaults.test.ts`.

### R4b.11: Fill Launch Working Directory from Clipboard Path [F4.1] — SHOULD — `done`

The system SHOULD let the operator fill the Launch dialog's working directory from a copied path that starts with `/` or `~/`, without reading the clipboard until they click.

**Acceptance criteria:**
- Clicking "Use clipboard path" with clipboard `/tmp/demo-repo` or `~/git/demo` (leading/trailing whitespace allowed) sets Working directory to that trimmed path
- A multi-line clipboard uses the first line when that line is a path
- Clicking with a paragraph of prose does not change cwd and explains that the clipboard is not a path
- Empty or denied clipboard does not throw; cwd is unchanged (same fail-closed behavior as the prompt paste chip)
- Opening the dialog does not read the clipboard
- Shape check only (`/` or `~/` after trim); no filesystem access

**Evidence:** `src/frontend/components/LaunchTaskDialog.tsx` (`looksLikeAbsoluteClipboardPath`, `handlePasteCwdFromClipboard`), `src/frontend/components/LaunchTaskDialog.paste.test.ts`.

### R4b.12: Required Launch Dependency Admission [F4.12, F10.5] — SHALL — `done`

The system SHALL preserve required work without consuming a worker when confirmed launch-dependency degradation makes that work non-viable.

**Acceptance criteria:**
- Confirmed degradation creates one durable pending task and starts no adapter session or worker slot
- The original user prompt, cwd, project, agent/model/effort pins, Ralph verdict wiring, dependency list, and idempotency key survive every automatic replay path as intent identity, while the already worktree/delivery-guarded durable task prompt remains the adapter replay prompt
- Unknown/timeout collection evidence stays distinct from confirmed degradation and cannot erase an already degraded or half-open gate
- Recovery allows one half-open probe; concurrent promotion cannot duplicate it
- Before dependency-denied work or a half-open capacity wait is acknowledged as queued or parked, and before a direct, promoted, or crash-recovery half-open probe invokes an adapter, the corresponding admission marker is force-persisted. A probe marker names its expected terminal session before creation so restart recovery can reap an interrupted launch before replay. If the pre-launch persistence barrier fails, no worker starts and no successful queued or parked response is returned
- Probe failure, or restart without a live reconciled probe session, re-parks the same task and stops any partial session only after the exact session is proven absent. A created probe never re-parks merely because launch rejected: direct launch, pending promotion, and crash recovery retain the exact `probing` marker, busy circuit ownership, and active/terminal cleanup ownership when physical stop rejects. Timeout before creation may retain that exact marker with zero session rows until a late callback links/reaps the session. Concurrent completion, cancellation, or termination still wins the work outcome. When the owning failure path proves the exact session stopped, it settles the circuit and clears a terminal task's marker immediately; when cleanup, creation, or circuit settlement remains unresolved, the terminal task retains the marker until runtime reconciliation or startup atomically settles durable and process-local ownership. The marker alone therefore does not assert process liveness. Non-terminal work is then re-parked; a terminal fence releases to one unclaimed half-open probe only when no confirmed degradation (including evidence observed during cleanup) still controls the circuit. Reopen is refused while cleanup ownership remains. A live reconciled probe continues and clears its marker, but confirmed degradation recorded at or after that probe began still keeps the circuit degraded
- Explicit deletion returns a stable retryable conflict while a `probing` cleanup owner remains; clear-finished and aged-prune sweeps skip the record. No deletion path may erase the durable exact-session owner before the owning failure path or reconciliation safely clears it
- Scheduled, interactive, and looped playbook launches all forward dependency declarations
- Generic pending TTL and scheduled-work staleness do not expire or duplicate dependency-parked work, and capacity/diagnostics report launchable pending, parked, degraded, and unknown populations separately
- Duplicate and idempotent REST responses preserve admission metadata; compact task listings retain only safe legacy launch pins (`schemaVersion`, `agentType`, `model`, `effort`) and redact prompt-bearing/replay fields

**Evidence:** `src/core/launch-dependency-admission.ts`, `src/core/launch-dependency-task-admission.ts`, `src/core/task-launch-intent.ts`, `src/core/pending-task-ttl.ts`, `src/core/capacity-ledger.ts`, `src/core/launch-dependency-diagnostics.ts`, `src/core/session-registry.ts`, `src/core/tasks.ts`, `src/server/launch-service.ts`, `src/server/agent-lifecycle.ts`, `src/server/crash-recovery.ts`, `src/server/provider-transient-retry.ts`, `src/server/reconciliation.ts`, `src/server/startup-recovery.ts`, `src/server/schedule-validator.ts`, `src/server/schedule-runner.ts`, `src/server/ralph-loop-service.ts`, `src/server/use-cases/looped-playbook-launch.ts`, `src/server/use-cases/delete-task.ts`, `src/server/use-cases/task-lifecycle-commands.ts`, `src/server/use-cases/prune-aged-task-records.ts`, `src/server/routes/task-routes.ts`, and focused tests beside each module.

### R4b.13: Portable Small-Model Intent [F4.1, F11] — SHALL — `done`

The system SHALL let routine tasks request `modelTier: "small"` without pinning a coding-agent provider.

**Acceptance criteria (Must):**
- Kookr resolves the final agent from the explicit pin, live default, round robin, and provider fallback before resolving the tier
- `small` resolves to Claude Haiku 4.5, Codex Luna with high reasoning, or Grok 4.6 for the final agent
- A tier request cannot be combined with raw `model` or `effort` pins and an unknown tier returns a typed 400 error
- Schedules persist and forward `modelTier` while an omitted `agentType` continues to follow the live Kookr default
- Queued and recovered tasks persist the portable tier with its resolved provider-specific pins, validate that pair before direct adapter replay, and re-resolve the tier when recovery rotates providers
- Codex tier launches fail explicitly when the binary lacks the Kookr fork's per-task model capability; they never silently run the stock default
- Launches and schedules that omit `modelTier` preserve their previous behavior

**Non-functional requirement (Must):** Tier resolution SHALL use an exhaustive agent mapping and SHALL NOT invoke a provider CLI or an LLM to choose the target.

**Evidence:** `src/shared/contracts/model-tier.ts`, `src/shared/contracts/task.ts`, `src/core/task-launch-intent.ts`, `src/server/launch-service.ts`, `src/server/provider-transient-retry.ts`, `src/server/provider-reset-scheduler.ts`, `src/adapters/codex-cli-adapter.ts`, `src/core/schedule.ts`, `src/server/schedule-runner.ts`, `bin/kookr-spawn.js`, and focused tests beside each module.

---

## R4c: Contribution Workspace

### R4c.1: Guided Cleanup for Safe Branches — SHALL — `done`

The system SHALL allow Contribution Workspace cleanup for candidates classified as `merged` or `patch_equivalent`, removing the worktree path and deleting the local branch when the ref is unchanged.

**Acceptance criteria:**
- Cleanup action is enabled only for candidates classified as `merged` or `patch_equivalent`
- The global sweep action removes the same safe classifications as the per-project cleanup action
- Server revalidates the candidate classification before deleting anything and blocks all other classifications
- Cleanup removes the worktree path, prunes git's worktree registry, and deletes the local branch when the observed ref still matches
- If the branch ref changes between validation and deletion, the worktree path is removed but the branch is retained and the user is told why

**Evidence:** `src/server/use-cases/cleanup-inspector.ts` (safe classification including `patch_equivalent`), `src/server/use-cases/workspace-cleanup-service.ts` (revalidation + cleanup execution), `src/frontend/components/CleanupCandidateTable.tsx` (guided cleanup affordance), `src/server/use-cases/workspace-cleanup-service.test.ts`, `src/core/workspace-types.test.ts`.

### R4c.2: Project Contribution Counters — SHALL — `done`

The system SHALL summarize each tracked contribution project with lifecycle counters derived from the OSS attempt store.

**Acceptance criteria:**
- Open PR count reflects every currently open PR for the project, regardless of when the PR was created
- Recent activity endpoints may apply explicit time windows without changing current-state counters
- Scouted-only records do not count as PRs

**Evidence:** `src/core/ledger-analytics.ts` (`getAttemptsByProject`, `getAttemptsByProjectRecent`), `src/core/project-summary.ts` (`openPrs` from all PR-keyed attempts), `src/core/ledger-analytics.test.ts`, `src/core/project-summary.test.ts`.

---

## R5: GUI Layout

### R5.1: Agent List Panel [F5.1] — SHALL — `done`

The system SHALL display a scrollable agent list panel with status indicators.

**Acceptance criteria:**
- Left sidebar shows all managed agents
- Each entry shows agent name/task and status indicator
- Agents needing attention sorted to top
- Clicking an agent selects it
- When a finding's task has at least one PR in `githubState`, the card shows a compact `#<number>` + status chip; failed checks or `changes_requested` add a visible cue; clicking the chip selects the task and activates the GitHub pane (issue #2601)
- When a finding has a `parentTaskId` that resolves to another agent in the live snapshot, the card's context row shows a compact `parent: <name>` chip; clicking it selects that parent without opening a new pane. The chip is absent when `parentTaskId` is unset or the parent is not in the snapshot. Git branch is not shown on the card (issue #2664)
- When `suggestions[agentId].quickActions` is non-empty, the card shows up to five live chips. Permission chips send `permissionChoice` with the live `permissionRequest` binding; other chips send `respond` with the chip value. Permission chips that lack a binding are not rendered. Skip / Snooze / Not a real issue remain. Cards with no suggestion chips look unchanged (issue #2747)

**Evidence:** `src/frontend/components/FindingsPanel.tsx` (scrollable list, status indicators, click selection, sorting), `src/frontend/components/FindingsPanel/FindingPrChip.tsx`, `src/frontend/components/FindingsPanel/FindingCard.tsx` (`FindingParentChip`, live quick-action chips), `src/frontend/components/FindingsPanel/finding-card-quick-actions.ts`.

### R5.2: Agent Detail / Terminal Panel [F5.2] — SHALL — `done`

The system SHALL display the selected agent's interactive terminal and response input.

**Acceptance criteria:**
- Main area shows the agent's interactive xterm.js terminal (bridged to its dtach session via `SessionBridge`)
- Anomaly explanation badge shown in detail header when active
- Input box for responding to the agent
- Empty state when no agent selected
- On the no-selection overview, when at least one agent is live (waiting, running, or completed), show a compact runtime-mix line tallying agents by runtime — known runtimes first in canonical order with short labels (`Claude 3 · Codex 2 · Grok 1`), unknown/legacy `agentType` values kept verbatim and sorted after, alphabetically. Agents with no `agentType` are skipped and a zero-count runtime never appears; the line is absent when there are no tasks (issue #2670)
- On the no-selection overview, each Recently completed row shows at most two compact, presence-only evidence markers read from the row's `completionDigest`: a neutral `Tests`/`Verification evidence` tag (from a test summary or recorded verification commands) and an actionable per-PR link (from `prUrls`). Wording is presence-based and never asserts a pass/verification/merge/delivery outcome; a failing test summary still reads `Tests`, multiple PRs each stay discoverable rather than collapsing to the first, and a row whose digest carries none of this evidence renders unchanged (issue #2851)

**Evidence:** `src/frontend/components/DetailPanel.tsx` (terminal view, anomaly banner, input box, empty state), `src/frontend/components/TerminalPanel.tsx` (xterm.js terminal), `src/frontend/components/OverviewEmptyState.tsx` (no-selection overview, runtime-mix line, `CompletedRowEvidence` markers), `src/frontend/presentation.ts` (`buildRuntimeMix`, `prLinkLabel`).

### R5.3: Status Bar [F5.3] — SHOULD — `done`

The system SHOULD display a status bar with agent counts and keyboard shortcut hints.

**Acceptance criteria:**
- Bottom bar shows count of agents needing attention
- Keyboard shortcut hints displayed
- When at least one live agent has a `finishedAt` in the last 24 hours, show a completed-task chip such as `3 completed / 24h` next to the task/finding counts (issue #2618). Hidden when the count is 0. Tooltip: tasks that reached a terminal status in the last 24 hours; the number is a lower bound because the live snapshot may have dropped older completed rows. This is completed tasks, not unblocked findings.
- When at least one live agent has a `startedAt` in the last 24 hours, show a launched-task chip such as `3 launched / 24h` next to the completed chip (issue #2632). Hidden when the count is 0. Skip agents with a missing or unparseable start time — do not invent a start from `finishedAt`. Tooltip: tasks that started in the last 24 hours; the number is a lower bound because the live snapshot may have dropped older rows. This is launched tasks, not completed tasks or unblocked findings.
- When at least five `finding_resolved` human-reply samples exist in the last 24 hours, show a time-to-unblock chip with the rolling 24-hour unblocked count next to the median wait (issues #2583, #2609). Hide the count copy when `sampleCount` is 0. Skip and snooze are not counted.
- When at least one finding is active, show an oldest-wait chip next to the finding count using the same live wait timestamps as the overview (issue #2588). The chip is hidden when the finding count is zero. It does not replace the historical time-to-unblock chip.
- When the live-friction snapshot has `signalCount > 0`, show a chip whose skip and snooze counts (and false-positive count, if that kind is present) match `signals[]` (issue #2596). Hidden when `signalCount` is 0. Tooltip states it is diagnostics-only and does not reorder findings. Clicking it opens the existing Live friction diagnostics panel. Does not change attention-queue ranking or `routingMutationAllowed`.

**Evidence:** `src/frontend/components/StatusBar.tsx`, `src/frontend/components/status-bar-completed-count.ts`, `src/frontend/components/status-bar-launched-count.ts`, `src/frontend/agent-buckets.ts`, `src/frontend/components/live-friction-chip.ts`, `src/frontend/presentation.ts`, `src/core/time-to-unblock.ts`, `src/shared/contracts/time-to-unblock.ts`, `GET /api/diagnostics/time-to-unblock`, `GET /api/live-friction-calibration`.

### R5.4: Keyboard Shortcuts [F5.4] — SHOULD — `done`

The system SHOULD support keyboard shortcuts for common actions.

**Acceptance criteria:**
- `Ctrl+N`: Navigate to next bottleneck
- `Ctrl+Enter`: Send response
- `Ctrl+L`: Quick-launch
- `Tab`: Skip current finding (when not in an input field)

**Evidence:** `src/frontend/App.tsx` (keyboard handler).

**Evidence:** Not yet implemented in frontend.

### R5.5: Real-time Updates [F5.5] — SHALL — `done`

The system SHALL update all panels live as agent states change, with no manual refresh.

**Acceptance criteria:**
- WebSocket connection maintained between frontend and backend
- Auto-reconnect on connection loss
- Snapshot sent on initial connection; incremental updates thereafter
- State changes reflected in agent list, detail panel, and status bar within 1 second

**Evidence:** `src/frontend/hooks/useWebSocket.ts` (connection + reconnect), `src/server/ws.ts` (snapshot on connect, broadcast on change), `src/frontend/store/useStore.ts` (state handlers).

### R5.6: Onboarding Tour Test Controls — SHOULD — `done`

The system SHOULD expose deterministic controls for automated tests to identify or suppress the first-run onboarding tour without relying on CSS classes or persisted browser state.

**Acceptance criteria:**
- The onboarding overlay exposes a stable `data-testid="onboarding-overlay"` selector
- The Skip/Close button exposes a stable `data-testid="onboarding-skip"` selector
- `?onboarding=0` suppresses the first-run onboarding tour even when localStorage has no seen marker
- `KOOKR_DISABLE_ONBOARDING=1` suppresses the first-run onboarding tour at frontend build/test time

**Evidence:** `src/frontend/components/OnboardingTour.tsx`, `src/frontend/store/onboarding-status.ts`, `src/frontend/store/onboarding-status.test.ts`, `e2e/onboarding-tour.spec.ts`.

### R5.7: Persistent Project Sidebar Preferences — SHOULD — `done`

The system SHOULD persist project sidebar ordering, pinned projects, hidden projects, and cached project labels in the Kookr data directory so the sidebar survives server redeploys and browser storage resets.

**Acceptance criteria:**
- Sidebar preferences are saved to disk under the active Kookr data directory
- Pinned projects are included in project summaries after restart even when no active agent currently references them
- The frontend hydrates sidebar preferences from the backend and migrates existing browser-local sidebar preferences when the backend store is empty
- Browser `localStorage` remains a fallback/cache rather than the source of truth after backend hydration
- Project sidebar icons show active task load rather than PR contribution counts; stalled projects show healthy/active task counts; the all-projects icon shows aggregate active task load.

**Evidence:** `src/core/project-sidebar-store.ts`, `src/server/routes/project-routes.ts` (`/api/projects/sidebar`), `src/frontend/store/slices/project-sidebar-slice.ts`, `src/core/project-sidebar-store.test.ts`, `src/core/project-summary.test.ts`, `src/server/index.test.ts`, `src/frontend/store/slices/project-sidebar-discovery.test.ts`.

### R5.8: Dense Dashboard Focus Mode — SHOULD — `done`

The system SHOULD reduce repeated metadata and long prompt noise when a developer is triaging running tasks on a large dashboard.

**Acceptance criteria:**
- The selected task header keeps title, status, critical worktree health, age, and primary actions visible while moving provider, hooks, project, branch, cost, and token details into a details affordance
- When a project and task are both selected on a wide viewport, the project drawer switches to a compact summary instead of showing full contribution history, settings, and recent tasks
- Oversized launch prompts in the Activity pane render as a bounded preview with an explicit full-prompt expander
- Task display text and hover text prioritize the user-authored prompt over Kookr-injected launch guidance so repeated worktree preambles do not look like duplicate user prompts
- Tooltip portals do not retain hidden long prompt text after dismissal
- Healthy task rows avoid repeated project metadata when the user is already scoped to that project
- The global top bar avoids duplicating finding/healthy counts already shown in the findings and status areas

**Evidence:** `src/core/monitor.ts`, `src/core/prompt-display.ts`, `src/server/launch-service.ts`, `src/frontend/components/Tooltip.tsx`, `src/frontend/components/DetailPanel.tsx`, `src/frontend/components/ActivityPanel.tsx`, `src/frontend/components/ProjectDetailDrawer.tsx`, `src/frontend/components/FindingsPanel.tsx`, `src/frontend/components/TopBar.tsx`, density-focused component tests.

### R5.9: API-Minimal GitHub Awareness Polling — SHOULD — `done`

The system SHOULD poll GitHub PR and issue state with the fewest API calls needed for the configured polling interval.

**Acceptance criteria:**
- GitHub references detected from agent output are fetched immediately without refetching unrelated known references
- Periodic GitHub state refresh batches all known references by repository
- Periodic GitHub state refresh skips references whose owner or repo fails GitHub's segment alphabet and length rules after trim, so a trailing newline or other illegal character cannot produce a retrying NOT_FOUND GraphQL call
- Periodic GitHub state refresh excludes PR references whose last-known status is `merged`; open, draft, and closed references remain eligible for refresh
- Each repository batch uses a single GraphQL request that returns PR metadata, review threads, review decision, comments, checks, issue metadata, labels, and comment counts
- The same GitHub object referenced by multiple tasks remains visible in each task without causing duplicate query selections
- Existing WebSocket `githubUpdate` messages and GitHub alert behavior are preserved

**Evidence:** `src/core/github-scanner-service.ts`, `src/core/github-state-store.ts`, `src/adapters/github-fetcher.ts`, `src/core/github-scanner-service.test.ts`, `src/core/github-state-store.test.ts`, `src/adapters/github-fetcher.test.ts`, `src/adapters/github-fetcher-sanitize.test.ts`, `src/core/project-identity.ts`, `docs/reports/2026-05-12-github-polling-api-call-audit.md`.

### R5.10: System Resource Visibility — SHOULD — `done`

The system SHOULD show lightweight host and Kookr-server resource status in the dashboard status bar.

**Acceptance criteria:**
- The backend samples host CPU and approximate RAM usage every 2 seconds using Node built-in APIs.
- The backend samples Kookr server event-loop delay and process memory without persisting resource samples.
- WebSocket clients receive `resourceStatus` updates and a newly connected client receives the latest cached status after the initial snapshot when one exists.
- The frontend shows CPU and RAM in the existing status bar, renders unavailable metrics as `--`, and marks data stale when no resource message has arrived for more than 10 seconds.
- Resource detail is available through keyboard/touch-accessible status bar controls and includes event-loop delay, Kookr RSS, RAM free/total, and sample timing.
- Resource status is passive context only; it does not alert, throttle, schedule, or create findings.

**Evidence:** `src/core/system-resource-metrics.ts`, `src/server/system-resource-sampler.ts`, `src/server/resource-status-service.ts`, `src/server/ws-connection-handler.ts`, `src/frontend/resource-status.ts`, `src/frontend/components/StatusBar.tsx`, related tests.

---

## R6: Infrastructure & Platform

### R6.1: Managed Terminal Sessions — SHALL — `done`

The system SHALL run agents in managed dtach sessions. See [ADR-007](adr/007-managed-terminal-sessions.md) (managed-session decision) and [ADR-014](adr/014-local-dtach-backend.md) (which replaced tmux with dtach in V8).

**Acceptance criteria:**
- Agents launched in dtach sessions via `LocalDtachBackend.createSession({ command, … })`
- Input delivered via byte-level writes to the dtach socket (`backend.write` / `backend.writeSequence`)
- Display snapshots via `backend.captureBytes` ring-buffer reads (GUI display only)
- Sessions survive Kookr crashes (the dtach socket persists; reconciliation reattaches)
- Session creation, liveness check, and teardown tested

**Evidence:** `src/adapters/local-dtach-backend.ts` (full dtach API), `src/adapters/local-dtach-backend.test.ts` (integration tests with real dtach).

### R6.2: Hook-based Monitoring — SHALL — `done`

The system SHALL monitor agents via Claude Code hooks configured through the `--settings` flag. See [PoC 001](poc/001-hook-mechanism-validation.md).

**Acceptance criteria:**
- Kookr generates a per-agent settings JSON file with hook definitions
- Hooks supported: `SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`
- Hook scripts append JSON events to agent-specific JSONL files in `~/.kookr/hooks/`
- Hook events are tailed in real-time by `HookFileWatcher`
- Events routed by `sessionId` (stable across restarts; the same string used as the dtach socket filename and retained on `Task.sessions[].tmuxSession` for legacy schema compatibility)
- On startup reconciliation, hook files are replayed from offset 0 via `replayExisting` option to rebuild detector state from persisted hook history (see R6.3)
- Hooks are additive to the user's own hook configuration

**Evidence:** `src/adapters/claude-code-adapter.ts` (settings generation, sessionId routing), `src/server/hook-watcher.ts` (JSONL tailing, replayExisting option), `src/core/hook-parser.ts` (JSON → AgentEvent), `src/server/hook-watcher.test.ts` (replay tests), validated by [PoC 001](poc/001-hook-mechanism-validation.md).

### R6.3: Startup Reconciliation — SHALL — `done`

The system SHALL reconcile persisted task state with live dtach sessions on startup. See [ADR-008](adr/008-tmux-session-management.md) (superseded by [ADR-014](adr/014-local-dtach-backend.md); the inline-session-metadata + startup-reconciliation design from ADR-008 still applies, now against `LocalDtachBackend`).

**Acceptance criteria:**
- On startup, read `tasks.json` and query the dtach backend for live sessions (`LocalDtachBackend.listSessions`)
- Reconnect to sessions that are still alive
- Mark dead sessions appropriately
- Handle clean first-start (no tasks file)
- For each resumed session, call `monitor.registerAgent(sessionId)` to register with the monitor
- For each resumed session, call `hookWatcher.watch(sessionId, { replayExisting: true })` to replay hook history from offset 0 and rebuild anomaly detection state (e.g., permission_blocked, needs_input)

**Evidence:** `src/server/reconciliation.ts`, `src/server/reconciliation.test.ts`, `src/server/index.ts` (startup bootstrap — registerAgent + watch with replayExisting), `src/server/hook-watcher.test.ts` ("replayExisting=true replays existing content on watch").

### R6.4: WebSocket Protocol — SHALL — `done`

The system SHALL use WebSocket for real-time communication between frontend and backend.

**Acceptance criteria:**
- Server → Client messages: `snapshot`, `update`, `alert`
- Client → Server messages: `respond`, `navigate`, `getNext`, `skip`, `snooze`, `launch`, `completeTask`, `relaunch`, `cancelTask`, `reopenTask`
- All message types defined as discriminated unions in TypeScript

**Evidence:** `src/server/ws.ts` (message router), `src/core/types.ts` (message types), `src/server/ws.test.ts` (protocol compliance tests).

### R6.5: HTTP Server — SHALL — `done`

The system SHALL serve the frontend SPA and provide a health endpoint.

**Acceptance criteria:**
- `npx kookr` starts the HTTP server
- Frontend SPA served at `/`
- Health check available
- Server binds to configurable port
- After a successful listen, an interactive loopback start opens the dashboard URL once (`xdg-open` / `open`). `CI=true`, `KOOKR_OPEN_BROWSER=0`, a non-TTY stdin, or a non-loopback bind skip the open. A missing opener must not fail startup.

**Evidence:** `src/server/index.ts` (Hono HTTP server, static file serving, startup flow), `src/server/bootstrap/start-http-and-websockets.ts`, `src/server/bootstrap/open-dashboard-browser.ts`.

### R6.6: Platform Support — SHALL — `partial`

The system SHALL support Linux and macOS.

**Acceptance criteria:**
- All features work on Linux (x86_64)
- All features work on macOS (ARM64 + x86_64)
- Windows explicitly deferred (may work under WSL)

**Evidence:** Developed and tested on Linux (WSL2). macOS testing not yet confirmed.

### R6.7: Graceful Shutdown — SHALL — `done`

The system SHALL handle SIGINT/SIGTERM gracefully.

**Acceptance criteria:**
- On signal, stop accepting new connections
- Clean up WebSocket connections
- Stop hook file watchers
- Agent dtach sessions are NOT killed (they survive independently)

**Evidence:** `src/server/index.ts` (signal handlers, cleanup logic).

### R6.8: Cache GET /api/health Assembly [#2429] — SHALL — `done`

The system SHALL reuse one assembled `GET /api/health` JSON body for about one second, and while a rebuild is already in flight, so overlapping diagnosis probes do not each walk the task list and capacity ledger.

**Acceptance criteria:**
- Two overlapping `GET /api/health` requests share one assembly (the second returns the cached or in-flight body)
- A request after the 1-second TTL (`HEALTH_BODY_CACHE_MS`) expires gets a fresh assembly
- `GET /api/ready` stays uncached and does not wait on the health walk
- Health gauges in a cached body may be up to 1 second stale; that staleness is documented

**Evidence:** `src/server/routes/diagnostics-routes.ts` (`HEALTH_BODY_CACHE_MS`, `getCachedHealthBody`), `src/server/routes/diagnostics-routes.test.ts` (`GET /api/health body cache`), `docs/reference/api.md`.

### R6.9: Publish Helper-LLM Pause State on GET /api/health [#2641] — SHALL — `done`

The system SHALL publish a slim, secret-free helper-LLM pause view on `GET /api/health` so remote operators can see why helper calls (task naming, summaries) are degraded without grepping the server log.

**Acceptance criteria:**
- Given a Groq helper-LLM provider is paused after an auth failure, when an operator fetches `GET /api/health`, then `helperLlm.paused` contains a row with `provider=groq` and `category=auth`
- `pausedUntil` is an ISO-8601 timestamp
- The health block never includes an API key or raw provider error body
- The paused array has at most one row per provider
- `helperLlm.stormsSuppressed` reports how many provider attempts the process-wide attempt budget refused
- `kookr ops digest` surfaces a paused helper-LLM provider as a warning with field path `helperLlm.paused`

**Evidence:** `src/core/llm-factory.ts` (`getHelperLlmHealthSnapshot`), `src/server/routes/diagnostics-routes.ts`, `src/cli/kookr-ops-digest.ts`, `src/core/llm-factory.test.ts`, `src/server/routes/diagnostics-routes.test.ts`, `docs/reference/api.md`.

### R6.10: Publish Timer-Health Counts on GET /api/health [#2636] — SHALL — `done`

The system SHALL publish a four-field lifecycle-timer summary on `GET /api/health` so last-good health can answer whether a safety-net timer is overdue after HTTP goes dark, without a second call to `GET /api/diagnostics/timer-health`.

**Acceptance criteria:**
- `GET /api/health` includes `timerHealth.registered`, `timerHealth.overdue`, `timerHealth.neverFired`, and `timerHealth.oldestNeverFiredName`
- Building that summary does no extra disk or network I/O
- `GET /api/diagnostics/timer-health` still returns the full per-loop list
- A loop still inside its first expected interval after boot is not counted overdue
- Last-good health keeps the `timerHealth` block when the full body is truncated

**Evidence:** `src/core/timer-health.ts` (`summary`, `summarizeTimerHealth`), `src/server/routes/diagnostics-routes.ts` (`timerHealthSummaryForHealth`), `src/server/last-good-health.ts` (`pickGauges`), `src/core/timer-health.test.ts`, `src/server/routes/diagnostics-routes.test.ts`, `src/server/last-good-health.test.ts`, `docs/reference/api.md`.

### R6.11: Surface Timer, Hook-Ingestion, and Paused-Schedule Warnings on Ops Digest [#2637] — SHALL — `done`

The system SHALL include overdue lifecycle timers, hook-ingestion p95 lag, and fail-closed paused schedules in `kookr ops digest` so a remote operator paste names those field paths instead of reporting `warnings: none` while they are already on `GET /api/health`.

**Acceptance criteria:**
- A health fixture with hook-ingestion p95 of 43 seconds produces a digest warning that names `hookIngestion.p95LagMs`
- A fixture with one paused schedule produces a warning at `schedules.schedulesPausedByFailure`
- A fixture with `timerHealth.overdue >= 1` produces a warning at `timerHealth.overdue`
- Existing digest warnings still appear and the human output stays under the 20-line cap
- When `/api/health` has no `timerHealth` object, digest may fetch `GET /api/diagnostics/timer-health` with a 2-second timeout and must not hang if that path is wedged

**Evidence:** `src/cli/kookr-ops-digest.ts` (`collectOpsDigestWarnings`), `src/cli/kookr-ops-digest.test.ts`, `docs/reference/cli.md`.

### R6.12: Keep Queue-Feeder Rollups Off the Health Request Path [#2912] — SHALL — `done`

The system SHALL refresh the rolling 24-hour queue-feeder invent-class counts outside `GET /api/health` and SHALL serve health from the last completed in-memory publication.

**Acceptance criteria:**
- `GET /api/health` neither reads nor splits the queue-feeder decisions ledger
- Concurrent refresh requests share one in-flight ledger scan
- The health projection reports the last successful `generatedAt`, its `ageMs`, and `lastRefreshError`
- A failed refresh preserves the last successful product, micro, and other counts
- A slow refresh over a large ledger does not delay health beyond the 2.5-second cold-assembly deadline

**Linked tests:** `src/server/invent-priority-health-refresher.test.ts`, `src/server/routes/diagnostics-routes.test.ts`.

**Dependencies:** R6.8.

**Evidence:** `src/server/invent-priority-health-refresher.ts` (single-flight publication and freshness metadata), `src/server/index.ts` (boot/shutdown lifecycle wiring), `src/server/routes/diagnostics-routes.ts` (in-memory health projection), `src/core/pipeline-starvation-state.ts` (ledger loading and refresh-error propagation), `docs/reference/api.md`.

### R6.13: Preserve the Resource-Watchdog OOM Baseline Across Restarts [#2911] — SHALL — `done`

The system SHALL persist each readable resource-watchdog `oom_kill` sample so the first sample after a daemon restart can detect an OOM-counter increase that occurred after the last completed sample.

**Acceptance criteria:**
- Given a persisted OOM baseline, when the first post-restart sample has a greater counter, then the watchdog emits exactly one `oom_kill_delta` trigger and advances the durable baseline.
- Given legacy watchdog state without an OOM baseline, when the first readable sample arrives, then the watchdog establishes and persists a baseline without emitting `oom_kill_delta`.
- Given a persisted OOM baseline, when a later readable counter is lower, then the watchdog rebaselines to the lower counter without emitting `oom_kill_delta`.
- `GET /api/health.resourceWatchdog` reports the cached baseline value, sample time, age, and whether it came from persisted startup state or a sample observed by the current process, without reading `/proc` or disk on the request path.

**Linked tests:** TS-WATCHDOG-001, TS-WATCHDOG-002, TS-WATCHDOG-003, TS-WATCHDOG-004, TS-WATCHDOG-005.

**Dependencies:** R6.8.

**Evidence:** `src/core/resource-watchdog-state.ts`, `src/server/resource-watchdog-service.ts`, `src/core/resource-watchdog-state.test.ts`, `src/server/resource-watchdog-service.test.ts`, `docs/architecture.md`, `docs/reference/api.md`.

---

## R7: Non-functional Requirements

### R7.1: TypeScript Strict Mode — SHALL — `done`

The system SHALL use TypeScript in strict mode throughout.

**Acceptance criteria:**
- `tsconfig.json` has `strict: true`
- No `any` types except at I/O boundaries with explicit validation
- Discriminated unions for all variant types

**Evidence:** `tsconfig.json`, `src/core/types.ts` (discriminated unions for AgentEvent, AgentStatus, TaskStatus, Anomaly, ServerMessage, ClientMessage).

### R7.2: Test Coverage — SHALL — `done`

The system SHALL maintain comprehensive test coverage using Vitest.

**Acceptance criteria:**
- Every module in `src/core/` has a corresponding `.test.ts` file
- Adapter tests use fakes/mocks for isolation; integration tests use real dtach
- Server tests verify WebSocket protocol compliance
- Integration tests cover the full respond-and-advance loop

**Evidence:** Test files and counts maintained via CI. Integration tests in `src/core/loop.test.ts`.

### R7.3: No ANSI Terminal Parsing — SHALL — `done`

The system SHALL NOT parse terminal ANSI escape sequences for monitoring. See [ADR-007](adr/007-managed-terminal-sessions.md).

**Acceptance criteria:**
- All monitoring data sourced from hooks (structured JSON) and transcript JSONL
- `backend.captureBytes` used only for GUI display, never for anomaly detection
- No ANSI parser dependency

**Evidence:** Architecture enforced in code — hook-parser.ts and hook-watcher.ts handle all monitoring data.

### R7.4: Single Package — SHALL — `done`

The system SHALL ship as a single npm package with no monorepo structure.

**Acceptance criteria:**
- Single `package.json` at the root
- No workspace configuration
- `npx kookr` is the entry point

**Evidence:** Root `package.json`, no workspace config.

### R7.5: Aggregate Hook Test Results — SHALL — `done`

The hook test runner SHALL execute every selected shell-hook suite before reporting an aggregate result.

**Acceptance criteria:**
- A failing suite does not prevent later selected suites from running
- The final summary reports passed and failed suite counts and names every failing suite
- An optional name filter selects suites by a substring of their filename
- The runner exits non-zero if any selected suite fails or if the filter matches no suites

**Evidence:** `scripts/run-hook-tests.sh`, `.claude/hooks-tests/run-hook-tests.test.sh`, and the `test:hooks` package script.

---

## R8: Contribution Workspace Cleanup Controls

### R8.1: Server-owned Cleanup Policy — SHALL — `done`

The system SHALL derive cleanup authorization from a single server-owned policy boundary rather than duplicating cleanup rules in the UI and transport layers.

**Acceptance criteria:**
- `merged` and `patch_equivalent` are authorized for safe remove
- `unique_commits` is authorized for reviewed cleanup and path-only cleanup
- `dirty`, `busy`, `protected`, `checked_out_elsewhere`, detached-HEAD, and other `unknown` states are blocked according to the rollout rules
- removal always refuses the primary checkout and paths that are not registered linked worktrees; protected branches require explicit user confirmation and are blocked from automatic cleanup
- UI-facing cleanup actions consume server-derived capability data rather than hard-coding `classification === 'merged'`

**Evidence:** shared policy boundary in `src/core/workspace-cleanup-policy.ts`, identity-checked removal boundary in `src/adapters/worktree-safety.ts` with real-Git contract coverage in `src/adapters/worktree-safety.test.ts`, bare-entry handling in `src/adapters/git-worktree-registry.ts` and `src/adapters/git-info.ts`, session identity refresh in `src/server/reconciliation.ts`, cleanup inspector/view projections, file-root filtering in `src/server/routes/file-routes.ts`, cleanup service authorization tests.

### R8.2: Freshness-gated Cleanup Execution — SHALL — `done`

The system SHALL reject cleanup when the reviewed candidate state is stale relative to the current worktree fingerprint.

**Acceptance criteria:**
- cleanup detail queries return a review fingerprint derived from current git state
- reviewed cleanup requests include the fingerprint the user approved
- the server rejects cleanup when the fingerprint no longer matches current candidate state

**Evidence:** cleanup detail query/service implementation in `src/server/use-cases/`, transport contracts in `src/shared/contracts/messages.ts`, stale-fingerprint tests.

### R8.3: Reviewed Dirty Cleanup With Recovery Artifact — SHALL — `done`

The system SHALL require a recovery artifact before any cleanup that discards dirty worktree state.

**Acceptance criteria:**
- dirty cleanup requires a fresh review fingerprint and explicit discard intent
- the server creates a recovery stash before removing a dirty worktree path
- the recovery stash includes tracked, untracked, and ignored files
- dirty branch deletion is blocked when commit-comparison evidence is unavailable
- dirty branch deletion requires explicit risk acceptance when local-only commits exist

**Evidence:** dirty-cleanup flow in `src/server/use-cases/workspace-cleanup-service.ts`, dialog UX in `src/frontend/components/CleanupCandidateTable.tsx`, targeted service and workspace tests.

---

## R9: Session Reflection Suggestions

### R9.1: Suggest Reflection After High-Friction Sessions [F8.1-F8.3] — SHOULD — `done`

The system SHOULD suggest an opt-in reflection task after a supervision session shows unusually high friction, using explicit and conservative heuristics.

**Acceptance criteria:**
- Reflection suggestion is evaluated from the existing interaction-log-backed `ReflectionReport`
- Suggestion remains opt-in first; Kookr does not auto-apply workflow changes
- Suggestion only appears after the active supervision session winds down
- Thresholds are conservative and explainable to avoid spam
- Triggering reflection creates a normal Kookr task with concise session context built from the activity-summary foundation

**Evidence:** `src/core/reflection-recommendation.ts`, `src/server/reflection-task.ts`, `src/server/routes/diagnostics-routes.ts`, `src/server/ws.ts`, `src/frontend/App.tsx`, `src/frontend/components/StatusBar.tsx`, related tests in `src/core/reflection-recommendation.test.ts`, `src/server/index.test.ts`, `src/server/ws.test.ts`, `src/frontend/components/status-bar-reflection.test.ts`.

---

## R10: Scheduled Tasks

### R10.1: Finite Cron Trigger Quotas [F11] — SHALL — `done`

The system SHALL allow a schedule to define an optional finite number of cron-triggered executions, decrement that quota only for cron dispatch attempts, and stop the schedule automatically once the quota is exhausted.

**Acceptance criteria:**
- A schedule MAY omit the trigger limit and continue with existing unbounded cron behavior
- When `maxTriggers` is set, the system tracks `remainingTriggers` and decrements it only for cron-triggered executions
- Manual `run now` executions remain available after exhaustion and do not decrement `remainingTriggers`
- When `remainingTriggers` reaches `0`, the schedule is auto-disabled, exposes `stopReason: trigger_limit_reached`, and persists that state across restarts
- The schedule API returns `maxTriggers`, `remainingTriggers`, `stopReason`, and `exhaustedAt` when applicable

**Evidence:** `src/core/schedule.ts` (persisted schedule model), `src/server/schedule-service.ts` (quota accounting and auto-stop), `src/server/schedule-runner.ts` (runtime enforcement), `src/server/routes/schedule-routes.ts` (REST contract), `src/frontend/components/ScheduleSection.tsx` and `src/frontend/components/SchedulesDialog.tsx` (quota visibility), `src/core/schedule.test.ts`, `src/server/schedule-runner.test.ts`, `src/server/index.test.ts`.

### R10.2: Schedule Execution Ledger [F11] — SHALL — `done`

The system SHALL persist a per-schedule execution ledger for cron, manual, skipped, missed, and catch-up decisions.

**Acceptance criteria:**
- Ledger entries include schedule id, due timestamp when applicable, evaluated time, trigger, decision, outcome, reason code, and related task/blocking task ids when available
- Skips caused by active previous runs, capacity pressure, missed startup runs awaiting manual recovery, and stale catch-up windows are durable across restarts
- Missed startup runs SHALL auto-launch exactly once per boot by default (a `catch_up`-tagged fire), gated behind the relaunch arbiter so a missed run cannot duplicate a concurrent actuator; `KOOKR_MANUAL_CATCHUP` reverts to record-for-manual-recovery and `KOOKR_NO_CATCHUP` suppresses catch-up. In every mode the scheduler SHALL advance its cron watermark so the same missed due slot does not replay on the next tick
- The schedule API exposes the ledger with each schedule response
- The schedules UI surfaces recent ledger entries without replacing the latest execution summary

**Evidence:** `src/core/schedule.ts`, `src/shared/contracts/schedule.ts`, `src/server/schedule-service.ts`, `src/server/schedule-runner.ts`, `src/server/routes/schedule-routes.ts`, `src/frontend/components/SchedulesDialog.tsx`, `src/core/schedule.test.ts`, `src/server/schedule-runner.test.ts`, `src/server/routes/schedule-routes.test.ts`.

### R10.3: Sunday Cron Alias Labels [F11] — SHALL — `done`

The system SHALL describe both standard Sunday day-of-week values, `0` and `7`, as Sunday in human-readable schedule labels.

**Acceptance criteria:**
- A weekly schedule with day-of-week `0` is labeled `Every Sun at HH:MM`
- A weekly schedule with day-of-week `7` is labeled `Every Sun at HH:MM`
- Range and list day-of-week labels retain their existing rendering

**Evidence:** `src/core/cron.ts`, `src/core/cron.test.ts`.

### R10.4: Schedule ROI Glance [F11.7] — SHALL — `done`

The system SHALL show a per-schedule scorecard on each Schedules dialog card from the materialized rollup store, without scanning `tasks.json` or hook logs.

**Acceptance criteria:**
- When the Schedules dialog opens, it fetches `GET /api/schedules/rollups` once and joins rows by `scheduleId`
- A card with a rollup row that has retained fires shows fire count, measured cost, and artifact count
- A card with no rollup row, or a zero-fire row, omits the scorecard line
- Unmeasured fires (those without token usage) never render as $0; the tooltip names the `measuredFires` denominator
- Cost attribution follows the [per-schedule ROI guidance](reference/schedule-roi.md): for each measured fire, `costUsd` sums that fire task's recorded closeout snapshot `tokenUsage.costUsd`; later task-usage updates, diagnostic peaks, and descendant usage do not affect the already-closed rollup while the operator decision remains pending
- The linked cost-attribution record explicitly marks operator sign-off as pending, records that reaping-truncation and child-cost inclusion are unresolved policy questions, and distinguishes those questions from the current closeout-only implementation behavior
- The last-execution line and last-three ledger rows remain the detail tier

**Evidence:** `src/frontend/components/SchedulesDialog.tsx`, `src/frontend/schedule-api.ts`, `src/frontend/schedule-format.ts`, `src/frontend/components/SchedulesDialog.test.ts`, `src/frontend/schedule-format.test.ts`, `src/frontend/schedule-api.test.ts`, `docs/reference/schedule-roi.md`, `docs/reports/cost-attribution-semantics-reaped-tasks.md`, `src/server/cost-attribution-semantics.test.ts`.

### R10.5: Keep Schedule Playbook Lookups Bound to the Current Directory [#2893] — SHALL — `done`

The system SHALL keep the schedule-creation playbook catalog and its related form state consistent with the working directory currently shown in the form when directory lookups overlap.

**Acceptance criteria:**
- Only the latest non-empty working-directory lookup may update the playbook catalog, selected playbook, pending prefill result, unmatched-prefill note, or loading state
- A stale successful response SHALL NOT replace a newer catalog or selection
- A stale failed response SHALL NOT clear a newer catalog or surface an unmatched-prefill note for the current directory
- A stale request settling SHALL NOT hide the loading indicator while the current request remains pending
- Clearing the working directory SHALL cancel any in-flight lookup and keep the catalog, selection, and loading state empty after that stale request settles
- Component tests cover both response orders, a stale rejection, overlapping loading state, and clearing the directory during a request

**Evidence:** `src/frontend/components/SchedulesDialog.tsx` (current-effect guard across success, failure, loading finalization, and empty-directory reset), `src/frontend/components/SchedulesDialog.test.tsx` (both response orders, stale rejection, overlapping loading state, and clearing the directory during a request).

### R10.6: Preserve Scheduled Playbook Completion Policy [#2904] — SHALL — `done`

The system SHALL preserve a playbook's configured completion-signal policy when a schedule launches that playbook.

**Acceptance criteria:**
- A scheduled playbook with `autoCloseOnSignal: true` launches a task with the policy enabled
- A scheduled playbook with `autoCloseOnSignal: false` launches a task with the policy explicitly disabled
- A scheduled playbook that omits `autoCloseOnSignal` leaves the task policy unset

**Evidence:** `src/server/schedule-validator.ts`, `src/server/schedule-runner.ts`, and `src/server/schedule-runner.test.ts`.

---

## R11: Self-Diagnostic Telemetry

### R11.1: Detection Stats Count Write-Path Transitions [F15.3] — SHALL — `done`

The system SHALL record anomaly detection telemetry only when new agent events are ingested.

**Acceptance criteria:**
- Read-only snapshot and diagnostic paths do not mutate detection-stat counters
- `checks` count detector evaluations performed by the event-ingestion path
- `fires` count newly emitted anomaly findings, not repeated reads of the same active finding
- Merge-conflict detection ignores source-code reads and grep/search output that merely contain detector pattern strings

**Evidence:** `src/core/anomaly-detector.ts` (pure evaluation + narrowed merge-conflict detector), `src/core/monitor.ts` (single telemetry write boundary), `src/core/anomaly-detector.test.ts`, `src/core/monitor.test.ts`.

---

## R12: Cross-Signal Terminal Session Health

### R12.1: Classify Session Health From Independent Signals [F15.3] — SHALL — `done`

The system SHALL derive an explainable health classification for each managed terminal session from PTY/ring progress, hook progress, transcript progress, task turn state, dtach liveness/attach state, browser bridge activity, and the current server restart epoch.

**Acceptance criteria:**
- A working session with fresh PTY and provider progress is `healthy-working`.
- A completed or input-waiting session with verified transport and sufficient independent signal context, but no new PTY bytes, is `healthy-idle`; unavailable or dead signals remain `session-lost` or `health-unknown`.
- A live dtach master/socket with a frozen PTY/ring head is distinguishable from a lost session and from a provider/agent stall.
- Replayed ring bytes are recorded separately from fresh post-restart/live bytes and never establish liveness on their own.
- Every signal exposes its last progress timestamp (or an explicit unknown/missing state), together with the current attach generation and restart epoch.

**Evidence:** `src/core/session-health.ts`, `src/adapters/local-dtach-backend.ts`, `src/adapters/dtach-ring-store.ts`, `src/server/session-bridge.ts`, `src/core/session-health.test.ts` (`TS-HEALTH-001` through `TS-HEALTH-004`).

### R12.2: Detect Coordinated Session Stalls [F15.3] — SHALL — `done`

The system SHALL group multiple independent sessions that stop advancing within a narrow time window into one coordinated/root-cause diagnostic with related child sessions.

**Acceptance criteria:**
- Two or more working sessions whose independent progress signals stop within the configured coordination window produce one root finding.
- The finding records the related session ids, the observed window, and the restart epoch used for correlation.
- A healthy idle/completed session does not participate in coordinated-stall detection.

**Evidence:** `src/core/session-health.ts` (`detectCoordinatedStall`), `src/core/session-health.test.ts` (`TS-HEALTH-005`).

### R12.3: Expose Session Health in Diagnostics and Support Capture [F15.3] — SHOULD — `done`

The system SHOULD expose the same structured session-health data through the diagnostics endpoint (subject to the deployment's authentication mode), the Diagnostics UI, stale-finding context, and redacted bug-report bundles.

**Acceptance criteria:**
- `GET /api/diagnostics/session-health` returns a versioned fleet snapshot with per-session classifications, evidence, signal timestamps, and any coordinated root finding.
- The Diagnostics UI renders a compact per-session health table with signal states, timestamps/ages, and bounded classification evidence.
- Stale findings include the computed classification and evidence rather than only generic stale wording.
- Support capture includes session health while redacting transcript paths, secrets, and other sensitive values.

**Evidence:** `src/server/session-health-service.ts`, `src/server/routes/diagnostics-routes.ts`, `src/frontend/components/SessionHealthPanel.tsx`, `src/frontend/components/FindingsPanel.tsx`, `src/frontend/bug-report-bundle.ts`, `src/server/session-health-service.test.ts` (`TS-HEALTH-006`), `src/server/routes/session-health-route.test.ts` (`TS-HEALTH-007`), `src/frontend/bug-report-bundle.test.ts` (`TS-HEALTH-008`).

---

## R13: Accurate Cost Metering

### R13.1: Price Transcript Usage Per Model [F4.9] — SHALL — `done`

The system SHALL price transcript token usage against the model that produced each usage bucket and SHALL expose when an estimate used fallback pricing.

**Acceptance criteria:**
- A transcript containing usage from two known models keeps separate token buckets and reports the sum priced at each model's rates with `pricingQuality: 'exact'`.
- A transcript containing an unknown model does not throw, uses the legacy fallback rate, and reports `pricingQuality: 'fallback'`.
- A transcript whose model id longest-prefix-matches a known pricing row (e.g. `claude-opus-4-8-20260701`) prices against that row and reports `pricingQuality: 'exact'` (not `'fallback'`).
- Legacy result-entry totals continue to override estimated cost and authoritative token totals continue to be honored.
- Corrected transcript cost remains the input to `BudgetChecker`, so the configured threshold is evaluated against the corrected amount.
- A later corrected task cost adjusts the lifetime spend counter by its delta, including a finite downward correction.
- `TokenUsage.pricingQuality` is optional so existing persisted task records remain valid.

**Evidence:** `src/core/pricing-tables.ts`, `src/core/token-tracker.ts`, `src/core/usage-types.ts`, `src/core/tasks.ts`, `src/shared/contracts/usage.ts`, `src/core/pricing-tables.test.ts`, `src/core/token-tracker.test.ts`, `src/core/tasks.test.ts`.

### R13.2: Show Session Dollars-Per-Hour Next to Cost [#2575] [F4.9] — SHALL — `done`

The dashboard SHALL show a compact dollars-per-hour figure next to session cost so a supervisor can tell a four-dollar burst from a four-dollar afternoon without dividing by hand.

**Acceptance criteria:**
- Given a session with a positive cost and a start time older than two minutes, the detail Cost row and the finding-card cost line show a compact `$X.XX/h` figure.
- Given a session younger than two minutes, or missing cost or start time, those surfaces omit the rate and never render `NaN` or an infinite value.
- The two-minute floor is the same cutoff `formatAge` already uses for finding age (`FRESH_SESSION_FLOOR_MS`, 120000 ms).
- The rate is total session cost divided by wall-clock hours since start, not a recent-window average.

**Evidence:** `src/frontend/presentation.ts` (`formatCostRate`), `src/frontend/components/DetailPanel.tsx`, `src/frontend/components/FindingsPanel/FindingCard.tsx`, `src/frontend/presentation.test.ts`, `src/frontend/components/DetailPanel.density.test.ts`, `src/frontend/components/FindingsPanel/FindingCard.cost-rate.test.tsx`.

---

## R14: Text-to-Speech Input Safety

### R14.1: Bound Synthesis Text [#1445] — SHALL — `done`

The TTS sidecar SHALL reject synthesis requests whose text is blank or exceeds the configured character limit before invoking the speech model.

**Acceptance criteria:**
- Empty or whitespace-only text returns HTTP 400 with a clear client-facing message.
- Text longer than `TTS_MAX_TEXT_LENGTH` returns HTTP 413 with a clear client-facing message.
- Text at or below the configured limit follows the existing synthesis path unchanged.

**Evidence:** `tts/src/server.py`, `tts/docker-compose.yml`, `tts/tests/test_server.py`.

## R15: Orchestration Pause Provenance

### R15.1: Preserve Explicit Quota-Drain Lifecycles [#2782] — SHALL — `done`

The system SHALL persist each orchestration pause as an explicit lifecycle record and SHALL keep current pause state separate from historical quota-drain overlap.

**Acceptance criteria:**
- Every pause start is persisted as `active`, `ended`, `cancelled`, or `unresolved`, with the source and lifecycle timestamps needed to explain that state.
- Explicit, automatic, and kill-switch-off resumes close the active record with an end timestamp and source instead of deleting its history.
- A record without a trustworthy end is represented as `unresolved`, is excluded from known historical overlap, and contributes an explicit incomplete-record warning.
- Process restart reloads the persisted active record without creating a duplicate, while retained terminal records remain available for audit.
- The orchestration status and health payloads expose current pause state, known historical overlap for the 24-hour window, and incomplete-record warnings as separate fields.
- The 2026-08-23 fixture (19.3 hours of historical overlap with pause currently cleared) remains below the recent baseline and reports the incomplete-quota caveat without adding another pause heuristic.

**Evidence:** `src/core/orchestration-pause.ts`, `src/server/orchestration-pause-service.ts`, `src/server/routes/diagnostics-routes.ts`, `src/core/orchestration-pause.test.ts`, `src/server/orchestration-pause-service.test.ts`, `src/server/routes/orchestration-routes.test.ts`, `src/server/routes/diagnostics-routes.test.ts`.

## R16: Issue Emission Bootstrap

### R16.1: Default New Repositories to an Effective Zero-Drain Allowance — SHALL — `done`

The system SHALL let a repository with no project-specific zero-drain setting emit issues before it has closed an issue in the drain window. The effective default SHALL be unlimited (`-1`) when the deployment has no configured ceiling, or the deployment ceiling when `KOOKR_MAX_ZERO_DRAIN_ISSUE_LIMIT` is set.

**Acceptance criteria:**
- With no project-specific value and no deployment ceiling, project settings present `-1` as the inherited default, `kookr emission plan` reports `-1`, and a zero drain count does not reduce the budget produced by the other emission gates.
- With no project-specific value and a deployment ceiling of `N`, project settings present `N` as the inherited default, `kookr emission plan` reports `N`, and a zero drain count caps issue emission at `N`.
- An explicit per-project value from `0` through the deployment ceiling overrides the effective default; explicit `0` refuses zero-drain emission.
- `-1` is accepted as the unlimited sentinel only when no deployment ceiling is configured.
- Repositories with a positive drain count remain governed by the existing drain-ratio calculation.

**Evidence:** `src/core/project-config-store.ts`, `src/core/emission-budget.ts`, `src/cli/kookr-emission.ts`, `src/frontend/components/ProjectDetailDrawer.tsx`, `src/core/project-config-store.test.ts` (`TS-EMISSION-001`), `src/core/emission-budget.test.ts` (`TS-EMISSION-002`), `src/cli/kookr-emission.test.ts` (`TS-EMISSION-003`), `src/frontend/components/ProjectDetailDrawer.tied.test.ts` (`TS-EMISSION-004`).

## R17: Self-Advancing Chain Recovery

### R17.1: Reconcile Umbrella Chains Across Configured Projects [#2903] — SHALL — `done`

The system SHALL reconcile self-advancing umbrella chains in every configured GitHub project whose canonical checkout and remote default branch can be resolved.

**Acceptance criteria:**
- One sweep discovers valid phase ledgers in at least two configured repositories while preserving the existing single-repository behavior.
- Each continuation launch uses the matching project ID and canonical checkout, plus a repository-qualified phase claim and idempotency key.
- Health keeps chains with the same issue number in different repositories as separate rows identified by repository and issue number.
- Discovery ignores ordinary open issues without a `kookr-phase-ledger` marker instead of recording them as malformed chains.
- A terminal phase owner without a recorded PR is persisted as terminal, is not relaunched, and produces an actionable fail-closed health reason.
- A project whose checkout or remote default branch cannot be resolved is skipped without attributing its chains to another project.

**Linked tests:** TS-CHAIN-001, TS-CHAIN-002, TS-CHAIN-003.

**Evidence:** `src/server/use-cases/umbrella-chain-advancer.ts`, `src/server/index.ts`, `src/adapters/github-umbrella-chain-client.ts`, `src/server/use-cases/workspace-context.ts`, `src/core/repo-policy-resolver.ts`, `src/server/use-cases/umbrella-chain-advancer.test.ts` (`TS-CHAIN-001`, `TS-CHAIN-003`), `src/adapters/github-umbrella-chain-client.test.ts` (`TS-CHAIN-002`), `src/server/use-cases/workspace-context.test.ts`.

## Summary Matrix

| Req | Feature | Priority | Status | Module(s) |
|-----|---------|----------|--------|-----------|
| R1.1 | F1.2 | SHALL | done | types, monitor, ws, useStore |
| R1.2 | F1.3 | SHOULD | partial | hook-parser, AgentDetail, hook-watcher, presentation, HealthyRow |
| R1.3 | F1.4 | SHOULD | partial | tasks, frontend components |
| R1.4 | F1.1 | MAY | deferred | — |
| R1.5 | F1.5 | MAY | deferred | — |
| R1.6 | F1.4 | SHOULD | partial | git-worktree-registry, reconciliation, lifecycle-timers, monitor |
| R1.7 | F1.4 | SHOULD | done | completion-digest, completion-metadata, lifecycle-handler |
| R1.8 | F4.4 | SHOULD | done | agent-lifecycle, lifecycle-handler |
| R2.1 | F2.1 | SHALL | done | hook-parser, anomaly-detector, monitor |
| R2.2 | F2.2 | SHOULD | deferred | — |
| R2.3 | F2.3 | SHOULD | done | anomaly-detector |
| R2.4 | F2.4 | SHOULD | done | hook-parser, anomaly-detector, monitor |
| R2.5 | F2.5 | MAY | partial | budget-checker, progress-budget-burn-diagnostics, lifecycle-timers, token-tracker |
| R2.6 | F2.6 | MAY | deferred | — |
| R2.7 | F2.7 | SHOULD | done | anomaly-detector, ws, Toasts |
| R2.8 | F2.8 | SHALL | done | anomaly-detector, attention-queue |
| R2.9 | F2.9 | SHOULD | done | Toasts, useNotifications, App |
| R2.10 | F2.9 | SHALL | done | monitor, finding-helpers, DetectionStatsPanel |
| R2.11 | F2.10 | SHOULD | done | finding-evidence-audit, monitor, lifecycle-timers, diagnostics-routes |
| R2.12 | F2.11 | SHOULD | done | review-log-store, finding-evidence-review-service, diagnostics-routes |
| R2.13 | F2.12 | SHOULD | done | detector-proposal-report, review-log-store, diagnostics-routes |
| R2.14 | #1378 | SHALL | done | agent-types, suppression-store, coordinator-routes |
| R3.1 | F3.1 | SHALL | done | AgentDetail, useStore |
| R3.2 | F3.2 | SHALL | done | AgentDetail, ws, claude-code-adapter |
| R3.3 | F3.3 | SHALL | done | attention-queue, loop.test |
| R3.3a | F3.3 | SHALL | done | terminal-input-coordinator, dashboard-selection-controller, session-bridge, DetailPanel |
| R3.4 | F3.4 | SHOULD | partial | attention-queue, AgentDetail |
| R3.5 | F3.5 | SHOULD | done | AgentList, useStore |
| R3.6 | F3.6 | SHALL | done | attention-queue, ws, loop.test |
| R3.7 | F3.7 | SHALL | done | attention-queue, ws, loop.test |
| R3.8 | — | SHOULD | done | useStore, SentOverlay, DetailPanel |
| R3.9 | — | SHOULD | done | group-findings, FindingsPanel |
| R3.10 | F5.1 | SHOULD | done | finding-type-filter, FindingsPanel |
| R3.11 | F3.1 | SHOULD | done | activity-role-filter, ActivityPanel |
| R4.1 | F4.1 | SHALL | done | LaunchTaskDialog, ws, agent-types, client-message-schema, server-message-schema, claude-code-adapter, local-dtach-backend |
| R4.1a | F4.1 | SHALL | done | grok-auth-preflight, grok-build-adapter |
| R4.1b | F4.1 | SHALL | done | grok-auth-status, grok-auth-routes, LaunchTaskDialog |
| R4.1c | F17.4 | SHALL | done | launch-duplicate, LaunchDuplicateBanner, LaunchTaskDialog, QuickLaunch |
| R4.1d | F4.1 | SHALL | done | quota-headroom-admission, launch-quota-warning, LaunchQuotaBanner, LaunchTaskDialog |
| R4.1e | F4.1 | SHALL | done | launch-duplicate, LaunchBusyDirectoryBanner, LaunchTaskDialog |
| R4.2 | F4.2 | SHOULD | done | claude-code-adapter, local-dtach-backend, ws, DetailPanel |
| R4.3 | F4.3 | SHOULD | done | tasks (relaunch), ws (relaunch handler), LaunchTaskDialog |
| R4.4 | F4.4 | SHALL | done | tasks, task-persistence, reconciliation |
| R4.5 | F4.5 | SHOULD | partial | LaunchTaskDialog, tasks (auto-eval todo) |
| R4.6 | F4.6 | SHOULD | done | local-dtach-backend (stable socket path), TerminalPanel (in-browser xterm.js) |
| R4.7 | F4.4 | SHOULD | done | settings-store, App, SettingsDialog, agent-lifecycle, client-message-schema |
| R4.8 | F4.4 | SHALL | done | maintenance-prune, persistence-utils, kookr-maintenance |
| R4b.1 | — | SHALL | done | ws, server/index, useStore, LaunchTaskDialog |
| R4b.2 | — | SHALL | done | recent-paths, LaunchTaskDialog |
| R4b.3 | — | SHOULD | done | useStore, DetailPanel, App |
| R4b.4 | — | SHOULD | done | QuickLaunch, App |
| R4b.5 | — | SHOULD | done | telegram/index, telegram/rephrase, launch-service |
| R4b.5a | — | SHOULD | done | settings-store, launch-service, SettingsDialog |
| R4b.5b | — | SHOULD | done | telegram/tasks-command, telegram/index |
| R4b.6 | F6.7 | SHOULD | done | looped-playbook-launch, PlaybookBrowser |
| R4b.7 | — | SHALL | done | launch-service, ralph-loop-service, implement-github-issue playbook |
| R4b.8 | F6.2, F6.6 | SHALL | done | LaunchTaskDialog, PlaybookBrowser, playbook-launch, task-routes |
| R4b.9 | F4.1 | SHALL | done | LaunchTaskDialog, QuickLaunch, LaunchEffortModelPickers, messages, lifecycle-handler |
| R4b.10 | F4.1 | SHALL | done | last-launch-pins, LaunchTaskDialog, QuickLaunch, launch-effort-model |
| R4b.11 | F4.1 | SHOULD | done | LaunchTaskDialog (`looksLikeAbsoluteClipboardPath`), LaunchTaskDialog.paste.test.ts |
| R4b.12 | F4.12, F10.5 | SHALL | done | launch-dependency-admission, task-launch-intent, launch-service, agent-lifecycle, crash-recovery, schedule-validator, task-routes |
| R4b.13 | F4.1, F11 | SHALL | done | model-tier, launch-service, schedule, schedule-runner, kookr-spawn |
| R4c.1 | — | SHALL | done | cleanup-inspector, workspace-cleanup-service, CleanupCandidateTable |
| R4c.2 | — | SHALL | done | ledger-analytics, project-summary |
| R5.1 | F5.1 | SHALL | done | AgentList |
| R5.2 | F5.2 | SHALL | done | AgentDetail |
| R5.3 | F5.3 | SHOULD | done | StatusBar |
| R5.4 | F5.4 | SHOULD | done | App, useStore, DetailPanel |
| R5.5 | F5.5 | SHALL | done | useWebSocket, ws, useStore |
| R5.6 | — | SHOULD | done | OnboardingTour, onboarding-status, onboarding-tour E2E |
| R5.7 | — | SHOULD | done | project-sidebar-store, project-routes, project-sidebar-slice |
| R5.8 | — | SHOULD | done | prompt-display, monitor, launch-service, Tooltip, DetailPanel, ActivityPanel, ProjectDetailDrawer, FindingsPanel, TopBar |
| R5.9 | — | SHOULD | done | github-scanner-service, github-state-store, github-fetcher, project-identity |
| R5.10 | — | SHOULD | done | system-resource-metrics, resource-status-service, useWebSocket, StatusBar |
| R6.1 | ADR-007 / ADR-014 | SHALL | done | local-dtach-backend |
| R6.2 | PoC 001 | SHALL | done | claude-code-adapter, hook-watcher, hook-parser |
| R6.3 | ADR-008 (superseded by ADR-014) | SHALL | done | reconciliation, local-dtach-backend |
| R6.4 | arch | SHALL | done | ws, types |
| R6.5 | arch | SHALL | done | server/index |
| R6.6 | features | SHALL | partial | tested on Linux only |
| R6.7 | arch | SHALL | done | server/index |
| R6.8 | #2429 | SHALL | done | diagnostics-routes health body cache |
| R6.9 | #2641 | SHALL | done | llm-factory helperLlm health snapshot, diagnostics-routes, ops digest |
| R6.10 | #2636 | SHALL | done | timer-health summary on GET /api/health, last-good pickGauges |
| R6.11 | #2637 | SHALL | done | ops digest timerHealth / hookIngestion.p95LagMs / schedulesPausedByFailure |
| R6.12 | #2912 | SHALL | done | background queue-feeder invent-class refresher, in-memory health projection |
| R6.13 | #2911 | SHALL | done | resource-watchdog state, service, and cached health projection |
| R7.1 | CLAUDE.md | SHALL | done | tsconfig, types |
| R7.2 | CLAUDE.md | SHALL | done | Vitest test suite (count maintained via CI) |
| R7.3 | ADR-007 | SHALL | done | hook-parser, hook-watcher |
| R7.4 | CLAUDE.md | SHALL | done | package.json |
| R7.5 | #1315 | SHALL | done | run-hook-tests.sh, run-hook-tests.test.sh, package.json |
| R8.1 | — | SHALL | done | workspace-cleanup-policy, cleanup inspector/projections/service |
| R8.2 | — | SHALL | done | workspace-cleanup use-cases, shared contracts |
| R8.3 | — | SHALL | done | workspace-cleanup-service, CleanupCandidateTable |
| R9.1 | F8.1-F8.3 | SHOULD | done | reflection-recommendation, reflection-task, StatusBar |
| R10.1 | F11 | SHALL | done | schedule, schedule-service, schedule-runner, schedule-routes |
| R10.2 | F11 | SHALL | done | schedule execution ledger, schedule-runner, schedule-routes, SchedulesDialog |
| R10.3 | F11 | SHALL | done | cron description helpers |
| R10.4 | F11.7 | SHALL | done | SchedulesDialog rollup glance, schedule-api, schedule-format |
| R10.5 | #2893 | SHALL | done | SchedulesDialog current-effect guard and overlap regressions |
| R10.6 | #2904 | SHALL | done | schedule-validator and schedule-runner completion-policy propagation |
| R11.1 | F15.3 | SHALL | done | anomaly-detector, monitor, DetectionStatsPanel |
| R12.1 | F15.3 | SHALL | done | session-health, local-dtach-backend, dtach-ring-store, session-bridge, Monitor |
| R12.2 | F15.3 | SHALL | done | session-health, SessionHealthService, diagnostics-routes |
| R12.3 | F15.3 | SHOULD | done | diagnostics-routes, SessionHealthPanel, FindingsPanel, bug-report-bundle |
| R13.1 | F4.9 | SHALL | done | pricing-tables, token-tracker, usage-types, tasks |
| R13.2 | F4.9 | SHALL | done | presentation formatCostRate, DetailPanel, FindingCard |
| R14.1 | #1445 | SHALL | done | TTS server input validation |
| R15.1 | #2782 | SHALL | done | orchestration-pause, orchestration-pause-service, diagnostics-routes |
| R16.1 | emission bootstrap | SHALL | done | project-config-store, emission-budget, kookr-emission, ProjectDetailDrawer |
| R17.1 | #2903 | SHALL | done | umbrella-chain-advancer, github-umbrella-chain-client, workspace-context, server wiring |

---

## Gap Summary

### SHALL requirements not yet fully done:

| Req | What's left |
|-----|-------------|
| R6.6 | macOS validation |

### SHOULD requirements remaining:

| Req | What's left |
|-----|-------------|
| R1.2 | Wire activity display end-to-end (hook events → frontend) — repeat-pill done |
| R1.3 | Display agent metadata — all gap items done, cost deferred to R2.5 |
| R1.6 | Worktree health reconciliation shipped for live registry checks; remaining validation is around edge-case stale/prunable refresh behavior |
| R2.2 | Detect stuck loops through the V2 semantic supervisor; deterministic same-tool counting was removed |
| R3.4 | Polish "all clear" empty state UI |
| R4.5 | Auto-evaluation of completion criteria (V2 candidate) |

### MAY requirements remaining: 4

| Req | Status | What's left |
|-----|--------|-------------|
| R1.4 | deferred | Agent discovery outside Kookr-managed sessions |
| R1.5 | deferred | Detect new/exited agents outside Kookr-managed sessions |
| R2.5 | partial | User-facing progress-aware budget burn; reactive cost-threshold alerts and diagnostics-only progress-aware sampling are implemented |
| R2.6 | deferred | Trajectory drift via the V2 semantic supervisor |
