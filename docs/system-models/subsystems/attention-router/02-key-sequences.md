# Attention Router — Key Sequences

## Purpose

Show the "respond, skip, snooze & advance" loop and all-clear detection.

## Primary Sequence: Respond & Auto-Advance

```mermaid
sequenceDiagram
  participant Dev as Developer
  participant SPA as Browser SPA
  participant Nav as Navigation Controller
  participant PQ as Priority Queue
  participant Adapter as Agent Adapter

  Dev->>SPA: Type response + send
  SPA->>Nav: WS: {type: "respond", agentId, input}
  Nav->>Adapter: sendInput(agentId, input)
  Adapter->>Adapter: write bytes to terminal session
  Nav->>PQ: remove(agentId)
  Nav->>PQ: getNext()
  alt Active queue has items
    PQ-->>Nav: nextAgentId
    Nav->>SPA: WS: {type: "update", navigate: nextAgentId}
  else Active empty, skipped has items
    PQ-->>Nav: nextSkippedAgentId
    Nav->>SPA: WS: {type: "update", navigate: nextSkippedAgentId}
  else All empty
    Nav->>SPA: WS: {type: "update", allClear: true}
  end
```

## Sequence: Skip & Auto-Advance

```mermaid
sequenceDiagram
  participant Dev as Developer
  participant SPA as Browser SPA
  participant Nav as Navigation Controller
  participant PQ as Priority Queue

  Dev->>SPA: Click Skip
  SPA->>Nav: WS: {type: "skip", agentId}
  Nav->>PQ: moveToSkipped(agentId)
  Nav->>PQ: getNext()
  alt Active queue has items
    PQ-->>Nav: nextAgentId
    Nav->>SPA: WS: {type: "update", navigate: nextAgentId}
  else Active empty, skipped has items
    PQ-->>Nav: nextSkippedAgentId (skipped tier sorted by severity)
    Nav->>SPA: WS: {type: "update", navigate: nextSkippedAgentId}
    Note over SPA: Skipped agents can cycle back; no distinct allSkipped queue state exists
  else All empty
    Nav->>SPA: WS: {type: "update", allClear: true}
  end
```

## Sequence: Snooze & Auto-Advance

```mermaid
sequenceDiagram
  participant Dev as Developer
  participant SPA as Browser SPA
  participant Nav as Navigation Controller
  participant PQ as Priority Queue
  participant ST as Snooze Timers
  participant Sup as Supervisor

  Dev->>SPA: Click Snooze + pick duration (+ optional reason)
  SPA->>Nav: WS: {type: "snooze", agentId, durationMs, reason?}
  Nav->>PQ: remove(agentId)
  Nav->>ST: startTimer(agentId, durationMs, reason)
  Note over Sup: Monitoring continues; queue suppresses resurfacing until expiry
  Nav->>PQ: getNext()
  PQ-->>Nav: nextAgentId (or allClear)
  Nav->>SPA: WS: {type: "update", navigate: ..., snoozed: {agentId, expiresAt, reason}}
```

## Sequence: Snooze Expires

```mermaid
sequenceDiagram
  participant ST as Snooze Timers
  participant Sup as Supervisor
  participant PQ as Priority Queue
  participant SPA as Browser SPA

  ST->>PQ: restoreExpiredSnoozes()
  PQ->>PQ: Move stored anomaly back to active tier
  PQ->>SPA: WS: {type: "alert", agentId, summary}
  Note over SPA: Agent re-enters queue if the snoozed anomaly was still stored
```

## Sequence: Alert Arrives While Developer Is Idle

```mermaid
sequenceDiagram
  participant Sup as Supervisor
  participant PQ as Priority Queue
  participant Nav as Navigation Controller
  participant SPA as Browser SPA

  Sup->>PQ: alert(agentId, summary, severity)
  PQ->>PQ: Insert at priority position in active tier
  PQ->>Nav: queueChanged()
  Nav->>SPA: WS: {type: "alert", agentId, summary, severity}
  Note over SPA: Agent highlighted in sidebar,<br/>browser notification if enabled
```

## Variant: Skipped Agent's State Changes

```mermaid
sequenceDiagram
  participant Sup as Supervisor
  participant PQ as Priority Queue
  participant SPA as Browser SPA

  Note over Sup: Supervisor still processes events for skipped agents
  Sup->>PQ: alert(agentId, newAnomaly)
  PQ->>PQ: Update anomaly and clear skipped flag if anomaly type changed
  PQ->>SPA: WS: {type: "alert", agentId, summary}
  Note over SPA: Agent re-enters active queue<br/>(new anomaly = fresh attention needed)
```

## Variant: Agent Completes Before Developer Responds (Issue #3)

```mermaid
sequenceDiagram
  participant PQ as Priority Queue
  participant ST as Snooze Timers
  participant SPA as Browser SPA
  participant Adapter as Agent Adapter

  Adapter->>PQ: agent completed (result event)
  PQ->>PQ: Remove from active or skipped tier
  PQ->>SPA: WS: {type: "update", agentId, state: "completed"}
  opt Agent was snoozed
    Adapter->>ST: cancelTimer(agentId)
  end
```

## Failure Or Recovery Variant

If the developer sends a response but terminal byte delivery fails (e.g., terminal session crashed), the adapter reports an error. The Navigation Controller keeps the agent in the queue and does not auto-advance.

## Handoff Notes

- The attention router delegates input delivery to the adapter. The adapter handles the byte write and reports failures.
- **~~Resume serialization~~ (issue #9, resolved by ADR-007):** No longer applicable. Input is delivered through the terminal backend's byte-write path — no subprocess spawning, no serialization needed.
- **Waiting for input (ADR-007, replaces issue #3):** agents natively block in interactive mode. The alert is actionable — the developer responds through the terminal backend. If the agent completes while waiting, the router handles the stale alert gracefully — remove from queue, show completed status.
- **Skip vs Snooze monitoring:** skipped and snoozed agents are still processed by the supervisor. Skips keep the anomaly in `entries` with `skipped: true`; snoozes move the anomaly into the `snoozed` map until expiry/manual wake/purge.

## Evidence

- `docs/features.md:76-85` — F3 features
- `docs/architecture.md:170-183` — WebSocket protocol

## Observed Smells

None.
