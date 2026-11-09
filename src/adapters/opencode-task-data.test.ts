import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TASK_DIR_MARKER,
  isAbsentOrEmptyDir,
  isMarkedTaskDir,
  markTaskDir,
  openCodeTaskDir,
  parseDataCap,
  readGateBase,
  inspectOpenCodeSession,
  readOpenCodeSessionId,
  removeMarkedTaskDir,
  removeTaskDirOwnedByLaunch,
  resolveOpenCodeDataRoot,
  sweepOpenCodeTaskData,
  writeGateBase,
} from './opencode-task-data.js';
import type { TaskStatus } from '../core/task-status.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'oc-task-data-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function makeDb(dataHome: string, rows: Array<[string, string | null, number]>): void {
  mkdirSync(join(dataHome, 'opencode'), { recursive: true });
  const db = new Database(join(dataHome, 'opencode', 'opencode.db'));
  db.exec('CREATE TABLE session (id text PRIMARY KEY, parent_id text, time_updated integer NOT NULL)');
  const ins = db.prepare('INSERT INTO session (id, parent_id, time_updated) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(...r);
  db.close();
}

describe('resolveOpenCodeDataRoot', () => {
  test('explicit absolute env wins; otherwise a sibling of the hooks dir', () => {
    expect(resolveOpenCodeDataRoot({ KOOKR_OPENCODE_DATA_DIR: '/x/oc' } as NodeJS.ProcessEnv, '/d/.kookr/hooks')).toBe('/x/oc');
    expect(resolveOpenCodeDataRoot({} as NodeJS.ProcessEnv, '/d/.kookr-4800/hooks')).toBe('/d/.kookr-4800/opencode-data');
    expect(resolveOpenCodeDataRoot({ KOOKR_OPENCODE_DATA_DIR: 'relative' } as NodeJS.ProcessEnv, '/d/.kookr/hooks')).toBe('/d/.kookr/opencode-data');
  });
  test('parseDataCap accepts 0, rejects garbage', () => {
    expect(parseDataCap('0', 5)).toBe(0);
    expect(parseDataCap('7', 5)).toBe(7);
    expect(parseDataCap('x', 5)).toBe(5);
    expect(parseDataCap(undefined, 5)).toBe(5);
  });
  test('openCodeTaskDir rejects path traversal', () => {
    expect(() => openCodeTaskDir(root, '../etc')).toThrow(/unsafe task id/);
    expect(openCodeTaskDir(root, 'abc-123')).toBe(join(root, 'abc-123'));
  });
});

describe('readOpenCodeSessionId', () => {
  test('returns the newest root session, ignoring child sessions', async () => {
    makeDb(root, [['ses_old', null, 1], ['ses_new', null, 5], ['ses_child', 'ses_new', 9]]);
    expect(await readOpenCodeSessionId(root)).toBe('ses_new');
  });
  test('prefers the recorded id while it still exists, falls back otherwise', async () => {
    makeDb(root, [['ses_old', null, 1], ['ses_new', null, 5]]);
    expect(await readOpenCodeSessionId(root, 'ses_old')).toBe('ses_old');
    expect(await readOpenCodeSessionId(root, 'ses_gone')).toBe('ses_new');
  });
  test('missing or schema-less DB yields undefined, never throws', async () => {
    expect(await readOpenCodeSessionId(join(root, 'nope'))).toBeUndefined();
    mkdirSync(join(root, 'opencode'), { recursive: true });
    writeFileSync(join(root, 'opencode', 'opencode.db'), 'not sqlite');
    expect(await readOpenCodeSessionId(root)).toBeUndefined();
  });
});

describe('inspectOpenCodeSession', () => {
  test('absent DB, zero-byte DB and a DB with no root session are "absent" (fresh launch is right)', async () => {
    expect((await inspectOpenCodeSession(join(root, 'nope'))).kind).toBe('absent');
    mkdirSync(join(root, 'opencode'), { recursive: true });
    writeFileSync(join(root, 'opencode', 'opencode.db'), '');
    expect((await inspectOpenCodeSession(root)).kind).toBe('absent');
    rmSync(join(root, 'opencode'), { recursive: true });
    makeDb(root, [['ses_child', 'ses_x', 1]]);
    expect((await inspectOpenCodeSession(root)).kind).toBe('absent');
  });
  test('a present but unreadable DB (corrupt file, schema drift) is "unreadable", never "absent"', async () => {
    mkdirSync(join(root, 'opencode'), { recursive: true });
    writeFileSync(join(root, 'opencode', 'opencode.db'), 'not sqlite');
    expect((await inspectOpenCodeSession(root)).kind).toBe('unreadable');
    rmSync(join(root, 'opencode'), { recursive: true });
    mkdirSync(join(root, 'opencode'), { recursive: true });
    const db = new Database(join(root, 'opencode', 'opencode.db'));
    db.exec('CREATE TABLE other (x integer)');
    db.close();
    const r = await inspectOpenCodeSession(root);
    expect(r.kind).toBe('unreadable');
    // The best-effort wrapper still collapses both to undefined.
    expect(await readOpenCodeSessionId(root)).toBeUndefined();
  });
  test('found carries the id', async () => {
    makeDb(root, [['ses_a', null, 3]]);
    expect(await inspectOpenCodeSession(root)).toEqual({ kind: 'found', id: 'ses_a' });
  });
});

describe('launch-token ownership marker', () => {
  test('only the launch that wrote the token may remove the dir; taskId-only helpers still work', async () => {
    const d = join(root, 'task-a');
    mkdirSync(d, { recursive: true });
    await markTaskDir(d, 'task-a', 'tok-1');
    expect(await isMarkedTaskDir(d, 'task-a')).toBe(true);
    // A retry re-marks the dir with its own token...
    await markTaskDir(d, 'task-a', 'tok-2');
    // ...so the first launch's late cleanup is a no-op.
    expect(await removeTaskDirOwnedByLaunch(d, 'task-a', 'tok-1')).toBe(false);
    expect(existsSync(d)).toBe(true);
    expect(await removeTaskDirOwnedByLaunch(d, 'other', 'tok-2')).toBe(false);
    expect(await removeTaskDirOwnedByLaunch(d, 'task-a', 'tok-2')).toBe(true);
    expect(existsSync(d)).toBe(false);
  });
  test('sweep and fresh reset (taskId-only) still remove a token-marked dir; a legacy marker has no token', async () => {
    const d = join(root, 'task-b');
    mkdirSync(d, { recursive: true });
    await markTaskDir(d, 'task-b', 'tok-9');
    expect(await removeMarkedTaskDir(d, 'task-b')).toBe(true);
    mkdirSync(d, { recursive: true });
    await markTaskDir(d, 'task-b');
    expect(await removeTaskDirOwnedByLaunch(d, 'task-b', 'tok-9')).toBe(false);
    expect(await removeMarkedTaskDir(d, 'task-b')).toBe(true);
  });
});

describe('gate base', () => {
  test('round-trips and rejects garbage', async () => {
    const dir = join(root, 't1');
    await writeGateBase(dir, 'abc1234def');
    expect(await readGateBase(dir)).toBe('abc1234def');
    writeFileSync(join(dir, 'gate-base'), 'not a sha');
    expect(await readGateBase(dir)).toBeUndefined();
  });
});

describe('sweepOpenCodeTaskData', () => {
  const day = 86_400_000;
  function taskDir(id: string, bytes = 10, ageMs = 0): string {
    const d = join(root, id);
    mkdirSync(join(d, 'data'), { recursive: true });
    writeFileSync(join(d, 'data', 'blob'), Buffer.alloc(bytes));
    writeFileSync(join(d, TASK_DIR_MARKER), `${id}\n`);
    const t = new Date(Date.now() - ageMs);
    utimesSync(d, t, t);
    return d;
  }
  const base = (statuses: Record<string, TaskStatus>, over: Record<string, unknown> = {}) => ({
    root,
    statusOf: (id: string) => statuses[id],
    activeTaskIds: new Set<string>(),
    maxAgeMs: 14 * day,
    doneTtlMs: 0,
    maxBytes: 0,
    ...over,
  });

  test('removes dirs of unknown, completed and cancelled tasks; keeps terminated and active ones', async () => {
    const dirs = ['gone', 'done', 'cancel', 'term', 'live'].map((id) => taskDir(id));
    const res = await sweepOpenCodeTaskData(base(
      { done: 'completed', cancel: 'cancelled', term: 'terminated', live: 'inProgress' },
    ));
    expect(res.removed.map((r) => `${r.taskId}:${r.reason}`).sort()).toEqual(['cancel:task-done', 'done:task-done', 'gone:task-gone']);
    expect(dirs.map((d) => existsSync(d))).toEqual([false, false, false, true, true]);
  });

  test('done tasks keep their data for the TTL so a reopen can still resume', async () => {
    const recent = taskDir('recent', 10, 1000);
    const stale = taskDir('stale', 10, 3 * day);
    const res = await sweepOpenCodeTaskData(base({ recent: 'completed', stale: 'cancelled' }, { doneTtlMs: day }));
    expect(res.removed).toEqual([{ taskId: 'stale', reason: 'task-done' }]);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  test('an active task is never swept even when its task is gone', async () => {
    const d = taskDir('busy');
    await sweepOpenCodeTaskData(base({}, { activeTaskIds: new Set(['busy']) }));
    expect(existsSync(d)).toBe(true);
  });

  test('age cap removes long-unused dirs, keeps recent ones', async () => {
    const old = taskDir('old', 10, 20 * day);
    const fresh = taskDir('fresh', 10, 1 * day);
    const res = await sweepOpenCodeTaskData(base({ old: 'terminated', fresh: 'terminated' }));
    expect(res.removed).toEqual([{ taskId: 'old', reason: 'expired' }]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test('size cap evicts oldest first until under the cap, sparing recently used dirs', async () => {
    const a = taskDir('a', 400, 3 * day);
    const b = taskDir('b', 400, 2 * day);
    const c = taskDir('c', 400, 1000); // used a second ago: graced
    const res = await sweepOpenCodeTaskData(base({ a: 'terminated', b: 'terminated', c: 'inProgress' }, { maxBytes: 900 }));
    expect(res.removed).toEqual([{ taskId: 'a', reason: 'size-cap' }]);
    expect([a, b, c].map((d) => existsSync(d))).toEqual([false, true, true]);
    expect(res.remainingBytes).toBeLessThanOrEqual(900);
  });

  test('ignores unsafe names, files and a missing root', async () => {
    writeFileSync(join(root, 'stray.txt'), 'x');
    mkdirSync(join(root, 'has space'));
    expect((await sweepOpenCodeTaskData(base({}))).removed).toEqual([]);
    expect(existsSync(join(root, 'has space'))).toBe(true);
    expect(await sweepOpenCodeTaskData(base({}, { root: join(root, 'missing') }))).toEqual({ removed: [], remainingBytes: 0 });
  });
});

describe('ownership marker: nothing unmarked is ever deleted (data-loss regression)', () => {
  const base = (over: Record<string, unknown> = {}) => ({
    root,
    activeTaskIds: new Set<string>(),
    statusOf: () => undefined as TaskStatus | undefined,
    maxAgeMs: 1,
    doneTtlMs: 0,
    maxBytes: 1,
    ...over,
  });

  test('a data root pointed at an existing directory keeps its unrelated children', async () => {
    mkdirSync(join(root, 'projects', 'app'), { recursive: true });
    writeFileSync(join(root, 'projects', 'app', 'f'), 'precious');
    mkdirSync(join(root, 'Documents'), { recursive: true });
    const res = await sweepOpenCodeTaskData(base());
    expect(res.removed).toEqual([]);
    expect(existsSync(join(root, 'projects', 'app', 'f'))).toBe(true);
    expect(existsSync(join(root, 'Documents'))).toBe(true);
  });

  test('a symlink in the root is never followed or removed, even when its name looks like a task id', async () => {
    const target = mkdtempSync(join(tmpdir(), 'oc-elsewhere-'));
    try {
      writeFileSync(join(target, 'keep'), 'x');
      symlinkSync(target, join(root, 'looks-like-a-task'));
      const res = await sweepOpenCodeTaskData(base());
      expect(res.removed).toEqual([]);
      expect(existsSync(join(target, 'keep'))).toBe(true);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test('a marker for a different task id does not authorise deletion', async () => {
    const d = join(root, 'task-a');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, TASK_DIR_MARKER), 'someone-else\n');
    expect((await sweepOpenCodeTaskData(base())).removed).toEqual([]);
    expect(await isMarkedTaskDir(d, 'task-a')).toBe(false);
    expect(await removeMarkedTaskDir(d, 'task-a')).toBe(false);
    expect(existsSync(d)).toBe(true);
  });

  test('a non-terminal task (live session surviving a Kookr restart) is never evicted by the age or size cap', async () => {
    const d = join(root, 'live-task');
    mkdirSync(join(d, 'data'), { recursive: true });
    writeFileSync(join(d, 'data', 'blob'), Buffer.alloc(300_000));
    await markTaskDir(d, 'live-task');
    const t = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(d, t, t);
    for (const status of ['inProgress', 'pending', 'open'] as const) {
      const res = await sweepOpenCodeTaskData(base({ statusOf: () => status, maxAgeMs: 86_400_000, maxBytes: 1_000 }));
      expect(res.removed).toEqual([]);
      expect(existsSync(join(d, 'data', 'blob'))).toBe(true);
    }
    // a terminated task of the same size/age is still evicted by the caps
    const res = await sweepOpenCodeTaskData(base({ statusOf: () => 'terminated' as TaskStatus, maxAgeMs: 86_400_000 }));
    expect(res.removed.map((r) => r.taskId)).toEqual(['live-task']);
  });

  test('isActive is re-checked right before each removal (a launch can start during a long sweep)', async () => {
    const d = join(root, 'resuming-task');
    mkdirSync(d, { recursive: true });
    await markTaskDir(d, 'resuming-task');
    const res = await sweepOpenCodeTaskData(base({ isActive: (id: string) => id === 'resuming-task' }));
    expect(res.removed).toEqual([]);
    expect(existsSync(d)).toBe(true);
  });

  test('marked dirs are still swept, and isAbsentOrEmptyDir only accepts absent/empty real dirs', async () => {
    const d = join(root, 'task-b');
    mkdirSync(d, { recursive: true });
    await markTaskDir(d, 'task-b');
    expect((await sweepOpenCodeTaskData(base())).removed.map((r) => r.taskId)).toEqual(['task-b']);
    expect(existsSync(d)).toBe(false);
    expect(await isAbsentOrEmptyDir(join(root, 'nope'))).toBe(true);
    mkdirSync(join(root, 'empty'));
    expect(await isAbsentOrEmptyDir(join(root, 'empty'))).toBe(true);
    mkdirSync(join(root, 'full'));
    writeFileSync(join(root, 'full', 'f'), 'x');
    expect(await isAbsentOrEmptyDir(join(root, 'full'))).toBe(false);
  });
});
