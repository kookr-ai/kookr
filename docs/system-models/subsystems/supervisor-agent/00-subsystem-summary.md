# Supervisor Agent — Summary

## Purpose

The supervisor agent is Kookr's core intelligence. It reads normalized agent event streams, detects anomalies, generates human-readable explanations, and signals when agents need developer attention.

## Scope

- Consumes `AgentEvent` streams from all managed agents (derived from structured hook events + transcript JSONL by the adapter)
- Runs anomaly detection patterns against recent events (event-driven via `HookFileWatcher` — no round-robin polling)
- Produces `Alert` objects with severity, summary, and explanation
- Expresses live agent state through `AgentState.anomaly` (anomaly type/severity) and `AgentState.snoozedUntil` in `monitor.ts`. The `AgentStatus` enum in `types.ts` is kept only as metadata on persisted sessions (`SessionInfo.lastStatus`) — there is no live `AgentStatus` state machine

## Owned Responsibilities

- Event-driven processing of per-agent hook files (`HookFileWatcher` → `Monitor.processEvents`)
- Anomaly detection (V1 rule-based): `needs_input`, `permission_blocked`, `repeated_error`, plus liveness anomalies (`stale_agent`, `hook_disconnected`, `hook_missing`, `tmux_unresponsive`, `api_error`, `merge_conflict`)
- Explanation generation (V1 template-based)
- Sliding per-agent event window and agent registration/unregistration
- Snooze honouring: detections are still run but results are held via `AttentionQueue` until the snooze expires

## Key Dependencies

- **agent-adapter** — provides the normalized `AgentEvent` stream
- **attention-router** — consumes alerts produced by the supervisor; stores skipped/snoozed queue state while the supervisor continues processing events

## Non-Goals

- Does NOT parse hooks/transcript JSONL (adapter does that)
- Does NOT own process lifecycle (adapter does that)
- Does NOT decide UI routing (attention-router does that)
- Does NOT call LLMs in V1 (rule-based only)

## Evidence

- `docs/architecture.md:36-103` — supervisor agent description
- `docs/features.md:58-74` — F2 anomaly detection features
- `docs/architecture.md:68-73` — two-tier implementation approach

## Observed Smells

None remaining. Detection and explanation are separate concerns with a defined interface (`Anomaly` objects emitted from detector/watchdog/budget paths). V1 implements rule-based detectors in TypeScript; V2 can swap the template explainer for an LLM call. See `04-boundary-smells.md`.
