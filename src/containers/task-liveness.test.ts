import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { loadTaskLiveness } from './task-liveness.js';

describe('loadTaskLiveness (tasks.json)', () => {
  let dir: string;
  const env = { KOOKR_TASK_STORE: 'json' } as NodeJS.ProcessEnv;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-live-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test('classifies live, terminal (with end time) and unknown tasks', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 2, tasks: [
      { id: 'a', status: 'inProgress' },
      { id: 'b', status: 'completed', updatedAt: '2026-01-01T00:00:00Z' },
    ] }));
    const look = await loadTaskLiveness(dir, ['a', 'b', 'c'], env);
    expect(look('a')).toEqual({ state: 'live' });
    expect(look('b')).toEqual({ state: 'terminal', endedAt: new Date('2026-01-01T00:00:00Z') });
    expect(look('c')).toEqual({ state: 'unknown' });
  });
  test('a row without a usable status is store_unreadable, not unknown', async () => {
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ version: 2, tasks: [{ id: 'a' }] }));
    expect((await loadTaskLiveness(dir, ['a'], env))('a')).toEqual({ state: 'store_unreadable' });
  });
  test('a missing, corrupt or shapeless store is store_unreadable for every task (never unknown)', async () => {
    expect((await loadTaskLiveness(dir, ['a'], env))('a')).toEqual({ state: 'store_unreadable' });
    writeFileSync(join(dir, 'tasks.json'), '{nope');
    expect((await loadTaskLiveness(dir, ['a'], env))('a')).toEqual({ state: 'store_unreadable' });
    writeFileSync(join(dir, 'tasks.json'), '{"foo":1}');
    expect((await loadTaskLiveness(dir, ['a'], env))('a')).toEqual({ state: 'store_unreadable' });
  });
});
