import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { AchievementWatcher, loadAchievements } from './achievement-watcher.js';
import type { AchievementUnlock } from './achievement-watcher.js';
import type { AgentEvent } from '../core/types.js';
import type { TelemetryEvent } from '../core/telemetry.js';
import { TaskStore } from '../core/tasks.js';

function makeTelemetryEvent(type: string): TelemetryEvent {
  return { type: type as TelemetryEvent['type'], timestamp: new Date().toISOString(), sessionId: 'test', platform: 'linux' };
}

describe('AchievementWatcher', () => {
  let tmpDir: string;
  let filePath: string;
  let unlocks: AchievementUnlock[];
  let watcher: AchievementWatcher;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'achievement-test-'));
    filePath = join(tmpDir, 'achievements.json');
    unlocks = [];
    watcher = new AchievementWatcher(filePath, { unlocked: {} }, (u) => unlocks.push(u));
  });

  afterEach(async () => {
    // Small delay to let fire-and-forget persistUnlock writes complete
    await new Promise((r) => setTimeout(r, 50));
    await rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe('agent events', () => {
    test('first-agent unlocks on session_start', () => {
      const taskStore = new TaskStore();
      const event: AgentEvent = { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/t' };
      watcher.check({ type: 'agent', event, taskStore, serverCwd: '/home/user/project' });

      expect(unlocks).toHaveLength(1);
      expect(unlocks[0].id).toBe('first-agent');
    });

    test('first-agent only unlocks once', () => {
      const taskStore = new TaskStore();
      const event: AgentEvent = { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/t' };
      watcher.check({ type: 'agent', event, taskStore, serverCwd: '/srv' });
      watcher.check({ type: 'agent', event, taskStore, serverCwd: '/srv' });

      expect(unlocks).toHaveLength(1);
    });

    test('the-loop unlocks when agent CWD matches serverCwd', () => {
      const taskStore = new TaskStore();
      const event: AgentEvent = { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/t', cwd: '/home/user/kookr/.claude/worktrees/fix' };
      watcher.check({ type: 'agent', event, taskStore, serverCwd: '/home/user/kookr' });

      expect(unlocks).toHaveLength(2); // first-agent + the-loop
      expect(unlocks.map((u) => u.id)).toContain('the-loop');
    });

    test('the-loop does NOT unlock when CWD does not match', () => {
      const taskStore = new TaskStore();
      const event: AgentEvent = { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/t', cwd: '/home/user/other-project' };
      watcher.check({ type: 'agent', event, taskStore, serverCwd: '/home/user/kookr' });

      expect(unlocks.map((u) => u.id)).not.toContain('the-loop');
    });

    test('five-agents unlocks when 5+ tasks are inProgress', () => {
      const taskStore = new TaskStore();
      for (let i = 0; i < 5; i++) {
        const task = taskStore.createTask(`task ${i}`, '/cwd');
        taskStore.startTask(task.id, `tmux-${i}`, 'claude', '/cwd');
      }
      const event: AgentEvent = { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/t' };
      watcher.check({ type: 'agent', event, taskStore, serverCwd: '/srv' });

      expect(unlocks.map((u) => u.id)).toContain('five-agents');
    });

    test('ten-agents unlocks when 10+ tasks are inProgress', () => {
      const taskStore = new TaskStore();
      for (let i = 0; i < 10; i++) {
        const task = taskStore.createTask(`task ${i}`, '/cwd');
        taskStore.startTask(task.id, `tmux-${i}`, 'claude', '/cwd');
      }
      const event: AgentEvent = { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/t' };
      watcher.check({ type: 'agent', event, taskStore, serverCwd: '/srv' });

      expect(unlocks.map((u) => u.id)).toContain('ten-agents');
      expect(unlocks.map((u) => u.id)).toContain('five-agents');
    });
  });

  describe('client messages', () => {
    test('first-response unlocks on respond', () => {
      watcher.check({ type: 'client', action: 'respond' });
      expect(unlocks.map((u) => u.id)).toContain('first-response');
    });

    test('first-response unlocks on directReply', () => {
      watcher.check({ type: 'client', action: 'directReply' });
      expect(unlocks.map((u) => u.id)).toContain('first-response');
    });

    test('first-anomaly-resolved unlocks on respond with anomaly', () => {
      watcher.check({ type: 'client', action: 'respond', hadAnomaly: true });
      expect(unlocks.map((u) => u.id)).toContain('first-anomaly-resolved');
    });

    test('first-anomaly-resolved does NOT unlock on respond without anomaly', () => {
      watcher.check({ type: 'client', action: 'respond', hadAnomaly: false });
      expect(unlocks.map((u) => u.id)).not.toContain('first-anomaly-resolved');
    });

    test('task-launched unlocks on launchTask', () => {
      watcher.check({ type: 'client', action: 'launchTask' });
      expect(unlocks.map((u) => u.id)).toContain('task-launched');
    });
  });

  describe('telemetry events', () => {
    test('first-shortcut unlocks on shortcut_used', () => {
      watcher.check({ type: 'telemetry', event: makeTelemetryEvent('shortcut_used') });
      expect(unlocks.map((u) => u.id)).toContain('first-shortcut');
    });

    test('smart-response-used unlocks on suggestion_accepted', () => {
      watcher.check({ type: 'telemetry', event: makeTelemetryEvent('suggestion_accepted') });
      expect(unlocks.map((u) => u.id)).toContain('smart-response-used');
    });

    test('unrelated telemetry does not unlock anything', () => {
      watcher.check({ type: 'telemetry', event: makeTelemetryEvent('tab_switched') });
      expect(unlocks).toHaveLength(0);
    });
  });

  describe('enabled/disabled', () => {
    test('does not check when disabled', () => {
      watcher.setEnabled(false);
      watcher.check({ type: 'client', action: 'respond' });
      expect(unlocks).toHaveLength(0);
    });

    test('resumes checking when re-enabled', () => {
      watcher.setEnabled(false);
      watcher.check({ type: 'client', action: 'respond' });
      watcher.setEnabled(true);
      watcher.check({ type: 'client', action: 'respond' });
      expect(unlocks).toHaveLength(1);
    });
  });

  describe('error boundary (structural test)', () => {
    test('watcher throw does not prevent subsequent checks', () => {
      const unlocked: string[] = [];
      const brokenWatcher = new AchievementWatcher(filePath, { unlocked: {} }, (u) => {
        unlocked.push(u.id);
        if (unlocked.length === 1) {
          throw new Error('onUnlock callback exploded');
        }
      });

      // First check triggers 'first-response' — callback throws
      expect(() => brokenWatcher.check({ type: 'client', action: 'respond' })).toThrow(
        'onUnlock callback exploded',
      );

      // Second check triggers a different achievement ('task-launched') —
      // watcher should still function after the previous error
      brokenWatcher.check({ type: 'client', action: 'launchTask' });
      expect(unlocked).toEqual(['first-response', 'task-launched']);
    });
  });

  describe('persistence', () => {
    test('loadAchievements returns full default state for missing file', async () => {
      const result = await loadAchievements(join(tmpDir, 'nonexistent.json'));
      expect(result.unlocked).toEqual({});
      expect(result.counters.repeated_error_resolutions).toBe(0);
      expect(result.counters.session_start_total).toBe(0);
      expect(result.streak).toEqual({ lastActiveDate: null, currentStreak: 0 });
      expect(result.backfillCompleted).toBe(false);
      expect(result.schemaVersion).toBe(2);
    });

    test('loadAchievements quarantines invalid JSON and returns defaults', async () => {
      await writeFile(filePath, 'not json!!!');
      const result = await loadAchievements(filePath);
      expect(result.unlocked).toEqual({});
      expect(result.backfillCompleted).toBe(false);

      const dirEntries = await readdir(tmpDir);
      const quarantined = dirEntries.find((f) => f.includes('.quarantined-'));
      expect(quarantined).toBeDefined();
      const quarantinedRaw = await readFile(join(tmpDir, quarantined!), 'utf-8');
      expect(quarantinedRaw).toBe('not json!!!');
    });

    test('loadAchievements quarantines schema-invalid JSON and returns defaults', async () => {
      await writeFile(filePath, JSON.stringify({ unlocked: 'not an object' }));
      const result = await loadAchievements(filePath);
      expect(result.unlocked).toEqual({});

      const dirEntries = await readdir(tmpDir);
      const quarantined = dirEntries.find((f) => f.includes('.quarantined-'));
      expect(quarantined).toBeDefined();
    });

    test('loadAchievements migrates v1 file (only `unlocked`) by populating defaults', async () => {
      await writeFile(
        filePath,
        JSON.stringify({ unlocked: { 'first-agent': '2026-04-01T00:00:00Z' } }),
      );
      const result = await loadAchievements(filePath);
      expect(result.unlocked).toEqual({ 'first-agent': '2026-04-01T00:00:00Z' });
      expect(result.counters.repeated_error_resolutions).toBe(0);
      expect(result.streak).toEqual({ lastActiveDate: null, currentStreak: 0 });
      expect(result.backfillCompleted).toBe(false);
      expect(result.schemaVersion).toBe(2);

      const dirEntries = await readdir(tmpDir);
      expect(dirEntries.some((f) => f.includes('.quarantined-'))).toBe(false);
    });

    test('loadAchievements roundtrips a fully-populated v2 file', async () => {
      const fullState = {
        unlocked: { 'first-agent': '2026-04-01T00:00:00Z' },
        counters: {
          repeated_error_resolutions: 7,
          permission_blocked_resolutions: 12,
          merge_conflict_resolutions: 0,
          api_error_resolutions: 0,
          needs_input_resolutions: 0,
          session_start_total: 41,
          stuck_together_runs: { 'agent-1:repeated_error': ['2026-05-07T10:00:00.000Z'] },
        },
        streak: { lastActiveDate: '2026-05-06', currentStreak: 3 },
        backfillCompleted: true,
        schemaVersion: 2 as const,
      };
      await writeFile(filePath, JSON.stringify(fullState));
      const result = await loadAchievements(filePath);
      expect(result).toEqual(fullState);
    });

    test('unlocks are persisted to file', async () => {
      watcher.check({ type: 'client', action: 'respond' });

      // Wait for async persistence
      await new Promise((r) => setTimeout(r, 100));

      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      expect(data.unlocked).toHaveProperty('first-response');
    });

    test('pre-existing unlocks are respected', () => {
      const preloaded = new AchievementWatcher(
        filePath,
        { unlocked: { 'first-response': '2026-01-01T00:00:00Z' } },
        (u) => unlocks.push(u),
      );
      preloaded.check({ type: 'client', action: 'respond' });
      expect(unlocks).toHaveLength(0); // Already unlocked
    });

    test('getUnlocked returns current unlocked map', () => {
      watcher.check({ type: 'client', action: 'respond' });
      const map = watcher.getUnlocked();
      expect(map).toHaveProperty('first-response');
      expect(typeof map['first-response']).toBe('string');
    });
  });

  describe('reset', () => {
    test('clears unlocked map and deletes file', async () => {
      watcher.check({ type: 'client', action: 'respond' });
      // Wait for async persistence
      await new Promise((r) => setTimeout(r, 100));
      // File should exist
      await expect(access(filePath)).resolves.toBeUndefined();

      await watcher.reset();
      expect(watcher.getUnlocked()).toEqual({});
      // File should be deleted
      await expect(access(filePath)).rejects.toThrow();
    });

    test('reset with missing file does not throw', async () => {
      // No unlocks, no file yet
      await expect(watcher.reset()).resolves.toBeUndefined();
      expect(watcher.getUnlocked()).toEqual({});
    });

    test('reset during in-flight persist does not re-create file', async () => {
      // Unlock an achievement (triggers async persistUnlock)
      watcher.check({ type: 'client', action: 'respond' });
      // Immediately reset before persist completes
      await watcher.reset();
      // Wait for the fire-and-forget persist to settle
      await new Promise((r) => setTimeout(r, 200));
      // File should NOT exist — the resetting flag should have blocked the persist
      await expect(access(filePath)).rejects.toThrow();
      expect(watcher.getUnlocked()).toEqual({});
    });
  });
});
