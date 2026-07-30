import { describe, expect, it } from 'vitest';
import type { MonitorAgentState } from './monitor.js';
import {
  AGENT_STATE_PROJECTION_ONLY_KEYS,
  toClientAgentState,
  type AgentStateProjectionOnlyKey,
} from './monitor-agent-state.js';
import type { AgentState } from '../shared/contracts/agent-state.js';

/** Compile-time: every live key must exist on the wire DTO. */
type LiveKeys = keyof MonitorAgentState;
type WireKeys = keyof AgentState;
type LiveMissingOnWire = Exclude<LiveKeys, WireKeys>;
type _AssertLiveIsWireSubset = LiveMissingOnWire extends never ? true : LiveMissingOnWire;
const _liveIsWireSubset: _AssertLiveIsWireSubset = true;

/** Compile-time: projection-only keys must not appear on live state. */
type ProjectionLeakedOntoLive = Extract<LiveKeys, AgentStateProjectionOnlyKey>;
type _AssertNoProjectionOnLive = ProjectionLeakedOntoLive extends never ? true : ProjectionLeakedOntoLive;
const _noProjectionOnLive: _AssertNoProjectionOnLive = true;

/** Compile-time: projection key list is exhaustive vs the union. */
type Listed = (typeof AGENT_STATE_PROJECTION_ONLY_KEYS)[number];
type _AssertListMatchesUnion =
  Listed extends AgentStateProjectionOnlyKey
    ? AgentStateProjectionOnlyKey extends Listed
      ? true
      : never
    : never;
const _listMatchesUnion: _AssertListMatchesUnion = true;

// Keep compile-time asserts referenced so unused-local lint cannot drop them.
void _liveIsWireSubset;
void _noProjectionOnLive;
void _listMatchesUnion;

describe('MonitorAgentState ↔ wire AgentState (issue #1460)', () => {
  it('lists the known projection-only wire fields', () => {
    expect([...AGENT_STATE_PROJECTION_ONLY_KEYS].sort()).toEqual([
      'childRollup',
      'effectiveAttentionSeverity',
      'pendingSignal',
      'reapOutcome',
      'stuckReason',
      'terminalInputSnapshot',
    ]);
  });

  it('maps live monitor state into the client AgentState shape without projection fields', () => {
    const live: MonitorAgentState = {
      agentId: 'sess-1',
      events: [],
      anomaly: null,
      lastEventSeq: 0,
      taskId: 'task-1',
      taskStatus: 'inProgress',
    };
    const client = toClientAgentState(live);
    expect(client.agentId).toBe('sess-1');
    expect(client.taskId).toBe('task-1');
    expect(client.pendingSignal).toBeUndefined();
    expect(client.childRollup).toBeUndefined();
    expect(client.stuckReason).toBeUndefined();
    expect(client.terminalInputSnapshot).toBeUndefined();
    expect(client.effectiveAttentionSeverity).toBeUndefined();
    expect(client.reapOutcome).toBeUndefined();

    // Caller may layer projection fields on the wire DTO after mapping.
    const withSignal: AgentState = {
      ...client,
      pendingSignal: { kind: 'completion_ready', raisedAt: '2026-01-01T00:00:00.000Z' },
    };
    expect(withSignal.pendingSignal?.kind).toBe('completion_ready');
  });
});
