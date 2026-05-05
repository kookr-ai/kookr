# Subsystems

## Catalog

| Subsystem | Priority | Status |
|---|---|---|
| [supervisor-agent](supervisor-agent/00-subsystem-summary.md) | Core — differentiator | modeled |
| [agent-adapter](agent-adapter/00-subsystem-summary.md) | Core — agent bridge | modeled |
| [attention-router](attention-router/00-subsystem-summary.md) | Core — UX driver | modeled |

## Priority / Hotspot Rationale

All three subsystems are core to V1. They were selected because:
- **supervisor-agent** is the AI brain — most complex logic, most risk of scope creep
- **agent-adapter** bridges to external CLI processes via managed terminal sessions (ADR-007) — most coupling to external systems
- **attention-router** drives the primary UX loop — most impact on developer experience

## ADR-007 Update (2026-03-24)

All subsystem models updated to reflect ADR-007: managed terminal sessions replace headless mode. Agents run in interactive mode inside managed terminal sessions (tmux). Input via terminal keystrokes (send-keys), monitoring via terminal output capture. The `AskUserQuestion` behavioral contract is no longer needed — interactive mode is natively blocking.
