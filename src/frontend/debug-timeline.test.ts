import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearDebugTimeline,
  createDebugTimelineRingBuffer,
  getDebugTimelineEntries,
  recordStoreMutationDebugEvent,
  recordWebSocketDebugEvent,
  setDebugTimelineEnabledForTests,
} from './debug-timeline.js';
import type { AgentState } from '../shared/protocol.js';

describe('debug timeline', () => {
  beforeEach(() => {
    setDebugTimelineEnabledForTests(true);
    clearDebugTimeline();
  });

  test('evicts old ring buffer entries by capacity', () => {
    const buffer = createDebugTimelineRingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);

    expect(buffer.entries()).toEqual([2, 3, 4]);
  });

  test('does not capture when the flag is disabled', () => {
    setDebugTimelineEnabledForTests(false);

    recordWebSocketDebugEvent('inbound', '{"type":"snapshot"}', { type: 'snapshot' });

    expect(getDebugTimelineEntries()).toEqual([]);
  });

  test('captures websocket summaries and finding lifecycle transitions', () => {
    const before: AgentState[] = [{ agentId: 'agent-1', events: [], anomaly: null }];
    const after: AgentState[] = [{
      agentId: 'agent-1',
      events: [],
      anomaly: {
        agentId: 'agent-1',
        type: 'needs_input',
        severity: 'warning',
        explanation: 'Waiting',
        detectedAt: new Date('2026-06-05T00:00:00.000Z'),
      },
    }];

    recordWebSocketDebugEvent('inbound', '{"type":"update","agentId":"agent-1"}', { type: 'update', agentId: 'agent-1' });
    recordStoreMutationDebugEvent(before, after, ['agents'], { agents: after });

    const entries = getDebugTimelineEntries();
    expect(entries.map((entry) => entry.kind)).toEqual(['websocket', 'store', 'finding-lifecycle']);
    expect(entries[0].summary).toContain('inbound update');
    expect(entries[2].summary).toContain('finding agent-1: created needs_input');
  });
});
