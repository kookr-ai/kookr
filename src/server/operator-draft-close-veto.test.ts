/**
 * Regression: a task must not be closed while the operator is writing in it.
 *
 * Incident (task 1df6560c, 2026-11-25): the operator was writing the next
 * prompt in a task's terminal. The agent had finished its turn and raised
 * `completion_ready`; five minutes later the capacity-pressure soft TTL
 * force-completed the task and the half-written prompt was lost. It happened
 * four times on the same task. The agent was idle at its prompt, so the
 * live-turn veto did not fire, and the pane check did not recognise a composer
 * holding typed text.
 *
 * These tests drive the real path end to end: the operator's keystrokes go
 * through a real `SessionBridge` (as the dashboard terminal sends them), then
 * the real close paths run. No test seam tells a close path about the draft:
 * it has to learn it from the keystrokes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../core/tasks.js';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';
import { SessionBridge } from './session-bridge.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { reclaimAgedFinishedAwaitingAckTasks } from './finished-awaiting-ack-ttl-sweep.js';
import { reapAwaitingPollFinishedAwaitingAckTasks } from './finished-awaiting-ack-ack-reaper.js';
import { autoCloseStaleCompletionReadyTasks } from './completion-ready-sweep.js';
import { ReapWarningCoordinator } from '../core/reap-warning-coordinator.js';
import type { LifecycleDeps } from './agent-lifecycle.js';

vi.mock('../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./use-cases/request-task-reflect.js', () => ({
  removeReflectWorktree: vi.fn().mockResolvedValue(true),
}));
vi.mock('./dirty-worktree-completion-finding.js', () => ({
  surfaceDirtyWorktreeOnHeadlessCompletion: vi.fn().mockResolvedValue(undefined),
}));

const SOFT_TTL_MS = 5 * 60_000;
const HARD_TTL_MS = 15 * 60_000;

class FakeWs {
  public readyState = 1;
  public OPEN = 1;
  public bufferedAmount = 0;
  public protocol = '';
  public sent: Array<Buffer | string> = [];
  private listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  send(payload: Buffer | string): void { this.sent.push(payload); }
  close(): void { this.readyState = 3; this.emit('close'); }
  on(event: string, cb: (...a: unknown[]) => void): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }
}

let sessionCounter = 0;

/** A live terminal for a fresh session id, with the operator's keyboard on it. */
async function openTerminal(): Promise<{
  sessionId: string;
  /** Keystrokes as xterm sends them (text frame). */
  type: (text: string) => Promise<void>;
  /** A dashboard paste frame. */
  paste: (text: string) => Promise<void>;
  close: () => void;
}> {
  sessionCounter += 1;
  const sessionId = `kookr-draft-${sessionCounter}`;
  const backend = new FakeTerminalBackend();
  await backend.createSession({ id: sessionId, command: 'claude', args: [] });
  const ws = new FakeWs();
  const bridge = new SessionBridge(sessionId, ws as unknown as never, backend);
  await bridge.start();
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    sessionId,
    type: async (text) => { ws.emit('message', Buffer.from(text), false); await settle(); },
    paste: async (text) => {
      ws.emit('message', Buffer.from(JSON.stringify({ type: 'paste', text })), false);
      await settle();
    },
    close: () => ws.close(),
  };
}

function finishedTask(sessionId: string, signalAgeMs: number, overrides: Partial<Task> = {}): Task {
  return aTask({
    id: `task-${sessionId}`,
    status: 'inProgress',
    // The agent finished its turn and sits idle at its prompt: no live turn.
    sessions: [aSession({ tmuxSession: sessionId, lastStatus: 'inProgress', lastTurnState: 'completed_turn' })],
    pendingSignal: {
      kind: 'completion_ready',
      raisedAt: new Date(Date.now() - signalAgeMs).toISOString(),
    },
    ...overrides,
  });
}

