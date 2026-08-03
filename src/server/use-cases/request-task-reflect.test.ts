import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
  symlinkSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS,
  REFLECT_IDENTITY_FILE,
  REFLECT_IDENTITY_SCHEMA,
  removeReflectWorktree,
  requestTaskReflect,
  resolveReflectWorktreeSweepIntervalHours,
  runScheduledReflectWorktreeSweep,
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

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return execFileSync('git', args, { cwd, stdio: 'pipe', env, encoding: 'utf8' }).trim();
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
      // Simulate launch-service resolving the configured default when agentType is omitted.
      const resolvedAgent = opts.agentType ?? 'grok-build';
      return {
        task: store.createTask({ prompt: opts.prompt, cwd: opts.cwd, agentType: resolvedAgent as 'grok-build' }),
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
      disableDedup: true,
      launchSource: 'api',
      sandboxProfile: 'reflect',
    });
    // Reflect must not pin Claude Code; omit agentType so launch-service uses the operator default.
    expect(launchOpts.agentType).toBeUndefined();
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
    expect(reflectTask?.agentType).toBe('grok-build');
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

  it('removes a legacy UUID directory when its source task is no longer live', async () => {
    const dir = join(baseDir, `${VALID_UUID_B}-2026-05-08T19-30-45-123Z`);
    mkdirSync(dir);

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: baseDir,
      taskStore: makeTaskStore([]),
    });

    expect(result).toEqual({ removed: 1, kept: 0 });
    expect(existsSync(dir)).toBe(false);
  });

  it('removes a stale registered Git worktree through the startup sweep', async () => {
    const repo = join(baseDir, 'repo');
    const reflectRoot = join(baseDir, 'reflect-worktrees');
    const dir = join(reflectRoot, `${VALID_UUID_B}-2026-05-08T19-30-45-123Z`);
    mkdirSync(repo, { recursive: true });
    mkdirSync(reflectRoot, { recursive: true });
    initGitRepo(repo);
    git(repo, 'worktree', 'add', '--quiet', '--detach', dir, 'HEAD');
    writeIdentity(dir, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_B,
      createdAt: new Date().toISOString(),
    });

    const result = await sweepReflectWorktrees({
      reflectWorktreesDir: reflectRoot,
      taskStore: makeTaskStore([]),
    });

    expect(result).toEqual({ removed: 1, kept: 0 });
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain(dir);
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

  it('removes a TTL-expired legacy UUID directory even when its source task is alive', async () => {
    const dir = join(baseDir, `${VALID_UUID_A}-old`);
    mkdirSync(dir);
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

describe('resolveReflectWorktreeSweepIntervalHours (issue #1860)', () => {
  it('defaults to 1h when unset so long-lived prod instances sweep without config', () => {
    expect(resolveReflectWorktreeSweepIntervalHours({})).toBe(
      DEFAULT_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS,
    );
    expect(resolveReflectWorktreeSweepIntervalHours({
      KOOKR_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS: '',
    })).toBe(DEFAULT_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS);
    expect(resolveReflectWorktreeSweepIntervalHours({
      KOOKR_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS: 'nope',
    })).toBe(DEFAULT_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS);
  });

  it('accepts 0 to disable and positive hours to override cadence', () => {
    expect(resolveReflectWorktreeSweepIntervalHours({
      KOOKR_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS: '0',
    })).toBe(0);
    expect(resolveReflectWorktreeSweepIntervalHours({
      KOOKR_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS: '2',
    })).toBe(2);
    expect(resolveReflectWorktreeSweepIntervalHours({
      KOOKR_REFLECT_WORKTREE_SWEEP_INTERVAL_HOURS: '0.5',
    })).toBe(0.5);
  });
});

describe('runScheduledReflectWorktreeSweep (issue #1860)', () => {
  it('logs removed/kept counts and returns the sweep result', async () => {
    const run = vi.fn(async () => ({ removed: 2, kept: 3 }));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await runScheduledReflectWorktreeSweep({
      reflectWorktreesDir: '/tmp/reflect-worktrees',
      taskStore: makeTaskStore([]),
      intervalHours: 1,
      run,
    });
    expect(result).toEqual({ removed: 2, kept: 3 });
    expect(run).toHaveBeenCalledWith({
      reflectWorktreesDir: '/tmp/reflect-worktrees',
      taskStore: expect.anything(),
    });
    expect(logSpy.mock.calls.flat().join(' ')).toMatch(
      /scheduled sweep removed 2 orphaned reflect worktree\(s\), kept 3/,
    );
    logSpy.mockRestore();
  });

  it('never throws — a failing sweep is logged and returns null', async () => {
    const run = vi.fn(async () => {
      throw new Error('disk exploded');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runScheduledReflectWorktreeSweep({
      reflectWorktreesDir: '/tmp/reflect-worktrees',
      taskStore: makeTaskStore([]),
      intervalHours: 1,
      run,
    });
    expect(result).toBeNull();
    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/scheduled sweep failed/);
    errSpy.mockRestore();
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

    const removed = await removeReflectWorktree(worktreePath, baseDir);

    expect(removed).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('falls back to rm for a markerless legacy UUID directory', async () => {
    const dir = join(baseDir, `${VALID_UUID_A}-plain`);
    mkdirSync(dir);

    const removed = await removeReflectWorktree(dir, baseDir, { allowLegacy: true });

    expect(removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses to delete a bare primary repository even without a .git child', async () => {
    const seed = join(baseDir, 'seed');
    const bare = join(baseDir, `${VALID_UUID_A}-bare`);
    mkdirSync(seed);
    initGitRepo(seed);
    execFileSync('git', ['clone', '--quiet', '--bare', seed, bare], { stdio: 'pipe' });
    writeIdentity(bare, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_A,
      createdAt: new Date().toISOString(),
    });

    expect(await removeReflectWorktree(bare, baseDir)).toBe(false);
    expect(existsSync(bare)).toBe(true);
  });

  it('is a no-op when the path is undefined', async () => {
    expect(await removeReflectWorktree(undefined)).toBe(false);
  });

  it('refuses to delete a directory that lacks the identity marker', async () => {
    const dir = join(baseDir, 'not-a-reflect-worktree');
    mkdirSync(dir);
    writeFileSync(join(dir, 'keep.txt'), 'precious');

    const removed = await removeReflectWorktree(dir, baseDir);

    expect(removed).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, 'keep.txt'))).toBe(true);
  });

  it('refuses the legacy filesystem fallback for a Git-looking directory', async () => {
    const dir = join(baseDir, `${VALID_UUID_A}-git-looking`);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeIdentity(dir, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_A,
      createdAt: new Date().toISOString(),
    });

    expect(await removeReflectWorktree(dir, baseDir)).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });

  it('refuses marked directories outside the configured reflect root', async () => {
    const outside = join(baseDir, 'outside');
    mkdirSync(join(baseDir, 'reflect-root'));
    mkdirSync(outside);
    writeIdentity(outside, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_A,
      createdAt: new Date().toISOString(),
    });

    expect(await removeReflectWorktree(outside, join(baseDir, 'reflect-root'))).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  it('refuses nested and symlinked paths even when their identity marker is valid', async () => {
    const nested = join(baseDir, 'reflect-root', 'nested', 'worktree');
    mkdirSync(nested, { recursive: true });
    writeIdentity(nested, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_A,
      createdAt: new Date().toISOString(),
    });

    expect(await removeReflectWorktree(nested, join(baseDir, 'reflect-root'))).toBe(false);
    expect(existsSync(nested)).toBe(true);

    const outside = join(baseDir, 'symlink-target');
    const link = join(baseDir, 'reflect-root', `${VALID_UUID_B}-link`);
    mkdirSync(outside);
    writeIdentity(outside, {
      schema: REFLECT_IDENTITY_SCHEMA,
      sourceTaskId: VALID_UUID_B,
      createdAt: new Date().toISOString(),
    });
    mkdirSync(join(baseDir, 'reflect-root'), { recursive: true });
    symlinkSync(outside, link, 'dir');

    expect(await removeReflectWorktree(link, join(baseDir, 'reflect-root'))).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(link)).toBe(true);
  });
});
