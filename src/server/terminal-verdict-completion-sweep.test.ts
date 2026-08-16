import { afterEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('./dirty-worktree-completion-finding.js', () => ({
  surfaceDirtyWorktreeOnHeadlessCompletion: vi.fn(async () => false),
}));
import { surfaceDirtyWorktreeOnHeadlessCompletion } from './dirty-worktree-completion-finding.js';
const mockSurfaceDirty = vi.mocked(surfaceDirtyWorktreeOnHeadlessCompletion);
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import type { Anomaly, AgentEvent } from '../core/types.js';
import { buildCapacityLedger } from '../core/capacity-ledger.js';
import type { LifecycleDeps } from './agent-lifecycle.js';
import {
  autoCompleteTerminalVerdictTasks,
  TERMINAL_VERDICT_AUTO_COMPLETE_ACTOR,
  type AutoCompleteTerminalVerdictDeps,
  type TerminalVerdictMonitor,
} from './terminal-verdict-completion-sweep.js';

const T0 = new Date('2026-08-16T00:00:00.000Z');

const tmpDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  mockSurfaceDirty.mockClear();
  mockSurfaceDirty.mockResolvedValue(false);
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

async function makeAuditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kookr-terminal-verdict-'));
  tmpDirs.push(dir);
  return join(dir, 'audit.jsonl');
}

/** Minimal LifecycleDeps sufficient for `completeTask`, mirroring the sibling sweep tests. */
function lifecycleDeps(taskStore: TaskStore): LifecycleDeps {
  return {
    adapter: { stop: vi.fn(async () => undefined) },
    monitor: { unregisterAgent: vi.fn(), getAgentEvents: vi.fn(() => []) },
    taskStore,
    queue: new AttentionQueue(),
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
  } as unknown as LifecycleDeps;
}

/** Create an inProgress task with one live session; returns [taskId, agentId]. */
function makeRunningTask(taskStore: TaskStore, prompt = 'deploy convergence check'): [string, string] {
  const task = taskStore.createTask({ prompt, cwd: '/tmp' });
  const agentId = `kookr-${task.id}`;
  taskStore.addSession(task.id, {
    tmuxSession: agentId,
    agentType: 'claude-code',
    cwd: '/tmp',
    createdAt: T0,
  });
  return [task.id, agentId];
}

function needsInputAnomaly(agentId: string, subType: 'stop' | 'ask_user_question' = 'stop'): Anomaly {
  return {
    agentId,
    type: 'needs_input',
    subType,
    severity: subType === 'ask_user_question' ? 'warning' : 'info',
    explanation: 'Agent is waiting for input.',
    detectedAt: T0,
  };
}

function stopEvent(agentId: string, lastMessage: string): AgentEvent {
  return { type: 'stop', sessionId: agentId, lastMessage } as AgentEvent;
}

/**
 * Monitor stub: per-agent current anomaly + event stream. Defaults to a
 * needs_input(stop) park with a `converged` final message unless overridden.
 */
function stubMonitor(
  entries: Record<string, { anomaly: Anomaly | null; events: AgentEvent[] }>,
): TerminalVerdictMonitor {
  return {
    getCurrentAnomaly: (agentId: string) => entries[agentId]?.anomaly ?? null,
    getAgentEvents: (agentId: string) => entries[agentId]?.events ?? [],
  };
}

function deps(
  taskStore: TaskStore,
  monitor: TerminalVerdictMonitor,
  overrides: Partial<AutoCompleteTerminalVerdictDeps> = {},
): AutoCompleteTerminalVerdictDeps {
  return {
    taskStore,
    lifecycleDeps: lifecycleDeps(taskStore),
    monitor,
    ...overrides,
  };
}

