# System Models

## Purpose

Architecture documentation for Kookr V1 using stable multi-level views. Models the designed system prior to implementation to validate boundaries and surface design smells early.

## Model Stack

- [00 Scope And Method](00-scope-and-method.md)
- [01 System Context](01-system-context.md)
- [02 Capability Map](02-capability-map.md)
- [03 Container View](03-container-view.md)
- [04 Runtime Interactions](04-runtime-interactions.md)
- [05 State Machine Catalog](05-state-machine-catalog.md)
- [06 Boundary And Responsibility Smells](06-boundary-and-responsibility-smells.md)
- [07 Decomposition Candidates](07-decomposition-candidates.md)
- [Subsystems](subsystems/INDEX.md)

## Current Hotspots

| Subsystem | Why It Matters | Status |
|---|---|---|
| supervisor-agent | Core differentiator: anomaly detection + explanation generation | modeled |
| agent-adapter | Bridges Kookr to Claude Code CLI; manages terminal sessions | modeled |
| attention-router | Priority ranking + "the loop" UX (respond, skip, snooze & advance) | modeled |

## Last Refresh Scope

- Initial V1 design-phase modeling (2026-03-23)
- Top-level views + 3 subsystem hotspots
- Removed agent discovery from V1 scope (interactive session files provide near-zero value without take-over)
- Updated for ADR-007: managed terminal sessions replace headless mode (2026-03-24)
- Monitoring approach validated: hooks + transcript JSONL — no ANSI terminal parsing needed (2026-03-24)
- Updated for ADR-008: session persistence inline in tasks.json, startup reconnection with tmux (2026-03-24)
- Updated for ADR-014: terminal persistence layer migrated from tmux to dtach; default flipped 2026-04-22 (Main B.b). Container / runtime / subsystem docs generalized to "terminal backend" (dtach = default, tmux = legacy)
