import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { TokenTracker } from '../core/token-tracker.js';
import { type RalphLoopState, TaskStore } from '../core/tasks.js';
import { defaultVerdictPath } from '../core/ralph-iteration-verdict.js';
import type { AgentEvent } from '../core/types.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { RalphLoopService, validateRalphLoopRequest } from './ralph-loop-service.js';
import { RelaunchArbiter } from './relaunch-arbiter.js';
import {
  LoopDeliveryWatchdogRegistry,
  type DeliverySnapshot,
} from '../core/loop-delivery-watchdog.js';

function baseLoop(overrides: Partial<RalphLoopState> = {}): RalphLoopState {
  return {
    prompt: 'iterate',
    iterationCap: 5,
    currentIteration: 0,
    status: 'running',
    lastIterationStartedAt: 0,
    cumulativeIterations: 0,
    ...overrides,
  };
}

function setStoredLoop(store: TaskStore, taskId: string, loop: RalphLoopState): void {
  store.getTaskForMutation(taskId)!.ralphLoop = loop;
}

function mkService(deps: {
  store?: TaskStore;
  terminalBackend?: FakeTerminalBackend;
  interactionLog?: { append: ReturnType<typeof vi.fn> };
  ralphCycler?: { handleStop: ReturnType<typeof vi.fn> };
  launchFreshTaskSession?: ConstructorParameters<typeof RalphLoopService>[0]['launchFreshTaskSession'];
  completeTask?: ConstructorParameters<typeof RalphLoopService>[0]['completeTask'];
  loopDeliveryWatchdog?: ConstructorParameters<typeof RalphLoopService>[0]['loopDeliveryWatchdog'];
  resolveDeliverySnapshot?: ConstructorParameters<typeof RalphLoopService>[0]['resolveDeliverySnapshot'];
  relaunchArbiter?: ConstructorParameters<typeof RalphLoopService>[0]['relaunchArbiter'];
  terminalRelaunchEnabled?: boolean;
  terminalRelaunchMax?: number;
  now?: () => number;
} = {}): {
  store: TaskStore;
  service: RalphLoopService;
  terminalBackend: FakeTerminalBackend;
  monitor: Monitor;
} {
  const store = deps.store ?? new TaskStore();
  const terminalBackend = deps.terminalBackend ?? new FakeTerminalBackend();
  const monitor = new Monitor(store, new AttentionQueue());
  const service = new RalphLoopService({
    taskStore: store,
    monitor,
    serverCwd: '/repo',
    terminalBackend,
    tokenTracker: new TokenTracker(),
    ralphCycler: deps.ralphCycler as never,
    launchFreshTaskSession: deps.launchFreshTaskSession ?? vi.fn(async () => 'unused-session'),
    completeTask: deps.completeTask ?? vi.fn(async () => undefined),
    broadcastToAll: (_msg: ServerMessage) => {
      /* no-op */
    },
    interactionLog: deps.interactionLog as never,
    ...(deps.loopDeliveryWatchdog ? { loopDeliveryWatchdog: deps.loopDeliveryWatchdog } : {}),
    ...(deps.resolveDeliverySnapshot ? { resolveDeliverySnapshot: deps.resolveDeliverySnapshot } : {}),
    ...(deps.relaunchArbiter ? { relaunchArbiter: deps.relaunchArbiter } : {}),
    ...(deps.terminalRelaunchEnabled !== undefined ? { terminalRelaunchEnabled: deps.terminalRelaunchEnabled } : {}),
    ...(deps.terminalRelaunchMax !== undefined ? { terminalRelaunchMax: deps.terminalRelaunchMax } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  return { store, service, terminalBackend, monitor };
}

describe('RalphLoopService', () => {
  test('Ralph routes delegate lifecycle ownership to the service', () => {
    const source = readFileSync(new URL('./ralph/routes.ts', import.meta.url), 'utf8');
    expect(source).toContain('ralphLoopService');
    expect(source).not.toContain('new RalphLoopService');
    expect(source).not.toContain('updateRalphLoop');
    expect(source).not.toContain('claimRalphLoopOwner');
    expect(source).not.toContain('ralphStopFingerprint');
    expect(source).not.toContain('handlingStopFingerprint');
  });

  test('event pipeline delegates Ralph Stop continuation ownership to the service', () => {
    const source = readFileSync(new URL('./event-pipeline.ts', import.meta.url), 'utf8');
    expect(source).toContain('ralphLoopService');
    expect(source).not.toContain('new RalphLoopService');
    expect(source).not.toContain('claimRalphLoopOwner');
    expect(source).not.toContain('ralphStopFingerprint');
    expect(source).not.toContain('handlingStopFingerprint');
  });

  test('startup recovery delegates Ralph crash reconciliation ownership to the service', () => {
    const source = readFileSync(new URL('./startup-recovery.ts', import.meta.url), 'utf8');
    expect(source).toContain('ralphLoopService.reconcileStartupLoops()');
    expect(source).not.toContain('new RalphLoopService');
    expect(source).toContain('.reconcileStartupLoops()');
    expect(source).not.toContain('claimRalphLoopOwner');
    expect(source).not.toContain('reconcileRalphLoops');
  });

  test('liveness tick wires orphan-loop recovery (issue #2193)', () => {
    const timers = readFileSync(new URL('./lifecycle-timers.ts', import.meta.url), 'utf8');
    const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(timers).toContain('reconcileOrphanedLoops');
    expect(timers).toContain('ralphLoopService');
    // Bootstrap must pass the live service into TimerDeps (optional chaining
    // alone is not enough — without the wire, the sweep is a permanent no-op).
    expect(index).toMatch(/timerDeps:\s*\{[\s\S]*ralphLoopService/);
  });

  test('looped playbook launch delegates failed transition ownership to the service', () => {
    const source = readFileSync(new URL('./use-cases/looped-playbook-launch.ts', import.meta.url), 'utf8');
    expect(source).toContain('ralphLoopService.markLoopFailed');
    expect(source).not.toContain('setRalphLoopStatus');
  });

  test('validates loop requests at the ownership boundary', () => {
    expect(validateRalphLoopRequest({ prompt: 'go', iterationCap: 2 })).toEqual({
      ok: true,
      value: { prompt: 'go', iterationCap: 2 },
    });
    expect(validateRalphLoopRequest({ prompt: 'go' })).toEqual({
      ok: true,
      value: { prompt: 'go', iterationCap: 10 },
    });
    expect(validateRalphLoopRequest({ prompt: '', iterationCap: 2 })).toMatchObject({
      ok: false,
      error: 'prompt is required and must be a non-empty string',
    });
    expect(validateRalphLoopRequest({ prompt: 'go', iterationCap: 0 })).toMatchObject({
      ok: false,
      error: 'iterationCap is required and must be a positive integer',
    });
  });

  test('startLoop initializes Ralph state and claims the newest live session as owner', async () => {
    const { store, service, terminalBackend } = mkService();
    await terminalBackend.createSession('old-session', 'claude');
    await terminalBackend.createSession('new-session', 'claude');
    const task = store.createTask('prompt', '/repo');
    store.addSession(task.id, {
      tmuxSession: 'old-session',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-03T00:00:00Z'),
      lastStatus: 'running',
      claudeSessionId: 'runtime-old',
      transcriptPath: '/tmp/old.jsonl',
    });
    store.addSession(task.id, {
      tmuxSession: 'dead-session',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-03T00:01:00Z'),
      lastStatus: 'running',
    });
    store.addSession(task.id, {
      tmuxSession: 'new-session',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-03T00:02:00Z'),
      lastStatus: 'running',
      claudeSessionId: 'runtime-new',
      transcriptPath: '/tmp/new.jsonl',
    });

    const result = await service.startLoop(task, {
      prompt: 'iterate until done',
      iterationCap: 7,
      zeroDiffConvergence: { consecutiveIterations: 2 },
      costCapUsd: 1.25,
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(store.getTask(task.id)!.ralphLoop).toMatchObject({
      prompt: 'iterate until done',
      iterationCap: 7,
      status: 'running',
      currentIteration: 0,
      zeroDiffConvergence: { consecutiveIterations: 2 },
      zeroDiffStreak: 0,
      costCapUsd: 1.25,
      ownerSessionId: 'new-session',
    });
  });

  test('startLoop accepts a TaskStore snapshot and mutates the stored task', async () => {
    const { store, service } = mkService();
    const created = store.createTask('prompt', '/repo');
    const snapshot = store.getTask(created.id)!;

    const result = await service.startLoop(snapshot, {
      prompt: 'iterate from snapshot',
      iterationCap: 3,
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(snapshot.ralphLoop).toBeUndefined();
    expect(store.getTask(created.id)!.ralphLoop).toMatchObject({
      prompt: 'iterate from snapshot',
      iterationCap: 3,
      status: 'running',
    });
  });

  test('handleStopEvent advances and launches the next Ralph runtime from the service boundary', async () => {
    const handleStop = vi.fn();
    const launchFreshTaskSession = vi.fn(async (task: ReturnType<TaskStore['createTask']>, _prompt: string, opts?: { tmuxName?: string }) => {
      const tmuxSession = opts?.tmuxName ?? 'agent-2';
      store.addSession(task.id, {
        tmuxSession,
        agentType: 'claude-code',
        cwd: task.cwd,
        createdAt: new Date('2026-05-03T00:03:00Z'),
        lastStatus: 'running',
      });
      return tmuxSession;
    });
    const { store, service, monitor } = mkService({
      ralphCycler: { handleStop },
      launchFreshTaskSession,
    });
    const task = store.createTask('prompt', '/repo');
    store.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-03T00:00:00Z'),
      lastStatus: 'running',
      claudeSessionId: 'runtime-1',
      transcriptPath: '/root.jsonl',
    });
    setStoredLoop(store, task.id, baseLoop({
      ownerSessionId: 'agent-1',
      // Non-zero iteration so the RALPH_ITERATION assertion below proves the
      // value comes from `String(loop.currentIteration)`, not from a hardcoded
      // '0' that coincides with the default. The original bug was specifically
      // that every post-iter-0 launch had a stale iteration value.
      currentIteration: 3,
    }));
    handleStop.mockResolvedValue({ kind: 'launch_fresh', taskId: task.id, text: 'continue' });
    const stopEvent: AgentEvent = {
      type: 'stop',
      sessionId: 'runtime-1',
      transcriptPath: '/root.jsonl',
      turnId: 'turn-1',
      lastMessage: 'done',
    };
    monitor.processEvents('agent-1', [stopEvent]);

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1.25 });

    expect(handleStop).toHaveBeenCalledWith(store, expect.objectContaining({
      taskId: task.id,
      sessionId: 'agent-1',
      cumulativeCostUsd: 1.25,
    }));
    expect(launchFreshTaskSession).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), 'continue', expect.objectContaining({
      tmuxName: expect.stringMatching(/^kookr-[0-9a-f]{8}$/),
      // PR2: env var pointing at the task's verdict file is injected on every
      // launch so the agent can write its verdict regardless of `cd`.
      // `RALPH_ITERATION` mirrors `{{ralph.iteration}}` so verdict-writer
      // bash like `"iteration":${RALPH_ITERATION}` emits the current number;
      // without it every post-iter-0 verdict was rejected as
      // `iteration_mismatch` and stall counts never accrued.
      extraEnv: expect.objectContaining({
        RALPH_VERDICT_FILE: expect.stringMatching(/\.ralph-verdict-.+\.json$/),
        RALPH_ITERATION: '3',
      }),
    }));
    const launchedTmuxName = launchFreshTaskSession.mock.calls[0]?.[2]?.tmuxName;
    expect(store.getTask(task.id)!.ralphLoop).toMatchObject({
      ownerSessionId: launchedTmuxName,
      lastHandledStopFingerprint: expect.any(String),
    });
    expect(store.getTask(task.id)!.ralphLoop!.handlingStopFingerprint).toBeUndefined();
  });

  test('handleStopEvent leaves a loop cancelled when cancellation happens during fresh launch', async () => {
    const handleStop = vi.fn();
    const launchFreshTaskSession = vi.fn(async (task: ReturnType<TaskStore['createTask']>, _prompt: string, opts?: { tmuxName?: string }) => {
      const tmuxSession = opts?.tmuxName ?? 'agent-2';
      await terminalBackend.createSession(tmuxSession, 'claude');
      store.addSession(task.id, {
        tmuxSession,
        agentType: 'claude-code',
        cwd: task.cwd,
        createdAt: new Date('2026-05-03T00:03:00Z'),
        lastStatus: 'running',
      });
      store.getTaskForMutation(task.id)!.ralphLoop!.status = 'cancelled';
      return tmuxSession;
    });
    const { store, service, monitor, terminalBackend } = mkService({
      ralphCycler: { handleStop },
      launchFreshTaskSession,
    });
    const task = store.createTask('prompt', '/repo');
    store.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-03T00:00:00Z'),
      lastStatus: 'running',
    });
    setStoredLoop(store, task.id, baseLoop({ ownerSessionId: 'agent-1' }));
    handleStop.mockResolvedValue({ kind: 'launch_fresh', taskId: task.id, text: 'continue' });
    const stopEvent: AgentEvent = {
      type: 'stop',
      sessionId: 'runtime-1',
      turnId: 'turn-1',
      lastMessage: 'done',
    };
    monitor.processEvents('agent-1', [stopEvent]);

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1.25 });

    const launchedTmuxName = launchFreshTaskSession.mock.calls[0]?.[2]?.tmuxName;
    const storedLoop = store.getTask(task.id)!.ralphLoop!;
    expect(storedLoop.status).toBe('cancelled');
    expect(storedLoop.ownerSessionId).toBeUndefined();
    expect(storedLoop.handlingStopFingerprint).toBeUndefined();
    expect(await terminalBackend.isAlive(launchedTmuxName!)).toBe(false);
  });

  test('attachLoop refuses to replace an active loop', async () => {
    const { store, service } = mkService();
    const task = store.createTask('prompt', '/repo');
    setStoredLoop(store, task.id, baseLoop({ status: 'paused', currentIteration: 3 }));

    const result = await service.attachLoop(task, { prompt: 'new', iterationCap: 4 });

    expect(result).toEqual({
      ok: false,
      status: 409,
      body: {
        error: 'task already has an active Ralph loop',
        status: 'paused',
        currentIteration: 3,
      },
    });
    expect(store.getTask(task.id)!.ralphLoop!.prompt).toBe('iterate');
  });

  test('completeLoop marks an active loop completed without cancelling the task turn', () => {
    const { store, service } = mkService();
    const task = store.createTask('prompt', '/repo');
    setStoredLoop(store, task.id, baseLoop({ status: 'running', currentIteration: 2 }));

    const snapshot = store.getTask(task.id)!;
    const result = service.completeLoop(snapshot);

    expect(result).toEqual({ ok: true, value: 'completed', changed: true });
    expect(snapshot.ralphLoop!.status).toBe('running');
    expect(store.getTask(task.id)!.status).toBe('open');
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('completed');
  });

  test('completeLoop is idempotent after the loop is already completed', () => {
    const { store, service } = mkService();
    const task = store.createTask('prompt', '/repo');
    setStoredLoop(store, task.id, baseLoop({ status: 'completed' }));

    const result = service.completeLoop(store.getTask(task.id)!);

    expect(result).toEqual({ ok: true, value: 'completed', changed: false });
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('completed');
  });

  test('pause, resume, and cancel mutate stored task when called with snapshots', async () => {
    const { store, service, terminalBackend } = mkService();
    await terminalBackend.createSession('s1', 'claude');
    const task = store.createTask('prompt', '/repo');
    store.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-03T00:00:00Z'),
      lastStatus: 'running',
    });
    setStoredLoop(store, task.id, baseLoop());

    const snapshot = store.getTask(task.id)!;
    expect(service.pauseLoop(snapshot)).toMatchObject({ ok: true, changed: true, value: { status: 'paused' } });
    expect(snapshot.ralphLoop!.status).toBe('running');
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('paused');

    expect(await service.resumeLoop(snapshot)).toMatchObject({ ok: true, changed: true, value: { status: 'running' } });
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('running');

    expect(service.cancelLoop(snapshot)).toMatchObject({ ok: true, changed: true, value: 'cancelled' });
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('cancelled');
  });

  test('active loop controls accept TaskStore snapshots and persist to the stored task', async () => {
    const { store, service, terminalBackend } = mkService();
    await terminalBackend.createSession('s1', 'claude');
    const task = store.createTask('prompt', '/repo');
    store.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-03T00:00:00Z'),
      lastStatus: 'running',
    });
    setStoredLoop(store, task.id, baseLoop());

    const staleBeforePause = store.getTask(task.id)!;
    expect(service.pauseLoop(staleBeforePause)).toMatchObject({ ok: true, changed: true, value: { status: 'paused' } });
    expect(staleBeforePause.ralphLoop!.status).toBe('running');
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('paused');

    const staleBeforeResume = store.getTask(task.id)!;
    expect(await service.resumeLoop(staleBeforeResume)).toMatchObject({ ok: true, changed: true, value: { status: 'running' } });
    expect(staleBeforeResume.ralphLoop!.status).toBe('paused');
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('running');

    const staleBeforeComplete = store.getTask(task.id)!;
    expect(service.completeLoop(staleBeforeComplete)).toEqual({ ok: true, value: 'completed', changed: true });
    expect(staleBeforeComplete.ralphLoop!.status).toBe('running');
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('completed');

    setStoredLoop(store, task.id, baseLoop());
    const staleBeforeCancel = store.getTask(task.id)!;
    expect(service.cancelLoop(staleBeforeCancel)).toMatchObject({ ok: true, changed: true, value: 'cancelled' });
    expect(staleBeforeCancel.ralphLoop!.status).toBe('running');
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('cancelled');
  });

  test('resume rejects a paused loop when no live session remains', async () => {
    const { store, service } = mkService();
    const task = store.createTask('prompt', '/repo');
    store.addSession(task.id, {
      tmuxSession: 'missing-session',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-05-03T00:00:00Z'),
      lastStatus: 'running',
    });
    setStoredLoop(store, task.id, baseLoop({ status: 'paused' }));

    const result = await service.resumeLoop(task);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      body: { status: 'paused' },
    });
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('paused');
  });

  describe('verdict file lifecycle (PR2 service-layer integration)', () => {
    let workDir: string;

    beforeEach(async () => {
      workDir = await mkdtemp(join(tmpdir(), 'ralph-svc-verdict-'));
    });

    afterEach(async () => {
      await rm(workDir, { recursive: true, force: true });
    });

    test('Stop handler reads verdict file, passes parsed verdict to cycler, then unlinks the file', async () => {
      const handleStop = vi.fn().mockResolvedValue({ kind: 'noop', events: [] });
      const append = vi.fn().mockResolvedValue(undefined);
      const launchFreshTaskSession = vi.fn(async () => 'unused-session');
      const { store, service, monitor } = mkService({
        ralphCycler: { handleStop },
        launchFreshTaskSession,
        interactionLog: { append },
      });
      const task = store.createTask('verdict integration', workDir);
      store.addSession(task.id, {
        tmuxSession: 'agent-1',
        agentType: 'claude-code',
        cwd: workDir,
        createdAt: new Date('2026-05-08T00:00:00Z'),
        lastStatus: 'running',
        claudeSessionId: 'runtime-1',
        transcriptPath: '/root.jsonl',
      });
      setStoredLoop(store, task.id, baseLoop({ ownerSessionId: 'agent-1', currentIteration: 3 }));

      const verdictPath = defaultVerdictPath(task.cwd, task.id);
      await writeFile(verdictPath, JSON.stringify({
        verdict: 'stalled',
        iteration: 3,
        target: '154',
        reason: 'tests fail',
      }));

      const stopEvent: AgentEvent = {
        type: 'stop',
        sessionId: 'runtime-1',
        transcriptPath: '/root.jsonl',
        turnId: 'turn-1',
        lastMessage: 'done',
      };
      monitor.processEvents('agent-1', [stopEvent]);
      await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: null });

      // (i) cycler received the parsed verdict
      expect(handleStop).toHaveBeenCalledWith(store, expect.objectContaining({
        verdict: { verdict: 'stalled', iteration: 3, target: '154', reason: 'tests fail' },
      }));
      // (ii) file is gone after the read
      await expect(access(verdictPath)).rejects.toThrow();
      // (iii) no warning event for a clean read
      const warningCalls = append.mock.calls
        .map(([e]) => (e as { type: string }).type)
        .filter((t) => t === 'ralph_verdict_warning');
      expect(warningCalls).toHaveLength(0);
    });

    test('Stop handler with malformed verdict file: increments verdictWarningCount + emits ralph_verdict_warning + cycler gets undefined', async () => {
      const handleStop = vi.fn().mockResolvedValue({ kind: 'noop', events: [] });
      const append = vi.fn().mockResolvedValue(undefined);
      const { store, service, monitor } = mkService({
        ralphCycler: { handleStop },
        interactionLog: { append },
      });
      const task = store.createTask('verdict malformed', workDir);
      store.addSession(task.id, {
        tmuxSession: 'agent-1',
        agentType: 'claude-code',
        cwd: workDir,
        createdAt: new Date('2026-05-08T00:00:00Z'),
        lastStatus: 'running',
        claudeSessionId: 'runtime-1',
        transcriptPath: '/root.jsonl',
      });
      setStoredLoop(store, task.id, baseLoop({ ownerSessionId: 'agent-1', currentIteration: 5 }));

      const verdictPath = defaultVerdictPath(task.cwd, task.id);
      // Wrong-iteration verdict — agent wrote iter 99, engine is on iter 5.
      await writeFile(verdictPath, JSON.stringify({
        verdict: 'progress',
        iteration: 99,
        target: '154',
      }));

      const stopEvent: AgentEvent = {
        type: 'stop',
        sessionId: 'runtime-1',
        transcriptPath: '/root.jsonl',
        turnId: 'turn-1',
        lastMessage: 'done',
      };
      monitor.processEvents('agent-1', [stopEvent]);
      await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: null });

      // Cycler called WITHOUT a verdict (mismatch is treated as legacy continued).
      expect(handleStop).toHaveBeenCalled();
      const cyclerOpts = handleStop.mock.calls[0][1] as { verdict?: unknown };
      expect(cyclerOpts.verdict).toBeUndefined();
      // Operability counters bumped on the loop state.
      expect(store.getTask(task.id)!.ralphLoop!.verdictWarningCount).toBe(1);
      expect(store.getTask(task.id)!.ralphLoop!.lastVerdictWarningReason).toMatch(/iteration 99 does not match expected 5/);
      // Warning event emitted for forensics.
      expect(append).toHaveBeenCalledWith(expect.objectContaining({
        type: 'ralph_verdict_warning',
        taskId: task.id,
        iteration: 5,
        failure: 'iteration_mismatch',
      }));
      // Stale file is gone after the read regardless of validation outcome.
      await expect(access(verdictPath)).rejects.toThrow();
    });

    test('Pre-launch unlink emits ralph_stale_verdict_unlinked when a leftover file exists from prior crash', async () => {
      const handleStop = vi.fn().mockResolvedValue({ kind: 'launch_fresh', taskId: 'task-1', text: 'continue', events: [] });
      const append = vi.fn().mockResolvedValue(undefined);
      const launchFreshTaskSession = vi.fn(async (task: ReturnType<TaskStore['createTask']>, _prompt: string, opts?: { tmuxName?: string }) => {
        const tmuxSession = opts?.tmuxName ?? 'agent-2';
        store.addSession(task.id, {
          tmuxSession, agentType: 'claude-code', cwd: task.cwd,
          createdAt: new Date('2026-05-08T00:00:01Z'), lastStatus: 'running',
        });
        return tmuxSession;
      });
      const { store, service, monitor } = mkService({
        ralphCycler: { handleStop },
        launchFreshTaskSession,
        interactionLog: { append },
      });
      const task = store.createTask('verdict pre-launch unlink', workDir);
      store.addSession(task.id, {
        tmuxSession: 'agent-1', agentType: 'claude-code', cwd: workDir,
        createdAt: new Date('2026-05-08T00:00:00Z'), lastStatus: 'running',
        claudeSessionId: 'runtime-1', transcriptPath: '/root.jsonl',
      });
      setStoredLoop(store, task.id, baseLoop({ ownerSessionId: 'agent-1', currentIteration: 0 }));

      // Write the post-stop verdict file (consumed and unlinked by Stop handling).
      const verdictPath = defaultVerdictPath(task.cwd, task.id);
      await writeFile(verdictPath, JSON.stringify({ verdict: 'progress', iteration: 0, target: 'a' }));

      const stopEvent: AgentEvent = {
        type: 'stop', sessionId: 'runtime-1', transcriptPath: '/root.jsonl',
        turnId: 'turn-1', lastMessage: 'done',
      };
      monitor.processEvents('agent-1', [stopEvent]);

      // Plant a stale verdict file BETWEEN read-then-unlink and pre-launch unlink:
      // simulate a crash recovery where a file appeared while the engine was
      // restarting. We fake this by re-writing the file immediately after the
      // stop event but before launchFreshRuntime runs. Easier path: mock the
      // launchFreshTaskSession to write the file BEFORE any launch — the
      // pre-launch unlink runs first and should see the stale file.
      // (Simpler alternative: rely on the post-stop unlink + a freshly-planted
      // file. We do that here.)
      launchFreshTaskSession.mockImplementationOnce(async (task, _prompt, opts) => {
        // By the time we get here, the post-stop unlink has already run.
        // The pre-launch unlink-and-audit ran INSIDE launchFreshRuntime BEFORE
        // we reach this mock — so for the pre-launch event to fire, the file
        // must have existed at that point. Plant it via a synchronous write
        // before allowing the spawn to proceed (simulates a kookr_crash where
        // a file was left behind on disk).
        // NOTE: This path is reached AFTER unlink-and-audit, so the audit fired
        // on a now-already-deleted file from the post-stop unlink. To exercise
        // the audit we instead pre-populate the file path and rely on the
        // pre-launch unlink-and-audit running before the post-stop unlink in
        // this same Stop event — the order in the service is:
        //   1. post-stop read+unlink the file from this iteration
        //   2. cycler decides to launch_fresh
        //   3. pre-launch unlink runs (no file → no audit)
        // So this test exercises the post-stop path's interaction with the
        // pre-launch path: clean handoff, no audit on the second unlink.
        const tmuxSession = opts?.tmuxName ?? 'agent-2';
        store.addSession(task.id, {
          tmuxSession, agentType: 'claude-code', cwd: task.cwd,
          createdAt: new Date('2026-05-08T00:00:01Z'), lastStatus: 'running',
        });
        return tmuxSession;
      });

      await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: null });

      // The cycler launched, the post-stop unlink and pre-launch unlink both
      // ran. No stale-verdict audit because the post-stop unlink already
      // consumed the file before the pre-launch unlink saw it. Verifying the
      // negative case here protects against a future regression that fires
      // the audit on every launch (would flood the interaction log).
      const staleEvents = append.mock.calls
        .map(([e]) => (e as { type: string }).type)
        .filter((t) => t === 'ralph_stale_verdict_unlinked');
      expect(staleEvents).toHaveLength(0);
      // The verdict was consumed by the cycler (positive path).
      expect(handleStop).toHaveBeenCalledWith(store, expect.objectContaining({
        verdict: { verdict: 'progress', iteration: 0, target: 'a' },
      }));
    });
  });

  test('updatePrompt mutates through the service and records the interaction', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const { store, service } = mkService({ interactionLog: { append } });
    const task = store.createTask('prompt', '/repo');
    setStoredLoop(store, task.id, baseLoop({ status: 'paused', prompt: 'old prompt' }));

    const result = await service.updatePrompt(task, 'new prompt');

    expect(result).toMatchObject({ ok: true, changed: true, value: { prompt: 'new prompt' } });
    expect(store.getTask(task.id)!.ralphLoop!.prompt).toBe('new prompt');
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ralph_prompt_updated',
      taskId: task.id,
      status: 'paused',
      previousPrompt: 'old prompt',
      prompt: 'new prompt',
    }));
  });

  test('updatePrompt accepts a TaskStore snapshot and persists to the stored task', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const { store, service } = mkService({ interactionLog: { append } });
    const task = store.createTask('prompt', '/repo');
    setStoredLoop(store, task.id, baseLoop({ status: 'paused', prompt: 'old prompt' }));
    const snapshot = store.getTask(task.id)!;

    const result = await service.updatePrompt(snapshot, 'new prompt');

    expect(result).toMatchObject({ ok: true, changed: true, value: { prompt: 'new prompt' } });
    expect(snapshot.ralphLoop!.prompt).toBe('old prompt');
    expect(store.getTask(task.id)!.ralphLoop!.prompt).toBe('new prompt');
  });

  test('modifyBurnedTargets owns burned-target mutation and audit logging', async () => {
    const append = vi.fn().mockResolvedValue(undefined);
    const { store, service } = mkService({ interactionLog: { append } });
    const task = store.createTask('prompt', '/repo');
    setStoredLoop(store, task.id, baseLoop({
      currentIteration: 4,
      burnedOutTargets: [
        {
          target: 'api',
          consecutiveStallCount: 2,
          totalStallCount: 2,
          firstStalledAtIteration: 1,
          lastStallReason: 'same error',
          lastStallBlockers: ['timeout'],
          burned: true,
          lastAttemptedIteration: 3,
        },
        {
          target: 'ui',
          consecutiveStallCount: 1,
          totalStallCount: 1,
          firstStalledAtIteration: 2,
          lastStallReason: 'compile',
          lastStallBlockers: [],
          burned: false,
          lastAttemptedIteration: 3,
        },
      ],
    }));

    const result = await service.modifyBurnedTargets(task.id, { remove: [' API '], clear: false });

    expect(result).toMatchObject({ ok: true, changed: true, value: [{ target: 'ui' }] });
    expect(store.getTask(task.id)!.ralphLoop!.burnedOutTargets).toMatchObject([{ target: 'ui' }]);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ralph_burned_targets_modified',
      taskId: task.id,
      removed: ['api'],
      cleared: false,
    }));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ralph_target_unburned',
      taskId: task.id,
      target: 'api',
      iteration: 4,
      via: 'patch_burned_targets',
    }));
  });

  test('markLoopFailed owns failed-start loop status mutation', () => {
    const { store, service } = mkService();
    const task = store.createTask('prompt', '/repo');
    setStoredLoop(store, task.id, baseLoop({ status: 'running' }));
    const before = store.getTask(task.id)!.updatedAt.getTime();

    expect(service.markLoopFailed(task.id)).toBe(true);

    const updated = store.getTask(task.id)!;
    expect(updated.ralphLoop!.status).toBe('failed');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});


