import { describe, test, expect, beforeEach } from 'vitest';
import type { AgentEvent } from './types.js';
import { Monitor } from './monitor.js';
import { TaskStore } from './tasks.js';
import { AttentionQueue } from './attention-queue.js';

function toolUse(sessionId: string, i: number): AgentEvent {
  return { type: 'tool_use', sessionId, toolName: 'Bash', toolInput: { command: `echo ${i}` }, toolUseId: `t${i}` };
}

/**
 * Issue #1612 — the Monitor accumulated per-agent retention that no path cleared
 * (suppressedCompletionSignalIds, ttlEvictedSubagentEventCounts), and the
 * suppressed-signal set grew without bound within a single long-lived session.
 */
describe('Monitor retention (issue #1612)', () => {
  let taskStore: TaskStore;
  let queue: AttentionQueue;
  let monitor: Monitor;

  beforeEach(() => {
    taskStore = new TaskStore();
    queue = new AttentionQueue();
    monitor = new Monitor(taskStore, queue);
  });

  test('getRetentionMetrics reports live per-agent counts', () => {
    monitor.registerAgent('agent-a');
    monitor.processEvents('agent-a', [toolUse('agent-a', 1), toolUse('agent-a', 2)]);
    monitor.registerAgent('agent-b');
    monitor.processEvents('agent-b', [toolUse('agent-b', 1)]);

    const metrics = monitor.getRetentionMetrics();
    expect(metrics.agents).toBe(2);
    expect(metrics.retainedEvents).toBe(3);
    // All maps present as numeric fields.
    for (const key of [
      'stoppedAgents',
      'suppressedCompletionSignalAgents',
      'suppressedCompletionSignalIds',
      'ttlEvictedSubagentCounts',
      'outstandingSubagentParents',
    ]) {
      expect(typeof metrics[key]).toBe('number');
    }
  });

  test('unregisterAgent releases the per-agent event window', () => {
    monitor.registerAgent('agent-a');
    monitor.processEvents('agent-a', [toolUse('agent-a', 1)]);
    expect(monitor.getRetentionMetrics().agents).toBe(1);

    monitor.unregisterAgent('agent-a');
    const metrics = monitor.getRetentionMetrics();
    expect(metrics.agents).toBe(0);
    expect(metrics.retainedEvents).toBe(0);
  });

  test('unregisterAgent clears the two maps that previously leaked', () => {
    // Populate BOTH maps first so the post-teardown assertions are meaningful
    // (not a 0-stays-0 tautology).
    const internal = monitor as unknown as {
      rememberSuppressedCompletionSignal(agentId: string, id: string): void;
      ttlEvictedSubagentEventCounts: Map<string, number>;
    };
    monitor.registerAgent('agent-a');
    monitor.processEvents('agent-a', [{ type: 'subagent_start', sessionId: 'agent-a', agentId: 'sub-1', agentType: 't' }]);
    internal.rememberSuppressedCompletionSignal('agent-a', 'signal-1');
    // Drive the real TTL-eviction bookkeeping path (markSnapshotTtlEviction).
    (monitor as unknown as {
      evictStaleSubagents(agentId: string, now: number, options: { markSnapshotTtlEviction?: boolean }): number;
    }).evictStaleSubagents('agent-a', Date.now() + 60 * 60 * 1000, { markSnapshotTtlEviction: true });

    const before = monitor.getRetentionMetrics();
    expect(before.suppressedCompletionSignalIds).toBe(1);
    expect(before.ttlEvictedSubagentCounts).toBe(1);

    monitor.unregisterAgent('agent-a');
    const after = monitor.getRetentionMetrics();
    expect(after.suppressedCompletionSignalAgents).toBe(0);
    expect(after.suppressedCompletionSignalIds).toBe(0);
    expect(after.ttlEvictedSubagentCounts).toBe(0);
  });

  test('suppressed completion-signal ids are bounded per agent', () => {
    // Access the private helper without booting the full snapshot-projection
    // path (which needs subagent-stall wiring). The retention contract under
    // test is purely the set-size cap.
    const remember = (
      monitor as unknown as { rememberSuppressedCompletionSignal(agentId: string, id: string): void }
    ).rememberSuppressedCompletionSignal.bind(monitor);

    for (let i = 0; i < 500; i++) remember('agent-a', `signal-${i}`);

    const metrics = monitor.getRetentionMetrics();
    expect(metrics.suppressedCompletionSignalAgents).toBe(1);
    // Bounded well below the 500 inserted (cap is 128).
    expect(metrics.suppressedCompletionSignalIds).toBeLessThanOrEqual(128);

    // Newest ids are retained; the oldest were evicted.
    const isSuppressed = (
      monitor as unknown as { isSuppressedCompletionSignal(agentId: string, id: string): boolean }
    ).isSuppressedCompletionSignal.bind(monitor);
    expect(isSuppressed('agent-a', 'signal-499')).toBe(true);
    expect(isSuppressed('agent-a', 'signal-0')).toBe(false);
  });

  test('suppressed completion-signal set is dropped on unregister', () => {
    const remember = (
      monitor as unknown as { rememberSuppressedCompletionSignal(agentId: string, id: string): void }
    ).rememberSuppressedCompletionSignal.bind(monitor);
    monitor.registerAgent('agent-a');
    remember('agent-a', 'signal-1');
    expect(monitor.getRetentionMetrics().suppressedCompletionSignalIds).toBe(1);

    monitor.unregisterAgent('agent-a');
    expect(monitor.getRetentionMetrics().suppressedCompletionSignalIds).toBe(0);
    expect(monitor.getRetentionMetrics().suppressedCompletionSignalAgents).toBe(0);
  });
});
