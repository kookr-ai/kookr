import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REFLECT_IDENTITY_FILE,
  REFLECT_IDENTITY_SCHEMA,
  removeReflectWorktree,
  requestTaskReflect,
  sweepReflectWorktrees,
} from './request-task-reflect.js';
import { TaskStore, type Task } from '../../core/tasks.js';
import type { LaunchOpts } from '../launch-service.js';

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

function git(cwd: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  execFileSync('git', args, { cwd, stdio: 'pipe', env });
}

function initGitRepo(dir: string) {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  writeFileSync(join(dir, 'README.md'), '# test\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'branch', '-M', 'main');
}

function writeFakeReflectSkill(pluginDir: string) {
  const skillDir = join(pluginDir, 'skills', 'task-feedback-reflect');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: task-feedback-reflect',
      'skillSchemaVersion: 1',
      '---',
      '',
      'Use this fake test skill to analyze the immutable feedback bundle and record a concise reflection.',
      'The body is intentionally long enough to satisfy the production skill verification length check.',
    ].join('\n'),
  );
}

describe('requestTaskReflect', () => {
  let baseDir: string;
  let repoDir: string;
  let reflectWorktreesDir: string;
  let pluginDir: string;
  let bundlePath: string;
  let store: TaskStore;
  let createdWorktree: string | undefined;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'reflect-request-'));
    repoDir = join(baseDir, 'repo');
    reflectWorktreesDir = join(baseDir, 'reflect-worktrees');
    pluginDir = join(baseDir, 'plugin');
    bundlePath = join(baseDir, 'feedback-bundle');
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(bundlePath, { recursive: true });
    writeFileSync(join(bundlePath, 'bundle.json'), '{}\n');
    initGitRepo(repoDir);
    writeFakeReflectSkill(pluginDir);
    store = new TaskStore();
    createdWorktree = undefined;
  });

  afterEach(() => {
    if (createdWorktree && existsSync(createdWorktree)) {
      try {
        git(repoDir, 'worktree', 'remove', '--force', createdWorktree);
      } catch {
        rmSync(createdWorktree, { recursive: true, force: true });
      }
    }
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('launches the reflection task inside the reflect worktree with the reflect sandbox profile', async () => {
    const sourceTask = store.createTask({ prompt: 'finish feature', cwd: repoDir, agentType: 'codex-cli' });
    const launchTask = vi.fn(async (opts: LaunchOpts) => {
      createdWorktree = opts.cwd;
      return {
        task: store.createTask({ prompt: opts.prompt, cwd: opts.cwd, agentType: 'claude-code' }),
        queued: false,
      };
    });

    const result = await requestTaskReflect(
      { sourceTaskId: sourceTask.id, bundlePath, direction: 'up' },
      {
        taskStore: store,
        reflectWorktreesDir,
        launchTask,
        pluginDirOverride: pluginDir,
      },
    );

    expect(result.spawned).toBe(true);
    expect(launchTask).toHaveBeenCalledOnce();
    const launchOpts = launchTask.mock.calls[0][0];
    expect(launchOpts).toMatchObject({
      agentType: 'claude-code',
      disableDedup: true,
      launchSource: 'api',
      sandboxProfile: 'reflect',
    });
    expect(launchOpts.cwd).toContain(reflectWorktreesDir);
    expect(launchOpts.cwd).not.toBe(repoDir);
    expect(existsSync(join(launchOpts.cwd, REFLECT_IDENTITY_FILE))).toBe(true);

    const reflectTask = store.getTask(result.reflectTaskId!);
    expect(reflectTask?.reflectMeta).toEqual({
      sourceTaskId: sourceTask.id,
      bundlePath,
      direction: 'up',
      worktreePath: launchOpts.cwd,
    });
  });

  it('falls back to origin/main when the local main branch is absent', async () => {
    git(repoDir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repoDir, 'checkout', '--detach', 'HEAD');
    writeFileSync(join(repoDir, 'DETACHED_HEAD_ONLY.md'), '# detached\n');
    git(repoDir, 'add', 'DETACHED_HEAD_ONLY.md');
    git(repoDir, 'commit', '-m', 'detached-only commit');
    git(repoDir, 'branch', '-D', 'main');
    const sourceTask = store.createTask({ prompt: 'finish feature', cwd: repoDir, agentType: 'codex-cli' });
    const launchTask = vi.fn(async (opts: LaunchOpts) => {
      createdWorktree = opts.cwd;
      return {
        task: store.createTask({ prompt: opts.prompt, cwd: opts.cwd, agentType: 'claude-code' }),
        queued: false,
      };
    });

    const result = await requestTaskReflect(
      { sourceTaskId: sourceTask.id, bundlePath, direction: 'up' },
      {
        taskStore: store,
        reflectWorktreesDir,
        launchTask,
        pluginDirOverride: pluginDir,
      },
    );

    expect(result.spawned).toBe(true);
    expect(launchTask).toHaveBeenCalledOnce();
    const worktreePath = launchTask.mock.calls[0][0].cwd;
    expect(existsSync(join(worktreePath, REFLECT_IDENTITY_FILE))).toBe(true);
    expect(existsSync(join(worktreePath, 'DETACHED_HEAD_ONLY.md'))).toBe(false);
  });
});

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

describe('removeReflectWorktree', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'reflect-remove-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('removes a real git worktree that carries the identity marker', async () => {
    const repoDir = join(baseDir, 'repo');
    mkdirSync(repoDir);
    initGitRepo(repoDir);
    const worktreePath = join(baseDir, `${VALID_UUID_A}-2026-06-05T00-00-00-000Z`);
    git(repoDir, 'worktree', 'add', '--detach', worktreePath, 'main');
    writeIdentity(worktreePath, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_A,
      createdAt: new Date().toISOString(),
    });

    const removed = await removeReflectWorktree(worktreePath);

    expect(removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('falls back to rm for a plain dir carrying the identity marker', async () => {
    const dir = join(baseDir, `${VALID_UUID_A}-plain`);
    mkdirSync(dir);
    writeIdentity(dir, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_A,
      createdAt: new Date().toISOString(),
    });

    const removed = await removeReflectWorktree(dir);

    expect(removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('is a no-op when the path is undefined', async () => {
    expect(await removeReflectWorktree(undefined)).toBe(false);
  });

  it('refuses to delete a directory that lacks the identity marker', async () => {
    const dir = join(baseDir, 'not-a-reflect-worktree');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'precious');

    const removed = await removeReflectWorktree(dir);

    expect(removed).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
  });
});
