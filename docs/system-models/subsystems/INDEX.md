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

## Terminal Backend Updates

All subsystem models were updated for ADR-007 on 2026-03-24: managed terminal sessions replace headless mode, so agents run continuously in interactive mode and input is delivered to the running process.

Updated 2026-05-09: ADR-014 is now the current terminal persistence decision. Production sessions are dtach-only through `LocalDtachBackend`; browser terminal views attach through `SessionBridge`; input is PTY byte writes rather than tmux `send-keys`; monitoring is structured hook JSONL, transcript JSONL, and watchdog signals rather than terminal-output polling.
