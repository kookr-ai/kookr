# Boundary And Responsibility Smells

## Purpose

Identify design smells in the V1 architecture before implementation. Pre-implementation smell analysis reduces rework. Updated with findings from GitHub issues #3, #5, #6, #9.

## Responsibility Overlap Findings

| # | Overlap | Components | Severity |
|---|---|---|---|
| 1 | **Status derivation** — both the agent adapter and supervisor can derive agent status from terminal output | agent-adapter, supervisor-agent | Medium — **Resolved** |

**Detail:** The adapter parses structured data (hooks + transcript JSONL) into `AgentEvent` objects, and could derive status. But the supervisor also detects `stuck` and `waiting_for_input` states. Who owns the canonical agent status?

**Decision (accepted, updated 2026-05-19):** Adapter emits only raw events (`tool_use`, `error`, `completed`, etc.) plus terminal lifecycle signals. The supervisor owns derived live state through `AgentState.anomaly`, watchdog verdicts, and attention-queue entries; `AgentStatus` is persisted session metadata, not a live transition machine. The adapter is a translator (structured data → `AgentEvent`); it does not own anomaly or attention state.

## Ambiguous Ownership Findings

| # | Ambiguity | Components | Severity | Status |
|---|---|---|---|---|
| 1 | **Process lifecycle** — who kills a managed agent? The adapter (it owns the process handle) or the backend (it receives the GUI command)? | agent-adapter, server | Low | Decided |
| 2 | **~~Resume serialization~~** — resolved by ADR-007. No more resume subprocess; input delivered through the terminal backend byte-write path | agent-adapter, server, attention-router | ~~Medium~~ | Resolved (ADR-007) |

**#1 Decision (accepted, updated 2026-05-19):** The server routes user lifecycle commands and calls the adapter/terminal backend to stop or kill sessions. The `TerminalBackend` owns dtach process/session I/O; server lifecycle helpers own the task-level transition and cleanup policy.

**#2 ~~Recommendation~~ (issue #9, resolved by ADR-007):** No longer applicable. With managed terminal sessions, input is delivered through the terminal backend to the running agent process. There is no resume subprocess to serialize.

## Duplicated Control Findings

None found. V1 is simple enough that control paths are singular.

## Mixed Abstraction Findings

| # | Finding | Component | Severity | Status |
|---|---|---|---|---|
| 1 | **Backend monolith** — the single backend process mixes HTTP serving, WebSocket handling, process management, supervisor logic, and task persistence | server/index.ts | Medium — **Accepted simplification** |

**#1 Decision (accepted, updated 2026-05-19):** This is a known architectural simplification for V1, not a smell. The process is one, but the code is modular: `server/` (HTTP + WS), `core/` (tasks, supervisor), `adapters/` (dtach + agent I/O), `remote/` (session-sharing policy/transport domain), and `frontend/` (SPA). Each concern has defined interfaces and is independently testable. **Extraction trigger:** revisit if supervisor CPU usage interferes with HTTP/WS responsiveness, or if the module count exceeds what a single process can cleanly organize.

### Resolved: Design-vs-Reality for AskUserQuestion (issue #3)

Previously flagged as HIGH severity: the design docs describe synchronous "agent waits → developer responds" UX, but `AskUserQuestion` is non-blocking in headless mode.

**Original resolution:** Agent behavioral contract (agents instructed to exit after asking).

**Further simplified by ADR-007 and ADR-014:** With managed terminal sessions, agents run in interactive mode where input blocking is native. When an agent needs input, it blocks in the running process. No behavioral contract needed, no session exit/resume cycle. Kookr detects actionable input states from structured hooks/transcripts and watchdog signals. The developer responds through the terminal backend's byte-write path, and the agent resumes immediately.

## Evidence

- `docs/architecture.md:188-201` — `AgentEvent` and `AgentStatus` type definitions
- `docs/architecture.md:205-234` — module structure showing flat backend
- `docs/features.md:60-73` — F2 detection features owned by supervisor
- `docs/adr/007-managed-terminal-sessions.md` — managed terminal sessions (ADR-007)
- GitHub issues #3, #5, #6, #9 — resolved by ADR-007
