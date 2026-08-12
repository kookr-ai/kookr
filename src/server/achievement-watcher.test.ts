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

async function waitForFile(path: string, timeoutMs = 1000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf-8');
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
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
      const quarantined = dirEntries.filter((f) => f.includes('.quarantined-'));
      // Exactly one quarantine file was created
      expect(quarantined).toHaveLength(1);
      // Original path was renamed away — must not exist after the rename
      await expect(access(filePath)).rejects.toThrow();
      // Quarantined content is the original unparseable JSON, useful for forensic recovery
      const quarantinedRaw = await readFile(join(tmpDir, quarantined[0]), 'utf-8');
      expect(quarantinedRaw).toBe('not json!!!');
    });

    test('loadAchievements quarantines schema-invalid JSON and returns defaults', async () => {
      // valid JSON, but `unlocked` is the wrong type (string instead of record)
      await writeFile(filePath, JSON.stringify({ unlocked: 'not an object' }));
      const result = await loadAchievements(filePath);
      expect(result.unlocked).toEqual({});

      const dirEntries = await readdir(tmpDir);
      const quarantined = dirEntries.find((f) => f.includes('.quarantined-'));
      expect(quarantined).toBeDefined();
    });

    test('loadAchievements migrates v1 file (only `unlocked`) by populating defaults', async () => {
      // v1 shape — only `unlocked`, no counters/streak/backfillCompleted/schemaVersion
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

      // No quarantine — v1 file is a valid migration source
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

      const raw = await waitForFile(filePath);
      const data = JSON.parse(raw);
      expect(data.unlocked).toHaveProperty('first-response');
    });

    test('persist writes compact JSON smaller than pretty form (issue #2339)', async () => {
      watcher.check({ type: 'client', action: 'respond' });

      const raw = await waitForFile(filePath);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed.unlocked).toHaveProperty('first-response');

      // Compact form: no multi-line indent (optional trailing newline only).
      expect(raw.trimEnd()).not.toMatch(/\n\s+/);
      const compactBytes = Buffer.byteLength(raw, 'utf-8');
      const prettyBytes = Buffer.byteLength(JSON.stringify(parsed, null, 2), 'utf-8');
      expect(compactBytes).toBeLessThan(prettyBytes);
      expect(raw).toBe(JSON.stringify(parsed));
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

  describe('snapshot state checks', () => {
    test('first-cron unlocks when scheduleCount > 0', () => {
      watcher.check({
        type: 'snapshot',
        state: {
          scheduleCount: 1, projectCount: 0,
          hasCodexTask: false, hasFeedbackTask: false,
          hasSnoozedFinding: false, hasKookrSubject: false,
          unsnoozedFindingCount: 0,
        },
      });
      expect(unlocks.map((u) => u.id)).toContain('first-cron');
    });

    test('first-multi-project unlocks when projectCount >= 2', () => {
      watcher.check({
        type: 'snapshot',
        state: {
          scheduleCount: 0, projectCount: 2,
          hasCodexTask: false, hasFeedbackTask: false,
          hasSnoozedFinding: false, hasKookrSubject: false,
          unsnoozedFindingCount: 0,
        },
      });
      expect(unlocks.map((u) => u.id)).toContain('first-multi-project');
    });

    test('first-codex / first-feedback / first-snooze / self-aware all unlock from snapshot', () => {
      watcher.check({
        type: 'snapshot',
        state: {
          scheduleCount: 0, projectCount: 0,
          hasCodexTask: true, hasFeedbackTask: true,
          hasSnoozedFinding: true, hasKookrSubject: true,
          unsnoozedFindingCount: 0,
        },
      });
      const ids = unlocks.map((u) => u.id);
      expect(ids).toEqual(expect.arrayContaining(['first-codex', 'first-feedback', 'first-snooze', 'self-aware']));
    });

    test('tab-hoarder unlocks when 10+ unsnoozed findings observable in a snapshot', () => {
      watcher.check({
        type: 'snapshot',
        state: {
          scheduleCount: 0, projectCount: 0,
          hasCodexTask: false, hasFeedbackTask: false,
          hasSnoozedFinding: false, hasKookrSubject: false,
          unsnoozedFindingCount: 10,
        },
      });
      expect(unlocks.map((u) => u.id)).toContain('tab-hoarder');
    });

    test('tab-hoarder does NOT unlock at 9 findings', () => {
      watcher.check({
        type: 'snapshot',
        state: {
          scheduleCount: 0, projectCount: 0,
          hasCodexTask: false, hasFeedbackTask: false,
          hasSnoozedFinding: false, hasKookrSubject: false,
          unsnoozedFindingCount: 9,
        },
      });
      expect(unlocks.map((u) => u.id)).not.toContain('tab-hoarder');
    });
  });

  describe('recordResolution', () => {
    function makeAnomaly(type: 'repeated_error' | 'permission_blocked' | 'needs_input', detectedAt = new Date('2026-05-07T10:00:00Z')) {
      return { agentId: 'a1', type, severity: 'critical' as const, explanation: 'x', detectedAt };
    }

    test('skips when body is shorter than 3 non-whitespace chars', () => {
      watcher.recordResolution({ agentId: 'a1', body: 'ok', activeAnomaly: makeAnomaly('repeated_error') });
      watcher.recordResolution({ agentId: 'a1', body: '   ', activeAnomaly: makeAnomaly('repeated_error') });
      expect(unlocks).toHaveLength(0);
      expect(watcher.getCounters().repeated_error_resolutions).toBe(0);
    });

    test('skips when no active anomaly is provided', () => {
      watcher.recordResolution({ agentId: 'a1', body: 'fix this', activeAnomaly: null });
      expect(unlocks).toHaveLength(0);
      expect(watcher.getCounters().repeated_error_resolutions).toBe(0);
    });

    test('increments the type-keyed counter on a valid resolution', () => {
      watcher.recordResolution({ agentId: 'a1', body: 'try again', activeAnomaly: makeAnomaly('repeated_error') });
      expect(watcher.getCounters().repeated_error_resolutions).toBe(1);
    });

    test('loop-buster-i unlocks at 10 repeated_error resolutions', () => {
      for (let i = 0; i < 10; i++) {
        watcher.recordResolution({ agentId: `a${i}`, body: 'try again', activeAnomaly: makeAnomaly('repeated_error') });
      }
      expect(unlocks.map((u) => u.id)).toContain('loop-buster-i');
    });

    test('permission-whisperer unlocks at 25 permission_blocked resolutions', () => {
      for (let i = 0; i < 25; i++) {
        watcher.recordResolution({ agentId: `a${i}`, body: 'allow it', activeAnomaly: makeAnomaly('permission_blocked') });
      }
      expect(unlocks.map((u) => u.id)).toContain('permission-whisperer');
    });

    test('streak increments daily, resets after a gap, no-ops same-day', () => {
      const day1 = Date.parse('2026-05-01T10:00:00Z');
      const day2 = Date.parse('2026-05-02T10:00:00Z');
      const day4 = Date.parse('2026-05-04T10:00:00Z');

      watcher.recordResolution({ agentId: 'a1', body: 'fix this', activeAnomaly: makeAnomaly('needs_input'), nowMs: day1 });
      expect(watcher.getStreak()).toEqual({ lastActiveDate: '2026-05-01', currentStreak: 1 });

      watcher.recordResolution({ agentId: 'a1', body: 'fix this', activeAnomaly: makeAnomaly('needs_input'), nowMs: day1 });
      expect(watcher.getStreak()).toEqual({ lastActiveDate: '2026-05-01', currentStreak: 1 });  // same-day no-op

      watcher.recordResolution({ agentId: 'a1', body: 'fix this', activeAnomaly: makeAnomaly('needs_input'), nowMs: day2 });
      expect(watcher.getStreak()).toEqual({ lastActiveDate: '2026-05-02', currentStreak: 2 });

      watcher.recordResolution({ agentId: 'a1', body: 'fix this', activeAnomaly: makeAnomaly('needs_input'), nowMs: day4 });
      // Gap of 2 days resets streak; lastActiveDate must update to the resolution day,
      // otherwise a +1-day check from the wrong base would mis-resume the streak.
      expect(watcher.getStreak()).toEqual({ lastActiveDate: '2026-05-04', currentStreak: 1 });
    });

    test('iron-streak unlocks at 7 consecutive days', () => {
      for (let i = 0; i < 7; i++) {
        const dayMs = Date.parse(`2026-05-0${i + 1}T10:00:00Z`);
        watcher.recordResolution({ agentId: 'a1', body: 'keep going', activeAnomaly: makeAnomaly('repeated_error'), nowMs: dayMs });
      }
      expect(watcher.getStreak().currentStreak).toBe(7);
      expect(unlocks.map((u) => u.id)).toContain('iron-streak');
    });

    test('stuck-together unlocks on 3 resolutions of same (agentId, type) within 1h', () => {
      const t0 = Date.parse('2026-05-07T10:00:00Z');
      watcher.recordResolution({ agentId: 'a1', body: 'try', activeAnomaly: makeAnomaly('repeated_error'), nowMs: t0 });
      watcher.recordResolution({ agentId: 'a1', body: 'try', activeAnomaly: makeAnomaly('repeated_error'), nowMs: t0 + 5 * 60_000 });
      watcher.recordResolution({ agentId: 'a1', body: 'try', activeAnomaly: makeAnomaly('repeated_error'), nowMs: t0 + 10 * 60_000 });
      expect(unlocks.map((u) => u.id)).toContain('stuck-together');
    });

    test('stuck-together does NOT unlock when 3rd resolution is past the 1h window', () => {
      const t0 = Date.parse('2026-05-07T10:00:00Z');
      watcher.recordResolution({ agentId: 'a1', body: 'try', activeAnomaly: makeAnomaly('repeated_error'), nowMs: t0 });
      watcher.recordResolution({ agentId: 'a1', body: 'try', activeAnomaly: makeAnomaly('repeated_error'), nowMs: t0 + 30 * 60_000 });
      watcher.recordResolution({ agentId: 'a1', body: 'try', activeAnomaly: makeAnomaly('repeated_error'), nowMs: t0 + 90 * 60_000 });
      // Only 2 entries are within the window from the third resolution's perspective.
      expect(unlocks.map((u) => u.id)).not.toContain('stuck-together');
    });

    test('afk unlocks when resolution arrives 30+ minutes after detection', () => {
      const detectedAt = new Date('2026-05-07T10:00:00Z');
      const nowMs = detectedAt.getTime() + 31 * 60_000;
      watcher.recordResolution({ agentId: 'a1', body: 'sorry got distracted', activeAnomaly: makeAnomaly('needs_input', detectedAt), nowMs });
      expect(unlocks.map((u) => u.id)).toContain('afk');
    });

    test('disabled watcher does not mutate counters', () => {
      watcher.setEnabled(false);
      watcher.recordResolution({ agentId: 'a1', body: 'try again', activeAnomaly: makeAnomaly('repeated_error') });
      expect(watcher.getCounters().repeated_error_resolutions).toBe(0);
    });
  });

  describe('forty-two', () => {
    test('counter increments on session_start', () => {
      const taskStore = new TaskStore();
      const event: AgentEvent = { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/t' };
      watcher.check({ type: 'agent', event, taskStore, serverCwd: '/srv' });
      expect(watcher.getCounters().session_start_total).toBe(1);
    });

    test('unlocks at 42 lifetime sessions', () => {
      // Pre-seed counter via fully-populated initial state, then trigger one more
      const filePath = join(tmpDir, 'preloaded.json');
      const local: AchievementUnlock[] = [];
      const preloaded = new AchievementWatcher(
        filePath,
        {
          unlocked: {},
          counters: {
            repeated_error_resolutions: 0,
            permission_blocked_resolutions: 0,
            merge_conflict_resolutions: 0,
            api_error_resolutions: 0,
            needs_input_resolutions: 0,
            session_start_total: 41,
            stuck_together_runs: {},
          },
        },
        (u) => local.push(u),
      );
      const taskStore = new TaskStore();
      const event: AgentEvent = { type: 'session_start', sessionId: 's42', transcriptPath: '/tmp/t' };
      preloaded.check({ type: 'agent', event, taskStore, serverCwd: '/srv' });
      expect(local.map((u) => u.id)).toContain('forty-two');
    });
  });

  describe('reset', () => {
    test('clears unlocked map and deletes file', async () => {
      watcher.check({ type: 'client', action: 'respond' });
      await waitForFile(filePath);

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
