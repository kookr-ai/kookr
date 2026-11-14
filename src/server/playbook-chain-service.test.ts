import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskStore, type Task } from '../core/tasks.js';
import type { LaunchOpts } from '../shared/contracts/launch.js';
import type { AgentEvent, Anomaly } from '../core/types.js';
import {
  AutomationKillSwitchError,
  DrainModeError,
  HostLoadAdmissionError,
  PendingQueueFullError,
  QuotaHeadroomAdmissionError,
  SpawnBurstLimitError,
  type LaunchResult,
  type LaunchTaskServerOptions,
} from './launch-service.js';
import { CHAIN_IDLE_COMPLETE_MS, CHAIN_SIGNAL_CLOSE_CEILING_MS, CHAIN_SIGNAL_SETTLE_MS, PlaybookChainService } from './playbook-chain-service.js';
import type { PreparePlaybookLaunchInput, PreparedPlaybookLaunch } from './use-cases/playbook-launch.js';

const HOUR = 60 * 60_000;

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Harness around a real TaskStore. `launchTask` mimics the real launcher's
 * contract the service relies on: it creates the task with the server-only
 * `chain` stamp, then starts it with one session.
 */
function harness(opts: { launchImpl?: (o: LaunchOpts, s?: LaunchTaskServerOptions) => Promise<LaunchResult> } = {}) {
  // One clock for everything: TaskStore stamps createdAt/finishedAt with
  // `new Date()`, the service reads `now()`; both must agree.
  vi.useFakeTimers({ toFake: ['Date'] });
  let nowMs = Date.parse('2026-11-14T20:00:00.000Z');
  vi.setSystemTime(nowMs);
  const taskStore = new TaskStore();
  const anomalies = new Map<string, Anomaly | null>();
  const events = new Map<string, AgentEvent[]>();
  const subagents = new Map<string, number>();
  const launches: Array<{ opts: LaunchOpts; server: LaunchTaskServerOptions | undefined }> = [];
  const prepareInputs: PreparePlaybookLaunchInput[] = [];

  const realLaunch = async (o: LaunchOpts, s?: LaunchTaskServerOptions): Promise<LaunchResult> => {
    const task = taskStore.createTask({
      prompt: o.prompt,
      cwd: o.cwd,
      parentTaskId: o.parentTaskId,
      agentType: o.agentType === 'claude-code' || o.agentType === undefined ? 'claude-code' : 'claude-code',
      playbookId: o.playbookId,
      playbookSource: o.playbookSource,
      playbookParameterValues: o.playbookParameterValues,
      launchSource: o.launchSource,
      autoCloseOnSignal: o.autoCloseOnSignal,
      unattended: o.unattended,
      ...(s?.chain ? { chain: s.chain } : {}),
    });
    taskStore.startTask(task.id);
    taskStore.addSession(task.id, {
      tmuxSession: `kookr-${task.id}`,
      agentType: 'claude-code',
      cwd: o.cwd,
      createdAt: new Date(nowMs),
    });
    return { task: taskStore.getTask(task.id)!, queued: false } as LaunchResult;
  };
  const launchTask = vi.fn(async (o: LaunchOpts, s?: LaunchTaskServerOptions) => {
    launches.push({ opts: o, server: s });
    return (opts.launchImpl ?? realLaunch)(o, s);
  });
  const completeIdleIteration = vi.fn(async (task: Task, _how: 'signalled' | 'idle', stillIdle: () => boolean) => {
    if (!stillIdle()) return false;
    taskStore.completeTask(task.id, { source: 'unknown', reason: 'completed_normal' });
    return true;
  });
  const prepare = async (input: PreparePlaybookLaunchInput): Promise<PreparedPlaybookLaunch> => {
    prepareInputs.push(input);
    return {
      playbook: { id: input.playbookPath } as PreparedPlaybookLaunch['playbook'],
      deliveryPolicy: 'pre-authorized',
      launchOpts: {
        prompt: 'PLAYBOOK BODY',
        cwd: input.taskTargetCwd ?? input.cwd ?? '/repo',
        name: 'Research',
        playbookId: input.playbookPath,
        playbookSource: { id: input.playbookPath, scope: input.scope ?? 'project', sourceCwd: '/repo', sourceDigest: 'd' },
        playbookParameterValues: input.parameterValues,
        agentType: input.agentType,
      },
    };
  };
  const service = new PlaybookChainService({
    taskStore,
    launchTask,
    resolveAutomationProjectId: async () => 'local/repo',
    monitor: {
      getCurrentAnomaly: (id) => anomalies.get(id) ?? null,
      getAgentEvents: (id) => events.get(id) ?? [],
      getOutstandingSubagentCount: (id) => subagents.get(id) ?? 0,
    },
    completeIteration: completeIdleIteration,
    preparePlaybookLaunch: prepare,
    now: () => new Date(nowMs),
  });

  return {
    taskStore,
    service,
    launches,
    prepareInputs,
    launchTask,
    completeIdleIteration,
    advance: (ms: number) => { nowMs += ms; vi.setSystemTime(nowMs); },
    nowMs: () => nowMs,
    /** Agent parked at its prompt after a clean Stop (optionally with background work still running). */
    setIdle: (task: Task, idle: boolean, extra: { backgroundTasks?: number; subagents?: number } = {}) => {
      const id = `kookr-${task.id}`;
      anomalies.set(id, idle
        ? { agentId: id, type: 'needs_input', subType: 'stop', severity: 'info', explanation: '', detectedAt: new Date() } as Anomaly
        : null);
      events.set(id, idle
        ? [{ type: 'stop', sessionId: 's', lastMessage: 'Done.', activeBackgroundTaskCount: extra.backgroundTasks ?? 0 } as AgentEvent]
        : [{ type: 'tool_use', sessionId: 's', toolName: 'Bash' } as AgentEvent]);
      subagents.set(id, extra.subagents ?? 0);
    },
    /** Let a running iteration work for `ranMs`, then have its agent complete it. */
    finish: (task: Task, ranMs = HOUR / 2) => {
      nowMs += ranMs;
      vi.setSystemTime(nowMs);
      taskStore.completeTask(task.id, { source: 'task_self', reason: 'completed_normal' });
    },
    chainTasks: (chainId: string) => service.listChain(chainId),
  };
}

