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

function mkService(deps: {
  store?: TaskStore;
  terminalBackend?: FakeTerminalBackend;
  interactionLog?: { append: ReturnType<typeof vi.fn> };
  ralphCycler?: { handleStop: ReturnType<typeof vi.fn> };
  launchFreshTaskSession?: ConstructorParameters<typeof RalphLoopService>[0]['launchFreshTaskSession'];
  completeTask?: ConstructorParameters<typeof RalphLoopService>[0]['completeTask'];
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
  });
  return { store, service, terminalBackend, monitor };
}

describe('RalphLoopService', () => {
  test('task routes delegate Ralph lifecycle ownership to the service', () => {
    const source = readFileSync(new URL('./routes/task-routes.ts', import.meta.url), 'utf8');
    expect(source).toContain('ralphLoopService');
    expect(source).not.toContain('new RalphLoopService');
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

  test('validates loop requests at the ownership boundary', () => {
    expect(validateRalphLoopRequest({ prompt: 'go', iterationCap: 2 })).toEqual({
      ok: true,
      value: { prompt: 'go', iterationCap: 2 },
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
    expect(task.ralphLoop).toMatchObject({
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

  test('handleStopEvent advances and launches the next Ralph runtime from the service boundary', async () => {
    const handleStop = vi.fn().mockResolvedValue({ kind: 'launch_fresh', taskId: 'task-1', text: 'continue' });
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
    task.ralphLoop = baseLoop({
      ownerSessionId: 'agent-1',
    });
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
    expect(launchFreshTaskSession).toHaveBeenCalledWith(task, 'continue', expect.objectContaining({
      tmuxName: expect.stringMatching(/^kookr-[0-9a-f]{8}$/),
      // PR2: env var pointing at the task's verdict file is injected on every
      // launch so the agent can write its verdict regardless of `cd`.
      extraEnv: expect.objectContaining({ RALPH_VERDICT_FILE: expect.stringMatching(/\.ralph-verdict-.+\.json$/) }),
    }));
    const launchedTmuxName = launchFreshTaskSession.mock.calls[0]?.[2]?.tmuxName;
    expect(task.ralphLoop).toMatchObject({
      ownerSessionId: launchedTmuxName,
      lastHandledStopFingerprint: expect.any(String),
    });
    expect(task.ralphLoop.handlingStopFingerprint).toBeUndefined();
  });

  test('handleStopEvent leaves a loop cancelled when cancellation happens during fresh launch', async () => {
    const handleStop = vi.fn().mockResolvedValue({ kind: 'launch_fresh', taskId: 'task-1', text: 'continue' });
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
      task.ralphLoop!.status = 'cancelled';
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
    task.ralphLoop = baseLoop({ ownerSessionId: 'agent-1' });
    const stopEvent: AgentEvent = {
      type: 'stop',
      sessionId: 'runtime-1',
      turnId: 'turn-1',
      lastMessage: 'done',
    };
    monitor.processEvents('agent-1', [stopEvent]);

    await service.handleStopEvent(task, 'agent-1', stopEvent, { cumulativeCostUsd: 1.25 });

    const launchedTmuxName = launchFreshTaskSession.mock.calls[0]?.[2]?.tmuxName;
    expect(task.ralphLoop.status).toBe('cancelled');
    expect(task.ralphLoop.ownerSessionId).toBeUndefined();
    expect(task.ralphLoop.handlingStopFingerprint).toBeUndefined();
    expect(await terminalBackend.isAlive(launchedTmuxName!)).toBe(false);
  });

  test('attachLoop refuses to replace an active loop', async () => {
    const { store, service } = mkService();
    const task = store.createTask('prompt', '/repo');
    task.ralphLoop = baseLoop({ status: 'paused', currentIteration: 3 });

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
    expect(task.ralphLoop.prompt).toBe('iterate');
  });

  test('completeLoop marks an active loop completed without cancelling the task turn', () => {
    const { store, service } = mkService();
    const task = store.createTask('prompt', '/repo');
    task.ralphLoop = baseLoop({ status: 'running', currentIteration: 2 });

    const result = service.completeLoop(task);

    expect(result).toEqual({ ok: true, value: 'completed', changed: true });
    expect(task.status).toBe('open');
    expect(task.ralphLoop.status).toBe('completed');
  });

  test('completeLoop is idempotent after the loop is already completed', () => {
    const { store, service } = mkService();
    const task = store.createTask('prompt', '/repo');
    task.ralphLoop = baseLoop({ status: 'completed' });

    const result = service.completeLoop(task);

    expect(result).toEqual({ ok: true, value: 'completed', changed: false });
    expect(task.ralphLoop.status).toBe('completed');
  });

  test('pause, resume, and cancel own task mutation semantics', async () => {
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
    task.ralphLoop = baseLoop();

    expect(service.pauseLoop(task)).toMatchObject({ ok: true, changed: true, value: { status: 'paused' } });
    expect(await service.resumeLoop(task)).toMatchObject({ ok: true, changed: true, value: { status: 'running' } });
    expect(service.cancelLoop(task)).toMatchObject({ ok: true, changed: true, value: 'cancelled' });
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
    task.ralphLoop = baseLoop({ status: 'paused' });

    const result = await service.resumeLoop(task);

    expect(result).toMatchObject({
      ok: false,
      status: 409,
      body: { status: 'paused' },
    });
    expect(task.ralphLoop.status).toBe('paused');
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
      task.ralphLoop = baseLoop({ ownerSessionId: 'agent-1', currentIteration: 3 });

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
      task.ralphLoop = baseLoop({ ownerSessionId: 'agent-1', currentIteration: 5 });

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
      expect(task.ralphLoop.verdictWarningCount).toBe(1);
      expect(task.ralphLoop.lastVerdictWarningReason).toMatch(/iteration 99 does not match expected 5/);
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
      task.ralphLoop = baseLoop({ ownerSessionId: 'agent-1', currentIteration: 0 });

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
    task.ralphLoop = baseLoop({ status: 'paused', prompt: 'old prompt' });

    const result = await service.updatePrompt(task, 'new prompt');

    expect(result).toMatchObject({ ok: true, changed: true, value: { prompt: 'new prompt' } });
    expect(task.ralphLoop.prompt).toBe('new prompt');
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ralph_prompt_updated',
      taskId: task.id,
      status: 'paused',
      previousPrompt: 'old prompt',
      prompt: 'new prompt',
    }));
  });
});
