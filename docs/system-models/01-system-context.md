# System Context

## Purpose

Show Kookr's boundary, who interacts with it, and what external systems it depends on.

## Context Diagram

```mermaid
flowchart LR
  Dev[Developer]
  Kookr[Kookr<br/>Supervisor + GUI]
  Term[Terminal Session<br/>dtach]
  CC[Claude Code CLI]
  Codex[Codex CLI]
  Browser[Browser]

  Dev -->|"launch agent, send response,<br/>skip, snooze"| Browser
  Browser -->|WebSocket| Kookr
  Kookr -->|"create terminal session +<br/>launch agent (interactive mode)"| Term
  Term -->|"runs inside"| CC
  Term -->|"runs inside"| Codex
  Kookr -->|"PTY bytes"| Term
  Term -->|"terminal byte stream"| Kookr
  CC -->|"hook JSONL + transcript JSONL"| Kookr
  Codex -->|"hook JSONL + transcript JSONL"| Kookr
  Kookr -->|"real-time updates + alerts"| Browser
```

> Updated 2026-05-09: Context diagram reflects the current dtach-only backend and dual managed-agent support (`ClaudeCodeAdapter` and `CodexCliAdapter`). The historical `tmuxSession` field name still appears in task metadata, but its value is a dtach session ID.

## External Actors And Systems

| Actor / System | Type | Interaction |
|---|---|---|
| **Developer** | Human actor | Views agent status, reads anomaly explanations, sends responses / skips / snoozes via browser |
| **Browser** | UI runtime | Renders SPA served by Kookr backend |
| **Terminal Session** | Managed process (dtach) | Created by Kookr through `LocalDtachBackend`; hosts one agent process; provides byte-stream output and PTY byte input |
| **Claude Code CLI** | External process | Runs in interactive mode inside a managed terminal session; monitored via hooks + transcript JSONL; receives PTY byte input |
| **Codex CLI** | External process | Runs in interactive mode inside a managed terminal session; monitored through the Codex-compatible hook subset and transcript JSONL; receives PTY byte input |

## System Mission And Boundaries

**Mission:** Watch multiple AI coding agents, detect when they need human help, explain what went wrong, and route the developer to the most urgent one.

**Boundaries:**
- Kookr does NOT write code or execute tools — agents do that
- Kookr does not author code changes, PRs, or issue comments. It does track GitHub/workspace state for supervision, cleanup, and dashboard context.
- Kookr only manages agents it launches itself (in managed terminal sessions) — no discovery of external agents in current scope
- Kookr reads structured hook/transcript events and terminal bytes; it writes task/session metadata, schedule/workspace/OSS state, hook outputs, and user-triggered settings under `~/.kookr/`

## Evidence

- `README.md:49-77` — how it works diagram
- `docs/architecture.md:9-31` — system overview
- `docs/adr/004-agent-communication-protocol.md` — launch, resume mechanisms (superseded by ADR-007 for agent interaction)
- `docs/adr/007-managed-terminal-sessions.md` — managed terminal sessions replace headless mode
- `docs/adr/014-local-dtach-backend.md` — dtach-only terminal persistence layer
- `docs/adr/003-deployment-model.md` — local backend + browser
- `src/adapters/local-dtach-backend.ts`, `src/adapters/claude-code-adapter.ts`, `src/adapters/codex-cli-adapter.ts` — current adapter implementations

## Observed Smells

None at this level. Context boundary is clean: Kookr launches and manages agents, no external discovery.

### Design Decision: No Agent Discovery in V1

Agent discovery via `~/.claude/sessions/` was removed from V1 scope because:
- Kookr-managed agents run in managed terminal sessions (ADR-007) — Kookr has full control over their I/O
- External interactive sessions found via session files are metadata-only (PID, cwd, start time) — Kookr cannot monitor their output or send them input
- The only forward-looking justification was "take over" (resume under Kookr control), which is deferred
- Net: implementation cost for near-zero user value in V1

Discovery can be re-added if/when take-over is implemented.
