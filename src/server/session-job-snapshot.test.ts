import { describe, expect, it, vi } from 'vitest';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';
import type { ProcessInfo } from '../core/long-running-jobs.js';
import { createSessionJobSnapshotter } from './session-job-snapshot.js';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const HOUR = 3_600_000;

function table(withJob: boolean): ProcessInfo[] {
  const rows: ProcessInfo[] = [
    { pid: 100, ppid: 1, comm: 'dtach', command: 'dtach', startedAtMs: NOW - 5 * HOUR },
    { pid: 101, ppid: 100, comm: 'claude', command: 'claude', startedAtMs: NOW - 5 * HOUR },
  ];
  if (withJob) rows.push({ pid: 201, ppid: 101, comm: 'python', command: 'python train.py', startedAtMs: NOW - 2 * HOUR });
  return rows;
}

const task = (id: string, session = 'kookr-a') =>
  aTask({ id, status: 'inProgress', sessions: [aSession({ tmuxSession: session, lastStatus: 'inProgress' })] });

describe('createSessionJobSnapshotter (issue #4237)', () => {
  it('maps a task to the jobs under its live session root, with GPU use', async () => {
    const readGpuPids = vi.fn().mockResolvedValue(new Set([201]));
    const snapshot = createSessionJobSnapshotter({
      getSessionRootPid: async (id) => (id === 'kookr-a' ? 100 : null),
      readProcessTable: () => table(true),
      readGpuPids,
      now: () => NOW,
    });
    const result = await snapshot([task('t1'), task('t2', 'kookr-unknown')]);
    expect([...result.keys()]).toEqual(['t1']);
    expect(result.get('t1')).toEqual([{ pid: 201, command: 'python train.py', ageMs: 2 * HOUR, holdsGpu: true }]);
    expect(readGpuPids).toHaveBeenCalledTimes(1);
  });

  it('finds a GPU holder that the age filters alone would drop (started with the session)', async () => {
    const rows = table(false);
    rows.push({ pid: 202, ppid: 101, comm: 'python', command: 'python eval.py', startedAtMs: NOW - 5 * HOUR + 60_000 });
    const snapshot = createSessionJobSnapshotter({
      getSessionRootPid: async () => 100,
      readProcessTable: () => rows,
      readGpuPids: async () => new Set([202]),
      now: () => NOW,
    });
    expect((await snapshot([task('t1')])).get('t1')).toEqual([expect.objectContaining({ pid: 202, holdsGpu: true })]);
  });

  it('resolves the latest live session, skipping crash-recovered and stale earlier records', async () => {
    const getSessionRootPid = vi.fn(async (id: string) => (id === 'kookr-new' ? 100 : null));
    const snapshot = createSessionJobSnapshotter({
      getSessionRootPid,
      readProcessTable: () => table(true),
      readGpuPids: async () => new Set(),
      now: () => NOW,
    });
    const relaunched = aTask({
      id: 'ralph',
      status: 'inProgress',
      sessions: [
        aSession({ tmuxSession: 'kookr-old', lastStatus: undefined }),
        aSession({ tmuxSession: 'kookr-crashed', lastStatus: 'inProgress', crashRecovered: true }),
        aSession({ tmuxSession: 'kookr-new', lastStatus: 'inProgress' }),
      ],
    });
    expect((await snapshot([relaunched])).get('ralph')).toEqual([expect.objectContaining({ pid: 201 })]);
    expect(getSessionRootPid).toHaveBeenCalledWith('kookr-new');
    expect(getSessionRootPid).toHaveBeenCalledTimes(1);
  });

  it('does not query the GPU when no session has anything below its agent', async () => {
    const readGpuPids = vi.fn().mockResolvedValue(new Set());
    const snapshot = createSessionJobSnapshotter({
      getSessionRootPid: async () => 100,
      readProcessTable: () => table(false),
      readGpuPids,
      now: () => NOW,
    });
    expect((await snapshot([task('t1')])).size).toBe(0);
    expect(readGpuPids).not.toHaveBeenCalled();
  });

  it('skips a task without a live session and survives every dependency failing', async () => {
    const ended = aTask({ id: 'done', status: 'inProgress', sessions: [aSession({ lastStatus: 'completed' })] });
    const getSessionRootPid = vi.fn().mockResolvedValue(100);
    const snapshot = createSessionJobSnapshotter({
      getSessionRootPid,
      readProcessTable: () => table(true),
      readGpuPids: async () => { throw new Error('nvidia-smi missing'); },
      now: () => NOW,
    });
    expect((await snapshot([ended])).size).toBe(0);
    expect(getSessionRootPid).not.toHaveBeenCalled();
    // GPU failure: jobs still reported, just without GPU use.
    expect((await snapshot([task('t1')])).get('t1')).toEqual([expect.objectContaining({ pid: 201, holdsGpu: false })]);

    const broken = createSessionJobSnapshotter({
      getSessionRootPid: async () => { throw new Error('manifest unreadable'); },
      readProcessTable: () => { throw new Error('no /proc'); },
      readGpuPids: async () => new Set(),
    });
    expect((await broken([task('t1')])).size).toBe(0);
  });
});
