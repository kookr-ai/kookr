# Scope And Method

## Purpose

Document the current implemented Kookr architecture, validate subsystem boundaries, and surface design smells from code-backed evidence.

## System In Scope

Kookr: local Node.js backend + browser SPA that launches, monitors, and routes developer attention across multiple AI coding agents. The implemented managed agents are Claude Code and Codex CLI. Agents run in interactive mode inside dtach-backed managed terminal sessions through `LocalDtachBackend`; Kookr monitors structured hook JSONL and transcript JSONL, streams terminal bytes through `SessionBridge`, and sends developer input as PTY bytes through the `TerminalBackend` abstraction. Kookr only manages agents it launches itself. The current codebase also includes optional session-sharing / hosted-relay modules under `src/remote/`; those expose shared views and supervised mutations but do not replace the local backend ownership model.

> Updated 2026-05-09: This file now models the implemented system, not the pre-implementation V1 design. Codex CLI and dtach-only terminal persistence are in scope; Gemini CLI remains deferred.
> Updated 2026-05-19: Added the optional remote session-sharing surface to the model scope.

## Out Of Scope

- Gemini CLI adapter
- LLM-powered supervisor (Tier 2 — V2)
- Full cloud deployment of the core supervisor/agent runner
- Windows support

## Evidence Sources

- `README.md` — problem statement, design principles
- `docs/features.md` — user-facing feature catalog (F1-F5)
- `docs/architecture.md` — system design, component layout, type definitions
- `docs/roadmap.md` — historical 4-phase implementation plan
- `docs/adr/001-015` — accepted and superseding architecture decisions
- `src/core/`, `src/adapters/`, `src/server/`, `src/frontend/`, `src/shared/`, `src/integrations/`, `src/remote/`, `src/cli/` — implemented architecture

## Modeling Method

MBSE-lite: C4-inspired structural views + Mermaid behavioral views (sequences, state machines). Evidence-first — grounded in both the design docs and the current source tree listed above.

## Confidence And Limitations

- **High confidence:** System context, container boundaries, task lifecycle, terminal backend model — backed by ADRs and current TypeScript implementation.
- **Medium confidence:** Long-running operational workflows such as Ralph loops, checkpoint cycling, and workspace cleanup — implemented but evolving quickly.
- **Limitation:** The models summarize current behavior and do not enumerate every frontend component or test helper. Use the source tree as the authoritative exhaustive file list.
