# Features & Functionality

This document defines **what Kookr must do** from the user's perspective. No technical implementation details — just the problems it solves and the interactions it enables.

---

## Core User Journey

```
Developer runs several AI coding agents
  ↓
Developer runs `npx kookr` → browser opens
  ↓
Kookr's supervisor agent watches all agents' output
  ↓
Agent #3 loops on the same failing test 12 times
  → Supervisor detects the anomaly
  → Generates explanation: "Agent #3 is stuck: same test failure
     12 times, not changing approach. Error: TypeError..."
  → Highlights agent #3 in the UI with the explanation
  ↓
Developer reads the explanation, types a hint → sends
  ↓
Kookr auto-advances to the next agent that needs help
  ↓
When no agents need help → "All clear, agents working"
```

---

## Terminology

**Bottleneck**: anything that prevents an agent from making progress on its task. Examples include:
- The agent needs information from the user (e.g., where to find a file, what approach to take)
- The agent needs access to a resource it can't reach (e.g., credentials for a database, VPN access, API keys)
- The agent is waiting for an external event (e.g., a code review, a CI pipeline result)
- The agent is stuck in a loop and needs a hint to change approach
- The agent drifted off-task and needs to be redirected

A bottleneck is not necessarily an error — it is a state where human attention can unblock the agent.

**Task**: a natural-language description of what an agent should accomplish (e.g., "Fix the auth bug in login.ts", "Add pagination to the /users endpoint"). For managed agents, the task is the prompt given at launch. Optionally, a task can include **completion criteria** (definition of done) to help Kookr determine when the agent has finished.

---

## Feature Categories

### F1: Agent Discovery & Monitoring

| ID | Feature | Description |
|----|---------|-------------|
| F1.1 | **Auto-discover running agents** | Detect Claude Code, Codex CLI, and Gemini CLI processes already running on the machine. No manual registration needed. |
| F1.2 | **Show agent status** | For each agent: running, waiting for input, errored, completed. Updated in real time. |
| F1.3 | **Show what each agent is doing** | Display the agent's current activity: what file it's reading, what tool it's using, what it last said. Tool calls and activity are available via hooks (real-time) and transcript JSONL (history). |
| F1.4 | **Show agent metadata** | Agent type, working directory, how long it's been running, session cost (if available). |
| F1.5 | **Detect new and exited agents** | When a new agent starts or an existing one exits, update the list automatically. |

### F2: Smart Anomaly Detection (Supervisor Agent)

Kookr's supervisor is an AI that watches agent streams and **understands** what they're doing — not just whether they're "running" or "idle."

| ID | Feature | Description |
|----|---------|-------------|
| F2.1 | **Detect "needs input" state** | Agent is waiting for the developer. Detected via (1) the `Stop` hook (fires when the agent finishes its turn — severity: info) or (2) the `AskUserQuestion` tool call (agent explicitly asks for input — severity: warning). `Stop` payload includes `last_assistant_message` for supervisor context. See [PoC 001](poc/001-hook-mechanism-validation.md). |
| F2.2 | **Detect stuck loops** | Agent is repeating the same action (e.g., running a test, editing a file) N times without meaningful change. **V1 status:** Deferred to V2 AI supervisor. Deterministic detection produces too many false positives (e.g., reading 20 files is normal exploration). The `stuck_loop` type was removed from the codebase — V2 will re-introduce it with semantic analysis. |
| F2.3 | **Detect repeated errors** | Agent keeps hitting the same error and isn't changing its approach. |
| F2.4 | **Detect permission blocks** | Agent is blocked on a tool permission prompt and can't proceed. Detected via the `PermissionRequest` hook, which fires before the permission dialog appears. Payload includes `tool_name`, `tool_input`, and `permission_suggestions`. See [PoC 001](poc/001-hook-mechanism-validation.md) and [ADR-006 revisit](adr/006-permission-mode-feasibility.md#revisit-interactive-mode-2026-03-24). |
| F2.5 | **Detect budget burn** | V1 emits reactive `budget_exceeded` findings when observed task cost crosses configured warning/critical thresholds, and records diagnostics-only progress-aware budget-burn samples for replay/precision analysis. User-facing progress-aware "cost climbing with no progress" findings remain a V2 semantic-supervisor feature. |
| F2.6 | **Detect trajectory drift** | Agent was supposed to fix a bug but started refactoring something unrelated. (V2 — requires LLM) |
| F2.7 | **Explain the problem** | For each anomaly, generate a human-readable explanation: what the agent did, what went wrong, and what the developer should consider doing. |
| F2.8 | **Prioritize by urgency** | V1 priority is severity-first: critical findings before warnings before info. Examples include critical `budget_exceeded` before warning findings, and AskUserQuestion `needs_input` (warning) before Stop-derived `needs_input` (info). Progress-aware budget burn, stuck-loop, and trajectory-drift detection remain V2 semantic-supervisor work. |
| F2.9 | **Notify when attention is needed** | Visual alert in the UI + optional browser notification with the explanation summary. |
| F2.10 | **Audit finding evidence** | Capture bounded evidence snapshots over time for surfaced supervisor findings so operators can review false positives and timing-sensitive alerts without reconstructing behavior from source code. |
| F2.11 | **Persist finding review diagnostics** | Store manual finding-evidence review outcomes and invalid model attempts in an append-only diagnostics log that is separate from runtime task state. |
| F2.12 | **Report detector proposal candidates** | Group repeated finding-review outcomes by detector target and version into advisory diagnostics reports with evidence hashes, review populations, and plain-text model rationale excerpts; reports never mutate detector behavior automatically. |

