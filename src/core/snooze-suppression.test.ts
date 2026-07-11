import { describe, test, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { FindingDeduplicator, SnoozeSuppressionTracker, isLivenessAnomaly } from './snooze-suppression.js';
import type { Anomaly } from './types.js';
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

describe('FindingDeduplicator', () => {
  const T0 = Date.parse('2026-07-02T11:16:00Z');

  function needsInput(message: string, overrides: Partial<Anomaly> = {}): Anomaly {
    return {
      agentId: 'kookr-68cc479d',
      type: 'needs_input',
      severity: 'info',
      subType: 'stop',
      explanation: `Agent is waiting for input. Last message: "${message}"`,
      detectedAt: new Date(T0),
      ...overrides,
    };
  }

  // --- Dedup: the reported five-sweep snooze storm collapses to one finding ---

  test('five equivalent needs_input sweeps produce one logical finding', () => {
    const dedup = new FindingDeduplicator();
    const input = { taskId: 'task-42' };

    // Five supervision sweeps across four sessions, snoozed each time in the
    // real incident. Sessions rotate (agentId changes) and the question text
    // drifts superficially (quoting/whitespace/casing) but is unchanged.
    const sweeps = [
      needsInput('Should I deploy to prod?', { agentId: 'kookr-s1' }),
      needsInput('should i deploy to prod', { agentId: 'kookr-s1' }),
      needsInput('Should I deploy to prod?  ', { agentId: 'kookr-s2' }),
      needsInput('SHOULD I DEPLOY TO PROD?', { agentId: 'kookr-s3' }),
      needsInput('Should I deploy to prod?', { agentId: 'kookr-s4' }),
    ];

    const dispositions = sweeps.map((a, i) => dedup.record(a, input, T0 + i * 1000).disposition);

    expect(dispositions).toEqual(['created', 'deduplicated', 'deduplicated', 'deduplicated', 'deduplicated']);

    const findings = dedup.snapshot();
    expect(findings).toHaveLength(1);
    expect(findings[0].occurrences).toBe(5);
    expect(findings[0].taskId).toBe('task-42');
    expect(findings[0].history).toHaveLength(0);
  });

  test('snooze-until survives later equivalent sweeps until expiry', () => {
    const dedup = new FindingDeduplicator();
    const input = { taskId: 'task-42' };
    const until = T0 + 60 * 60 * 1000; // snoozed one hour

    dedup.record(needsInput('Should I deploy?'), input, T0);
    dedup.snooze(needsInput('Should I deploy?'), input, until, T0 + 10);

    // A later sweep re-detects the same question — must stay hidden, not re-alert.
    const again = dedup.record(needsInput('Should I deploy?'), input, T0 + 20_000);
    expect(again.disposition).toBe('deduplicated');
    expect(again.record.snoozeUntil).toBe(until);
    expect(dedup.isSnoozed(needsInput('Should I deploy?'), input, T0 + 20_000)).toBe(true);

    // ...and surfaces again once the snooze expires.
    expect(dedup.isSnoozed(needsInput('Should I deploy?'), input, until + 1)).toBe(false);
  });

  // --- Supersede: a materially changed question is not hidden behind a stale snooze ---

  test('a materially changed question supersedes and clears the snooze', () => {
    const dedup = new FindingDeduplicator();
    const input = { taskId: 'task-42' };
    const until = T0 + 60 * 60 * 1000;

    dedup.record(needsInput('Should I deploy to prod?'), input, T0);
    dedup.snooze(needsInput('Should I deploy to prod?'), input, until, T0 + 10);

    const changed = dedup.record(needsInput('Should I roll back the migration?'), input, T0 + 20_000);

    expect(changed.disposition).toBe('superseded');
    // Same logical finding (stable id), but resurfaced: snooze cleared.
    expect(changed.record.findingId).toBe(dedup.snapshot()[0].findingId);
    expect(changed.record.snoozeUntil).toBeNull();
    expect(dedup.isSnoozed(needsInput('Should I roll back the migration?'), input, T0 + 20_000)).toBe(false);

    // Audit trail preserves the prior question and its snooze-until.
    expect(changed.record.history).toHaveLength(1);
    expect(changed.record.history[0].reason).toBe('superseded');
    expect(changed.record.history[0].snoozeUntil).toBe(until);
    expect(changed.record.history[0].context).toContain('deploy to prod');
    expect(changed.record.occurrences).toBe(1);
  });

  test('a changed stateVersion supersedes even when the question text is unchanged', () => {
    const dedup = new FindingDeduplicator();
    const anomaly = needsInput('Should I deploy?');

    expect(dedup.record(anomaly, { taskId: 'task-42', stateVersion: 1 }, T0).disposition).toBe('created');
    const bumped = dedup.record(anomaly, { taskId: 'task-42', stateVersion: 2 }, T0 + 1000);
    expect(bumped.disposition).toBe('superseded');
    expect(bumped.record.history).toHaveLength(1);
  });

  // --- Resolution history + lineage separation ---

  test('resolve returns the audit trail and lets a later detection open a fresh finding', () => {
    const dedup = new FindingDeduplicator();
    const input = { taskId: 'task-42' };
    const until = T0 + 60 * 60 * 1000;

    dedup.record(needsInput('Should I deploy?'), input, T0);
    dedup.snooze(needsInput('Should I deploy?'), input, until, T0 + 5);

    const resolved = dedup.resolve(needsInput('Should I deploy?'), input, T0 + 10);
    expect(resolved).not.toBeNull();
    // The resolution + its snooze-until are preserved in the returned audit trail.
    expect(resolved!.history).toHaveLength(1);
    expect(resolved!.history[0].reason).toBe('resolved');
    expect(resolved!.history[0].snoozeUntil).toBe(until);
    expect(dedup.snapshot()).toHaveLength(0);
    expect(dedup.resolve(needsInput('Should I deploy?'), input, T0 + 20)).toBeNull();

    const reopened = dedup.record(needsInput('Should I deploy?'), input, T0 + 10_000);
    expect(reopened.disposition).toBe('created');
    expect(reopened.record.history).toHaveLength(0);
  });

  test('an equivalent detection after supersede re-dedupes and bumps occurrences', () => {
    const dedup = new FindingDeduplicator();
    const input = { taskId: 'task-42' };

    dedup.record(needsInput('Should I deploy to prod?'), input, T0);
    dedup.record(needsInput('Should I roll back?'), input, T0 + 1000); // supersede
    const again = dedup.record(needsInput('Should I roll back?'), input, T0 + 2000);
    expect(again.disposition).toBe('deduplicated');
    expect(again.record.occurrences).toBe(2);
    expect(again.record.history).toHaveLength(1); // the superseded predecessor is retained
  });

  test('snapshot/get return clones that cannot mutate internal state', () => {
    const dedup = new FindingDeduplicator();
    const input = { taskId: 'task-42' };

    dedup.record(needsInput('Should I deploy?'), input, T0);
    const snap = dedup.get(needsInput('Should I deploy?'), input)!;
    snap.occurrences = 999;
    snap.history.push({
      fingerprint: 'x', context: 'x', occurrences: 1,
      firstSeenAt: 0, lastSeenAt: 0, snoozeUntil: null, reason: 'resolved', endedAt: 0,
    });

    const fresh = dedup.get(needsInput('Should I deploy?'), input)!;
    expect(fresh.occurrences).toBe(1);
    expect(fresh.history).toHaveLength(0);
    expect(dedup.getByFindingId(fresh.findingId)?.findingId).toBe(fresh.findingId);
  });

  test('distinct tasks keep independent findings', () => {
    const dedup = new FindingDeduplicator();
    dedup.record(needsInput('Should I deploy?'), { taskId: 'task-a' }, T0);
    dedup.record(needsInput('Should I deploy?'), { taskId: 'task-b' }, T0);
    expect(dedup.snapshot()).toHaveLength(2);
  });
});
