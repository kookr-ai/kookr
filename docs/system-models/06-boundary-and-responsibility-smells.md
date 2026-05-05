# Boundary And Responsibility Smells

## Purpose

Identify design smells in the V1 architecture before implementation. Pre-implementation smell analysis reduces rework. Updated with findings from GitHub issues #3, #5, #6, #9.

## Responsibility Overlap Findings

| # | Overlap | Components | Severity |
|---|---|---|---|
| 1 | **Status derivation** — both the agent adapter and supervisor can derive agent status from terminal output | agent-adapter, supervisor-agent | Medium — **Resolved** |

**Detail:** The adapter parses structured data (hooks + transcript JSONL) into `AgentEvent` objects, and could derive status. But the supervisor also detects `stuck` and `waiting_for_input` states. Who owns the canonical agent status?

**Decision (accepted):** Adapter emits only raw events (`tool_use`, `error`, `completed`). Supervisor owns the `AgentStatus` state machine and all status transitions. The adapter is a translator (structured data → `AgentEvent`); the supervisor is the single source of truth for agent state. This contract is enforced at the type level: the adapter returns `AgentEvent`, never `AgentStatus`.

## Ambiguous Ownership Findings

| # | Ambiguity | Components | Severity | Status |
|---|---|---|---|---|
| 1 | **Process lifecycle** — who kills a managed agent? The adapter (it owns the process handle) or the backend (it receives the GUI command)? | agent-adapter, server | Low | Decided |
| 2 | **~~Resume serialization~~** — resolved by ADR-007. No more resume subprocess; input delivered via terminal keystrokes (send-keys) | agent-adapter, server, attention-router | ~~Medium~~ | Resolved (ADR-007) |

**#1 Decision (accepted):** The adapter exposes a `stop(agentId)` method. The server calls it in response to the GUI command. Adapter owns the process handle; server owns the routing of user commands.

**#2 ~~Recommendation~~ (issue #9, resolved by ADR-007):** No longer applicable. With managed terminal sessions, input is delivered via terminal keystrokes (send-keys) to the running agent process. There is no resume subprocess to serialize.

## Duplicated Control Findings

None found. V1 is simple enough that control paths are singular.

## Mixed Abstraction Findings

| # | Finding | Component | Severity | Status |
|---|---|---|---|---|
| 1 | **Backend monolith** — the single backend process mixes HTTP serving, WebSocket handling, process management, supervisor logic, and task persistence | server/index.ts | Medium — **Accepted simplification** |

**#1 Decision (accepted):** This is a known architectural simplification for V1, not a smell. The process is one, but the code is modular from the start: `server/` (HTTP + WS), `core/` (tasks, supervisor), `adapters/` (tmux + agent I/O). Each concern has defined interfaces and is independently testable. **Extraction trigger:** revisit if supervisor CPU usage interferes with HTTP/WS responsiveness, or if the module count exceeds what a single process can cleanly organize.

### Resolved: Design-vs-Reality for AskUserQuestion (issue #3)

Previously flagged as HIGH severity: the design docs describe synchronous "agent waits → developer responds" UX, but `AskUserQuestion` is non-blocking in headless mode.

**Original resolution:** Agent behavioral contract (agents instructed to exit after asking).

**Further simplified by ADR-007:** With managed terminal sessions, agents run in interactive mode where input blocking is native. When an agent needs input, it simply blocks waiting for keystrokes. No behavioral contract needed, no session exit/resume cycle. The "waiting for input" state is a real, observable state that Kookr detects via terminal output analysis. The developer responds via terminal keystrokes (send-keys), and the agent resumes immediately. This completely eliminates the design-vs-reality gap.

## Evidence

- `docs/architecture.md:188-201` — `AgentEvent` and `AgentStatus` type definitions
- `docs/architecture.md:205-234` — module structure showing flat backend
- `docs/features.md:60-73` — F2 detection features owned by supervisor
- `docs/adr/007-managed-terminal-sessions.md` — managed terminal sessions (ADR-007)
- GitHub issues #3, #5, #6, #9 — resolved by ADR-007
