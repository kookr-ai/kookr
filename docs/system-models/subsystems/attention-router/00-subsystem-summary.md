# Attention Router — Summary

## Purpose

The attention router manages the developer-facing prioritization and navigation. It ranks agents by urgency, drives the "respond, skip, snooze & advance" loop, and determines the "all clear" state.

## Scope

- Maintain a priority-sorted queue of agents needing attention
- Serve "getNext" requests: which agent should the developer focus on?
- Handle three developer actions: **respond** (send input), **skip** (back of queue), **snooze** (pause monitoring + timer)
- Auto-advance to next agent after any action
- Detect "all clear" (no agents need attention) and "all skipped" (pending work but nothing active)
- Manage snooze timers and re-queue agents on expiry
- Push alerts and priority updates to the SPA via WebSocket

## Owned Responsibilities

- Priority queue of active alerts/bottlenecks
- Skip state: skipped agents form a back-of-queue tier
- Snooze timers: `(agentId, expiresAt, reason?)` — on expiry, signal the supervisor to resume polling
- Navigation state: which agent is currently selected
- "All clear" / "all skipped" determination
- WebSocket message dispatch to the SPA (alerts, updates, snapshots)

## Key Dependencies

- **supervisor-agent** — produces alerts that feed the priority queue; must be notified to pause/resume polling on snooze/wake
- **agent-adapter** — provides agent state for snapshots; process exit events can cancel snoozes
- **WebSocket** — transport to the SPA

## Non-Goals

- Does NOT detect anomalies (supervisor does that)
- Does NOT manage processes (adapter does that)
- Does NOT render UI (SPA does that)
- Does NOT auto-escalate repeated skips (deferred — see edge cases)

## Evidence

- `docs/features.md:76-85` — F3 "The Loop" feature set
- `docs/features.md:71-72` — F2.8 priority ranking
- `docs/architecture.md:170-183` — WebSocket message types

## Observed Smells

None. The attention router is a thin orchestration layer with clear inputs (alerts) and outputs (WS messages).