async function startResearchChain(h: ReturnType<typeof harness>, spec: { maxIterations?: number; durationMinutes?: number }) {
  const result = await h.service.startChain({
    cwd: '/repo',
    playbookPath: 'agentic-capability-research.md',
    parameterValues: { subject: 'memory-architecture' },
    spec,
    launchSource: 'websocket',
  });
  return result.task;
}

describe('PlaybookChainService.startChain', () => {
  it('stamps iteration 1 with its own id as chain id and launches it unattended, auto-closing, undeduplicated', async () => {
    const h = harness();
    const task = await startResearchChain(h, { maxIterations: 3 });
    expect(task.chain).toMatchObject({ chainId: task.id, iteration: 1, maxIterations: 3, unhealthyStreak: 0 });
    const [{ opts }] = h.launches;
    expect(opts.prompt.startsWith('## Kookr chain — iteration 1 of 3')).toBe(true);
    expect(opts.prompt).toContain('PLAYBOOK BODY');
    expect(opts).toMatchObject({ autoCloseOnSignal: true, unattended: true, disableDedup: true, launchSource: 'websocket' });
  });
});

describe('PlaybookChainService sweep', () => {
  it('runs exactly N iterations, one at a time, linked by parentTaskId', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    for (let i = 0; i < 6; i++) {
      await h.service.sweep();
      const live = h.taskStore.viewTasks().filter((t) => t.chain && t.status === 'inProgress');
      expect(live.length).toBeLessThanOrEqual(1);
      const tip = h.service.findTip(first.id)!;
      if (tip.status === 'inProgress') h.finish(tip);
    }
    await h.service.sweep();
    const members = h.chainTasks(first.id);
    expect(members.map((t) => t.chain!.iteration)).toEqual([1, 2, 3]);
    expect(members[1].parentTaskId).toBe(members[0].id);
    expect(members[2].parentTaskId).toBe(members[1].id);
    expect(members[2].chain!.ended?.reason).toBe('iterations_reached');
    expect(members[0].chain!.successorTaskId).toBe(members[1].id);
    // Successors are autonomous chain launches pinned to the tip's agent, never manual relaunches.
    const successorLaunch = h.launches[1];
    expect(successorLaunch.opts).toMatchObject({ launchSource: 'chain', parentTaskId: members[0].id, agentType: 'claude-code' });
    expect(successorLaunch.opts.userInitiatedRelaunch).toBeUndefined();
    expect(successorLaunch.server).toMatchObject({ automationProjectId: 'local/repo' });
    expect(h.prepareInputs[1]).not.toHaveProperty('parentTaskId');
    // Same playbook, parameters, source checkout and target directory as iteration 1.
    expect(h.prepareInputs[1]).toMatchObject({
      playbookPath: 'agentic-capability-research.md',
      scope: 'project',
      parameterValues: { subject: 'memory-architecture' },
      playbookSourceCwd: '/repo',
      taskTargetCwd: '/repo',
      taskTargetCwdExplicit: false,
    });
  });

  it('waits while an iteration runs and never launches twice for one boundary', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 5 });
    await h.service.sweep();
    expect(h.launches).toHaveLength(1);
    h.finish(first);
    await Promise.all([h.service.sweep(), h.service.sweep()]);
    await h.service.sweep();
    expect(h.launches).toHaveLength(2);
  });

  it('adopts a successor that already exists (crash after launch, before the link was recorded)', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 5 });
    h.finish(first);
    // Simulate: the successor was created and stamped, then the server died
    // before the predecessor recorded successorTaskId.
    h.taskStore.createTask({ prompt: 'x', cwd: '/repo', parentTaskId: first.id, chain: { ...first.chain!, iteration: 2 } });
    await h.service.sweep();
    expect(h.launches).toHaveLength(1);
  });

  it('never relaunches from an iteration whose successor was deleted', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 5 });
    h.finish(first);
    await h.service.sweep();
    const second = h.service.findTip(first.id)!;
    expect(second.chain!.iteration).toBe(2);
    h.taskStore.cancelTask(second.id, { source: 'user', reason: 'manual' });
    h.taskStore.deleteTask(second.id);
    await h.service.sweep();
    await h.service.sweep();
    expect(h.launches).toHaveLength(2);
  });

  it('ends at the first boundary after the deadline and lets the running iteration finish', async () => {
    const h = harness();
    const first = await startResearchChain(h, { durationMinutes: 60 });
    h.advance(90 * 60_000);
    await h.service.sweep();
    expect(h.service.findTip(first.id)!.status).toBe('inProgress');
    h.finish(first);
    await h.service.sweep();
    expect(h.launches).toHaveLength(1);
    expect(h.service.findTip(first.id)!.chain!.ended?.reason).toBe('deadline_reached');
  });

  it('ends the chain when the operator cancels the running iteration', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 5 });
    h.taskStore.cancelTask(first.id, { source: 'user', reason: 'manual' });
    await h.service.sweep();
    expect(h.launches).toHaveLength(1);
    expect(h.service.findTip(first.id)!.chain!.ended?.reason).toBe('iteration_cancelled');
  });

  it('keeps going after a watchdog kill, counting it as unhealthy', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 5 });
    h.taskStore.terminateTask(first.id, { reason: 'timeout' });
    await h.service.sweep();
    const tip = h.service.findTip(first.id)!;
    expect(tip.chain).toMatchObject({ iteration: 2, unhealthyStreak: 1 });
  });

  it('ends with runaway when iterations keep finishing instantly', async () => {
    const h = harness();
    const first = await startResearchChain(h, { durationMinutes: 600 });
    for (let i = 0; i < 5; i++) {
      const tip = h.service.findTip(first.id)!;
      if (tip.status === 'inProgress') h.finish(tip, 10_000);
      await h.service.sweep();
    }
    const members = h.chainTasks(first.id);
    expect(members).toHaveLength(3);
    expect(members[2].chain!.ended?.reason).toBe('runaway');
  });
});

