import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openCodeTaskDir,
  parseDataCap,
  readOpenCodeSessionId,
  resolveOpenCodeDataRoot,
  sweepOpenCodeTaskData,
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

describe('sweepOpenCodeTaskData', () => {
  const day = 86_400_000;
  function taskDir(id: string, bytes = 10, ageMs = 0): string {
    const d = join(root, id);
    mkdirSync(join(d, 'data'), { recursive: true });
    writeFileSync(join(d, 'data', 'blob'), Buffer.alloc(bytes));
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
