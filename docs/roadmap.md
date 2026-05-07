# Roadmap

Fewer phases. Each one demoable and immediately useful.

**V1 = Phases 1 + 2 + 3.** All MVP "must have" features (see [features.md](features.md#mvp-scope-v1)) require Phases 1-3. Phase 4 is V2 (multi-agent-type support + polish).

Now informed by concrete research: agents run in interactive mode inside managed dtach sessions. Input via byte-level writes to the dtach socket, monitoring via hooks (and, for V2, transcript JSONL file tailing). `backend.captureBytes` provides ring-buffer snapshots for GUI display only. See [ADR-007](adr/007-managed-terminal-sessions.md) (supersedes ADR-004's headless approach) and [ADR-014](adr/014-local-dtach-backend.md) (replaced tmux with dtach).

---

## Phase 1: Foundation + Managed Terminal Sessions (V1 increment)

**Goal:** Project setup + launch and monitor a single Claude Code agent in a managed terminal session.

- [x] Initialize TypeScript project (strict mode, Vitest, pnpm)
- [x] Validate terminal-persistence tool choice (initial tmux PoC validated session creation/input/display; later replaced by dtach in [ADR-014](adr/014-local-dtach-backend.md))
- [x] Fork aegiscore patterns (adapt for hook-based monitoring)
- [x] Create managed dtach session via `LocalDtachBackend.createSession({ command: 'claude', … })`
- [x] Monitor agent via hook event tailing (`~/.kookr/hooks/<session-id>.jsonl`) for structured events
- [x] Register hooks for real-time structured event notifications (tool use, errors, permission requests)
- [x] Use `backend.captureBytes` only for display rendering in GUI (not for monitoring logic)
- [x] Parse hook JSON entries into normalized `AgentEvent` stream
- [x] CLI entry point: `npx kookr` (via `bin/kookr.js`) starts the server. Agent launching moved to the GUI ("New Task" dialog) in Phase 2 rather than a positional-argument CLI, since the interactive dialog offers a better surface for specifying prompt + cwd + autonomy + agent type.

**Demo:** Run `npx kookr` → server starts on `http://127.0.0.1:4800`, open it in a browser, launch an agent via the top-bar launcher, and watch its dtach-backed terminal stream live.

> **Note:** Agent discovery via `~/.claude/sessions/` is deferred to a future phase. See [ADR-005](adr/005-discovered-agent-degradation.md).

---

## Phase 2: GUI + Multi-Agent (V1 increment)

**Goal:** Browser GUI for managing multiple agents with full task lifecycle.

**GUI design:** [Proposal 33 — Supervisor-First Triage](spikes/gui-proposals/33-supervisor-first-triage.html) selected from 27 evaluated proposals. Two-panel layout: supervisor findings feed (left), interactive terminal (right), with respond-and-advance triage loop.

- [x] Local HTTP server (Hono) + WebSocket for real-time updates
- [x] Frontend SPA: findings panel + terminal panel
- [x] Implement Proposal 33 layout: findings panel, terminal, Send & Next
- [x] "New Task" dialog: task description (natural-language prompt) + working directory + optional completion criteria → spawns agent in managed dtach session
- [x] "Attach to terminal" action: Attach button in DetailPanel and FindingsPanel (copies the `dtach -a` command); interactive xterm.js terminal in browser fully satisfies F4.6
- [x] Task lifecycle: Open → InProgress → Completed/Cancelled (persisted in JSON)
- [x] Stop agent from GUI (kill dtach session)
- [x] `npx kookr` starts server (via `bin/kookr.js`). Automatic browser-opening is deferred as a small polish item — users currently open the URL printed on startup.

**Demo:** Open Kookr in browser. Supervisor findings panel shows stuck agents with explanations. Click a finding, see its interactive terminal. Send a hint, auto-advance to next finding.

---

## Phase 3: The Loop — V1 Complete

**Goal:** The core "kookr" interaction.

- [x] Detect agent questions via `Stop` hook (`last_assistant_message` provides context) — [PoC 001](poc/001-hook-mechanism-validation.md)
- [x] Detect permission blocks via `PermissionRequest` hook (`tool_name`, `tool_input`, `permission_suggestions`) — [PoC 001](poc/001-hook-mechanism-validation.md)
- [x] Prioritizer: rank agents by urgency (stuck > permission-blocked > waiting-for-input > errored > running)
- [x] Input box: type response → deliver via byte-level writes to the dtach session (`backend.write` / `backend.writeSequence`)
- [x] Auto-advance: after sending, navigate to next bottleneck
- [x] Skip agent (deprioritize to back of queue, supervisor keeps polling)
- [x] Snooze agent (pause monitoring for a duration, timer-based re-entry)
- [x] "All clear" and "all skipped" states
- [x] Browser notification when an agent becomes blocked (`useNotifications.ts`)
- [x] Keyboard shortcuts (Ctrl+N = next bottleneck, Ctrl+Enter = send)
- [ ] Stuck detection: deferred to V2 AI supervisor. Deterministic detection produces false positives; `stuck_loop` type was removed from codebase. V2 will use semantic analysis via the supervisor agent
- [x] GitHub PR/issue awareness: extract references from agent tool_result events, poll state via `gh` CLI, diff for actionable changes, route alerts through attention queue, display in dashboard GitHub tab ([ADR-012](adr/012-github-pr-awareness.md))
- [x] AI response suggestions: Claude Haiku generates predicted developer responses for waiting agents
- [x] Quick action buttons: extract binary/multiple-choice options from agent messages as clickable buttons
- [x] AI task naming: Claude Haiku generates concise task names from prompts
- [x] Token/cost tracking: incremental transcript parsing tracks tokens and costs per session
- [x] Build version info: commit hash, branch, timestamp shown in TopBar
- [x] Project-scoped playbooks: Markdown task templates with parameter interpolation ([ADR-011](adr/011-project-scoped-playbooks.md), F6)
- [x] Session reflection: interaction event log + friction pattern analysis via rule-based analyzer ([ADR-010](adr/010-session-reflection-workflow.md))
- [x] Parent/child task linking for task hierarchies

**Demo:** Run 5 agents. Two get stuck. Kookr highlights #1, you respond, it sends you to #2. Skip #2. Snooze #3 for 10 minutes. "All clear." The loop. Agent #4 creates a PR — the GitHub tab shows its CI status and review comments.

---

## Phase 4: Multi-Agent Type + Polish (V2)

**Goal:** Support Codex CLI. Production-quality release.

- [~] Codex CLI adapter (`src/adapters/codex-cli-adapter.ts`, `routing-agent-adapter.ts`, `codex-config.ts`) — **in progress**. Core adapter and per-session routing are wired. Remaining fork-side and Kookr-side gaps are tracked in [PoC 003](poc/003-codex-compatibility-gaps.md) (hook `--settings` loader, `features.codex_hooks` flag, missing `SessionEnd` / `PostToolUseFailure`, workspace-trust prompt bypass via `codex-config.ts`, MCP startup hang)
- [ ] Codex session discovery (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — date-partitioned, no PID, liveness via mtime)
- [x] Agent type indicators in UI (`AgentTypeSelector.tsx`; agent type shown on finding cards)
- [ ] Dark/light theme (OS preference)
- [x] E2E tests with Playwright (concurrent scenarios)
- [x] `npx kookr` entry point (`bin/kookr.js` launches the built server; publishing to npm is still pending)
- [ ] Getting-started guide (README quickstart in place; long-form guide pending)
- [x] Linux + macOS testing

**Demo:** Mixed fleet of Claude Code + Codex CLI agents, all managed from one Kookr instance. `npx kookr` just works.

---

## Future (only if validated by usage)

- Agent discovery via `~/.claude/sessions/` and `~/.codex/sessions/` (adopt externally-started agents into Kookr management)
- Custom prioritization rules (config-based)
- Anomaly detection patterns as SKILL.md files (community-contributable, V1 uses hardcoded functions)
- Plugin/extension system (study openclaw's SDK first)
- Session persistence and history
- Windows support
- Gemini CLI adapter
- Team mode / multi-user
- Cloud deployment option
- ~~GitHub integration (agent PR status)~~ — **Done** (Phase 3, [ADR-012](adr/012-github-pr-awareness.md)). V2: Haiku LLM extraction, webhook support, GitLab integration
