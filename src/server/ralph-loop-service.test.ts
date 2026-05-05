import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { type RalphLoopState, TaskStore } from '../core/tasks.js';
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
  launchFreshTaskSession?: (task: Parameters<NonNullable<ConstructorParameters<typeof RalphLoopService>[0]['launchFreshTaskSession']>>[0], prompt: string) => Promise<string>;
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
    ralphCycler: deps.ralphCycler as never,
    launchFreshTaskSession: deps.launchFreshTaskSession,
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
    expect(source).toContain('new RalphLoopService');
    expect(source).not.toContain('claimRalphLoopOwner');
    expect(source).not.toContain('ralphStopFingerprint');
    expect(source).not.toContain('handlingStopFingerprint');
  });

  test('event pipeline delegates Ralph Stop continuation ownership to the service', () => {
    const source = readFileSync(new URL('./event-pipeline.ts', import.meta.url), 'utf8');
    expect(source).toContain('new RalphLoopService');
    expect(source).not.toContain('claimRalphLoopOwner');
    expect(source).not.toContain('ralphStopFingerprint');
    expect(source).not.toContain('handlingStopFingerprint');
  });

  test('startup recovery delegates Ralph crash reconciliation ownership to the service', () => {
    const source = readFileSync(new URL('./startup-recovery.ts', import.meta.url), 'utf8');
    expect(source).toContain('new RalphLoopService');
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
      ownerRuntimeSessionId: 'runtime-new',
      ownerTranscriptPath: '/tmp/new.jsonl',
    });
  });

  test('handleStopEvent advances and launches the next Ralph runtime from the service boundary', async () => {
    const handleStop = vi.fn().mockResolvedValue({ kind: 'launch_fresh', taskId: 'task-1', text: 'continue' });
    const launchFreshTaskSession = vi.fn(async (task: ReturnType<TaskStore['createTask']>, _prompt: string) => {
      store.addSession(task.id, {
        tmuxSession: 'agent-2',
        agentType: 'claude-code',
        cwd: task.cwd,
        createdAt: new Date('2026-05-03T00:03:00Z'),
        lastStatus: 'running',
      });
      return 'agent-2';
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
      ownerRuntimeSessionId: 'runtime-1',
      ownerTranscriptPath: '/root.jsonl',
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
    expect(launchFreshTaskSession).toHaveBeenCalledWith(task, 'continue');
    expect(task.ralphLoop).toMatchObject({
      ownerSessionId: 'agent-2',
      lastHandledStopFingerprint: expect.any(String),
    });
    expect(task.ralphLoop.handlingStopFingerprint).toBeUndefined();
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
