import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../core/tasks.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import type { SessionSpec } from '../adapters/terminal-backend.js';
import type { SessionReapConfig } from '../core/session-reap-policy.js';
import {
  DEFAULT_SWEEP_THRESHOLD_LOG_INTERVAL_MS,
  formatSweepThresholdLine,
  SessionReaperService,
  shouldLogSweepThreshold,
  type SweepThresholdSnapshot,
} from './session-reaper.js';

const HOUR_MS = 60 * 60 * 1000;

const ENABLED_CONFIG: SessionReapConfig & { orphanAgeUnderPressureMs: number } = {
  enabled: true,
  orphanAgeThresholdMs: 24 * HOUR_MS,
  orphanAgeUnderPressureMs: 2 * HOUR_MS,
  terminalTaskGraceMs: 60_000,
};

function spec(id: string): SessionSpec {
  return { id, command: 'claude', args: [], env: {}, cwd: '/tmp', size: { cols: 80, rows: 24 } };
}

async function withTempAuditLog<T>(fn: (auditLogPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-session-reaper-test-'));
  try {
    return await fn(join(dir, 'audit.jsonl'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readAuditRows(auditLogPath: string): Promise<Record<string, unknown>[]> {
  try {
    const raw = await readFile(auditLogPath, 'utf-8');
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe('SessionReaperService.runSweep', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs the monitor aged-agent sweep on every sweep and survives its failure (issue #1761)', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    let calls = 0;
    const reaper = new SessionReaperService({
      taskStore,
      backend,
      getConfig: () => ENABLED_CONFIG,
      sweepMonitorAgedAgents: () => { calls += 1; return calls === 1 ? 3 : 0; },
    });
    await reaper.runSweep();
    await reaper.runSweep();
    expect(calls).toBe(2);

    // A throwing sweep must not break session reaping.
    const throwing = new SessionReaperService({
      taskStore,
      backend,
      getConfig: () => ENABLED_CONFIG,
      sweepMonitorAgedAgents: () => { throw new Error('boom'); },
    });
    const result = await throwing.runSweep();
    expect(result.scanned).toBe(0);
  });

  it('reaps a true orphan session past the age threshold (issue #1720 leak class 1)', async () => {
    await withTempAuditLog(async (auditLogPath) => {
      const taskStore = new TaskStore();
      const backend = new FakeTerminalBackend();
      await backend.createSession(spec('kookr-orphan'));
      backend.setSessionStartedAt('kookr-orphan', Date.now() - 25 * HOUR_MS);

      const reaper = new SessionReaperService({
        taskStore,
        backend,
        auditLogPath,
        getConfig: () => ENABLED_CONFIG,
      });

      const result = await reaper.runSweep();

      expect(result.reaped.map((d) => d.sessionId)).toEqual(['kookr-orphan']);
      expect(await backend.isAlive('kookr-orphan')).toBe(false);
      const rows = await readAuditRows(auditLogPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'session.reap',
        actor: 'system:session-reaper',
        sessionId: 'kookr-orphan',
        kind: 'unowned',
        taskId: null,
        signal: 'SIGTERM_then_SIGKILL',
      });
      // ageMs is measured at reap time; allow a few ms of clock drift under load.
      expect(rows[0]!.ageMs).toBeGreaterThanOrEqual(25 * HOUR_MS);
      expect(rows[0]!.ageMs).toBeLessThan(25 * HOUR_MS + 5_000);
      expect(typeof rows[0].timestamp).toBe('string');
      expect(typeof rows[0].reason).toBe('string');
      expect('processCount' in rows[0]).toBe(true);
    });
  });

  it('does not reap anything, records no audit row, and leaves counters at zero when killSession throws', async () => {
    await withTempAuditLog(async (auditLogPath) => {
      const taskStore = new TaskStore();
      const backend = new FakeTerminalBackend();
      await backend.createSession(spec('kookr-orphan'));
      backend.setSessionStartedAt('kookr-orphan', Date.now() - 25 * HOUR_MS);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (backend as any).killSession = async () => {
        throw new Error('dtach kill failed (simulated)');
      };

      const reaper = new SessionReaperService({
        taskStore,
        backend,
        auditLogPath,
        getConfig: () => ENABLED_CONFIG,
      });
      const result = await reaper.runSweep();

      // The session was correctly classified/would-reap, but the kill attempt
      // itself failed — the sweep must not silently record success.
      expect(result.reaped).toHaveLength(0);
      expect(reaper.getHealthSnapshot().totalSessionsReaped).toBe(0);
      expect(await readAuditRows(auditLogPath)).toHaveLength(0);
    });
  });

  it('does not reap an orphan session younger than the age threshold', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    await backend.createSession(spec('kookr-fresh-orphan'));
    backend.setSessionStartedAt('kookr-fresh-orphan', Date.now() - 1_000);

    const reaper = new SessionReaperService({ taskStore, backend, getConfig: () => ENABLED_CONFIG });
    const result = await reaper.runSweep();

    expect(result.reaped).toHaveLength(0);
    expect(result.orphanCount).toBe(1);
    expect(await backend.isAlive('kookr-fresh-orphan')).toBe(true);
  });

  it('reaps a session whose owning task already reached a terminal status (issue #1720 leak class 2 — kookr-826a3ebe)', async () => {
    await withTempAuditLog(async (auditLogPath) => {
      const taskStore = new TaskStore();
      const backend = new FakeTerminalBackend();
      const task = taskStore.createTask('Fix bug', '/cwd');
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-leak',
        agentType: 'codex-cli',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'completed',
      });
      taskStore.completeTask(task.id);

      await backend.createSession(spec('kookr-leak'));
      // The backend still reports it alive (the fire-and-forget adapter.stop()
      // silently failed) — well past the 60s terminal-task grace period.
      backend.setSessionStartedAt('kookr-leak', Date.now() - 2 * HOUR_MS);

      const reaper = new SessionReaperService({
        taskStore,
        backend,
        auditLogPath,
        getConfig: () => ENABLED_CONFIG,
      });
      const result = await reaper.runSweep();

      expect(result.reaped.map((d) => d.sessionId)).toEqual(['kookr-leak']);
      expect(result.terminalLeakCount).toBe(1);
      expect(await backend.isAlive('kookr-leak')).toBe(false);
      const rows = await readAuditRows(auditLogPath);
      expect(rows[0]).toMatchObject({ type: 'session.reap', sessionId: 'kookr-leak', kind: 'terminal-task-leak', taskId: task.id });
    });
  });

  it('never touches a session belonging to a still-active (inProgress) task, even if very old', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    const task = taskStore.createTask('Long-running task', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-active',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    await backend.createSession(spec('kookr-active'));
    backend.setSessionStartedAt('kookr-active', Date.now() - 365 * 24 * HOUR_MS);

    const reaper = new SessionReaperService({ taskStore, backend, getConfig: () => ENABLED_CONFIG });
    const result = await reaper.runSweep();

    expect(result.reaped).toHaveLength(0);
    expect(result.orphanCount).toBe(0);
    expect(result.terminalLeakCount).toBe(0);
    expect(await backend.isAlive('kookr-active')).toBe(true);
  });

  it('does not race a mid-launch session: an orphan the backend cannot age (no getSessionStartedAt) is never reaped', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    await backend.createSession(spec('kookr-unknown-age'));
    // Delete the backend's own age-tracking method to model a backend that
    // cannot report session age at all (the optional interface method absent).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (backend as any).getSessionStartedAt;

    const reaper = new SessionReaperService({ taskStore, backend, getConfig: () => ENABLED_CONFIG });
    const result = await reaper.runSweep();

    expect(result.reaped).toHaveLength(0);
    expect(await backend.isAlive('kookr-unknown-age')).toBe(true);
  });

  it('flag-off: classifies orphans/leaks for observability but reaps nothing', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    await backend.createSession(spec('kookr-orphan'));
    backend.setSessionStartedAt('kookr-orphan', Date.now() - 48 * HOUR_MS);

    const disabledConfig: SessionReapConfig = { ...ENABLED_CONFIG, enabled: false };
    const reaper = new SessionReaperService({ taskStore, backend, getConfig: () => disabledConfig });
    const result = await reaper.runSweep();

    expect(result.reaped).toHaveLength(0);
    expect(result.orphanCount).toBe(1); // still visible for observability
    expect(await backend.isAlive('kookr-orphan')).toBe(true);
  });

  it('getHealthSnapshot reflects the last sweep cheaply (issue #1553: no re-scan on read)', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    await backend.createSession(spec('kookr-orphan'));
    backend.setSessionStartedAt('kookr-orphan', Date.now() - 48 * HOUR_MS);

    const reaper = new SessionReaperService({ taskStore, backend, getConfig: () => ENABLED_CONFIG });
    expect(reaper.getHealthSnapshot().lastSweepAt).toBeNull();
    expect(reaper.getHealthSnapshot().effectiveOrphanAgeMs).toBeNull();

    await reaper.runSweep();

    const snapshot = reaper.getHealthSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.lastSweepAt).not.toBeNull();
    expect(snapshot.totalSessionsReaped).toBe(1);
    expect(snapshot.lastOrphanCount).toBe(1);
    // Single live session → below soft bound → steady-state 24h threshold.
    expect(snapshot.effectiveOrphanAgeMs).toBe(24 * HOUR_MS);
    expect(snapshot.underPressure).toBe(false);
  });

  it('under pressure: reaps a 3h unowned orphan using the 2h threshold and reports effectiveOrphanAgeMs (issue #2081)', async () => {
    await withTempAuditLog(async (auditLogPath) => {
      const taskStore = new TaskStore();
      const backend = new FakeTerminalBackend();
      await backend.createSession(spec('kookr-orphan-pressure'));
      backend.setSessionStartedAt('kookr-orphan-pressure', Date.now() - 3 * HOUR_MS);

      const reaper = new SessionReaperService({
        taskStore,
        backend,
        auditLogPath,
        getConfig: () => ENABLED_CONFIG,
        // Soft bound 20; inject a high gauge so pressure adapts without
        // needing 20 live fake sessions.
        getStaleDtachCount: () => 32,
      });

      const result = await reaper.runSweep();
      expect(result.reaped.map((d) => d.sessionId)).toEqual(['kookr-orphan-pressure']);
      expect(await backend.isAlive('kookr-orphan-pressure')).toBe(false);

      const snapshot = reaper.getHealthSnapshot();
      expect(snapshot.effectiveOrphanAgeMs).toBe(2 * HOUR_MS);
      expect(snapshot.underPressure).toBe(true);
      expect(snapshot.totalSessionsReaped).toBe(1);
    });
  });

  it('without pressure: preserves the 24h default and does not reap a 3h orphan (issue #2081)', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    await backend.createSession(spec('kookr-orphan-young'));
    backend.setSessionStartedAt('kookr-orphan-young', Date.now() - 3 * HOUR_MS);

    const reaper = new SessionReaperService({
      taskStore,
      backend,
      getConfig: () => ENABLED_CONFIG,
      getStaleDtachCount: () => 5, // well below soft bound 20
    });

    const result = await reaper.runSweep();
    expect(result.reaped).toEqual([]);
    expect(await backend.isAlive('kookr-orphan-young')).toBe(true);
    expect(reaper.getHealthSnapshot().effectiveOrphanAgeMs).toBe(24 * HOUR_MS);
    expect(reaper.getHealthSnapshot().underPressure).toBe(false);
  });

  it('omitted getStaleDtachCount: pressure derives from live session count (prod fallback path)', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    // Soft bound 3 for this test so we don't need 20 fake sessions.
    const softBound = 3;
    for (let i = 0; i < softBound; i += 1) {
      const id = `kookr-live-${i}`;
      await backend.createSession(spec(id));
      // Only the first is past the 2h pressure age; the rest are brand new.
      backend.setSessionStartedAt(id, Date.now() - (i === 0 ? 3 * HOUR_MS : 10_000));
    }

    const reaper = new SessionReaperService({
      taskStore,
      backend,
      getConfig: () => ENABLED_CONFIG,
      dtachPressureSoftBound: softBound,
      // deliberately omit getStaleDtachCount
    });

    const result = await reaper.runSweep();
    expect(reaper.getHealthSnapshot().underPressure).toBe(true);
    expect(reaper.getHealthSnapshot().effectiveOrphanAgeMs).toBe(2 * HOUR_MS);
    expect(result.reaped.map((d) => d.sessionId)).toEqual(['kookr-live-0']);
  });

  it('getStaleDtachCount throw falls back to live session count without aborting the sweep', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    await backend.createSession(spec('kookr-orphan-fallback'));
    backend.setSessionStartedAt('kookr-orphan-fallback', Date.now() - 3 * HOUR_MS);

    const reaper = new SessionReaperService({
      taskStore,
      backend,
      getConfig: () => ENABLED_CONFIG,
      getStaleDtachCount: () => {
        throw new Error('proc unavailable');
      },
    });

    const result = await reaper.runSweep();
    // 1 live session → below soft bound 20 → steady-state 24h → no reap.
    expect(result.reaped).toEqual([]);
    expect(reaper.getHealthSnapshot().underPressure).toBe(false);
    expect(reaper.getHealthSnapshot().effectiveOrphanAgeMs).toBe(24 * HOUR_MS);
  });

  it('rate-limits identical sweep-threshold lines and logs immediately when a field changes (issue #2428)', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    let now = 1_000;
    let dtachCount = 5;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reaper = new SessionReaperService({
      taskStore,
      backend,
      getConfig: () => ENABLED_CONFIG,
      now: () => now,
      getStaleDtachCount: () => dtachCount,
    });

    const thresholdCalls = (): string[] =>
      log.mock.calls
        .map((args) => String(args[0] ?? ''))
        .filter((line) => line.startsWith('[session-reaper] sweep thresholds:'));

    await reaper.runSweep();
    expect(thresholdCalls()).toHaveLength(1);
    expect(thresholdCalls()[0]).toContain('underPressure=false');
    expect(thresholdCalls()[0]).toContain('dtachCount=5');

    now += 1_000;
    await reaper.runSweep();
    expect(thresholdCalls()).toHaveLength(1);

    dtachCount = 32;
    now += 1_000;
    await reaper.runSweep();
    expect(thresholdCalls()).toHaveLength(2);
    expect(thresholdCalls()[1]).toContain('underPressure=true');
    expect(thresholdCalls()[1]).toContain('dtachCount=32');
    const lastEmitAt = now;

    now += 1_000;
    await reaper.runSweep();
    expect(thresholdCalls()).toHaveLength(2);

    now = lastEmitAt + DEFAULT_SWEEP_THRESHOLD_LOG_INTERVAL_MS;
    await reaper.runSweep();
    expect(thresholdCalls()).toHaveLength(3);
    expect(thresholdCalls()[2]).toBe(thresholdCalls()[1]);
  });

  it('still logs a reap immediately when the identical threshold line is suppressed (issue #2428)', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    await backend.createSession(spec('kookr-orphan'));
    let now = 10_000;
    backend.setSessionStartedAt('kookr-orphan', now - 1_000);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reaper = new SessionReaperService({
      taskStore,
      backend,
      getConfig: () => ({ ...ENABLED_CONFIG, thresholdLogIntervalMs: HOUR_MS }),
      now: () => now,
    });

    await reaper.runSweep();
    expect(await backend.isAlive('kookr-orphan')).toBe(true);
    const firstThresholds = log.mock.calls.filter((args) =>
      String(args[0] ?? '').startsWith('[session-reaper] sweep thresholds:'),
    );
    expect(firstThresholds).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();

    now += 1_000;
    backend.setSessionStartedAt('kookr-orphan', now - 25 * HOUR_MS);
    await reaper.runSweep();

    expect(await backend.isAlive('kookr-orphan')).toBe(false);
    const laterThresholds = log.mock.calls.filter((args) =>
      String(args[0] ?? '').startsWith('[session-reaper] sweep thresholds:'),
    );
    expect(laterThresholds).toHaveLength(1);
    expect(warn.mock.calls.some((args) =>
      String(args[0] ?? '').includes('reaped unowned session kookr-orphan'),
    )).toBe(true);
  });

  it('still logs a killSession error immediately when the identical threshold line is suppressed (issue #2428)', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    await backend.createSession(spec('kookr-orphan'));
    let now = 10_000;
    backend.setSessionStartedAt('kookr-orphan', now - 25 * HOUR_MS);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reaper = new SessionReaperService({
      taskStore,
      backend,
      getConfig: () => ({ ...ENABLED_CONFIG, thresholdLogIntervalMs: HOUR_MS }),
      now: () => now,
    });

    await reaper.runSweep();
    expect(await backend.isAlive('kookr-orphan')).toBe(false);
    expect(log.mock.calls.filter((args) =>
      String(args[0] ?? '').startsWith('[session-reaper] sweep thresholds:'),
    )).toHaveLength(1);

    await backend.createSession(spec('kookr-orphan-2'));
    backend.setSessionStartedAt('kookr-orphan-2', now - 25 * HOUR_MS);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (backend as any).killSession = async () => {
      throw new Error('dtach kill failed (simulated)');
    };
    now += 1_000;
    await reaper.runSweep();

    expect(log.mock.calls.filter((args) =>
      String(args[0] ?? '').startsWith('[session-reaper] sweep thresholds:'),
    )).toHaveLength(1);
    expect(warn.mock.calls.some((args) =>
      String(args[0] ?? '').includes('killSession failed for kookr-orphan-2'),
    )).toBe(true);
  });
});