describe('autoCompleteTerminalVerdictTasks', () => {
  test('completes a deploy-convergence task parked in needs_input with a converged verdict', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: needsInputAnomaly(agentId),
        events: [stopEvent(agentId, 'deploy-convergence: converged · serving=194eda77 main=194eda77')],
      },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([taskId]);
    expect(taskStore.getTask(taskId)?.status).toBe('completed');
    expect(mockSurfaceDirty).toHaveBeenCalledTimes(1);
  });

  test('AC3: the completed deploy-convergence task no longer counts as phantom / finishedAwaitingAck', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: needsInputAnomaly(agentId),
        events: [stopEvent(agentId, 'converged — prod serving 97ef54f4 == origin/main HEAD 97ef54f4')],
      },
    });

    const ledgerBefore = buildCapacityLedger(taskStore.viewTasks(), {
      now: T0.getTime(),
      maxActiveTasks: 16,
      isHungSuspect: () => false,
      isLaunching: () => false,
    });
    expect(ledgerBefore.active).toBe(1);

    await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(taskStore.getTask(taskId)?.status).toBe('completed');
    const ledgerAfter = buildCapacityLedger(taskStore.viewTasks(), {
      now: T0.getTime(),
      maxActiveTasks: 16,
      isHungSuspect: () => false,
      isLaunching: () => false,
    });
    expect(ledgerAfter.active).toBe(0);
    expect(ledgerAfter.phantomActive).toBe(0);
    expect(ledgerAfter.byClass.finishedAwaitingAck).toBe(0);
  });

  test('writes an audit row and broadcasts one alert', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: needsInputAnomaly(agentId),
        events: [stopEvent(agentId, 'converged — serving 194eda77 main 194eda77')],
      },
    });
    const auditLogPath = await makeAuditPath();
    const broadcastToAll = vi.fn();

    await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor, { auditLogPath, broadcastToAll }));

    const audit = await readFile(auditLogPath, 'utf-8');
    const row = JSON.parse(audit.trim());
    expect(row).toMatchObject({
      type: 'task.terminalSuccessAutoCompleted',
      actor: TERMINAL_VERDICT_AUTO_COMPLETE_ACTOR,
      taskId,
      reason: 'terminal_success_auto_complete',
      verdict: 'converged',
    });
    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(broadcastToAll.mock.calls[0][0]).toMatchObject({ type: 'alert', severity: 'info' });
  });

  test('AC1: a non-converged (diverging) park stays in needs_input, unchanged', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: needsInputAnomaly(agentId),
        events: [stopEvent(agentId, 'diverging: prod serving abc not yet on origin/main def, 5m into 15m grace')],
      },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('never completes a task asking a concrete question (needs_input / ask_user_question)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    // Even with a "converged" final message, an explicit AskUserQuestion park
    // carries a concrete question and must be left for the human.
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: needsInputAnomaly(agentId, 'ask_user_question'),
        events: [stopEvent(agentId, 'deploy-convergence: converged · serving=194eda77 main=194eda77')],
      },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('does not complete a task that is not parked in needs_input (still working)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: null, // healthy / working
        events: [stopEvent(agentId, 'converged — serving 194eda77 main 194eda77')],
      },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('skips a task that already raised completion_ready (owned by the FAA path)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    taskStore.setPendingSignal(taskId, { kind: 'completion_ready', raisedAt: T0.toISOString() });
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: needsInputAnomaly(agentId),
        events: [stopEvent(agentId, 'converged — serving 194eda77 main 194eda77')],
      },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  function makeAskFirstTask(taskStore: TaskStore): [string, TerminalVerdictMonitor] {
    const task = taskStore.createTask({ prompt: 'gated', cwd: '/tmp', deliveryAuthorization: 'ask-first' });
    const agentId = `kookr-${task.id}`;
    taskStore.addSession(task.id, { tmuxSession: agentId, agentType: 'claude-code', cwd: '/tmp', createdAt: T0 });
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: needsInputAnomaly(agentId),
        events: [stopEvent(agentId, 'deploy-convergence: converged · serving=194eda77 main=194eda77')],
      },
    });
    return [task.id, monitor];
  }

  test('skips an ask-first task when open-PR status cannot be confirmed clear (no predicate)', async () => {
    const taskStore = new TaskStore();
    const [taskId, monitor] = makeAskFirstTask(taskStore);

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('skips an ask-first task confirmed to be holding an open PR (delivery pending)', async () => {
    const taskStore = new TaskStore();
    const [taskId, monitor] = makeAskFirstTask(taskStore);

    const result = await autoCompleteTerminalVerdictTasks(
      deps(taskStore, monitor, { isHoldingOpenPr: () => true }),
    );

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('completes an ask-first task once delivery is confirmed clear (no open PR)', async () => {
    const taskStore = new TaskStore();
    const [taskId, monitor] = makeAskFirstTask(taskStore);

    // AC: a converged deploy-verification task with no pending delivery reaches a
    // completed, slot-releasing state without operator input.
    const result = await autoCompleteTerminalVerdictTasks(
      deps(taskStore, monitor, { isHoldingOpenPr: () => false }),
    );

    expect(result.completedTaskIds).toEqual([taskId]);
    expect(taskStore.getTask(taskId)?.status).toBe('completed');
  });

  test('skips a provider-paused task', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: needsInputAnomaly(agentId),
        events: [stopEvent(agentId, 'converged — serving 194eda77 main 194eda77')],
      },
    });

    const result = await autoCompleteTerminalVerdictTasks(
      deps(taskStore, monitor, { isProviderPaused: () => true }),
    );

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('honors the per-tick cap, draining the rest on a later tick', async () => {
    const taskStore = new TaskStore();
    const entries: Record<string, { anomaly: Anomaly | null; events: AgentEvent[] }> = {};
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const [taskId, agentId] = makeRunningTask(taskStore, `converge ${i}`);
      ids.push(taskId);
      entries[agentId] = {
        anomaly: needsInputAnomaly(agentId),
        events: [stopEvent(agentId, 'converged — serving 194eda77 main 194eda77')],
      };
    }
    const monitor = stubMonitor(entries);

    const first = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor), { maxPerTick: 2 });
    expect(first.completedTaskIds).toHaveLength(2);

    const second = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor), { maxPerTick: 2 });
    expect(second.completedTaskIds).toHaveLength(1);

    for (const id of ids) expect(taskStore.getTask(id)?.status).toBe('completed');
  });

  test('skips an active Ralph loop (its own lifecycle owns completion)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    taskStore.getTaskForMutation(taskId)!.ralphLoop = {
      prompt: 'loop',
      iterationCap: 3,
      currentIteration: 1,
      status: 'running',
      lastIterationStartedAt: T0.getTime(),
      cumulativeIterations: 1,
    };
    const monitor = stubMonitor({
      [agentId]: { anomaly: needsInputAnomaly(agentId), events: [stopEvent(agentId, 'converged — serving 194eda77 main 194eda77')] },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('does not act on a task whose only session is already completed (no live session)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    taskStore.updateSession(taskId, agentId, { lastStatus: 'completed' });
    const monitor = stubMonitor({
      [agentId]: { anomaly: needsInputAnomaly(agentId), events: [stopEvent(agentId, 'converged — serving 194eda77 main 194eda77')] },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('ignores a stale stop message when the turn has resumed (newer tool_use after the stop)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const monitor = stubMonitor({
      [agentId]: {
        anomaly: needsInputAnomaly(agentId),
        events: [
          stopEvent(agentId, 'converged — serving 194eda77 main 194eda77'),
          { type: 'tool_use', sessionId: agentId, toolName: 'Bash' } as AgentEvent,
        ],
      },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('a raced completion failure does not burn the per-tick budget and the batch continues', async () => {
    const taskStore = new TaskStore();
    const [racedId, racedAgent] = makeRunningTask(taskStore, 'raced');
    const [okId, okAgent] = makeRunningTask(taskStore, 'ok');
    const monitor = stubMonitor({
      [racedAgent]: { anomaly: needsInputAnomaly(racedAgent), events: [stopEvent(racedAgent, 'converged — serving 194eda77 main 194eda77')] },
      [okAgent]: { anomaly: needsInputAnomaly(okAgent), events: [stopEvent(okAgent, 'converged — serving 0a1b2c3d main 0a1b2c3d')] },
    });
    // Fail the FIRST completion only; the sweep must skip it and still complete the next.
    const spy = vi.spyOn(taskStore, 'completeTask');
    spy.mockImplementationOnce(() => {
      throw new Error('raced to terminal by another actor');
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor), { maxPerTick: 2 });

    expect(result.completedTaskIds).toEqual([okId]);
    expect(taskStore.getTask(racedId)?.status).toBe('inProgress');
    expect(taskStore.getTask(okId)?.status).toBe('completed');
  });

  test('does not complete a Stop that still reports active background tasks (turn is running)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const stopWithBackground = {
      type: 'stop',
      sessionId: agentId,
      lastMessage: 'deploy-convergence: converged · serving=194eda77 main=194eda77',
      activeBackgroundTaskCount: 1,
    } as AgentEvent;
    const monitor = stubMonitor({
      [agentId]: { anomaly: needsInputAnomaly(agentId), events: [stopWithBackground] },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('does not complete a Grok turn that was cancelled/shutdown (stopReason !== end_turn)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    // Grok stamps a stopReason; only `end_turn` is a success. A cancelled (Esc)
    // turn that already printed its receipt must NOT be treated as completed.
    const cancelledStop = {
      type: 'stop',
      sessionId: agentId,
      lastMessage: 'deploy-convergence: converged · serving=194eda77 main=194eda77',
      stopReason: 'cancelled',
    } as AgentEvent;
    const monitor = stubMonitor({
      [agentId]: { anomaly: needsInputAnomaly(agentId), events: [cancelledStop] },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('completes a Grok turn that ended cleanly (stopReason === end_turn)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const endTurnStop = {
      type: 'stop',
      sessionId: agentId,
      lastMessage: 'deploy-convergence: converged · serving=194eda77 main=194eda77',
      stopReason: 'end_turn',
    } as AgentEvent;
    const monitor = stubMonitor({
      [agentId]: { anomaly: needsInputAnomaly(agentId), events: [endTurnStop] },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([taskId]);
    expect(taskStore.getTask(taskId)?.status).toBe('completed');
  });

  test('fails closed when a task has more than one live session (attach race)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    // A second live session — SessionRegistry permits this after an attach race.
    const agentId2 = `${agentId}-2`;
    taskStore.addSession(taskId, { tmuxSession: agentId2, agentType: 'claude-code', cwd: '/tmp', createdAt: T0 });
    const receipt = 'deploy-convergence: converged · serving=194eda77 main=194eda77';
    const monitor = stubMonitor({
      [agentId]: { anomaly: needsInputAnomaly(agentId), events: [stopEvent(agentId, receipt)] },
      [agentId2]: { anomaly: needsInputAnomaly(agentId2), events: [stopEvent(agentId2, receipt)] },
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });

  test('re-validates after the worktree await and skips if the turn resumed (TOCTOU)', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const receipt = 'deploy-convergence: converged · serving=194eda77 main=194eda77';
    // Mutable monitor state so the awaited surfaceDirty can simulate a resume.
    const entry: { anomaly: Anomaly | null; events: AgentEvent[] } = {
      anomaly: needsInputAnomaly(agentId),
      events: [stopEvent(agentId, receipt)],
    };
    const monitor: TerminalVerdictMonitor = {
      getCurrentAnomaly: () => entry.anomaly,
      getAgentEvents: () => entry.events,
    };
    // The agent receives a follow-up and resumes DURING the worktree inspection:
    // its needs_input park clears, so it is no longer a terminal park.
    mockSurfaceDirty.mockImplementationOnce(async () => {
      entry.anomaly = null;
      return false;
    });

    const result = await autoCompleteTerminalVerdictTasks(deps(taskStore, monitor));

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
    expect(mockSurfaceDirty).toHaveBeenCalledTimes(1);
  });

  test('is a no-op without lifecycleDeps', async () => {
    const taskStore = new TaskStore();
    const [taskId, agentId] = makeRunningTask(taskStore);
    const monitor = stubMonitor({
      [agentId]: { anomaly: needsInputAnomaly(agentId), events: [stopEvent(agentId, 'converged — serving 194eda77 main 194eda77')] },
    });

    const result = await autoCompleteTerminalVerdictTasks({ taskStore, monitor });

    expect(result.completedTaskIds).toEqual([]);
    expect(taskStore.getTask(taskId)?.status).toBe('inProgress');
  });
});