**Implementation approach:** V1 detection patterns are implemented as pure functions in `anomaly-detector.ts`, co-located with their tests for simplicity. The SKILL.md approach (community-contributable, discoverable patterns) remains a valid V2 direction. V2 can also add LLM-powered analysis for nuanced detection (trajectory drift, strategic dead ends).

### F3: The "Loop" — Respond & Advance

| ID | Feature | Description |
|----|---------|-------------|
| F3.1 | **View blocked agent's context** | When navigating to a blocked agent, show what it's asking and relevant conversation history. |
| F3.2 | **Respond to agent** | Type a response in Kookr's UI and have it delivered to the agent's managed dtach session via byte-level writes (`backend.write` / `backend.writeSequence`). Same effect as the developer typing directly in the terminal. See [ADR-007](adr/007-managed-terminal-sessions.md) and [ADR-014](adr/014-local-dtach-backend.md). |
| F3.3 | **Auto-advance after response** | After sending a response, automatically navigate to the next agent that needs attention. |
| F3.4 | **"All clear" state** | When no agents need attention, show a clear "all agents working autonomously" state. |
| F3.5 | **Manual navigation** | Allow the developer to manually select any agent from the list, not just the next bottleneck. |
| F3.6 | **Skip agent** | Deprioritize an agent to the back of the queue. Supervisor keeps monitoring — if the agent's state changes (new anomaly, completion), it re-enters the active queue. |
| F3.7 | **Snooze agent** | Pause monitoring for a chosen duration (+ optional reason). Supervisor stops polling. On timer expiry, supervisor re-evaluates and re-queues if anomaly persists. |
| F3.8 | **Quick action buttons** | When an agent stops and its last message contains a recognizable binary or multiple-choice question, Kookr presents clickable quick-action buttons (e.g., "Yes"/"No", numbered options) alongside the free-text input. Keyboard shortcuts (1-5) trigger corresponding actions. |
| F3.9 | **AI response suggestions** | When an agent needs input and quick actions are insufficient, Kookr generates 3-5 predicted developer responses through the configured LLM provider. Suggestions appear as clickable buttons above the input box. Requires an LLM provider key (Groq, Gemini, Anthropic, or OpenRouter — see [Configuration](configuration.md#ai-suggestions)). |

### F4: Agent Lifecycle

| ID | Feature | Description |
|----|---------|-------------|
| F4.1 | **Launch new agent** | Start a new agent from the GUI with a task description (natural-language prompt) and working directory. Launched in a managed terminal session (interactive mode) for full monitoring and developer access. See [ADR-007](adr/007-managed-terminal-sessions.md). |
| F4.2 | **Stop agent** | Terminate a running agent from the GUI. Stopping kills the dtach session, stops the hook file watcher, and marks the agent as stopped in the monitor to prevent resurrection from late-arriving hook events. |
| F4.3 | **Relaunch agent** | Create a new task with the same or modified prompt and working directory. The original task is preserved for history — relaunch creates a new task rather than restarting in-place. |
| F4.4 | **Task lifecycle management** | Tasks are the unit of work. **One task = one agent session** (no multi-session tasks). Lifecycle: Open → InProgress → Completed/Cancelled. Completing or cancelling a task kills the associated dtach session. Relaunch creates a new task (preserving the original for history). Tasks are persisted locally in JSON. |
| F4.5 | **Optional completion criteria** | When launching an agent, the user can provide a definition of done (e.g., "tests pass", "PR created"). Criteria are stored on the task but not auto-evaluated in V1 — the developer must explicitly mark the task complete. |
| F4.6 | **Attach to agent terminal** | Open an agent's managed dtach session directly from an external terminal when needed. Kookr no longer exposes a GUI button that copies an attach command. See [ADR-007](adr/007-managed-terminal-sessions.md) and [ADR-014](adr/014-local-dtach-backend.md). |
| F4.7 | **Rename task** | Double-click a task name in the findings panel or detail header to edit it inline. The custom name overrides the auto-generated name (truncated prompt) everywhere in the UI. Clearing the name reverts to the default truncated prompt. |
| F4.8 | **AI task naming** | When a task is launched, the configured LLM provider generates a concise 3-8 word name from the prompt (e.g., "Fix JWT Token Invalidation"). Requires an LLM provider key (Groq, Gemini, Anthropic, or OpenRouter — see [Configuration](configuration.md#ai-suggestions)); falls back to truncated prompt if unavailable. |
| F4.9 | **Token/cost tracking** | Track token usage (input, output, cache read/write) and estimated cost per agent session by incrementally parsing transcript JSONL files. Supports Opus, Sonnet, and Haiku pricing tiers. Displayed in finding cards and detail header. |
| F4.10 | **Parent/child task linking** | Tasks can reference a parent task via `parentTaskId`. Child task IDs are tracked on the parent. Enables task hierarchies for complex workflows. |
| F4.11 | **Launch from terminal (`kookr spawn`)** | A CLI subcommand that creates a task from any working directory by POSTing to `/api/tasks`. Uses `$PWD` as the task's cwd; prompt comes from positional argv, piped stdin, or `--prompt-file`. Discovers the running instance via `KOOKR_API_BASE_URL` / `KOOKR_PORT` or by probing 4800/4801 with an ambiguity exit-3 when both respond. Hook-safe mode via `--prompt-file` for prompts containing strings that PreToolUse hooks match on. Active duplicate prompts are controlled with `--dedupe=warn|block|skip`; non-interactive `warn` blocks with exit 5. The deprecated `kookr-spawn` alias remains for compatibility. |

### F5: GUI Layout — Supervisor-First Triage ([Proposal 33](spikes/gui-proposals/33-supervisor-first-triage.html))

The chosen layout is a two-panel "supervisor-first" design. The UI is organized around **what the supervisor found** (findings/anomalies) rather than a flat agent list. This directly reflects Kookr's core product: the supervisor's explanations are the primary content, not the agent list.

```
┌─────────────────────┬──────────────────────────────────────────────┐
│ Supervisor Findings  │ Terminal                                     │
│ (340px)             │ (flex)                                       │
│                     │                                              │
│ [Finding cards      │ [Full-height interactive xterm.js terminal   │
│  with severity,     │  bridged to agent's dtach session]           │
│  explanation,       │                                              │
│  inline quick-reply,│                                              │
│  skip/snooze]       │                                              │
│                     │                                              │
│ Healthy (collapsed) │                                              │
├─────────────────────┼──────────────────────────────────────────────┤
│                     │ [Response input]  [Send & Next] [Skip] [Snooze]│
├─────────────────────┴──────────────────────────────────────────────┤
│ ●● queue dots │ task count │ cost │ Ctrl+Enter: send & next        │
└────────────────────────────────────────────────────────────────────┘
```

| ID | Feature | Description |
|----|---------|-------------|
| F5.1 | **Supervisor findings panel** | Left side (340px): rich finding cards ordered by urgency, each with severity badge, supervisor explanation, inline quick-reply input, and skip/snooze/attach actions. Healthy agents collapsed into a compact section at the bottom. |
| F5.2 | **Terminal panel** | Main area shows an interactive xterm.js terminal bridged to the selected agent's dtach session via `SessionBridge` over a binary WebSocket. The terminal is always visible when an agent is selected. |
| F5.3 | **Status bar** | Bottom: task count, finding count, keyboard shortcut hints. Top bar: queue dots showing triage position, findings/healthy counts. Session cost deferred to V2 (R2.5). |
| F5.4 | **Keyboard shortcuts** | Ctrl+Enter: send & advance. Ctrl+N: next finding. Tab: skip. Ctrl+L: quick launch. |
| F5.5 | **Real-time updates** | All panels update live as agent states change. No manual refresh. |
| F5.6 | **Respond-and-advance loop** | "Send & Next" as primary action. After responding, a confirmation overlay shows what was sent and where the UI is advancing to. Queue dots track triage progress. |
| F5.7 | **"All clear" state** | When no findings exist, the findings panel shows a calm "all agents working autonomously" state. |
| F5.8 | **Do Not Disturb** | Top-bar pill silences toasts, desktop notifications, and the audible chime while leaving anomaly detection running. Optional auto-disable after 15m / 30m / 1h / 2h, or until manually turned off. Findings that arrive while DND is on are tagged with a "while away" badge. Persisted in `localStorage` (`kookr-dnd-enabled`, `kookr-dnd-started-at`, `kookr-dnd-expires-at`). |

### F6: Project-Scoped Playbooks ([ADR-011](adr/011-project-scoped-playbooks.md))

Playbooks are reusable task templates stored as Markdown files in `.kookr/playbooks/` within the project directory. They let developers define recurring workflows (release MRs, design drift checks, test improvement runs) that Kookr can execute as managed agent tasks.

| ID | Feature | Description |
|----|---------|-------------|
| F6.1 | **Playbook discovery** | Automatically discover playbooks from `.kookr/playbooks/*.md` in any project CWD. |
| F6.2 | **Playbook browser** | Browse available playbooks in a tabbed Launch Dialog (Manual \| Playbooks). Shows name, description, and parameter count. |
| F6.3 | **Parameterized launch** | Fill in playbook parameters before triggering. Parameters use `{{paramName}}` interpolation in the playbook body. Required parameters are validated. |
| F6.4 | **Checklist as criteria** | Playbook checklist items become the task's completion criteria. |
| F6.5 | **Playbook badge** | Tasks launched from playbooks show a "Playbook" badge in the detail header. |
| F6.6 | **Multi-CWD support** | Playbooks are resolved per-CWD. The browser lets the user select which project's playbooks to browse. |
| F6.7 | **Crash-restart for looped playbooks** | After a Kookr or system crash, relaunching a looped playbook with the same playbook+cwd+parameters is one click: a startup liveness probe auto-fails dtach-master-killed phantoms, and the launch dialog surfaces an inline "Replace it (start fresh) / Open the running loop" prompt for any residual conflict. See `docs/rfc/rfc-ralph-loop-crash-restart-recovery.md`. |

**V1 scope:** Manual trigger only. File-based definitions. No auto-proposal or scheduling.

**V2 (deferred):** Auto-proposal based on trigger conditions. Scheduled triggers. Playbook editor in GUI.

### F7: GitHub PR/Issue Awareness ([ADR-012](adr/012-github-pr-awareness.md))

When supervised agents create PRs or reference GitHub issues, Kookr detects those references, periodically polls their state, and alerts the developer when actionable events occur (new review comments, CI failures, review decisions).

**How it works:** The association between a GitHub PR and a Kookr task is established at detection time. When an agent's `tool_result` event (e.g., output from `gh pr create`) contains a GitHub URL or PR reference, the scanner extracts it and stamps it with the agent's task ID. All subsequent GitHub state changes for that PR are routed back to the originating task via this association.

| ID | Feature | Description |
|----|---------|-------------|
| F7.1 | **Extract GitHub references** | Scan agent `tool_result` hook events for GitHub PR/issue references using regex patterns (full URLs, `PR #N`, `issue #N`). References are stored per task. |
| F7.2 | **Periodic GitHub polling** | For each known reference, periodically fetch current state via `gh` CLI: PR status, review threads, CI checks, comment count. Default interval: 1 minute. |
| F7.3 | **Detect actionable changes** | Diff fetched state against previous snapshot. Detect: new unresolved review threads, CI check failures, "changes requested" reviews, PR merged/closed, new comments. |
| F7.4 | **Route GitHub alerts** | Actionable changes trigger attention alerts routed through the existing attention queue. Severity: `changes_requested`/`ci_failed` → warning, `new_comments`/`pr_merged` → info. |
| F7.5 | **GitHub tab in dashboard** | "GitHub" tab in the detail panel (alongside Terminal) showing PR cards with status badges, unresolved review threads, CI summary. Shown only when GitHub references are detected for the selected agent's task. |

**V1 scope:** Regex-based reference extraction. Periodic `gh` CLI polling. Graceful degradation when `gh` is unavailable.

**V2 (deferred):** Haiku LLM-assisted extraction for indirect references. GitHub webhook support for real-time updates. PR diff summaries. Suggested actions.

### F8: Session Reflection ([ADR-010](adr/010-session-reflection-workflow.md))

After a supervision session, Kookr can analyze its own interaction data to identify friction patterns and suggest workflow improvements.

| ID | Feature | Description |
|----|---------|-------------|
| F8.1 | **Interaction event log** | Append-only JSONL log capturing developer actions: inputs sent, findings skipped/snoozed, agents selected, agents launched/stopped. Stored in `~/.kookr/sessions/`. |
| F8.2 | **Friction pattern detection** | Rule-based analysis of the interaction log detecting: repeated inputs, interventions without findings, rapid skip cycles, question-shaped inputs, long resolution times, always-skipped anomaly types. |
| F8.3 | **Reflection report** | Triggered via "Reflect" button or `GET /api/reflect`. Produces a structured report with friction findings, categories, evidence, and suggested fixes. |
| F8.4 | **Live friction calibration diagnostics** | During a session, summarize skips, snoozes, false-positive feedback, and direct interventions without findings as diagnostics-only attention-routing calibration signals. These signals are visible in diagnostics but do not reorder, suppress, or down-rank findings until a later explicit policy change. |

**V1 scope:** Rule-based friction analysis (Phase 1 of ADR-010). No LLM summarization yet.

**V2 (deferred):** LLM-powered summarization for contextual improvement suggestions. Cross-session pattern detection.

### F9: Findings feedback

The original F9 section ("Agent Autonomy & Auto-Proceed") was removed on
2026-05-12 — see docs/cleanup/2026-05-12-autonomy-removal-audit.md. The
findings-feedback sub-item survives because it is independent of the
autonomy feature. F9 is preserved as a numbered slot to avoid renumbering
F10-F15.

| ID | Feature | Description |
|----|---------|-------------|
| F9.1 | **Findings feedback loop** | Developers can mark a finding as a false positive via `findingFeedback`; the monitor records the verdict and suppresses similar future anomalies per session. |

### F10: Resilience — Circuit Breakers

External dependencies (LLM providers, `gh` CLI) can fail. Kookr wraps them in generic circuit breakers so individual failures don't cascade into a global outage.

| ID | Feature | Description |
|----|---------|-------------|
| F10.1 | **Core breaker** | `circuit-breaker.ts` implements a CLOSED → OPEN → HALF_OPEN state machine with configurable thresholds and cooldown. |
| F10.2 | **Wrapped dependencies** | `circuit-breaker-llm-client.ts` and `circuit-breaker-github-fetcher.ts` wrap each outbound integration. |
| F10.3 | **Status broadcast** | The server periodically publishes `circuitBreakerStatus` with all current snapshots; `CircuitBreakerPanel.tsx` renders them. |
| F10.4 | **Manual rearm** | Developers can force a breaker back to HALF_OPEN via the `rearmCircuitBreaker` WS message. |

### F11: Scheduled Tasks

Kookr supports cron-scheduled recurring tasks for maintenance playbooks, periodic reviews, or any workflow that should run on a timer.

| ID | Feature | Description |
|----|---------|-------------|
| F11.1 | **Cron expressions** | `cron.ts` parses standard 5/6-field cron expressions and computes next-run times using `cron-parser`. |
| F11.2 | **Schedule store** | `schedule-service.ts` persists schedules; `schedule-validator.ts` validates them on create/update. |
| F11.3 | **Runner** | `schedule-runner.ts` fires due schedules, spawning a task via the regular launch pipeline. |
| F11.4 | **UI** | `SchedulesDialog.tsx` + `ScheduleSection.tsx` provide CRUD; the server broadcasts `schedules` on change and `scheduleFired` on each firing. |
| F11.5 | **Execution ledger** | Schedule responses include a durable per-schedule execution ledger for recent operator-visible run, skip, and catch-up decisions. |

### F12: Contribution Workspace & Worktree Cleanup

For OSS contribution workflows, Kookr manages a shared contribution workspace where agents operate in dedicated git worktrees, with safe-cleanup heuristics for retired branches.

| ID | Feature | Description |
|----|---------|-------------|
| F12.1 | **Worktree lease** | `worktree-lease-service.ts` leases each worktree to exactly one agent at a time; `worktree-protection.ts` guards against concurrent writes. |
| F12.2 | **Repo policy resolver** | `repo-policy-resolver.ts` loads per-repo contribution / style rules and surfaces them to the agent and UI. |
| F12.3 | **Workspace cleanup view** | `ContributionWorkspace.tsx` surfaces worktree cleanup candidates per project. (Tasks launch via `LaunchTaskDialog` / Ctrl+K.) |
| F12.4 | **Safe cleanup** | `workspace-cleanup-policy.ts` classifies each worktree (safe / risky / blocked). `CleanupCandidateTable.tsx` drives individual and bulk `workspace:cleanupCandidate` actions; `workspace:bulkSafeCleanup` performs one-click batch cleanup. |
| F12.5 | **Cleanup diagnostics** | `workspace:runCleanupDiagnostic` launches an agent-powered diagnostic when automated classification is inconclusive. |
| F12.6 | **Attempt history** | `workspace-attempt-repository.ts` tracks prior attempts per worktree so repeated failures don't silently restart. |

### F13: Achievements

Kookr tracks milestones (first PR merged, streaks, uptime) to gently reinforce good workflow habits.

| ID | Feature | Description |
|----|---------|-------------|
| F13.1 | **Catalog** | `achievement-catalog.ts` defines achievements, their unlock conditions, and display metadata. |
| F13.2 | **Unlock detection** | `achievement-watcher.ts` listens to task and contribution events and persists unlocks to disk. |
| F13.3 | **Toast + panel** | `AchievementToast.tsx` announces unlocks; `AchievementsPanel.tsx` lists earned and upcoming achievements. |
| F13.4 | **Reset / disable** | `achievement:reset` + `achievement:setEnabled` let the developer clear progress or opt out entirely. |

### F14: Claude API Quota

Kookr surfaces Claude API usage against Anthropic's 5-hour and 7-day windows so developers notice before they hit the ceiling.

| ID | Feature | Description |
|----|---------|-------------|
| F14.1 | **Quota poller** | `quota-adapter.ts` authenticates via OAuth and polls the usage endpoint, exposing a `QuotaStatus` snapshot. |
| F14.2 | **Status broadcast** | The server sends `quotaStatus` on connect and on change; the TopBar renders the remaining budget. |

### F15: Self-Diagnostics

For field debugging, Kookr can run a self-diagnostic pass (disk, memory, hook pipeline, dtach backend, LLM connectivity) and return a structured report.

| ID | Feature | Description |
|----|---------|-------------|
| F15.1 | **Diagnostic runner** | `self-diagnostic.ts` + `diagnostic-runner.ts` execute checks and build a `DiagnosticReport`. |
| F15.2 | **On-demand HTTP surface** | `routes/diagnostics-routes.ts` exposes `/api/diagnostic` for cached status and `/api/diagnostic/run` for manual diagnostic runs. |
| F15.3 | **Detection stats panel** | `DetectionStatsPanel.tsx` renders anomaly-detection stats and recent health signals. |

### F-Settings: Settings UI

Previously marked as deferred; now shipped in V1.

| ID | Feature | Description |
|----|---------|-------------|
| FS.1 | **Settings dialog** | `SettingsDialog.tsx` is the in-app configuration surface for user and project settings. |
| FS.2 | **Settings store** | `settings-store.ts` persists preferences; `settings-side-effects.ts` applies changes at runtime. |
| FS.3 | **HTTP surface** | `routes/settings-routes.ts` exposes CRUD endpoints for programmatic access. |
| FS.4 | **Project config** | The `setProjectConfig` WS message updates per-project settings (contribution policy, agent defaults). |

---

## What Kookr Does NOT Do (explicit non-goals)

| Non-goal | Reason |
|----------|--------|
| **Replace AI coding agents** | Kookr monitors them, doesn't compete with them |
| **Execute code** | Agents do the coding. Kookr routes developer attention |
| **Be a general-purpose AI** | The supervisor agent only watches and explains; it doesn't write code |
| **Manage git, PRs, or issues** | Agents create PRs and manage git. Kookr *monitors* PRs agents create (F7) but doesn't create or modify them |
| **Work as a team tool** | V1 is for a single developer managing their own agents |
| **Run in the cloud** | V1 runs locally. Cloud is a future possibility |
| **Plugin marketplace** | No plugins in V1. Extensibility comes later if needed |

---

## Agent Support Model

### V1: Managed Terminal Sessions

V1 supports agents **launched by Kookr** in managed terminal sessions ([ADR-007](adr/007-managed-terminal-sessions.md), [ADR-014](adr/014-local-dtach-backend.md)). Two agent types are supported: **Claude Code** (primary) and **Codex CLI** (via a forked binary — see [PoC 003](poc/003-codex-compatibility-gaps.md)). Agents run in **interactive mode** (their native execution mode) inside a dtach-backed session owned by `LocalDtachBackend`:
- **Monitoring:** Hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `Notification`, `UserPromptSubmit`, `SessionEnd`, …) are written as JSONL into `~/.kookr/hooks/<session-id>.jsonl` and tailed by the supervisor for anomaly detection. Hooks are configured per agent via the `--settings` flag; they are additive to user hooks. `backend.captureBytes` provides ring-buffer snapshots for the GUI display only. Transcript JSONL tailing is implemented (`transcript-parser.ts`) but not yet wired — it is a V2 enhancement. No ANSI terminal output parsing is needed. See [PoC 001](poc/001-hook-mechanism-validation.md).
- **Input delivery:** responses sent as byte-level writes (`backend.write` / `backend.writeSequence`) to the agent's dtach session. Same effect as the developer typing directly.
- **Crash recovery:** managed dtach sessions survive Kookr crashes. The developer can reattach or restart Kookr without losing agent sessions.
- **Direct access:** the developer can attach to any agent's dtach session at any time, even outside Kookr (F4.6).
- **Agent dispatch:** `routing-agent-adapter.ts` dispatches per-session to the correct concrete adapter (`claude-code-adapter.ts` or `codex-cli-adapter.ts`) based on `task.agentType`.

This approach supersedes the headless mode design from [ADR-004](adr/004-agent-communication-protocol.md). Agent discovery via `~/.claude/sessions/` remains deferred — see [ADR-005](adr/005-discovered-agent-degradation.md) for the tiered degradation strategy.

---

## MVP Scope (V1)

**Must have:**
- F1.2: Show agent status for Kookr-managed agents (terminal output monitoring)
- F2.1: Detect "needs input" state (managed agents)
- F2.8: Prioritize which agent needs you most
- F3.1: View blocked agent's context
- F3.2: Respond to agent via byte-level writes to the dtach session
- F3.3: Auto-advance after response
- F3.6: Skip agent (deprioritize to back of queue)
- F3.7: Snooze agent (pause monitoring for a duration)
- F4.1: Launch new agent from GUI (managed terminal session)
- F4.4: Store task descriptions locally with full task lifecycle (Open, InProgress, Completed, Cancelled)
- F5.1: Agent list panel (managed agents only in V1)
- F5.2: Terminal panel with input box
- F5.5: Real-time updates

**Nice to have for V1:**
- F1.3: Show current activity (tool calls, files modified)
- F2.2: Detect "stuck" state (deferred to V2 AI supervisor; deterministic detection removed)
- F2.4: Detect permission blocks (detectable via hooks + transcript JSONL)
- F2.9: Browser notifications
- F3.8: Quick action buttons
- F3.9: AI response suggestions
- F4.2: Stop agent from GUI
- F4.5: Optional completion criteria (stored, not auto-evaluated)
- F4.6: Attach to agent terminal (open managed terminal session directly)
- F4.8: AI task naming
- F4.9: Token/cost tracking
- F5.4: Keyboard shortcuts
- F7.1: Extract GitHub references from agent tool_result events
- F7.2: Periodic GitHub polling for PR/issue state via `gh` CLI
- F7.3: Detect actionable changes (new comments, CI failures, review decisions)
- F7.4: Route GitHub alerts through attention queue
- F7.5: GitHub tab in dashboard showing PR context
- F8.1-F8.3: Session reflection (interaction log, friction analysis, reflection report)

**Shipped after the original V1 cut:**
- F9 Findings feedback (false positives)
- F10 Circuit breakers for LLM, GitHub, and terminal
- F11 Scheduled tasks (cron)
- F12 Contribution workspace + worktree cleanup
- F13 Achievements
- F14 Claude API quota tracking
- F15 Self-diagnostics
- F-Settings Settings UI (was previously marked deferred)
- Codex CLI adapter (was previously marked deferred) — with caveats tracked in [PoC 003](poc/003-codex-compatibility-gaps.md)

**Explicitly deferred:**
- F1.1: Agent discovery via session files (managed agents are launched by Kookr, so discovery adds no value without "take over" support for externally-started agents)
- Gemini CLI support
- "Take over" discovered agents (resume under Kookr's control)
- Task inference for discovered agents (reading conversation beginnings)
- Any plugin/extension system
- Session history and analytics persistence (beyond the inline session metadata in `tasks.json`)
- Windows support

---

## Platform Support

| Platform | V1 Status |
|----------|-----------|
| **Linux** | Required |
| **macOS** | Required |
| **Windows** | Deferred — may work under WSL but not explicitly supported |

---

## Resolved Technical Questions

| Question | Answer | Source |
|----------|--------|--------|
| Can we discover running Claude Code processes? | **Yes.** Read `~/.claude/sessions/{pid}.json`, verify PID alive. (Deferred from V1 — Kookr manages its own agents.) | Research / ADR-004 |
| Can we inject input into a running interactive session? | **Yes, via managed dtach sessions.** Byte-level writes to the dtach socket deliver keystrokes to the agent — same as the developer typing. | ADR-007 / ADR-014 |
| How do we send input to agents? | **Byte-level writes** to the agent's dtach session via `backend.write` / `backend.writeSequence`. Supersedes the `--resume` approach from ADR-004 and the `tmux send-keys` path from earlier ADR-007. | ADR-007 / ADR-014 |
| Is JSONL streaming required for monitoring? | **No, but transcript JSONL is used.** Claude Code interactive mode provides **hooks** (real-time JSON events) and **transcript JSONL files** (full session history). These structured sources are tailed for monitoring — no ANSI terminal output parsing needed. `backend.captureBytes` is used only for GUI display. | PoC / ADR-007 |
| Does Codex CLI support similar patterns? | **Yes.** `codex exec --json` for JSONL, `codex exec resume <threadId>` for follow-ups. Sessions stored in `~/.codex/sessions/`. (Codex CLI support deferred from V1.) | Research / ADR-004 |