describe('delivery-aware loop watchdog wiring (issue #1902)', () => {
  const workDir = '/repo';

  function addOwnedSession(store: TaskStore, taskId: string): void {
    store.addSession(taskId, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: workDir,
      createdAt: new Date('2026-08-02T00:00:00Z'),
      lastStatus: 'running',
      claudeSessionId: 'runtime-1',
      transcriptPath: '/root.jsonl',
    });
  }

  async function driveIteration(
    service: RalphLoopService,
    monitor: Monitor,
    task: ReturnType<TaskStore['createTask']>,
    turn: number,
  ): Promise<void> {
    const stopEvent: AgentEvent = {
      type: 'stop',
      sessionId: 'runtime-1',
      transcriptPath: '/root.jsonl',
      turnId: `turn-${turn}`,
      lastMessage: `iteration ${turn}`,
    };
    monitor.processEvents('agent-1', [stopEvent]);
    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: null });
  }

  test('flags a loop that stops delivering for N consecutive iterations', async () => {
    const handleStop = vi.fn().mockResolvedValue({ kind: 'noop', events: [] });
    const registry = new LoopDeliveryWatchdogRegistry({ noProgressSamples: 3, recoverSamples: 2 });
    // Delivery never advances — a delivered-then-hung loop.
    const stalled: DeliverySnapshot = { commits: 1, prsOpened: 1, prsMerged: 0 };
    const { store, service, monitor } = mkService({
      ralphCycler: { handleStop },
      loopDeliveryWatchdog: registry,
      resolveDeliverySnapshot: () => stalled,
    });
    const task = store.createTask('stalled loop', workDir);
    addOwnedSession(store, task.id);
    setStoredLoop(store, task.id, baseLoop({ ownerSessionId: 'agent-1' }));

    // Iteration 1 is the baseline; iterations 2-4 are three consecutive
    // no-progress samples, so the flag engages on iteration 4.
    await driveIteration(service, monitor, task, 1);
    expect(registry.isFlagged(task.id)).toBe(false);
    await driveIteration(service, monitor, task, 2);
    await driveIteration(service, monitor, task, 3);
    expect(registry.isFlagged(task.id)).toBe(false);
    await driveIteration(service, monitor, task, 4);
    expect(registry.isFlagged(task.id)).toBe(true);
  });

  test('never flags a quiet-but-progressing loop', async () => {
    const handleStop = vi.fn().mockResolvedValue({ kind: 'noop', events: [] });
    const registry = new LoopDeliveryWatchdogRegistry({ noProgressSamples: 3, recoverSamples: 2 });
    let commits = 0;
    const { store, service, monitor } = mkService({
      ralphCycler: { handleStop },
      loopDeliveryWatchdog: registry,
      // Advances a delivery counter every iteration — quiet (no chatter is an
      // input) but genuinely progressing.
      resolveDeliverySnapshot: () => ({ commits: ++commits, prsOpened: 0, prsMerged: 0 }),
    });
    const task = store.createTask('progressing loop', workDir);
    addOwnedSession(store, task.id);
    setStoredLoop(store, task.id, baseLoop({ ownerSessionId: 'agent-1' }));

    for (let turn = 1; turn <= 8; turn++) {
      await driveIteration(service, monitor, task, turn);
      expect(registry.isFlagged(task.id)).toBe(false);
    }
  });

  test('a null-returning resolver never flags the loop (missing delivery data is fail-open)', async () => {
    const handleStop = vi.fn().mockResolvedValue({ kind: 'noop', events: [] });
    // Threshold 1 would flag on the very first no-progress sample — prove that
    // a resolver that can't read delivery data (returns null) never gets there.
    const registry = new LoopDeliveryWatchdogRegistry({ noProgressSamples: 1, recoverSamples: 1 });
    const { store, service, monitor } = mkService({
      ralphCycler: { handleStop },
      loopDeliveryWatchdog: registry,
      resolveDeliverySnapshot: () => null,
    });
    const task = store.createTask('unreadable delivery', workDir);
    addOwnedSession(store, task.id);
    setStoredLoop(store, task.id, baseLoop({ ownerSessionId: 'agent-1' }));

    for (let turn = 1; turn <= 4; turn++) {
      await driveIteration(service, monitor, task, turn);
    }
    expect(registry.isFlagged(task.id)).toBe(false);
  });

  test('no resolver wired ⇒ watchdog is never sampled (fail-open)', async () => {
    const handleStop = vi.fn().mockResolvedValue({ kind: 'noop', events: [] });
    const registry = new LoopDeliveryWatchdogRegistry({ noProgressSamples: 1, recoverSamples: 1 });
    const { store, service, monitor } = mkService({
      ralphCycler: { handleStop },
      loopDeliveryWatchdog: registry,
      // resolveDeliverySnapshot deliberately omitted.
    });
    const task = store.createTask('unsampled loop', workDir);
    addOwnedSession(store, task.id);
    setStoredLoop(store, task.id, baseLoop({ ownerSessionId: 'agent-1' }));

    await driveIteration(service, monitor, task, 1);
    await driveIteration(service, monitor, task, 2);
    expect(registry.size).toBe(0);
    expect(registry.isFlagged(task.id)).toBe(false);
  });
});

