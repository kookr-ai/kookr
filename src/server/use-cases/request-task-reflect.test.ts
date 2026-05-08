import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REFLECT_IDENTITY_FILE,
  REFLECT_IDENTITY_SCHEMA,
  sweepReflectWorktrees,
} from './request-task-reflect.js';
import type { Task, TaskStore } from '../../core/tasks.js';

const VALID_UUID_A = '11111111-2222-3333-4444-555555555555';
const VALID_UUID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeTaskStore(reflectSourceIds: string[]): TaskStore {
  const tasks: Partial<Task>[] = reflectSourceIds.map((sid, idx) => ({
    id: `reflect-task-${idx}`,
    reflectMeta: { sourceTaskId: sid, bundlePath: '/tmp/bundle', direction: 'down' as const },
  }));
  return { listTasks: () => tasks as Task[] } as unknown as TaskStore;
}

function writeIdentity(dir: string, payload: unknown) {
  writeFileSync(join(dir, REFLECT_IDENTITY_FILE), JSON.stringify(payload));
}

describe('sweepReflectWorktrees', () => {
  let baseDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'reflect-sweep-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  it('returns zeros when the reflect worktrees dir does not exist', async () => {
    const missing = join(baseDir, 'does-not-exist');
    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: missing,
      taskStore: makeTaskStore([]),
    });
    expect(result).toEqual({ removed: 0, kept: 0 });
  });

  it('keeps a worktree when identity file has valid UUID and source task is alive', async () => {
    const dir = join(baseDir, `${VALID_UUID_A}-2026-05-08T19-30-45-123Z`);
    mkdirSync(dir);
    writeIdentity(dir, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_A,
      createdAt: new Date().toISOString(),
    });

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: baseDir,
      taskStore: makeTaskStore([VALID_UUID_A]),
    });

    expect(result).toEqual({ removed: 0, kept: 1 });
    expect(existsSync(dir)).toBe(true);
  });

  it('removes a worktree when identity file has valid UUID but no live source task', async () => {
    const dir = join(baseDir, `${VALID_UUID_B}-2026-05-08T19-30-45-123Z`);
    mkdirSync(dir);
    writeIdentity(dir, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_B,
      createdAt: new Date().toISOString(),
    });

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: baseDir,
      taskStore: makeTaskStore([]),
    });

    expect(result).toEqual({ removed: 1, kept: 0 });
    expect(existsSync(dir)).toBe(false);
  });

  it('does not classify as reflect when identity sourceTaskId is not a UUID', async () => {
    const dir = join(baseDir, 'manual-named-by-user');
    mkdirSync(dir);
    writeIdentity(dir, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: 'not-a-uuid',
      createdAt: new Date().toISOString(),
    });

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: baseDir,
      taskStore: makeTaskStore([]),
    });

    expect(result).toEqual({ removed: 0, kept: 1 });
    expect(existsSync(dir)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      '[reflect-sweep] identity file missing valid sourceTaskId',
      expect.objectContaining({ dir }),
    );
  });

  it('does not classify as reflect when identity file is malformed JSON', async () => {
    const dir = join(baseDir, `${VALID_UUID_A}-broken-json`);
    mkdirSync(dir);
    writeFileSync(join(dir, REFLECT_IDENTITY_FILE), '{not json');

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: baseDir,
      taskStore: makeTaskStore([]),
    });

    expect(result).toEqual({ removed: 0, kept: 1 });
    expect(existsSync(dir)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      '[reflect-sweep] identity file parse error',
      expect.objectContaining({ dir }),
    );
  });

  it('falls back to UUID basename parse when identity file is missing (legacy worktree)', async () => {
    const dir = join(baseDir, `${VALID_UUID_A}-2026-05-08T19-30-45-123Z`);
    mkdirSync(dir);
    // Intentionally no identity file written.

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: baseDir,
      taskStore: makeTaskStore([VALID_UUID_A]),
    });

    expect(result).toEqual({ removed: 0, kept: 1 });
    expect(existsSync(dir)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      '[reflect-sweep] legacy worktree without identity file',
      expect.objectContaining({ dir, sourceTaskId: VALID_UUID_A }),
    );
  });

  it('does not classify a manually-named directory matching `*-*`', async () => {
    const dir = join(baseDir, 'my-personal-scratch-dir');
    mkdirSync(dir);
    // No identity file, basename is not a UUID — must remain untouched.

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: baseDir,
      taskStore: makeTaskStore([]),
    });

    expect(result).toEqual({ removed: 0, kept: 1 });
    expect(existsSync(dir)).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('removes a TTL-expired worktree even when its source task is alive', async () => {
    const dir = join(baseDir, `${VALID_UUID_A}-old`);
    mkdirSync(dir);
    writeIdentity(dir, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_A,
      createdAt: '2020-01-01T00:00:00Z',
    });
    // Backdate mtime to 30 days ago.
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(dir, old, old);

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: baseDir,
      taskStore: makeTaskStore([VALID_UUID_A]),
    });

    expect(result).toEqual({ removed: 1, kept: 0 });
    expect(existsSync(dir)).toBe(false);
  });

  it('ignores non-directory entries at the reflect root', async () => {
    writeFileSync(join(baseDir, 'stray-file.txt'), 'not a dir');

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: baseDir,
      taskStore: makeTaskStore([]),
    });

    expect(result).toEqual({ removed: 0, kept: 0 });
  });
});
