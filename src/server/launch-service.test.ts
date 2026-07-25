import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../core/tasks.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import { checkSubmission, launchTask, CwdValidationError, isCwdValidationError, DrainModeError, EffortValidationError, ModelValidationError, type LaunchServiceDeps } from './launch-service.js';
import type { LaunchPreflightFinding } from '../core/launch-dependency-preflight.js';
import { IdempotencyLedger } from '../core/idempotency-ledger.js';

// Minimal stubs for adapter and lifecycle deps
function makeDeps(taskStore: TaskStore): LaunchServiceDeps {
  const claudeAdapter = {
    agentType: 'claude-code',
    launch: vi.fn().mockResolvedValue('tmux-claude'),
    sendInput: vi.fn(),
    sendKeystroke: vi.fn(),
    stop: vi.fn(),
    captureDisplay: vi.fn(),
    onEvent: vi.fn(),
    onRefreshNeeded: vi.fn(),
    injectHookEvent: vi.fn(),
  } as any;
  const codexAdapter = {
    agentType: 'codex-cli',
    launch: vi.fn().mockResolvedValue('tmux-codex'),
    sendInput: vi.fn(),
    sendKeystroke: vi.fn(),
    stop: vi.fn(),
    captureDisplay: vi.fn(),
    onEvent: vi.fn(),
    onRefreshNeeded: vi.fn(),
    injectHookEvent: vi.fn(),
  } as any;
  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(claudeAdapter);
  adapterRegistry.register(codexAdapter);
  return {
    taskStore,
    adapterRegistry,
    lifecycleDeps: {
      monitor: { registerAgent: vi.fn() } as any,
      watchdog: { registerAgent: vi.fn() } as any,
      hookWatcher: { watch: vi.fn() } as any,
      githubScanner: { scanTask: vi.fn(), isActive: vi.fn().mockReturnValue(false), processTaskPrompt: vi.fn() } as any,
      autoNameTask: vi.fn(),
    } as any,
  };
}

function git(cwd: string, ...args: string[]) {
  // Strip GIT_DIR/GIT_WORK_TREE so tests aren't polluted when run from a
  // git hook (e.g. pre-push), which sets GIT_DIR in the environment.
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  execFileSync('git', args, { cwd, stdio: 'pipe', env });
}