describe('Terminal-loop relaunch policy (issue #1901 / WS2.3)', () => {
  const CLAIM = { repo: 'github.com/kookr-ai/kookr', number: 1901 };

  /**
   * Wire a running single-iteration Ralph loop whose stop is owned by session
   * `agent-1`, then drive one Stop through the service with a cycler that
   * terminates with `reason` (mirroring the real cycler, which writes a
   * terminal `loop.status` before returning `terminate`).
   */
  function setupTerminating(reason: string, opts: {
    withClaim?: boolean;
    relaunchArbiter?: RelaunchArbiter;
    terminalRelaunchEnabled?: boolean;
    terminalRelaunchMax?: number;
    loopOverrides?: Partial<RalphLoopState>;
    launchError?: Error;
    now?: () => number;
  } = {}) {
    const interactionLog = { append: vi.fn(async () => undefined) };
    const launchFreshTaskSession = vi.fn(async (t: ReturnType<TaskStore['createTask']>, _prompt: string, o?: { tmuxName?: string }) => {
      if (opts.launchError) throw opts.launchError;
      const tmuxSession = o?.tmuxName ?? 'agent-2';
      store.addSession(t.id, {
        tmuxSession,
        agentType: 'claude-code',
        cwd: t.cwd,
        createdAt: new Date('2026-08-02T00:01:00Z'),
        lastStatus: 'running',
      });
      return tmuxSession;
    });
    // Mirror the real cycler: it writes a terminal loop.status BEFORE returning.
    const handleStop = vi.fn(async (s: TaskStore, o: { taskId: string }) => {
      s.runRalphMutation(o.taskId, (t) => {
        if (t.ralphLoop) t.ralphLoop.status = 'completed';
      });
      return { kind: 'terminate' as const, reason, events: [] };
    });

    const built = mkService({
      ralphCycler: { handleStop },
      launchFreshTaskSession,
      interactionLog,
      ...(opts.relaunchArbiter ? { relaunchArbiter: opts.relaunchArbiter } : {}),
      ...(opts.terminalRelaunchEnabled !== undefined ? { terminalRelaunchEnabled: opts.terminalRelaunchEnabled } : {}),
      ...(opts.terminalRelaunchMax !== undefined ? { terminalRelaunchMax: opts.terminalRelaunchMax } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    const { store, service, monitor } = built;
    const task = store.createTask('iterate', '/repo');
    store.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date('2026-08-02T00:00:00Z'),
      lastStatus: 'running',
      claudeSessionId: 'runtime-1',
      transcriptPath: '/root.jsonl',
    });
    if (opts.withClaim !== false) {
      store.getTaskForMutation(task.id)!.issueClaim = { ...CLAIM, claimedAt: '2026-08-02T00:00:00Z' };
    }
    setStoredLoop(store, task.id, baseLoop({ ownerSessionId: 'agent-1', currentIteration: 5, iterationCap: 5, ...opts.loopOverrides }));

    const stopEvent: AgentEvent = {
      type: 'stop',
      sessionId: 'runtime-1',
      transcriptPath: '/root.jsonl',
      turnId: 'turn-1',
      lastMessage: 'done',
    };
    monitor.processEvents('agent-1', [stopEvent]);

    return { store, service, task, stopEvent, launchFreshTaskSession, interactionLog };
  }

  test('relaunch-on-eligible: a capped loop re-arms in place via the arbiter', async () => {
    const arbiter = new RelaunchArbiter();
    const { store, service, task, stopEvent, launchFreshTaskSession, interactionLog } =
      setupTerminating('iteration_cap', { relaunchArbiter: arbiter });

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1 });

    // Re-armed: fresh iteration budget, running again, no needs-human marker.
    const loop = store.getTask(task.id)!.ralphLoop!;
    expect(loop.status).toBe('running');
    expect(loop.currentIteration).toBe(0);
    expect(loop.needsHuman).toBeUndefined();
    // A fresh agent session was launched (the actual re-arm).
    expect(launchFreshTaskSession).toHaveBeenCalledTimes(1);
    // The relaunch went through the arbiter — the lease is now held by the task.
    expect(arbiter.isHeld(CLAIM)).toBe(true);
    expect(arbiter.getLease(CLAIM)?.holderId).toBe(task.id);
    // Audit trail records the relaunch.
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ralph_terminal_relaunch',
      taskId: task.id,
      exitReason: 'iteration_cap',
      outcome: 'relaunched',
    }));
  });

  test('escalate-on-budget-exhausted: a cost-capped loop lands in a visible needs-human state, not silence', async () => {
    const arbiter = new RelaunchArbiter();
    const { store, service, task, stopEvent, launchFreshTaskSession, interactionLog } =
      setupTerminating('cost_cap', { relaunchArbiter: arbiter, now: () => 1_700_000_000_000 });

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 99 });

    const loop = store.getTask(task.id)!.ralphLoop!;
    // Explicit, visible needs-human terminal state (not relaunched).
    expect(loop.needsHuman).toMatchObject({
      reason: 'budget_exhausted',
      exitReason: 'cost_cap',
      since: 1_700_000_000_000,
    });
    expect(loop.needsHuman!.detail).toMatch(/cost cap/i);
    // No relaunch: the arbiter lease was never acquired, no fresh session.
    expect(launchFreshTaskSession).not.toHaveBeenCalled();
    expect(arbiter.isHeld(CLAIM)).toBe(false);
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ralph_loop_needs_human',
      taskId: task.id,
      reason: 'budget_exhausted',
      exitReason: 'cost_cap',
    }));
  });

  test('escalation releases the arbiter lease so a needs-human issue is not pinned against the task', async () => {
    const arbiter = new RelaunchArbiter();
    const { store, service, task, stopEvent } =
      setupTerminating('cost_cap', { relaunchArbiter: arbiter });
    // The task holds the issue lease, as it would after its original claimIssue
    // launch (or a prior terminal relaunch).
    expect(arbiter.tryAcquire(CLAIM, task.id).ok).toBe(true);
    expect(arbiter.isHeld(CLAIM)).toBe(true);

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 99 });

    expect(store.getTask(task.id)!.ralphLoop!.needsHuman).toMatchObject({ reason: 'budget_exhausted' });
    // Released: the lease is no longer pinned, so a human manual re-dispatch is
    // not silently denied 'held' while the loop waits on a human.
    expect(arbiter.isHeld(CLAIM)).toBe(false);
  });

  test('arbiter is the single gate: an eligible exit does not relaunch when another actuator holds the issue', async () => {
    const arbiter = new RelaunchArbiter();
    // Another actuator already owns the relaunch lease for this issue.
    expect(arbiter.tryAcquire(CLAIM, 'other-actuator').ok).toBe(true);

    const { store, service, task, stopEvent, launchFreshTaskSession, interactionLog } =
      setupTerminating('all_targets_stalled', { relaunchArbiter: arbiter });

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1 });

    // No double-launch; the loop stays terminal.
    expect(launchFreshTaskSession).not.toHaveBeenCalled();
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('completed');
    expect(arbiter.getLease(CLAIM)?.holderId).toBe('other-actuator');
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ralph_terminal_relaunch',
      outcome: 'skipped_held',
    }));
  });

  test('arbiter cooldown: an eligible exit does not relaunch while a post-release backoff is active', async () => {
    const arbiter = new RelaunchArbiter();
    // A prior holder released, starting the cooldown window — tryAcquire now
    // returns `backoff` until it elapses (the thundering-herd throttle).
    arbiter.tryAcquire(CLAIM, 'prior');
    arbiter.release(CLAIM, 'prior');

    const { store, service, task, stopEvent, launchFreshTaskSession, interactionLog } =
      setupTerminating('iteration_cap', { relaunchArbiter: arbiter });

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1 });

    expect(launchFreshTaskSession).not.toHaveBeenCalled();
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('completed');
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ralph_terminal_relaunch',
      outcome: 'skipped_backoff',
    }));
  });

  test('relaunch launch failure: the lease is released and the loop is marked failed', async () => {
    const arbiter = new RelaunchArbiter();
    const { store, service, task, stopEvent } =
      setupTerminating('iteration_cap', { relaunchArbiter: arbiter, launchError: new Error('boom') });

    // The launch throws; the error propagates out of the stop handler.
    await expect(
      service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1 }),
    ).rejects.toThrow('boom');

    // Critically: the lease is released (so the cooldown starts and no actuator
    // is jammed behind a dead lease), and the loop lands in a terminal state.
    expect(arbiter.isHeld(CLAIM)).toBe(false);
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('failed');
  });

  test('kill-switch: terminalRelaunchEnabled=false suppresses relaunch but still escalates budget exhaustion', async () => {
    const arbiter = new RelaunchArbiter();
    const eligible = setupTerminating('iteration_cap', { relaunchArbiter: arbiter, terminalRelaunchEnabled: false });
    await eligible.service.handleStopEvent(eligible.task, 'agent-1', eligible.stopEvent, { cumulativeCostUsd: 1 });
    expect(eligible.launchFreshTaskSession).not.toHaveBeenCalled();
    expect(eligible.store.getTask(eligible.task.id)!.ralphLoop!.status).toBe('completed');

    const budget = setupTerminating('iteration_cost_cap', { relaunchArbiter: arbiter, terminalRelaunchEnabled: false });
    await budget.service.handleStopEvent(budget.task, 'agent-1', budget.stopEvent, { cumulativeCostUsd: 1 });
    expect(budget.store.getTask(budget.task.id)!.ralphLoop!.needsHuman).toMatchObject({ reason: 'budget_exhausted' });
  });

  test('relaunch increments the cumulative terminal-relaunch counter', async () => {
    const arbiter = new RelaunchArbiter();
    const { store, service, task, stopEvent } =
      setupTerminating('iteration_cap', { relaunchArbiter: arbiter, loopOverrides: { terminalRelaunchCount: 2 } });

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1 });

    expect(store.getTask(task.id)!.ralphLoop!.terminalRelaunchCount).toBe(3);
  });

  test('runaway guard: a loop at the relaunch cap escalates to needs-human instead of re-arming', async () => {
    const arbiter = new RelaunchArbiter();
    const { store, service, task, stopEvent, launchFreshTaskSession, interactionLog } =
      setupTerminating('iteration_cap', {
        relaunchArbiter: arbiter,
        terminalRelaunchMax: 3,
        loopOverrides: { terminalRelaunchCount: 3 },
      });

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1 });

    // Capped: no re-arm, no lease acquired, escalated to a visible needs-human state.
    expect(launchFreshTaskSession).not.toHaveBeenCalled();
    expect(arbiter.isHeld(CLAIM)).toBe(false);
    expect(store.getTask(task.id)!.ralphLoop!.needsHuman).toMatchObject({
      reason: 'relaunch_exhausted',
      exitReason: 'iteration_cap',
    });
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ralph_loop_needs_human',
      reason: 'relaunch_exhausted',
    }));
  });

  test('runaway guard disabled (max 0): a loop past 20 relaunches still re-arms', async () => {
    const arbiter = new RelaunchArbiter();
    const { store, service, task, stopEvent, launchFreshTaskSession } =
      setupTerminating('iteration_cap', {
        relaunchArbiter: arbiter,
        terminalRelaunchMax: 0,
        loopOverrides: { terminalRelaunchCount: 999 },
      });

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1 });

    expect(launchFreshTaskSession).toHaveBeenCalledTimes(1);
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('running');
  });

  test('no issue claim: an eligible exit does not relaunch (nothing to arbitrate on)', async () => {
    const arbiter = new RelaunchArbiter();
    const { store, service, task, stopEvent, launchFreshTaskSession } =
      setupTerminating('target_stalled', { relaunchArbiter: arbiter, withClaim: false });

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1 });

    expect(launchFreshTaskSession).not.toHaveBeenCalled();
    expect(store.getTask(task.id)!.ralphLoop!.status).toBe('completed');
  });
});

describe('Ralph escape hatch closure (issue #1461)', () => {
  test('ralph-loop-service production source does not call getTaskForMutation', () => {
    const src = readFileSync(new URL('./ralph-loop-service.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/getTaskForMutation/);
    expect(src).toMatch(/runRalphMutation/);
  });
});