describe('PlaybookChainService.stopChain', () => {
  it('stops after the current iteration, from any member id, recording who asked', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 5 });
    h.finish(first);
    await h.service.sweep();
    const result = h.service.stopChain(first.id, 'agent', 'no questions left');
    expect(result).toMatchObject({ ok: true, alreadyRequested: false });
    const tip = h.service.findTip(first.id)!;
    expect(tip.chain!.stopRequest).toMatchObject({ by: 'agent', reason: 'no questions left' });
    expect(h.service.stopChain(tip.id, 'operator')).toMatchObject({ ok: true, alreadyRequested: true });
    h.finish(tip);
    await h.service.sweep();
    expect(h.launches).toHaveLength(2);
    expect(h.service.findTip(first.id)!.chain!.ended).toMatchObject({ reason: 'stopped', detail: 'no questions left' });
    expect(h.service.stopChain(first.id, 'operator')).toMatchObject({ ok: false, status: 409 });
  });

  it('carries a stop that lands while the successor launch is in flight onto the new tip', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    // eslint-disable-next-line prefer-const
    let h: ReturnType<typeof harness>;
    const slowLaunch = async (o: LaunchOpts, s?: LaunchTaskServerOptions) => {
      calls++;
      if (calls === 2) await gate;
      const task = h.taskStore.createTask({ prompt: o.prompt, cwd: o.cwd, parentTaskId: o.parentTaskId, playbookSource: o.playbookSource, ...(s?.chain ? { chain: s.chain } : {}) });
      h.taskStore.startTask(task.id);
      h.taskStore.addSession(task.id, { tmuxSession: `kookr-${task.id}`, agentType: 'claude-code', cwd: o.cwd, createdAt: new Date(Date.now()) });
      return { task: h.taskStore.getTask(task.id)!, queued: false } as LaunchResult;
    };
    h = harness({ launchImpl: slowLaunch });
    const first = await startResearchChain(h, { maxIterations: 5 });
    h.finish(first);
    const sweeping = h.service.sweep();
    await Promise.resolve();
    expect(h.service.stopChain(first.id, 'operator', 'enough')).toMatchObject({ ok: true });
    release();
    await sweeping;
    const tip = h.service.findTip(first.id)!;
    expect(tip.chain!.iteration).toBe(2);
    expect(tip.chain!.stopRequest).toMatchObject({ reason: 'enough' });
  });

  it('rejects tasks that are not in a chain', () => {
    const h = harness();
    const plain = h.taskStore.createTask({ prompt: 'p', cwd: '/repo' });
    expect(h.service.stopChain(plain.id, 'operator')).toMatchObject({ ok: false, status: 409 });
    expect(h.service.stopChain('nope', 'operator')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('launch failures', () => {
  it('holds on SAFE MODE without counting, and ends after three real failures', async () => {
    let mode: 'safe' | 'broken' = 'safe';
    let calls = 0;
    // eslint-disable-next-line prefer-const
    let h: ReturnType<typeof harness>;
    const flaky = async (o: LaunchOpts, s?: LaunchTaskServerOptions): Promise<LaunchResult> => {
      calls++;
      if (calls > 1) {
        if (mode === 'safe') throw new AutomationKillSwitchError('safe_mode');
        throw new Error('playbook file vanished');
      }
      const task = h.taskStore.createTask({ prompt: o.prompt, cwd: o.cwd, playbookSource: o.playbookSource, ...(s?.chain ? { chain: s.chain } : {}) });
      h.taskStore.startTask(task.id);
      h.taskStore.addSession(task.id, { tmuxSession: `kookr-${task.id}`, agentType: 'claude-code', cwd: o.cwd, createdAt: new Date(Date.now()) });
      return { task: h.taskStore.getTask(task.id)!, queued: false } as LaunchResult;
    };
    h = harness({ launchImpl: flaky });
    const first = await startResearchChain(h, { maxIterations: 5 });
    h.finish(first);
    for (let i = 0; i < 5; i++) await h.service.sweep();
    expect(h.service.findTip(first.id)!.chain!.ended).toBeUndefined();
    mode = 'broken';
    for (let i = 0; i < 2; i++) await h.service.sweep();
    expect(h.service.findTip(first.id)!.chain!.ended).toBeUndefined();
    await h.service.sweep();
    expect(h.service.findTip(first.id)!.chain!.ended).toMatchObject({ reason: 'launch_failed', detail: 'playbook file vanished' });
  });
});

describe('idle backstop', () => {
  it('completes an iteration idle at its prompt for the hold period, then advances the chain', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.setIdle(first, true);
    await h.service.sweep();
    h.advance(CHAIN_IDLE_COMPLETE_MS - 1_000);
    await h.service.sweep();
    expect(h.completeIdleIteration).not.toHaveBeenCalled();
    h.advance(2_000);
    await h.service.sweep();
    expect(h.completeIdleIteration).toHaveBeenCalledTimes(1);
    // The agent went idle right after starting (the harness session began at
    // launch), so this immediate stall counts against the runaway breaker.
    expect(h.taskStore.getTask(first.id)!.chain!.idleClosedAfterActiveMs).toBe(0);
    await h.service.sweep();
    expect(h.service.findTip(first.id)!.chain).toMatchObject({ iteration: 2, unhealthyStreak: 1 });
  });

  it('counts an idle close after real work as healthy, so forgetful agents never end a chain', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.advance(40 * 60_000); // 40 minutes of work, then the agent stops without closing.
    h.setIdle(first, true);
    await h.service.sweep();
    h.advance(CHAIN_IDLE_COMPLETE_MS + 1_000);
    await h.service.sweep();
    expect(h.taskStore.getTask(first.id)!.chain!.idleClosedAfterActiveMs).toBe(40 * 60_000);
    await h.service.sweep();
    expect(h.service.findTip(first.id)!.chain).toMatchObject({ iteration: 2, unhealthyStreak: 0 });
  });

  it('never closes a lead parked on background work or waiting on subagents, however long it waits', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.setIdle(first, true, { backgroundTasks: 1 });
    await h.service.sweep();
    h.advance(3 * HOUR);
    await h.service.sweep();
    h.setIdle(first, true, { subagents: 2 });
    await h.service.sweep();
    h.advance(3 * HOUR);
    await h.service.sweep();
    expect(h.completeIdleIteration).not.toHaveBeenCalled();
  });

  it('skips the completion when the agent wakes up during the final check', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.setIdle(first, true);
    await h.service.sweep();
    h.advance(CHAIN_IDLE_COMPLETE_MS + 1_000);
    h.completeIdleIteration.mockImplementationOnce(async (_task: Task, _how: 'signalled' | 'idle', stillIdle: () => boolean) => {
      h.setIdle(first, false);
      return stillIdle();
    });
    await h.service.sweep();
    expect(h.taskStore.getTask(first.id)!.status).toBe('inProgress');
    expect(h.taskStore.getTask(first.id)!.chain!.idleClosedAfterActiveMs).toBeUndefined();
  });

  it('restarts the hold when the agent becomes active again', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.setIdle(first, true);
    await h.service.sweep();
    h.advance(CHAIN_IDLE_COMPLETE_MS - 1_000);
    h.setIdle(first, false);
    await h.service.sweep();
    h.setIdle(first, true);
    h.advance(2_000);
    await h.service.sweep();
    h.advance(CHAIN_IDLE_COMPLETE_MS - 5_000);
    await h.service.sweep();
    expect(h.completeIdleIteration).not.toHaveBeenCalled();
  });

  it('never completes a live AskUserQuestion', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.setIdle(first, false);
    const anomaly = { agentId: `kookr-${first.id}`, type: 'needs_input', subType: 'ask_user_question', severity: 'info', explanation: '', detectedAt: new Date() } as Anomaly;
    const svc = new PlaybookChainService({
      taskStore: h.taskStore,
      launchTask: h.launchTask,
      resolveAutomationProjectId: async () => 'local/repo',
      monitor: {
        getCurrentAnomaly: () => anomaly,
        getAgentEvents: () => [{ type: 'stop', sessionId: 's', lastMessage: '?' } as AgentEvent],
        getOutstandingSubagentCount: () => 0,
      },
      completeIteration: h.completeIdleIteration,
      now: () => new Date(h.nowMs()),
    });
    await svc.sweep();
    h.advance(CHAIN_IDLE_COMPLETE_MS * 3);
    await svc.sweep();
    expect(h.completeIdleIteration).not.toHaveBeenCalled();
  });
});

