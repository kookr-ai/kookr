import { describe, test, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SnoozeSuppressionTracker, isLivenessAnomaly } from './snooze-suppression.js';
import { Monitor } from './monitor.js';
import { TaskStore } from './tasks.js';
import { AttentionQueue } from './attention-queue.js';
import { saveTasks, loadTasks } from './task-persistence.js';

describe('SnoozeSuppressionTracker', () => {
  // --- Threshold ---

  test('does not suppress before threshold (3 snoozes)', () => {
    const tracker = new SnoozeSuppressionTracker();
    expect(tracker.recordSnooze('agent-1', 'stale_agent')).toBe(false);
    expect(tracker.recordSnooze('agent-1', 'stale_agent')).toBe(false);
    expect(tracker.isSuppressed('agent-1')).toBe(false);
    expect(tracker.shouldSuppress('agent-1', 'stale_agent')).toBe(false);
  });

  test('suppresses on third consecutive liveness snooze', () => {
    const tracker = new SnoozeSuppressionTracker();
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    const newlySuppressed = tracker.recordSnooze('agent-1', 'stale_agent');
    expect(newlySuppressed).toBe(true);
    expect(tracker.isSuppressed('agent-1')).toBe(true);
    expect(tracker.shouldSuppress('agent-1', 'stale_agent')).toBe(true);
  });

  test('returns false for subsequent snoozes after threshold (already suppressed)', () => {
    const tracker = new SnoozeSuppressionTracker();
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    expect(tracker.recordSnooze('agent-1', 'stale_agent')).toBe(true); // transition
    expect(tracker.recordSnooze('agent-1', 'stale_agent')).toBe(false); // already suppressed
  });

  // --- False-positive flag (decisive, immediate suppression) ---

  test('recordFalsePositive suppresses a liveness type on the first flag', () => {
    const tracker = new SnoozeSuppressionTracker();
    const newlySuppressed = tracker.recordFalsePositive('agent-1', 'stale_agent');
    expect(newlySuppressed).toBe(true);
    expect(tracker.isSuppressed('agent-1')).toBe(true);
    expect(tracker.shouldSuppress('agent-1', 'stale_agent')).toBe(true);
    // Also covers hook_disconnected, the other liveness type.
    expect(tracker.shouldSuppress('agent-1', 'hook_disconnected')).toBe(true);
  });

  test('recordFalsePositive returns false on the second flag (already suppressed)', () => {
    const tracker = new SnoozeSuppressionTracker();
    expect(tracker.recordFalsePositive('agent-1', 'hook_disconnected')).toBe(true);
    expect(tracker.recordFalsePositive('agent-1', 'hook_disconnected')).toBe(false);
  });

  test('recordFalsePositive ignores non-liveness types (no state change)', () => {
    const tracker = new SnoozeSuppressionTracker();
    expect(tracker.recordFalsePositive('agent-1', 'needs_input')).toBe(false);
    expect(tracker.isSuppressed('agent-1')).toBe(false);
  });

  test('reset clears false-positive-driven suppression', () => {
    const tracker = new SnoozeSuppressionTracker();
    tracker.recordFalsePositive('agent-1', 'stale_agent');
    expect(tracker.isSuppressed('agent-1')).toBe(true);
    tracker.reset('agent-1');
    expect(tracker.isSuppressed('agent-1')).toBe(false);
    expect(tracker.shouldSuppress('agent-1', 'stale_agent')).toBe(false);
  });

  // --- Category gating ---

  test('ignores non-liveness anomaly types', () => {
    const tracker = new SnoozeSuppressionTracker();
    expect(tracker.recordSnooze('agent-1', 'needs_input')).toBe(false);
    expect(tracker.recordSnooze('agent-1', 'permission_blocked')).toBe(false);
    expect(tracker.recordSnooze('agent-1', 'repeated_error')).toBe(false);
    expect(tracker.isSuppressed('agent-1')).toBe(false);
  });

  test('counts hook_disconnected as liveness (suppressible)', () => {
    const tracker = new SnoozeSuppressionTracker();
    tracker.recordSnooze('agent-1', 'hook_disconnected');
    tracker.recordSnooze('agent-1', 'hook_disconnected');
    expect(tracker.recordSnooze('agent-1', 'hook_disconnected')).toBe(true);
    expect(tracker.isSuppressed('agent-1')).toBe(true);
  });

  test('counts mixed liveness types towards threshold', () => {
    const tracker = new SnoozeSuppressionTracker();
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'hook_disconnected');
    expect(tracker.recordSnooze('agent-1', 'stale_agent')).toBe(true);
  });

  test('shouldSuppress returns false for non-liveness anomalies even when suppressed', () => {
    const tracker = new SnoozeSuppressionTracker();
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    expect(tracker.shouldSuppress('agent-1', 'needs_input')).toBe(false);
    expect(tracker.shouldSuppress('agent-1', 'stale_agent')).toBe(true);
  });

  // --- Reset ---

  test('reset clears suppression state', () => {
    const tracker = new SnoozeSuppressionTracker();
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    expect(tracker.isSuppressed('agent-1')).toBe(true);

    tracker.reset('agent-1');
    expect(tracker.isSuppressed('agent-1')).toBe(false);
    expect(tracker.shouldSuppress('agent-1', 'stale_agent')).toBe(false);
  });

  test('reset does not affect other agents', () => {
    const tracker = new SnoozeSuppressionTracker();
    // Suppress agent-1
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    // Suppress agent-2
    tracker.recordSnooze('agent-2', 'stale_agent');
    tracker.recordSnooze('agent-2', 'stale_agent');
    tracker.recordSnooze('agent-2', 'stale_agent');

    tracker.reset('agent-1');
    expect(tracker.isSuppressed('agent-1')).toBe(false);
    expect(tracker.isSuppressed('agent-2')).toBe(true);
  });

  // --- getSuppressedAgents ---

  test('getSuppressedAgents returns all suppressed agent IDs', () => {
    const tracker = new SnoozeSuppressionTracker();
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-2', 'stale_agent');
    tracker.recordSnooze('agent-2', 'stale_agent');
    // agent-2 not yet suppressed (only 2 snoozes)
    const suppressed = tracker.getSuppressedAgents();
    expect(suppressed).toEqual(['agent-1']);
  });

  // --- Persistence round-trip ---

  test('export/import preserves suppression state', () => {
    const tracker1 = new SnoozeSuppressionTracker();
    tracker1.recordSnooze('agent-1', 'stale_agent');
    tracker1.recordSnooze('agent-1', 'stale_agent');
    tracker1.recordSnooze('agent-1', 'stale_agent');
    tracker1.recordSnooze('agent-2', 'hook_disconnected');

    const exported = tracker1.export();
    expect(exported).toHaveLength(2);

    const tracker2 = new SnoozeSuppressionTracker();
    tracker2.import(exported);

    expect(tracker2.isSuppressed('agent-1')).toBe(true);
    expect(tracker2.isSuppressed('agent-2')).toBe(false);
    expect(tracker2.shouldSuppress('agent-1', 'stale_agent')).toBe(true);

    // agent-2 should need only 2 more snoozes to hit threshold (already at 1)
    tracker2.recordSnooze('agent-2', 'hook_disconnected');
    expect(tracker2.recordSnooze('agent-2', 'hook_disconnected')).toBe(true);
  });

  // --- Unknown agent ---

  test('isSuppressed returns false for unknown agent', () => {
    const tracker = new SnoozeSuppressionTracker();
    expect(tracker.isSuppressed('unknown')).toBe(false);
  });

  test('shouldSuppress returns false for unknown agent', () => {
    const tracker = new SnoozeSuppressionTracker();
    expect(tracker.shouldSuppress('unknown', 'stale_agent')).toBe(false);
  });

  test('reset is a no-op for unknown agent', () => {
    const tracker = new SnoozeSuppressionTracker();
    tracker.reset('unknown'); // should not throw
  });
});

