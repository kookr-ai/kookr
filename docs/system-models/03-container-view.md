# Container View

## Purpose

Show the runtime processes and their responsibilities. Containers = running processes, not code packages.

## Container Diagram

```mermaid
flowchart LR
  subgraph Developer Machine
    Browser[Browser SPA<br/>React + Vite]
    Backend[Kookr Backend<br/>Node.js process]
    Term1[Terminal Session #1<br/>dtach]
    Term2[Terminal Session #2<br/>dtach]
    CC[Claude Code<br/>interactive mode]
    Codex[Codex CLI<br/>interactive mode]
    TasksFile[(tasks.json\ntasks + session metadata)]
    StateFiles[(~/.kookr/*.json\nsettings + schedules + OSS/workspace state)]
    HooksDir[(~/.kookr/hooks/\nper-session JSONL)]
    STT[TTS/STT helpers<br/>optional local services]
  end

  Browser <-->|"WebSocket<br/>snapshot + delta + alert"| Backend
  Browser <-->|"binary WS<br/>byte-stream (dtach)"| Backend
  Browser -->|"HTTP"| Backend

  Backend -->|"createSession / attachSession /<br/>input bytes + output stream"| Term1
  Backend -->|"createSession / attachSession /<br/>input bytes + output stream"| Term2
  Term1 -->|"hosts"| CC
  Term2 -->|"hosts"| Codex
  Backend -->|"read/write"| TasksFile
  Backend -->|"read/write"| StateFiles
  CC -->|"hook output"| HooksDir
  Codex -->|"hook output"| HooksDir
  Backend -->|"optional HTTP / subprocess lifecycle"| STT
```

> Updated 2026-04-10: Added Codex CLI alongside Claude Code to reflect `RoutingAgentAdapter` dispatching to `claude-code-adapter.ts` or `codex-cli-adapter.ts` per task.
> Updated 2026-04-22: Terminal session persistence layer moved to dtach by default (ADR-014, Main B.b). The browser↔backend terminal stream is now a binary WebSocket served by `SessionBridge` against the backend's `LocalDtachBackend`.
> Updated 2026-04-24: V8 removed the tmux escape hatch entirely. `src/server/start.ts` hard-rejects `KOOKR_BACKEND` values other than `dtach`. The `tmuxSession` field on `Task.sessions[]` is a historical name that now holds a dtach session ID.
> Updated 2026-05-09: Added non-task state files and optional speech helper services to match the current server surface (`settings`, schedules, OSS attempts, workspace attempts, STT/TTS managers).

## Container Responsibility Table

| Container | Technology | Responsibility |
|---|---|---|
| **Kookr Backend** | Node.js (TypeScript) | HTTP server, WebSocket server, terminal session management, supervisor logic, task storage, schedules, workspace cleanup, OSS contribution refresh, optional speech/Telegram integration |
| **Browser SPA** | React + Vite (ADR-002) | Findings panel, terminal panel, input box, status bar, notifications |
| **Terminal Session** | dtach (ADR-014, sole backend post-V8) | Managed terminal hosting a single agent process. A persistent dtach master owns the child PTY; `SessionBridge` attaches a byte-transparent `dtach -a -E` client per browser viewer. One session per agent |
| **Claude Code (managed)** | External CLI process | Interactive agent execution inside a managed terminal session. Selected by `agentType: 'claude-code'` |
| **Codex CLI (managed)** | External CLI process (forked, see project `CLAUDE.md`) | Interactive agent execution inside a managed terminal session. Selected by `agentType: 'codex-cli'`. Advertises its supported hook subset via `codexHookCapabilities` on `session_start` |
| **tasks.json** | JSON file on disk | Task lifecycle state, description, completion criteria, and inline agent session metadata (dtach session name — field still historically named `tmuxSession`, agent type, transcript path, hook output path, last known status) per task (ADR-008 — persistence layer now dtach per ADR-014) |
| **~/.kookr state files** | JSON files on disk | Settings, schedules, OSS contribution attempts, workspace attempt records, snoozed findings, and related operational state owned by the backend |
| **hooks/** | Per-session JSONL files (`~/.kookr/hooks/`) | Append-only hook output from the active agent (Claude Code or Codex CLI). Full `HookEventName` set — see `src/core/types.ts:2-14` — one file per agent session (ADR-008) |
| **Speech / Telegram helpers** | Optional local service + integration modules | STT/TTS managers and Telegram integration support voice/text task ingress when configured; they are not required for the core attention-router loop |

## Data And Control Ownership Notes

- **Backend owns** all agent lifecycle operations (create terminal session, send keystrokes, kill) and supervisor logic
- **Backend serves** the SPA as static files and pushes updates via WebSocket
- **SPA owns** UI state and rendering; sends commands (respond, skip, snooze, navigate, getNext) to backend
- **No database** in the local deployment — task/session metadata and operational state are file-backed JSON stores under `~/.kookr/`; active queue state remains in-memory with persisted snooze snapshots
- **Core (tasks.ts) owns** tasks.json including inline session metadata; adapter writes hook output to `~/.kookr/hooks/` (ADR-008)
- **No discovery** in V1 — Kookr only shows agents it launched itself

## Evidence

- `docs/architecture.md` — Components section (backend, frontend, adapter layer descriptions)
- `docs/adr/003-deployment-model.md` — local backend + browser decision
- `docs/adr/007-managed-terminal-sessions.md` — managed terminal sessions (ADR-007)
- `docs/adr/008-tmux-session-management.md` — session persistence and startup reconnection (ADR-008)
- `docs/architecture.md` — Module Structure section
- `src/server/index.ts`, `src/server/stt-manager.ts`, `src/server/tts-manager.ts`, `src/integrations/telegram/` — current runtime wiring

## Observed Smells

None remaining. The single-process backend is an accepted V1 simplification — the code is modular (`server/`, `core/`, `adapters/`) even though the process is one. See `06-boundary-and-responsibility-smells.md` Mixed Abstraction #1.