async function initGitRepo(dir: string) {
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  await writeFile(join(dir, 'README.md'), '# test\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'branch', '-M', 'main');
}

describe('checkSubmission', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it('returns undefined when no tasks exist', () => {
    expect(checkSubmission(store, 'fix the bug', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('returns the existing task when an active task has the same prompt and cwd', () => {
    const task = store.createTask({ prompt: 'fix the bug', cwd: '/tmp' });
    store.startTask(task.id);
    const found = checkSubmission(store, 'fix the bug', 'claude-code', '/tmp');
    expect(found?.id).toBe(task.id);
  });

  it('returns undefined for a different prompt', () => {
    const task = store.createTask({ prompt: 'fix the bug', cwd: '/tmp' });
    store.startTask(task.id);
    expect(checkSubmission(store, 'add the feature', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('blocks on open status', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    // Task is 'open' by default
    expect(task.status).toBe('open');
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')?.id).toBe(task.id);
  });

  it('blocks on pending status', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.pendTask(task.id);
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')?.id).toBe(task.id);
  });

  it('blocks on inProgress status', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.startTask(task.id);
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')?.id).toBe(task.id);
  });

  it('allows re-submission when existing task is completed', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.startTask(task.id);
    store.completeTask(task.id);
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('allows re-submission when existing task is cancelled', () => {
    const task = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.startTask(task.id);
    store.cancelTask(task.id);
    expect(checkSubmission(store, 'do something', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('does not trim whitespace — exact prompt match only', () => {
    store.createTask({ prompt: '  fix  ', cwd: '/tmp' });
    expect(checkSubmission(store, 'fix', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('allows the same prompt for a different agent type', () => {
    const task = store.createTask({ prompt: 'fix the bug', cwd: '/tmp', agentType: 'claude-code' });
    store.startTask(task.id);
    expect(checkSubmission(store, 'fix the bug', 'codex-cli', '/tmp')).toBeUndefined();
  });

  it('does not dedup when the cwd differs (same prompt, different repos)', () => {
    const task = store.createTask({ prompt: 'review the diff', cwd: '/tmp/repo-a' });
    store.startTask(task.id);
    expect(
      checkSubmission(store, 'review the diff', 'claude-code', '/tmp/repo-b'),
    ).toBeUndefined();
  });

  it('treats trailing slashes as the same cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dedup-trailing-'));
    try {
      const task = store.createTask({ prompt: 'do it', cwd: dir });
      store.startTask(task.id);
      expect(
        checkSubmission(store, 'do it', 'claude-code', `${dir}/`)?.id,
      ).toBe(task.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a cwd and its symlink as the same task', async () => {
    const target = await mkdtemp(join(tmpdir(), 'dedup-target-'));
    const link = join(tmpdir(), `dedup-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await symlink(target, link);
      const task = store.createTask({ prompt: 'do it', cwd: target });
      store.startTask(task.id);
      expect(
        checkSubmission(store, 'do it', 'claude-code', link)?.id,
      ).toBe(task.id);
    } finally {
      await rm(link, { force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it('falls back to path.resolve() when the cwd does not exist', () => {
    // Non-existent absolute path — realpathSync throws, canonicalizeCwd falls
    // back to path.resolve. Both sides fall back the same way, so they match.
    const task = store.createTask({
      prompt: 'do it',
      cwd: '/nonexistent/kookr-test-path/a/..',
    });
    store.startTask(task.id);
    expect(
      checkSubmission(store, 'do it', 'claude-code', '/nonexistent/kookr-test-path')?.id,
    ).toBe(task.id);
  });

  it('on case-insensitive filesystems, dedups case-aliased cwds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dedup-caseAlias-'));
    try {
      const upper = realpathSync(dir);
      // Heuristic: if lowering the case produces a path that realpaths to the
      // same physical directory, we are on a case-insensitive FS (default
      // macOS). Otherwise, skip — the behavior under test only applies there.
      const lower = upper.toLowerCase();
      let caseInsensitive = false;
      try {
        caseInsensitive = realpathSync(lower) === upper;
      } catch {
        caseInsensitive = false;
      }
      if (!caseInsensitive) return; // skip on Linux / case-sensitive volumes
      const task = store.createTask({ prompt: 'do it', cwd: upper });
      store.startTask(task.id);
      expect(
        checkSubmission(store, 'do it', 'claude-code', lower)?.id,
      ).toBe(task.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('launchTask', () => {
  let store: TaskStore;
  let deps: LaunchServiceDeps;
  let repoDir: string;

  beforeEach(async () => {
    store = new TaskStore();
    deps = makeDeps(store);
    repoDir = await mkdtemp(join(tmpdir(), 'launch-task-'));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('creates a new task normally', async () => {
    const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(result.duplicate).toBeUndefined();
    expect(result.task.prompt).toBe('hello');
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  describe('per-task effort override (#681)', () => {
    /** The AdapterLaunchOptions (5th) arg of the first adapter.launch call. */
    function launchOptsFor(deps: LaunchServiceDeps, agent: 'claude-code' | 'codex-cli') {
      const launch = vi.mocked(deps.adapterRegistry.get(agent).launch);
      return launch.mock.calls[0]?.[4];
    }

    it('with no effort, passes no effort override', async () => {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
      // 5th arg is undefined (no ralph env, no effort override).
      expect(launchOptsFor(deps, 'claude-code')).toBeUndefined();
    });

    it('threads a valid override to the adapter as opts.effort', async () => {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp', effort: 'max' });
      expect(launchOptsFor(deps, 'claude-code')).toMatchObject({ effort: 'max' });
    });

    it('threads the reflect sandbox profile to the adapter', async () => {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp', sandboxProfile: 'reflect' });
      expect(launchOptsFor(deps, 'claude-code')).toMatchObject({ sandboxProfile: 'reflect' });
    });

    it('validates against the RESOLVED agent: an unknown level is rejected for codex-cli', async () => {
      await expect(
        launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'codex-cli', effort: 'supermax' }),
      ).rejects.toBeInstanceOf(EffortValidationError);
      // Fail-fast: no task record, no adapter launch.
      expect(store.listTasks()).toHaveLength(0);
      expect(deps.adapterRegistry.get('codex-cli').launch).not.toHaveBeenCalled();
    });

    it('accepts a codex-only level for codex-cli (minimal)', async () => {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'codex-cli', effort: 'minimal' });
      expect(launchOptsFor(deps, 'codex-cli')).toMatchObject({ effort: 'minimal' });
    });

    it('accepts max for codex-cli', async () => {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'codex-cli', effort: 'max' });
      expect(launchOptsFor(deps, 'codex-cli')).toMatchObject({ effort: 'max' });
    });

    it('accepts ultra for codex-cli', async () => {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'codex-cli', effort: 'ultra' });
      expect(launchOptsFor(deps, 'codex-cli')).toMatchObject({ effort: 'ultra' });
    });

    it('rejects an entirely unknown effort token', async () => {
      await expect(
        launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'claude-code', effort: 'ultra' }),
      ).rejects.toBeInstanceOf(EffortValidationError);
    });

    it('rejects an empty-string effort (guards the !== undefined check, not truthiness)', async () => {
      // If the guard regressed to `if (opts.effort && ...)`, an empty string
      // would silently bypass validation and reach the adapter. The `!== undefined`
      // check must reject it.
      await expect(
        launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'claude-code', effort: '' }),
      ).rejects.toBeInstanceOf(EffortValidationError);
      expect(store.listTasks()).toHaveLength(0);
    });

    it('threads a valid model pin to the adapter as opts.model (#1518)', async () => {
      await launchTask(deps, {
        prompt: 'hello',
        cwd: '/tmp',
        model: 'claude-fable-5',
      });
      expect(launchOptsFor(deps, 'claude-code')).toMatchObject({ model: 'claude-fable-5' });
    });

    it('threads model together with effort (#1518)', async () => {
      await launchTask(deps, {
        prompt: 'hello',
        cwd: '/tmp',
        model: 'claude-fable-5',
        effort: 'max',
      });
      expect(launchOptsFor(deps, 'claude-code')).toMatchObject({
        model: 'claude-fable-5',
        effort: 'max',
      });
    });

    it('rejects an unknown model for claude-code without creating a task (#1518)', async () => {
      await expect(
        launchTask(deps, {
          prompt: 'hello',
          cwd: '/tmp',
          agentType: 'claude-code',
          model: 'not-a-real-model',
        }),
      ).rejects.toBeInstanceOf(ModelValidationError);
      expect(store.listTasks()).toHaveLength(0);
    });

    it('rejects any model pin for codex-cli empty allowlist (#1518)', async () => {
      await expect(
        launchTask(deps, {
          prompt: 'hello',
          cwd: '/tmp',
          agentType: 'codex-cli',
          model: 'claude-fable-5',
        }),
      ).rejects.toBeInstanceOf(ModelValidationError);
    });

    it('rejects empty-string model (#1518)', async () => {
      await expect(
        launchTask(deps, { prompt: 'hello', cwd: '/tmp', model: '' }),
      ).rejects.toBeInstanceOf(ModelValidationError);
    });
  });

  describe('operator drain gate (issue #659)', () => {
    it('refuses a launch with DrainModeError while draining, creating no task', async () => {
      const drainingDeps = { ...deps, isAccepting: () => false };
      await expect(launchTask(drainingDeps, { prompt: 'blocked', cwd: '/tmp' }))
        .rejects.toThrow(DrainModeError);
      // No side effects: no task record, no adapter launch.
      expect(store.listTasks()).toHaveLength(0);
      expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    });

    it('does not affect an already-running task when drain begins', async () => {
      // A task launched before drain stays in the store; drain only gates new launches.
      const running = await launchTask(deps, { prompt: 'live', cwd: '/tmp' });
      const drainingDeps = { ...deps, isAccepting: () => false };
      await expect(launchTask(drainingDeps, { prompt: 'new', cwd: '/tmp' }))
        .rejects.toThrow(DrainModeError);
      expect(store.getTask(running.task.id)?.status).toBe(running.task.status);
      expect(store.listTasks()).toHaveLength(1);
    });

    it('resumes launches once accepting again', async () => {
      let accepting = false;
      const gatedDeps = { ...deps, isAccepting: () => accepting };
      await expect(launchTask(gatedDeps, { prompt: 'first', cwd: '/tmp' }))
        .rejects.toThrow(DrainModeError);
      accepting = true;
      const result = await launchTask(gatedDeps, { prompt: 'second', cwd: '/tmp' });
      expect(result.task.prompt).toBe('second');
    });
  });

  it('records declared KB dependency preflight failures as advisory launch health', async () => {
    const finding: LaunchPreflightFinding = {
      dependency: 'kb',
      status: 'failed',
      category: 'server_reachability',
      summary: 'KB unavailable',
      detail: 'ECONNREFUSED',
      recommendedAction: 'Start KB.',
    };
    const dependencyPreflightRunner = vi.fn().mockResolvedValue([finding]);
    const depsWithPreflight = { ...deps, dependencyPreflightRunner };

    const result = await launchTask(depsWithPreflight, {
      prompt: 'needs kb',
      cwd: '/tmp',
      dependencies: ['kb'],
    });

    expect(dependencyPreflightRunner).toHaveBeenCalledWith(['kb']);
    expect(result.task.prompt).toBe('needs kb');
    expect(result.task.launchHealthSummary).toEqual({
      degradedDependencies: ['kb'],
      findings: [finding],
    });
    expect(result.task.launchNote).toContain('KB unavailable');
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledWith(
      result.task.id,
      expect.stringContaining('KB unavailable'),
      '/tmp',
      undefined,
      undefined,
    );
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledWith(
      result.task.id,
      expect.stringContaining('needs kb'),
      '/tmp',
      undefined,
      undefined,
    );
  });

  it('keeps advisory launch notes out of the task prompt used for dedup', async () => {
    const finding: LaunchPreflightFinding = {
      dependency: 'kb',
      status: 'failed',
      category: 'query_runtime_failure',
      summary: 'KB search smoke failed',
      detail: 'Cannot read properties of undefined',
      recommendedAction: 'Run `kb doctor --format=json` and `kb search` manually.',
    };
    const dependencyPreflightRunner = vi.fn()
      .mockResolvedValueOnce([finding])
      .mockResolvedValueOnce([]);
    const depsWithPreflight = { ...deps, dependencyPreflightRunner };

    const first = await launchTask(depsWithPreflight, {
      prompt: 'needs kb',
      cwd: '/tmp',
      dependencies: ['kb'],
    });
    const second = await launchTask(depsWithPreflight, {
      prompt: 'needs kb',
      cwd: '/tmp',
      dependencies: ['kb'],
    });

    expect(first.task.prompt).toBe('needs kb');
    expect(second.duplicate).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('preserves advisory launch health for queued tasks', async () => {
    const finding: LaunchPreflightFinding = {
      dependency: 'kb',
      status: 'failed',
      category: 'empty_index_data',
      summary: 'KB index is empty',
      detail: 'FAISS index has no chunks',
      recommendedAction: 'Ingest the knowledge base.',
    };
    const dependencyPreflightRunner = vi.fn().mockResolvedValue([finding]);
    const result = await launchTask({
      ...deps,
      getMaxActiveTasks: () => 0,
      dependencyPreflightRunner,
    }, {
      prompt: 'queued kb task',
      cwd: '/tmp',
      dependencies: ['kb'],
    });

    expect(result.queued).toBe(true);
    expect(result.task.prompt).toBe('queued kb task');
    expect(result.task.launchHealthSummary?.findings).toEqual([finding]);
    expect(result.task.launchNote).toContain('KB index is empty');
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('redacts and bounds advisory dependency details before storing or launching', async () => {
    const rawDetail = '/home/jean/.config/kb token=sk-secret password=hunter2 '.repeat(30);
    const finding: LaunchPreflightFinding = {
      dependency: 'kb',
      status: 'failed',
      category: 'query_runtime_failure',
      summary: 'KB search smoke failed',
      detail: rawDetail,
      recommendedAction: 'Run `kb doctor --format=json` and `kb search` manually.',
    };
    const dependencyPreflightRunner = vi.fn().mockResolvedValue([finding]);

    const result = await launchTask({ ...deps, dependencyPreflightRunner }, {
      prompt: 'needs kb',
      cwd: '/tmp',
      dependencies: ['kb'],
    });

    const storedDetail = result.task.launchHealthSummary?.findings[0]?.detail ?? '';
    expect(storedDetail.length).toBeLessThanOrEqual(500);
    expect(storedDetail).not.toContain('/home/jean');
    expect(storedDetail).not.toContain('sk-secret');
    expect(storedDetail).not.toContain('hunter2');
    const launchPrompt = vi.mocked(deps.adapterRegistry.get('claude-code').launch).mock.calls[0]?.[1] ?? '';
    expect(launchPrompt).not.toContain('/home/jean');
    expect(launchPrompt).not.toContain('sk-secret');
    expect(launchPrompt).not.toContain('hunter2');
  });

  it('does not block launch when advisory preflight infrastructure throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dependencyPreflightRunner = vi.fn().mockRejectedValue(
      new Error('/home/jean/.config/kb token=sk-secret broke'),
    );

    try {
      const result = await launchTask({ ...deps, dependencyPreflightRunner }, {
        prompt: 'needs kb',
        cwd: '/tmp',
        dependencies: ['kb'],
      });

      expect(result.queued).toBe(false);
      expect(result.task.prompt).toBe('needs kb');
      expect(result.task.launchHealthSummary?.findings[0]).toEqual(expect.objectContaining({
        category: 'unknown',
        summary: 'KB dependency preflight could not complete',
      }));
      expect(result.task.launchHealthSummary?.findings[0]?.detail).not.toContain('/home/jean');
      expect(result.task.launchHealthSummary?.findings[0]?.detail).not.toContain('sk-secret');
      expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('launches normally when dependency preflights pass', async () => {
    const dependencyPreflightRunner = vi.fn().mockResolvedValue([]);
    const result = await launchTask({ ...deps, dependencyPreflightRunner }, {
      prompt: 'needs kb',
      cwd: '/tmp',
      dependencies: ['kb'],
    });

    expect(result.task.prompt).toBe('needs kb');
    expect(dependencyPreflightRunner).toHaveBeenCalledWith(['kb']);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('returns duplicate:true for an identical active prompt', async () => {
    // First launch
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(first.duplicate).toBeUndefined();

    // Second launch with same prompt — should be deduplicated
    const second = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(second.duplicate).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    // adapter.launch should only have been called once
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('can intentionally bypass active duplicate dedup and persist duplicate intent', async () => {
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    const second = await launchTask(deps, {
      prompt: 'hello',
      cwd: '/tmp',
      disableDedup: true,
      metadataIntent: 'keep_as_duplicate',
    });

    expect(second.duplicate).toBeUndefined();
    expect(second.task.id).not.toBe(first.task.id);
    expect(second.task.metadata).toEqual({ intent: 'keep_as_duplicate' });
    expect(store.getTask(second.task.id)?.metadata).toEqual({ intent: 'keep_as_duplicate' });
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledTimes(2);
  });

  it('bypasses and reconciles a stale inProgress duplicate whose session is gone', async () => {
    const existing = store.createTask({ prompt: 'hello', cwd: '/tmp' });
    store.addSession(existing.id, {
      tmuxSession: 'kookr-stale',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date(),
      lastStatus: 'running',
    });
    const terminalBackend = {
      isAlive: vi.fn().mockResolvedValue(false),
    };

    const result = await launchTask({ ...deps, terminalBackend }, { prompt: 'hello', cwd: '/tmp' });

    expect(result.duplicate).toBeUndefined();
    expect(result.task.id).not.toBe(existing.id);
    expect(terminalBackend.isAlive).toHaveBeenCalledWith('kookr-stale');
    expect(store.getTask(existing.id)!.status).toBe('terminated');
    expect(store.getTask(existing.id)!.sessions[0].lastStatus).toBe('completed');
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('keeps dedup idempotent for an inProgress duplicate with a live session', async () => {
    const existing = store.createTask({ prompt: 'hello', cwd: '/tmp' });
    store.addSession(existing.id, {
      tmuxSession: 'kookr-live',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date(),
      lastStatus: 'running',
    });
    const terminalBackend = {
      isAlive: vi.fn().mockResolvedValue(true),
    };

    const result = await launchTask({ ...deps, terminalBackend }, { prompt: 'hello', cwd: '/tmp' });

    expect(result.duplicate).toBe(true);
    expect(result.task.id).toBe(existing.id);
    expect(terminalBackend.isAlive).toHaveBeenCalledWith('kookr-live');
    expect(store.getTask(existing.id)!.status).toBe('inProgress');
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('continues scanning after a stale duplicate and still dedups a later live match', async () => {
    const stale = store.createTask({ prompt: 'hello', cwd: '/tmp' });
    store.addSession(stale.id, {
      tmuxSession: 'kookr-stale',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date(),
      lastStatus: 'running',
    });
    const live = store.createTask({ prompt: 'hello', cwd: '/tmp' });
    store.addSession(live.id, {
      tmuxSession: 'kookr-live',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date(),
      lastStatus: 'running',
    });
    const terminalBackend = {
      isAlive: vi.fn(async (sessionId: string) => sessionId === 'kookr-live'),
    };

    const result = await launchTask({ ...deps, terminalBackend }, { prompt: 'hello', cwd: '/tmp' });

    expect(result.duplicate).toBe(true);
    expect(result.task.id).toBe(live.id);
    expect(terminalBackend.isAlive).toHaveBeenCalledWith('kookr-stale');
    expect(terminalBackend.isAlive).toHaveBeenCalledWith('kookr-live');
    expect(store.getTask(stale.id)!.status).toBe('terminated');
    expect(store.getTask(live.id)!.status).toBe('inProgress');
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it.each([['running' as const], ['paused' as const]])(
    'keeps Ralph loop duplicate idempotent during a %s between-iteration gap',
    async (loopStatus) => {
      const existing = store.createTask({ prompt: 'hello', cwd: '/tmp' });
      store.addSession(existing.id, {
        tmuxSession: 'kookr-prior',
        agentType: 'claude-code',
        cwd: '/tmp',
        createdAt: new Date(),
        lastStatus: 'completed',
      });
      store.getTaskForMutation(existing.id)!.ralphLoop = {
        prompt: 'iterate',
        iterationCap: 5,
        currentIteration: 1,
        status: loopStatus,
        lastIterationStartedAt: 0,
        cumulativeIterations: 1,
      };
      const terminalBackend = {
        isAlive: vi.fn().mockResolvedValue(false),
      };

      const result = await launchTask({ ...deps, terminalBackend }, { prompt: 'hello', cwd: '/tmp' });

      expect(result.duplicate).toBe(true);
      expect(result.task.id).toBe(existing.id);
      expect(terminalBackend.isAlive).not.toHaveBeenCalled();
      expect(store.getTask(existing.id)!.status).toBe('inProgress');
      expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    },
  );

  it('allows re-launch after completing the original task', async () => {
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    // Transition: open -> inProgress -> completed
    store.startTask(first.task.id);
    store.completeTask(first.task.id);

    const second = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(second.duplicate).toBeUndefined();
    expect(second.task.id).not.toBe(first.task.id);
  });

  it('allows re-launch after cancelling the original task', async () => {
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    // Transition: open -> inProgress -> cancelled
    store.startTask(first.task.id);
    store.cancelTask(first.task.id);

    const second = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(second.duplicate).toBeUndefined();
    expect(second.task.id).not.toBe(first.task.id);
  });

  it('does not call adapter.launch on duplicate', async () => {
    await launchTask(deps, { prompt: 'do it', cwd: '/tmp' });
    await launchTask(deps, { prompt: 'do it', cwd: '/tmp' });
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('queued:false on duplicate (existing task, not queued)', async () => {
    const result = await launchTask(deps, { prompt: 'test', cwd: '/tmp' });
    const dup = await launchTask(deps, { prompt: 'test', cwd: '/tmp' });
    expect(dup.queued).toBe(false);
    expect(dup.duplicate).toBe(true);
  });

  it('persists playbookParameterValues on the created task', async () => {
    const result = await launchTask(deps, {
      prompt: 'Analyze owner/repo',
      cwd: '/tmp',
      playbookId: 'analyze.md',
      playbookParameterValues: { repo: 'owner/repo', count: '10' },
    });
    expect(result.task.playbookParameterValues).toEqual({ repo: 'owner/repo', count: '10' });
  });

  it('stamps ask-first delivery authorization by default', async () => {
    const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });

    expect(result.task.deliveryAuthorization).toBe('ask-first');
    expect(store.getTask(result.task.id)?.deliveryAuthorization).toBe('ask-first');
  });

  it('stamps pre-authorized delivery authorization from server-only launch options', async () => {
    const result = await launchTask(
      deps,
      { prompt: 'hello pre-authorized', cwd: '/tmp' },
      { deliveryPolicy: 'pre-authorized' },
    );

    expect(result.task.deliveryAuthorization).toBe('pre-authorized');
    expect(store.getTask(result.task.id)?.deliveryAuthorization).toBe('pre-authorized');
  });

  it('records launch permission posture when bypass-all-permissions mode is active', async () => {
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await launchTask({
      ...deps,
      interactionLog,
      bypassAllPermissions: true,
    }, { prompt: 'hello unguarded', cwd: '/tmp' });

    expect(result.task.metadata?.launchPermissionPosture).toMatchObject({
      bypassAllPermissions: true,
      mode: 'bypass-all',
    });
    expect(store.getTask(result.task.id)?.metadata?.launchPermissionPosture).toMatchObject({
      bypassAllPermissions: true,
      mode: 'bypass-all',
    });
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_launch_permission_posture',
      taskId: result.task.id,
      agentType: 'claude-code',
      bypassAllPermissions: true,
      mode: 'bypass-all',
    }));
  });

  it('does not stamp launch permission posture until a bypass-mode task actually launches', async () => {
    const result = await launchTask({
      ...deps,
      getMaxActiveTasks: () => 0,
      bypassAllPermissions: true,
    }, { prompt: 'queued unguarded later', cwd: '/tmp' });

    expect(result.queued).toBe(true);
    expect(result.task.metadata?.launchPermissionPosture).toBeUndefined();
    expect(store.getTask(result.task.id)?.metadata?.launchPermissionPosture).toBeUndefined();
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('does not record launch permission posture by default', async () => {
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await launchTask({ ...deps, interactionLog, bypassAllPermissions: false }, {
      prompt: 'hello guarded',
      cwd: '/tmp',
    });

    expect(result.task.metadata?.launchPermissionPosture).toBeUndefined();
    expect(interactionLog.append).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_launch_permission_posture',
    }));
  });

  it('does not set playbookParameterValues when not provided', async () => {
    const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
    expect(result.task.playbookParameterValues).toBeUndefined();
  });

  it('launches with the requested adapter type', async () => {
    const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'codex-cli' });
    expect(result.task.agentType).toBe('codex-cli');
    expect(deps.adapterRegistry.get('codex-cli').launch).toHaveBeenCalledOnce();
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('uses the configured default agent type when none is requested', async () => {
    const depsWithDefault = {
      ...deps,
      getDefaultAgentType: vi.fn(() => 'codex-cli' as const),
    };

    const result = await launchTask(depsWithDefault, { prompt: 'hello', cwd: '/tmp' });

    expect(result.task.agentType).toBe('codex-cli');
    expect(depsWithDefault.getDefaultAgentType).toHaveBeenCalledOnce();
    expect(deps.adapterRegistry.get('codex-cli').launch).toHaveBeenCalledOnce();
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('lets an explicit launch agent override the configured default', async () => {
    const depsWithDefault = {
      ...deps,
      getDefaultAgentType: vi.fn(() => 'codex-cli' as const),
    };

    const result = await launchTask(depsWithDefault, {
      prompt: 'hello',
      cwd: '/tmp',
      agentType: 'claude-code',
    });

    expect(result.task.agentType).toBe('claude-code');
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
    expect(deps.adapterRegistry.get('codex-cli').launch).not.toHaveBeenCalled();
  });

  it('cleans up task record when adapter.launch throws, allowing retry', async () => {
    const adapter = deps.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('tmux unsafe permissions'));

    // First launch fails
    await expect(launchTask(deps, { prompt: 'do work', cwd: '/tmp' }))
      .rejects.toThrow('tmux unsafe permissions');

    // Task record should have been deleted
    expect(store.listTasks()).toHaveLength(0);

    // Retry succeeds — not blocked by dedup
    (adapter.launch as ReturnType<typeof vi.fn>).mockResolvedValueOnce('tmux-session');
    const result = await launchTask(deps, { prompt: 'do work', cwd: '/tmp' });
    expect(result.duplicate).toBeUndefined();
    expect(result.task.prompt).toBe('do work');
  });

  it('does not deduplicate across agent types', async () => {
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'claude-code' });
    const second = await launchTask(deps, { prompt: 'hello', cwd: '/tmp', agentType: 'codex-cli' });
    expect(first.task.id).not.toBe(second.task.id);
    expect(second.duplicate).toBeUndefined();
  });

  it('does not deduplicate when cwd differs — same prompt in two repos creates two tasks', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'launch-repo-a-'));
    const dirB = await mkdtemp(join(tmpdir(), 'launch-repo-b-'));
    try {
      const first = await launchTask(deps, { prompt: 'review the diff', cwd: dirA });
      const second = await launchTask(deps, { prompt: 'review the diff', cwd: dirB });
      expect(first.task.id).not.toBe(second.task.id);
      expect(second.duplicate).toBeUndefined();
      expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it('deduplicates when cwd is reached via a symlink to the same directory', async () => {
    const target = await mkdtemp(join(tmpdir(), 'launch-symlink-target-'));
    const link = join(tmpdir(), `launch-symlink-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      await symlink(target, link);
      const first = await launchTask(deps, { prompt: 'do it', cwd: target });
      const second = await launchTask(deps, { prompt: 'do it', cwd: link });
      expect(first.task.id).toBe(second.task.id);
      expect(second.duplicate).toBe(true);
    } finally {
      await rm(link, { force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

  it('records canonicalCwd in the submission_rejected_dedup interaction event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-log-event-'));
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) } as any;
    const depsWithLog = { ...deps, interactionLog };
    try {
      await launchTask(depsWithLog, { prompt: 'do it', cwd: dir });
      await launchTask(depsWithLog, { prompt: 'do it', cwd: dir });
      const dedupCalls = interactionLog.append.mock.calls
        .map((call: [unknown]) => call[0] as { type?: string; canonicalCwd?: string })
        .filter((e) => e.type === 'submission_rejected_dedup');
      expect(dedupCalls).toHaveLength(1);
      expect(dedupCalls[0].canonicalCwd).toBe(realpathSync(dir));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stamps launchSource into the server log on successful launch', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp', launchSource: 'cli' });
      const launchLogs = logSpy.mock.calls
        .map(([line]) => line)
        .filter((line): line is string => typeof line === 'string' && line.startsWith('[launch] '));
      expect(launchLogs).toEqual([
        `[launch] source=cli agent=claude-code taskId=${result.task.id} cwd=/tmp`,
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('defaults launchSource to api when not provided', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
      const launchLogs = logSpy.mock.calls
        .map(([line]) => line)
        .filter((line): line is string => typeof line === 'string' && line.startsWith('[launch] '));
      expect(launchLogs).toEqual([
        `[launch] source=api agent=claude-code taskId=${result.task.id} cwd=/tmp`,
      ]);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('normalizes relative file references before storing and launching the task', async () => {
    await mkdir(join(repoDir, 'docs', 'rfc'), { recursive: true });
    const filePath = join(repoDir, 'docs', 'rfc', 'design.md');
    await writeFile(filePath, '# RFC');

    const result = await launchTask(deps, {
      prompt: 'Read docs/rfc/design.md before coding.',
      cwd: repoDir,
    });

    expect(result.task.prompt).toBe(`Read ${filePath} before coding.`);
    // PR4: launchTask now always passes 5 args (taskId, prompt, cwd, resume,
    // adapterOpts). For non-ralph launches `resume` and `adapterOpts` are
    // both undefined.
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledWith(
      result.task.id,
      `Read ${filePath} before coding.`,
      repoDir,
      undefined,
      undefined,
    );
  });

  it('deduplicates equivalent relative and absolute file references', async () => {
    await mkdir(join(repoDir, 'docs', 'rfc'), { recursive: true });
    const filePath = join(repoDir, 'docs', 'rfc', 'design.md');
    await writeFile(filePath, '# RFC');

    const first = await launchTask(deps, {
      prompt: 'Read docs/rfc/design.md before coding.',
      cwd: repoDir,
    });
    const second = await launchTask(deps, {
      prompt: `Read ${filePath} before coding.`,
      cwd: repoDir,
    });

    expect(first.task.id).toBe(second.task.id);
    expect(second.duplicate).toBe(true);
  });

  it('prefixes "create a fresh worktree" guidance when launching from a main checkout', async () => {
    await initGitRepo(repoDir);

    const result = await launchTask(deps, {
      prompt: 'Implement the bug fix and update tests.',
      cwd: repoDir,
    });

    expect(result.task.userPrompt).toBe('Implement the bug fix and update tests.');
    expect(result.task.prompt).toContain('You are currently in the main checkout');
    expect(result.task.prompt).toContain(realpathSync(repoDir));
    expect(result.task.prompt).toContain('Do NOT commit to main or in this checkout');
    expect(result.task.prompt).toContain('every Kookr task must make tracked-file changes in a fresh git worktree of its own');
    expect(result.task.prompt).toContain(`git worktree add ../${repoDir.split('/').pop()}-<short-name> -b <feature-branch> 'HEAD'`);
    expect(result.task.prompt).toContain('ask the user whether to push the branch and open a PR');
    expect(result.task.prompt).toContain('Implement the bug fix and update tests.');
  });

  it('prefixes pre-authorized delivery guidance when requested by server launch context', async () => {
    await initGitRepo(repoDir);

    const result = await launchTask(
      deps,
      {
        prompt: 'Implement the bug fix and update tests.',
        cwd: repoDir,
      },
      { deliveryPolicy: 'pre-authorized' },
    );

    expect(result.task.prompt).toContain('Delivery is pre-authorized for this task');
    expect(result.task.prompt).toContain('finish the full delivery cycle without asking again');
    expect(result.task.prompt).toContain('commit, push the branch, open or update the PR, and report the PR URL');
    expect(result.task.prompt).toContain('If you show a diff or plan and the user approves it, treat that as approval to continue through the full delivery cycle.');
    expect(result.task.prompt).toContain("If the work does not actually satisfy the task, do NOT open a PR; stop and report what's wrong instead.");
    expect(result.task.prompt).not.toContain('ask the user whether to push the branch and open a PR');
    expect(result.task.deliveryAuthorization).toBe('pre-authorized');
  });

  it('does not duplicate worktree guidance when the prompt already includes it', async () => {
    await initGitRepo(repoDir);

    const prompt = [
      'Before starting any work, create a git worktree on a feature branch and work inside it.',
      'git worktree add ../repo-feature -b feature/test HEAD',
      'Fix the bug.',
    ].join('\n');

    const result = await launchTask(deps, {
      prompt,
      cwd: repoDir,
    });

    expect(result.task.prompt).toBe(prompt);
    expect(result.task.userPrompt).toBe(prompt);
  });

  it('prefixes "create a fresh worktree" guidance when launching from an existing worktree', async () => {
    await initGitRepo(repoDir);
    const worktreeDir = `${repoDir}-feature`;
    git(repoDir, 'worktree', 'add', '-b', 'feature/test', worktreeDir, 'HEAD');

    const result = await launchTask(deps, {
      prompt: 'Implement the bug fix and update tests.',
      cwd: worktreeDir,
    });

    // git rev-parse --show-toplevel returns the realpath, which on macOS
    // differs from the raw mkdtemp path (/var/... vs /private/var/...).
    expect(result.task.prompt).toContain('You are currently in the git worktree');
    expect(result.task.prompt).toContain(realpathSync(worktreeDir));
    expect(result.task.prompt).toContain('feature/test');
    expect(result.task.prompt).toContain(realpathSync(repoDir));
    expect(result.task.prompt).toContain('Do NOT commit to main, in this worktree, or in the main checkout');
    expect(result.task.prompt).toContain('every Kookr task must make tracked-file changes in a fresh git worktree of its own');
    expect(result.task.prompt).toContain(`git worktree add ../${repoDir.split('/').pop()}-<short-name> -b <feature-branch> 'HEAD'`);
    expect(result.task.prompt).toContain('ask the user whether to push the branch and open a PR');
    expect(result.task.prompt).toContain('Implement the bug fix and update tests.');
  });

  it('labels detached HEAD instead of a branch name in the guidance', async () => {
    await initGitRepo(repoDir);
    const worktreeDir = `${repoDir}-detached`;
    // Create a worktree at a specific commit (detached HEAD).
    const cleanEnv = { ...process.env };
    delete cleanEnv.GIT_DIR;
    delete cleanEnv.GIT_WORK_TREE;
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, env: cleanEnv })
      .toString()
      .trim();
    git(repoDir, 'worktree', 'add', '--detach', worktreeDir, sha);

    const result = await launchTask(deps, {
      prompt: 'Read-only audit.',
      cwd: worktreeDir,
    });

    expect(result.task.prompt).toContain('You are currently in the git worktree');
    expect(result.task.prompt).toContain('(detached HEAD)');
    // Make sure we did NOT emit a misleading `on branch \`HEAD\`` phrase.
    expect(result.task.prompt).not.toContain('on branch `HEAD`');
    expect(result.task.prompt).toContain('Read-only audit.');
  });

  it('does not duplicate the guidance when the prompt already says "do not commit in this worktree"', async () => {
    await initGitRepo(repoDir);
    const worktreeDir = `${repoDir}-feature2`;
    git(repoDir, 'worktree', 'add', '-b', 'feature/test2', worktreeDir, 'HEAD');

    const prompt = 'Do not commit in this worktree. Just inspect the file.';
    const result = await launchTask(deps, {
      prompt,
      cwd: worktreeDir,
    });

    expect(result.task.prompt).toBe(prompt);
  });

  describe('ralphVerdictEnv (PR4 — first-iteration fix)', () => {
    it('injects verdict file and iteration env into adapter env when ralphVerdictEnv is true', async () => {
      const result = await launchTask(deps, {
        prompt: 'iterate',
        cwd: '/tmp',
        ralphVerdictEnv: true,
      });
      const adapter = deps.adapterRegistry.get('claude-code');
      // Path is absolute and uses the per-task suffix (taskId.slice(0, 12)).
      const expectedSuffix = result.task.id.slice(0, 12);
      expect(adapter.launch).toHaveBeenCalledWith(
        result.task.id,
        'iterate',
        '/tmp',
        undefined,
        {
          extraEnv: {
            RALPH_VERDICT_FILE: expect.stringMatching(new RegExp(`/\\.ralph-verdict-${expectedSuffix}\\.json$`)),
            RALPH_ITERATION: '0',
          },
        },
      );
    });

    it('omits adapter opts entirely when ralphVerdictEnv is unset (no regression for non-ralph launches)', async () => {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
      const adapter = deps.adapterRegistry.get('claude-code');
      const launchCall = (adapter.launch as ReturnType<typeof vi.fn>).mock.calls[0];
      // The adapter is called as launch(id, prompt, cwd, undefined, undefined)
      // so the 5th arg is undefined — preserves the legacy 3-arg call shape
      // semantically (no env override).
      expect(launchCall![4]).toBeUndefined();
    });

    it('omits adapter opts when ralphVerdictEnv is explicit false', async () => {
      await launchTask(deps, { prompt: 'hello-explicit-false', cwd: '/tmp', ralphVerdictEnv: false });
      const adapter = deps.adapterRegistry.get('claude-code');
      const launchCall = (adapter.launch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(launchCall![4]).toBeUndefined();
    });
  });
});

describe('R19 trust boundary (rfc-remote-chat-trigger §4)', () => {
  let store: TaskStore;
  let deps: LaunchServiceDeps;
  const originalAllowCodex = process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX;

  beforeEach(() => {
    store = new TaskStore();
    deps = makeDeps(store);
    delete process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX;
  });

  afterEach(() => {
    if (originalAllowCodex === undefined) delete process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX;
    else process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX = originalAllowCodex;
  });

  it('throws when launchSource=remote-chat-telegram and agentType=codex-cli', async () => {
    await expect(
      launchTask(deps, {
        prompt: 'p',
        cwd: '/tmp',
        launchSource: 'remote-chat-telegram',
        agentType: 'codex-cli',
      }),
    ).rejects.toThrow(/R19/);
  });

  it('R19 throws BEFORE any side effects (no task created, no adapter call)', async () => {
    const claudeLaunch = (deps.adapterRegistry.get('claude-code') as any).launch as ReturnType<typeof vi.fn>;
    const codexLaunch = (deps.adapterRegistry.get('codex-cli') as any).launch as ReturnType<typeof vi.fn>;
    claudeLaunch.mockClear();
    codexLaunch.mockClear();
    await expect(
      launchTask(deps, {
        prompt: 'p',
        cwd: '/tmp',
        launchSource: 'remote-chat-telegram',
        agentType: 'codex-cli',
      }),
    ).rejects.toThrow(/R19/);
    expect(store.listTasks()).toHaveLength(0);
    expect(claudeLaunch).not.toHaveBeenCalled();
    expect(codexLaunch).not.toHaveBeenCalled();
  });

  it('applies R19 to a codex configured default when remote chat omits agentType', async () => {
    await expect(
      launchTask({
        ...deps,
        getDefaultAgentType: () => 'codex-cli',
      }, {
        prompt: 'p',
        cwd: '/tmp',
        launchSource: 'remote-chat-telegram',
      }),
    ).rejects.toThrow(/R19/);
    expect(store.listTasks()).toHaveLength(0);
    expect(deps.adapterRegistry.get('codex-cli').launch).not.toHaveBeenCalled();
  });

  it('allows launchSource=remote-chat-telegram with agentType=claude-code', async () => {
    const result = await launchTask(deps, {
      prompt: 'p',
      cwd: '/tmp',
      launchSource: 'remote-chat-telegram',
      agentType: 'claude-code',
    });
    expect(result.task.agentType).toBe('claude-code');
  });

  it('does not enforce R19 for other launch sources', async () => {
    const result = await launchTask(deps, {
      prompt: 'p',
      cwd: '/tmp',
      launchSource: 'api',
      agentType: 'codex-cli',
    });
    expect(result.task.agentType).toBe('codex-cli');
  });

  it('allows remote-chat-telegram codex only when KOOKR_REMOTE_CHAT_ALLOW_CODEX=1', async () => {
    process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX = '1';
    const result = await launchTask(deps, {
      prompt: 'p',
      cwd: '/tmp',
      launchSource: 'remote-chat-telegram',
      agentType: 'codex-cli',
    });
    expect(result.task.agentType).toBe('codex-cli');
    expect(deps.adapterRegistry.get('codex-cli').launch).toHaveBeenCalledOnce();
  });
});

describe('launchTask round-robin', () => {
  let store: TaskStore;
  let deps: LaunchServiceDeps;
  let cursor: number;

  beforeEach(() => {
    store = new TaskStore();
    cursor = 0;
    // Mirrors index.ts: peek reads the index, advance moves it forward.
    deps = {
      ...makeDeps(store),
      roundRobinCursor: { peek: () => cursor, advance: () => { cursor += 1; } },
    };
  });

  it('alternates agents across launches when the default is round-robin', async () => {
    const roundRobinDeps = { ...deps, getDefaultAgentType: () => 'round-robin' as const };
    const first = await launchTask(roundRobinDeps, { prompt: 'task one', cwd: '/tmp' });
    const second = await launchTask(roundRobinDeps, { prompt: 'task two', cwd: '/tmp' });
    const third = await launchTask(roundRobinDeps, { prompt: 'task three', cwd: '/tmp' });
    expect(first.task.agentType).toBe('claude-code');
    expect(second.task.agentType).toBe('codex-cli');
    expect(third.task.agentType).toBe('claude-code');
    // One advance per committed task, and the choice reaches the adapter.
    expect(cursor).toBe(3);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledTimes(2);
    expect(deps.adapterRegistry.get('codex-cli').launch).toHaveBeenCalledTimes(1);
  });

  it('resolves an explicit round-robin launch request to a concrete agent', async () => {
    const result = await launchTask(deps, {
      prompt: 'explicit round robin',
      cwd: '/tmp',
      agentType: 'round-robin',
    });
    // The created task always records a concrete agent — never the sentinel.
    expect(result.task.agentType).toBe('claude-code');
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
    expect(cursor).toBe(1);
  });

  it('lets an explicit concrete request override a round-robin default', async () => {
    const roundRobinDeps = { ...deps, getDefaultAgentType: () => 'round-robin' as const };
    const result = await launchTask(roundRobinDeps, {
      prompt: 'pinned to codex',
      cwd: '/tmp',
      agentType: 'codex-cli',
    });
    expect(result.task.agentType).toBe('codex-cli');
    // A concrete request must not consume a rotation slot.
    expect(cursor).toBe(0);
  });

  it('does not advance the cursor when a round-robin launch deduplicates', async () => {
    // An active task already exists for this prompt on the agent the cursor
    // would pick (claude-code at index 0).
    const existing = store.createTask({ prompt: 'dup prompt', cwd: '/tmp' });
    store.startTask(existing.id);

    const result = await launchTask(deps, {
      prompt: 'dup prompt',
      cwd: '/tmp',
      agentType: 'round-robin',
    });

    expect(result.duplicate).toBe(true);
    expect(result.task.id).toBe(existing.id);
    // Deduplicated launch created no task, so the rotation must not move.
    expect(cursor).toBe(0);
  });

  it('does not advance the cursor when a round-robin launch fails to start', async () => {
    deps.adapterRegistry.get('claude-code').launch = vi
      .fn()
      .mockRejectedValue(new Error('adapter boom'));

    await expect(
      launchTask(deps, { prompt: 'failing launch', cwd: '/tmp', agentType: 'round-robin' }),
    ).rejects.toThrow('adapter boom');

    // A failed launch deletes the task record; the rotation must not move.
    expect(cursor).toBe(0);
  });

  it('collapses round-robin to the only registered agent', async () => {
    // Only codex-cli is registered — e.g. the Claude binary is absent. The
    // rotation must degrade to the single available agent, not route to a
    // missing one.
    const soloStore = new TaskStore();
    const registry = new AdapterRegistry();
    registry.register({
      agentType: 'codex-cli',
      launch: vi.fn().mockResolvedValue('tmux-codex'),
      sendInput: vi.fn(),
      sendKeystroke: vi.fn(),
      stop: vi.fn(),
      captureDisplay: vi.fn(),
      onEvent: vi.fn(),
      onRefreshNeeded: vi.fn(),
      injectHookEvent: vi.fn(),
    } as any);
    const soloDeps: LaunchServiceDeps = {
      ...makeDeps(soloStore),
      adapterRegistry: registry,
      roundRobinCursor: { peek: () => 0, advance: () => {} },
      getDefaultAgentType: () => 'round-robin',
    };

    const result = await launchTask(soloDeps, { prompt: 'solo', cwd: '/tmp' });
    expect(result.task.agentType).toBe('codex-cli');
    expect(registry.get('codex-cli').launch).toHaveBeenCalledOnce();
  });
});

describe('launchTask cwd validation (RFC F12)', () => {
  let store: TaskStore;
  let deps: LaunchServiceDeps;

  beforeEach(() => {
    store = new TaskStore();
    deps = makeDeps(store);
  });

  it('rejects a nonexistent working directory before creating any task record', async () => {
    const missing = '/nonexistent/kookr-test-cwd';
    await expect(launchTask(deps, { prompt: 'go', cwd: missing }))
      .rejects.toThrow(`Working directory does not exist: ${missing}`);

    // Fails fast: no task record, no spawn attempt, nothing to clean up.
    expect(store.listTasks()).toHaveLength(0);
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('throws a CwdValidationError with code invalid_cwd (for the 400 mapping)', async () => {
    let caught: unknown;
    try {
      await launchTask(deps, { prompt: 'go', cwd: '/nonexistent/kookr-test-cwd' });
    } catch (err) {
      caught = err;
    }
    expect(isCwdValidationError(caught)).toBe(true);
    expect(caught).toBeInstanceOf(CwdValidationError);
    expect((caught as CwdValidationError).code).toBe('invalid_cwd');
    // The message must LEAD with the actual cause — the WS alert summary
    // embeds it verbatim, and the old "dtach socket did not appear" flow
    // buried the cwd hint as the third recovery bullet.
    expect((caught as CwdValidationError).message).toMatch(/^Working directory does not exist:/);
  });

  it('rejects a cwd that exists but is a file, not a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-cwd-test-'));
    try {
      const file = join(dir, 'not-a-dir');
      await writeFile(file, 'x');
      await expect(launchTask(deps, { prompt: 'go', cwd: file }))
        .rejects.toThrow(`Working directory is not a directory: ${file}`);
      expect(store.listTasks()).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts an existing directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-cwd-test-'));
    try {
      const result = await launchTask(deps, { prompt: 'go', cwd: dir });
      expect(result.task.cwd).toBe(dir);
      expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The validateLaunchCwd seam exists for the E2E test server, whose specs
  // launch into the fictional /test/project. These two tests pin the dispatch
  // contract: the override fully replaces the default existence check (it
  // does not run in addition), and a rejecting override still fails fast
  // before any task record or spawn.
  it('validateLaunchCwd override replaces the default existence check', async () => {
    const missing = '/nonexistent/kookr-test-cwd';
    const validateLaunchCwd = vi.fn().mockResolvedValue(undefined);
    const result = await launchTask({ ...deps, validateLaunchCwd }, { prompt: 'go', cwd: missing });
    expect(result.task.cwd).toBe(missing);
    expect(validateLaunchCwd).toHaveBeenCalledExactlyOnceWith(missing);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('a rejecting validateLaunchCwd override still fails fast before task creation', async () => {
    const validateLaunchCwd = vi.fn().mockRejectedValue(new CwdValidationError('Working directory does not exist: /custom'));
    await expect(launchTask({ ...deps, validateLaunchCwd }, { prompt: 'go', cwd: '/custom' }))
      .rejects.toThrow('Working directory does not exist: /custom');
    expect(store.listTasks()).toHaveLength(0);
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #700: launch reservation at the fresh-launch site
// ---------------------------------------------------------------------------

describe('launchTask launch reservation (#700)', () => {
  it('an in-flight fresh launch occupies a concurrency slot', async () => {
    const taskStore = new TaskStore();
    const deps = makeDeps(taskStore);
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const adapter = deps.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await gate; // park mid-launch, like a real adapter spawning a session
      return 'tmux-claude';
    });

    const pendingLaunch = launchTask(deps, { prompt: 'hold the slot', cwd: '/tmp' });
    // launchTask does async pre-work (dedupe canonicalization, git probes)
    // before reserving — poll until the mid-await reservation shows in the
    // cap accounting (the audit's second over-launch bug: inProgress-only
    // counting would keep this 0 for the whole launch).
    await vi.waitFor(() => {
      expect(taskStore.getActiveCount()).toBe(1);
    });

    openGate();
    await pendingLaunch;
  });

  it('a failed fresh launch releases its reservation with the task', async () => {
    const taskStore = new TaskStore();
    const deps = makeDeps(taskStore);
    const adapter = deps.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    await expect(launchTask(deps, { prompt: 'will fail', cwd: '/tmp' })).rejects.toThrow('boom');
    expect(taskStore.getActiveCount()).toBe(0); // no leaked slot
    expect(taskStore.getNextPending()).toBeUndefined();
  });
});

describe('launchTask idempotency (issue #1526 Phase B)', () => {
  let store: TaskStore;
  let ledgerDir: string;
  let ledger: IdempotencyLedger;
  let deps: LaunchServiceDeps;

  beforeEach(async () => {
    store = new TaskStore();
    ledgerDir = await mkdtemp(join(tmpdir(), 'idempotency-launch-'));
    ledger = new IdempotencyLedger(ledgerDir);
    await ledger.load();
    deps = { ...makeDeps(store), idempotencyLedger: ledger };
  });

  afterEach(async () => {
    await rm(ledgerDir, { recursive: true, force: true });
  });

  it('same key twice sequentially: one task, second response is a replay', async () => {
    const first = await launchTask(deps, { prompt: 'hello', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(first.idempotentReplay).toBeUndefined();

    const second = await launchTask(deps, { prompt: 'hello', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(second.idempotentReplay).toBe(true);
    expect(second.task.id).toBe(first.task.id);

    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
    expect(store.listTasks()).toHaveLength(1);
  });

  it('two concurrent identical POSTs create exactly one task; both responses reference it', async () => {
    const [a, b] = await Promise.all([
      launchTask(deps, { prompt: 'concurrent', cwd: '/tmp', idempotencyKey: 'k1' }),
      launchTask(deps, { prompt: 'concurrent', cwd: '/tmp', idempotencyKey: 'k1' }),
    ]);

    expect(a.task.id).toBe(b.task.id);
    // Exactly one of the two calls actually created the task; the other replayed it.
    expect([a.idempotentReplay, b.idempotentReplay].filter((v) => v === true)).toHaveLength(1);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
    expect(store.listTasks()).toHaveLength(1);
  });

  it('different keys create two distinct tasks', async () => {
    const first = await launchTask(deps, { prompt: 'first task', cwd: '/tmp', idempotencyKey: 'k1' });
    const second = await launchTask(deps, { prompt: 'second task', cwd: '/tmp', idempotencyKey: 'k2' });

    expect(second.task.id).not.toBe(first.task.id);
    expect(second.idempotentReplay).toBeUndefined();
    expect(store.listTasks()).toHaveLength(2);
  });

  it('no key: unchanged behavior — two identical no-key posts still hit prompt dedup', async () => {
    const first = await launchTask(deps, { prompt: 'no key here', cwd: '/tmp' });
    const second = await launchTask(deps, { prompt: 'no key here', cwd: '/tmp' });

    expect(second.duplicate).toBe(true);
    expect(second.idempotentReplay).toBeUndefined();
    expect(second.task.id).toBe(first.task.id);
    expect(ledger.size()).toBe(0); // ledger never touched when no key is supplied
  });

  it('reservation released on creation failure — retry with the same key succeeds', async () => {
    const adapter = deps.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    await expect(
      launchTask(deps, { prompt: 'will fail then retry', cwd: '/tmp', idempotencyKey: 'k1' }),
    ).rejects.toThrow('boom');
    expect(store.listTasks()).toHaveLength(0); // failed launch cleaned up its task record

    const retry = await launchTask(deps, { prompt: 'will fail then retry', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(retry.idempotentReplay).toBeUndefined();
    expect(store.listTasks()).toHaveLength(1);
    expect(adapter.launch).toHaveBeenCalledTimes(2);
  });

  it('TTL expiry: an entry older than 24h is compacted and the key becomes reusable', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const ttlLedger = new IdempotencyLedger(ledgerDir, { ttlMs: 1000, now: () => nowMs });
    await ttlLedger.load();
    const ttlDeps: LaunchServiceDeps = { ...makeDeps(store), idempotencyLedger: ttlLedger };

    const first = await launchTask(ttlDeps, { prompt: 'ttl one', cwd: '/tmp', idempotencyKey: 'k1' });

    nowMs += 1001; // advance past the TTL
    const second = await launchTask(ttlDeps, { prompt: 'ttl two', cwd: '/tmp', idempotencyKey: 'k1' });

    expect(second.idempotentReplay).toBeUndefined();
    expect(second.task.id).not.toBe(first.task.id);
    expect(store.listTasks()).toHaveLength(2);
  });

  it('restart: ledger reloaded from disk still detects a replay', async () => {
    const first = await launchTask(deps, { prompt: 'survives restart', cwd: '/tmp', idempotencyKey: 'k1' });

    // Simulate a server restart: fresh ledger instance pointed at the same dir.
    const reloadedLedger = new IdempotencyLedger(ledgerDir);
    await reloadedLedger.load();
    const reloadedDeps: LaunchServiceDeps = { ...makeDeps(store), idempotencyLedger: reloadedLedger };

    const second = await launchTask(reloadedDeps, { prompt: 'survives restart', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(second.idempotentReplay).toBe(true);
    expect(second.task.id).toBe(first.task.id);
  });
});