describe('isLivenessAnomaly', () => {
  test('stale_agent is liveness', () => {
    expect(isLivenessAnomaly('stale_agent')).toBe(true);
  });

  test('hook_disconnected is liveness', () => {
    expect(isLivenessAnomaly('hook_disconnected')).toBe(true);
  });

  test('needs_input is not liveness', () => {
    expect(isLivenessAnomaly('needs_input')).toBe(false);
  });

  test('permission_blocked is not liveness', () => {
    expect(isLivenessAnomaly('permission_blocked')).toBe(false);
  });

  test('repeated_error is not liveness', () => {
    expect(isLivenessAnomaly('repeated_error')).toBe(false);
  });
});

describe('Monitor integration — suppressed flag in getSnapshot()', () => {
  test('suppressed agent has suppressed: true in snapshot', () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const tracker = new SnoozeSuppressionTracker();
    const monitor = new Monitor(taskStore, queue, undefined, undefined, tracker);

    monitor.registerAgent('agent-1');
    // Suppress the agent
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');

    const snapshot = monitor.getSnapshot();
    const agent = snapshot.find((a) => a.agentId === 'agent-1');
    expect(agent?.suppressed).toBe(true);
  });

  test('suppressed flag hidden when active non-liveness finding exists', () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const tracker = new SnoozeSuppressionTracker();
    const monitor = new Monitor(taskStore, queue, undefined, undefined, tracker);

    monitor.registerAgent('agent-1');
    // Suppress the agent
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');
    tracker.recordSnooze('agent-1', 'stale_agent');

    // Create a non-liveness anomaly (needs_input via stop event)
    monitor.processEvents('agent-1', [
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash' },
      { type: 'tool_result', sessionId: 's1', toolName: 'Bash' },
      { type: 'stop', sessionId: 's1', lastMessage: 'Need help' },
    ]);

    const snapshot = monitor.getSnapshot();
    const agent = snapshot.find((a) => a.agentId === 'agent-1');
    // Agent has needs_input anomaly (non-liveness), so suppressed should NOT be set
    expect(agent?.anomaly?.type).toBe('needs_input');
    expect(agent?.suppressed).toBeUndefined();
  });

  test('non-suppressed agent does not have suppressed flag', () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const tracker = new SnoozeSuppressionTracker();
    const monitor = new Monitor(taskStore, queue, undefined, undefined, tracker);

    monitor.registerAgent('agent-1');
    const snapshot = monitor.getSnapshot();
    const agent = snapshot.find((a) => a.agentId === 'agent-1');
    expect(agent?.suppressed).toBeUndefined();
  });
});

