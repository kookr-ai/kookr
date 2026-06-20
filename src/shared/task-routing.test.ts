import { describe, expect, it } from 'vitest';
import type { AgentState } from './protocol.js';
import type { AnomalySeverity } from './contracts/anomalies.js';
import {
  isActiveFinding,
  isHealthyRunning,
  isRoutableAgent,
  selectNextRoutableSessionId,
} from './task-routing.js';

function agent(agentId: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    ...overrides,
  };
}

function finding(agentId: string, severity: AnomalySeverity = 'warning', overrides: Partial<AgentState> = {}): AgentState {
  return agent(agentId, {
    anomaly: { type: 'needs_input', agentId, severity, explanation: 'waiting', detectedAt: new Date() },
    ...overrides,
  });
}

describe('routability predicates', () => {
  it('classifies findings, healthy, and excluded agents', () => {
    const aFinding = finding('a');
    const aHealthy = agent('b');
    expect(isActiveFinding(aFinding)).toBe(true);
    expect(isHealthyRunning(aHealthy)).toBe(true);

    // Findings and healthy are mutually exclusive classifications.
    expect(isHealthyRunning(aFinding)).toBe(false);
    expect(isActiveFinding(aHealthy)).toBe(false);

    const snoozed = finding('c', 'warning', { snoozedUntil: Date.now() + 1000 });
    const suppressed = agent('d', { suppressed: true });
    const pending = agent('e', { taskStatus: 'pending' });
    const terminal = agent('f', { taskStatus: 'completed' });

    for (const excluded of [snoozed, suppressed, pending, terminal]) {
      expect(isRoutableAgent(excluded)).toBe(false);
      expect(isActiveFinding(excluded)).toBe(false);
      expect(isHealthyRunning(excluded)).toBe(false);
    }
    expect(isRoutableAgent(aFinding)).toBe(true);
    expect(isRoutableAgent(aHealthy)).toBe(true);

    // `open` is a non-pending, non-terminal status, so it stays routable —
    // matching the frontend predicates the server now mirrors.
    expect(isHealthyRunning(agent('g', { taskStatus: 'open' }))).toBe(true);
  });
});

describe('selectNextRoutableSessionId', () => {
  it('follows the frontend-provided order and advances past the current session', () => {
    const agents = [finding('s1'), agent('s2'), agent('s3')];
    const result = selectNextRoutableSessionId({
      orderedSessionIds: ['s1', 's2', 's3'],
      currentSessionId: 's1',
      agents,
    });
    expect(result.next).toEqual({ sessionId: 's2', taskId: 'task-s2' });
    expect(result.diagnostics).toMatchObject({
      source: 'frontend-order',
      candidateCount: 3,
      routableCount: 3,
      excludedCount: 0,
      currentInOrder: true,
      selectedSessionId: 's2',
    });
  });

  it('wraps around to the first routable entry from the last', () => {
    const agents = [finding('s1'), agent('s2')];
    const result = selectNextRoutableSessionId({
      orderedSessionIds: ['s1', 's2'],
      currentSessionId: 's2',
      agents,
    });
    expect(result.next?.sessionId).toBe('s1');
  });

  it('never advances to pending, terminal, snoozed, or suppressed tasks even if listed', () => {
    const agents = [
      finding('s1'),
      agent('pending', { taskStatus: 'pending' }),
      agent('terminal', { taskStatus: 'cancelled' }),
      finding('snoozed', 'warning', { snoozedUntil: Date.now() + 5000 }),
      agent('suppressed', { suppressed: true }),
      agent('healthy'),
    ];
    const orderedSessionIds = ['s1', 'pending', 'terminal', 'snoozed', 'suppressed', 'healthy'];
    const result = selectNextRoutableSessionId({ orderedSessionIds, currentSessionId: 's1', agents });

    // Only s1 and healthy survive; next after s1 is healthy.
    expect(result.next?.sessionId).toBe('healthy');
    expect(result.diagnostics).toMatchObject({
      candidateCount: 6,
      routableCount: 2,
      excludedCount: 4,
    });
  });

  it('drops candidate ids missing from the authoritative snapshot (stale client view)', () => {
    const agents = [finding('s1'), agent('s3')];
    const result = selectNextRoutableSessionId({
      // s2 was in the client view but is gone server-side.
      orderedSessionIds: ['s1', 's2', 's3'],
      currentSessionId: 's1',
      agents,
    });
    expect(result.next?.sessionId).toBe('s3');
    expect(result.diagnostics.excludedCount).toBe(1);
  });

  it('starts from the first routable entry when the current session is not routable', () => {
    const agents = [finding('s1'), agent('s2')];
    const result = selectNextRoutableSessionId({
      orderedSessionIds: ['s1', 's2'],
      currentSessionId: 'gone',
      agents,
    });
    expect(result.next?.sessionId).toBe('s1');
    expect(result.diagnostics.currentInOrder).toBe(false);
  });

  it('dedupes repeated session ids in the provided order', () => {
    const agents = [finding('s1'), agent('s2')];
    const result = selectNextRoutableSessionId({
      orderedSessionIds: ['s1', 's1', 's2'],
      currentSessionId: 's1',
      agents,
    });
    expect(result.next?.sessionId).toBe('s2');
    expect(result.diagnostics.routableCount).toBe(2);
    // The duplicate collapsed by dedupe is not counted as an exclusion.
    expect(result.diagnostics.excludedCount).toBe(0);
  });

  it('falls back to snapshot order (findings before healthy) when no list is provided', () => {
    const agents = [agent('healthy1'), finding('finding1'), agent('healthy2')];
    const result = selectNextRoutableSessionId({ currentSessionId: 'finding1', agents });
    // Fallback order is [finding1, healthy1, healthy2]; next after finding1 is healthy1.
    expect(result.next?.sessionId).toBe('healthy1');
    expect(result.diagnostics).toMatchObject({
      source: 'fallback-snapshot-order',
      candidateCount: 0,
      routableCount: 3,
    });
  });

  it('excludes pending/terminal/snoozed/suppressed in the fallback path too', () => {
    const agents = [
      finding('finding1'),
      agent('pending', { taskStatus: 'pending' }),
      agent('terminal', { taskStatus: 'terminated' }),
      finding('snoozed', 'warning', { snoozedUntil: Date.now() + 5000 }),
      agent('suppressed', { suppressed: true }),
      agent('healthy1'),
    ];
    const result = selectNextRoutableSessionId({ currentSessionId: 'finding1', agents });
    // Only finding1 + healthy1 survive; next after finding1 is healthy1.
    expect(result.next?.sessionId).toBe('healthy1');
    expect(result.diagnostics).toMatchObject({
      source: 'fallback-snapshot-order',
      routableCount: 2,
    });
  });

  it('returns null when nothing routable remains', () => {
    const agents = [agent('pending', { taskStatus: 'pending' })];
    const result = selectNextRoutableSessionId({
      orderedSessionIds: ['pending'],
      currentSessionId: 'pending',
      agents,
    });
    expect(result.next).toBeNull();
    expect(result.diagnostics.selectedSessionId).toBeNull();
  });
});
