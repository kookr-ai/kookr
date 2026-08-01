import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clearDebugTimeline,
  createDebugTimelineRingBuffer,
  ensureLongTaskObserverStarted,
  getDebugTimelineEntries,
  getLongTaskTimelineEntries,
  LONG_TASK_THRESHOLD_MS,
  measureSync,
  recordMeasuredDuration,
  recordStoreMutationDebugEvent,
  recordWebSocketDebugEvent,
  setDebugTimelineEnabledForTests,
  setLongTaskObserverEnabledForTests,
  stopLongTaskObserverForTests,
} from './debug-timeline.js';
import type { AgentState } from '../shared/protocol.js';

describe('debug timeline', () => {
  beforeEach(() => {
    setDebugTimelineEnabledForTests(true);
    clearDebugTimeline();
  });

  afterEach(() => {
    stopLongTaskObserverForTests();
    setLongTaskObserverEnabledForTests(null);
    setDebugTimelineEnabledForTests(null);
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

  test('samples measured durations at or above the long-task threshold even when debug is off', () => {
    setDebugTimelineEnabledForTests(false);

    recordMeasuredDuration('snapshot-apply', LONG_TASK_THRESHOLD_MS - 1, { agentCount: 3 });
    recordMeasuredDuration('snapshot-apply', LONG_TASK_THRESHOLD_MS, { agentCount: 12 });
    recordMeasuredDuration('xterm-write', 120.4, { byteLength: 2_000_000 });

    const entries = getLongTaskTimelineEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: 'longtask',
      summary: `longtask snapshot-apply: ${LONG_TASK_THRESHOLD_MS}ms`,
      payload: { source: 'snapshot-apply', durationMs: LONG_TASK_THRESHOLD_MS, agentCount: 12 },
    });
    expect(entries[1]).toMatchObject({
      kind: 'longtask',
      payload: { source: 'xterm-write', durationMs: 120.4, byteLength: 2_000_000 },
    });
  });

  test('measureSync records only slow critical paths', () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    now = 0;
    measureSync('snapshot-apply', () => {
      now = 10;
    }, { agentCount: 1 });
    expect(getLongTaskTimelineEntries()).toHaveLength(0);

    now = 100;
    measureSync('xterm-write', () => {
      now = 100 + LONG_TASK_THRESHOLD_MS + 5;
    }, { byteLength: 99 });
    const entries = getLongTaskTimelineEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({
      source: 'xterm-write',
      durationMs: LONG_TASK_THRESHOLD_MS + 5,
      byteLength: 99,
    });
  });

  test('starts PerformanceObserver(longtask) when enabled and records browser long tasks', () => {
    setLongTaskObserverEnabledForTests(true);

    const observe = vi.fn();
    const disconnect = vi.fn();
    let observerCallback: PerformanceObserverCallback | null = null;

    class MockPerformanceObserver {
      static supportedEntryTypes = ['longtask'];
      constructor(callback: PerformanceObserverCallback) {
        observerCallback = callback;
      }
      observe = observe;
      disconnect = disconnect;
      takeRecords = () => [];
    }

    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);

    ensureLongTaskObserverStarted();
    expect(observe).toHaveBeenCalledWith({ type: 'longtask', buffered: true });

    observerCallback?.(
      {
        getEntries: () => [{
          name: 'self',
          entryType: 'longtask',
          startTime: 1,
          duration: 88,
          toJSON: () => ({}),
        }],
        getEntriesByType: () => [],
        getEntriesByName: () => [],
      } as PerformanceObserverEntryList,
      {} as PerformanceObserver,
    );

    const entries = getLongTaskTimelineEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'longtask',
      payload: { source: 'browser-longtask', durationMs: 88, name: 'self' },
    });

    ensureLongTaskObserverStarted();
    expect(observe).toHaveBeenCalledTimes(1);
  });

  test('skips PerformanceObserver when long-task observer flag is off', () => {
    setLongTaskObserverEnabledForTests(false);
    const observe = vi.fn();

    class MockPerformanceObserver {
      static supportedEntryTypes = ['longtask'];
      constructor(_callback: PerformanceObserverCallback) {}
      observe = observe;
      disconnect = vi.fn();
      takeRecords = () => [];
    }

    vi.stubGlobal('PerformanceObserver', MockPerformanceObserver);
    ensureLongTaskObserverStarted();
    expect(observe).not.toHaveBeenCalled();
  });
});
