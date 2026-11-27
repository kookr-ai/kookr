# Features & Functionality

This document defines **what Kookr must do** from the user's perspective. No technical implementation details — just the problems it solves and the interactions it enables.

---

## Workstation responsiveness

Local agent workloads must leave room for the developer's desktop and Kookr's
supervisor. Linux operators can allocate the same subset of CPUs to all newly
launched agents and their child processes. This is an aggregate allocation,
not a fresh CPU allowance for each agent. Other platforms retain their existing
launch behavior when this optional setting is unset.

Terminal monitoring must preserve prompt classification and meaningful activity
detection while avoiding duplicate screen reconstruction within a watchdog check.

---

## Core User Journey

```
Developer runs several AI coding agents
  ↓
Developer runs `npx kookr` → server prints the local dashboard URL and opens it in the browser
  ↓
Kookr's supervisor agent watches all agents' output
  ↓
Agent #3 repeats the same failing command without changing approach
  → Supervisor detects the anomaly
  → Generates explanation: "Agent #3 is repeatedly hitting
     TypeError in auth.ts without changing strategy..."
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
| F1.1 | **Auto-discover running agents** | Deferred for externally-started agents. Current V1 tracks Kookr-launched Claude Code, Codex CLI, and Grok Build sessions; discovery/takeover of existing Claude, Codex, Grok, or Gemini processes remains future work. |
| F1.2 | **Show agent status** | For each agent: running, waiting for input, errored, completed. Updated in real time. |
| F1.3 | **Show what each agent is doing** | Display the agent's current activity: what file it's reading, what tool it's using, what it last said. Tool calls and activity are available via hooks (real-time) and transcript JSONL (history). |
| F1.4 | **Show agent metadata** | Agent type, working directory, how long it's been running, session cost (if available), and a compact dollars-per-hour rate once the session is older than two minutes. |
| F1.5 | **Detect new and exited agents** | When a managed Kookr agent starts, stops, exits, or is reconciled after restart, update the list automatically. |

### F2: Smart Anomaly Detection (Supervisor Agent)

Kookr's supervisor is an AI that watches agent streams and **understands** what they're doing — not just whether they're "running" or "idle."

| ID | Feature | Description |
|----|---------|-------------|
| F2.1 | **Detect "needs input" state** | Agent is waiting for the developer. Detected via (1) the `Stop` hook (fires when the agent finishes its turn — severity: info) or (2) the `AskUserQuestion` tool call (agent explicitly asks for input — severity: warning). `Stop` payload includes `last_assistant_message` for supervisor context. See [PoC 001](poc/001-hook-mechanism-validation.md). |
| F2.2 | **Detect stuck loops** | Agent is repeating the same action (e.g., running a test, editing a file) N times without meaningful change. **V1 status:** Deferred to V2 AI supervisor. Deterministic detection produces too many false positives (e.g., reading 20 files is normal exploration). The `stuck_loop` type was removed from the codebase — V2 will re-introduce it with semantic analysis. |
| F2.3 | **Detect repeated errors** | Agent keeps hitting the same error and isn't changing its approach. |
| F2.4 | **Detect permission blocks** | Agent is blocked on a tool permission prompt and can't proceed. Detected via the `PermissionRequest` hook, which fires before the permission dialog appears. Payload includes `tool_name`, `tool_input`, and `permission_suggestions`. See [PoC 001](poc/001-hook-mechanism-validation.md) and [ADR-006 revisit](adr/006-permission-mode-feasibility.md#revisit-interactive-mode-2026-03-24). |
| F2.5 | **Detect budget burn** | V1 emits reactive `budget_exceeded` findings when observed task cost crosses configured warning/critical thresholds. Projects may override the global warning threshold (including disabling it with `0`) from project settings. Kookr also records diagnostics-only progress-aware budget-burn samples for replay/precision analysis. User-facing progress-aware "cost climbing with no progress" findings remain a V2 semantic-supervisor feature. |
| F2.6 | **Detect trajectory drift** | Agent was supposed to fix a bug but started refactoring something unrelated. (V2 — requires LLM) |
| F2.7 | **Explain the problem** | For each anomaly, generate a human-readable explanation: what the agent did, what went wrong, and what the developer should consider doing. |
| F2.8 | **Prioritize by urgency** | V1 priority is severity-first: critical findings before warnings before info. Examples include critical `budget_exceeded` before warning findings, and AskUserQuestion `needs_input` (warning) before Stop-derived `needs_input` (info). Progress-aware budget burn, stuck-loop, and trajectory-drift detection remain V2 semantic-supervisor work. |
| F2.9 | **Notify when attention is needed** | Visual alert in the UI + optional browser notification with the explanation summary. |
| F2.10 | **Audit finding evidence** | Capture bounded evidence snapshots over time for surfaced supervisor findings so operators can review false positives and timing-sensitive alerts without reconstructing behavior from source code. |
| F2.11 | **Persist finding review diagnostics** | Store manual finding-evidence review outcomes and invalid model attempts in an append-only diagnostics log that is separate from runtime task state. |
| F2.12 | **Report detector proposal candidates** | Group repeated finding-review outcomes by detector target and version into advisory diagnostics reports with evidence hashes, review populations, and plain-text model rationale excerpts; reports never mutate detector behavior automatically. |

**Implementation approach:** V1 detection patterns are implemented as pure functions in `anomaly-detector.ts`, co-located with their tests for simplicity. The SKILL.md approach (community-contributable, discoverable patterns) remains a valid V2 direction. V2 can also add LLM-powered analysis for nuanced detection (trajectory drift, strategic dead ends).

**Reference:** The [Findings Reference](reference/findings.md) catalogs every anomaly type with its trigger, recommended response, and suppression/tuning knobs. A drift-guard test keeps it in sync with the `AnomalyType` union.

### F3: The "Loop" — Respond & Advance

| ID | Feature | Description |
|----|---------|-------------|
| F3.1 | **View blocked agent's context** | When navigating to a blocked agent, show what it's asking and relevant conversation history. The activity transcript can be filtered to All / You / Agent / Tools (exclusive chips, last choice persisted in `localStorage`). |
| F3.2 | **Respond to agent** | Type a response in Kookr's UI and have it delivered to the agent's managed dtach session via byte-level writes (`backend.write` / `backend.writeSequence`). Same effect as the developer typing directly in the terminal. See [ADR-007](adr/007-managed-terminal-sessions.md) and [ADR-014](adr/014-local-dtach-backend.md). |
| F3.3 | **Auto-advance after response** | After sending a response, automatically navigate to the next agent that needs attention. |
| F3.4 | **"All clear" state** | When no agents need attention, show a clear "all agents working autonomously" state. |
| F3.5 | **Manual navigation** | Allow the developer to manually select any agent from the list, not just the next bottleneck. |
| F3.6 | **Skip agent** | Deprioritize an agent to the back of the queue. Supervisor keeps monitoring — if the agent's state changes (new anomaly, completion), it re-enters the active queue. |
| F3.7 | **Snooze agent** | Pause monitoring for a chosen duration (+ optional reason). Supervisor stops polling. On timer expiry, supervisor re-evaluates and re-queues if anomaly persists. |
| F3.8 | **Quick action buttons** | When an agent stops and its last message contains a recognizable binary or multiple-choice question, Kookr presents clickable quick-action buttons (e.g., "Yes"/"No", numbered options) alongside the free-text input in the detail pane, and as compact chips on the finding card. Keyboard shortcuts (1-5) trigger corresponding actions in the detail pane. |
| F3.9 | **AI response suggestions** | When an agent needs input and quick actions are insufficient, Kookr generates 3-5 predicted developer responses through the configured LLM provider. Suggestions appear as clickable buttons above the input box. Requires an LLM provider key (Groq, Gemini, Anthropic, OpenRouter, or explicit Requesty — see [Configuration](configuration.md#ai-suggestions)). |

### F4: Agent Lifecycle

| ID | Feature | Description |
|----|---------|-------------|
| F4.1 | **Launch new agent** | Start a new agent from the GUI with a task description (natural-language prompt) and working directory. The Manual tab offers a few clickable sample prompts that fill the description without launching. It also offers **Recent prompts** recall: a collapsible picker of the operator's recent *manual-launch* prompts (deduped, drawn from the live task store unioned with the durable terminal-task archive, so it survives the 1-day live-store prune and works on a fresh browser), ranked so prompts previously launched against the current working directory surface first. Selecting one refills the description — text only, no submit, no change to cwd/agent/criteria — so a prompt can be repeated on a specific repository without authoring a playbook. The picker is client-side filterable and hides itself when there is no history. Quick Launch reuses the same picker: selecting a row fills the compact prompt field only and leaves working directory, agent, effort, and model pins unchanged. It is read-only server state (no new persistence); recall is unavailable during a task relaunch, which drives the form from the source task. In both the Launch dialog and Quick Launch, working directory can be filled from a copied path that starts with `/` or `~/` via an explicit "Use clipboard path" click; opening either surface does not read the clipboard, and non-path clipboard text is rejected without changing the field. The launch dialog and Quick Launch can optionally pin reasoning effort and model when the selected agent accepts those pins; leaving them on "Agent default" uses the existing server / CLI default. After a successful launch, the last effort and model pins are restored on the next open (and dropped if the current agent does not accept them). If Quick Launch cannot send because the browser is disconnected, it stays open with the full launch draft intact so the user can retry without retyping. The Launch dialog and Quick Launch show shared Grok login guidance and block explicit Grok submissions when authentication would be refused; other runtimes and filtered round-robin launches remain available. When Claude plan usage is already at or above the existing headroom threshold and the pick would consume Claude quota, both surfaces show the same non-blocking quota banner (Enter / Launch still submit). When the chosen working directory already has live agents, the Launch dialog shows an inline warning with the live count and those task names, plus Open existing and Launch anyway — a warning only; submit is not blocked. Prompt-and-directory duplicate matching stays a separate interrupt (F17.4). Admitted launches run in a managed terminal session (interactive mode) for full monitoring and developer access; the F4.12 dependency gate may first preserve the task pending without a session. The command palette (Ctrl/Cmd+K) exposes **Launch task** (manual tab) for the same dialog; searching a project there also surfaces a **Launch task in <project>** action that opens the manual dialog scoped to that project without first selecting it. See [ADR-007](adr/007-managed-terminal-sessions.md). |
| F4.2 | **Stop agent** | Terminate a running agent from the GUI. Stopping kills the dtach session, stops the hook file watcher, and marks the agent as stopped in the monitor to prevent resurrection from late-arriving hook events. |
| F4.3 | **Relaunch agent** | Start another attempt from the same or modified prompt and working directory. User-initiated relaunches create successor tasks for history; crash-recovery and looped-playbook recovery can attach additional sessions to the existing task so attempt history is preserved. |
| F4.4 | **Task lifecycle management** | Tasks are the unit of work; sessions are attempts attached to a task. A task usually has one live managed session, but may retain multiple historical or recovery sessions. Lifecycle: Open/Pending → InProgress → Completed/Cancelled/Terminated, with confirmed dependency degradation creating Pending directly and a failed recovery probe returning a still-non-terminal task to Pending. A concurrent terminal transition wins over stale preflight/probe completion and prevents re-parking or launch. Completing or cancelling a task terminates live sessions. Completing a task opens a cleanup confirmation that names each task-owned worktree and reports whether it can be removed, from the same inspection the cleanup runs; the worktree/branch checkbox defaults from Settings and can be overridden for that task when a worktree is removable, and is disabled with a reason when none is. Tasks and session metadata are persisted locally in JSON. |
| F4.5 | **Optional completion criteria** | When launching an agent, the user can provide a definition of done (e.g., "tests pass", "PR created"). Criteria are stored on the task but not auto-evaluated in V1 — the developer must explicitly mark the task complete. |
| F4.6 | **Attach to agent terminal** | Open an agent's managed dtach session directly from an external terminal when needed. Kookr no longer exposes a GUI button that copies an attach command. See [ADR-007](adr/007-managed-terminal-sessions.md) and [ADR-014](adr/014-local-dtach-backend.md). |
| F4.7 | **Rename task** | Double-click a task name in the findings panel or detail header to edit it inline. The custom name overrides the auto-generated name (truncated prompt) everywhere in the UI. Clearing the name reverts to the default truncated prompt. |
| F4.8 | **AI task naming** | When a task is launched, the configured LLM provider generates a concise 3-8 word name from the prompt (e.g., "Fix JWT Token Invalidation"). Requires an LLM provider key (Groq, Gemini, Anthropic, OpenRouter, or explicit Requesty — see [Configuration](configuration.md#ai-suggestions)); falls back to the first prompt line if unavailable, with prompt openers such as "You are", "Your job is to", "Can you" and "Please" removed. Stored names that came from the prompt are shown with the same openers removed; the full prompt stays in the Activity panel ("Show full prompt") and the row tooltip. |
| F4.9 | **Token/cost tracking** | Track token usage (input, output, cache read/write) and estimate cost per agent session by incrementally parsing transcript JSONL files, pricing each usage bucket against its producing model (exact key or longest-prefix table row). Unknown models use the legacy Sonnet fallback rate and expose `pricingQuality: 'fallback'`; prefix-priced dated ids report `'exact'`. Authoritative legacy totals remain supported. Displayed in finding cards, Healthy rows, and the detail header. When a session has a positive cost and a start time older than two minutes, those surfaces also show a compact `$X.XX/h` rate (total cost ÷ wall-clock hours since start). |
| F4.10 | **Parent/child task linking** | Tasks can reference a parent task via `parentTaskId`. Child task IDs are tracked on the parent. Enables task hierarchies for complex workflows. |
| F4.11 | **Launch from terminal (`kookr spawn`)** | A CLI subcommand that creates a task from any working directory by POSTing to `/api/tasks`. Uses `$PWD` as the task's cwd; prompt comes from positional argv, piped stdin, or `--prompt-file`. Discovers the running instance via `KOOKR_API_BASE_URL` / `KOOKR_PORT` or by probing 4800/4801 with an ambiguity exit-3 when both respond. Hook-safe mode via `--prompt-file` for prompts containing strings that PreToolUse hooks match on. Active duplicate prompts are controlled with `--dedupe=warn|block|skip`; non-interactive `warn` blocks with exit 5. The deprecated `kookr-spawn` alias remains for compatibility. |
| F4.12 | **Dependency-aware launch admission** | Playbooks and API launches may declare required launch dependencies. Confirmed degradation creates one durable pending task without starting a worker; its original prompt, cwd, project, agent/model/effort pins, Ralph wiring, dependencies, and idempotency identity are replayed after recovery. Unknown health remains fail-open only without stronger degraded or half-open evidence. Recovery admits one half-open probe and durably marks its exact session before launch. A failed probe re-parks only after that session is proven stopped; if cleanup rejects in direct launch, promotion, or crash recovery, Kookr retains the exact `probing` marker and busy circuit. Timeout before creation can temporarily retain that exact marker with no session row until the late callback links/reaps it. A concurrent terminal transition wins the work outcome. Successful owner-controlled cleanup settles and clears its marker immediately; unresolved cleanup, creation, or circuit ownership retains the marker until reconciliation settles it, so the marker alone does not assert process liveness and cannot be deleted prematurely. |
| F4.13 | **Blacklist a coding agent** | Settings can blacklist a coding agent (Claude Code, Codex CLI, or Grok Build) so Kookr never spawns it again — dashboard launches, CLI, scheduled tasks, child tasks, round-robin, and migration. Blacklisted agents are hidden from launch pickers and shown struck through in Settings until the operator removes them. Existing in-flight sessions are not auto-killed. |
| F4.14 | **Explain task and conversation times** | Task details distinguish task creation, Kookr session registration, terminal status transition, observed hook activity, and archive time. Transcript messages show provider source timestamps when available. Missing execution-end or operator-close times are stated as unavailable rather than inferred. |

### F5: GUI Layout — Supervisor-First Triage ([Proposal 33](spikes/gui-proposals/33-supervisor-first-triage.html))

The chosen layout is a two-panel "supervisor-first" design. The UI is organized around **what the supervisor found** (findings/anomalies) rather than a flat agent list. This directly reflects Kookr's core product: the supervisor's explanations are the primary content, not the agent list.

```
┌─────────────────────┬──────────────────────────────────────────────┐
│ Tasks (one list)     │ Terminal                                     │
│ (340px)             │ (flex)                                       │
│                     │                                              │
│ [Finding cards      │ [Full-height interactive xterm.js terminal   │
│  with severity,     │  bridged to agent's dtach session]           │
│  explanation,       │                                              │
│  inline quick-reply,│                                              │
│  skip/snooze]       │                                              │
│                     │                                              │
│ Working, Finished   │                                              │
├─────────────────────┼──────────────────────────────────────────────┤
│                     │ [Response input]  [Send & Next] [Skip] [Snooze]│
├─────────────────────┴──────────────────────────────────────────────┤
│ ●● queue dots │ task count │ cost │ Ctrl+Enter: send & next        │
└────────────────────────────────────────────────────────────────────┘
```

| ID | Feature | Description |
|----|---------|-------------|
| F5.1 | **Supervisor findings panel** | Left side (340px): rich finding cards ordered by urgency, each with severity badge, supervisor explanation, a one-line recommended next-action line (from the findings catalog), inline quick-reply input, skip/snooze, and live response chips when the suggestion channel has them (up to five Allow/Deny or Yes/No actions; permission chips without a live request binding are omitted). When the task already has a PR in `githubState`, the card also shows one compact `#N status` chip (with CI-failed or changes-requested cues); clicking it selects the task and opens the GitHub pane. When the finding has a `parentTaskId` that still resolves in the live snapshot, the card's context row also shows a compact `parent: <name>` chip; clicking it selects that parent without opening a new pane. Git branch stays off the card. When the rail mixes types, header chips filter the cards by anomaly type (multi-select OR, persisted in `localStorage`; empty selection shows all). The rail is one scrolling list grouped by state: "Needs you" (one row for each question or permission prompt a task waits on, then the finding cards; the count includes all of them and says so in words when they are mixed, for example "1 question, 1 finding"; pressing a question or permission row opens Lucy's panel on it and answers nothing; one line reading "nothing waiting" only when all three are empty), then Working, Pending, Snoozed and Finished (collapsed by default). Working rows are two lines, with their action buttons shown on hover, keyboard focus or selection. Unselected finding cards hide the recommendation, cost, turn-state line and copy-ID chip, which the selected card shows. |
| F5.2 | **Terminal panel** | The task reading pane shows an interactive xterm.js terminal bridged to the selected agent's dtach session. It is a tab beside Conversation and Changes (and GitHub when the task has references); on windows wider than 1200 px a **Split view** toggle shows the conversation and the terminal side by side, and the choice is remembered. Terminal focus (Alt+T) shows the terminal alone; leaving it returns to the layout it was entered from, Split view included. Fractional wheel scrolling stays local to the terminal. The negotiated stream bounds pending output by acknowledging bytes after parsing; a slow or interrupted view shows an explicit recovery state instead of silently losing continuity. Dropping an image onto the terminal, or pasting one from the clipboard through the terminal's right-click Paste (for example a screenshot; plain Ctrl+V stays the agent's own key), saves it on the Kookr host and pastes the saved file's path into the agent's prompt without submitting it; Claude Code and Codex CLI attach that path as an image. Because only the image bytes cross from the browser, this works when the browser and Kookr are on different filesystems (Chrome on Windows with Kookr in WSL). PNG, JPEG, GIF and WebP up to 10 MB are accepted. See the [terminal validation report](reports/terminal-responsiveness-validation.md) for measured performance and qualification limits. |
| F5.3 | **Status bar** | Bottom: task count, finding count, a completed-task chip when at least one live agent finished in the last 24 hours (e.g. `3 completed / 24h`; hidden at zero; tooltip notes the live-list lower bound; clicking it expands the Completed rail and scrolls it into view), a launched-task chip when at least one live agent started in the last 24 hours (e.g. `3 launched / 24h`; hidden at zero; never inferred from a finish time; tooltip notes the live-list lower bound; clicking it opens Diagnostics containing the Outcome Scoreboard), the oldest live finding wait when at least one finding is active (clicking it selects that unanswered finding), the rolling 24-hour cost chip and plan quota. Everything else sits behind the top-bar **System** indicator (issue #3561 slice 2), which turns amber while a hidden readout is degraded and shows non-urgent states neutrally (a muted-speaker glyph when alert sounds are muted, a grey dot for elevated CPU or RAM; issue #3619): host resources, ops-health pills, sound, achievements, speech-to-text, a time-to-unblock chip when at least five human-reply samples exist in the last 24 hours (visible label is volume plus median, e.g. `12 unblocked (24h) · median 8m`), and — when the live-friction snapshot has signalCount > 0 — a live-friction chip with skip and snooze counts from signals[] (false-positive included only when that kind is present; diagnostics-only; does not reorder findings). Top bar: queue dots showing triage position, findings/healthy counts, cost where available, a neutral **Bypass mode** chip when permission bypass is on, and the System indicator whose detail ends with **About** (build hash and deploy controls). |
| F5.4 | **Keyboard shortcuts** | Ctrl+Enter: send & advance. Alt+N: next finding. Alt+L: quick launch. With the avatar panel on, Alt+Shift+M: hands-free Talk; Alt+Shift+L: Lucy's desk (she takes the whole window) and back. macOS defaults use Cmd+Ctrl instead of Alt. Rebindable in Settings. |
| F5.5 | **Real-time updates** | All panels update live as agent states change. No manual refresh. |
| F5.6 | **Respond-and-advance loop** | "Send & Next" as primary action. After responding, a confirmation overlay shows what was sent and where the UI is advancing to. Queue dots track triage progress. |
| F5.7 | **"All clear" state** | When no findings exist and no question or permission prompt waits, the findings panel shows a calm "all agents working autonomously" state. |
| F5.8 | **Do Not Disturb** | Top-bar pill silences toasts, desktop notifications, and the audible chime while leaving anomaly detection running. Optional auto-disable after 15m / 30m / 1h / 2h, or until manually turned off. Findings that arrive while DND is on are tagged with a "while away" badge. Persisted in `localStorage` (`kookr-dnd-enabled`, `kookr-dnd-started-at`, `kookr-dnd-expires-at`). The command palette (Ctrl/Cmd+K) exposes a **Do Not Disturb** toggle that drives the same manual layer as the pill; its label reflects the current state, and because DND is local-only it stays available to read-only viewers. |
| F5.9 | **Type scale, contrast and state roles** | The dashboard uses five text sizes (12, 13, 14, 16 and 20 px; nothing smaller), three text tiers that each reach at least 4.5:1 contrast on every surface, and four state roles: amber = waiting on you, red = failed or stuck, teal = working or selected, neutral otherwise. Each role also has its own marker shape (dot, diamond, ring, dash) so state never depends on colour alone. Enforced by `src/frontend/design-tokens.test.ts` (#3561). |
| F5.10 | **Reading pane header, facts column and decision card** | The selected task's header shows its name over one meta line (state or finding, project, branch, running time, cost, plus bypass, operator-needed, share-approval, blocker and worktree flags). One main action matches the task status (Complete, Mark as done or Relaunch); Reflect, Reopen, Relaunch, Migrate to… and Cancel task… sit in a More actions menu, so Cancel never sits on screen at rest and still asks for confirmation. A facts column (project, directory, branch, agent and hooks, model (the one the transcript reports, with the launch pin or "default" under it), cost, tokens, pull request, relationships, timeline, copy/share links and the full prompt) docks beside the conversation when the pane is at least 760 px wide (about a 1350 px window); otherwise, and in Split view or terminal focus, a Details button opens it over the pane. A finding docks a decision card above the reply box with what the agent is waiting on, its last message, the answer buttons, Skip and Snooze; on the Terminal tab a compact card sits in the reply area instead, with the ask in full and the last message folded behind a disclosure; in terminal focus only the buttons stay. The agent's completion signal (with its note and Dismiss) and an operator-needed notice show as lines under the card's head; without a finding they get a card of their own, titled Agent signal or Operator needed, with no Skip or Snooze. Terminal focus and a completed task's digest show no card, so there they stay as a banner above the tabs. |
| F5.11 | **Changes tab** | Every task's reading pane has a Changes tab listing what the task changed in its worktree, compared with the branch it forked from (the nearest of origin/main, origin/staging, origin/master and its own pull request's base): committed, staged and unstaged edits, plus new files `.gitignore` does not exclude. Each row shows a status letter, the path and the lines added and removed; clicking it opens that file's diff under the row. Git runs only when the tab opens, Refresh is pressed or a file's diff is opened, never on a timer. Clicking an Edit or Write row in the conversation opens that one edit's patch at the top of the tab and marks the file's row; Escape or its close button returns to the tab it came from. Once the worktree is removed, the tab lists the files of the task's own pull request, as GitHub reports them. A task without a directory or a non-git directory, or a removed worktree with no pull request of its own, get a one-line explanation instead. Design note: [rfc-reading-pane-changes-tab](rfc/rfc-reading-pane-changes-tab.md); API: `GET /api/tasks/:id/changes`. |
| F5.12 | **Machine and fleet vitals** | The System detail (top bar) opens with a vitals block: one line that says whether the machine is comfortable or what is under pressure, meters for CPU, memory, GPU load and video memory, how many agents and subagents are running, and tokens generated, tokens read and tool calls per minute, each with a five-minute trend line. A "Pin to top bar" switch (off by default) adds a small strip of the same readings beside the System indicator; it is neutral at rest, names the resource in trouble under pressure, and sheds cells to fit a narrow window. GPU readings need an NVIDIA GPU with `nvidia-smi`; without one the GPU parts are absent. Token rates are lower bounds (shown with ≥): Grok Build and OpenCode agents report tokens only when they stop. Nothing is stored. Design note: [rfc-system-resource-visibility](rfc/rfc-system-resource-visibility.md), section "V2: fleet vitals". |

### F6: Playbooks ([ADR-011](adr/011-project-scoped-playbooks.md))

Playbooks are reusable task templates stored as Markdown files in project, user, or bundled plugin locations. They let developers define recurring workflows (release MRs, design drift checks, test improvement runs) that Kookr can execute as managed agent tasks.

| ID | Feature | Description |
|----|---------|-------------|
| F6.1 | **Playbook discovery** | Automatically discover playbooks from `.kookr/playbooks/*.md` in any project CWD, `~/.kookr/playbooks/*.md` for user playbooks, and bundled plugin playbooks. Project playbooks take precedence over user playbooks, which take precedence over plugin playbooks. |
| F6.2 | **Playbook browser** | Browse available playbooks in a tabbed Launch Dialog (Manual \| Playbooks). Shows name, description, and parameter count. A search box filters the list: every word typed must appear, in any order, in the playbook's name, description, tags, file name or instructions; playbooks whose name, description, tags and file name contain every word are listed before those that need their instructions to match. Project playbooks are read from the project checkout on disk; when that checkout lacks playbooks that are on the remote default branch (for example, it is parked on an old branch), an amber notice above the search names them and the checkout's branch. The check reads the last-fetched remote ref and never fetches, so it never slows the list. The command palette (Ctrl/Cmd+K) exposes **Browse playbooks**, which opens the same dialog on the Playbooks tab. The empty OSS contribution dashboard offers the same control plus a link to OSS tracking setup. |
| F6.3 | **Parameterized launch** | Fill in playbook parameters before triggering. Parameters use `{{paramName}}` interpolation in the playbook body. Required parameters are validated. |
| F6.4 | **Checklist as criteria** | Playbook checklist items become the task's completion criteria. |
| F6.5 | **Playbook badge** | Tasks launched from playbooks show a "Playbook" badge in the detail header. |
| F6.6 | **Multi-CWD support** | Playbooks are resolved per-CWD. The browser lets the user select which project's playbooks to browse. |
| F6.7 | **Crash-restart for looped playbooks** | After a Kookr or system crash, relaunching a looped playbook with the same playbook+cwd+parameters is one click: a startup liveness probe auto-fails dtach-master-killed phantoms, and the launch dialog surfaces an inline "Replace it (start fresh) / Open the running loop" prompt for any residual conflict. See `docs/rfc/rfc-ralph-loop-crash-restart-recovery.md`. |
| F6.8 | **Playbook chains** | Launch any playbook to repeat for N iterations, H hours, or both (Playbooks tab **Repeat** row, `kookr chain start`, `POST /api/playbook-chains`). Kookr launches each next iteration itself when the current task ends, so the chain never depends on the agent remembering to spawn a successor. Each iteration is a normal task linked to the previous one; an iteration that idles without closing its task is closed after 5 minutes. Tasks show a chain badge with position and remaining time, and a **Stop chain** button ends the chain after the current iteration. See [playbook-chains.md](reference/playbook-chains.md) and `docs/rfc/rfc-playbook-chains.md`. |

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
| F7.5 | **Pull request tab in dashboard** | The reading pane's "Pull request" tab (was "GitHub (n)", #4024) shows the task's own pull request first as a card: status badge, checks, review decision, unresolved review threads and `branch → base`. Every other PR and issue the task mentioned is listed under "Mentioned". A task that opened no PR gets a "Mentioned (n)" tab with only that list. A PR is the task's own when it is not cited in the prompt and is on the task's branch, or, with no PR on that branch, was opened after the task was created. Shown only when GitHub references are detected for the selected agent's task. |

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

External dependencies (LLM providers, `gh` CLI, remote alert callbacks, STT/TTS speech services) can fail. Kookr wraps them in generic circuit breakers so individual failures don't cascade into a global outage. See the [circuit breaker operator reference](reference/circuit-breakers.md) for thresholds, dashboard behavior, API shape, and manual rearm guidance.

| ID | Feature | Description |
|----|---------|-------------|
| F10.1 | **Core breaker** | `circuit-breaker.ts` implements a CLOSED → OPEN → HALF_OPEN state machine with configurable thresholds and cooldown. |
| F10.2 | **Wrapped dependencies** | `circuit-breaker-llm-client.ts`, `circuit-breaker-github-fetcher.ts`, `circuit-breaker-tts-client.ts`, and `circuit-breaker-stt-client.ts` wrap each outbound integration. TTS open degrades by skipping fresh synthesis (cached speech still serves); STT open degrades health probes to unavailable. |
| F10.3 | **Status broadcast** | The server publishes `circuitBreakerStatus` with all current snapshots on WebSocket connect and breaker state changes; `CircuitBreakerPanel.tsx` renders them. |
| F10.4 | **Manual rearm** | Developers can close a non-closed breaker via the dashboard or the `rearmCircuitBreaker` WS message. |
| F10.5 | **Launch dependency admission circuit** | Required launch dependencies use a separate `healthy | unknown | degraded | half_open` admission circuit. A degraded circuit parks new work without consuming capacity; clean recovery evidence moves it to `half_open`, and one bounded probe returns it to `healthy`. Collection timeout/unknown evidence never erases confirmed degradation and never creates a new fleet-wide pause by itself. |

### F11: Scheduled Tasks

Kookr supports cron-scheduled recurring tasks for maintenance playbooks, periodic reviews, or any workflow that should run on a timer.

| ID | Feature | Description |
|----|---------|-------------|
| F11.1 | **Cron expressions** | `cron.ts` parses standard 5/6-field cron expressions and computes next-run times using `cron-parser`. |
| F11.2 | **Schedule store** | `schedule-service.ts` persists schedules; `schedule-validator.ts` validates them on create/update. |
| F11.3 | **Runner** | `schedule-runner.ts` fires due schedules. If the playbook declares `probe` (or matches a well-known deploy-convergence path), the scheduler execs that command first; non-escalate exits complete the fire with no task. Otherwise it inspects a project-tier playbook's cwd checkout against its upstream tracking ref (issue #2945): a current checkout is unchanged; a lag prepends a briefing warning and records `playbookSource` on the fire receipt; `failOnPlaybookDrift: true` records `skipped_playbook_drift` and does not launch. Then it spawns a task via the regular launch pipeline. |
| F11.4 | **UI** | `SchedulesDialog.tsx` + `ScheduleSection.tsx` provide CRUD. The no-selection overview shows the soonest next run (or paused/exhausted) and opens the dialog. The server broadcasts `schedules` on change and `scheduleFired` on each firing. |
| F11.5 | **Execution ledger** | Schedule responses include a durable per-schedule execution ledger for recent operator-visible run, skip, missed-startup, and catch-up decisions. |
| F11.6 | **Automatic startup catch-up** | A schedule that missed its window while the process was down performs exactly one `catch_up`-tagged run per boot on restart by default (lease-gated behind the relaunch arbiter so it cannot duplicate a concurrent actuator). Set `KOOKR_MANUAL_CATCHUP` to record missed runs for manual Run Now recovery instead, or `KOOKR_NO_CATCHUP` to suppress catch-up entirely. |
| F11.7 | **Schedule ROI glance** | The Schedules dialog joins `GET /api/schedules/rollups` once on open and shows fire count, recorded closeout snapshot spend, and artifact count per card that has retained fires. Never-run and missing rows omit the line. Unmeasured fires never render as $0. The last-execution line and last-three ledger rows stay the drill-down. Cost attribution follows the [per-schedule ROI guidance](reference/schedule-roi.md), which keeps the closeout snapshot separate from budget-burn peaks and child-task usage. |
| F11.8 | **Bounded recovery re-arm retry** | If persistence rejects a boot-time enable of an allowlisted recovery-critical schedule, Kookr retries only that schedule on later post-recovery ticks. Retries stop after a bounded attempt count or immediately when current schedule state shows removal, an operator hold, allowlist loss, or trigger exhaustion. |
| F11.9 | **Schedule an exact task configuration** | **Schedule this playbook** preserves the source task's working directory, parameter values, and playbook resource identity (path, scope, source directory, and content digest). If that exact resource is unavailable or modified, or the legacy task lacks its identity, the form requires the developer to select a replacement instead of silently using the current catalog winner or its defaults. |

### F12: Contribution Workspace & Worktree Cleanup

For OSS contribution workflows, Kookr manages a shared contribution workspace where agents operate in dedicated git worktrees, with safe-cleanup heuristics for retired branches.

| ID | Feature | Description |
|----|---------|-------------|
| F12.1 | **Worktree lease** | `worktree-lease-service.ts` leases each worktree to exactly one agent at a time; `worktree-protection.ts` guards against concurrent writes. |
| F12.2 | **Repo policy resolver** | `repo-policy-resolver.ts` loads per-repo contribution / style rules and surfaces them to the agent and UI. |
| F12.3 | **Workspace cleanup view** | `ContributionWorkspace.tsx` surfaces worktree cleanup candidates per project. (Tasks launch via `LaunchTaskDialog` / Ctrl+K.) |
| F12.4 | **Safe cleanup** | `workspace-cleanup-policy.ts` classifies each worktree (safe / risky / blocked). Cleanup hard-guards the primary checkout, unregistered paths, and protected branches; `CleanupCandidateTable.tsx` drives individual and bulk `workspace:cleanupCandidate` actions; `workspace:bulkSafeCleanup` performs one-click batch cleanup. |
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
| F14.1 | **Quota poller** | `quota-adapter.ts` authenticates via OAuth and polls the usage endpoint, exposing a `QuotaStatus` snapshot plus a secret-free `quotaPoller` liveness block on `GET /api/health` (`state`, `lastError`, `currentIntervalMs`, `consecutiveFailures`; issue #3312). |
| F14.2 | **Status broadcast** | The server sends `quotaStatus` on connect and on change; the TopBar renders the remaining budget. |

### F15: Self-Diagnostics

For field debugging, Kookr can run a self-diagnostic pass (disk, memory, hook pipeline, dtach backend, LLM connectivity) and return a structured report.

| ID | Feature | Description |
|----|---------|-------------|
| F15.1 | **Diagnostic runner** | `self-diagnostic.ts` + `diagnostic-runner.ts` execute checks and build a `DiagnosticReport`. |
| F15.2 | **On-demand HTTP surface** | `routes/diagnostics-routes.ts` exposes `/api/diagnostic` for cached status, `/api/diagnostic/run` for manual diagnostic runs, and `/api/diagnostics/session-health` for versioned cross-signal session diagnostics. |
| F15.3 | **Detection and session health diagnostics** | `DetectionStatsPanel.tsx` renders anomaly-detection stats; `SessionHealthPanel.tsx` exposes explainable cross-signal terminal health, attach/browser state, and coordinated-stall context. |

**Ops runbook (unattended):** When Discord is the only channel and live health edges need recovery actions, use the symptom → health field → action map in [Unattended recovery runbook](reference/unattended-recovery-runbook.md) (SAFE MODE, disk-critical admission, hung residual, prod smoke tick artifact, resource watchdog enable). Short host return checklist: [offline recovery card](reference/offline-recovery-card.md).

### F-Settings: Settings UI

Previously marked as deferred; now shipped in V1.

| ID | Feature | Description |
|----|---------|-------------|
| FS.1 | **Settings dialog** | `SettingsDialog.tsx` is the in-app configuration surface for user and project settings. |
| FS.2 | **Settings store** | `settings-store.ts` persists preferences; `settings-side-effects.ts` applies changes at runtime. |
| FS.3 | **HTTP surface** | `routes/settings-routes.ts` exposes CRUD endpoints for programmatic access. |
| FS.4 | **Project config** | The `setProjectConfig` WS message updates per-project settings (contribution policy, agent defaults) with PATCH semantics: omitted keys preserve stored values, while explicit nullable clears remove supported overrides and content. |

### F16: Optional Session Sharing & Relay

Kookr remains local-first, but can expose a task or terminal stream through explicit sharing flows for review and collaboration.

| ID | Feature | Description |
|----|---------|-------------|
| F16.1 | **Task share links** | Create shareable task views from the dashboard. The shared projection is separate from local task ownership. |
| F16.2 | **Hosted relay pairing** | Pair a local Kookr instance with the hosted relay when remote viewing or input is explicitly enabled. |
| F16.3 | **Remote terminal viewing and input grants** | Stream selected terminal sessions through the relay. Remote input is permissioned separately and fails closed when grants or relay connectivity are absent. |
| F16.4 | **Contact-aware sharing** | Remember share contacts and grant metadata so repeated sharing does not require manual link reconstruction. |

### F17: Meta Task Coordinator

The task coordinator adds relationship-aware supervision on top of the main findings queue. It is deterministic and local: it reads live task state, hook activity, task edges, and dedupe metadata, then renders recommendations without asking an LLM to infer intent.

| ID | Feature | Description |
|----|---------|-------------|
| F17.1 | **Coordinator chips** | Per-task chips summarize one coordinator recommendation: declared-edge status, stale coordinator activity, duplicate active prompt clusters, or completed tasks that can be cleared. Chip actions can nudge, compare, acknowledge, or snooze depending on the detector. |
| F17.2 | **Chain strips** | The task detail surface shows compact parent, child, blocks, and blocked-by strips for related tasks. Above 6 related tasks the strip starts collapsed to a summary line plus the chips of unfinished tasks; expanded, it scrolls in a bounded box, and the terminal area keeps at least 45% of the detail column. Prior-task batch completion is guarded by a refreshed chain token, merged-PR verification, post-merge check status, and worktree-health checks. |
| F17.3 | **Declared task edges** | Users can declare and remove `blocks` and `blocked_by` relationships from the task detail panel. The editor supports typeahead over non-terminal tasks and free-text milestones. |
| F17.4 | **Duplicate launch interrupt** | `kookr spawn` detects active duplicate prompts before launch. `--dedupe=warn` prompts interactively and blocks non-interactive launches, `--dedupe=block` always blocks, and `--dedupe=skip` creates an intentional duplicate excluded from duplicate coordinator clusters. The Launch dialog and Quick Launch bar show the same warning before submit, with Open existing / Launch anyway (launch-anyway marks the new task as an intentional duplicate). In Quick Launch, when an independent launch preflight blocks submission, Launch anyway is disabled while Open existing remains available. CLI defaults are unchanged. |
| F17.5 | **Coordinator suppressions** | Users can dismiss coordinator recommendations by detector class and agent type. Suppressions persist locally, last 7 days for the first two dismissals, and widen to 30 days after repeated dismissals. Task-level acknowledgements hide one recommendation for 30 days. |
| F17.6 | **Coordinator findings pane** | Fleet-level coordinator cards group duplicate task clusters and orphan dependency edges. These cards are separate from supervisor anomaly finding cards and open the affected task rather than joining the severity queue. |
| F17.7 | **Cross-agent task migration** | Continue interrupted tasks (terminated / cancelled / interrupted-with-dead-session) under a **different**, user-chosen agent when the original provider is unavailable (e.g. a coding agent's weekly quota is exhausted). Works on a single task, an explicit set, or all tasks of one source agent, launching a linked continuation task in the same checkout with a reconstructed brief (intent + progress digest + working-tree state). The interrupted task is kept as an immutable record linked to its successor, so cost/outcome ledgers stay truthful. Optionally set the target as the new default agent in the same action. Available via `kookr migrate` and in the dashboard (per-task "Migrate to…", and a batch "Migrate interrupted…" dialog in the task rail's More actions menu). |

---

### F18: Delegating analysis jobs to Hermes workers (experimental, off by default)

Kookr can hand a bounded, read-only analysis job to a sandboxed Hermes worker and collect a structured result, so cheaper models can take over work like issue triage while Kookr stays in charge (RFC `rfc-kookr-hermes-delegation`). Slice 1a ships the HTTP API only; the CLI and the playbook hook come later. It does nothing unless `KOOKR_HERMES_DELEGATION=1` and a valid worker configuration file exist.

| ID | Feature | Description |
|----|---------|-------------|
| F18.1 | **Typed, server-built jobs** | `POST /api/delegations` takes `{kind, projectId, issueRef, key?, parentTaskId?}`. For `triage`, Kookr fetches the issue itself and builds a versioned prompt; the worker fetches nothing and holds no GitHub credential. |
| F18.2 | **Read-only snapshots** | Each job reads an immutable per-commit snapshot of the project (tracked files only) mounted read-only, recorded as `baseSha` on the delegation. |
| F18.3 | **Honest outcomes** | Every delegation ends in a stated state: completed with a schema-validated verdict, or failed / timed out with a reason (worker unreachable, worker lost, worker failed, rejected, needs input, invalid result). A job whose worker may still be running says so. |
| F18.4 | **Restart-safe** | A write-ahead record lets Kookr re-attach to, or truthfully fail, every unfinished job after a restart. A corrupt store disables delegation with an error naming the file rather than reading as empty. |
| F18.5 | **Bounded and fail-closed** | Per-worker and global caps, distinct per-worker tokens (the shared default token is refused), loopback-or-allow-listed worker URLs, and untrusted-by-default treatment of everything the worker returns. |

### F19: Delivery pipeline (fast gate, integration branch, integration train)

Pull requests merge quickly while `main` stays fully verified. A push runs only the checks and tests the diff needs; the full suite runs once, on the integration branch, before anything reaches `main`. Configured by `.kookr/delivery-gate.json` on `origin/main`; without that file the full suite runs on every push and pull requests merge into `main` as before. Reference: [`docs/reference/integration-train.md`](reference/integration-train.md).

| ID | Feature | Description |
|----|---------|-------------|
| F19.1 | **Fast pre-push gate** | With `"prePushGate": "fast"`, `.hooks/pre-push` runs the static checks plus only the tests related to the diff (`scripts/fast-gate-tests.sh`). A `kookr-full-gate` file in the git common directory forces the full lanes again. |
| F19.2 | **Integration branch** | With `"integrationBranch": "staging"`, `pnpm merge <PR>` retargets a pull request aimed at `main` to `staging` and squash-merges it there. Linked issues stay open until the change reaches `main`. |
| F19.3 | **Integration train** | `pnpm train:start` runs a loop that verifies the head of `staging` with the full `pnpm verify` and fast-forwards `main` to the exact commit it verified, then closes the linked issues. When at most five test files fail, the verify re-runs them once (`KOOKR_VERIFY_FLAKY_RERUN`) before calling the head red. `pnpm train:status` and `pnpm train:logs` show what it did. |
| F19.4 | **Revert and fix task** | When the full run fails, the train finds the offending pull request by bisecting, reverts it on `staging`, reopens its issue with the failing output, and spawns one task to fix and re-land it, up to three times per issue; a fourth failure notifies the operator instead. It halts and notifies the operator instead when the culprit is unclear. |

### Local voice dictation

When speech-to-text is enabled, microphone buttons in task launch, quick launch,
completion criteria, and task replies accept Auto, Français, or English. Kookr
shows recognition in a live preview, then appends the completed transcript to
the existing draft. The operator reviews and submits the text explicitly.
Changing tasks or closing the input cancels that recording so its text cannot
land in another task. This uses local Qwen recognition on GPU or Whisper on CPU and works
independently of the selected coding agent.

If recognition fails or the input closes, non-empty provisional text remains
available as an incomplete dictation in the matching input. Restore appends it
to existing text; copy and discard are separate actions. Recoveries expire
after 24 hours. The browser stores text only, with an in-tab fallback when
storage is unavailable; another recording cannot silently replace it.

Operators can enable a local audio/transcription corpus for later evaluation.
It retains completed browser recordings and Telegram audio with the automatic
text, recognition settings and outcome. Collection is off by default; enabling
it does not create human reference transcripts. Both launchers retain recording
links when the operator edits the prompt or criteria. Launch saves the submitted
field text separately from the original prediction; saving failures remain
visible and do not block launching. The operator can later play each recording,
edit its correction, confirm a faithful transcript after listening, mark a
reformulation, or exclude it. Corpus review offers separate verified-pair and
candidate exports, and deletion of individual examples. See the
[corpus configuration and format](reference/speech-recognition.md#local-evaluation-corpus).

While recording, a small meter beside the stop button follows the captured
microphone level. It falls flat during silence or a capture interruption, with
text distinguishing quiet input from missing audio. This helps the operator
notice gaps while speaking without treating every natural pause as a fault.

### Avatar panel (optional, off by default)

A column on the right of the dashboard, with a 3D character who lip-syncs Kookr's spoken task summaries
— the clips played by the speaker (🔊) buttons on tasks. It gives those summaries a face: it shows
"preparing" while a summary is being generated and moves its mouth while the clip plays. It is also where
she and you talk: one conversation, shown as a chat, holds what you type, what you say, and everything she
says out loud, and a one-line strip above it holds what is waiting on you.

- **Off unless you turn it on.** Settings → Notifications & Alerts → **Avatar panel**. The choice is
  stored per browser. While it is off, the browser downloads nothing for it: no 3D renderer, no
  avatar file.
- **A column beside the dashboard, not on top of it.** While it is open, the column is as tall as the
  window and 380 px wide, docked to the right edge, and the dashboard (top bar, banners, panes) shrinks to
  end where the column starts; the toasts and other overlays at the right edge move left with it. The page
  always keeps at least 1000 px: in a window of 1320 px or more the column is docked, and a wide width is
  capped so the page keeps its 1000 px (a 560 px width in a 1440 px window shows as 440 px, and comes back
  in a wider window). In a window of 769 to 1319 px there is no room to take, so the column floats over the
  right side of the page, below the top bar, and the page keeps its full width. Drag
  its left edge to change its width, or focus the edge and press the left and right arrow
  keys (Shift for bigger steps, Home and End for the limits); the width is remembered. The column can be
  from 320 px wide up to half the window, as long as the page keeps its 1000 px: at most 560 px in a
  1560 px window, 920 px at 1920 px and 1280 px at 2560 px (and at most 560 px while it floats over the
  page). In a wide column the conversation and the composer stay 760 px wide at most, centred, so lines
  remain readable. On a window 768 px
  wide or narrower it is a full-width sheet over the page instead. Minimising collapses it to a round
  bubble in the bottom-right corner, and the dashboard takes its full width back. The bubble shows an amber badge with the number of things waiting for you (findings needing your
  attention, plus questions from tasks and permission prompts, described below), and an amber dot
  when a message is unheard. Hover the bubble, or focus it with the keyboard, and a small card says
  it in words: "1 question for you", "2 findings need you", "1 unheard message" (each row only when it
  applies) and "Click to open Lucy". Escape closes the card; screen readers get the same sentence from the bubble's label
  instead. A minimised panel shuts its 3D view down and uses no graphics memory.
- **Lucy's desk: she takes the whole window.** The column's title bar has a **Desk** button (the full-width sheet of a narrow window has none, and the shortcut still works there); press it,
  or **Alt+Shift+L** (**Cmd+Ctrl+Shift+L** on macOS; rebindable in Settings, and it works from anywhere, text
  boxes and a minimised bubble included), and she covers the dashboard, which stays loaded underneath. The
  same button, now **Back to dashboard**, or the same key brings the column back. From 1500 px wide the desk
  has three columns under one title bar. The title bar is her name and what she is doing, a plain summary from
  the same data as the columns ("7 running · 2 need you"), and on the right **Talk**, **Replay last message**
  and **Back to dashboard**. The columns, left to right, are each a labelled region and are reached in this
  order with Tab:
  - **Decisions** (26% of the window, 400 to 520 px; the title carries the count, "DECISIONS · 2"). Everything
    that waits on you, soonest first, in the order of the dashboard's "Needs you" list: the questions tasks
    ask (the one that closes soonest first) and the permission prompts as whole cards with their answers on
    screen, then the findings (a task that says it is finished, is over budget, has gone quiet) as compact
    cards with the finding's kind in words, the task's name, one line of Kookr's own explanation and one
    button, **Open task**. A task stopped on a permission prompt shows the prompt's card, with Approve once
    and Deny, in place of a second card for its finding. Nothing in this column changes a task except
    the answer and permission buttons of the cards. On top, one line names the first item in words ("Next:
    answer Earnings Watch UX review, 117 min left", "Next: Billing migration wants your permission to use
    Bash", "Next: review Package release, it says it is finished"); pressing it scrolls that card into view and
    lights it for a moment, and never moves keyboard focus. When nothing waits the column says "Nothing waits
    on you." and, under **Decided today**, lists up to five questions closed today with how each ended;
    opinion requests from tasks that have already ended stay folded under their one line.
  - **Fleet** (the same width; "FLEET · 7 RUNNING"). One row per running task in the dashboard's order, with
    the tasks that need you first and marked with the amber diamond: the name, the project, how long it has run
    and its cost when it has one, and under the name what it is doing right now (the same current-tool line
    the dashboard's working rows show; no line when it has none). Under them, **Finished today** lists up to
    eight tasks with when they finished and their cost. A row is a button that leaves the desk and opens the
    task. It reads what the dashboard already holds; nothing is fetched.
  - **Conversation** (the rest). Her 3D view as a portrait about 160 px tall at the top, then the conversation, at
    most 760 px wide and centred in the column, and the composer under it (the text box starts two lines tall
    and grows to eight). An empty conversation shows her welcome and its suggestions.

  Each of the two left columns scrolls by itself. From 1100 to 1499 px Decisions with Fleet under it sit in one
  left column, each scrolling by itself, with the conversation on the right. In a narrower window the desk is
  one column, laid out like the docked column with the same title bar (the "Waiting on you" strip is Decisions
  there, and there is no Fleet). While the desk is shown, the dashboard's notifications stand at the bottom
  left of the conversation column, just above the composer, so they never cover a card, her 3D view or the
  composer. Nothing is restarted by the switch: the
  3D view keeps running, a half-typed message stays in the text box (which gets the keyboard focus on
  entering; nothing else in the desk takes focus by itself), and the conversation stays where it was. **Open task** on a card in the desk selects the task
  and brings the column back, so the task is on screen beside her (also when she was a minimised bubble
  before the desk). While she covers the dashboard, in the desk
  and as the open full-width sheet of a narrow window, the
  dashboard's own keyboard shortcuts do nothing (so a stray Enter cannot act on a task you cannot see); Ctrl+K
  and her own two shortcuts still work. The dashboard underneath is also inert then: Tab cannot reach it and
  screen readers skip it, while the command palette, notifications, Diagnostics and Settings stay usable, and
  keyboard focus left in the dashboard moves to her text box. The desk is not entered while a dialog opened from
  the dashboard (Share task, a confirm) is open; if the sheet comes up under one, the dashboard stays live until it closes. The desk belongs to one browser tab: it is remembered until the tab is
  closed and survives a reload, and it does not switch your other tabs, so the dashboard can stay in one
  window while she has another. Opening **`/?lucy=room`** starts a tab in the desk whatever the saved
  preferences say, also when she was minimised, and switches the panel on if it was off; the parameter is
  then removed from the address.
- **Usable from the keyboard.** Focus stays on the panel when you minimise or reopen it,
  and every message's Replay button can be reached with Tab. With "reduce motion" set in your operating
  system, the decorative rings and particles stand still; only her mouth and a slight sway remain.
- **Inside the column, top to bottom.** The title bar (her name and what she is doing, **Replay last
  message**, Minimise); the 3D view, 120 px tall; the strip **Waiting on you** (below), one line until you
  unfold it; the conversation, which always keeps at least 45% of the column; and the composer: the
  **Talk** button and the text box for typing to her, with the autonomy level she works at. At most two
  areas of the column scroll: the conversation and the unfolded strip. When the unfolded strip needs more
  room than is left, the 3D view gives up its height first.
- **The conversation is a chat.** Oldest first. Her messages are bubbles on the left, yours are bubbles on
  the right with a teal tint, each with the time it was said (messages from the same side within a minute
  share one time). It stays on the newest entry as it arrives and grows; if you scrolled up to read, it
  stays where it is and a **New message** button appears at the bottom. New entries fade in over a moment
  (not at all with "reduce motion"). It holds what you typed and her reply (streamed in as it is
  written), what you said in hands-free talk and what she answered, notices about talk (unavailable,
  connection lost), what became of the launches she proposed and her reports about those tasks, and every
  message she said aloud, marked "said aloud". Each of those shows its full text, the task it was about
  and how long ago ("just now", "5 min ago", "3 h ago", "2 d ago"), plus a Replay button of its own. A
  message she read from fixed template wording, because the summary model was not used, is marked
  "template". Only the last three spoken messages keep their audio, so an older one stays as text, without
  a Replay button.
- **What she is doing while you wait.** After you send a typed request, one quiet line under it says what
  she is looking at ("Reading the board…", "Reading a task's terminal…"); when her answer starts it
  shrinks to "Looked at 3 things". Lines of her typed answer that start with "- " or "•" are shown as a
  short list; nothing else in her text is interpreted.
- **A start that invites.** An empty conversation shows a short welcome from her and three buttons,
  **Brief me**, **What needs me right now?** and **What can you do?**: pressing one sends that sentence.
  A message of hers can offer such buttons too; only her newest message shows them.
- **The conversation survives a new tab.** It keeps the last 200 entries, as text only, in the browser's
  local storage: a reload, a new tab or a browser restart shows the same conversation, and tabs that are
  open at the same time show each other's new entries. The conversation she remembers on the server
  continues with it, so she still knows what you asked before.
- **Hear it again.** If you were away, or the tab was in the background, when she spoke, the message
  is kept. A message's own Replay button plays that message again with the same lip-sync; the
  **Replay last message** button in the title bar plays the newest one. Until at least 80% of a message
  has played while the tab was visible, it is marked "unheard" in the list (a dot and the word), and
  the minimised bubble carries a dot while any message is unheard, and the title-bar button while the newest one is. Replaying a
  message marks only that message heard. Replay respects the global sound switch.
- **It cannot break the dashboard.** If the panel fails to load or crashes, it disappears until the
  next reload and everything else keeps working.
- **What it needs.** A browser with WebGL. Without it the panel says so and spoken summaries still
  play normally. It only has something to say when the speech service is on (`KOOKR_TTS`).
- **Choose the voice.** Settings → General → **Voice** (server setting `speakVoice`, next to
  `speakVerbosity`) picks Heart, Sky, Sarah or Matilda, or **Install default** to follow `TTS_VOICE`.
  It applies to the next spoken clip with no restart. Heart, Sky and Sarah need a GPU to respond quickly.
- **What it does not do.** With one exception it never speaks on its own: it accompanies clips you
  asked for and answers you while hands-free is on (below). The exception is a question a task asks
  you, which she reads out once when it arrives (next section). Its mouth follows the loudness of the clip, not the
  individual sounds, so the lip-sync is approximate.

#### Lucy asks you what a task needs to know

When a task asks you a question with `kookr ask` (the multiple-choice questions that reach your phone
over Telegram), Lucy asks it too if the dashboard is open with the avatar panel on. She reads the
question and its choices aloud once, and the **Waiting on you** strip counts it. Unfold the strip and
press the question to get its card: one button per choice, the background the task gave, and a box for a
typed answer when the task accepts one.

- **One line, not a pile of cards.** With nothing waiting, the strip starts folded: "0 waiting on you ·
  2 opinions wanted", and pressing it unfolds the list (your choice is remembered until you close the
  browser tab). While a question or a live permission prompt waits, the strip is unfolded whatever you
  saved: the question that closes soonest is shown whole and the others are one line each (who asks, the
  start of the question, the time left), so a waiting question is never hidden behind a folded strip.
  You can still fold it by hand; it stays folded until a new question or prompt arrives. Pressing a line
  opens that card and folds the one that was open, and a question that arrives later never takes the open
  card away from you (what you were typing stays). Permission cards come first. A card never scrolls
  inside itself: the list scrolls as one area when it is taller than the room it has, and in a window 800
  px tall or more a card with three choices is shown whole. The number in the strip counts the permission
  cards and the questions a task may still be waiting for.
- **Opinions from finished tasks.** A question whose task has already ended blocks nothing, so these
  fold into one row ("15 opinions wanted by finished tasks · first closes in 4 h"). Press it to
  unfold one line per question, again soonest first, and press a line to answer. They are counted apart
  in the strip ("2 opinions wanted"), not in its number, and the minimised bubble's badge leaves them out too.

- **Answer where you are.** Press a choice in her panel, or answer on Telegram. It is one question
  with two ways to answer: the first answer wins, the task receives it the same way, and the other
  place is updated. Answer in Kookr and the Telegram message changes to "Already answered in Kookr:
  … Nothing more is needed here." Answer on Telegram and the card changes to "Answered on Telegram: …".
- **She does not nag.** She speaks a question only when it arrives, never again on a reload, and in
  one browser tab only. With sound off or Do Not Disturb on she stays silent and the question waits
  in her thread as unheard. If it is answered while she is reading it, she stops.
- **Open what it is about.** A question can carry up to two links (`kookr ask --link`), shown as
  buttons such as "Open mockups" on the card and on Telegram, and the card has an **Open task** button
  that selects the asking task. With hands-free talk on, "show me", "open it" or "show me the task"
  does the same, and she says if the browser blocked the new tab.
- **A reminder until you answer.** While a question waits, Telegram brings it back with a short
  reply to the question: by default after 10 minutes, after 1 hour, then every 4 hours (at most 6
  times), and once 10 minutes before it closes. None come during your quiet hours, and one comes
  when they end. The reminders disappear once the question is answered. The `askReminders` setting
  changes the schedule; an empty one turns them off.
- **Minimised**, the bubble's badge counts the questions still waiting and the permission prompts, with the findings, and the bubble
  grows into the decision itself. A card appears above it (about 390 px wide) with who asks, the time left,
  the question, its answers as buttons, "Open Lucy" and "Later". A permission prompt whose Approve once and
  Deny still work gets the same treatment, with the whole command in a scrolling box; a prompt whose buttons
  have timed out does not. With several waiting, a live permission prompt comes first, then the question
  that closes soonest, one at a time, with "+2 more waiting" under it (it opens her column). Long questions
  are cut to five lines with "Show all"; with more than four answers, or one too long to fit, a single
  "Open Lucy to answer" button replaces them (the typed answer, the background and "Open task" are in the
  open column). After you answer, or when the question is answered on Telegram, expires or is withdrawn,
  the card says what happened for 4 seconds, then shows the next one or goes. "Later" (or Escape inside
  the card) puts it away, and that item never grows the bubble again in this browser tab. The card never
  takes keyboard focus (it is announced to screen readers instead), its buttons ignore presses for the first
  0.6 s, and it waits while you are typing (until 2 seconds after the last key, or 2 seconds after focus moves into a
  text field or a terminal), while Do Not Disturb is on, and while the browser tab is hidden. "Open Lucy" opens her column
  with the waiting strip unfolded. The interaction log counts these as `lucy_panel_action` events
  (`bubble_card_shown`, `bubble_card_answered`, `bubble_card_dismissed`, `bubble_card_opened`).
- **Needs** Telegram remote chat (that is what makes `kookr ask` available) and, for her voice, the
  speech service. With the avatar panel off nothing changes: the question is on Telegram only.
- **By voice, with a read-back.** With hands-free talk on, say one of the listed choices ("run it
  tonight"). She reads it back ("You want: run it tonight. Shall I send that?") and sends it only when
  your next sentence is a clear "yes". "No", or anything else, cancels. Free-text answers stay in the
  panel and on Telegram. She also knows which questions are waiting and which were answered, and can
  tell you.

Details: [Lucy live](reference/lucy-live.md#questions-from-tasks).

#### Lucy tells you when a task waits for your permission

When a task's agent has waited a minute on a permission prompt and the avatar panel is on, Lucy says
so ("The task "Fix the login page" is waiting for your permission to use Bash. The command is on my
card.") and her panel shows a card with the whole command and the finding card's **Approve once** and
**Deny**. She never reads the command out, speaks at most once every 2 minutes (several tasks in that
time are said together: "Two more tasks are waiting for you."), and follows the same rules as for
questions: one tab, nothing aloud with sound off, Do Not Disturb or quiet hours. The card goes as soon
as the prompt is answered anywhere. The delay is the `lucyPermissionNoticeAfterSeconds` setting
(default 60; 0 turns it off). Needs no Telegram; her voice needs the speech service.

She remembers what she just told you. Answer the notice with "can you make it proceed ?", typed or
spoken, and she knows which task you mean: she names it, says what it wants to run and points you at
**Approve once** on her card. The buttons stop working five minutes after the prompt appeared; she
then says so and opens the task so you can answer in its terminal. She cannot approve a prompt
herself. The same memory covers a question she read out, a line she wrote about a task that failed or
went quiet, and the report of a task she launched: the last six, for fifteen minutes.
Details: [What she said unprompted](reference/lucy-operator.md#what-she-said-unprompted).

#### Talk to Lucy hands-free (optional, off by default)

The **Talk** button beside the panel's text box starts a spoken conversation (when it cannot be used it
reads "Talk is not set up", and its tooltip says why): you speak, she answers out
loud about a second after you stop, and you can talk over her to stop her. She answers from
the current task status (what is running, stopped or recently finished) and says so when she does not
know something. She cannot act on tasks yet.

- **From the keyboard or the bubble.** **Alt+Shift+M** (**Cmd+Ctrl+Shift+M** on macOS) switches Talk on
  or off from anywhere, also while a text box has focus (**Alt+M** stays dictation into that box), and
  with the panel minimised. While Talk is on, the minimised bubble shows a small teal microphone
  button; one click on it switches Talk off.
- **The microphone is on only while Talk is on**, and Talk is off again after every page reload.
  Audio goes to your own Kookr server and to a speech recogniser running on your machine; only the
  text of what you said goes to the helper model, with the task status, to write her answer.
- **Interrupting.** Start speaking while she is busy (preparing or speaking an answer) and her volume drops at once.
  The Kookr server then checks the sound with Silero, a small speech detector, which takes a fraction
  of a second. If it hears a voice, she stops and listens to you; if it was a cough, a click or a
  door, her volume comes back and she carries on. If the check is not available (the model failed to
  load), she stops as soon as the browser hears a loud enough sound, as before. Headphones work best;
  on speakers her own voice may be picked up.
- **Her other clips.** While Talk is on, the same holds for everything else she says out loud: a
  speaker button's summary, a Replay, the report of a task she launched. Talk over it and it turns down, then
  stops if it was your voice or comes back if it was not. She never says two things at once: pressing a
  speaker button or Replay while she is answering stops her answer and plays the clip, and an answer
  that is ready while a clip plays starts when the clip ends. With Talk off, clips play as before.
- **A task's question.** While Talk is on, a new question from a task is not a clip: she says it in the
  conversation once you have finished speaking and she has finished answering. Talking over it stops her
  as for an answer, and she remembers having said it, so "say that again" works.
- **What you see.** Her state (listening, thinking, speaking), and in the conversation thread what you said as a
  draft that improves while you talk, then the final text, and her answer as she speaks it. Every exchange
  stays in the thread, not only the latest.
- **Language.** You can speak English or French (it follows the dictation language). She always answers
  in English, because her voices are English voices.
- **What it needs.** The speech service (`KOOKR_TTS`), a helper model on Baseten
  (`KOOKR_BASETEN_API_KEY`), and Lucy's ears: a local speech recogniser (LFM3-Omni-2B in llama.cpp, about
  3.2 GB of GPU memory, NVIDIA GPU) that Kookr starts and stops itself
  with `KOOKR_LUCY_EARS=true` (or that you run yourself and point to with `KOOKR_LUCY_EARS_URL`). Setup and measured timings: [Lucy live](reference/lucy-live.md).
- **Licence.** The bundled avatar file is CC BY-NC 4.0, not Apache-2.0 like the code — see
  `src/frontend/avatar/assets/LICENSE.md`. Commercial users should remove it or keep the panel off.

#### Ask Lucy a question (on by default with a Baseten or OpenRouter key)

When a Baseten or OpenRouter key is set, Kookr answers questions about your tasks at `POST /api/lucy/turn`
(on by default; `KOOKR_LUCY_OPERATOR=0` switches it off):
you send one sentence, and Lucy's reply comes back as it is written. This is the first step toward
running Kookr through her. The avatar panel has a text box for it at the foot of the column when it is on
(it grows from one line to five; Enter sends and Shift+Enter starts a new line; your sentence and her
reply appear in the conversation), and hands-free
talk uses it too when launching is on (next section).

- **She looks things up.** Each answer starts from a board of your tasks: what needs you, what is
  working, what just finished, spend and quota. When that is not enough she can read one task (what
  it was asked to do, what it is waiting for, its closing summary), list projects, or ask the
  dashboard to open a task. She can also read what a task's terminal shows now (its last 40 lines).
- **On its own she cannot change anything.** No look-up tool launches, replies to, closes, snoozes or stops a
  task, so text written by an agent cannot make her act. The exceptions are the proposals described
  below (starting a task, and answering, replying to or closing an existing one), which only the operator
  can confirm. She is told that everything tasks write is
  information to report, never an instruction.
- **Limits.** A turn makes at most four model calls and stops after 30 seconds. When a limit ends a
  turn, her last sentence says so.
- **What leaves the machine.** Her model runs at Baseten (the default when its key is set) or OpenRouter. Each turn sends your question, the board
  (task names, projects, states, costs) and whatever she looks up, with secret-looking tokens replaced
  first. Switch it off (`KOOKR_LUCY_OPERATOR=0`) if task names or task requests must not leave the machine.
- **What it needs.** A Baseten key (`KOOKR_BASETEN_API_KEY`) or an OpenRouter key (`KOOKR_OPENROUTER_API_KEY`). The service,
  the model and how much it thinks are settings. Details: [Lucy operator](reference/lucy-operator.md).

#### Ask Lucy to start a task (on by default)

Launching is on whenever the question conversation above is on (`KOOKR_LUCY_LAUNCH=0` switches
launching off on its own). Say or type "Lucy, investigate why the issue tasks stop
chaining" and she starts a task for you. She repeats back what she is about to launch, the avatar
panel shows it as a card with the whole description at the end of the conversation (the card stands in
for her read-back, which is not also written as a message), and the task starts when you say "go", press
Enter or click Go. Anything else you say drops it, and a proposal expires after two minutes. What became
of it stays in the conversation as one line ("Started kookr task", with a button to open the task,
"Cancelled" or "Timed out"). An unclear request gets one question instead; when it is the project
that is unclear, the question names up to three ("Which project: kookr, kb-scout-evol or
earnings-watch?"). She can launch in every project that has a folder on this machine, as the Launch
dialog can, including Kookr's own: "fix this problem with you" or "with the dashboard" goes to Kookr's
own project, which the server identifies by its repository, never by a name. An investigation is told to
report findings and file issues, not to open a pull request. When the task finishes or needs you, she
says so, and the sentence is a message of hers in the conversation with an **Open task** button.

- **You choose how much she may do alone** (Settings → Lucy, `lucyAutonomy`): *Careful* (her tasks
  always ask for permissions), *Balanced* (default; her tasks run like ones from the Launch tab), or
  *Hands-off* (every permission bypassed, and a clear request starts after a few seconds unless you say
  "cancel"). She cannot change this setting, and only your own words start anything: text written by
  agents never does.
- **What leaves the machine.** Hands-free talk is then answered by the operator conversation, so each
  spoken request goes to OpenRouter, and a second call writes the task from your words, the project
  names and which of them is Kookr itself, and nothing else. Details: [Lucy operator](reference/lucy-operator.md#launching-a-task-by-voice-or-text).

#### Ask Lucy to answer, reply to or close a task (on by default)

Under the same switch as launching (`KOOKR_LUCY_LAUNCH`), you can tell Lucy to act on a task that
already exists: "answer the billing question with Postgres", "tell the billing task to rebase on main",
"close the billing task" (only for a task that says it is finished). As with a launch, nothing happens
at once. She proposes it as a card in the avatar panel that shows exactly what will be sent, and it
goes only when you click **Send** (or **Close**) or say "go". Anything else you say drops it, and an
unconfirmed card expires after two minutes. Kookr checks again at that moment that the question is
still waiting, the task still runs or still says it is finished, and refuses with a short sentence when
the card is no longer true. What became of the card stays in the conversation as one line ("Sent",
"Closed", or the reason nothing was done), with a button to open the task. Details:
[Lucy operator](reference/lucy-operator.md#acting-on-an-existing-task-answer-reply-close).

#### Lucy writes to you first: a briefing and task events (on by default with the Lucy conversation)

Two things appear in Lucy's thread without you asking, as written messages that are not spoken. When
her panel first opens she writes a **briefing** of at most about 45 words: what waits on you, what is
working, and up to three follow-up buttons. She writes it again when you come back after 10 minutes or
more away, but only if what waits on you changed. When a task she did not launch fails, goes quiet or
loses contact, or says it is finished and still waits for review after ten minutes, she writes one line
about it (events close together are written as one line, at most one line every two minutes), with an
**Open task** button. Details:
[Lucy live](reference/lucy-live.md#what-she-writes-on-her-own).

#### Interaction log (on by default, local only)

So that the wording and length of her summaries can be tuned from real use, Kookr keeps a plain-text
log of what she said and how you reacted: `~/.kookr/lucy-interactions.jsonl` (one JSON object per
line; it rotates at 10 MB and keeps three older files).

- **What is recorded.** For every spoken summary: the text that was spoken, the wording before it was
  tidied for speech (when that differs), whether it came from the language model or the plain
  fallback and, for a fallback, why (no model configured, the call timed out or failed, an empty or
  malformed reply, or wording that was too long or read as an instruction), whether it was cached, word count, and timings. From the browser: when a clip started
  (click or replay), how it ended (finished, stopped by you, replaced) and how much of it
  played, clips that were never heard (muted, do-not-disturb, audio blocked), and avatar-panel
  actions (enable, disable, minimise, restore, move, replay, and expand and collapse for entering and
  leaving her room). Each clip has an id that links the two
  sides. If you use hands-free talk, every turn is also recorded (`kind: "live_turn"`): what you said,
  as text (secret-looking tokens such as API keys are replaced first), her answer, how the turn ended
  (answered, interrupted, nothing heard, or failed, with the reason), and timings such as how long
  recognition and the first sentence took. Your voice is never stored: the audio is sent to the
  recogniser and discarded. No audio is stored. Task names and summary text can contain project details, so treat the
  file like your other local logs.
- **Conversation turns.** If the operator conversation is switched on (see above), every turn is
  recorded too (`kind: "operator_turn"`): what you asked and what she answered (secret-looking
  tokens replaced first), the names of the look-ups she made, how the turn ended, timings, tokens
  and cost. What her look-ups returned is not recorded.
- **It stays on this machine.** Nothing is sent anywhere; Kookr only writes the file.
- **Turn it off.** Settings → Notifications & Alerts → **Keep a local log of Lucy's interactions**
  (server setting `lucyInteractionLog`, default on). When off, nothing is written. Existing files are
  left alone; delete them if you want them gone.
- **Summarise it.** `GET /api/diagnostics/lucy-interactions/summary?days=7` (1 to 90 days) returns
  counts and shares: clips said, share from the fallback text, share served from cache, mean and
  median words per clip (overall and per source), clips started, replay rate (distinct clips replayed over clips started), early-stop rate (you
  stopped it before half had played), unheard rate by reason, panel actions by type, and the ten
  phrasings stopped early most often. Damaged lines are skipped and counted.

## What Kookr Does NOT Do (explicit non-goals)

| Non-goal | Reason |
|----------|--------|
| **Replace AI coding agents** | Kookr monitors them, doesn't compete with them |
| **Execute code** | Agents do the coding. Kookr routes developer attention |
| **Be a general-purpose AI** | The supervisor agent only watches and explains; it doesn't write code |
| **Manage git, PRs, or issues** | Agents create PRs and manage git. Kookr *monitors* PRs agents create (F7) but doesn't create or modify them |
| **Replace collaboration tools** | Kookr is still centered on one developer supervising their agents. Optional share/relay flows expose selected sessions but do not make Kookr a general team workspace |
| **Move supervision to the cloud** | The core supervisor, agent processes, and terminal control run locally. The hosted relay is an optional transport for explicit sharing, not a cloud-hosted Kookr runtime |
| **General extension marketplace** | Kookr ships the bundled Kookr Toolkit plugin and plugin-tier playbooks, but a third-party extension marketplace remains deferred |

---

## Agent Support Model

### V1: Managed Terminal Sessions

V1 supports agents **launched by Kookr** in managed terminal sessions ([ADR-007](adr/007-managed-terminal-sessions.md), [ADR-014](adr/014-local-dtach-backend.md)). Three agent types are supported: **Claude Code** (primary), **Codex CLI** (via a forked binary — see [PoC 003](poc/003-codex-compatibility-gaps.md)), and **Grok Build** (xAI's official `grok` CLI — see [PoC 009](poc/009-grok-build-basic-supervision.md)). (A fourth `AgentType`, `hermes-fleet` (jeanibarz/hermes-fleet#15), exists only as an interop identity for the activity ledger and review verdicts — it is not a Kookr-launched agent and has no adapter. When opted in (`KOOKR_HERMES_FLEET` + `KOOKR_HERMES_OBSERVER_TOKEN`), its activity can be observed through a flag- and token-gated, ledger-free ingest API — `/api/observed-activity/hermes-fleet` — surfaced in the monitor without launching or binding a task.) Agents run in **interactive mode** (their native execution mode) inside a dtach-backed session owned by `LocalDtachBackend`:
- **Monitoring:** Hooks (`SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`, `Notification`, `UserPromptSubmit`, `SessionEnd`, …) are written as JSONL into `~/.kookr/hooks/<session-id>.jsonl` and tailed by the supervisor for anomaly detection. Hooks are configured per agent via the `--settings` flag (Claude Code, Codex CLI) or a per-session `GROK_HOME` (Grok Build); they are additive to user hooks. `backend.captureBytes` provides ring-buffer snapshots for the GUI display only. Transcript JSONL parsing is used for token/cost and freshness tracking, while transcript-derived anomaly events remain a V2 enhancement. No ANSI terminal output parsing is needed. See [PoC 001](poc/001-hook-mechanism-validation.md).
- **Input delivery:** responses sent as byte-level writes (`backend.write` / `backend.writeSequence`) to the agent's dtach session. Same effect as the developer typing directly.
- **Crash recovery:** managed dtach sessions survive Kookr crashes. The developer can reattach or restart Kookr without losing agent sessions.
- **Direct access:** the developer can attach to any agent's dtach session at any time, even outside Kookr (F4.6).
- **Agent dispatch:** `routing-agent-adapter.ts` dispatches per-session to the correct concrete adapter (`claude-code-adapter.ts`, `codex-cli-adapter.ts`, or `grok-build-adapter.ts`) based on `task.agentType`.

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
- F5.1: Supervisor findings panel (managed agents only in V1)
- F5.2: Terminal panel with input box
- F5.5: Real-time updates

**Nice to have for V1:**
- F1.3: Show current activity (tool calls, files modified)
- F2.2: Detect "stuck" state (deferred to V2 AI supervisor; deterministic detection removed)
- F2.4: Detect permission blocks (detectable via hooks)
- F2.9: Browser notifications
- F3.8: Quick action buttons
- F3.9: AI response suggestions
- F4.2: Stop agent from GUI
- F4.5: Optional completion criteria (stored, not auto-evaluated)
- F4.6: Attach to agent terminal via the dashboard terminal panel; external `dtach` attach remains available manually
- F4.8: AI task naming
- F4.9: Token/cost tracking
- F5.4: Keyboard shortcuts
- F7.1: Extract GitHub references from agent tool_result events
- F7.2: Periodic GitHub polling for PR/issue state via `gh` CLI
- F7.3: Detect actionable changes (new comments, CI failures, review decisions)
- F7.4: Route GitHub alerts through attention queue
- F7.5: Pull request tab in dashboard showing PR context
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
- Grok Build adapter — official `grok` CLI; supervision caveats in [PoC 009](poc/009-grok-build-basic-supervision.md)
- Optional session sharing and hosted relay flows (F16)
- Meta Task Coordinator (F17)

**Explicitly deferred:**
- F1.1: Agent discovery via session files (managed agents are launched by Kookr, so discovery adds no value without "take over" support for externally-started agents)
- Gemini CLI support
- "Take over" discovered agents (resume under Kookr's control)
- Task inference for discovered agents (reading conversation beginnings)
- Third-party/general extension system beyond the bundled Kookr Toolkit plugin and plugin-tier playbooks
- Full cross-session analytics database beyond the local JSON/JSONL/SQLite stores used by current features
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
| Is JSONL streaming required for monitoring? | **No.** Claude Code interactive mode provides **hooks** as the real-time anomaly event source. Transcript JSONL files are used for token/cost and freshness tracking, and remain available for richer future event ingestion. `backend.captureBytes` is used only for GUI display. | PoC / ADR-007 |
| Does Codex CLI support similar patterns? | **Yes for Kookr-managed sessions.** The forked Codex CLI path is wired through `codex-cli-adapter.ts`, `routing-agent-adapter.ts`, and `codex-config.ts`, with remaining compatibility caveats tracked in [PoC 003](poc/003-codex-compatibility-gaps.md). External Codex session discovery remains deferred. | PoC / ADR-004 |
| Does Grok Build support similar patterns? | **Yes for Kookr-managed sessions.** The official `grok` CLI is wired through `grok-build-adapter.ts` and `routing-agent-adapter.ts`. The adapter registers when the binary is present and appears in the picker / round-robin. External Grok session discovery remains deferred. | PoC 009 / issue #1339 |