describe('signalled tips', () => {
  function signal(h: ReturnType<typeof harness>, task: Task) {
    h.taskStore.viewTasks().find((t) => t.id === task.id)!.pendingSignal = {
      kind: 'completion_ready',
      raisedAt: new Date(h.nowMs()).toISOString(),
    } as Task['pendingSignal'];
  }

  it('closes a tip that raised completion-ready once its turn has ended, without the generic review delay', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.advance(30 * 60_000); // the run itself took 30 minutes
    h.setIdle(first, true);
    signal(h, first);
    await h.service.sweep();
    expect(h.completeIdleIteration).not.toHaveBeenCalled();
    h.advance(CHAIN_SIGNAL_SETTLE_MS + 1_000);
    await h.service.sweep();
    expect(h.completeIdleIteration).toHaveBeenCalledWith(expect.objectContaining({ id: first.id }), 'signalled', expect.any(Function));
    await h.service.sweep();
    // A signalled close is a normal, healthy iteration end.
    expect(h.service.findTip(first.id)!.chain).toMatchObject({ iteration: 2, unhealthyStreak: 0 });
  });

  it('waits while the agent is still mid-turn after signalling, up to a ceiling', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.setIdle(first, false); // last event is a tool call: turn still running
    signal(h, first);
    h.advance(CHAIN_SIGNAL_SETTLE_MS + 1_000);
    await h.service.sweep();
    expect(h.completeIdleIteration).not.toHaveBeenCalled();
    h.advance(CHAIN_SIGNAL_CLOSE_CEILING_MS);
    await h.service.sweep();
    expect(h.completeIdleIteration).toHaveBeenCalledTimes(1);
  });
});

