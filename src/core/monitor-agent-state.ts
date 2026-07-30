/**
 * Live monitor agent state vs client/wire AgentState (issue #1460).
 *
 * Wire/protocol SSOT: `src/shared/contracts/agent-state.ts` (`AgentState`).
 * Live/internal SSOT: `MonitorAgentState` in `monitor.ts` — the fields Monitor
 * actually materializes. Projection-only fields are attached in snapshot
 * builders (`snapshot-projection`, `get-snapshot`), never by Monitor itself.
 *
 * Nested value types (Anomaly, AgentEvent, …) may still exist in both core and
 * shared forms; this module unifies the *AgentState field surface* and
 * documents the live→client map. Nested dualism is out of scope for #1460.
 */
import type { AgentState } from '../shared/contracts/agent-state.js';
import type { MonitorAgentState } from './monitor.js';

/**
 * Fields that exist on the client/wire {@link AgentState} but are never set
 * by {@link Monitor.getSnapshot} / {@link Monitor.getAgentState}. Snapshot
 * projection and client enrichment populate them.
 */
export type AgentStateProjectionOnlyKey =
  | 'childRollup'
  | 'effectiveAttentionSeverity'
  | 'pendingSignal'
  | 'reapOutcome'
  | 'stuckReason'
  | 'terminalInputSnapshot';

/** Runtime list of {@link AgentStateProjectionOnlyKey} for tests and docs. */
export const AGENT_STATE_PROJECTION_ONLY_KEYS = [
  'childRollup',
  'effectiveAttentionSeverity',
  'pendingSignal',
  'reapOutcome',
  'stuckReason',
  'terminalInputSnapshot',
] as const satisfies readonly AgentStateProjectionOnlyKey[];

/**
 * Map live monitor state into the client/wire {@link AgentState} shape.
 * Projection-only fields are left absent; callers layer them on after mapping.
 *
 * Uses a structural cast: live and wire share the same field names, but nested
 * core vs shared value types are not yet nominally identical (tracked separately).
 */
export function toClientAgentState(live: MonitorAgentState): AgentState {
  return { ...live } as AgentState;
}
