# Architecture Decision Records

| ADR | Title | Status |
|-----|-------|--------|
| [001](001-backend-language.md) | Backend Language | **Accepted** — TypeScript |
| [002](002-frontend-framework.md) | Frontend Framework | **Accepted** — React + Vite + Zustand |
| [003](003-deployment-model.md) | Deployment Model | **Accepted** — Local backend + browser |
| [004](004-agent-communication-protocol.md) | Agent Interaction Mechanisms | **Superseded** by ADR-007 — managed terminal sessions replace headless mode |
| [005](005-discovered-agent-degradation.md) | Discovered Agent Degradation Strategy | Proposed — tiered degradation, fully deferred from V1 |
| [006](006-permission-mode-feasibility.md) | Permission Mode Feasibility | **Accepted** — permission detection feasible via hooks in managed terminal mode (revised 2026-03-24; original headless-mode conclusion superseded) |
| [007](007-managed-terminal-sessions.md) | Managed Terminal Sessions | **Accepted** — run agents in managed terminal sessions. Supersedes ADR-004 headless-only. Persistence layer migrated from tmux to dtach by ADR-014 (default flipped 2026-04-22); the interactive-mode rationale still holds |
| [008](008-tmux-session-management.md) | Tmux Session Management & Persistence | **Superseded by ADR-014** (persistence layer, 2026-04-22; V8 removed the tmux backend) — the tasks.json-inline session-metadata + startup reconciliation design still applies, now against `LocalDtachBackend` |
| [009](009-interactive-terminal-in-gui.md) | Interactive Terminal in Browser GUI | **Accepted** — xterm.js + node-pty bridge for full interactive terminal. Dtach default (ADR-014) replaces `TerminalBridge` with `SessionBridge`; the xterm.js front-end contract is unchanged |
| [010](010-session-reflection-workflow.md) | Session Reflection Workflow | **Accepted** — interaction event log + rule-based friction analysis, with LLM summaries as a future/optional enhancement |
| [011](011-project-scoped-playbooks.md) | Project-Scoped Playbooks | **Accepted** — Markdown playbook templates in `.kookr/playbooks/` |
| [012](012-github-pr-awareness.md) | GitHub PR/Issue Awareness | **Accepted** — regex extraction + `gh` CLI polling for PR/issue state tracking |
| [013](013-stuck-detection-promotion-criteria.md) | Stuck-Loop Detection Promotion Criteria | **Accepted** — precision ≥90%, coverage ≥50%, platform parity, env-var opt-in for shadow→active promotion |
| [014](014-local-dtach-backend.md) | Local dtach Backend | **Accepted** — replace tmux with dtach as the terminal persistence layer. Default flipped 2026-04-22 (Main B.b). Escape hatch removed in V8 (2026-04-24); `src/server/start.ts` hard-rejects `KOOKR_BACKEND=tmux` |