describe('Persistence round-trip — tasks.json envelope', () => {
  test('suppressionState is saved and restored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-test-'));
    const filePath = join(dir, 'tasks.json');

    try {
      // Create and suppress
      const tracker1 = new SnoozeSuppressionTracker();
      tracker1.recordSnooze('agent-1', 'stale_agent');
      tracker1.recordSnooze('agent-1', 'stale_agent');
      tracker1.recordSnooze('agent-1', 'stale_agent');
      tracker1.recordSnooze('agent-2', 'hook_disconnected');

      // Save
      await saveTasks([], filePath, 0, undefined, tracker1.export());

      // Load and restore
      const loaded = await loadTasks(filePath);
      expect(loaded.suppressionState).toBeDefined();
      expect(loaded.suppressionState).toHaveLength(2);

      const tracker2 = new SnoozeSuppressionTracker();
      tracker2.import(loaded.suppressionState!);

      expect(tracker2.isSuppressed('agent-1')).toBe(true);
      expect(tracker2.isSuppressed('agent-2')).toBe(false);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  test('loadTasks handles missing suppressionState gracefully', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-test-'));
    const filePath = join(dir, 'tasks.json');

    try {
      // Save without suppression state
      await saveTasks([], filePath, 0);

      const loaded = await loadTasks(filePath);
      expect(loaded.suppressionState).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
