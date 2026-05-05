# Scope And Method

## Purpose

Document the V1 design of Kookr before implementation begins, to validate subsystem boundaries and surface design smells early.

## System In Scope

Kookr V1: local Node.js backend + browser SPA that launches, monitors, and routes developer attention across multiple AI coding agents (Claude Code only for V1). Agents run in interactive mode inside managed terminal sessions (tmux); Kookr monitors via terminal output capture and sends input via terminal keystrokes (ADR-007). Kookr only manages agents it launches itself — no discovery of external agents in V1.

## Out Of Scope

- Codex CLI and Gemini CLI adapters (Phase 4)
- LLM-powered supervisor (Tier 2 — V2)
- Plugin/extension system
- Session persistence and analytics
- Cloud deployment
- Windows support

## Evidence Sources

- `README.md` — problem statement, design principles
- `docs/features.md` — user-facing feature catalog (F1-F5)
- `docs/architecture.md` — system design, component layout, type definitions
- `docs/roadmap.md` — 4-phase implementation plan
- `docs/adr/001-007` — accepted and proposed architecture decisions (ADR-007: managed terminal sessions)

## Modeling Method

MBSE-lite: C4-inspired structural views + Mermaid behavioral views (sequences, state machines). Evidence-first — grounded in the design docs listed above.

## Confidence And Limitations

- **High confidence:** System context, container boundaries, agent lifecycle states — well-documented in ADRs with empirical research.
- **Medium confidence:** Supervisor internals, attention prioritization — design intent is clear but implementation details are TBD.
- **Limitation:** No source code exists yet. Models reflect designed architecture, not observed runtime behavior.
