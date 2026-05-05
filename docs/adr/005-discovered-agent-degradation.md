# ADR-005: Discovered Agent Degradation Strategy

## Status

**Proposed**

## Context

Kookr distinguishes between **managed agents** (launched by Kookr in headless mode) and **discovered agents** (found via session files from processes Kookr didn't start). As documented in [ADR-004](004-agent-communication-protocol.md), discovered agents are metadata-only: Kookr cannot read their output streams or send them input.

However, completely ignoring discovered agents or treating them as inert metadata wastes opportunities. Some discovered agents may have been started with launch options partially or fully compatible with Kookr's monitoring requirements. A degradation strategy that extracts maximum value from each discovered agent — based on what's actually available — is preferable to a binary "full support or nothing" approach.

## Problem

The README quick-start and features doc promise that `npx kookr` "discovers running agents" and the supervisor "starts watching." In reality, discovered agents cannot be watched in the same way as managed agents. This creates a misleading user experience if we don't define exactly what "discovered" means and what capabilities are available at each degradation level.

## Options

### Option A: Ignore discovered agents entirely

Remove discovery from V1. Only show Kookr-launched agents.

**Pros:**
- Simplest implementation
- No user confusion about tiers

**Cons:**
- Loses a key use case (aegiscore spawns agents that Kookr should know about)
- No visibility into the developer's full agent fleet
- Wastes information that's freely available

### Option B: Metadata-only with "switch to terminal" action

Show discovered agents with whatever metadata is available (PID, cwd, start time) and a "switch to terminal" or "open in terminal" action. No monitoring, no input delivery.

**Pros:**
- Honest about limitations
- Still useful as an inventory view

**Cons:**
- Minimal value — barely better than `ps aux | grep claude`
- "Switch to terminal" requires knowing which terminal the agent runs in (not always possible)

### Option C: Tiered degradation based on available signals (recommended)

Define multiple degradation levels based on what Kookr can actually observe for a discovered agent. Extract maximum value at each tier:

| Tier | Condition | Capabilities |
|------|-----------|-------------|
| **Tier 1: Metadata-only** | Session file exists, PID alive (Claude Code) or file recently modified (Codex) | Show: agent type, cwd, start time, alive/stale status. Action: "open terminal" |
| **Tier 2: Log tailing** | Agent writes to a known log file or the rollout JSONL is actively appended | Tail the rollout/log file for recent events. Show: last N events, basic activity status (idle vs active). Limited anomaly detection (e.g., detect if output stopped). |
| **Tier 3: Compatible launch** | Discovered agent was started with `--output-format stream-json` (detectable from session metadata or process args via `/proc/{pid}/cmdline` on Linux) | Attach to the JSONL output if the stream is accessible (e.g., the agent writes to a file or named pipe). Near-managed-level monitoring, but no input delivery unless session resume is viable. |
| **Tier 4: Take over** | User explicitly requests Kookr to take control | Terminate original process (with confirmation), resume session via `--resume <sessionId>` under Kookr's control. Becomes a fully managed agent. |

**Pros:**
- Maximizes value from each agent regardless of how it was started
- Clear expectations at each tier — UI can show the current tier and what's available
- Codex agents (no PID) naturally land in Tier 1-2 based on file mtime
- Compatible agents started by other automation (e.g., aegiscore) could reach Tier 3
- Tier 4 provides a migration path to full control

**Cons:**
- More implementation complexity
- `/proc/{pid}/cmdline` is Linux-only (macOS needs `ps -o args=`)
- Tier 3 depends on whether the JSONL output is written to a file (may not be if piped)
- Tier 4 "take over" has the session conflict risks described in ADR-004 Option D

### Option D: Separate "discovered" status with no-monitoring badge

Show discovered agents in the sidebar with a distinct visual treatment (dimmed, different icon) and a tooltip explaining why monitoring is limited. No attempt at degraded monitoring.

**Pros:**
- Simple to implement
- Clear visual distinction

**Cons:**
- Misses the opportunity to extract value from compatible agents
- Binary (managed vs discovered) doesn't reflect the actual capability spectrum

## Decision

**Option C: Tiered degradation** — but fully deferred from V1.

Agent discovery was removed from V1 scope after analysis showed near-zero value: headless sessions (`-p`) do not create session files, so Kookr-managed agents are invisible to discovery. Interactive sessions are metadata-only with no monitoring or input capability. The implementation cost is not justified until "take over" (Tier 4) makes discovered agents actionable.

Planned rollout (when demand warrants):
- **Future**: Tier 1 (metadata-only) for all discovered agents. UI clearly labels them as "Discovered" with available metadata.
- **Future**: Tier 2 (log tailing) for Codex agents (their rollout JSONL files are on disk and appendable).
- **Future**: Tier 3 (compatible launch detection) and Tier 4 (take over) as demand warrants.

## Consequences

- UI must visually distinguish managed vs discovered agents AND show the current capability tier
- Agent type determines the best available tier (Claude Code has PID → Tier 1+; Codex has rollout files → Tier 2 candidate)
- The `AgentInfo` type must include a `tier` or `capabilities` field so the frontend knows what actions to offer
- Codex rollout JSONL tailing (Tier 2) requires a file watcher, not stdout parsing — different code path from managed agent monitoring
- "Take over" (Tier 4) must warn the user that the original terminal session will be terminated
- On macOS, process arg inspection requires `ps` instead of `/proc` — adapter needed

## Implementation Notes

### Tier detection logic

```typescript
type DiscoveryTier = 1 | 2 | 3 | 4;

interface DiscoveredAgent {
  type: 'claude-code' | 'codex-cli';
  tier: DiscoveryTier;
  metadata: {
    pid?: number;         // Claude Code only
    threadId?: string;    // Codex only
    cwd: string;
    startedAt: string;
    alive: boolean;       // PID check (Claude) or mtime-based (Codex)
  };
  capabilities: {
    canMonitor: boolean;  // Tier 2+
    canTakeOver: boolean; // Tier 4
  };
}

function detectTier(agent: DiscoveredAgent): DiscoveryTier {
  // Tier 3: check if launched with --output-format stream-json
  if (agent.type === 'claude-code' && agent.metadata.pid) {
    const args = getProcessArgs(agent.metadata.pid); // /proc or ps
    if (args?.includes('--output-format') && args?.includes('stream-json')) {
      return 3;
    }
  }

  // Tier 2: Codex rollout files are always on disk and appendable
  if (agent.type === 'codex-cli') {
    return 2;
  }

  // Tier 1: metadata only
  return 1;
}
```

### UI treatment per tier

| Tier | Sidebar icon | Detail panel | Available actions |
|------|-------------|-------------|-------------------|
| 1 | Dimmed circle | Metadata only: type, cwd, uptime | "Open terminal" |
| 2 | Half-filled circle | Metadata + recent activity (tailed) | "Open terminal" |
| 3 | Nearly-full circle | Near-real-time event stream | "Open terminal", "Take over" (future) |
| 4 | Full circle (same as managed) | Full monitoring + input | All managed actions |