describe('successor launch recipe', () => {
  it('carries the effort and model pins, or the model tier, of the previous iteration', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.taskStore.viewTasks().find((t) => t.id === first.id)!.launchIntent = {
      schemaVersion: 'task-launch-intent.v1', agentType: 'claude-code', effort: 'high', model: 'claude-opus-5-5',
    };
    h.finish(first);
    await h.service.sweep();
    expect(h.prepareInputs[1]).toMatchObject({ effort: 'high', model: 'claude-opus-5-5', agentType: 'claude-code' });
    const second = h.service.findTip(first.id)!;
    h.taskStore.viewTasks().find((t) => t.id === second.id)!.launchIntent = {
      schemaVersion: 'task-launch-intent.v1', agentType: 'claude-code', modelTier: 'small', effort: 'low', model: 'x',
    };
    h.finish(second);
    await h.service.sweep();
    // A tier replaces raw pins (they cannot be combined).
    expect(h.prepareInputs[2]).not.toHaveProperty('effort');
    expect(h.prepareInputs[2]).not.toHaveProperty('model');
    expect(h.launches[2].opts).toMatchObject({ modelTier: 'small' });
  });

  it('reads a non-project playbook from its own scope, not the source checkout', async () => {
    const h = harness();
    const result = await h.service.startChain({
      cwd: '/repo', playbookPath: 'plugin-book.md', scope: 'plugin', parameterValues: {}, spec: { maxIterations: 2 }, launchSource: 'cli',
    });
    h.taskStore.viewTasks().find((t) => t.id === result.task.id)!.playbookSource = {
      id: 'plugin-book.md', scope: 'plugin', sourceCwd: '/plugin/playbooks', sourceDigest: 'd',
    };
    h.finish(result.task);
    await h.service.sweep();
    expect(h.prepareInputs[1]).toMatchObject({ scope: 'plugin', playbookSourceCwd: '/repo', playbookPath: 'plugin-book.md' });
  });
});