const STEADY_SNAPSHOT: SweepThresholdSnapshot = {
  effectiveOrphanAgeMs: 24 * HOUR_MS,
  underPressure: false,
  dtachCount: 4,
  softBound: 20,
  steadyStateOrphanAgeMs: 24 * HOUR_MS,
  underPressureOrphanAgeMs: 2 * HOUR_MS,
};

describe('shouldLogSweepThreshold', () => {
  it('always logs the first snapshot', () => {
    const line = formatSweepThresholdLine(STEADY_SNAPSHOT);
    expect(shouldLogSweepThreshold({
      lastLine: null,
      lastLoggedAtMs: null,
      nextLine: line,
      nowMs: 0,
      intervalMs: DEFAULT_SWEEP_THRESHOLD_LOG_INTERVAL_MS,
    })).toBe(true);
  });

  it('suppresses an identical snapshot inside the interval', () => {
    const line = formatSweepThresholdLine(STEADY_SNAPSHOT);
    expect(shouldLogSweepThreshold({
      lastLine: line,
      lastLoggedAtMs: 0,
      nextLine: line,
      nowMs: DEFAULT_SWEEP_THRESHOLD_LOG_INTERVAL_MS - 1,
      intervalMs: DEFAULT_SWEEP_THRESHOLD_LOG_INTERVAL_MS,
    })).toBe(false);
  });

  it('logs again when any field changes, even inside the interval', () => {
    const previous = formatSweepThresholdLine(STEADY_SNAPSHOT);
    const next = formatSweepThresholdLine({ ...STEADY_SNAPSHOT, underPressure: true, dtachCount: 32 });
    expect(previous).not.toBe(next);
    expect(shouldLogSweepThreshold({
      lastLine: previous,
      lastLoggedAtMs: 0,
      nextLine: next,
      nowMs: 1,
      intervalMs: DEFAULT_SWEEP_THRESHOLD_LOG_INTERVAL_MS,
    })).toBe(true);
  });

  it('re-emits an identical snapshot once the interval elapses', () => {
    const line = formatSweepThresholdLine(STEADY_SNAPSHOT);
    expect(shouldLogSweepThreshold({
      lastLine: line,
      lastLoggedAtMs: 0,
      nextLine: line,
      nowMs: DEFAULT_SWEEP_THRESHOLD_LOG_INTERVAL_MS,
      intervalMs: DEFAULT_SWEEP_THRESHOLD_LOG_INTERVAL_MS,
    })).toBe(true);
  });
});