function makeTaskStore(tasks: Task[]) {
  return {
    listTasks: vi.fn(() => tasks),
    viewTasks: vi.fn(() => tasks),
    getTask: vi.fn((id: string) => tasks.find((t) => t.id === id)),
    completeTask: vi.fn(),
    updateSession: vi.fn(),
    updateSessionWorktreeHealth: vi.fn(),
    setCriteriaVerdict: vi.fn(),
    clearPendingSignal: vi.fn(),
  } as any;
}

function makeLifecycleDeps(taskStore: any): LifecycleDeps {
  return {
    adapter: { stop: vi.fn().mockResolvedValue(undefined) },
    monitor: { unregisterAgent: vi.fn() },
    taskStore,
    interactionLog: { append: vi.fn().mockResolvedValue(undefined) } as any,
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
    queue: { purgeTask: vi.fn() },
    issueClaimRegistry: { safeReleaseAllFor: vi.fn().mockReturnValue([]) },
    onTaskOutcome: vi.fn(),
  };
}

/** The incident's close path: capacity-pressure soft TTL (#2355). */
async function runSoftTtlSweep(taskStore: any, auditLogPath: string) {
  return reclaimAgedFinishedAwaitingAckTasks(
    { taskStore, lifecycleDeps: makeLifecycleDeps(taskStore), auditLogPath, isHoldingOpenPr: () => false },
    { ttlMs: HARD_TTL_MS, softTtlMs: SOFT_TTL_MS, capacityAllowsEarlyReclaim: true },
  );
}

