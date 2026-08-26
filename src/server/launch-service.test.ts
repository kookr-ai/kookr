import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../core/tasks.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import { checkSubmission, launchTask, launchPhaseTimingsOf, CwdValidationError, isCwdValidationError, DrainModeError, AutomationKillSwitchError, EffortValidationError, ModelValidationError, LaunchTimeoutError, isLaunchTimeoutError, isPendingQueueFullError, isSpawnBurstLimitError, isHostLoadAdmissionError, isQuotaHeadroomAdmissionError, IssueClaimHeldError, isIssueClaimHeldError, RelaunchDeniedError, isRelaunchDeniedError, IssueClaimLeaseRequiredError, isIssueClaimLeaseRequiredError, type PendingQueueFullError, type SpawnBurstLimitError, type HostLoadAdmissionError, type QuotaHeadroomAdmissionError, type LaunchServiceDeps } from './launch-service.js';
import { IssueClaimRegistry } from '../core/issue-claim-registry.js';
import type { ClaimEvent, ClaimTaskPort, ClaimTaskView } from '../core/issue-claim-types.js';
import { isTerminalStatus } from '../core/task-status.js';
import { RelaunchArbiter } from './relaunch-arbiter.js';
import { SpawnRateLimiter } from '../core/spawn-rate-limiter.js';
import { buildCapacityLedger } from '../core/capacity-ledger.js';
import type { LaunchPreflightFinding } from '../core/launch-dependency-preflight.js';
import { IdempotencyLedger } from '../core/idempotency-ledger.js';
import { AgentBootLatencyMonitor } from '../core/agent-boot-latency.js';
import type { LaunchPhaseTimings } from '../core/launch-phase-timings.js';
import { LaunchDependencyAdmission } from '../core/launch-dependency-admission.js';

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
    flushTasks: vi.fn().mockResolvedValue(undefined),
    lifecycleDeps: {
      monitor: { registerAgent: vi.fn() } as any,
      watchdog: { registerAgent: vi.fn() } as any,
      hookWatcher: { isWatching: vi.fn().mockReturnValue(false), watch: vi.fn() } as any,
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

  it('does not deduplicate a legacy task whose launch intent is missing', () => {
    const task = store.createTask({ prompt: 'legacy work', cwd: '/tmp' });
    const mutable = store.getTaskForMutation(task.id)!;
    delete mutable.launchIntent;
    store.startTask(task.id);

    expect(checkSubmission(store, 'legacy work', 'claude-code', '/tmp')).toBeUndefined();
  });

  it('deduplicates only when independent model and effort pins both match', () => {
    const task = store.createTask({
      prompt: 'pinned work',
      cwd: '/tmp',
      agentType: 'claude-code',
      launchIntent: {
        schemaVersion: 'task-launch-intent.v1',
        agentType: 'claude-code',
        model: 'model-a',
        effort: 'effort-a',
      },
    });
    store.startTask(task.id);

    expect(checkSubmission(store, 'pinned work', 'claude-code', '/tmp', {
      model: 'model-a',
      effort: 'effort-a',
    })?.id).toBe(task.id);
    expect(checkSubmission(store, 'pinned work', 'claude-code', '/tmp', {
      model: 'model-a',
      effort: 'effort-b',
    })).toBeUndefined();
    expect(checkSubmission(store, 'pinned work', 'claude-code', '/tmp', {
      model: 'model-b',
      effort: 'effort-a',
    })).toBeUndefined();
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

  it('walks viewLiveTasks instead of cloning the full store', () => {
    const live = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.startTask(live.id);
    const samePromptDone = store.createTask({ prompt: 'do something', cwd: '/tmp' });
    store.startTask(samePromptDone.id);
    store.completeTask(samePromptDone.id);
    for (let i = 0; i < 24; i++) {
      const done = store.createTask({ prompt: `completed ${i}`, cwd: '/tmp' });
      store.startTask(done.id);
      store.completeTask(done.id);
    }

    const listSpy = vi.spyOn(store, 'listTasks');
    const liveSpy = vi.spyOn(store, 'viewLiveTasks');
    try {
      const found = checkSubmission(store, 'do something', 'claude-code', '/tmp');
      expect(found?.id).toBe(live.id);
      expect(listSpy).not.toHaveBeenCalled();
      expect(liveSpy).toHaveBeenCalled();
      const walked = liveSpy.mock.results[0]?.value as { id: string }[] | undefined;
      expect(walked?.map((task) => task.id)).toEqual([live.id]);
    } finally {
      listSpy.mockRestore();
      liveSpy.mockRestore();
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

  it('persists the exact independent model and effort pins on the task', async () => {
    const result = await launchTask(deps, {
      prompt: 'preserve pins',
      cwd: '/tmp',
      model: 'claude-fable-5',
      effort: 'max',
    });

    expect(result.task.launchIntent).toEqual({
      schemaVersion: 'task-launch-intent.v1',
      agentType: 'claude-code',
      prompt: 'preserve pins',
      cwd: '/tmp',
      model: 'claude-fable-5',
      effort: 'max',
    });
  });

  describe('per-task effort override (#681)', () => {
    /** The AdapterLaunchOptions (5th) arg of the first adapter.launch call. */
    function launchOptsFor(deps: LaunchServiceDeps, agent: 'claude-code' | 'codex-cli') {
      const launch = vi.mocked(deps.adapterRegistry.get(agent).launch);
      return launch.mock.calls[0]?.[4];
    }

    it('with no effort, passes no effort override', async () => {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
      // adapterOpts always carries the phase-instrumentation callback (issue
      // #1589), but no effort/model/extraEnv when none were requested.
      const opts = launchOptsFor(deps, 'claude-code');
      expect(opts).toBeDefined();
      expect(typeof opts.onPhase).toBe('function');
      expect(opts.effort).toBeUndefined();
      expect(opts.model).toBeUndefined();
      expect(opts.extraEnv).toBeUndefined();
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

  describe('operator drain gate (issue #659 / #1976)', () => {
    it('refuses a launch with DrainModeError while draining, creating no task', async () => {
      const drainingDeps = { ...deps, isAccepting: () => false };
      await expect(launchTask(drainingDeps, { prompt: 'blocked', cwd: '/tmp' }))
        .rejects.toThrow(DrainModeError);
      // No side effects: no task record, no adapter launch.
      expect(store.listTasks()).toHaveLength(0);
      expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    });

    it('surfaces reason=draining and retryAfterSeconds≥1 on DrainModeError (issue #1976)', async () => {
      const drainingDeps = { ...deps, isAccepting: () => false };
      try {
        await launchTask(drainingDeps, { prompt: 'blocked', cwd: '/tmp' });
        expect.unreachable('expected DrainModeError');
      } catch (err) {
        expect(err).toBeInstanceOf(DrainModeError);
        const drain = err as DrainModeError;
        expect(drain.code).toBe('draining');
        expect(drain.reason).toBe('draining');
        expect(drain.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(drain.retryAfterSeconds)).toBe(true);
      }
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

  describe('automation kill-switch (issue #1710)', () => {
    it('refuses schedule-sourced launches while SAFE MODE is engaged', async () => {
      const gated = { ...deps, isAutomationEnabled: () => false };
      await expect(
        launchTask(gated, { prompt: 'sched', cwd: '/tmp', launchSource: 'schedule' }),
      ).rejects.toThrow(AutomationKillSwitchError);
      expect(store.listTasks()).toHaveLength(0);
      expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    });

    it('still accepts manual launches while SAFE MODE is engaged', async () => {
      const gated = { ...deps, isAutomationEnabled: () => false };
      const result = await launchTask(gated, {
        prompt: 'manual',
        cwd: '/tmp',
        launchSource: 'api',
      });
      expect(result.task.prompt).toBe('manual');
      expect(store.listTasks()).toHaveLength(1);
    });

    it('restores schedule launches once the kill-switch is disengaged', async () => {
      let automationEnabled = false;
      const gated = { ...deps, isAutomationEnabled: () => automationEnabled };
      await expect(
        launchTask(gated, { prompt: 'blocked', cwd: '/tmp', launchSource: 'schedule' }),
      ).rejects.toThrow(AutomationKillSwitchError);
      automationEnabled = true;
      const result = await launchTask(gated, {
        prompt: 'unblocked',
        cwd: '/tmp',
        launchSource: 'schedule',
      });
      expect(result.task.prompt).toBe('unblocked');
    });

    it('lets a safeModeExempt schedule launch through while SAFE MODE is engaged (issue #2672)', async () => {
      // The cross-repo orchestrator fire carries serverOpts.safeModeExempt so it
      // keeps ticking during SAFE MODE (it snapshots, honors the pause, spawns
      // nothing). Trusted server-internal channel — never from LaunchOpts.
      const gated = { ...deps, isAutomationEnabled: () => false };
      const result = await launchTask(
        gated,
        { prompt: 'orchestrator tick', cwd: '/tmp', launchSource: 'schedule' },
        { safeModeExempt: true },
      );
      expect(result.task.prompt).toBe('orchestrator tick');
      expect(store.listTasks()).toHaveLength(1);
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
      expect.objectContaining({ onPhase: expect.any(Function) }),
    );
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledWith(
      result.task.id,
      expect.stringContaining('needs kb'),
      '/tmp',
      undefined,
      expect.objectContaining({ onPhase: expect.any(Function) }),
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

  it('parks a launch on confirmed dependency degradation without consuming a worker slot', async () => {
    const dependencyPreflightRunner = vi.fn().mockResolvedValue([{
      dependency: 'kb',
      status: 'failed',
      category: 'provider_api',
      summary: 'KB provider is unavailable',
      recommendedAction: 'Restore the KB provider.',
    } satisfies LaunchPreflightFinding]);
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner,
      launchDependencyAdmission: new LaunchDependencyAdmission(),
    };

    const result = await launchTask(gatedDeps, {
      prompt: 'needs the knowledge base',
      cwd: '/tmp',
      projectId: 'github.com/example/project',
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
      dependencies: ['kb'],
      idempotencyKey: 'parked-kb-task',
    });

    expect(result).toMatchObject({ queued: true, parked: true });
    expect(result.task.status).toBe('pending');
    expect(result.task.launchIntent).toMatchObject({
      prompt: 'needs the knowledge base',
      cwd: '/tmp',
      projectId: 'github.com/example/project',
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
      dependencies: ['kb'],
      idempotencyKey: 'parked-kb-task',
    });
    expect(result.task.launchAdmission).toMatchObject({
      status: 'parked',
      reason: 'dependency_degraded',
      dependencies: [{ dependency: 'kb', state: 'degraded' }],
    });
    expect(gatedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    expect(gatedDeps.flushTasks).toHaveBeenCalledOnce();
    expect(store.getActiveCount()).toBe(0);
  });

  it('does not acknowledge or retain dependency-denied work when its persistence barrier fails', async () => {
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([{
        dependency: 'kb',
        status: 'failed',
        category: 'provider_api',
        summary: 'KB provider is unavailable',
        recommendedAction: 'Restore the KB provider.',
      } satisfies LaunchPreflightFinding]),
      launchDependencyAdmission: new LaunchDependencyAdmission(),
      flushTasks: vi.fn().mockRejectedValue(new Error('denied marker write failed')),
    };

    await expect(launchTask(gatedDeps, {
      prompt: 'dependency denied durability failure',
      cwd: '/tmp',
      dependencies: ['kb'],
    })).rejects.toThrow('denied marker write failed');

    expect(gatedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    expect(store.listTasks()).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        launchAdmission: undefined,
        disposition: expect.objectContaining({
          reason: 'launch_error',
          detail: expect.stringContaining('denied marker write failed'),
        }),
      }),
    ]);
  });

  it('does not cancel a replacement reservation when a stale dependency-denial barrier rejects', async () => {
    let now = 3_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let rejectFlush!: (err: Error) => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([{
        dependency: 'kb',
        status: 'failed',
        category: 'provider_api',
        summary: 'KB provider is unavailable',
      } satisfies LaunchPreflightFinding]),
      launchDependencyAdmission: new LaunchDependencyAdmission(),
      flushTasks: vi.fn(async () => {
        markFlushStarted();
        await new Promise<void>((_resolve, reject) => { rejectFlush = reject; });
      }),
    };

    try {
      const launch = launchTask(gatedDeps, {
        prompt: 'stale dependency denial owner',
        cwd: '/tmp',
        dependencies: ['kb'],
      });
      await flushStarted;
      const task = store.listTasks()[0]!;
      expect(store.getActiveCount()).toBe(0);
      const originalMarker = task.launchAdmission;
      now += 10 * 60 * 1_000 + 1;
      const replacementToken = store.beginLaunchWithToken(task.id);
      expect(replacementToken).toBeDefined();

      rejectFlush(new Error('stale denial write failed'));
      await expect(launch).rejects.toThrow('stale denial write failed');
      expect(store.getTask(task.id)).toMatchObject({
        status: 'pending',
        launchAdmission: originalMarker,
      });
      expect(store.getTask(task.id)?.disposition).toBeUndefined();
      expect(store.ownsLaunchReservation(task.id, replacementToken!)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not return a parked response after cancellation wins the denial barrier', async () => {
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([{
        dependency: 'kb',
        status: 'failed',
        category: 'provider_api',
        summary: 'KB provider is unavailable',
      } satisfies LaunchPreflightFinding]),
      launchDependencyAdmission: new LaunchDependencyAdmission(),
      flushTasks: vi.fn(async () => {
        markFlushStarted();
        await new Promise<void>((resolve) => { releaseFlush = resolve; });
      }),
    };

    const launch = launchTask(gatedDeps, {
      prompt: 'cancel dependency denial owner',
      cwd: '/tmp',
      dependencies: ['kb'],
    });
    await flushStarted;
    const task = store.listTasks()[0]!;
    store.cancelTask(task.id);
    releaseFlush();

    await expect(launch).rejects.toThrow('changed state while its dependency denial was persisted');
    expect(store.getTask(task.id)).toMatchObject({
      status: 'cancelled',
      launchAdmission: undefined,
    });
  });

  it('parks confirmed dependency degradation even when the ordinary pending queue is full', async () => {
    const active = store.createTask({ prompt: 'active worker', cwd: '/tmp' });
    store.startTask(active.id);
    const ordinaryPending = store.createTask({ prompt: 'capacity wait', cwd: '/tmp' });
    store.pendTask(ordinaryPending.id);
    const gatedDeps: LaunchServiceDeps = {
      ...deps,
      getMaxActiveTasks: () => 1,
      getMaxPendingTasks: () => 1,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([{
        dependency: 'kb',
        status: 'failed',
        category: 'provider_api',
        summary: 'KB provider is unavailable',
        recommendedAction: 'Restore the KB provider.',
      } satisfies LaunchPreflightFinding]),
      launchDependencyAdmission: new LaunchDependencyAdmission(),
    };

    expect(store.getPendingCount()).toBe(1);
    const result = await launchTask(gatedDeps, {
      prompt: 'must survive the provider outage',
      cwd: '/tmp',
      dependencies: ['kb'],
    });

    expect(result).toMatchObject({
      queued: true,
      parked: true,
      task: {
        status: 'pending',
        launchAdmission: { status: 'parked', reason: 'dependency_degraded' },
      },
    });
    expect(store.listTasks().filter((task) => task.status === 'pending')).toHaveLength(2);
    expect(store.getPendingCount()).toBe(1);
    expect(gatedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('returns parked admission metadata when a duplicate matches an existing parked task', async () => {
    const dependencyPreflightRunner = vi.fn().mockResolvedValue([{
      dependency: 'kb',
      status: 'failed',
      category: 'provider_api',
      summary: 'KB is unavailable',
      recommendedAction: 'Restore KB.',
    } satisfies LaunchPreflightFinding]);
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner,
      launchDependencyAdmission: new LaunchDependencyAdmission(),
    };
    const first = await launchTask(gatedDeps, {
      prompt: 'parked duplicate',
      cwd: '/tmp',
      agentType: 'claude-code',
      dependencies: ['kb'],
    });
    const duplicate = await launchTask(gatedDeps, {
      prompt: 'parked duplicate',
      cwd: '/tmp',
      agentType: 'claude-code',
      dependencies: ['kb'],
    });

    expect(first.parked).toBe(true);
    expect(duplicate).toMatchObject({
      task: { id: first.task.id },
      queued: true,
      duplicate: true,
      parked: true,
      dependencyAdmission: { status: 'parked', reason: 'dependency_degraded' },
    });
  });

  it('releases a half-open probe when task creation rejects', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    launchDependencyAdmission.observe(['kb'], []);
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
    };

    await expect(launchTask(gatedDeps, {
      prompt: 'missing parent',
      cwd: '/tmp',
      parentTaskId: 'missing-parent',
      dependencies: ['kb'],
    })).rejects.toThrow('Parent task not found: missing-parent');

    expect(launchDependencyAdmission.evaluate(['kb'])).toMatchObject({
      admit: true,
      probe: { dependencies: ['kb'] },
    });
  });

  it('fails open when dependency health is unknown', async () => {
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([{
        dependency: 'kb',
        status: 'failed',
        category: 'unknown',
        summary: 'KB health probe timed out',
        recommendedAction: 'Retry the health probe.',
      } satisfies LaunchPreflightFinding]),
      launchDependencyAdmission: new LaunchDependencyAdmission(),
    };

    const result = await launchTask(gatedDeps, {
      prompt: 'best effort without health data',
      cwd: '/tmp',
      dependencies: ['kb'],
    });

    expect(result.parked).toBeUndefined();
    expect(result.task.launchAdmission).toBeUndefined();
    expect(gatedDeps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('fails open when health collection times out', async () => {
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockRejectedValue(new Error('health probe timeout')),
      launchDependencyAdmission: new LaunchDependencyAdmission(),
    };

    const result = await launchTask(gatedDeps, {
      prompt: 'continue while health collection is unavailable',
      cwd: '/tmp',
      dependencies: ['kb'],
    });

    expect(result.parked).toBeUndefined();
    expect(result.task.launchAdmission).toBeUndefined();
    expect(gatedDeps.launchDependencyAdmission.snapshot()).toEqual([
      expect.objectContaining({ dependency: 'kb', state: 'unknown' }),
    ]);
    expect(gatedDeps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('does not hold a half-open probe while recovery work waits for capacity', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    launchDependencyAdmission.observe(['kb'], []);
    const gatedDeps = {
      ...deps,
      getMaxActiveTasks: () => 0,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      idempotencyLedger: new IdempotencyLedger(repoDir),
    };
    await gatedDeps.idempotencyLedger.load();

    const result = await launchTask(gatedDeps, {
      prompt: 'wait for a recovery slot',
      cwd: '/tmp',
      dependencies: ['kb'],
      idempotencyKey: 'capacity-wait-probe',
    });

    expect(result.queued).toBe(true);
    expect(result.parked).toBeUndefined();
    expect(result.task.status).toBe('pending');
    expect(result.task.launchAdmission).toMatchObject({
      status: 'parked',
      reason: 'half_open_waiting_for_capacity',
      dependencies: [{ dependency: 'kb', state: 'half_open' }],
    });
    expect(launchDependencyAdmission.snapshot()).toEqual([
      expect.objectContaining({ dependency: 'kb', state: 'half_open' }),
    ]);
    const nextProbe = launchDependencyAdmission.evaluate(['kb']);
    expect(nextProbe).toMatchObject({ admit: true, probe: { dependencies: ['kb'] } });
    if (nextProbe.admit) launchDependencyAdmission.releaseProbe(nextProbe.probe);

    const replay = await launchTask(gatedDeps, {
      prompt: 'wait for a recovery slot',
      cwd: '/tmp',
      dependencies: ['kb'],
      idempotencyKey: 'capacity-wait-probe',
    });
    expect(replay).toMatchObject({
      idempotentReplay: true,
      queued: true,
      dependencyAdmission: { reason: 'half_open_waiting_for_capacity' },
    });
    expect(replay.parked).toBeUndefined();

    const duplicate = await launchTask(gatedDeps, {
      prompt: 'wait for a recovery slot',
      cwd: '/tmp',
      dependencies: ['kb'],
    });
    expect(duplicate).toMatchObject({
      duplicate: true,
      queued: true,
      dependencyAdmission: { reason: 'half_open_waiting_for_capacity' },
    });
    expect(duplicate.parked).toBeUndefined();
  });

  it('does not cancel a replacement reservation when a stale capacity barrier rejects', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    launchDependencyAdmission.observe(['kb'], []);
    let now = 9_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let rejectFlush!: (err: Error) => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const gatedDeps = {
      ...deps,
      getMaxActiveTasks: () => 0,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      flushTasks: vi.fn(async () => {
        markFlushStarted();
        await new Promise<void>((_resolve, reject) => { rejectFlush = reject; });
      }),
    };

    try {
      const launch = launchTask(gatedDeps, {
        prompt: 'stale capacity wait owner',
        cwd: '/tmp',
        dependencies: ['kb'],
      });
      await flushStarted;
      const task = store.listTasks()[0]!;
      const originalMarker = task.launchAdmission;
      now += 10 * 60 * 1_000 + 1;
      const replacementToken = store.beginLaunchWithToken(task.id);
      expect(replacementToken).toBeDefined();

      rejectFlush(new Error('stale capacity write failed'));
      await expect(launch).rejects.toThrow('stale capacity write failed');
      expect(store.getTask(task.id)).toMatchObject({
        status: 'pending',
        launchAdmission: originalMarker,
      });
      expect(store.getTask(task.id)?.disposition).toBeUndefined();
      expect(store.ownsLaunchReservation(task.id, replacementToken!)).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not return queued after cancellation wins a capacity barrier', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    launchDependencyAdmission.observe(['kb'], []);
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const gatedDeps = {
      ...deps,
      getMaxActiveTasks: () => 0,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      flushTasks: vi.fn(async () => {
        markFlushStarted();
        await new Promise<void>((resolve) => { releaseFlush = resolve; });
      }),
    };

    const launch = launchTask(gatedDeps, {
      prompt: 'cancel capacity wait owner',
      cwd: '/tmp',
      dependencies: ['kb'],
    });
    await flushStarted;
    const task = store.listTasks()[0]!;
    store.cancelTask(task.id);
    releaseFlush();

    await expect(launch).rejects.toThrow('changed state while its capacity wait was persisted');
    expect(store.getTask(task.id)).toMatchObject({
      status: 'cancelled',
      launchAdmission: undefined,
    });
  });

  it('releases a half-open probe when the ordinary capacity queue is full', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    launchDependencyAdmission.observe(['kb'], []);
    const active = store.createTask({ prompt: 'active worker', cwd: '/tmp' });
    store.startTask(active.id);
    const pending = store.createTask({ prompt: 'ordinary capacity wait', cwd: '/tmp' });
    store.pendTask(pending.id);
    const gatedDeps: LaunchServiceDeps = {
      ...deps,
      getMaxActiveTasks: () => 1,
      getMaxPendingTasks: () => 1,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
    };

    await expect(launchTask(gatedDeps, {
      prompt: 'recovery probe with no queue room',
      cwd: '/tmp',
      dependencies: ['kb'],
    })).rejects.toSatisfy(isPendingQueueFullError);

    const nextProbe = launchDependencyAdmission.evaluate(['kb']);
    expect(nextProbe).toMatchObject({ admit: true, probe: { dependencies: ['kb'] } });
    if (nextProbe.admit) launchDependencyAdmission.releaseProbe(nextProbe.probe);
    expect(store.listTasks()).toHaveLength(2);
  });

  it('re-parks the same task when a half-open provider launch fails', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
    };
    vi.mocked(gatedDeps.adapterRegistry.get('claude-code').launch)
      .mockRejectedValueOnce(new Error('provider rejected recovery probe'));

    const result = await launchTask(gatedDeps, {
      prompt: 'preserve this recovery work',
      cwd: '/tmp',
      dependencies: ['kb'],
      idempotencyKey: 'stable-recovery-identity',
    });

    expect(result).toMatchObject({
      queued: true,
      parked: true,
      task: {
        status: 'pending',
        launchAdmission: { status: 'parked', reason: 'dependency_degraded' },
        launchIntent: { idempotencyKey: 'stable-recovery-identity' },
      },
    });
    expect(result.task.sessions).toEqual([]);
    expect(store.listTasks()).toHaveLength(1);
    expect(launchDependencyAdmission.snapshot()[0]).toMatchObject({ state: 'degraded' });
  });

  it('persists probing before launch and aborts a partial probe session before re-parking', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let probePersisted = false;
    let expectedSessionId: string | undefined;
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      flushTasks: vi.fn(async () => {
        const probing = store.listTasks().find((task) => task.launchAdmission?.status === 'probing');
        expect(probing?.launchAdmission).toMatchObject({
          status: 'probing',
          reason: 'half_open_probe_in_flight',
          sessionId: expect.stringMatching(/^kookr-/),
        });
        expectedSessionId = probing?.launchAdmission?.status === 'probing'
          ? probing.launchAdmission.sessionId
          : undefined;
        probePersisted = true;
      }),
    };
    const adapter = gatedDeps.adapterRegistry.get('claude-code');
    vi.mocked(adapter.launch).mockImplementationOnce(async (taskId, _prompt, cwd, _resume, options) => {
      expect(probePersisted).toBe(true);
      expect(store.getTask(taskId)?.launchAdmission).toMatchObject({
        status: 'probing',
        reason: 'half_open_probe_in_flight',
      });
      expect(options?.tmuxName).toBe(expectedSessionId);
      options?.onSessionCreated?.(expectedSessionId!);
      store.addSession(taskId, {
        tmuxSession: expectedSessionId!,
        agentType: 'claude-code',
        cwd,
        createdAt: new Date(),
      });
      throw new Error('provider failed after session creation');
    });

    const result = await launchTask(gatedDeps, {
      prompt: 'preserve partially launched recovery work',
      cwd: '/tmp',
      dependencies: ['kb'],
    });

    expect(result).toMatchObject({
      queued: true,
      parked: true,
      task: {
        status: 'pending',
        launchAdmission: { status: 'parked', reason: 'dependency_degraded' },
        sessions: [expect.objectContaining({
          tmuxSession: expectedSessionId,
          lastStatus: 'aborted',
        })],
      },
    });
    expect(adapter.stop).toHaveBeenCalledWith(expectedSessionId);
    expect(gatedDeps.flushTasks).toHaveBeenCalledOnce();
  });

  it('retains exact direct-probe ownership when partial-session cleanup rejects', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
    };
    const adapter = gatedDeps.adapterRegistry.get('claude-code');
    vi.mocked(adapter.launch).mockImplementationOnce(async (_taskId, _prompt, _cwd, _resume, options) => {
      options?.onSessionCreated?.(options.tmuxName!);
      throw new Error('provider failed after terminal creation');
    });
    vi.mocked(adapter.stop).mockRejectedValueOnce(new Error('terminal cleanup rejected'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      await expect(launchTask(gatedDeps, {
        prompt: 'retain ambiguous direct probe',
        cwd: '/tmp',
        dependencies: ['kb'],
      })).rejects.toThrow('provider failed after terminal creation');
    } finally {
      warnSpy.mockRestore();
    }

    const [retained] = store.listTasks();
    const retainedSessionId = retained.launchAdmission?.status === 'probing'
      ? retained.launchAdmission.sessionId
      : undefined;
    expect(retained).toMatchObject({
      status: 'inProgress',
      launchAdmission: {
        status: 'probing',
        reason: 'half_open_probe_in_flight',
        sessionId: expect.stringMatching(/^kookr-/),
      },
      sessions: [expect.objectContaining({
        tmuxSession: retainedSessionId,
        lastStatus: undefined,
      })],
    });
    expect(adapter.stop).toHaveBeenCalledWith(retainedSessionId);
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    launchDependencyAdmission.observe(['kb'], []);
    expect(launchDependencyAdmission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  it('keeps a timed-out direct probe fenced until a late-created session is reaped', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      getLaunchTimeoutMs: () => 5,
    };
    const adapter = gatedDeps.adapterRegistry.get('claude-code');
    let reportLateSession!: () => void;
    let expectedSessionId: string | undefined;
    vi.mocked(adapter.launch).mockImplementationOnce(
      async (_taskId, _prompt, _cwd, _resume, options) => {
        expectedSessionId = options?.tmuxName;
        reportLateSession = () => options?.onSessionCreated?.(expectedSessionId!);
        return new Promise<string>(() => undefined);
      },
    );

    await expect(launchTask(gatedDeps, {
      prompt: 'late-created direct probe',
      cwd: '/tmp',
      dependencies: ['kb'],
    })).rejects.toBeInstanceOf(LaunchTimeoutError);

    expect(adapter.stop).not.toHaveBeenCalled();
    expect(store.listTasks()[0]).toMatchObject({
      status: 'inProgress',
      launchAdmission: { status: 'probing', sessionId: expectedSessionId },
      sessions: [],
    });
    expect(launchDependencyAdmission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });

    reportLateSession();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(adapter.stop).toHaveBeenCalledOnce();
    expect(adapter.stop).toHaveBeenCalledWith(expectedSessionId);
    expect(store.listTasks()[0]).toMatchObject({
      status: 'inProgress',
      launchAdmission: { status: 'probing', sessionId: expectedSessionId },
      sessions: [expect.objectContaining({
        tmuxSession: expectedSessionId,
        lastStatus: 'aborted',
      })],
    });
    expect(launchDependencyAdmission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  it('fails closed before direct probe launch when the persistence barrier fails', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      flushTasks: vi.fn().mockRejectedValueOnce(new Error('probe marker write failed')),
    };
    const adapter = gatedDeps.adapterRegistry.get('claude-code');

    await expect(launchTask(gatedDeps, {
      prompt: 'do not launch without durable probe ownership',
      cwd: '/tmp',
      dependencies: ['kb'],
    })).rejects.toThrow('probe marker write failed');

    expect(adapter.launch).not.toHaveBeenCalled();
    expect(store.listTasks()).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        disposition: expect.objectContaining({
          reason: 'launch_error',
          detail: expect.stringContaining('probe marker write failed'),
        }),
      }),
    ]);
  });

  it('finalizes an idempotency key to the disposed task when the direct probe barrier fails', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const ledger = new IdempotencyLedger(repoDir);
    await ledger.load();
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      idempotencyLedger: ledger,
      flushTasks: vi.fn().mockRejectedValueOnce(new Error('durability unavailable')),
    };
    const opts = {
      prompt: 'stable failed durability identity',
      cwd: '/tmp',
      dependencies: ['kb'] as const,
      idempotencyKey: 'failed-probe-barrier',
    };

    await expect(launchTask(gatedDeps, opts)).rejects.toThrow('durability unavailable');
    const disposed = store.listTasks()[0]!;

    const replay = await launchTask(gatedDeps, opts);
    expect(replay).toMatchObject({
      idempotentReplay: true,
      task: {
        id: disposed.id,
        status: 'cancelled',
        disposition: { reason: 'launch_error' },
      },
    });
    expect(gatedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    expect(store.listTasks()).toHaveLength(1);
  });

  it('does not start a direct probe cancelled while its marker is being persisted', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      flushTasks: vi.fn(async () => {
        markFlushStarted();
        await new Promise<void>((resolve) => { releaseFlush = resolve; });
      }),
    };

    const launch = launchTask(gatedDeps, {
      prompt: 'cancel during direct probe persistence',
      cwd: '/tmp',
      dependencies: ['kb'],
    });
    await flushStarted;
    const task = store.listTasks()[0]!;
    store.cancelTask(task.id);
    releaseFlush();

    await expect(launch).rejects.toThrow('changed state while its probe marker was persisted');
    expect(gatedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    expect(store.getTask(task.id)).toMatchObject({ status: 'cancelled', launchAdmission: undefined });
    expect(launchDependencyAdmission.snapshot()[0]).toMatchObject({ state: 'half_open' });
  });

  it('re-parks a direct probe when confirmed degradation invalidates its token during persistence', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      flushTasks: vi.fn()
        .mockImplementationOnce(async () => {
          markFlushStarted();
          await new Promise<void>((resolve) => { releaseFlush = resolve; });
        })
        .mockResolvedValue(undefined),
    };

    const launch = launchTask(gatedDeps, {
      prompt: 'invalidate direct probe token',
      cwd: '/tmp',
      dependencies: ['kb'],
    });
    await flushStarted;
    launchDependencyAdmission.observe(['kb'], [{
      dependency: 'kb',
      category: 'provider_api',
      summary: 'provider degraded again',
    }]);
    releaseFlush();

    await expect(launch).resolves.toMatchObject({
      queued: true,
      parked: true,
      task: { status: 'pending', launchAdmission: { reason: 'dependency_degraded' } },
    });
    expect(gatedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    expect(launchDependencyAdmission.snapshot()[0]).toMatchObject({ state: 'degraded' });
  });

  it('disposes a direct probe when its re-park persistence barrier fails', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      flushTasks: vi.fn()
        .mockImplementationOnce(async () => {
          markFlushStarted();
          await new Promise<void>((resolve) => { releaseFlush = resolve; });
        })
        .mockRejectedValueOnce(new Error('direct re-park write failed')),
    };

    const launch = launchTask(gatedDeps, {
      prompt: 'failed direct re-park barrier',
      cwd: '/tmp',
      dependencies: ['kb'],
    });
    await flushStarted;
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    releaseFlush();

    await expect(launch).rejects.toThrow('direct re-park write failed');
    expect(gatedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    expect(store.listTasks()).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        launchAdmission: undefined,
        disposition: expect.objectContaining({ reason: 'launch_error' }),
      }),
    ]);
  });

  it('does not dispose replacement-owned work when a stale direct re-park barrier rejects', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let now = 7_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let releaseFirst!: () => void;
    let rejectSecond!: (err: Error) => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      flushTasks: vi.fn()
        .mockImplementationOnce(async () => {
          markFirstStarted();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        })
        .mockImplementationOnce(async () => {
          markSecondStarted();
          await new Promise<void>((_resolve, reject) => { rejectSecond = reject; });
        }),
    };

    try {
      const launch = launchTask(gatedDeps, {
        prompt: 'stale direct re-park owner',
        cwd: '/tmp',
        dependencies: ['kb'],
      });
      await firstStarted;
      launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
      releaseFirst();
      await secondStarted;
      const task = store.listTasks()[0]!;
      const replacementMarker = task.launchAdmission;
      now += 10 * 60 * 1_000 + 1;
      const replacementToken = store.beginLaunchWithToken(task.id);
      expect(replacementToken).toBeDefined();

      rejectSecond(new Error('stale direct re-park write failed'));
      await expect(launch).rejects.toThrow('stale direct re-park write failed');
      expect(store.getTask(task.id)).toMatchObject({
        status: 'pending',
        launchAdmission: replacementMarker,
      });
      expect(store.getTask(task.id)?.disposition).toBeUndefined();
      expect(store.ownsLaunchReservation(task.id, replacementToken!)).toBe(true);
      expect(gatedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps a live direct probe when post-attach persistence fails', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const flushTasks = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('post-attach write failed'));
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
      flushTasks,
    };
    const adapter = gatedDeps.adapterRegistry.get('claude-code');
    vi.mocked(adapter.launch).mockImplementationOnce(async (taskId, _prompt, cwd, _resume, options) => {
      const sessionId = options?.tmuxName;
      expect(sessionId).toMatch(/^kookr-/);
      options?.onSessionCreated?.(sessionId!);
      store.addSession(taskId, {
        tmuxSession: sessionId!,
        agentType: 'claude-code',
        cwd,
        createdAt: new Date(),
      });
      return sessionId!;
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    let result;
    try {
      result = await launchTask(gatedDeps, {
        prompt: 'live direct probe survives post-attach flush failure',
        cwd: '/tmp',
        dependencies: ['kb'],
      });
    } finally {
      errorSpy.mockRestore();
    }

    expect(result).toMatchObject({ queued: false, task: { status: 'inProgress', launchAdmission: undefined } });
    expect(flushTasks).toHaveBeenCalledTimes(2);
    expect(adapter.launch).toHaveBeenCalledOnce();
    expect(launchDependencyAdmission.snapshot()[0]).toMatchObject({ state: 'healthy' });
  });

  it('retains a terminal probe fence when completion wins during post-attach persistence', async () => {
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let releasePostAttach!: () => void;
    let markPostAttachStarted!: () => void;
    const postAttachStarted = new Promise<void>((resolve) => { markPostAttachStarted = resolve; });
    const flushTasks = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        markPostAttachStarted();
        await new Promise<void>((resolve) => { releasePostAttach = resolve; });
      });
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission: admission,
      flushTasks,
    };
    const adapter = gatedDeps.adapterRegistry.get('claude-code');
    vi.mocked(adapter.launch).mockImplementationOnce(async (taskId, _prompt, cwd, _resume, options) => {
      const sessionId = options?.tmuxName!;
      options?.onSessionCreated?.(sessionId);
      store.addSession(taskId, {
        tmuxSession: sessionId,
        agentType: 'claude-code',
        cwd,
        createdAt: new Date(),
      });
      return sessionId;
    });

    const launched = launchTask(gatedDeps, {
      prompt: 'completion races direct probe persistence',
      cwd: '/tmp',
      dependencies: ['kb'],
    });
    await postAttachStarted;
    const taskId = store.listTasks()[0]!.id;
    store.completeTask(taskId);
    expect(() => store.reopenTask(taskId)).toThrow(/cleanup is in progress/);
    releasePostAttach();
    await launched;

    expect(store.getTask(taskId)).toMatchObject({
      status: 'completed',
      launchAdmission: { status: 'probing' },
    });
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  it('does not degrade the circuit when a direct probe task is cancelled before rejection', async () => {
    const launchDependencyAdmission = new LaunchDependencyAdmission();
    launchDependencyAdmission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      launchDependencyAdmission,
    };
    const adapter = gatedDeps.adapterRegistry.get('claude-code');
    vi.mocked(adapter.launch).mockImplementationOnce(async (taskId, _prompt, cwd, _resume, options) => {
      options?.onSessionCreated?.('cancelled-probe-direct');
      store.addSession(taskId, {
        tmuxSession: 'cancelled-probe-direct',
        agentType: 'claude-code',
        cwd,
        createdAt: new Date(),
      });
      store.cancelTask(taskId);
      throw new Error('adapter rejected after cancellation');
    });

    await expect(launchTask(gatedDeps, {
      prompt: 'cancel this direct recovery probe',
      cwd: '/tmp',
      dependencies: ['kb'],
    })).rejects.toThrow('adapter rejected after cancellation');

    expect(store.listTasks()[0]).toMatchObject({
      status: 'cancelled',
      launchAdmission: undefined,
    });
    expect(launchDependencyAdmission.snapshot()[0]).toMatchObject({ state: 'half_open' });
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

  it('stamps pre-authorized delivery authorization by default', async () => {
    const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });

    expect(result.task.deliveryAuthorization).toBe('pre-authorized');
    expect(store.getTask(result.task.id)?.deliveryAuthorization).toBe('pre-authorized');
  });

  it('stamps ask-first delivery authorization from server-only launch options', async () => {
    const result = await launchTask(
      deps,
      { prompt: 'hello ask-first', cwd: '/tmp' },
      { deliveryPolicy: 'ask-first' },
    );

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

  it('disposes (never deletes) the task record when adapter.launch throws, and a no-key retry still launches fresh (issue #1588)', async () => {
    const adapter = deps.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('tmux unsafe permissions'));

    // First launch fails
    await expect(launchTask(deps, { prompt: 'do work', cwd: '/tmp' }))
      .rejects.toThrow('tmux unsafe permissions');

    // Issue #1588: the record is NOT silently deleted. It stays queryable,
    // terminal, and carries a disposition explaining why it died.
    const [disposed] = store.listTasks();
    expect(store.listTasks()).toHaveLength(1);
    expect(disposed.status).toBe('terminated');
    expect(disposed.disposition?.reason).toBe('launch_error');
    expect(disposed.disposition?.source).toBe('launch-service');
    expect(disposed.disposition?.at).toBeTruthy();
    expect(disposed.sessions).toHaveLength(0);

    // Retry (no idempotency key) is not blocked by dedup — a terminal task
    // never matches the active-only dedup — so a fresh task launches.
    (adapter.launch as ReturnType<typeof vi.fn>).mockResolvedValueOnce('tmux-session');
    const result = await launchTask(deps, { prompt: 'do work', cwd: '/tmp' });
    expect(result.duplicate).toBeUndefined();
    expect(result.task.id).not.toBe(disposed.id);
    expect(result.task.prompt).toBe('do work');
  });

  describe('per-phase launch timings (issue #1589)', () => {
    /** Make the claude adapter report the given phases (in order) then resolve. */
    function reportPhasesThenResolve(phases: Array<'session-create' | 'agent-boot' | 'ack'>) {
      const adapter = deps.adapterRegistry.get('claude-code');
      (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
          for (const p of phases) opts?.onPhase?.(p);
          return 'tmux-claude';
        },
      );
    }

    it('persists the full phase sequence on a successful launch, with no incomplete phase', async () => {
      reportPhasesThenResolve(['session-create', 'agent-boot', 'ack']);
      const result = await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });

      const timings = store.getTask(result.task.id)?.launchPhaseTimings;
      expect(timings).toBeDefined();
      expect(timings!.phases.map((p) => p.phase)).toEqual([
        'preflight', 'reserve', 'session-create', 'agent-boot', 'ack',
      ]);
      expect(timings!.phases.every((p) => p.completed)).toBe(true);
      expect(timings!.incompletePhase).toBeUndefined();
      expect(timings!.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('a launch that times out in a simulated phase records that phase as incomplete (AC#3)', async () => {
      const adapter = deps.adapterRegistry.get('claude-code');
      // Report session-create, then hang forever inside that phase.
      (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
          opts?.onPhase?.('session-create');
          return new Promise<string>(() => { /* never settles → times out */ });
        },
      );
      deps.getLaunchTimeoutMs = () => 20;

      await expect(launchTask(deps, { prompt: 'do work', cwd: '/tmp' }))
        .rejects.toBeInstanceOf(LaunchTimeoutError);

      const [disposed] = store.listTasks();
      expect(disposed.disposition?.reason).toBe('launch_timeout');
      const timings = disposed.launchPhaseTimings;
      expect(timings).toBeDefined();
      expect(timings!.incompletePhase).toBe('session-create');
      const phase = timings!.phases.find((p) => p.phase === 'session-create');
      expect(phase?.completed).toBe(false);
      // Earlier phases handed off cleanly.
      expect(timings!.phases.find((p) => p.phase === 'reserve')?.completed).toBe(true);
    });

    it('localizes a hang to a later phase (agent-boot) when earlier phases completed', async () => {
      const adapter = deps.adapterRegistry.get('claude-code');
      (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
          opts?.onPhase?.('session-create');
          opts?.onPhase?.('agent-boot');
          return new Promise<string>(() => { /* hangs in agent-boot */ });
        },
      );
      deps.getLaunchTimeoutMs = () => 20;

      await expect(launchTask(deps, { prompt: 'boot hang', cwd: '/tmp' }))
        .rejects.toBeInstanceOf(LaunchTimeoutError);

      const [disposed] = store.listTasks();
      expect(disposed.launchPhaseTimings?.incompletePhase).toBe('agent-boot');
      expect(disposed.launchPhaseTimings?.phases.find((p) => p.phase === 'session-create')?.completed).toBe(true);
    });

    it('attaches phase timings to the thrown error so a dispatch_failed ledger row can carry them (AC#2)', async () => {
      const adapter = deps.adapterRegistry.get('claude-code');
      (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
          opts?.onPhase?.('session-create');
          return new Promise<string>(() => { /* hangs → timeout */ });
        },
      );
      deps.getLaunchTimeoutMs = () => 20;

      let caught: unknown;
      try {
        await launchTask(deps, { prompt: 'ledger work', cwd: '/tmp' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchTimeoutError);
      const timings = launchPhaseTimingsOf(caught);
      expect(timings).toBeDefined();
      expect(timings!.incompletePhase).toBe('session-create');
    });

    it('records timings on a launch that throws (not just timeouts)', async () => {
      const adapter = deps.adapterRegistry.get('claude-code');
      (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
          opts?.onPhase?.('session-create');
          throw new Error('createSession failed');
        },
      );

      await expect(launchTask(deps, { prompt: 'boom', cwd: '/tmp' }))
        .rejects.toThrow('createSession failed');

      const [disposed] = store.listTasks();
      expect(disposed.disposition?.reason).toBe('launch_error');
      expect(disposed.launchPhaseTimings?.incompletePhase).toBe('session-create');
    });
  });

  describe('launch-timeout links + reaps a late dtach master (issue #2500)', () => {
    it('records the session created during session-create on the terminated task AND reaps it (AC#1)', async () => {
      const adapter = deps.adapterRegistry.get('claude-code');
      // session-create completes (master `kookr-late1` exists) then agent-boot
      // hangs past the top-level timeout — the exact leak: a live master whose
      // launch is abandoned before `addSession` (which only runs at `ack`).
      (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
          opts?.onPhase?.('session-create');
          opts?.onSessionCreated?.('kookr-late1');
          opts?.onPhase?.('agent-boot');
          return new Promise<string>(() => { /* hangs in agent-boot → times out */ });
        },
      );
      deps.getLaunchTimeoutMs = () => 20;

      await expect(launchTask(deps, { prompt: 'boot hang', cwd: '/tmp' }))
        .rejects.toBeInstanceOf(LaunchTimeoutError);

      const [disposed] = store.listTasks();
      expect(disposed.status).toBe('terminated');
      expect(disposed.disposition?.reason).toBe('launch_timeout');
      // The master is now recorded on the task (so the reaper owns it as a
      // terminal-task-leak, not an unowned 24h orphan) with a dead lastStatus.
      const recorded = disposed.sessions.find((s) => s.tmuxSession === 'kookr-late1');
      expect(recorded).toBeDefined();
      expect(recorded?.lastStatus).toBe('aborted');
      // …and it was reaped via the adapter's stop() (TERM -> grace -> KILL).
      expect(adapter.stop).toHaveBeenCalledWith('kookr-late1');
    });

    it('reaps + links a master whose socket appears shortly AFTER the abandon (AC#2)', async () => {
      const adapter = deps.adapterRegistry.get('claude-code');
      // The launch is abandoned while still in session-create; the dtach master
      // only comes up a moment later (onSessionCreated fires late). It must still
      // be linked (never left unowned for 24h) and reaped.
      (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
          opts?.onPhase?.('session-create');
          return new Promise<string>(() => {
            setTimeout(() => opts?.onSessionCreated?.('kookr-late2'), 40);
          });
        },
      );
      deps.getLaunchTimeoutMs = () => 20;

      await expect(launchTask(deps, { prompt: 'late socket', cwd: '/tmp' }))
        .rejects.toBeInstanceOf(LaunchTimeoutError);
      // Let the late master appear.
      await new Promise((resolve) => setTimeout(resolve, 80));

      const [disposed] = store.listTasks();
      expect(disposed.status).toBe('terminated');
      const recorded = disposed.sessions.find((s) => s.tmuxSession === 'kookr-late2');
      expect(recorded).toBeDefined();
      expect(recorded?.lastStatus).toBe('aborted');
      expect(adapter.stop).toHaveBeenCalledWith('kookr-late2');
    });

    it('reaps the abandoned session exactly once even when the abandoned launch RESOLVES late with the same id', async () => {
      const adapter = deps.adapterRegistry.get('claude-code');
      let resolveLate: (id: string) => void = () => {};
      (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
          opts?.onPhase?.('session-create');
          opts?.onSessionCreated?.('kookr-dup');
          opts?.onPhase?.('agent-boot');
          // Resolve LATE (after the timeout) with the SAME id — exercises the
          // race helper's late-settlement path against the abandon reap.
          return new Promise<string>((resolve) => { resolveLate = resolve; });
        },
      );
      deps.getLaunchTimeoutMs = () => 20;

      await expect(launchTask(deps, { prompt: 'late resolve', cwd: '/tmp' }))
        .rejects.toBeInstanceOf(LaunchTimeoutError);
      // Now let the abandoned promise resolve late.
      resolveLate('kookr-dup');
      await new Promise((resolve) => setTimeout(resolve, 20));

      // The shared reap guard must dedup: stop() fires once, not twice.
      expect(adapter.stop).toHaveBeenCalledTimes(1);
      expect(adapter.stop).toHaveBeenCalledWith('kookr-dup');
    });

    it('writes a session.reap-shaped audit row (actor system:launch-service) when auditLogPath is wired', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kookr-launch-audit-'));
      try {
        const auditLogPath = join(dir, 'audit.jsonl');
        deps.auditLogPath = auditLogPath;
        const adapter = deps.adapterRegistry.get('claude-code');
        (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
          (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
            opts?.onPhase?.('session-create');
            opts?.onSessionCreated?.('kookr-audit');
            opts?.onPhase?.('agent-boot');
            return new Promise<string>(() => { /* hangs → times out */ });
          },
        );
        deps.getLaunchTimeoutMs = () => 20;

        await expect(launchTask(deps, { prompt: 'audit me', cwd: '/tmp' }))
          .rejects.toBeInstanceOf(LaunchTimeoutError);

        // The audit append is best-effort/async — poll until the row lands.
        let reap: Record<string, unknown> | undefined;
        for (let i = 0; i < 50 && !reap; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          const raw = await readFile(auditLogPath, 'utf-8').catch(() => '');
          reap = raw
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
            .find((r) => r.type === 'session.reap' && r.sessionId === 'kookr-audit');
        }
        expect(reap).toBeDefined();
        expect(reap).toMatchObject({
          type: 'session.reap',
          actor: 'system:launch-service',
          kind: 'terminal-task-leak',
          signal: 'SIGTERM_then_SIGKILL',
          taskId: (deps.taskStore.listTasks()[0]!).id,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('does NOT write a success session.reap audit row when adapter.stop() rejects (kill failed)', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'kookr-launch-audit-fail-'));
      try {
        const auditLogPath = join(dir, 'audit.jsonl');
        deps.auditLogPath = auditLogPath;
        const adapter = deps.adapterRegistry.get('claude-code');
        // The kill fails — the master may still be alive, so no "reaped" row.
        (adapter.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('killSession failed'));
        (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
          (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
            opts?.onPhase?.('session-create');
            opts?.onSessionCreated?.('kookr-killfail');
            opts?.onPhase?.('agent-boot');
            return new Promise<string>(() => { /* hangs → times out */ });
          },
        );
        deps.getLaunchTimeoutMs = () => 20;

        await expect(launchTask(deps, { prompt: 'kill fails', cwd: '/tmp' }))
          .rejects.toBeInstanceOf(LaunchTimeoutError);
        // Give the rejected stop() and any (absent) audit write time to settle.
        await new Promise((resolve) => setTimeout(resolve, 60));

        // The session is still linked to the task (reaper safety net)…
        const [disposed] = store.listTasks();
        expect(disposed.sessions.some((s) => s.tmuxSession === 'kookr-killfail')).toBe(true);
        // …but no false-positive `session.reap` success row was written.
        const raw = await readFile(auditLogPath, 'utf-8').catch(() => '');
        const reaped = raw
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .some((r) => r.type === 'session.reap' && r.sessionId === 'kookr-killfail');
        expect(reaped).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('a successful launch under the timeout neither records an abandoned session nor reaps (AC#4)', async () => {
      const adapter = deps.adapterRegistry.get('claude-code');
      (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
        (_id: string, _prompt: string, _cwd: string, _resume: unknown, opts: any) => {
          opts?.onPhase?.('session-create');
          opts?.onSessionCreated?.('kookr-ok');
          opts?.onPhase?.('agent-boot');
          opts?.onPhase?.('ack');
          return Promise.resolve('kookr-ok');
        },
      );
      deps.getLaunchTimeoutMs = () => 5000;

      const result = await launchTask(deps, { prompt: 'healthy', cwd: '/tmp' });
      expect(result.queued).toBe(false);
      // No reap of a live, healthy session.
      expect(adapter.stop).not.toHaveBeenCalled();
      // No abandoned-session record (the fake adapter never calls addSession, so
      // the only way `kookr-ok` could appear is the #2500 abandon path — it must
      // not fire on the success path).
      const [task] = store.listTasks();
      expect(task.sessions.some((s) => s.tmuxSession === 'kookr-ok')).toBe(false);
    });
  });

  describe('grok-build agent-boot wall-clock bound (issue #1642)', () => {
    /**
     * End-to-end reproduction of the reported grok-build `POST /api/tasks`
     * >90s launch hang: a REAL `GrokBuildAdapter` (not a fake `.launch`
     * mock) wired against a terminal backend whose `captureBytes` never
     * resolves — the same failure mode as a wedged pty under host
     * contention, or Grok showing a blocking startup screen that never
     * emits the ready DECSET. Before the #1642 fix, `waitForReadyOrAbort`'s
     * "bounded" ready-wait loop can never check its own deadline because the
     * awaited capture itself hangs, and the launch is only ever bounded by
     * the coarse 180s top-level `launchTimeoutSeconds` (#1528) — holding
     * `POST /api/tasks` open for the whole ceiling. This proves the
     * grok-build-specific `agentBootTimeoutMs` bound (default ~50s, pinned
     * to 50ms here) fires FIRST and aborts the launch fast, with
     * `dispatch_failed`/`launch_error` naming `agent-boot` as the
     * `incompletePhase` — not an unbounded hang up to the 180s ceiling.
     */
    it('aborts a launch hung in agent-boot well under the top-level launch timeout, naming agent-boot as incompletePhase', async () => {
      const { GrokBuildAdapter } = await import('../adapters/grok-build-adapter.js');
      const { FakeTerminalBackend } = await import('../adapters/fake-terminal-backend.js');

      const sessionHomeRoot = await mkdtemp(join(tmpdir(), 'launch-svc-grok-home-'));
      const sourceGrokHome = await mkdtemp(join(tmpdir(), 'launch-svc-grok-source-'));
      try {
        await writeFile(
          join(sourceGrokHome, 'auth.json'),
          JSON.stringify({
            // Key under the configured default scope the preflight looks up;
            // an arbitrary scope reads as "no usable credential" and the
            // launch would fail at auth-preflight before reaching agent-boot.
            'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828': {
              key: 'test-access-token',
              auth_mode: 'oidc',
              create_time: '2026-07-01T00:00:00Z',
              user_id: 'test-user',
              expires_at: '2030-01-01T00:00:00Z',
              refresh_token: 'test-refresh-token',
            },
          }),
        );

        const backend = new FakeTerminalBackend();
        // Wedged terminal capture — never resolves, so every internal
        // ready-wait loop's `Date.now() <= deadline` check never runs.
        vi.spyOn(backend, 'captureBytes').mockImplementation(() => new Promise(() => { /* never settles */ }));

        const grokAdapter = new GrokBuildAdapter(backend as any, store, {
          // Literal PATH — the launch aborts in agent-boot before anything is
          // exec'd, so a fixed value is fine; reading the ambient PATH from the
          // environment here would trip the PR-checklist env rule.
          env: { PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv,
          installedStateOverride: {
            kind: 'ok',
            version: '0.2.93',
            buildId: 'test-build',
            identity: {
              configured: 'grok',
              launcherPath: '/fake/.grok/bin/grok',
              canonicalPath: '/fake/.grok/bin/grok-0.2.93',
              sha256: 'a'.repeat(64),
              sizeBytes: 1,
              mode: 0o755,
              uid: 0,
              gid: 0,
            },
            qualification: { status: 'tested', reason: 'matches tested build', evidenceBuildId: '0.2.93' },
          } as any,
          sourceGrokHome,
          sessionHomeRoot,
          promptReadyTimeoutMs: 30,
          agentBootTimeoutMs: 50,
        });

        const registry = new AdapterRegistry();
        registry.register(grokAdapter as any);
        const grokDeps: LaunchServiceDeps = {
          ...makeDeps(store),
          adapterRegistry: registry,
          // The outer backstop is left at a production-like 180s: the whole
          // point of the fix is that agent-boot's own, much tighter bound
          // fires first, so this test would time out (way past the vitest
          // test timeout) if the fix regressed to relying on this alone.
          getLaunchTimeoutMs: () => 180_000,
        };

        const start = Date.now();
        await expect(
          launchTask(grokDeps, { prompt: 'grok hang', cwd: '/tmp', agentType: 'grok-build' }),
        ).rejects.toThrow(/agent-boot did not complete within/);
        const elapsed = Date.now() - start;

        // Bounded to roughly agentBootTimeoutMs (50ms) — nowhere near the
        // 180s outer ceiling — proving the launch was aborted, not hung.
        expect(elapsed).toBeLessThan(5_000);

        const [disposed] = store.listTasks();
        expect(disposed.disposition?.reason).toBe('launch_error');
        expect(disposed.launchPhaseTimings?.incompletePhase).toBe('agent-boot');
        expect(disposed.launchPhaseTimings?.phases.find((p) => p.phase === 'session-create')?.completed).toBe(true);
      } finally {
        await rm(sessionHomeRoot, { recursive: true, force: true });
        await rm(sourceGrokHome, { recursive: true, force: true });
      }
    });
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
    // adapterOpts). For non-ralph launches `resume` is undefined and adapterOpts
    // carries only the phase-instrumentation callback (issue #1589).
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledWith(
      result.task.id,
      `Read ${filePath} before coding.`,
      repoDir,
      undefined,
      expect.objectContaining({ onPhase: expect.any(Function) }),
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
    expect(result.task.prompt).toContain('Delivery is pre-authorized for this task');
    expect(result.task.prompt).toContain('Implement the bug fix and update tests.');
  });

  it('prefixes ask-first delivery guidance when requested by server launch context', async () => {
    await initGitRepo(repoDir);

    const result = await launchTask(
      deps,
      {
        prompt: 'Implement the bug fix and update tests.',
        cwd: repoDir,
      },
      { deliveryPolicy: 'ask-first' },
    );

    expect(result.task.prompt).toContain('ask the user whether to push the branch and open a PR');
    expect(result.task.prompt).not.toContain('Delivery is pre-authorized for this task');
    expect(result.task.deliveryAuthorization).toBe('ask-first');
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
    expect(result.task.prompt).toContain('Delivery is pre-authorized for this task');
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
      // adapterOpts always carries the phase-instrumentation onPhase callback
      // (issue #1589); objectContaining keeps this focused on the ralph env.
      expect(adapter.launch).toHaveBeenCalledWith(
        result.task.id,
        'iterate',
        '/tmp',
        undefined,
        expect.objectContaining({
          extraEnv: {
            RALPH_VERDICT_FILE: expect.stringMatching(new RegExp(`/\\.ralph-verdict-${expectedSuffix}\\.json$`)),
            RALPH_ITERATION: '0',
          },
        }),
      );
      const opts = (adapter.launch as ReturnType<typeof vi.fn>).mock.calls[0]![4];
      expect(typeof opts.onPhase).toBe('function');
    });

    it('omits env/effort/model adapter opts when ralphVerdictEnv is unset (no regression for non-ralph launches)', async () => {
      await launchTask(deps, { prompt: 'hello', cwd: '/tmp' });
      const adapter = deps.adapterRegistry.get('claude-code');
      const launchCall = (adapter.launch as ReturnType<typeof vi.fn>).mock.calls[0];
      // adapterOpts carries only the phase-instrumentation callback (issue
      // #1589) — no extraEnv/effort/model when none were requested.
      const opts = launchCall![4];
      expect(typeof opts.onPhase).toBe('function');
      expect(opts.extraEnv).toBeUndefined();
      expect(opts.effort).toBeUndefined();
      expect(opts.model).toBeUndefined();
    });

    it('omits env adapter opts when ralphVerdictEnv is explicit false', async () => {
      await launchTask(deps, { prompt: 'hello-explicit-false', cwd: '/tmp', ralphVerdictEnv: false });
      const adapter = deps.adapterRegistry.get('claude-code');
      const launchCall = (adapter.launch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(launchCall![4].extraEnv).toBeUndefined();
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

describe('launchTask boot-reliability failover precondition (#1898)', () => {
  function mockAdapter(agentType: string, tmux: string) {
    return {
      agentType,
      launch: vi.fn().mockResolvedValue(tmux),
      sendInput: vi.fn(),
      sendKeystroke: vi.fn(),
      stop: vi.fn(),
      captureDisplay: vi.fn(),
      onEvent: vi.fn(),
      onRefreshNeeded: vi.fn(),
      injectHookEvent: vi.fn(),
    } as any;
  }

  /** All three agents registered; the round-robin cursor parked on grok's slot (index 2). */
  function threeAgentDeps(monitor: AgentBootLatencyMonitor): {
    deps: LaunchServiceDeps;
    registry: AdapterRegistry;
  } {
    const store = new TaskStore();
    const registry = new AdapterRegistry();
    registry.register(mockAdapter('claude-code', 'tmux-claude'));
    registry.register(mockAdapter('codex-cli', 'tmux-codex'));
    registry.register(mockAdapter('grok-build', 'tmux-grok'));
    const deps: LaunchServiceDeps = {
      ...makeDeps(store),
      adapterRegistry: registry,
      roundRobinCursor: { peek: () => 2, advance: () => {} },
      getDeprioritizedAgentTypes: (available) => monitor.deprioritizedTypes(available),
      recordLaunchBootLatency: (agentType, timings) => monitor.record(agentType, timings),
    };
    return { deps, registry };
  }

  const hungBoot: LaunchPhaseTimings = {
    phases: [{ phase: 'agent-boot', durationMs: 90_000, completed: false }],
    totalMs: 90_000,
    incompletePhase: 'agent-boot',
  };

  const fastBoot: LaunchPhaseTimings = {
    phases: [{ phase: 'agent-boot', durationMs: 2_000, completed: true }],
    totalMs: 2_000,
  };

  it('deprioritizes grok-build in round-robin when its recent boot latency is unhealthy', async () => {
    const monitor = new AgentBootLatencyMonitor({ minSlowSamples: 2, now: () => 1_000 });
    // Two prior grok launches hung in agent-boot (the #1642 shape), fed through
    // the SAME record() API the launch service uses on every finalization.
    monitor.record('grok-build', hungBoot);
    monitor.record('grok-build', hungBoot);
    const { deps, registry } = threeAgentDeps(monitor);

    const result = await launchTask(deps, { prompt: 'rr', cwd: '/tmp', agentType: 'round-robin' });

    // Cursor 2 would normally pick grok-build; the unhealthy boot signal makes
    // the rotation choose a healthy agent instead of hanging until the cap.
    expect(result.task.agentType).toBe('claude-code');
    expect(registry.get('grok-build').launch).not.toHaveBeenCalled();
    expect(registry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('still selects grok-build at the same cursor when its recent boots are healthy (control)', async () => {
    const monitor = new AgentBootLatencyMonitor({ minSlowSamples: 2, now: () => 1_000 });
    // Genuinely-healthy samples (fast completed boots), not merely an empty
    // window — proves healthy boot latency does NOT deprioritize.
    monitor.record('grok-build', fastBoot);
    monitor.record('grok-build', fastBoot);
    const { deps, registry } = threeAgentDeps(monitor);

    const result = await launchTask(deps, { prompt: 'rr', cwd: '/tmp', agentType: 'round-robin' });

    // No unhealthy signal → the deprioritization changes nothing: cursor 2 → grok.
    expect(result.task.agentType).toBe('grok-build');
    expect(registry.get('grok-build').launch).toHaveBeenCalledOnce();
  });

  it('feeds each finalized launch back into the boot-reliability monitor', async () => {
    // A grok adapter whose launch emits the agent-boot phase then hangs, so the
    // launch-service failure path records a real hung boot-latency sample.
    const monitor = new AgentBootLatencyMonitor({ minSlowSamples: 2, now: () => 1_000 });
    const { deps, registry } = threeAgentDeps(monitor);
    const grok = registry.get('grok-build');
    grok.launch = vi.fn(async (_id, _prompt, _cwd, _resume, opts) => {
      opts?.onPhase?.('session-create');
      opts?.onPhase?.('agent-boot');
      throw new Error('grok boot hang');
    }) as any;

    // Explicitly target grok twice so both launches feed a hung sample.
    for (let i = 0; i < 2; i += 1) {
      await expect(
        launchTask(deps, { prompt: `grok ${i}`, cwd: '/tmp', agentType: 'grok-build' }),
      ).rejects.toThrow('grok boot hang');
    }

    // The monitor now sees grok as unhealthy purely from the launch feed.
    expect(monitor.isUnhealthy('grok-build')).toBe(true);
    expect(monitor.deprioritizedTypes(['claude-code', 'codex-cli', 'grok-build'])).toEqual([
      'grok-build',
    ]);
  });

  it('routes a round-robin launch away from grok after real hung launches feed the monitor (end-to-end)', async () => {
    // The full production sequence with NO direct monitor.record() seeding:
    // hung grok launches feed the signal through launch-service, then a
    // round-robin launch at grok's cursor routes to a healthy agent instead.
    const monitor = new AgentBootLatencyMonitor({ minSlowSamples: 2, now: () => 1_000 });
    const { deps, registry } = threeAgentDeps(monitor);
    registry.get('grok-build').launch = vi.fn(async (_id, _prompt, _cwd, _resume, opts) => {
      opts?.onPhase?.('agent-boot');
      throw new Error('grok boot hang');
    }) as any;

    for (let i = 0; i < 2; i += 1) {
      await expect(
        launchTask(deps, { prompt: `grok ${i}`, cwd: '/tmp', agentType: 'grok-build' }),
      ).rejects.toThrow('grok boot hang');
    }
    // Cursor 2 would pick grok; the fed-back hung boots now deprioritize it.
    const result = await launchTask(deps, { prompt: 'rr', cwd: '/tmp', agentType: 'round-robin' });

    expect(result.task.agentType).toBe('claude-code');
    expect(registry.get('claude-code').launch).toHaveBeenCalledOnce();
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

  it('retries a dependency-parked launch by replaying the same intent', async () => {
    const dependencyPreflightRunner = vi.fn().mockResolvedValue([{
      dependency: 'kb',
      status: 'failed',
      category: 'provider_api',
      summary: 'KB provider is unavailable',
      recommendedAction: 'Restore the KB provider.',
    } satisfies LaunchPreflightFinding]);
    const gatedDeps = {
      ...deps,
      dependencyPreflightRunner,
      launchDependencyAdmission: new LaunchDependencyAdmission(),
    };

    const first = await launchTask(gatedDeps, {
      prompt: 'retry me after KB recovers',
      cwd: '/tmp',
      dependencies: ['kb'],
      idempotencyKey: 'parked-retry',
    });
    const second = await launchTask(gatedDeps, {
      prompt: 'retry me after KB recovers',
      cwd: '/tmp',
      dependencies: ['kb'],
      idempotencyKey: 'parked-retry',
    });

    expect(first.parked).toBe(true);
    expect(second.parked).toBe(true);
    expect(second.idempotentReplay).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    expect(store.listTasks()).toHaveLength(1);
    expect(gatedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
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

  it('issue #1588: a launch failure disposes the task, and a same-key retry replays it (no sibling created)', async () => {
    const adapter = deps.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    await expect(
      launchTask(deps, { prompt: 'will fail then retry', cwd: '/tmp', idempotencyKey: 'k1' }),
    ).rejects.toThrow('boom');

    // The failed launch is NOT deleted (the old behaviour) — it stays queryable
    // with a disposition so the retry can return it instead of a duplicate.
    expect(store.listTasks()).toHaveLength(1);
    const [disposed] = store.listTasks();
    expect(disposed.status).toBe('terminated');
    expect(disposed.disposition?.reason).toBe('launch_error');

    // Retry with the SAME key replays the disposed task — no second launch, no
    // sibling task — the create-then-lose duplicate bug (#1550) is closed.
    const retry = await launchTask(deps, { prompt: 'will fail then retry', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.task.id).toBe(disposed.id);
    expect(retry.task.disposition?.reason).toBe('launch_error');
    expect(store.listTasks()).toHaveLength(1);
    expect(adapter.launch).toHaveBeenCalledTimes(1);
  });

  it('issue #1588: a launch TIMEOUT disposes the task with reason launch_timeout and a same-key retry replays it', async () => {
    const adapter = deps.adapterRegistry.get('claude-code');
    // A launch that never settles trips the hard launch timeout.
    (adapter.launch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string>(() => {}),
    );
    const timeoutDeps: LaunchServiceDeps = { ...deps, getLaunchTimeoutMs: () => 20 };

    await expect(
      launchTask(timeoutDeps, { prompt: 'hangs', cwd: '/tmp', idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(LaunchTimeoutError);

    const [disposed] = store.listTasks();
    expect(disposed.status).toBe('terminated');
    expect(disposed.disposition?.reason).toBe('launch_timeout');

    const retry = await launchTask(timeoutDeps, { prompt: 'hangs', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.task.id).toBe(disposed.id);
    expect(retry.task.disposition?.reason).toBe('launch_timeout');
    expect(store.listTasks()).toHaveLength(1);
    // The retry replayed — it did NOT re-invoke the adapter.
    expect(adapter.launch).toHaveBeenCalledTimes(1);
  });

  it('a keyed launch rejected BEFORE any task record (backpressure) releases the key — a same-key retry launches fresh, not a bogus replay', async () => {
    // maxActive=0 + maxPending=0 makes the pending-queue guard reject BEFORE
    // createTask, so no task record exists and disposedTaskId is undefined.
    // The wrapper must RELEASE (not finalize) the key — otherwise a retry would
    // replay a task that never existed. This guards the `else` branch that the
    // launch-failure disposition path (#1588) sits beside.
    const rejectDeps: LaunchServiceDeps = { ...deps, getMaxActiveTasks: () => 0, getMaxPendingTasks: () => 0 };
    let caught: unknown;
    try {
      await launchTask(rejectDeps, { prompt: 'rejected then retried', cwd: '/tmp', idempotencyKey: 'k1' });
    } catch (err) {
      caught = err;
    }
    expect(isPendingQueueFullError(caught)).toBe(true);
    expect(store.listTasks()).toHaveLength(0);

    // Retry with capacity restored: a fresh launch, never a replay of a
    // never-created task.
    const retry = await launchTask(deps, { prompt: 'rejected then retried', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(retry.idempotentReplay).toBeUndefined();
    expect(store.listTasks()).toHaveLength(1);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
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

  it('an expired idempotency entry still converges on the same active parked intent', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const ttlLedger = new IdempotencyLedger(ledgerDir, { ttlMs: 1000, now: () => nowMs });
    await ttlLedger.load();
    const admission = new LaunchDependencyAdmission();
    const parkedDeps: LaunchServiceDeps = {
      ...makeDeps(store),
      idempotencyLedger: ttlLedger,
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([{
        dependency: 'kb',
        status: 'failed',
        category: 'provider_api',
        summary: 'provider unavailable',
        recommendedAction: 'restore provider',
      }]),
    };

    const first = await launchTask(parkedDeps, {
      prompt: 'durable parked intent',
      cwd: '/tmp',
      dependencies: ['kb'],
      idempotencyKey: 'parked-key',
    });
    nowMs += 1001;
    const retry = await launchTask(parkedDeps, {
      prompt: 'durable parked intent',
      cwd: '/tmp',
      dependencies: ['kb'],
      idempotencyKey: 'parked-key',
    });

    expect(first).toMatchObject({ queued: true, parked: true });
    expect(retry).toMatchObject({
      task: { id: first.task.id },
      duplicate: true,
      queued: true,
      parked: true,
    });
    expect(store.listTasks()).toHaveLength(1);
    expect(parkedDeps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
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

  it('review item 1: a ledger persist failure after a successful launch does not fail the caller, and same-process retry still replays', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A kookrDir that was never created — atomicWriteFile fails (ENOENT:
      // parent dir missing) when finalize() tries to persist, simulating a
      // disk-full/permissions failure without mocking modules.
      const brokenLedger = new IdempotencyLedger(join(ledgerDir, 'does-not-exist-subdir'));
      await brokenLedger.load(); // tolerates the missing dir
      const brokenDeps: LaunchServiceDeps = { ...makeDeps(store), idempotencyLedger: brokenLedger };

      const result = await launchTask(brokenDeps, { prompt: 'disk full', cwd: '/tmp', idempotencyKey: 'k1' });
      // The caller gets the real, successfully-launched task — no thrown error.
      expect(result.idempotentReplay).toBeUndefined();
      expect(result.task.prompt).toBe('disk full');
      expect(store.listTasks()).toHaveLength(1); // the task really was created
      expect(errorSpy).toHaveBeenCalled(); // logged loudly

      // Same-process retry with the same key still replays (in-memory state
      // survived the failed persist) instead of creating a duplicate.
      const retry = await launchTask(brokenDeps, { prompt: 'disk full', cwd: '/tmp', idempotencyKey: 'k1' });
      expect(retry.idempotentReplay).toBe(true);
      expect(retry.task.id).toBe(result.task.id);
      expect(brokenDeps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('review item 2: a terminal task that never ran (queued then cancelled, zero sessions) is NOT replayed — retry launches fresh', async () => {
    // Force the very first launch straight into the "queued" (concurrency
    // cap reached) path so it gets a task record with zero sessions —
    // launchTaskCore's maxActive branch never calls adapter.launch.
    const queuedDeps: LaunchServiceDeps = { ...deps, getMaxActiveTasks: () => 0 };
    const queued = await launchTask(queuedDeps, { prompt: 'never launched', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(queued.queued).toBe(true);
    expect(queued.task.sessions).toHaveLength(0);

    // Simulate the hung-task reaper / a manual cancel reclaiming it before
    // promotion ever ran adapter.launch — pending -> cancelled is valid.
    store.cancelTask(queued.task.id);

    // Retry with the same key, now with capacity — must launch fresh rather
    // than replay a task that will never do the work being retried for.
    const retry = await launchTask(deps, { prompt: 'never launched', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(retry.idempotentReplay).toBeUndefined();
    expect(retry.task.id).not.toBe(queued.task.id);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('review item 2: a terminal task that DID run (has a session) is still replayed', async () => {
    const first = await launchTask(deps, { prompt: 'did real work', cwd: '/tmp', idempotencyKey: 'k1' });

    // The mock adapter in this test harness does not attach a session
    // itself, so simulate the agent having actually run and finished — same
    // pattern as launch-dedup-integration.test.ts. addSession auto-transitions
    // open/pending -> inProgress, so a separate startTask() is neither needed
    // nor valid here.
    store.addSession(first.task.id, {
      tmuxSession: 'kookr-ran',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    store.completeTask(first.task.id);

    const retry = await launchTask(deps, { prompt: 'did real work', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(retry.idempotentReplay).toBe(true);
    expect(retry.task.id).toBe(first.task.id);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce(); // no second launch
  });

  it('review item 3: replay of a still-pending (queued) task preserves queued:true', async () => {
    const queuedDeps: LaunchServiceDeps = { ...deps, getMaxActiveTasks: () => 0 };
    const first = await launchTask(queuedDeps, { prompt: 'stays queued', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(first.queued).toBe(true);
    expect(first.task.status).toBe('pending');

    const replay = await launchTask(queuedDeps, { prompt: 'stays queued', cwd: '/tmp', idempotencyKey: 'k1' });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.queued).toBe(true);
    expect(replay.task.id).toBe(first.task.id);
  });
});

describe('launchTask hard timeout (issue #1526 Phase C / #1528)', () => {
  it('a never-settling adapter launch rejects with LaunchTimeoutError and cleans up like a thrown launch', async () => {
    const taskStore = new TaskStore();
    const deps: LaunchServiceDeps = { ...makeDeps(taskStore), getLaunchTimeoutMs: () => 40 };
    const adapter = deps.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>(() => { /* never settles — the #1528 wedge */ }),
    );

    await expect(launchTask(deps, { prompt: 'wedged launch', cwd: '/tmp' }))
      .rejects.toBeInstanceOf(LaunchTimeoutError);

    // Issue #1588: the wedged launch is DISPOSED, not deleted — it stays
    // queryable with a launch_timeout disposition and is terminal, so it
    // releases its reservation and no longer holds a capacity slot.
    const tasks = taskStore.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('terminated');
    expect(tasks[0].disposition?.reason).toBe('launch_timeout');
    expect(taskStore.getActiveCount()).toBe(0);
  });

  it('the timeout error is distinguishable via the type guard and code', async () => {
    const taskStore = new TaskStore();
    const deps: LaunchServiceDeps = { ...makeDeps(taskStore), getLaunchTimeoutMs: () => 25 };
    const adapter = deps.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>(() => {}),
    );

    let caught: unknown;
    try {
      await launchTask(deps, { prompt: 'wedged launch', cwd: '/tmp' });
    } catch (err) {
      caught = err;
    }
    expect(isLaunchTimeoutError(caught)).toBe(true);
    expect((caught as LaunchTimeoutError).code).toBe('launch_timeout');
    expect((caught as LaunchTimeoutError).message).toContain('timed out');
  });

  it('late RESOLUTION after the timeout does not resurrect state and stops the orphaned session', async () => {
    const taskStore = new TaskStore();
    const deps: LaunchServiceDeps = { ...makeDeps(taskStore), getLaunchTimeoutMs: () => 30 };
    const adapter = deps.adapterRegistry.get('claude-code');
    let settleLate!: (sessionId: string) => void;
    (adapter.launch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>((resolve) => { settleLate = resolve; }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(launchTask(deps, { prompt: 'late resolver', cwd: '/tmp' }))
        .rejects.toBeInstanceOf(LaunchTimeoutError);
      // Issue #1588: disposed (terminated) rather than deleted.
      expect(taskStore.listTasks()).toHaveLength(1);
      expect(taskStore.listTasks()[0].disposition?.reason).toBe('launch_timeout');

      // The abandoned promise settles LATE with a real session id.
      settleLate('tmux-late-1');
      await vi.waitFor(() => {
        expect(adapter.stop).toHaveBeenCalledWith('tmux-late-1');
      });

      // The disposed record is unchanged (still terminal, still holds no slot)
      // and the orphaned late session was stopped, never resurrected into
      // launch state.
      expect(taskStore.listTasks()).toHaveLength(1);
      expect(taskStore.listTasks()[0].status).toBe('terminated');
      expect(taskStore.getActiveCount()).toBe(0);
      expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('settled LATE'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('late REJECTION after the timeout is swallowed (logged), never unhandled', async () => {
    const taskStore = new TaskStore();
    const deps: LaunchServiceDeps = { ...makeDeps(taskStore), getLaunchTimeoutMs: () => 30 };
    const adapter = deps.adapterRegistry.get('claude-code');
    let rejectLate!: (err: Error) => void;
    (adapter.launch as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<string>((_resolve, reject) => { rejectLate = reject; }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await expect(launchTask(deps, { prompt: 'late rejecter', cwd: '/tmp' }))
        .rejects.toBeInstanceOf(LaunchTimeoutError);

      rejectLate(new Error('Task not found: gone'));
      await vi.waitFor(() => {
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('rejected after timeout'))).toBe(true);
      });
      // Issue #1588: the timed-out task remains as a disposed terminal record.
      expect(taskStore.listTasks()).toHaveLength(1);
      expect(taskStore.listTasks()[0].disposition?.reason).toBe('launch_timeout');
      expect(adapter.stop).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('a launch that resolves within the timeout is untouched by the wrapper', async () => {
    const taskStore = new TaskStore();
    const deps: LaunchServiceDeps = { ...makeDeps(taskStore), getLaunchTimeoutMs: () => 5_000 };

    const result = await launchTask(deps, { prompt: 'fast launch', cwd: '/tmp' });
    expect(result.queued).toBe(false);
    expect(taskStore.getTask(result.task.id)).toBeDefined();
  });

  it('falls back to the default timeout when the getter returns a non-positive value', async () => {
    // Guard against a broken live getter disabling the bound entirely: the
    // race must still be armed (we only assert the launch succeeds and no
    // timer misfires with 0/NaN — a 0ms timeout would kill every launch).
    const taskStore = new TaskStore();
    const deps: LaunchServiceDeps = { ...makeDeps(taskStore), getLaunchTimeoutMs: () => 0 };
    const result = await launchTask(deps, { prompt: 'default bound', cwd: '/tmp' });
    expect(result.queued).toBe(false);
    expect(taskStore.getTask(result.task.id)).toBeDefined();
  });

  it('issue #1588: a late abandoned launch that tries to attach a session finds the task terminal — no phantom session', async () => {
    // Real adapters call taskStore.addSession(taskId, ...) internally before
    // resolving. Model that: fire the attach only when released, AFTER the
    // timeout has disposed+terminated the task. The terminal guard must refuse.
    const taskStore = new TaskStore();
    const deps: LaunchServiceDeps = { ...makeDeps(taskStore), getLaunchTimeoutMs: () => 30 };
    const adapter = deps.adapterRegistry.get('claude-code');
    let attachLate!: () => void;
    let attachThrew = false;
    (adapter.launch as ReturnType<typeof vi.fn>).mockImplementation(
      (taskId: string) => new Promise<string>((resolve, reject) => {
        attachLate = () => {
          try {
            taskStore.addSession(taskId, { tmuxSession: 'tmux-phantom', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date() });
            resolve('tmux-phantom'); // unreachable — the guard throws first
          } catch (err) {
            attachThrew = true;
            reject(err as Error); // real adapter propagates the attach failure
          }
        };
      }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(launchTask(deps, { prompt: 'wedged then late-attach', cwd: '/tmp' }))
        .rejects.toBeInstanceOf(LaunchTimeoutError);
      const [disposed] = taskStore.listTasks();
      expect(disposed.status).toBe('terminated');
      expect(disposed.disposition?.reason).toBe('launch_timeout');

      // The abandoned launch now tries to attach — refused by the terminal
      // guard, so the disposed record never gains a phantom session.
      attachLate();
      expect(attachThrew).toBe(true);
      expect(taskStore.getTask(disposed.id)!.sessions).toHaveLength(0);
      expect(taskStore.getTask(disposed.id)!.status).toBe('terminated');
      await vi.waitFor(() => {
        expect(warnSpy.mock.calls.some(([msg]) => String(msg).includes('rejected after timeout'))).toBe(true);
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('issue #1588: a post-attach audit-log failure does NOT dispose a launch that already attached a session', async () => {
    // The launch succeeds (a session attaches, agent is live), but the
    // best-effort audit append then fails. The task must stay live — never
    // disposed/terminated on a bookkeeping fault.
    const taskStore = new TaskStore();
    const base = makeDeps(taskStore);
    const adapter = base.adapterRegistry.get('claude-code');
    (adapter.launch as ReturnType<typeof vi.fn>).mockImplementation(async (taskId: string) => {
      taskStore.addSession(taskId, { tmuxSession: 'tmux-live', agentType: 'claude-code', cwd: '/tmp', createdAt: new Date() });
      return 'tmux-live';
    });
    const deps: LaunchServiceDeps = {
      ...base,
      bypassAllPermissions: true,
      interactionLog: { append: vi.fn().mockRejectedValue(new Error('audit disk full')) } as never,
      // This adapter actually attaches a session, so registerNewAgent runs its
      // per-session path — give the hookWatcher mock the isWatching probe.
      lifecycleDeps: {
        ...base.lifecycleDeps,
        hookWatcher: { watch: vi.fn(), isWatching: vi.fn().mockReturnValue(false) },
      } as never,
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await launchTask(deps, { prompt: 'live then log fails', cwd: '/tmp' });
      const stored = taskStore.getTask(result.task.id)!;
      expect(stored.status).toBe('inProgress'); // live, not disposed
      expect(stored.disposition).toBeUndefined();
      expect(stored.sessions).toHaveLength(1);
      expect(errSpy).toHaveBeenCalled(); // audit failure logged best-effort
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('server-side backpressure (issue #1526 Phase C / C3)', () => {
  describe('pending-queue depth limit', () => {
    /** Queue `pendingCount` tasks through the normal at-capacity pend path. */
    async function fillQueue(deps: LaunchServiceDeps, pendingCount: number) {
      for (let i = 0; i < pendingCount; i++) {
        const result = await launchTask(deps, { prompt: `queued ${i}`, cwd: '/tmp' });
        expect(result.queued).toBe(true);
      }
    }

    function backpressureDeps(store: TaskStore, maxPending: number): LaunchServiceDeps {
      return {
        ...makeDeps(store),
        getMaxActiveTasks: () => 1,
        getMaxPendingTasks: () => maxPending,
      };
    }

    it('rejects with PendingQueueFullError carrying the capacity ledger when at cap with a full queue', async () => {
      const store = new TaskStore();
      const deps = backpressureDeps(store, 2);
      // Occupy the only active slot.
      const first = store.createTask({ prompt: 'active', cwd: '/tmp' });
      store.startTask(first.id);
      await fillQueue(deps, 2);

      const before = store.listTasks().length;
      let thrown: unknown;
      try {
        await launchTask(deps, { prompt: 'one too many', cwd: '/tmp' });
      } catch (err) {
        thrown = err;
      }
      expect(isPendingQueueFullError(thrown)).toBe(true);
      const err = thrown as PendingQueueFullError;
      expect(err.code).toBe('pending_queue_full');
      expect(err.maxPendingTasks).toBe(2);
      expect(err.capacity.pendingQueueDepth).toBe(2);
      expect(err.capacity.active).toBe(1);
      expect(err.capacity.maxActiveTasks).toBe(1);
      expect(err.capacity.byClass).toBeDefined();
      // No task record was created for the rejected launch.
      expect(store.listTasks().length).toBe(before);
    });

    it('below the depth limit, an at-capacity launch still queues (unchanged behavior)', async () => {
      const store = new TaskStore();
      const deps = backpressureDeps(store, 3);
      const first = store.createTask({ prompt: 'active', cwd: '/tmp' });
      store.startTask(first.id);
      await fillQueue(deps, 2);
      const result = await launchTask(deps, { prompt: 'still fits', cwd: '/tmp' });
      expect(result.queued).toBe(true);
      expect(store.getTask(result.task.id)?.status).toBe('pending');
    });

    it('below capacity, a full queue does not block launches', async () => {
      const store = new TaskStore();
      const deps: LaunchServiceDeps = {
        ...makeDeps(store),
        getMaxActiveTasks: () => 5,
        getMaxPendingTasks: () => 1,
      };
      // Queue is "full" (1/1) but there is active headroom → launch proceeds.
      const queued = store.createTask({ prompt: 'queued', cwd: '/tmp' });
      store.pendTask(queued.id);
      const result = await launchTask(deps, { prompt: 'launches fine', cwd: '/tmp' });
      expect(result.queued).toBe(false);
    });

    it('uses the wired getCapacityLedger snapshot when provided', async () => {
      const store = new TaskStore();
      const ledger = {
        maxActiveTasks: 1,
        active: 1,
        free: 0,
        byClass: { working: 0, finishedAwaitingAck: 1, hungSuspect: 0, launching: 0 },
        effectiveWorking: 0,
        phantomActive: 1,
        pendingQueueDepth: 1,
        oldestPendingAgeMs: 1234,
        oldestFinishedAwaitingAckAgeMs: 5678,
      };
      const deps: LaunchServiceDeps = {
        ...makeDeps(store),
        getMaxActiveTasks: () => 1,
        getMaxPendingTasks: () => 1,
        getCapacityLedger: () => ledger,
      };
      const first = store.createTask({ prompt: 'active', cwd: '/tmp' });
      store.startTask(first.id);
      const queued = store.createTask({ prompt: 'queued', cwd: '/tmp' });
      store.pendTask(queued.id);

      await expect(launchTask(deps, { prompt: 'rejected', cwd: '/tmp' }))
        .rejects.toMatchObject({ code: 'pending_queue_full', capacity: ledger });
    });
  });

  describe('CPU-aware admission (issue #1630)', () => {
    function hostLoadDeps(
      store: TaskStore,
      threshold: number,
      sample: { load1m: number; cpuCount: number },
    ): LaunchServiceDeps {
      return {
        ...makeDeps(store),
        getMaxHostLoadPerCpu: () => threshold,
        getHostLoadSample: () => sample,
      };
    }

    it('rejects with HostLoadAdmissionError when load-per-core exceeds the threshold, before any task record', async () => {
      const store = new TaskStore();
      // 4 cores, load 8 -> 2.0 per core, threshold 0.9.
      const deps = hostLoadDeps(store, 0.9, { load1m: 8, cpuCount: 4 });
      const before = store.listTasks().length;
      let thrown: unknown;
      try {
        await launchTask(deps, { prompt: 'too hot', cwd: '/tmp' });
      } catch (err) {
        thrown = err;
      }
      expect(isHostLoadAdmissionError(thrown)).toBe(true);
      const err = thrown as HostLoadAdmissionError;
      expect(err.code).toBe('host_load_admission');
      expect(err.loadPerCpu).toBeCloseTo(2, 5);
      expect(err.maxLoadPerCpu).toBe(0.9);
      expect(err.capacity).toBeDefined();
      // A rejected launch must leave no task record behind.
      expect(store.listTasks().length).toBe(before);
    });

    it('admits when load-per-core is below the threshold', async () => {
      const store = new TaskStore();
      const deps = hostLoadDeps(store, 0.9, { load1m: 2, cpuCount: 24 });
      const result = await launchTask(deps, { prompt: 'plenty of headroom', cwd: '/tmp' });
      expect(result.queued).toBe(false);
      expect(store.getTask(result.task.id)).toBeDefined();
    });

    it('does not gate when disabled (threshold 0), even under extreme load', async () => {
      const store = new TaskStore();
      const deps = hostLoadDeps(store, 0, { load1m: 999, cpuCount: 1 });
      const result = await launchTask(deps, { prompt: 'gate off', cwd: '/tmp' });
      expect(result.queued).toBe(false);
    });

    it('exempts schedule-fired launches from the host-load gate', async () => {
      const store = new TaskStore();
      const deps = hostLoadDeps(store, 0.9, { load1m: 999, cpuCount: 1 });
      const result = await launchTask(deps, {
        prompt: 'scheduled',
        cwd: '/tmp',
        launchSource: 'schedule',
      });
      expect(result.queued).toBe(false);
    });

    it('fires below active capacity — host saturation is task-count-independent', async () => {
      const store = new TaskStore();
      const deps: LaunchServiceDeps = {
        ...hostLoadDeps(store, 0.9, { load1m: 8, cpuCount: 4 }),
        // Plenty of active headroom, no active tasks — but the host is saturated.
        getMaxActiveTasks: () => 10,
      };
      await expect(launchTask(deps, { prompt: 'saturated but idle queue', cwd: '/tmp' }))
        .rejects.toMatchObject({ code: 'host_load_admission' });
    });

    it('is inert when only the threshold is set but no sampler is wired', async () => {
      const store = new TaskStore();
      const deps: LaunchServiceDeps = {
        ...makeDeps(store),
        getMaxHostLoadPerCpu: () => 0.9,
        // getHostLoadSample intentionally absent.
      };
      const result = await launchTask(deps, { prompt: 'no sampler', cwd: '/tmp' });
      expect(result.queued).toBe(false);
    });
  });

  describe('live quota-headroom admission (issue #1894 / #1936)', () => {
    function quotaDeps(
      store: TaskStore,
      sample: { fiveHour: { utilization: number; resetsAt?: string } | null; sevenDay: { utilization: number; resetsAt?: string } | null } | null,
      extras: Partial<LaunchServiceDeps> = {},
    ): LaunchServiceDeps {
      return {
        ...makeDeps(store),
        getLiveQuotaHeadroom: vi.fn().mockResolvedValue(sample),
        ...extras,
      };
    }

    /** Claude-only registry so rotation has no healthy alternate. */
    function claudeOnlyDeps(
      store: TaskStore,
      sample: { fiveHour: { utilization: number; resetsAt?: string } | null; sevenDay: { utilization: number; resetsAt?: string } | null } | null,
      extras: Partial<LaunchServiceDeps> = {},
    ): LaunchServiceDeps {
      const base = makeDeps(store);
      const solo = new AdapterRegistry();
      solo.register(base.adapterRegistry.get('claude-code') as any);
      return {
        ...base,
        adapterRegistry: solo,
        getLiveQuotaHeadroom: vi.fn().mockResolvedValue(sample),
        ...extras,
      };
    }

    it('rotates to a healthy alternate when plan quota is exhausted (issue #1936)', async () => {
      const store = new TaskStore();
      const sample = {
        fiveHour: { utilization: 100, resetsAt: '2026-08-04T12:00:00.000Z' },
        sevenDay: { utilization: 40, resetsAt: '2026-08-09T00:00:00Z' },
      };
      const deps = quotaDeps(store, sample);
      const result = await launchTask(deps, {
        prompt: 'rotate off exhausted plan',
        cwd: '/tmp',
        agentType: 'claude-code',
      });
      expect(result.queued).toBe(false);
      expect(result.task.agentType).toBe('codex-cli');
      expect(result.admission).toBe('rotated');
      expect(result.reason).toBe('plan_quota');
      expect(result.fromAgent).toBe('claude-code');
      expect(result.toAgent).toBe('codex-cli');
      expect(result.maxUtilization).toBe(100);
      expect(result.threshold).toBe(90);
      expect(result.resetsAt).toBe('2026-08-04T12:00:00.000Z');
      expect(store.getTask(result.task.id)?.agentType).toBe('codex-cli');
      expect(deps.getLiveQuotaHeadroom).toHaveBeenCalledTimes(1);
      expect(result.agentSubstitutionChain).toEqual([
        { reason: 'quota_rotate', from: 'claude-code', to: 'codex-cli' },
      ]);
      expect(store.getTask(result.task.id)?.metadata?.agentSubstitutionChain).toEqual([
        { reason: 'quota_rotate', from: 'claude-code', to: 'codex-cli' },
      ]);
    });

    it('does not rotate onto disallowed codex-cli when policy denies it (issue #2001)', async () => {
      const store = new TaskStore();
      const sample = {
        fiveHour: { utilization: 100, resetsAt: '2026-08-04T12:00:00.000Z' },
        sevenDay: null,
      };
      const deps = quotaDeps(store, sample, {
        getAgentFallbackPolicy: () => ({ disallow: ['codex-cli'] }),
      });
      const before = store.listTasks().length;
      await expect(
        launchTask(deps, {
          prompt: 'no silent codex landing',
          cwd: '/tmp',
          agentType: 'claude-code',
        }),
      ).rejects.toMatchObject({ code: 'quota_headroom_admission', admission: 'rejected' });
      expect(store.listTasks().length).toBe(before);
    });

    it('appends quota_rotate onto prior schedule_sub hops (issue #2001)', async () => {
      const store = new TaskStore();
      const sample = {
        fiveHour: { utilization: 100, resetsAt: '2026-08-04T12:00:00.000Z' },
        sevenDay: null,
      };
      const deps = quotaDeps(store, sample);
      const result = await launchTask(deps, {
        prompt: 'full chain',
        cwd: '/tmp',
        agentType: 'claude-code',
        priorAgentSubstitutions: [
          { reason: 'schedule_sub', from: 'grok-build', to: 'claude-code' },
        ],
      });
      expect(result.task.agentType).toBe('codex-cli');
      expect(result.agentSubstitutionChain).toEqual([
        { reason: 'schedule_sub', from: 'grok-build', to: 'claude-code' },
        { reason: 'quota_rotate', from: 'claude-code', to: 'codex-cli' },
      ]);
      expect(store.getTask(result.task.id)?.metadata?.agentSubstitutionChain).toEqual(
        result.agentSubstitutionChain,
      );
    });

    it('denies a claude-code launch when plan quota is exhausted and no alternate exists, before any task record', async () => {
      const store = new TaskStore();
      const sample = {
        fiveHour: { utilization: 97, resetsAt: '2026-08-02T18:00:00Z' },
        sevenDay: { utilization: 40, resetsAt: '2026-08-09T00:00:00Z' },
      };
      const deps = claudeOnlyDeps(store, sample);
      const before = store.listTasks().length;
      let thrown: unknown;
      try {
        await launchTask(deps, { prompt: 'no headroom', cwd: '/tmp', agentType: 'claude-code' });
      } catch (err) {
        thrown = err;
      }
      expect(isQuotaHeadroomAdmissionError(thrown)).toBe(true);
      const err = thrown as QuotaHeadroomAdmissionError;
      expect(err.code).toBe('quota_headroom_admission');
      expect(err.admission).toBe('rejected');
      expect(err.reason).toBe('plan_quota');
      expect(err.maxUtilization).toBe(97);
      expect(err.threshold).toBe(90);
      expect(err.resetsAt).toBe('2026-08-02T18:00:00Z');
      expect(err.capacity).toBeDefined();
      // Live getter must have been consulted (not a silent skip).
      expect(deps.getLiveQuotaHeadroom).toHaveBeenCalledTimes(1);
      // A rejected launch must leave no task record behind.
      expect(store.listTasks().length).toBe(before);
    });

    it('binding-window cache short-circuits further live polls (issue #1936)', async () => {
      const { PlanQuotaBindingCache } = await import('../core/plan-quota-binding-cache.js');
      const store = new TaskStore();
      const cache = new PlanQuotaBindingCache();
      const sample = {
        fiveHour: { utilization: 100, resetsAt: '2099-01-01T00:00:00.000Z' },
        sevenDay: null,
      };
      const getter = vi.fn().mockResolvedValue(sample);
      const deps: LaunchServiceDeps = {
        ...makeDeps(store),
        getLiveQuotaHeadroom: getter,
        planQuotaBindingCache: cache,
      };
      // First launch: live poll + rotate.
      const first = await launchTask(deps, {
        prompt: 'cache-warm-1',
        cwd: '/tmp',
        agentType: 'claude-code',
        disableDedup: true,
      });
      expect(first.admission).toBe('rotated');
      expect(getter).toHaveBeenCalledTimes(1);
      // Second launch: cache hit, no re-poll.
      const second = await launchTask(deps, {
        prompt: 'cache-warm-2',
        cwd: '/tmp',
        agentType: 'claude-code',
        disableDedup: true,
      });
      expect(second.admission).toBe('rotated');
      expect(second.task.agentType).toBe('codex-cli');
      expect(getter).toHaveBeenCalledTimes(1);
    });

    it('admits claude-code untouched when the gate is disabled (threshold 0, issue #2185)', async () => {
      const { PlanQuotaBindingCache } = await import('../core/plan-quota-binding-cache.js');
      const store = new TaskStore();
      const cache = new PlanQuotaBindingCache();
      // Cache already bound from a prior deny — a disabled gate must skip it too.
      cache.markExhausted({
        admit: false,
        maxUtilization: 100,
        threshold: 90,
        resetsAt: '2099-01-01T00:00:00.000Z',
      });
      const sample = {
        fiveHour: { utilization: 100, resetsAt: '2099-01-01T00:00:00.000Z' },
        sevenDay: null,
      };
      const deps = quotaDeps(store, sample, {
        planQuotaBindingCache: cache,
        getQuotaHeadroomThreshold: () => 0,
      });
      const result = await launchTask(deps, {
        prompt: 'gate disabled — spend the window',
        cwd: '/tmp',
        agentType: 'claude-code',
      });
      expect(result.queued).toBe(false);
      expect(result.task.agentType).toBe('claude-code');
      expect(store.getTask(result.task.id)?.agentType).toBe('claude-code');
      // Disabled gate never polls and never rotates.
      expect(deps.getLiveQuotaHeadroom).not.toHaveBeenCalled();
      expect(result.agentSubstitutionChain ?? []).toEqual([]);
    });

    it('raised threshold overrides a stale stricter binding-cache decision (issue #2185)', async () => {
      const { PlanQuotaBindingCache } = await import('../core/plan-quota-binding-cache.js');
      const store = new TaskStore();
      const cache = new PlanQuotaBindingCache();
      cache.markExhausted({
        admit: false,
        maxUtilization: 92,
        threshold: 90,
        resetsAt: '2099-01-01T00:00:00.000Z',
      });
      const sample = {
        fiveHour: { utilization: 92, resetsAt: '2099-01-01T00:00:00.000Z' },
        sevenDay: null,
      };
      const deps = quotaDeps(store, sample, {
        planQuotaBindingCache: cache,
        getQuotaHeadroomThreshold: () => 95,
      });
      const result = await launchTask(deps, {
        prompt: 'threshold raised mid-window',
        cwd: '/tmp',
        agentType: 'claude-code',
      });
      // Cached 92% < new threshold 95 ⇒ cache miss; live 92% < 95 ⇒ admit.
      expect(result.task.agentType).toBe('claude-code');
      expect(deps.getLiveQuotaHeadroom).toHaveBeenCalledTimes(1);
    });

    it('rotates at a lowered custom threshold (issue #2185)', async () => {
      const store = new TaskStore();
      const sample = {
        fiveHour: { utilization: 60, resetsAt: '2099-01-01T00:00:00.000Z' },
        sevenDay: null,
      };
      const deps = quotaDeps(store, sample, {
        getQuotaHeadroomThreshold: () => 50,
      });
      const result = await launchTask(deps, {
        prompt: 'strict operator threshold',
        cwd: '/tmp',
        agentType: 'claude-code',
      });
      expect(result.admission).toBe('rotated');
      expect(result.task.agentType).toBe('codex-cli');
      expect(result.threshold).toBe(50);
      expect(result.maxUtilization).toBe(60);
    });

    it('idempotency-key replay after plan-quota rotation does not double-create (issue #1936)', async () => {
      const { PlanQuotaBindingCache } = await import('../core/plan-quota-binding-cache.js');
      const store = new TaskStore();
      const ledgerDir = await mkdtemp(join(tmpdir(), 'kookr-quota-idemp-'));
      const ledger = new IdempotencyLedger(ledgerDir);
      await ledger.load();
      try {
        const deps = quotaDeps(
          store,
          {
            fiveHour: { utilization: 100, resetsAt: '2099-01-01T00:00:00.000Z' },
            sevenDay: null,
          },
          { idempotencyLedger: ledger, planQuotaBindingCache: new PlanQuotaBindingCache() },
        );
        const key = 'plan-quota-rotate-key-1';
        const first = await launchTask(deps, {
          prompt: 'idempotent after rotate',
          cwd: '/tmp',
          agentType: 'claude-code',
          idempotencyKey: key,
        });
        expect(first.admission).toBe('rotated');
        expect(first.task.agentType).toBe('codex-cli');
        expect(first.idempotentReplay).toBeFalsy();
        const before = store.listTasks().length;
        const second = await launchTask(deps, {
          prompt: 'idempotent after rotate',
          cwd: '/tmp',
          agentType: 'claude-code',
          idempotencyKey: key,
        });
        expect(second.idempotentReplay).toBe(true);
        expect(second.task.id).toBe(first.task.id);
        expect(store.listTasks().length).toBe(before);
      } finally {
        await rm(ledgerDir, { recursive: true, force: true });
      }
    });

    it('admits a claude-code launch when live headroom is available', async () => {
      const store = new TaskStore();
      const deps = quotaDeps(store, {
        fiveHour: { utilization: 40, resetsAt: '2026-08-02T18:00:00Z' },
        sevenDay: { utilization: 10 },
      });
      const result = await launchTask(deps, {
        prompt: 'plenty of quota',
        cwd: '/tmp',
        agentType: 'claude-code',
      });
      expect(result.queued).toBe(false);
      expect(result.admission).toBeUndefined();
      expect(store.getTask(result.task.id)).toBeDefined();
      expect(deps.getLiveQuotaHeadroom).toHaveBeenCalledTimes(1);
    });

    it('fails open when the live poll returns null (no stale-snapshot deny)', async () => {
      const store = new TaskStore();
      const deps = quotaDeps(store, null);
      const result = await launchTask(deps, {
        prompt: 'poll failed',
        cwd: '/tmp',
        agentType: 'claude-code',
      });
      expect(result.queued).toBe(false);
      expect(deps.getLiveQuotaHeadroom).toHaveBeenCalledTimes(1);
    });

    it('does not gate non-claude agents (QuotaAdapter is Anthropic-only)', async () => {
      const store = new TaskStore();
      const getter = vi.fn().mockResolvedValue({
        fiveHour: { utilization: 100 },
        sevenDay: null,
      });
      const deps: LaunchServiceDeps = {
        ...makeDeps(store),
        getLiveQuotaHeadroom: getter,
      };
      const result = await launchTask(deps, {
        prompt: 'codex path',
        cwd: '/tmp',
        agentType: 'codex-cli',
      });
      expect(result.queued).toBe(false);
      expect(getter).not.toHaveBeenCalled();
    });

    it('does not rotate remote-chat-telegram onto codex when R19 flag is off (issue #1936)', async () => {
      const store = new TaskStore();
      const prev = process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX;
      delete process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX;
      try {
        const deps = quotaDeps(store, {
          fiveHour: { utilization: 100, resetsAt: '2099-01-01T00:00:00.000Z' },
          sevenDay: null,
        });
        const before = store.listTasks().length;
        await expect(
          launchTask(deps, {
            prompt: 'telegram under plan exhaustion',
            cwd: '/tmp',
            agentType: 'claude-code',
            launchSource: 'remote-chat-telegram',
          }),
        ).rejects.toMatchObject({
          code: 'quota_headroom_admission',
          admission: 'rejected',
          reason: 'plan_quota',
        });
        expect(store.listTasks().length).toBe(before);
      } finally {
        if (prev === undefined) delete process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX;
        else process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX = prev;
      }
    });

    it('still applies plan-quota gate to schedule-fired claude-code launches (no schedule exemption)', async () => {
      const store = new TaskStore();
      // Claude-only so the gate must reject rather than rotate (schedule path
      // also benefits from #1936 rotation when an alternate is registered).
      const deps = claudeOnlyDeps(store, {
        fiveHour: { utilization: 95, resetsAt: 'later' },
        sevenDay: null,
      });
      await expect(
        launchTask(deps, {
          prompt: 'scheduled into empty quota',
          cwd: '/tmp',
          agentType: 'claude-code',
          launchSource: 'schedule',
        }),
      ).rejects.toMatchObject({ code: 'quota_headroom_admission', admission: 'rejected', reason: 'plan_quota' });
    });

    it('is inert when the live getter is not wired', async () => {
      const store = new TaskStore();
      const deps = makeDeps(store);
      const result = await launchTask(deps, {
        prompt: 'no getter',
        cwd: '/tmp',
        agentType: 'claude-code',
      });
      expect(result.queued).toBe(false);
    });
  });

  describe('per-source spawn burst budget', () => {
    function burstDeps(store: TaskStore, limit: number, windowMs = 10 * 60_000, now?: () => number): LaunchServiceDeps {
      return {
        ...makeDeps(store),
        spawnRateLimiter: new SpawnRateLimiter({
          getLimit: () => limit,
          getWindowMs: () => windowMs,
          ...(now ? { now } : {}),
        }),
      };
    }

    it('rejects an over-limit source with SpawnBurstLimitError (distinct code + ledger)', async () => {
      const store = new TaskStore();
      const deps = burstDeps(store, 2);
      await launchTask(deps, { prompt: 'a', cwd: '/tmp', launchSource: 'cli' });
      await launchTask(deps, { prompt: 'b', cwd: '/tmp', launchSource: 'cli' });

      let thrown: unknown;
      try {
        await launchTask(deps, { prompt: 'c', cwd: '/tmp', launchSource: 'cli' });
      } catch (err) {
        thrown = err;
      }
      expect(isSpawnBurstLimitError(thrown)).toBe(true);
      const err = thrown as SpawnBurstLimitError;
      expect(err.code).toBe('spawn_burst_limit');
      expect(err.source).toBe('cli');
      expect(err.limit).toBe(2);
      expect(err.retryAfterMs).toBeGreaterThan(0);
      expect(err.capacity.byClass).toBeDefined();
    });

    it('other sources are unaffected by one source bursting', async () => {
      const store = new TaskStore();
      const deps = burstDeps(store, 1);
      await launchTask(deps, { prompt: 'cli one', cwd: '/tmp', launchSource: 'cli' });
      await expect(launchTask(deps, { prompt: 'cli two', cwd: '/tmp', launchSource: 'cli' }))
        .rejects.toMatchObject({ code: 'spawn_burst_limit' });
      // api + websocket buckets still have budget.
      await expect(launchTask(deps, { prompt: 'api one', cwd: '/tmp', launchSource: 'api' }))
        .resolves.toMatchObject({ queued: false });
      await expect(launchTask(deps, { prompt: 'ws one', cwd: '/tmp', launchSource: 'websocket' }))
        .resolves.toMatchObject({ queued: false });
    });

    it('the window slides: the source recovers once its oldest launch ages out', async () => {
      const store = new TaskStore();
      let nowMs = 1_000_000;
      const deps = burstDeps(store, 1, 60_000, () => nowMs);
      await launchTask(deps, { prompt: 'first', cwd: '/tmp', launchSource: 'cli' });
      await expect(launchTask(deps, { prompt: 'second', cwd: '/tmp', launchSource: 'cli' }))
        .rejects.toMatchObject({ code: 'spawn_burst_limit' });
      nowMs += 60_001;
      await expect(launchTask(deps, { prompt: 'third', cwd: '/tmp', launchSource: 'cli' }))
        .resolves.toMatchObject({ queued: false });
    });

    it('schedule-fired launches are exempt from the budget', async () => {
      const store = new TaskStore();
      const deps = burstDeps(store, 1);
      for (let i = 0; i < 4; i++) {
        await expect(launchTask(deps, { prompt: `fire ${i}`, cwd: '/tmp', launchSource: 'schedule', disableDedup: true }))
          .resolves.toBeDefined();
      }
    });

    it('an actor-qualified caller has a bucket separate from the bare source', async () => {
      const store = new TaskStore();
      const deps = burstDeps(store, 1);
      await launchTask(deps, { prompt: 'anon', cwd: '/tmp', launchSource: 'api' });
      // Bare `api` is exhausted…
      await expect(launchTask(deps, { prompt: 'anon 2', cwd: '/tmp', launchSource: 'api' }))
        .rejects.toMatchObject({ code: 'spawn_burst_limit', source: 'api' });
      // …but lucy's attributed bucket is untouched, and vice versa.
      await expect(launchTask(deps, { prompt: 'lucy 1', cwd: '/tmp', launchSource: 'api', launchActorId: 'lucy' }))
        .resolves.toBeDefined();
      await expect(launchTask(deps, { prompt: 'lucy 2', cwd: '/tmp', launchSource: 'api', launchActorId: 'lucy' }))
        .rejects.toMatchObject({ code: 'spawn_burst_limit', source: 'api:actor:lucy' });
    });

    it('a dedup replay consumes no budget and is never rejected', async () => {
      const store = new TaskStore();
      const deps = burstDeps(store, 1);
      const first = await launchTask(deps, { prompt: 'same prompt', cwd: '/tmp', launchSource: 'cli' });
      store.startTask(first.task.id); // keep it active so dedup matches
      // Identical resubmission: dedup returns the existing task BEFORE the
      // budget check, so an exhausted bucket does not break retries.
      const replay = await launchTask(deps, { prompt: 'same prompt', cwd: '/tmp', launchSource: 'cli' });
      expect(replay.duplicate).toBe(true);
      expect(replay.task.id).toBe(first.task.id);
    });
  });

  describe('reserved self-maintenance slots (issue #1564)', () => {
    function reservedDeps(
      store: TaskStore,
      maxActive: number,
      reservedActiveSlots: number,
      reservedSlotSources: string[] = ['kookr'],
    ): LaunchServiceDeps {
      return {
        ...makeDeps(store),
        getMaxActiveTasks: () => maxActive,
        getReservedActiveSlots: () => reservedActiveSlots,
        getReservedSlotSources: () => reservedSlotSources,
      };
    }

    it('a lucy-source burst at its reduced cap cannot starve a kookr batch spawn', async () => {
      const store = new TaskStore();
      // 3 slots, 1 reserved for kookr → lucy is effectively capped at 2.
      const deps = reservedDeps(store, 3, 1);

      // Lucy saturates her allotment: two launches admitted…
      const lucy1 = await launchTask(deps, { prompt: 'lucy 1', cwd: '/tmp', launchSource: 'api', launchActorId: 'lucy' });
      const lucy2 = await launchTask(deps, { prompt: 'lucy 2', cwd: '/tmp', launchSource: 'api', launchActorId: 'lucy' });
      expect(lucy1.queued).toBe(false);
      expect(lucy2.queued).toBe(false);
      expect(store.getActiveCount()).toBe(2);

      // …and her third launch pends rather than consuming the reserved slot.
      const lucy3 = await launchTask(deps, { prompt: 'lucy 3', cwd: '/tmp', launchSource: 'api', launchActorId: 'lucy' });
      expect(lucy3.queued).toBe(true);
      expect(store.getActiveCount()).toBe(2);

      // The reserved slot is still available: a kookr batch spawn is admitted.
      const kookr = await launchTask(deps, { prompt: 'kookr batch', cwd: '/tmp', launchSource: 'api', launchActorId: 'kookr' });
      expect(kookr.queued).toBe(false);
      expect(store.getActiveCount()).toBe(3);
    });

    it('surfaces the reservation in the capacity ledger so the guarantee is observable', async () => {
      const store = new TaskStore();
      const deps = reservedDeps(store, 3, 1);
      await launchTask(deps, { prompt: 'lucy 1', cwd: '/tmp', launchSource: 'api', launchActorId: 'lucy' });
      await launchTask(deps, { prompt: 'lucy 2', cwd: '/tmp', launchSource: 'api', launchActorId: 'lucy' });

      // Same builder the /api/health ledger uses.
      const ledger = buildCapacityLedger(store.listTasks(), {
        now: Date.now(),
        maxActiveTasks: 3,
        isHungSuspect: () => false,
        isLaunching: (task) => store.hasFreshActiveLaunchReservation(task.id),
        reservedActiveSlots: 1,
        reservedSlotSources: ['kookr'],
      });
      expect(ledger.reservedActiveSlots).toBe(1);
      expect(ledger.reservedSlotSources).toEqual(['kookr']);
      expect(ledger.active).toBe(2);
      // A general source is out of headroom; a reserved source still has 1 slot.
      expect(ledger.freeForGeneralSources).toBe(0);
      expect(ledger.freeForReservedSources).toBe(1);
    });

    it('privileges by bare launch source too, not just the actor id', async () => {
      const store = new TaskStore();
      // Reserve for the `cli` source directly (no actor attribution needed).
      const deps = reservedDeps(store, 2, 1, ['cli']);
      await launchTask(deps, { prompt: 'api 1', cwd: '/tmp', launchSource: 'api' });
      // api is capped at 1 → its second launch pends.
      const api2 = await launchTask(deps, { prompt: 'api 2', cwd: '/tmp', launchSource: 'api' });
      expect(api2.queued).toBe(true);
      // …but a cli launch takes the reserved slot.
      const cli = await launchTask(deps, { prompt: 'cli 1', cwd: '/tmp', launchSource: 'cli' });
      expect(cli.queued).toBe(false);
    });

    it('with no reservation configured, behavior is unchanged (all sources share the full pool)', async () => {
      const store = new TaskStore();
      const deps: LaunchServiceDeps = { ...makeDeps(store), getMaxActiveTasks: () => 2, getReservedActiveSlots: () => 0 };
      const a = await launchTask(deps, { prompt: 'a', cwd: '/tmp', launchSource: 'api', launchActorId: 'lucy' });
      const b = await launchTask(deps, { prompt: 'b', cwd: '/tmp', launchSource: 'api', launchActorId: 'lucy' });
      expect(a.queued).toBe(false);
      expect(b.queued).toBe(false); // fills the full pool — reservation is off
      expect(store.getActiveCount()).toBe(2);
    });
  });

  describe('metadata.launchSource stamping', () => {
    it('stamps the launch source onto task metadata', async () => {
      const store = new TaskStore();
      const deps = makeDeps(store);
      const result = await launchTask(deps, { prompt: 'stamped', cwd: '/tmp', launchSource: 'schedule' });
      expect(store.getTask(result.task.id)?.metadata?.launchSource).toBe('schedule');
    });

    it('leaves metadata absent when no source is given', async () => {
      const store = new TaskStore();
      const deps = makeDeps(store);
      const result = await launchTask(deps, { prompt: 'unstamped', cwd: '/tmp' });
      expect(store.getTask(result.task.id)?.metadata).toBeUndefined();
    });
  });
});

describe('launchTask claimIssue (RFC PR 1b / #1230)', () => {
  let store: TaskStore;
  let deps: LaunchServiceDeps;
  let events: ClaimEvent[];

  function makePort(taskStore: TaskStore): ClaimTaskPort {
    return {
      activeTaskViews: () => taskStore.getAllTasks().map((t): ClaimTaskView => ({
        id: t.id,
        status: t.status,
        ...(t.name !== undefined ? { name: t.name } : {}),
        ...(t.issueClaim !== undefined ? { issueClaim: t.issueClaim } : {}),
      })),
      getTaskView: (taskId) => {
        const t = taskStore.getTask(taskId);
        if (!t) return undefined;
        return {
          id: t.id,
          status: t.status,
          ...(t.name !== undefined ? { name: t.name } : {}),
          ...(t.issueClaim !== undefined ? { issueClaim: t.issueClaim } : {}),
        };
      },
      setIssueClaim: (taskId, claim) => taskStore.setIssueClaim(taskId, claim),
      clearIssueClaim: (taskId) => taskStore.clearIssueClaim(taskId),
    };
  }

  beforeEach(() => {
    store = new TaskStore();
    events = [];
    const registry = new IssueClaimRegistry(makePort(store), (e) => events.push(e));
    deps = {
      ...makeDeps(store),
      issueClaimRegistry: registry,
      resolveClaimRepo: vi.fn(async () => ({ ok: true as const, repo: 'github.com/kookr-ai/kookr' })),
      flushTasks: vi.fn(async () => undefined),
    };
  });

  it('is a no-op when registry is not wired (flag off, R7)', async () => {
    const bare = makeDeps(store);
    const result = await launchTask(bare, {
      prompt: 'work on #1',
      cwd: '/tmp',
      claimIssue: { number: 1 },
    });
    expect(result.task.issueClaim).toBeUndefined();
    expect(bare.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('grants claim on create when free (CAS interleaved with createTask)', async () => {
    const result = await launchTask(deps, {
      prompt: 'work on #42',
      cwd: '/tmp',
      claimIssue: { number: 42 },
    });
    expect(result.task.issueClaim).toMatchObject({
      repo: 'github.com/kookr-ai/kookr',
      number: 42,
    });
    expect(events.map((e) => e.decision)).toContain('granted');
    expect(deps.flushTasks).toHaveBeenCalled();
    expect(deps.resolveClaimRepo).toHaveBeenCalledWith({ cwd: '/tmp' });
  });

  it('persists an ordinary claimed task before acknowledging a capacity wait', async () => {
    deps.getMaxActiveTasks = () => 0;
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    deps.flushTasks = vi.fn(async () => {
      markFlushStarted();
      await new Promise<void>((resolve) => { releaseFlush = resolve; });
    });

    let settled = false;
    const launch = launchTask(deps, {
      prompt: 'claimed task waiting for capacity',
      cwd: '/tmp',
      claimIssue: { number: 43 },
    });
    void launch.finally(() => { settled = true; });
    await flushStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFlush();
    const result = await launch;

    expect(result).toMatchObject({
      queued: true,
      task: { status: 'pending', issueClaim: { number: 43 } },
    });
    expect(deps.flushTasks).toHaveBeenCalledOnce();
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('releases the claim and disposes capacity-wait work when persistence fails', async () => {
    deps.getMaxActiveTasks = () => 0;
    deps.flushTasks = vi.fn().mockRejectedValue(new Error('claimed queue write failed'));

    await expect(launchTask(deps, {
      prompt: 'claimed capacity persistence failure',
      cwd: '/tmp',
      claimIssue: { number: 44 },
    })).rejects.toThrow('claimed queue write failed');

    expect(deps.issueClaimRegistry?.ownerRecord({
      repo: 'github.com/kookr-ai/kookr',
      number: 44,
    })).toBeNull();
    expect(store.listTasks()).toEqual([
      expect.objectContaining({
        status: 'cancelled',
        disposition: expect.objectContaining({ reason: 'launch_error' }),
      }),
    ]);
    expect(store.listTasks()[0]?.issueClaim).toBeUndefined();
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
  });

  it('does not dispose a successor that attaches after a claimed capacity fence expires', async () => {
    deps.getMaxActiveTasks = () => 0;
    let now = 11_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let rejectFlush!: (error: Error) => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    deps.flushTasks = vi.fn(async () => {
      markFlushStarted();
      await new Promise<void>((_resolve, reject) => { rejectFlush = reject; });
    });

    try {
      const launch = launchTask(deps, {
        prompt: 'claimed capacity successor',
        cwd: '/tmp',
        claimIssue: { number: 45 },
      });
      await flushStarted;
      const task = store.listTasks()[0]!;
      now += 10 * 60 * 1_000 + 1;
      const successorToken = store.beginLaunchWithToken(task.id);
      expect(successorToken).toBeDefined();
      store.addSession(task.id, {
        tmuxSession: 'kookr-capacity-successor',
        agentType: 'claude-code',
        cwd: '/tmp',
        createdAt: new Date(),
      });

      rejectFlush(new Error('stale claimed capacity write failed'));
      await expect(launch).rejects.toThrow('stale claimed capacity write failed');
      expect(store.getTask(task.id)).toMatchObject({
        status: 'inProgress',
        issueClaim: { number: 45 },
        sessions: [expect.objectContaining({ tmuxSession: 'kookr-capacity-successor' })],
      });
      expect(store.getTask(task.id)?.disposition).toBeUndefined();
      expect(deps.issueClaimRegistry?.ownerRecord({
        repo: 'github.com/kookr-ai/kookr',
        number: 45,
      })?.taskId).toBe(task.id);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('refuses with IssueClaimHeldError and creates no task when held', async () => {
    const owner = store.createTask({ prompt: 'owner', cwd: '/tmp' });
    store.startTask(owner.id);
    deps.issueClaimRegistry!.claim(
      { repo: 'github.com/kookr-ai/kookr', number: 99 },
      { taskId: owner.id },
    );
    events.length = 0;

    await expect(
      launchTask(deps, {
        prompt: 'challenger for #99',
        cwd: '/tmp',
        claimIssue: { number: 99 },
      }),
    ).rejects.toBeInstanceOf(IssueClaimHeldError);

    const nonOwner = store.listTasks().filter((t) => t.id !== owner.id);
    expect(nonOwner).toHaveLength(0);
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    expect(events.map((e) => e.decision)).not.toContain('granted');
  });

  it('releases the claim when adapter.launch fails (R5b)', async () => {
    vi.mocked(deps.adapterRegistry.get('claude-code').launch).mockRejectedValueOnce(
      new Error('spawn failed'),
    );
    await expect(
      launchTask(deps, {
        prompt: 'will fail launch',
        cwd: '/tmp',
        claimIssue: { number: 7 },
      }),
    ).rejects.toThrow(/spawn failed/);

    // Map must be free again — a second claim by a new task succeeds.
    const second = await launchTask(deps, {
      prompt: 'retry after failed launch',
      cwd: '/tmp',
      claimIssue: { number: 7 },
    });
    expect(second.task.issueClaim?.number).toBe(7);
    expect(events.map((e) => e.decision)).toContain('released');
  });

  it('isIssueClaimHeldError type guard works', () => {
    const err = new IssueClaimHeldError({
      repo: 'github.com/a/b',
      number: 1,
      taskId: 't1',
      ownerStatus: 'inProgress',
      claimedAt: new Date().toISOString(),
    });
    expect(isIssueClaimHeldError(err)).toBe(true);
    expect(isIssueClaimHeldError(new Error('x'))).toBe(false);
  });

  // Keep isTerminalStatus referenced so unused-import lint stays quiet if
  // tree-shaken in some configs (used conceptually by the registry port).
  it('port filters terminal owners via isTerminalStatus', () => {
    expect(isTerminalStatus('completed')).toBe(true);
  });
});

describe('launchTask relaunch arbiter + hard lease gate (issue #1711)', () => {
  let store: TaskStore;
  let deps: LaunchServiceDeps;
  let arbiter: RelaunchArbiter;
  let now: number;
  let events: ClaimEvent[];

  function makePort(taskStore: TaskStore): ClaimTaskPort {
    return {
      activeTaskViews: () => taskStore.getAllTasks().map((t): ClaimTaskView => ({
        id: t.id,
        status: t.status,
        ...(t.name !== undefined ? { name: t.name } : {}),
        ...(t.issueClaim !== undefined ? { issueClaim: t.issueClaim } : {}),
      })),
      getTaskView: (taskId) => {
        const t = taskStore.getTask(taskId);
        if (!t) return undefined;
        return {
          id: t.id,
          status: t.status,
          ...(t.name !== undefined ? { name: t.name } : {}),
          ...(t.issueClaim !== undefined ? { issueClaim: t.issueClaim } : {}),
        };
      },
      setIssueClaim: (taskId, claim) => taskStore.setIssueClaim(taskId, claim),
      clearIssueClaim: (taskId) => taskStore.clearIssueClaim(taskId),
    };
  }

  beforeEach(() => {
    store = new TaskStore();
    events = [];
    now = 2_000_000;
    arbiter = new RelaunchArbiter({
      backoffMs: 30_000,
      now: () => now,
      isHolderLive: (id) => {
        const t = store.getTask(id);
        return t !== undefined && !isTerminalStatus(t.status);
      },
    });
    const registry = new IssueClaimRegistry(makePort(store), (e) => events.push(e));
    deps = {
      ...makeDeps(store),
      issueClaimRegistry: registry,
      relaunchArbiter: arbiter,
      resolveClaimRepo: vi.fn(async () => ({ ok: true as const, repo: 'github.com/kookr-ai/kookr' })),
      flushTasks: vi.fn(async () => undefined),
    };
  });

  it('admits a claimIssue launch when the relaunch lease is free and holds both leases', async () => {
    const result = await launchTask(deps, {
      prompt: 'work on #1711',
      cwd: '/tmp',
      claimIssue: { number: 1711 },
    });
    expect(result.task.issueClaim?.number).toBe(1711);
    expect(arbiter.isHeld({ repo: 'github.com/kookr-ai/kookr', number: 1711 })).toBe(true);
    expect(arbiter.getLease({ repo: 'github.com/kookr-ai/kookr', number: 1711 })?.holderId).toBe(
      result.task.id,
    );
  });

  it('mutual exclusion: second concurrent claimIssue launch is denied (no task created)', async () => {
    const first = await launchTask(deps, {
      prompt: 'actuator-1 on #1711',
      cwd: '/tmp',
      claimIssue: { number: 1711 },
    });
    expect(first.duplicate).toBeFalsy();

    await expect(
      launchTask(deps, {
        prompt: 'actuator-2 on #1711 (different prompt so dedup does not hit)',
        cwd: '/tmp',
        claimIssue: { number: 1711 },
      }),
    ).rejects.toBeInstanceOf(RelaunchDeniedError);

    const nonFirst = store.listTasks().filter((t) => t.id !== first.task.id);
    expect(nonFirst).toHaveLength(0);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledOnce();
  });

  it('rejects with RelaunchDeniedError during backoff after a failed launch releases the lease', async () => {
    vi.mocked(deps.adapterRegistry.get('claude-code').launch).mockRejectedValueOnce(
      new Error('spawn failed'),
    );
    await expect(
      launchTask(deps, {
        prompt: 'will fail then backoff',
        cwd: '/tmp',
        claimIssue: { number: 42 },
      }),
    ).rejects.toThrow(/spawn failed/);

    // Immediate re-dispatch must not race the same issue (backoff window).
    await expect(
      launchTask(deps, {
        prompt: 'retry during backoff',
        cwd: '/tmp',
        claimIssue: { number: 42 },
      }),
    ).rejects.toMatchObject({ code: 'relaunch_denied', reason: 'backoff' });

    // After the window, relaunch is admitted again.
    now += 30_000;
    const retry = await launchTask(deps, {
      prompt: 'retry after backoff',
      cwd: '/tmp',
      claimIssue: { number: 42 },
    });
    expect(retry.task.issueClaim?.number).toBe(42);
  });

  it('hard gate: claimIssue launch without a held issue-claim lease is rejected', async () => {
    // Registry that pretends the claim never stuck (ownerRecord always null
    // after claim "succeeds" would be impossible with the real registry; instead
    // simulate a missing registry while the arbiter is required — force the
    // post-CAS hard gate by using a registry whose claim is a no-op grant that
    // never appears in ownerRecord).
    const phantomRegistry: NonNullable<LaunchServiceDeps['issueClaimRegistry']> = {
      ownerRecord: () => null,
      claim: () => ({ ok: true, reentrant: false }),
      safeReleaseAllFor: () => [],
    };
    deps.issueClaimRegistry = phantomRegistry;

    await expect(
      launchTask(deps, {
        prompt: 'claimIssue but lease never held',
        cwd: '/tmp',
        claimIssue: { number: 7 },
      }),
    ).rejects.toBeInstanceOf(IssueClaimLeaseRequiredError);

    expect(store.listTasks()).toHaveLength(0);
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    // Arbiter must not leave a dangling hold after the hard-gate rejection.
    expect(arbiter.isHeld({ repo: 'github.com/kookr-ai/kookr', number: 7 })).toBe(false);
  });

  it('arbiter-only path: claimIssue still requires a held relaunch lease', async () => {
    const bare = makeDeps(store);
    const onlyArbiter = new RelaunchArbiter({ backoffMs: 10_000, now: () => now });
    const arbiterDeps: LaunchServiceDeps = {
      ...bare,
      relaunchArbiter: onlyArbiter,
      resolveClaimRepo: vi.fn(async () => ({ ok: true as const, repo: 'github.com/acme/r' })),
    };

    const ok = await launchTask(arbiterDeps, {
      prompt: 'arbiter-only claim',
      cwd: '/tmp',
      claimIssue: { number: 3 },
    });
    expect(onlyArbiter.getLease({ repo: 'github.com/acme/r', number: 3 })?.holderId).toBe(
      ok.task.id,
    );

    await expect(
      launchTask(arbiterDeps, {
        prompt: 'second actuator denied',
        cwd: '/tmp',
        claimIssue: { number: 3 },
      }),
    ).rejects.toBeInstanceOf(RelaunchDeniedError);
  });

  it('type guards for new #1711 errors', () => {
    const denied = new RelaunchDeniedError('backoff', { repo: 'r', number: 1 }, { retryAfterMs: 5 });
    const lease = new IssueClaimLeaseRequiredError({ repo: 'r', number: 1 });
    expect(isRelaunchDeniedError(denied)).toBe(true);
    expect(isRelaunchDeniedError(lease)).toBe(false);
    expect(isIssueClaimLeaseRequiredError(lease)).toBe(true);
    expect(isIssueClaimLeaseRequiredError(denied)).toBe(false);
    expect(denied.code).toBe('relaunch_denied');
    expect(lease.code).toBe('issue_claim_lease_required');
  });
});
