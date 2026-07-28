import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  appendLessonWrite,
  applyDegradationProbe,
  buildLessonEntry,
  contentHashFor,
  DEFAULT_DEGRADED_ALERT_THRESHOLD_MS,
  drainLessonSpool,
  emptySpoolState,
  extractRememberKb,
  extractRememberTitle,
  isLessonRememberArgv,
  pendingPath,
  readPendingLessons,
  readSpoolState,
  writeSpoolState,
} from './lesson-write-spool.js';

const dirs: string[] = [];

afterEach(async () => {
  // temp dirs are under os.tmpdir; leave cleanup to OS. Track for sanity.
  dirs.length = 0;
});

async function tempSpoolDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-lesson-spool-'));
  dirs.push(dir);
  return dir;
}

describe('contentHashFor', () => {
  test('is stable for equivalent body whitespace', () => {
    const a = contentHashFor('agent-task-lessons', 'title', 'body\n');
    const b = contentHashFor('agent-task-lessons', 'title', 'body\n\n');
    const c = contentHashFor('agent-task-lessons', 'title', 'body  \n');
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test('changes when title or kb differs', () => {
    const base = contentHashFor('agent-task-lessons', 'a', 'body\n');
    expect(contentHashFor('agent-task-lessons', 'b', 'body\n')).not.toBe(base);
    expect(contentHashFor('other', 'a', 'body\n')).not.toBe(base);
  });
});

describe('appendLessonWrite + drainLessonSpool', () => {
  test('spools a lesson durably and survives re-read', async () => {
    const spoolDir = await tempSpoolDir();
    const entry = buildLessonEntry({
      title: 'do not drop lessons',
      body: '## Mistake\nx\n## Why it happened\ny\n## Better next time\nz\n',
      taskId: 'task-1',
    });
    const result = await appendLessonWrite(spoolDir, entry);
    expect(result.appended).toBe(true);
    expect(result.reason).toBe('appended');

    const pending = await readPendingLessons(spoolDir);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.contentHash).toBe(entry.contentHash);
    expect(pending[0]!.title).toBe('do not drop lessons');
    expect(pending[0]!.taskId).toBe('task-1');

    // File survives as JSONL
    const raw = await readFile(pendingPath(spoolDir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  test('duplicate content hash is a no-op append', async () => {
    const spoolDir = await tempSpoolDir();
    const entry = buildLessonEntry({ title: 'same', body: 'body\n' });
    await appendLessonWrite(spoolDir, entry);
    const second = await appendLessonWrite(spoolDir, {
      ...entry,
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(second.appended).toBe(false);
    expect(second.reason).toBe('duplicate');
    expect(await readPendingLessons(spoolDir)).toHaveLength(1);
  });

  test('drain writes successfully and empties the spool (idempotent re-drain)', async () => {
    const spoolDir = await tempSpoolDir();
    const e1 = buildLessonEntry({ title: 'one', body: 'body one\n' });
    const e2 = buildLessonEntry({ title: 'two', body: 'body two\n' });
    await appendLessonWrite(spoolDir, e1);
    await appendLessonWrite(spoolDir, e2);

    const written: string[] = [];
    const first = await drainLessonSpool({
      spoolDir,
      write: async (entry) => {
        written.push(entry.title);
        return { ok: true };
      },
    });
    expect(first.written).toBe(2);
    expect(first.remaining).toBe(0);
    expect(written).toEqual(['one', 'two']);
    expect(await readPendingLessons(spoolDir)).toHaveLength(0);

    const second = await drainLessonSpool({
      spoolDir,
      write: async () => {
        throw new Error('should not be called on empty spool');
      },
    });
    expect(second.attempted).toBe(0);
    expect(second.written).toBe(0);
    expect(second.remaining).toBe(0);
  });

  test('drain keeps failed entries and retries them later', async () => {
    const spoolDir = await tempSpoolDir();
    await appendLessonWrite(spoolDir, buildLessonEntry({ title: 'ok', body: 'a\n' }));
    await appendLessonWrite(spoolDir, buildLessonEntry({ title: 'fail', body: 'b\n' }));

    let failOnce = true;
    const first = await drainLessonSpool({
      spoolDir,
      write: async (entry) => {
        if (entry.title === 'fail' && failOnce) {
          failOnce = false;
          return { ok: false, error: 'provider down' };
        }
        return { ok: true };
      },
    });
    expect(first.written).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.remaining).toBe(1);

    const remaining = await readPendingLessons(spoolDir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.title).toBe('fail');
    expect(remaining[0]!.lastError).toBe('provider down');

    const second = await drainLessonSpool({
      spoolDir,
      write: async () => ({ ok: true }),
    });
    expect(second.written).toBe(1);
    expect(second.remaining).toBe(0);
  });
});

describe('applyDegradationProbe', () => {
  const threshold = DEFAULT_DEGRADED_ALERT_THRESHOLD_MS;

  test('records degraded-since on first degraded probe', () => {
    const now = new Date('2026-07-23T12:00:00.000Z');
    const tick = applyDegradationProbe({
      previous: emptySpoolState(),
      status: 'degraded',
      now,
      thresholdMs: threshold,
    });
    expect(tick.state.kbDegradedSince).toBe(now.toISOString());
    expect(tick.shouldFireAlert).toBe(false);
    expect(tick.shouldDrain).toBe(false);
    expect(tick.degradedForMs).toBe(0);
  });

  test('fires alert once when degraded past threshold', () => {
    const start = new Date('2026-07-23T10:00:00.000Z');
    const later = new Date(start.getTime() + threshold + 1);
    const first = applyDegradationProbe({
      previous: emptySpoolState(),
      status: 'degraded',
      now: start,
      thresholdMs: threshold,
    });
    const second = applyDegradationProbe({
      previous: first.state,
      status: 'degraded',
      now: later,
      thresholdMs: threshold,
    });
    expect(second.shouldFireAlert).toBe(true);
    expect(second.state.alertFiredAt).toBe(later.toISOString());
    expect(second.degradedForMs).toBeGreaterThanOrEqual(threshold);

    // Third tick in the same streak must not re-fire.
    const third = applyDegradationProbe({
      previous: second.state,
      status: 'degraded',
      now: new Date(later.getTime() + 60_000),
      thresholdMs: threshold,
    });
    expect(third.shouldFireAlert).toBe(false);
    expect(third.state.alertFiredAt).toBe(later.toISOString());
  });

  test('healthy probe clears streak and requests drain', () => {
    const start = new Date('2026-07-23T10:00:00.000Z');
    const degraded = applyDegradationProbe({
      previous: emptySpoolState(),
      status: 'degraded',
      now: start,
      thresholdMs: threshold,
    });
    const healthy = applyDegradationProbe({
      previous: { ...degraded.state, lastPendingCount: 2 },
      status: 'healthy',
      now: new Date('2026-07-23T13:00:00.000Z'),
      thresholdMs: threshold,
    });
    expect(healthy.state.kbDegradedSince).toBeNull();
    expect(healthy.state.alertFiredAt).toBeNull();
    expect(healthy.state.lastProbeStatus).toBe('healthy');
    expect(healthy.shouldDrain).toBe(true);
    expect(healthy.shouldFireAlert).toBe(false);
  });
});

describe('spool state persistence', () => {
  test('round-trips state.json', async () => {
    const spoolDir = await tempSpoolDir();
    const state = {
      ...emptySpoolState(),
      kbDegradedSince: '2026-07-22T10:08:00.000Z',
      lastProbeStatus: 'degraded' as const,
      lastProbeAt: '2026-07-23T10:00:00.000Z',
    };
    await writeSpoolState(spoolDir, state);
    const loaded = await readSpoolState(spoolDir);
    expect(loaded).toEqual(state);
  });

  test('missing state file returns empty state', async () => {
    const spoolDir = await tempSpoolDir();
    expect(await readSpoolState(spoolDir)).toEqual(emptySpoolState());
  });

  test('corrupt state file fails open to empty', async () => {
    const spoolDir = await tempSpoolDir();
    await writeFile(join(spoolDir, 'state.json'), 'not-json{', 'utf8');
    expect(await readSpoolState(spoolDir)).toEqual(emptySpoolState());
  });
});

describe('remember argv helpers', () => {
  test('detects lesson remember via --lesson and --kb', () => {
    expect(isLessonRememberArgv(['remember', '--lesson', '--title=x'])).toBe(true);
    expect(isLessonRememberArgv(['remember', '--kb=agent-task-lessons', '--title=x'])).toBe(true);
    expect(isLessonRememberArgv(['remember', '--kb', 'agent-task-lessons', '--title=x'])).toBe(true);
    expect(isLessonRememberArgv(['remember', '--kb=work', '--title=x'])).toBe(false);
    expect(isLessonRememberArgv(['search', 'foo'])).toBe(false);
    expect(isLessonRememberArgv(['doctor'])).toBe(false);
  });

  test('extracts title and kb', () => {
    expect(extractRememberTitle(['remember', '--title=hello world', '--stdin'])).toBe('hello world');
    expect(extractRememberTitle(['remember', '--title', 'hello', '--stdin'])).toBe('hello');
    expect(extractRememberKb(['remember', '--lesson'])).toBe('agent-task-lessons');
    expect(extractRememberKb(['remember', '--kb=work'])).toBe('work');
  });
});