describe('SessionReaperService.runStaleAttacherSweep', () => {
  it('is a no-op (and never signals anything) when the flag is disabled', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    const disabledConfig: SessionReapConfig = { ...ENABLED_CONFIG, enabled: false };
    const reaper = new SessionReaperService({ taskStore, backend, getConfig: () => disabledConfig });

    const result = await reaper.runStaleAttacherSweep('/tmp/kookr-dtach/1000/port-4800', () => {
      throw new Error('must not list processes when disabled');
    });
    expect(result).toEqual([]);
  });

  it('returns an empty result when the injected process table has no stale attachers', async () => {
    const taskStore = new TaskStore();
    const backend = new FakeTerminalBackend();
    const reaper = new SessionReaperService({ taskStore, backend, getConfig: () => ENABLED_CONFIG });

    const result = await reaper.runStaleAttacherSweep('/tmp/kookr-dtach/1000/port-4800', () => [
      { pid: 1, command: 'bash' },
    ]);
    expect(result).toEqual([]);
  });

  it('reaps an identified stale attacher end-to-end: updates counters and writes an audit row', async () => {
    await withTempAuditLog(async (auditLogPath) => {
      const taskStore = new TaskStore();
      const backend = new FakeTerminalBackend();
      const reaper = new SessionReaperService({ taskStore, backend, auditLogPath, getConfig: () => ENABLED_CONFIG });
      const instanceDir = '/tmp/kookr-dtach/1000/port-4800';
      // Non-existent pid (same convention as process-tree.test.ts's "does not
      // exist" fixture, well past any real pid_max) — the escalation's real
      // `process.kill` calls harmlessly ESRCH rather than touching a real
      // process, matching "no test may kill real processes it did not spawn".
      const bogusPid = 2_147_483_600;
      const sock = `${instanceDir}/kookr-stale.sock`;

      expect(reaper.getHealthSnapshot().totalStaleAttachersReaped).toBe(0);
      expect(reaper.getHealthSnapshot().lastStaleAttacherSweepAt).toBeNull();

      const result = await reaper.runStaleAttacherSweep(instanceDir, () => [
        { pid: bogusPid, command: `dtach -a ${sock} -E` },
      ]);

      expect(result).toEqual([{ pid: bogusPid, sock }]);
      const snapshot = reaper.getHealthSnapshot();
      expect(snapshot.totalStaleAttachersReaped).toBe(1);
      expect(snapshot.lastStaleAttacherSweepAt).not.toBeNull();

      const rows = await readAuditRows(auditLogPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'session.reapStaleAttacher',
        actor: 'system:session-reaper',
        pid: bogusPid,
        sock,
        signal: 'SIGTERM_then_SIGKILL',
      });
    });
  });
});
