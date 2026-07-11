# Agent Adapter — Summary

## Purpose

The agent adapter bridges Kookr to the supported coding-agent CLIs — **Claude Code** and **Codex CLI** (updated 2026-04-10), plus an **experimental Grok Build** adapter (`grok-build-adapter.ts`, issue #1339 Phase 1) registered only when `KOOKR_GROK_BUILD_ENABLED=true` and deliberately excluded from the frontend picker / round-robin. It manages terminal sessions through the `TerminalBackend` abstraction; production is dtach-only through `LocalDtachBackend` per ADR-014 and V8. It consumes structured data from hooks and transcript files, and delivers developer input as bytes to the child PTY. A thin `RoutingAgentAdapter` dispatches calls to the per-agent-type adapter (`claude-code-adapter.ts`, `codex-cli-adapter.ts`, `grok-build-adapter.ts`) behind the common `AgentAdapter` interface. The layer exposes a uniform `AgentEvent` stream for the supervisor to consume.

> Updated 2026-05-09: Removed stale tmux escape-hatch, `SessionMonitor`, and `capture-pane` descriptions. `src/server/start.ts` rejects non-dtach backends; the ring buffer lives inside `LocalDtachBackend`.

## Scope

- Create managed terminal sessions and launch the configured agent binary in interactive mode (ADR-007 interactive rationale, ADR-014 dtach persistence)
- Tail transcript JSONL (`~/.claude/projects/<project>/<session_id>.jsonl` for Claude Code; Codex CLI equivalent) for structured agent events
- Receive real-time hook events via per-session JSONL files. Claude Code hooks include `SessionStart`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `PermissionRequest`, `Notification`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `SessionEnd` — see `HookEventName` in `src/core/hook-events.ts`. Codex CLI advertises its supported subset via `codexHookCapabilities` on `session_start`
- Stream agent output to the browser: `LocalDtachBackend` maintains a persistent attach and ring buffer; every `SessionBridge` attach receives recent bytes plus live output
- Map structured data into normalized `AgentEvent` objects — no ANSI terminal parsing needed
- Send developer input as bytes to the child PTY
- Terminate agent processes (SIGTERM -> SIGKILL) and clean up terminal sessions + dtach sockets
- Surface quota state via `quota-adapter.ts` and wrap GitHub fetches with `circuit-breaker-github-fetcher.ts`; there is no terminal-backend circuit-breaker wrapper on the dtach path

## Owned Responsibilities

- Terminal session lifecycle (create, monitor, destroy)
- Transcript JSONL tailing and hook event reception — normalization into `AgentEvent` stream
- Per-agent-type dispatch through `RoutingAgentAdapter`
- Input delivery via terminal backend byte writes
- Process exit detection within terminal sessions

## Key Dependencies

- **Claude Code CLI** — external binary, must be installed on PATH
- **Codex CLI** — optional external binary (`KOOKR_CODEX_BIN`, defaults to `codex` on PATH). Sourced from `~/git/codex` fork in dev; see project `CLAUDE.md`

## Non-Goals

- Does NOT interpret events (supervisor does that)
- Does NOT decide agent status (supervisor owns the state machine)
- Does NOT store task metadata (core tasks.ts does that)
- Does NOT own session persistence — calls into core's `tasks.ts` to register/update session metadata (ADR-008)
- Does NOT discover external agents (removed from V1 scope — see `01-system-context.md`)
- Does NOT manage `--resume` lifecycle (superseded by ADR-007)

## Evidence

- `docs/architecture.md:130-140` — adapter layer description and reuse strategy
- `docs/adr/004-agent-communication-protocol.md` — mechanisms research (superseded by ADR-007 for interaction model)
- `docs/adr/007-managed-terminal-sessions.md` — managed terminal sessions (ADR-007); interactive-mode rationale still holds under ADR-014
- `docs/adr/008-tmux-session-management.md` — session persistence inline in tasks.json; adapter calls tasks.ts to register/update sessions (ADR-008)
- `docs/adr/014-local-dtach-backend.md` — dtach persistence layer (ADR-014, default from 2026-04-22)

## Observed Smells

None. Clean separation between raw I/O (adapter) and interpretation (supervisor).
