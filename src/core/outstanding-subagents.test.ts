import { describe, expect, test } from 'vitest';
import type { AgentEvent, Anomaly } from './types.js';
import {
  OutstandingSubagentTracker,
  SUBAGENT_SUPPRESSIBLE_TYPES,
  SUBAGENT_TTL_MS,
} from './outstanding-subagents.js';

function makeStart(subagentId: string): AgentEvent {
  return { type: 'subagent_start', sessionId: 's1', agentId: subagentId, agentType: 'general-purpose' };
}

function makeStopEvent(subagentId: string): AgentEvent {
  return {
    type: 'subagent_stop',
    sessionId: 's1',
    agentId: subagentId,
    agentType: 'general-purpose',
    lastMessage: 'done',
  };
}

function makeParentStop(opts?: {
  activeBackgroundTaskCount?: number;
  activeSessionCronCount?: number;
}): AgentEvent {
  return {
    type: 'stop',
    sessionId: 's1',
    lastMessage: 'parent stop',
    activeBackgroundTaskCount: opts?.activeBackgroundTaskCount,
    activeSessionCronCount: opts?.activeSessionCronCount,
  };
}

function makeAnomaly(type: Anomaly['type']): Anomaly {
  return {
    type,
    agentId: 'parent',
    explanation: 'test',
    detectedAt: new Date('2026-01-01T00:00:00.000Z'),
  } as Anomaly;
}

describe('OutstandingSubagentTracker', () => {
  test('tracks start/stop and suppresses needs_input while outstanding', () => {
    const tracker = new OutstandingSubagentTracker();
    const t0 = 1_000_000;
    tracker.updateFromEvent('parent', makeStart('sa-1'), t0);
    expect(tracker.size('parent')).toBe(1);

    const suppressed = tracker.suppressIfRunning(makeAnomaly('needs_input'), 'parent', t0 + 1_000);
    expect(suppressed.anomaly).toBeNull();
    expect(suppressed.remaining).toBe(1);
    expect(suppressed.evicted).toBe(0);

    tracker.updateFromEvent('parent', makeStopEvent('sa-1'), t0 + 2_000);
    const after = tracker.suppressIfRunning(makeAnomaly('needs_input'), 'parent', t0 + 3_000);
    expect(after.anomaly?.type).toBe('needs_input');
    expect(after.remaining).toBe(0);
  });

  test('holds suppression until all outstanding subagents clear', () => {
    const tracker = new OutstandingSubagentTracker();
    const t0 = 1_000_000;
    tracker.updateFromEvent('parent', makeStart('a'), t0);
    tracker.updateFromEvent('parent', makeStart('b'), t0);
    expect(tracker.suppressIfRunning(makeAnomaly('stale_agent'), 'parent', t0).anomaly).toBeNull();
    tracker.updateFromEvent('parent', makeStopEvent('a'), t0 + 1);
    expect(tracker.suppressIfRunning(makeAnomaly('stale_agent'), 'parent', t0 + 2).anomaly).toBeNull();
    tracker.updateFromEvent('parent', makeStopEvent('b'), t0 + 3);
    expect(tracker.suppressIfRunning(makeAnomaly('stale_agent'), 'parent', t0 + 4).anomaly?.type)
      .toBe('stale_agent');
  });

  test('empty agentId on subagent_start is a no-op', () => {
    const tracker = new OutstandingSubagentTracker();
    tracker.updateFromEvent('parent', {
      type: 'subagent_start',
      sessionId: 's1',
      agentId: '',
      agentType: 'general-purpose',
    });
    expect(tracker.size('parent')).toBe(0);
  });

  test('permission_blocked is never suppressed', () => {
    const tracker = new OutstandingSubagentTracker();
    tracker.updateFromEvent('parent', makeStart('sa-1'));
    const result = tracker.suppressIfRunning(makeAnomaly('permission_blocked'), 'parent');
    expect(result.anomaly?.type).toBe('permission_blocked');
    expect(result.evicted).toBe(0);
  });

  test('null anomaly passes through', () => {
    const tracker = new OutstandingSubagentTracker();
    tracker.updateFromEvent('parent', makeStart('sa-1'));
    expect(tracker.suppressIfRunning(null, 'parent').anomaly).toBeNull();
  });

  test('TTL eviction drops stale entries and reports evicted count', () => {
    const tracker = new OutstandingSubagentTracker();
    const t0 = 1_000_000;
    tracker.updateFromEvent('parent', makeStart('old'), t0);
    tracker.updateFromEvent('parent', makeStart('fresh'), t0 + 1_000);

    const justBefore = tracker.evictStale('parent', t0 + SUBAGENT_TTL_MS);
    expect(justBefore.remaining).toBe(2);
    expect(justBefore.evicted).toBe(0);

    const after = tracker.evictStale('parent', t0 + SUBAGENT_TTL_MS + 1);
    expect(after.evicted).toBe(1);
    expect(after.remaining).toBe(1);
    expect(tracker.size('parent')).toBe(1);

    // fresh still within its TTL → suppression holds, no further eviction
    const stillSuppressed = tracker.suppressIfRunning(
      makeAnomaly('hook_disconnected'),
      'parent',
      t0 + 1_000 + SUBAGENT_TTL_MS,
    );
    expect(stillSuppressed.anomaly).toBeNull();
    expect(stillSuppressed.remaining).toBe(1);
    expect(stillSuppressed.evicted).toBe(0);

    // past fresh's TTL → eviction lifts suppression
    const lifted = tracker.suppressIfRunning(
      makeAnomaly('hook_disconnected'),
      'parent',
      t0 + 1_000 + SUBAGENT_TTL_MS + 1,
    );
    expect(lifted.anomaly?.type).toBe('hook_disconnected');
    expect(lifted.evicted).toBe(1);
    expect(lifted.remaining).toBe(0);
  });

  test('final Stop with zero background work clears without counting orphans', () => {
    const tracker = new OutstandingSubagentTracker();
    tracker.updateFromEvent('parent', makeStart('phantom'));
    tracker.updateFromEvent('parent', makeParentStop({
      activeBackgroundTaskCount: 0,
      activeSessionCronCount: 0,
    }));
    expect(tracker.size('parent')).toBe(0);
    expect(tracker.flush('parent')).toBe(0);
  });

  test('final Stop with active session cron keeps outstanding entries', () => {
    const tracker = new OutstandingSubagentTracker();
    tracker.updateFromEvent('parent', makeStart('cron-owned'));
    tracker.updateFromEvent('parent', makeParentStop({
      activeBackgroundTaskCount: 0,
      activeSessionCronCount: 1,
    }));
    expect(tracker.size('parent')).toBe(1);
  });

  test('flush returns orphan count once then zero', () => {
    const tracker = new OutstandingSubagentTracker();
    tracker.updateFromEvent('parent', makeStart('a'));
    tracker.updateFromEvent('parent', makeStart('b'));
    expect(tracker.flush('parent')).toBe(2);
    expect(tracker.flush('parent')).toBe(0);
  });

  test('SUBAGENT_SUPPRESSIBLE_TYPES matches documented set', () => {
    expect([...SUBAGENT_SUPPRESSIBLE_TYPES].sort()).toEqual([
      'hook_disconnected',
      'needs_input',
      'stale_agent',
    ]);
  });
});
