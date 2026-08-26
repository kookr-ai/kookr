import { describe, test, expect, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../core/tasks.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code-adapter.js';
import { reconcile } from './reconciliation.js';
import { recoverCrashedSessions } from './crash-recovery.js';
import { buildTaskLaunchIntent } from '../core/task-launch-intent.js';
import { LaunchDependencyAdmission } from '../core/launch-dependency-admission.js';

describe('Crash Recovery', () => {
  let taskStore: TaskStore;
  let terminal: FakeTerminalBackend;
  let adapter: ClaudeCodeAdapter;
  let adapterRegistry: AdapterRegistry;
  let tempDir: string;
  let hooksDir: string;
  let settingsDir: string;

  beforeEach(async () => {
    taskStore = new TaskStore();
    terminal = new FakeTerminalBackend();
    tempDir = await mkdtemp(join(tmpdir(), 'crash-recovery-'));
    hooksDir = join(tempDir, 'hooks');
    settingsDir = join(tempDir, 'settings');
    await mkdir(hooksDir, { recursive: true });
    await mkdir(settingsDir, { recursive: true });

    adapter = new ClaudeCodeAdapter(terminal, taskStore, {
      hooksDir,
      settingsDir,
      writeFile: (path, content) => writeFile(path, content, 'utf-8'),
    });
    adapterRegistry = new AdapterRegistry();
    adapterRegistry.register(adapter);
  });

  async function setupCrashedTask(
    prompt: string,
    cwd: string,
    sessionOverrides?: Record<string, unknown>,
  ) {
    // Ensure CWD exists
    await mkdir(cwd, { recursive: true });

    const task = taskStore.createTask(prompt, cwd);
    taskStore.addSession(task.id, {
      tmuxSession: `kookr-dead-${task.id.slice(0, 8)}`,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
      ...sessionOverrides,
    });
    return taskStore.getTask(task.id)!;
  }

  test('relaunches dead sessions after reconciliation', async () => {
    const cwd = join(tempDir, 'project');
    const task = await setupCrashedTask('Fix the bug', cwd);
    const deadSessionId = task.sessions[0].tmuxSession;

    // Reconcile marks the session completed and auto-transitions the task
    // to 'terminated' (rfc-task-loss-prevention D1).
    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.markedCompleted).toContain(deadSessionId);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');

    // Crash recovery relaunches
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].taskId).toBe(task.id);
    expect(result.relaunched[0].oldSessionId).toBe(deadSessionId);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    // Task should be reopened and back to inProgress (adapter.launch calls addSession)
    const updatedTask = taskStore.getTaskForMutation(task.id)!;
    expect(updatedTask.status).toBe('inProgress');
    expect(updatedTask.sessions).toHaveLength(2);

    // Old session marked as crash-recovered
    const oldSession = updatedTask.sessions.find((s) => s.tmuxSession === deadSessionId)!;
    expect(oldSession.crashRecovered).toBe(true);

    // New session has relaunch metadata
    const newSession = updatedTask.sessions.find((s) => s.tmuxSession !== deadSessionId)!;
    expect(newSession.relaunchCount).toBe(1);
    expect(newSession.lastRelaunchedAt).toBeGreaterThan(0);
  });

  test('replays the durable guarded prompt while retaining raw intent identity', async () => {
    const cwd = join(tempDir, 'guarded-prompt-recovery');
    const task = await setupCrashedTask('raw user request', cwd);
    const mutable = taskStore.getTaskForMutation(task.id)!;
    mutable.prompt = '[Kookr delivery guard]\nCreate a worktree before editing.\n\nraw user request';
    mutable.userPrompt = 'raw user request';
    mutable.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'raw user request',
      cwd,
    };
    const launch = vi.spyOn(adapter, 'launch');

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(launch).toHaveBeenCalledWith(
      task.id,
      mutable.prompt,
      cwd,
      undefined,
      expect.any(Object),
    );
    expect(taskStore.getTask(task.id)?.launchIntent?.prompt).toBe('raw user request');
  });

  test('fails closed and records a durable reason when persisted intent is missing', async () => {
    const cwd = join(tempDir, 'missing-intent');
    const task = await setupCrashedTask('Do not guess', cwd);
    const mutable = taskStore.getTaskForMutation(task.id)!;
    delete mutable.launchIntent;
    const deadSessionId = task.sessions[0].tmuxSession;

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped).toEqual([expect.objectContaining({
      taskId: task.id,
      sessionId: deadSessionId,
      reason: expect.stringContaining('no persisted launch intent'),
    })]);
    expect(taskStore.getTask(task.id)?.relaunchDisposition).toMatchObject({
      outcome: 'not_relaunched',
      source: 'crash-recovery',
      reason: 'missing_launch_intent',
      detail: expect.any(String),
    });
  });

  test('passes independent model and effort pins through restart recovery', async () => {
    const cwd = join(tempDir, 'pinned-recovery');
    const task = await setupCrashedTask('Keep both pins', cwd);
    const mutable = taskStore.getTaskForMutation(task.id)!;
    mutable.launchIntent = buildTaskLaunchIntent('claude-code', {
      model: 'claude-fable-5',
      effort: 'max',
    });
    const launchSpy = vi.spyOn(adapter, 'launch');

    const reconcileResult = await reconcile(taskStore, terminal);
    await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(launchSpy.mock.calls[0]?.[4]).toMatchObject({
      model: 'claude-fable-5',
      effort: 'max',
    });
  });

  test('reuses persisted replay fields while preserving the durable guarded prompt', async () => {
    const cwd = join(tempDir, 'project-intent');
    const task = await setupCrashedTask('Rendered prompt', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Original caller prompt',
      cwd,
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
      ralphVerdictEnv: true,
      dependencies: ['kb'],
    };
    const launch = vi.spyOn(adapter, 'launch');

    const reconcileResult = await reconcile(taskStore, terminal);
    await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(launch).toHaveBeenCalledWith(
      task.id,
      'Rendered prompt',
      cwd,
      undefined,
      expect.objectContaining({
        effort: 'max',
        model: 'claude-fable-5',
        extraEnv: {
          RALPH_VERDICT_FILE: expect.stringMatching(/\.ralph-verdict-/),
          RALPH_ITERATION: '0',
        },
      }),
    );
  });

  test('parks crash recovery when a required dependency is confirmed degraded', async () => {
    const cwd = join(tempDir, 'project-degraded');
    const task = await setupCrashedTask('Needs the provider', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Needs the provider',
      cwd,
      agentType: 'claude-code',
      dependencies: ['kb'],
    };
    const launch = vi.spyOn(adapter, 'launch');
    const admission = new LaunchDependencyAdmission();
    const flushTasks = vi.fn(async () => {
      expect(taskStore.getTask(task.id)?.launchAdmission).toMatchObject({
        status: 'parked',
        reason: 'dependency_degraded',
      });
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([{
        dependency: 'kb',
        status: 'failed',
        category: 'provider_api',
        summary: 'KB provider unavailable',
        recommendedAction: 'Restore the provider.',
      }]),
      flushTasks,
    });

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('dependency_degraded');
    expect(launch).not.toHaveBeenCalled();
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'pending',
      launchAdmission: {
        status: 'parked',
        reason: 'dependency_degraded',
      },
    });
    expect(flushTasks).toHaveBeenCalledOnce();
  });

  test('cancellation during recovery dependency preflight prevents stale re-parking', async () => {
    const cwd = join(tempDir, 'project-cancelled-preflight');
    const task = await setupCrashedTask('Cancel during provider check', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Cancel during provider check',
      cwd,
      dependencies: ['kb'],
    };
    const launch = vi.spyOn(adapter, 'launch');
    const admission = new LaunchDependencyAdmission();
    const reconcileResult = await reconcile(taskStore, terminal);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockImplementation(async () => {
        taskStore.cancelTask(task.id);
        return [{
          dependency: 'kb',
          status: 'failed',
          category: 'provider_api',
          summary: 'KB provider unavailable',
          recommendedAction: 'Restore the provider.',
        }];
      }),
    });

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe(
      'task changed state while recovery dependency admission was in flight',
    );
    expect(launch).not.toHaveBeenCalled();
    expect(taskStore.getTask(task.id)?.status).toBe('cancelled');
    expect(taskStore.getTask(task.id)?.launchAdmission).toBeUndefined();
  });

  test('cancellation during recovery preflight releases a newly claimed half-open probe', async () => {
    const cwd = join(tempDir, 'project-cancelled-half-open-preflight');
    const task = await setupCrashedTask('Cancel a recovery probe claim', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Cancel a recovery probe claim',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const reconcileResult = await reconcile(taskStore, terminal);

    await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockImplementation(async () => {
        taskStore.cancelTask(task.id);
        return [];
      }),
    });

    const nextProbe = admission.evaluate(['kb']);
    expect(nextProbe).toMatchObject({ admit: true, probe: { dependencies: ['kb'] } });
    if (nextProbe.admit) admission.releaseProbe(nextProbe.probe);
    expect(taskStore.getTask(task.id)?.status).toBe('cancelled');
    expect(taskStore.getTask(task.id)?.launchAdmission).toBeUndefined();
  });

  test('bounds a recovery launch and retains ownership until late creation settles', async () => {
    const cwd = join(tempDir, 'project-timeout');
    const task = await setupCrashedTask('Provider recovery timeout', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Provider recovery timeout',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{
      dependency: 'kb',
      category: 'provider_api',
      summary: 'provider unavailable',
    }]);
    const launch = vi.spyOn(adapter, 'launch').mockImplementation(
      () => new Promise<string>(() => {}),
    );

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      getLaunchTimeoutMs: () => 5,
    });

    expect(launch).toHaveBeenCalledOnce();
    expect(result.relaunched).toHaveLength(0);
    expect(result.failed).toEqual([expect.objectContaining({
      taskId: task.id,
      error: expect.stringContaining('timed out before session'),
    })]);
    expect(result.skipped).toHaveLength(0);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'inProgress',
      launchAdmission: { status: 'probing' },
    });
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  test('reaps a recovery probe that creates its session after the timeout', async () => {
    const cwd = join(tempDir, 'project-late-timeout-probe');
    const task = await setupCrashedTask('Late recovery probe', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Late recovery probe',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let reportLateSession!: () => void;
    let expectedSessionId: string | undefined;
    vi.spyOn(adapter, 'launch').mockImplementationOnce(async (_taskId, _prompt, _cwd, _resume, options) => {
      expectedSessionId = options?.tmuxName;
      reportLateSession = () => options?.onSessionCreated?.(expectedSessionId!);
      return new Promise<string>(() => undefined);
    });
    const stop = vi.spyOn(adapter, 'stop').mockResolvedValue(undefined);
    const reconcileResult = await reconcile(taskStore, terminal);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      getLaunchTimeoutMs: () => 5,
      flushTasks: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.failed).toEqual([expect.objectContaining({
      taskId: task.id,
      error: expect.stringContaining('timed out before session'),
    })]);
    expect(stop).not.toHaveBeenCalled();
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'inProgress',
      launchAdmission: { status: 'probing', sessionId: expectedSessionId },
    });

    reportLateSession();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stop).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith(expectedSessionId);
    expect(taskStore.getTask(task.id)).toMatchObject({
      launchAdmission: { status: 'probing', sessionId: expectedSessionId },
      sessions: expect.arrayContaining([expect.objectContaining({
        tmuxSession: expectedSessionId,
        lastStatus: 'aborted',
      })]),
    });
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  test('retains a timed-out recovery probe when physical cleanup rejects', async () => {
    const cwd = join(tempDir, 'project-timeout-cleanup-rejection');
    const task = await setupCrashedTask('Timed out probe cleanup rejection', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Timed out probe cleanup rejection',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let expectedSessionId: string | undefined;
    vi.spyOn(adapter, 'launch').mockImplementationOnce(async (_taskId, _prompt, _cwd, _resume, options) => {
      expectedSessionId = options?.tmuxName;
      options?.onSessionCreated?.(expectedSessionId!);
      return new Promise<string>(() => undefined);
    });
    vi.spyOn(adapter, 'stop').mockRejectedValue(new Error('timeout cleanup rejected'));
    const reconcileResult = await reconcile(taskStore, terminal);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    let result;
    try {
      result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
        launchDependencyAdmission: admission,
        dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
        getLaunchTimeoutMs: () => 5,
      });
    } finally {
      warnSpy.mockRestore();
    }

    expect(result.failed).toEqual([expect.objectContaining({
      taskId: task.id,
      error: expect.stringContaining('timeout cleanup rejected'),
    })]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'inProgress',
      launchAdmission: { status: 'probing', sessionId: expectedSessionId },
      sessions: expect.arrayContaining([expect.objectContaining({
        tmuxSession: expectedSessionId,
        lastStatus: undefined,
      })]),
    });
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    admission.observe(['kb'], []);
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  test('reaps an unattached ordinary healthy recovery launch that rejects', async () => {
    const cwd = join(tempDir, 'project-healthy-launch-failure');
    const task = await setupCrashedTask('Healthy dependency relaunch', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Healthy dependency relaunch',
      cwd,
      dependencies: ['kb'],
    };
    const stop = vi.spyOn(adapter, 'stop').mockResolvedValue();
    vi.spyOn(adapter, 'launch').mockImplementationOnce(async (_taskId, _prompt, _cwd, _resume, options) => {
      options?.onSessionCreated?.('ordinary-unattached-recovery');
      throw new Error('ordinary adapter failure');
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: new LaunchDependencyAdmission(),
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
    });

    expect(result.relaunched).toHaveLength(0);
    expect(result.failed).toEqual([expect.objectContaining({
      taskId: task.id,
      error: 'ordinary adapter failure',
    })]);
    expect(taskStore.getTask(task.id)?.launchAdmission).toBeUndefined();
    expect(taskStore.getTask(task.id)?.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tmuxSession: 'ordinary-unattached-recovery',
        lastStatus: 'aborted',
      }),
    ]));
    expect(stop).toHaveBeenCalledWith('ordinary-unattached-recovery');
  });

  test('persists probing and aborts a partial recovery session before re-parking', async () => {
    const cwd = join(tempDir, 'project-partial-probe');
    const task = await setupCrashedTask('Partial recovery probe', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Partial recovery probe',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const stop = vi.spyOn(adapter, 'stop').mockResolvedValue();
    let probePersisted = false;
    let expectedSessionId: string | undefined;
    const flushTasks = vi.fn(async () => {
      expect(taskStore.getTask(task.id)?.launchAdmission).toMatchObject({
        status: 'probing',
        sessionId: expect.stringMatching(/^kookr-/),
      });
      const launchAdmission = taskStore.getTask(task.id)?.launchAdmission;
      expectedSessionId = launchAdmission?.status === 'probing'
        ? launchAdmission.sessionId
        : undefined;
      probePersisted = true;
    });
    vi.spyOn(adapter, 'launch').mockImplementationOnce(async (taskId, _prompt, launchCwd, _resume, options) => {
      expect(probePersisted).toBe(true);
      expect(taskStore.getTask(taskId)?.launchAdmission).toMatchObject({ status: 'probing' });
      expect(options?.tmuxName).toBe(expectedSessionId);
      options?.onSessionCreated?.(expectedSessionId!);
      taskStore.addSession(taskId, {
        tmuxSession: expectedSessionId!,
        agentType: 'claude-code',
        cwd: launchCwd,
        createdAt: new Date(),
      });
      throw new Error('provider failed after recovery attach');
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      flushTasks,
    });

    expect(result.failed).toHaveLength(0);
    expect(result.skipped[0]?.reason).toContain('recovery probe failed and task was re-parked');
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'pending',
      launchAdmission: { status: 'parked', reason: 'dependency_degraded' },
      sessions: expect.arrayContaining([expect.objectContaining({
        tmuxSession: expectedSessionId,
        lastStatus: 'aborted',
      })]),
    });
    expect(stop).toHaveBeenCalledWith(expectedSessionId);
    expect(flushTasks).toHaveBeenCalledOnce();
  });

  test('keeps an exact recovery probe fence when session cleanup rejects', async () => {
    const cwd = join(tempDir, 'project-probe-cleanup-rejection');
    const task = await setupCrashedTask('Probe cleanup rejection', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Probe cleanup rejection',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let expectedSessionId: string | undefined;
    vi.spyOn(adapter, 'launch').mockImplementationOnce(async (_taskId, _prompt, _cwd, _resume, options) => {
      expectedSessionId = options?.tmuxName;
      options?.onSessionCreated?.(expectedSessionId!);
      throw new Error('probe launch rejected');
    });
    vi.spyOn(adapter, 'stop').mockRejectedValueOnce(new Error('probe cleanup rejected'));
    const reconcileResult = await reconcile(taskStore, terminal);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
    });

    expect(result.failed).toEqual([expect.objectContaining({
      taskId: task.id,
      error: expect.stringContaining('probe cleanup rejected'),
    })]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'inProgress',
      launchAdmission: {
        status: 'probing',
        sessionId: expectedSessionId,
      },
      sessions: expect.arrayContaining([expect.objectContaining({
        tmuxSession: expectedSessionId,
      })]),
    });
    expect(taskStore.getTask(task.id)?.sessions.find(
      (session) => session.tmuxSession === expectedSessionId,
    )?.lastStatus).toBeUndefined();
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  test('keeps a live recovered probe when post-attach persistence fails', async () => {
    const cwd = join(tempDir, 'project-live-post-attach-failure');
    const task = await setupCrashedTask('Live recovery post-attach failure', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Live recovery post-attach failure',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const flushTasks = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('post-attach recovery write failed'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reconcileResult = await reconcile(taskStore, terminal);

    let result;
    try {
      result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
        launchDependencyAdmission: admission,
        dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
        flushTasks,
      });
    } finally {
      errorSpy.mockRestore();
    }

    expect(result?.relaunched).toEqual([expect.objectContaining({ taskId: task.id })]);
    expect(result?.failed).toHaveLength(0);
    expect(flushTasks).toHaveBeenCalledTimes(2);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'inProgress',
      launchAdmission: undefined,
    });
    expect(admission.snapshot()[0]).toMatchObject({ state: 'healthy' });
  });

  test('reports a failed recovery and starts no adapter when a denied marker cannot be persisted', async () => {
    const cwd = join(tempDir, 'project-denied-marker-failure');
    const task = await setupCrashedTask('Denied marker failure', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Denied marker failure',
      cwd,
      dependencies: ['kb'],
    };
    const launch = vi.spyOn(adapter, 'launch');
    const reconcileResult = await reconcile(taskStore, terminal);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: new LaunchDependencyAdmission(),
      dependencyPreflightRunner: vi.fn().mockResolvedValue([{
        dependency: 'kb',
        category: 'provider_api',
        summary: 'provider unavailable',
      }]),
      flushTasks: vi.fn().mockRejectedValue(new Error('denied marker write failed')),
    });

    expect(launch).not.toHaveBeenCalled();
    expect(result.failed).toEqual([expect.objectContaining({
      taskId: task.id,
      error: expect.stringContaining('denied marker write failed'),
    })]);
    expect(result.skipped).toHaveLength(0);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'pending',
      launchAdmission: undefined,
    });
  });

  test('reports a failed recovery without degrading the provider when the probe barrier fails', async () => {
    const cwd = join(tempDir, 'project-probe-marker-failure');
    const task = await setupCrashedTask('Probe marker failure', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Probe marker failure',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const launch = vi.spyOn(adapter, 'launch');
    const reconcileResult = await reconcile(taskStore, terminal);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      flushTasks: vi.fn().mockRejectedValue(new Error('probe marker write failed')),
    });

    expect(launch).not.toHaveBeenCalled();
    expect(result.failed).toEqual([expect.objectContaining({
      taskId: task.id,
      error: expect.stringContaining('probe marker write failed'),
    })]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'pending',
      launchAdmission: undefined,
    });
    expect(admission.snapshot()[0]).toMatchObject({ state: 'half_open' });
  });

  test('does not recover a task cancelled while its probe marker is being persisted', async () => {
    const cwd = join(tempDir, 'project-cancel-during-probe-persistence');
    const task = await setupCrashedTask('Cancel during probe persistence', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Cancel during probe persistence',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const launch = vi.spyOn(adapter, 'launch');
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const reconcileResult = await reconcile(taskStore, terminal);

    const recovery = recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      flushTasks: vi.fn(async () => {
        markFlushStarted();
        await new Promise<void>((resolve) => { releaseFlush = resolve; });
      }),
    });
    await flushStarted;
    taskStore.cancelTask(task.id);
    releaseFlush();
    const result = await recovery;

    expect(launch).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([expect.objectContaining({
      taskId: task.id,
      reason: 'task changed state while its probe marker was persisted',
    })]);
    expect(taskStore.getTask(task.id)).toMatchObject({ status: 'cancelled', launchAdmission: undefined });
    expect(admission.snapshot()[0]).toMatchObject({ state: 'half_open' });
  });

  test('re-parks recovery when confirmed degradation invalidates its probe token', async () => {
    const cwd = join(tempDir, 'project-invalidated-probe');
    const task = await setupCrashedTask('Invalidate recovery probe', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Invalidate recovery probe',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const launch = vi.spyOn(adapter, 'launch');
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const reconcileResult = await reconcile(taskStore, terminal);

    const recovery = recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      flushTasks: vi.fn()
        .mockImplementationOnce(async () => {
          markFlushStarted();
          await new Promise<void>((resolve) => { releaseFlush = resolve; });
        })
        .mockResolvedValue(undefined),
    });
    await flushStarted;
    admission.observe(['kb'], [{
      dependency: 'kb',
      category: 'provider_api',
      summary: 'provider degraded during recovery barrier',
    }]);
    releaseFlush();
    const result = await recovery;

    expect(launch).not.toHaveBeenCalled();
    expect(result.skipped).toEqual([expect.objectContaining({
      taskId: task.id,
      reason: 'dependency probe ownership changed before adapter launch; task re-parked',
    })]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'pending',
      launchAdmission: { status: 'parked', reason: 'dependency_degraded' },
    });
    expect(admission.snapshot()[0]).toMatchObject({ state: 'degraded' });
  });

  test('rolls back a re-park marker when its second recovery persistence barrier fails', async () => {
    const cwd = join(tempDir, 'project-failed-invalidated-probe-persistence');
    const task = await setupCrashedTask('Failed invalidated recovery persistence', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Failed invalidated recovery persistence',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const launch = vi.spyOn(adapter, 'launch');
    let releaseFlush!: () => void;
    let markFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => { markFlushStarted = resolve; });
    const reconcileResult = await reconcile(taskStore, terminal);

    const recovery = recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
      flushTasks: vi.fn()
        .mockImplementationOnce(async () => {
          markFlushStarted();
          await new Promise<void>((resolve) => { releaseFlush = resolve; });
        })
        .mockRejectedValueOnce(new Error('recovery re-park write failed')),
    });
    await flushStarted;
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    releaseFlush();
    const result = await recovery;

    expect(launch).not.toHaveBeenCalled();
    expect(result.failed).toEqual([expect.objectContaining({
      taskId: task.id,
      error: expect.stringContaining('recovery re-park write failed'),
    })]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'pending',
      launchAdmission: undefined,
    });
    expect(admission.snapshot()[0]).toMatchObject({ state: 'degraded' });
  });

  test('does not roll back replacement ownership when a stale recovery barrier rejects', async () => {
    const cwd = join(tempDir, 'project-stale-recovery-owner');
    const task = await setupCrashedTask('Stale recovery owner', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Stale recovery owner',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const launch = vi.spyOn(adapter, 'launch');
    let now = 8_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let releaseFirst!: () => void;
    let rejectSecond!: (err: Error) => void;
    let markFirstStarted!: () => void;
    let markSecondStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const reconcileResult = await reconcile(taskStore, terminal);

    try {
      const recovery = recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
        launchDependencyAdmission: admission,
        dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
        flushTasks: vi.fn()
          .mockImplementationOnce(async () => {
            markFirstStarted();
            await new Promise<void>((resolve) => { releaseFirst = resolve; });
          })
          .mockImplementationOnce(async () => {
            markSecondStarted();
            await new Promise<void>((_resolve, reject) => { rejectSecond = reject; });
          }),
      });
      await firstStarted;
      admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
      releaseFirst();
      await secondStarted;
      const replacementMarker = taskStore.getTask(task.id)?.launchAdmission;
      now += 10 * 60 * 1_000 + 1;
      const replacementToken = taskStore.beginLaunchWithToken(task.id);
      expect(replacementToken).toBeDefined();

      rejectSecond(new Error('stale recovery re-park write failed'));
      const result = await recovery;
      expect(result.failed).toEqual([expect.objectContaining({
        taskId: task.id,
        error: expect.stringContaining('stale recovery re-park write failed'),
      })]);
      expect(taskStore.getTask(task.id)).toMatchObject({
        status: 'pending',
        launchAdmission: replacementMarker,
      });
      expect(taskStore.ownsLaunchReservation(task.id, replacementToken!)).toBe(true);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('reaps an unattached recovery session when its probe is cancelled before rejection', async () => {
    const cwd = join(tempDir, 'project-cancelled-probe');
    const task = await setupCrashedTask('Cancelled recovery probe', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Cancelled recovery probe',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    const stop = vi.spyOn(adapter, 'stop').mockResolvedValue();
    vi.spyOn(adapter, 'launch').mockImplementationOnce(async (taskId, _prompt, _launchCwd, _resume, options) => {
      options?.onSessionCreated?.('cancelled-probe-recovery');
      taskStore.cancelTask(taskId);
      throw new Error('adapter rejected after cancellation');
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
    });

    expect(result.failed).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('task became terminal while its recovery probe was in flight');
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'cancelled',
      launchAdmission: undefined,
      sessions: expect.arrayContaining([
        expect.objectContaining({ tmuxSession: task.sessions[0]?.tmuxSession }),
        expect.objectContaining({
          tmuxSession: 'cancelled-probe-recovery',
          lastStatus: 'aborted',
        }),
      ]),
    });
    expect(stop).toHaveBeenCalledWith('cancelled-probe-recovery');
    expect(admission.snapshot()[0]).toMatchObject({ state: 'half_open' });
  });

  test('terminal state during recovery-session cleanup wins before circuit degradation', async () => {
    const cwd = join(tempDir, 'project-cancelled-during-probe-cleanup');
    const task = await setupCrashedTask('Cancel while stopping recovery probe', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Cancel while stopping recovery probe',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let finishStop!: () => void;
    let markStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve; });
    vi.spyOn(adapter, 'stop').mockImplementationOnce(async () => {
      markStopStarted();
      await new Promise<void>((resolve) => { finishStop = resolve; });
    });
    vi.spyOn(adapter, 'launch').mockImplementationOnce(async (_taskId, _prompt, _cwd, _resume, options) => {
      options?.onSessionCreated?.('probe-cleanup-recovery');
      throw new Error('probe rejected before attachment');
    });
    const reconcileResult = await reconcile(taskStore, terminal);

    const recovery = recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
    });
    await stopStarted;
    taskStore.cancelTask(task.id);
    finishStop();
    const result = await recovery;

    expect(result.failed).toHaveLength(0);
    expect(result.skipped[0]?.reason).toBe('task became terminal while its recovery probe was in flight');
    expect(taskStore.getTask(task.id)?.status).toBe('cancelled');
    expect(taskStore.getTask(task.id)?.launchAdmission).toBeUndefined();
    expect(admission.snapshot()[0]).toMatchObject({ state: 'half_open' });
  });

  test('terminal cancellation retains a recovery probe fence when concurrent cleanup rejects', async () => {
    const cwd = join(tempDir, 'project-cancelled-rejecting-probe-cleanup');
    const task = await setupCrashedTask('Cancel while rejecting recovery cleanup', cwd);
    taskStore.getTaskForMutation(task.id)!.launchIntent = {
      ...buildTaskLaunchIntent('claude-code'),
      prompt: 'Cancel while rejecting recovery cleanup',
      cwd,
      dependencies: ['kb'],
    };
    const admission = new LaunchDependencyAdmission();
    admission.observe(['kb'], [{ dependency: 'kb', category: 'provider_api' }]);
    let rejectStop!: (error: Error) => void;
    let markStopStarted!: () => void;
    let expectedSessionId: string | undefined;
    const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve; });
    vi.spyOn(adapter, 'stop').mockImplementationOnce(async () => {
      markStopStarted();
      await new Promise<void>((_resolve, reject) => { rejectStop = reject; });
    });
    vi.spyOn(adapter, 'launch').mockImplementationOnce(async (_taskId, _prompt, _cwd, _resume, options) => {
      expectedSessionId = options?.tmuxName;
      options?.onSessionCreated?.(expectedSessionId!);
      throw new Error('probe rejected before attachment');
    });
    const reconcileResult = await reconcile(taskStore, terminal);

    const recovery = recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: admission,
      dependencyPreflightRunner: vi.fn().mockResolvedValue([]),
    });
    await stopStarted;
    taskStore.cancelTask(task.id);
    rejectStop(new Error('concurrent recovery cleanup rejected'));
    const result = await recovery;

    expect(result.failed).toEqual([expect.objectContaining({
      taskId: task.id,
      error: expect.stringContaining('concurrent recovery cleanup rejected'),
    })]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'cancelled',
      launchAdmission: {
        status: 'probing',
        sessionId: expectedSessionId,
      },
      sessions: expect.arrayContaining([expect.objectContaining({
        tmuxSession: expectedSessionId,
        lastStatus: undefined,
      })]),
    });
    expect(admission.evaluate(['kb'])).toMatchObject({
      admit: false,
      reason: 'half_open_probe_busy',
    });
  });

  test('does NOT relaunch a spawned task that finished its turn cleanly (#693)', async () => {
    // A self-continuation chain link (parentTaskId set) that ended on a clean
    // `completed_turn` is done, not crashed. reconcile auto-completes it; crash
    // recovery must leave it terminal rather than re-running it and re-spawning
    // its successor at startup.
    const cwd = join(tempDir, 'cycle-n');
    await mkdir(cwd, { recursive: true });
    const parent = taskStore.createTask('Cycle N-1', cwd);
    const child = taskStore.createTask({
      prompt: 'Cycle N: do work then spawn cycle N+1',
      cwd,
      parentTaskId: parent.id,
    });
    const deadSessionId = `kookr-clean-${child.id.slice(0, 8)}`;
    taskStore.addSession(child.id, {
      tmuxSession: deadSessionId,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
      lastTurnState: 'completed_turn',
    });

    // Reconcile auto-completes the clean-finished spawned task.
    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.markedCompleted).toContain(deadSessionId);
    expect(taskStore.getTask(child.id)!.status).toBe('completed');

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].taskId).toBe(child.id);
    expect(result.skipped[0].reason).toContain('finished its turn cleanly');
    // Stays terminal — not reopened/relaunched.
    expect(taskStore.getTask(child.id)!.status).toBe('completed');
    expect(taskStore.getTask(child.id)!.sessions).toHaveLength(1);
  });

  test('does NOT relaunch a task terminated for a non-recoverable reason (#1664)', async () => {
    // A deliberate kill (operator / supervisor sweep) must not auto-resume.
    const cwd = join(tempDir, 'manual-kill');
    const task = await setupCrashedTask('Long-running work', cwd);

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');

    // Simulate the termination having been classified as a deliberate kill.
    const mutable = taskStore.getTaskForMutation(task.id)!;
    mutable.terminationReason = 'manual';

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].taskId).toBe(task.id);
    expect(result.skipped[0].reason).toContain('non-recoverable termination');
    // Stays terminal — not reopened.
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
  });

  test('still relaunches a spawned task that crashed mid-turn (#693 guard is clean-finish-only)', async () => {
    // The clean-finish skip must not suppress genuine crash recovery: a spawned
    // task whose newest session died while still `running` is a crash and is
    // relaunched as before.
    const cwd = join(tempDir, 'cycle-crash');
    await mkdir(cwd, { recursive: true });
    const parent = taskStore.createTask('Cycle parent', cwd);
    const child = taskStore.createTask({
      prompt: 'Cycle that crashed mid-work',
      cwd,
      parentTaskId: parent.id,
    });
    const deadSessionId = `kookr-crashed-${child.id.slice(0, 8)}`;
    taskStore.addSession(child.id, {
      tmuxSession: deadSessionId,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
      lastTurnState: 'running',
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(taskStore.getTask(child.id)!.status).toBe('terminated');

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].taskId).toBe(child.id);
    expect(taskStore.getTask(child.id)!.status).toBe('inProgress');
  });

  test('skips when CWD does not exist', async () => {
    const cwd = join(tempDir, 'nonexistent-project');
    const task = await setupCrashedTask('Fix bug', cwd);
    // Don't create the CWD directory — but we need it for addSession above
    // So let's create then remove it
    await rm(cwd, { recursive: true });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('CWD does not exist');
    expect(result.relaunched).toHaveLength(0);
  });

  test('skips rapid crash-loop (recently relaunched)', async () => {
    const cwd = join(tempDir, 'project-loop');
    const task = await setupCrashedTask('Fix bug', cwd, {
      relaunchCount: 1,
      lastRelaunchedAt: Date.now() - 10_000, // 10 seconds ago — within 60s window
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('rapid crash-loop');
    expect(result.relaunched).toHaveLength(0);
  });

  test('allows recovery when lastRelaunchedAt is old (outside crash-loop window)', async () => {
    const cwd = join(tempDir, 'project-old-relaunch');
    const task = await setupCrashedTask('Fix bug', cwd, {
      relaunchCount: 3,
      lastRelaunchedAt: Date.now() - 120_000, // 2 minutes ago — outside 60s window
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);

    // Relaunch count should be incremented
    const updatedTask = taskStore.getTaskForMutation(task.id)!;
    const newSession = updatedTask.sessions.find((s) => s.relaunchCount === 4)!;
    expect(newSession).toBeDefined();
  });

  test('reopens auto-transitioned task before relaunch', async () => {
    const cwd = join(tempDir, 'project-reopen');
    const task = await setupCrashedTask('Build feature', cwd);

    // After reconcile, task is auto-transitioned to 'terminated' (all sessions dead)
    const reconcileResult = await reconcile(taskStore, terminal);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');

    // Crash recovery reopens and relaunches
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);
    expect(result.relaunched).toHaveLength(1);
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
  });

  test('handles adapter.launch() failure gracefully', async () => {
    const cwd = join(tempDir, 'project-fail');
    const task = await setupCrashedTask('Do work', cwd);

    const reconcileResult = await reconcile(taskStore, terminal);

    // Sabotage the terminal to make createSession throw
    vi.spyOn(terminal, 'createSession').mockRejectedValue(new Error('tmux broken'));

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toBe('tmux broken');
    expect(result.relaunched).toHaveLength(0);
  });

  test('handles multiple tasks with mixed outcomes', async () => {
    const cwd1 = join(tempDir, 'proj1');
    const cwd2 = join(tempDir, 'proj2');
    const cwd3 = join(tempDir, 'proj3-gone');

    const task1 = await setupCrashedTask('Task 1', cwd1);
    const task2 = await setupCrashedTask('Task 2', cwd2, {
      relaunchCount: 1,
      lastRelaunchedAt: Date.now() - 5_000, // crash loop
    });
    const task3 = await setupCrashedTask('Task 3', cwd3);
    await rm(cwd3, { recursive: true }); // CWD gone

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1); // task1
    expect(result.relaunched[0].taskId).toBe(task1.id);
    expect(result.skipped).toHaveLength(2); // task2 (crash-loop) + task3 (CWD gone)
    expect(result.failed).toHaveLength(0);
  });

  test('no-op when reconcile has no dead sessions', async () => {
    const cwd = join(tempDir, 'alive-project');
    await mkdir(cwd, { recursive: true });
    const task = taskStore.createTask('Running task', cwd);
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-alive',
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });
    await terminal.createSession({ id: 'kookr-alive', command: 'claude', args: [], env: {}, cwd });

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.markedCompleted).toHaveLength(0);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  test('new session is registered in tmux (via adapter.launch)', async () => {
    const cwd = join(tempDir, 'project-tmux');
    const task = await setupCrashedTask('Do work', cwd);

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    // The new session should exist as a live tmux session
    const newTmux = result.relaunched[0].newSessionId;
    expect(await terminal.isAlive(newTmux)).toBe(true);

    // And the terminal should have the claude command
    const fakeSession = terminal.sessions.get(newTmux)!;
    expect(fakeSession.spec.command).toContain('claude');
    expect(fakeSession.spec.cwd).toBe(cwd);
  });

  test('removes stale .git/index.lock before relaunch', async () => {
    const cwd = join(tempDir, 'project-gitlock');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const lockFile = join(cwd, '.git', 'index.lock');
    await writeFile(lockFile, 'stale lock');

    const task = await setupCrashedTask('Fix thing', cwd);

    const reconcileResult = await reconcile(taskStore, terminal);
    await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    // Lock file should have been removed
    await expect(access(lockFile)).rejects.toThrow();
  });

  test('skips task that already has a running session', async () => {
    const cwd = join(tempDir, 'project-live');
    await mkdir(cwd, { recursive: true });

    const task = taskStore.createTask('Fix the bug', cwd);

    // Add a live session (will be resumed by reconcile)
    const liveTmux = `kookr-live-${task.id.slice(0, 8)}`;
    taskStore.addSession(task.id, {
      tmuxSession: liveTmux,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });
    await terminal.createSession({ id: liveTmux, command: 'claude', args: [], env: {}, cwd });

    // Add a dead session (will be marked completed by reconcile)
    const deadTmux = `kookr-dead-${task.id.slice(0, 8)}`;
    taskStore.addSession(task.id, {
      tmuxSession: deadTmux,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.resumed).toContain(liveTmux);
    expect(reconcileResult.markedCompleted).toContain(deadTmux);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('task already has a running session');
    expect(result.relaunched).toHaveLength(0);
  });

  test('skips intra-pass duplicate when task has multiple dead sessions', async () => {
    const cwd = join(tempDir, 'project-multi-dead');
    await mkdir(cwd, { recursive: true });

    const task = taskStore.createTask('Fix the bug', cwd);

    // Add two dead sessions (both from previous crash cycles)
    const dead1 = `kookr-dead1-${task.id.slice(0, 8)}`;
    const dead2 = `kookr-dead2-${task.id.slice(0, 8)}`;
    taskStore.addSession(task.id, {
      tmuxSession: dead1,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });
    taskStore.addSession(task.id, {
      tmuxSession: dead2,
      agentType: 'claude-code',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.markedCompleted).toContain(dead1);
    expect(reconcileResult.markedCompleted).toContain(dead2);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    // Only one should be relaunched, the other skipped as intra-pass duplicate
    expect(result.relaunched).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('task already relaunched in this recovery pass');
  });

  test('skips duplicate prompt across different tasks', async () => {
    const cwd1 = join(tempDir, 'proj-dup1');
    const cwd2 = join(tempDir, 'proj-dup2');

    // Two different tasks with identical prompts
    const task1 = await setupCrashedTask('Identical prompt text', cwd1);
    const task2 = await setupCrashedTask('Identical prompt text', cwd2);

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    // First task gets relaunched, second is skipped as duplicate prompt
    expect(result.relaunched).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('duplicate prompt already running or relaunched');
  });

  test('allows different prompts to be relaunched independently', async () => {
    const cwd1 = join(tempDir, 'proj-diff1');
    const cwd2 = join(tempDir, 'proj-diff2');

    const task1 = await setupCrashedTask('Fix bug A', cwd1);
    const task2 = await setupCrashedTask('Fix bug B', cwd2);

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  test('skips task when identical prompt is already running in another task', async () => {
    const cwd1 = join(tempDir, 'proj-running');
    const cwd2 = join(tempDir, 'proj-dead');
    await mkdir(cwd1, { recursive: true });
    await mkdir(cwd2, { recursive: true });

    // Task 1 has a live session
    const task1 = taskStore.createTask('Same prompt', cwd1);
    const liveTmux = `kookr-live-${task1.id.slice(0, 8)}`;
    taskStore.addSession(task1.id, {
      tmuxSession: liveTmux,
      agentType: 'claude-code',
      cwd: cwd1,
      createdAt: new Date(),
      lastStatus: 'running',
    });
    await terminal.createSession({ id: liveTmux, command: 'claude', args: [], env: {}, cwd: cwd1 });

    // Task 2 has a dead session with the same prompt
    const task2 = await setupCrashedTask('Same prompt', cwd2);

    const reconcileResult = await reconcile(taskStore, terminal);
    expect(reconcileResult.resumed).toContain(liveTmux);

    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('duplicate prompt already running or relaunched');
  });

  test('consecutive crash simulation — recovery works after both crashes', async () => {
    const cwd = join(tempDir, 'project-multi-crash');
    const task = await setupCrashedTask('Long task', cwd);

    // === First crash + recovery ===
    const reconcile1 = await reconcile(taskStore, terminal);
    const recovery1 = await recoverCrashedSessions(taskStore, adapterRegistry, reconcile1);
    expect(recovery1.relaunched).toHaveLength(1);
    const newTmux1 = recovery1.relaunched[0].newSessionId;

    // Verify the new session is alive
    expect(await terminal.isAlive(newTmux1)).toBe(true);

    // === Simulate second crash (kill the relaunched session) ===
    await terminal.killSession(newTmux1);

    // Wait a bit to be outside the crash-loop window in the test
    // We can't actually wait 60s, so we'll manually set lastRelaunchedAt to the past
    const updatedTask = taskStore.getTaskForMutation(task.id)!;
    const newSession1 = updatedTask.sessions.find((s) => s.tmuxSession === newTmux1)!;
    newSession1.lastRelaunchedAt = Date.now() - 120_000; // simulate 2 minutes ago

    // === Second recovery ===
    const reconcile2 = await reconcile(taskStore, terminal);
    expect(reconcile2.markedCompleted).toContain(newTmux1);

    const recovery2 = await recoverCrashedSessions(taskStore, adapterRegistry, reconcile2);
    expect(recovery2.relaunched).toHaveLength(1);
    expect(recovery2.skipped).toHaveLength(0);

    // Third session exists and is alive
    const finalTask = taskStore.getTask(task.id)!;
    expect(finalTask.sessions).toHaveLength(3);
    expect(finalTask.status).toBe('inProgress');
    const newTmux2 = recovery2.relaunched[0].newSessionId;
    expect(await terminal.isAlive(newTmux2)).toBe(true);

    // Relaunch count incremented
    const newSession2 = finalTask.sessions.find((s) => s.tmuxSession === newTmux2)!;
    expect(newSession2.relaunchCount).toBe(2);
  });

  // === Resume-on-crash (rfc-crash-recovery-resume.md) ===

  test('resume mode: passes claudeSessionId + transcriptPath to adapter when both persisted', async () => {
    const cwd = join(tempDir, 'project-resume');
    const transcriptPath = join(tempDir, 'transcripts', 'session-abc.jsonl');
    await mkdir(join(tempDir, 'transcripts'), { recursive: true });
    await writeFile(transcriptPath, '{"type":"user","content":"hello"}\n', 'utf-8');

    const task = await setupCrashedTask('Refactor auth', cwd, {
      claudeSessionId: 'session-abc',
      transcriptPath,
    });

    // Spy on adapter.launch to capture the resume argument
    const launchSpy = vi.spyOn(adapter, 'launch');

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].mode).toBe('resumed');
    expect(result.relaunched[0].fallbackReason).toBeUndefined();

    // Adapter was called with the ResumeContext
    expect(launchSpy).toHaveBeenCalledTimes(1);
    const [calledTaskId, calledPrompt, calledCwd, calledResume] = launchSpy.mock.calls[0];
    expect(calledTaskId).toBe(task.id);
    expect(calledPrompt).toBe('Refactor auth');
    expect(calledCwd).toBe(cwd);
    expect(calledResume).toEqual({ sessionId: 'session-abc', transcriptPath });

    // New session is marked resumedFromCrash
    const updatedTask = taskStore.getTask(task.id)!;
    const newSession = updatedTask.sessions.find((s) => s.tmuxSession === result.relaunched[0].newSessionId)!;
    expect(newSession.resumedFromCrash).toBe(true);
  });

  test('fresh fallback: no claudeSessionId persisted (agent crashed before SessionStart)', async () => {
    const cwd = join(tempDir, 'project-no-session');
    const task = await setupCrashedTask('Fix the bug', cwd);
    // Note: no claudeSessionId, no transcriptPath set

    const launchSpy = vi.spyOn(adapter, 'launch');

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].mode).toBe('fresh');
    expect(result.relaunched[0].fallbackReason).toBe('no claudeSessionId persisted');

    // Adapter was called WITHOUT a ResumeContext
    expect(launchSpy.mock.calls[0][3]).toBeUndefined();

    const updatedTask = taskStore.getTask(task.id)!;
    const newSession = updatedTask.sessions.find((s) => s.tmuxSession === result.relaunched[0].newSessionId)!;
    expect(newSession.resumedFromCrash).toBeUndefined();
  });

  test('resume mode: stale transcript path falls back to session-id-only resume', async () => {
    const cwd = join(tempDir, 'project-missing-transcript');
    const transcriptPath = join(tempDir, 'transcripts', 'gone.jsonl');
    // Intentionally do NOT create the transcript file

    const task = await setupCrashedTask('Fix the bug', cwd, {
      claudeSessionId: 'session-gone',
      transcriptPath,
    });

    const launchSpy = vi.spyOn(adapter, 'launch');

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    expect(result.relaunched[0].mode).toBe('resumed');
    expect(result.relaunched[0].fallbackReason).toBeUndefined();
    expect(launchSpy.mock.calls[0][3]).toEqual({ sessionId: 'session-gone' });
  });

  test('codex sessions always get fresh launch even when claudeSessionId is set', async () => {
    // Register a fake codex adapter that records its launch arguments
    const codexLaunches: Array<{ taskId: string; prompt: string; cwd: string; resume?: unknown }> = [];
    const codexAdapter = {
      agentType: 'codex-cli' as const,
      async launch(taskId: string, prompt: string, cwd: string, resume?: unknown): Promise<string> {
        codexLaunches.push({ taskId, prompt, cwd, resume });
        const tmuxName = `kookr-codex-${taskId.slice(0, 8)}`;
        await terminal.createSession({ id: tmuxName, command: 'codex', args: [], env: {}, cwd });
        taskStore.addSession(taskId, {
          tmuxSession: tmuxName,
          agentType: 'codex-cli',
          cwd,
          createdAt: new Date(),
        });
        return tmuxName;
      },
      sendInput: async () => {},
      sendKeystroke: async () => {},
      stop: async () => {},
      captureDisplay: async () => '',
      onEvent: () => {},
      onRefreshNeeded: () => {},
      injectHookEvent: () => {},
      getEffectiveHookSettings: () => undefined,
    };
    adapterRegistry.register(codexAdapter);

    const cwd = join(tempDir, 'project-codex');
    await mkdir(cwd, { recursive: true });

    // Create a Codex task whose dead session DID populate a claudeSessionId
    // (hypothetically — Codex doesn't currently emit hooks, but the recovery
    // logic must still skip resume for Codex even if the field is present).
    const task = taskStore.createTask({ prompt: 'Refactor module', cwd, agentType: 'codex-cli' });
    const deadTmux = `kookr-dead-${task.id.slice(0, 8)}`;
    taskStore.addSession(task.id, {
      tmuxSession: deadTmux,
      agentType: 'codex-cli',
      cwd,
      createdAt: new Date(),
      lastStatus: 'running',
      claudeSessionId: 'codex-session-uuid',
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    expect(result.relaunched).toHaveLength(1);
    // Mode is 'fresh' with the agent-type fallback reason; the adapter
    // received the ResumeContext (recovery doesn't pre-filter by agentType)
    // but ignored it.
    expect(result.relaunched[0].mode).toBe('fresh');
    expect(result.relaunched[0].fallbackReason).toBe('agent type does not support resume');
    expect(codexLaunches).toHaveLength(1);
    expect(codexLaunches[0].resume).toEqual({ sessionId: 'codex-session-uuid', transcriptPath: undefined });

    // Codex session not marked resumedFromCrash
    const updatedTask = taskStore.getTask(task.id)!;
    const newSession = updatedTask.sessions.find((s) => s.tmuxSession !== deadTmux)!;
    expect(newSession.resumedFromCrash).toBeUndefined();
  });

  test('resume args branch: adapter passes --resume <id> --fork-session and omits the prompt', async () => {
    const cwd = join(tempDir, 'project-args');
    const transcriptPath = join(tempDir, 'transcripts', 'args-session.jsonl');
    await mkdir(join(tempDir, 'transcripts'), { recursive: true });
    await writeFile(transcriptPath, '{}\n', 'utf-8');

    await setupCrashedTask('Original prompt should not appear', cwd, {
      claudeSessionId: 'args-session',
      transcriptPath,
    });

    const reconcileResult = await reconcile(taskStore, terminal);
    const result = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);
    expect(result.relaunched).toHaveLength(1);

    // FakeTerminalBackend records sessions; inspect the launch argv.
    const session = terminal.sessions.get(result.relaunched[0].newSessionId);
    expect(session).toBeDefined();
    expect(session!.args).toContain('--resume');
    expect(session!.args).toContain('args-session');
    expect(session!.args).toContain('--fork-session');
    // The original prompt MUST NOT be in argv on a resume launch
    expect(session!.args).not.toContain('Original prompt should not appear');
  });
});