describe('launch errors that only hold a chain', () => {
  const holds: Array<[string, () => Error]> = [
    ['SAFE MODE', () => new AutomationKillSwitchError('safe_mode')],
    ['project automation pause', () => new AutomationKillSwitchError('project_automation')],
    ['drain mode', () => Object.create(DrainModeError.prototype) as Error],
    ['host load', () => Object.create(HostLoadAdmissionError.prototype) as Error],
    ['quota headroom', () => Object.create(QuotaHeadroomAdmissionError.prototype) as Error],
    ['spawn burst', () => Object.create(SpawnBurstLimitError.prototype) as Error],
    ['pending queue full', () => Object.create(PendingQueueFullError.prototype) as Error],
  ];
  it.each(holds)('%s is retried without counting toward launch_failed', async (_label, makeError) => {
    let calls = 0;
    // eslint-disable-next-line prefer-const
    let h: ReturnType<typeof harness>;
    h = harness({
      launchImpl: async (o, s) => {
        calls++;
        if (calls > 1) throw makeError();
        const task = h.taskStore.createTask({ prompt: o.prompt, cwd: o.cwd, playbookSource: o.playbookSource, ...(s?.chain ? { chain: s.chain } : {}) });
        h.taskStore.startTask(task.id);
        h.taskStore.addSession(task.id, { tmuxSession: `kookr-${task.id}`, agentType: 'claude-code', cwd: o.cwd, createdAt: new Date(Date.now()) });
        return { task: h.taskStore.getTask(task.id)!, queued: false } as LaunchResult;
      },
    });
    const first = await startResearchChain(h, { maxIterations: 5 });
    h.finish(first);
    for (let i = 0; i < 6; i++) await h.service.sweep();
    expect(h.service.findTip(first.id)!.chain!.ended).toBeUndefined();
    expect(calls).toBe(7);
  });

  it('resets the failure count after a successful launch', async () => {
    const plan = ['ok', 'fail', 'fail', 'ok', 'fail', 'fail', 'ok'];
    let call = 0;
    // eslint-disable-next-line prefer-const
    let h: ReturnType<typeof harness>;
    h = harness({
      launchImpl: async (o, s) => {
        const step = plan[call++] ?? 'ok';
        if (step === 'fail') throw new Error('transient');
        const task = h.taskStore.createTask({ prompt: o.prompt, cwd: o.cwd, parentTaskId: o.parentTaskId, playbookSource: o.playbookSource, ...(s?.chain ? { chain: s.chain } : {}) });
        h.taskStore.startTask(task.id);
        h.taskStore.addSession(task.id, { tmuxSession: `kookr-${task.id}`, agentType: 'claude-code', cwd: o.cwd, createdAt: new Date(Date.now()) });
        return { task: h.taskStore.getTask(task.id)!, queued: false } as LaunchResult;
      },
    });
    const first = await startResearchChain(h, { maxIterations: 5 });
    h.finish(first);
    for (let i = 0; i < 3; i++) await h.service.sweep(); // fail, fail, ok
    const second = h.service.findTip(first.id)!;
    expect(second.chain!.iteration).toBe(2);
    h.finish(second);
    for (let i = 0; i < 3; i++) await h.service.sweep(); // fail, fail, ok — would end if the count carried over
    expect(h.service.findTip(first.id)!.chain).toMatchObject({ iteration: 3 });
    expect(h.service.findTip(first.id)!.chain!.ended).toBeUndefined();
  });

  it('does not double-count a launch that created the task and then threw', async () => {
    let calls = 0;
    // eslint-disable-next-line prefer-const
    let h: ReturnType<typeof harness>;
    h = harness({
      launchImpl: async (o, s) => {
        calls++;
        const task = h.taskStore.createTask({ prompt: o.prompt, cwd: o.cwd, parentTaskId: o.parentTaskId, playbookSource: o.playbookSource, ...(s?.chain ? { chain: s.chain } : {}) });
        if (calls > 1) {
          // The real launcher marks a task whose session never started terminal.
          h.taskStore.terminateTask(task.id, { reason: 'unknown' });
          throw new Error('agent failed to boot');
        }
        h.taskStore.startTask(task.id);
        h.taskStore.addSession(task.id, { tmuxSession: `kookr-${task.id}`, agentType: 'claude-code', cwd: o.cwd, createdAt: new Date(Date.now()) });
        return { task: h.taskStore.getTask(task.id)!, queued: false } as LaunchResult;
      },
    });
    const first = await startResearchChain(h, { maxIterations: 10 });
    h.finish(first);
    for (let i = 0; i < 6; i++) await h.service.sweep();
    const members = h.chainTasks(first.id);
    // Each stillborn task counts once (as never started); the third in a row ends the chain.
    expect(members.map((t) => t.chain!.iteration)).toEqual([1, 2, 3, 4]);
    expect(members[0].chain!.successorTaskId).toBe(members[1].id);
    expect(members[3].chain!.ended?.reason).toBe('launch_failed');
  });
});