describe('a task is never closed while the operator has an unsent draft in it', () => {
  let auditDir: string;
  let auditLogPath: string;
  const terminals: Array<{ close: () => void }> = [];

  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'operator-draft-veto-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
  });
  afterEach(async () => {
    for (const t of terminals.splice(0)) t.close();
    vi.useRealTimers();
    await rm(auditDir, { recursive: true, force: true });
  });

  async function terminal() {
    const t = await openTerminal();
    terminals.push(t);
    return t;
  }

  it('capacity-pressure soft TTL: the incident — typing the next prompt keeps the task open', async () => {
    const t = await terminal();
    await t.type('Peux-tu aussi ajouter un assistant de configuration pour');
    const task = finishedTask(t.sessionId, SOFT_TTL_MS + 30_000);
    const taskStore = makeTaskStore([task]);

    const result = await runSoftTtlSweep(taskStore, auditLogPath);

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(result.deferredTaskIds).toEqual([task.id]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('hard TTL: an unsent draft also holds the strict reclaim', async () => {
    const t = await terminal();
    await t.type('une phrase pas finie');
    const task = finishedTask(t.sessionId, HARD_TTL_MS + 60_000);
    const taskStore = makeTaskStore([task]);

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps: makeLifecycleDeps(taskStore), auditLogPath, isHoldingOpenPr: () => false },
      { ttlMs: HARD_TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('a pasted draft counts too (dashboard paste frame, multi-line)', async () => {
    const t = await terminal();
    await t.paste('ligne 1\nligne 2\nligne 3');
    const task = finishedTask(t.sessionId, SOFT_TTL_MS + 30_000);
    const taskStore = makeTaskStore([task]);

    const result = await runSoftTtlSweep(taskStore, auditLogPath);

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('a ten-minute pause mid-prompt does not lift the veto', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = await terminal();
    await t.type('je réfléchis à la suite');
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const task = finishedTask(t.sessionId, SOFT_TTL_MS + 30_000);
    const taskStore = makeTaskStore([task]);

    const result = await runSoftTtlSweep(taskStore, auditLogPath);

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('meta playbook auto-complete: an unsent draft holds the close', async () => {
    const t = await terminal();
    await t.type('consigne pour l\'orchestrateur');
    const metaTtlMs = 12 * 60_000;
    const task = finishedTask(t.sessionId, metaTtlMs + 60_000, {
      playbookId: 'cross-repo-orchestrator.md',
      name: 'Cross-Repo Autonomous Orchestrator',
    });
    task.pendingSignal = { ...task.pendingSignal!, source: 'http' };
    const taskStore = makeTaskStore([task]);

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      // Unknown PR state: the strict path skips the task, only the meta path could close it.
      { taskStore, lifecycleDeps: makeLifecycleDeps(taskStore), auditLogPath, isHoldingOpenPr: () => undefined },
      { ttlMs: HARD_TTL_MS, metaAutoCompleteTtlMs: metaTtlMs },
    );

    expect(result.autoCompletedTaskIds).toEqual([]);
    expect(result.deferredTaskIds).toEqual([task.id]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('FAA ack-path reaper: never warns-then-reaps a task holding a draft', async () => {
    const t = await terminal();
    await t.type('encore une question');
    const task = finishedTask(t.sessionId, SOFT_TTL_MS + 60_000);
    const taskStore = makeTaskStore([task]);
    const coordinator = new ReapWarningCoordinator();
    const deps = {
      taskStore,
      coordinator,
      lifecycleDeps: makeLifecycleDeps(taskStore),
      auditLogPath,
      isHoldingOpenPr: () => false as const,
      getEnabled: () => true,
      getDeadlineMs: () => SOFT_TTL_MS,
      getGraceMs: () => 60_000,
    };

    await reapAwaitingPollFinishedAwaitingAckTasks(deps);
    const second = await reapAwaitingPollFinishedAwaitingAckTasks(deps, {
      now: new Date(Date.now() + 2 * 60_000),
    });

    expect(second.reapedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('completion-ready TTL drain: an unsent draft holds the close', async () => {
    const t = await terminal();
    await t.type('attends, ne ferme pas');
    const task = finishedTask(t.sessionId, 3 * 60 * 60_000);
    const taskStore = makeTaskStore([task]);

    const result = await autoCloseStaleCompletionReadyTasks(
      { taskStore, lifecycleDeps: makeLifecycleDeps(taskStore), auditLogPath },
      { thresholdMs: 60_000, ttlMs: 60 * 60_000 },
    );

    expect(result.closedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  // The veto must not hold a slot once the operator is done typing.

  it('after the prompt is submitted (Enter), the finished task is reclaimed as before', async () => {
    const t = await terminal();
    await t.type('merci, c\'est parfait\r');
    const task = finishedTask(t.sessionId, SOFT_TTL_MS + 30_000);
    const taskStore = makeTaskStore([task]);

    const result = await runSoftTtlSweep(taskStore, auditLogPath);

    expect(result.reclaimedTaskIds).toEqual([task.id]);
  });

  it('after the draft is erased (Ctrl-U), the finished task is reclaimed as before', async () => {
    const t = await terminal();
    await t.type('finalement non\u0015');
    const task = finishedTask(t.sessionId, SOFT_TTL_MS + 30_000);
    const taskStore = makeTaskStore([task]);

    const result = await runSoftTtlSweep(taskStore, auditLogPath);

    expect(result.reclaimedTaskIds).toEqual([task.id]);
  });

  it('xterm focus and device-attribute replies alone are not a draft', async () => {
    const t = await terminal();
    await t.type('\u001b[I\u001b[?1;2c\u001b[O');
    const task = finishedTask(t.sessionId, SOFT_TTL_MS + 30_000);
    const taskStore = makeTaskStore([task]);

    const result = await runSoftTtlSweep(taskStore, auditLogPath);

    expect(result.reclaimedTaskIds).toEqual([task.id]);
  });

  it('a draft untouched for over an hour stops holding the slot', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = await terminal();
    await t.type('brouillon oublié');
    vi.setSystemTime(Date.now() + 61 * 60_000);
    const task = finishedTask(t.sessionId, SOFT_TTL_MS + 30_000);
    const taskStore = makeTaskStore([task]);

    const result = await runSoftTtlSweep(taskStore, auditLogPath);

    expect(result.reclaimedTaskIds).toEqual([task.id]);
  });

  it('a draft in another task does not protect this one', async () => {
    const typing = await terminal();
    const idle = await terminal();
    await typing.type('je tape ailleurs');
    const task = finishedTask(idle.sessionId, SOFT_TTL_MS + 30_000);
    const taskStore = makeTaskStore([task]);

    const result = await runSoftTtlSweep(taskStore, auditLogPath);

    expect(result.reclaimedTaskIds).toEqual([task.id]);
  });
});
