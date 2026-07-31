import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../core/tasks.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import type { SessionSpec } from '../adapters/terminal-backend.js';
import type { SessionReapConfig } from '../core/session-reap-policy.js';
import { SessionReaperService } from './session-reaper.js';

const HOUR_MS = 60 * 60 * 1000;

const ENABLED_CONFIG: SessionReapConfig = {
  enabled: true,
  orphanAgeThresholdMs: 24 * HOUR_MS,
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

    await reaper.runSweep();

    const snapshot = reaper.getHealthSnapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.lastSweepAt).not.toBeNull();
    expect(snapshot.totalSessionsReaped).toBe(1);
    expect(snapshot.lastOrphanCount).toBe(1);
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