describe('idle backstop races', () => {
  it('skips the close when the agent signals during the dirty-worktree check', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.setIdle(first, true);
    await h.service.sweep();
    h.advance(CHAIN_IDLE_COMPLETE_MS + 1_000);
    h.completeIdleIteration.mockImplementationOnce(async (_task: Task, _how: 'signalled' | 'idle', stillValid: () => boolean) => {
      h.taskStore.viewTasks().find((t) => t.id === first.id)!.pendingSignal = {
        kind: 'completion_ready', raisedAt: new Date(Date.now()).toISOString(),
      } as Task['pendingSignal'];
      return stillValid();
    });
    await h.service.sweep();
    expect(h.taskStore.getTask(first.id)!.status).toBe('inProgress');
  });
});

describe('documented thresholds', () => {
  it('match the values the docs quote', () => {
    expect(CHAIN_IDLE_COMPLETE_MS).toBe(5 * 60_000);
    expect(CHAIN_SIGNAL_SETTLE_MS).toBe(30_000);
    expect(CHAIN_SIGNAL_CLOSE_CEILING_MS).toBe(10 * 60_000);
  });

  it('does not close a signalled tip 29 s after the signal, does at 31 s', async () => {
    const h = harness();
    const first = await startResearchChain(h, { maxIterations: 3 });
    h.advance(30 * 60_000);
    h.setIdle(first, true);
    h.taskStore.viewTasks().find((t) => t.id === first.id)!.pendingSignal = {
      kind: 'completion_ready', raisedAt: new Date(Date.now()).toISOString(),
    } as Task['pendingSignal'];
    h.advance(29_000);
    await h.service.sweep();
    expect(h.completeIdleIteration).not.toHaveBeenCalled();
    h.advance(2_000);
    await h.service.sweep();
    expect(h.completeIdleIteration).toHaveBeenCalledTimes(1);
  });
});

