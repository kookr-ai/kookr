import { randomUUID } from 'node:crypto';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import { generateCompletionDigest } from '../core/completion-digest.js';
import type { RalphCycler } from '../core/ralph-cycler.js';
import { nowISO, type DeferredInteractionLogWriter } from '../core/interaction-log.js';
import {
  appendIterationRecord,
  type RalphIterationRecord,
} from '../core/ralph-iteration-log.js';
import { isStopFromMainTaskSession, ralphStopFingerprint } from './ralph-stop.js';
import type { Monitor } from '../core/monitor.js';
import {
  claimRalphLoopOwner,
  type RalphLoopState,
  type RalphLoopStatus,
  type SessionInfo,
  type Task,
  type TaskStore,
} from '../core/tasks.js';
import type { TokenTracker } from '../core/token-tracker.js';
import type { AgentEvent, TokenUsage } from '../core/types.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';

export interface RalphLoopRequest {
  prompt: string;
  iterationCap: number;
  stopPredicate?: string;
  zeroDiffConvergence?: { consecutiveIterations: number };
  costCapUsd?: number;
}

export type RalphLoopValidation =
  | { ok: true; value: RalphLoopRequest }
  | { ok: false; error: string };

export type RalphLoopServiceResult<T> =
  | { ok: true; value: T; changed: boolean }
  | { ok: false; status: 400 | 404 | 409; body: Record<string, unknown> };

export interface RalphLoopServiceDeps {
  taskStore: TaskStore;
  monitor: Monitor;
  serverCwd: string;
  broadcastToAll: (msg: ServerMessage) => void;
  interactionLog: DeferredInteractionLogWriter | undefined;
  ralphCycler: RalphCycler | undefined;
  terminalBackend: TerminalBackend;
  tokenTracker: TokenTracker;
  launchFreshTaskSession: (task: Task, prompt: string, opts?: { tmuxName?: string }) => Promise<string>;
  completeTask: (taskId: string) => Promise<void>;
}

export interface RalphStopHandlingOptions {
  cumulativeCostUsd?: number | null | Promise<number | null>;
}

export interface RalphReconcileSummary {
  /** Tasks examined (had `ralphLoop.status === 'running'`). */
  examined: number;
  /** Tasks left alone because at least one live session survived. */
  preserved: number;
  /** Tasks whose loops were terminated as `failed` due to no live session. */
  failed: number;
  /** Per-task outcomes for logging / debugging. Bounded by `examined`. */
  perTask: Array<{
    taskId: string;
    outcome: 'preserved' | 'failed';
    iterationNumber: number;
  }>;
}

export interface ReconcileRalphLoopsOptions {
  /**
   * Test seam: replaces the JSONL writer so unit tests don't need a real
   * filesystem and so we can assert exactly what records were written.
   */
  appendIterationRecord?: typeof appendIterationRecord;
  /** Test seam: clock for the `endedAt` field on the crash record. */
  now?: () => number;
  /**
   * Test seam: substitute the startup liveness probe so unit tests don't
   * have to drive a real TerminalBackend. The default uses
   * `terminalBackend.isAlive` with a 500 ms per-probe timeout.
   */
  probeStartupLiveness?: (
    task: Task,
    backend: TerminalBackend,
  ) => Promise<SessionInfo | null>;
}

/** Per-probe timeout for `probeStartupLiveness` (ms). Hardcoded; not configurable. */
const STARTUP_PROBE_TIMEOUT_MS = 500;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Startup-only liveness probe. Iterates a task's sessions newest-first and
 * returns the first session whose backing process is probe-confirmed alive.
 *
 * Independent from the runtime `findLiveSession` helper because this one
 * carries a per-probe timeout — adding the timeout to the runtime helper
 * would risk misclassifying slow-but-alive sessions on the cycler hot path.
 *
 * Coverage: catches the dtach-master-killed phantom shape (the WSL/OS-crash
 * case). Does not catch the agent-child-exited phantom — see
 * docs/rfc/rfc-ralph-loop-crash-restart-recovery.md.
 */
export async function probeStartupLiveness(
  task: Task,
  backend: TerminalBackend,
): Promise<SessionInfo | null> {
  const candidates = task.sessions.filter(isLiveRalphSession);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const session = candidates[i]!;
    const alive = await withTimeout(
      backend.isAlive(session.tmuxSession).catch(() => false),
      STARTUP_PROBE_TIMEOUT_MS,
      false,
    );
    if (alive) return session;
  }
  return null;
}

function sameTokenUsage(a: TokenUsage | undefined, b: TokenUsage): boolean {
  return (
    a !== undefined &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheWriteTokens === b.cacheWriteTokens &&
    a.costUsd === b.costUsd
  );
}

export function validateRalphLoopRequest(body: {
  prompt?: unknown;
  iterationCap?: unknown;
  stopPredicate?: unknown;
  zeroDiffConvergence?: unknown;
  costCapUsd?: unknown;
}): RalphLoopValidation {
  if (typeof body.prompt !== 'string' || body.prompt.trim().length === 0) {
    return { ok: false, error: 'prompt is required and must be a non-empty string' };
  }
  if (typeof body.iterationCap !== 'number' || !Number.isInteger(body.iterationCap) || body.iterationCap <= 0) {
    return { ok: false, error: 'iterationCap is required and must be a positive integer' };
  }
  if (body.stopPredicate !== undefined && typeof body.stopPredicate !== 'string') {
    return { ok: false, error: 'stopPredicate, when present, must be a string' };
  }
  if (body.zeroDiffConvergence !== undefined) {
    if (!isPlainObject(body.zeroDiffConvergence)) {
      return { ok: false, error: 'zeroDiffConvergence, when present, must be an object' };
    }
    const consecutiveIterations = body.zeroDiffConvergence.consecutiveIterations;
    if (
      typeof consecutiveIterations !== 'number'
      || !Number.isInteger(consecutiveIterations)
      || consecutiveIterations <= 0
    ) {
      return {
        ok: false,
        error: 'zeroDiffConvergence.consecutiveIterations must be a positive integer',
      };
    }
  }
  if (
    body.costCapUsd !== undefined
    && (
      typeof body.costCapUsd !== 'number'
      || !Number.isFinite(body.costCapUsd)
      || body.costCapUsd <= 0
    )
  ) {
    return { ok: false, error: 'costCapUsd, when present, must be a positive finite number' };
  }

  return {
    ok: true,
    value: {
      prompt: body.prompt,
      iterationCap: body.iterationCap,
      ...(body.stopPredicate !== undefined ? { stopPredicate: body.stopPredicate } : {}),
      ...(body.zeroDiffConvergence !== undefined
        ? {
            zeroDiffConvergence: {
              consecutiveIterations: body.zeroDiffConvergence.consecutiveIterations as number,
            },
          }
        : {}),
      ...(body.costCapUsd !== undefined ? { costCapUsd: body.costCapUsd } : {}),
    },
  };
}

export class RalphLoopService {
  private readonly deps: RalphLoopServiceDeps;

  constructor(deps: RalphLoopServiceDeps) {
    this.deps = deps;
  }

  async startLoop(task: Task, input: RalphLoopRequest): Promise<RalphLoopServiceResult<RalphLoopState>> {
    assignRalphLoop(task, input);
    await this.claimLatestLiveOwner(task);
    task.updatedAt = new Date();

    await this.catchUpFromLatestStop(task);
    return { ok: true, value: task.ralphLoop!, changed: true };
  }

  async attachLoop(task: Task, input: RalphLoopRequest): Promise<RalphLoopServiceResult<RalphLoopState>> {
    if (task.ralphLoop && (task.ralphLoop.status === 'running' || task.ralphLoop.status === 'paused')) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'task already has an active Ralph loop',
          status: task.ralphLoop.status,
          currentIteration: task.ralphLoop.currentIteration,
        },
      };
    }

    return this.startLoop(task, input);
  }

  cancelLoop(task: Task): RalphLoopServiceResult<RalphLoopStatus> {
    const loop = task.ralphLoop;
    if (!loop) return missingLoop();

    if (loop.status === 'running' || loop.status === 'paused') {
      loop.status = 'cancelled';
      task.updatedAt = new Date();
      return { ok: true, value: loop.status, changed: true };
    }

    return { ok: true, value: loop.status, changed: false };
  }

  completeLoop(task: Task): RalphLoopServiceResult<RalphLoopStatus> {
    const loop = task.ralphLoop;
    if (!loop) return missingLoop();

    if (loop.status === 'running' || loop.status === 'paused') {
      loop.status = 'completed';
      task.updatedAt = new Date();
      return { ok: true, value: loop.status, changed: true };
    }

    if (loop.status === 'completed') {
      return { ok: true, value: loop.status, changed: false };
    }

    return {
      ok: false,
      status: 409,
      body: {
        error: `cannot complete Ralph loop with status ${loop.status}`,
        status: loop.status,
      },
    };
  }

  async finalizeCompletedLoopStop(task: Task, sessionId: string, event: AgentEvent): Promise<boolean> {
    if (!task.ralphLoop || task.ralphLoop.status !== 'completed') return false;
    if (event.type !== 'stop') return false;
    if (!isStopFromMainTaskSession(task, sessionId, event)) return false;

    const currentTask = this.deps.taskStore.getTask(task.id);
    if (!currentTask) return false;
    const completeTask = this.deps.completeTask;
    let finalizeTask: ((taskId: string) => Promise<void>) | undefined;
    if (currentTask.status === 'inProgress') {
      if (!completeTask) return false;
      finalizeTask = completeTask;
    }

    if (!currentTask.completionDigest) {
      const events = this.deps.monitor.getAgentEvents(sessionId);
      this.deps.taskStore.setCompletionDigest(task.id, generateCompletionDigest(events));
    }

    if (finalizeTask) await finalizeTask(task.id);

    return true;
  }

  async updatePrompt(task: Task, prompt: unknown): Promise<RalphLoopServiceResult<RalphLoopState>> {
    const loop = task.ralphLoop;
    if (!loop) return missingLoop();
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      return { ok: false, status: 400, body: { error: 'prompt is required and must be a non-empty string' } };
    }
    if (loop.status !== 'running' && loop.status !== 'paused') {
      return {
        ok: false,
        status: 409,
        body: {
          error: `cannot update Ralph prompt in terminal status: ${loop.status}`,
          status: loop.status,
        },
      };
    }

    const previousPrompt = loop.prompt;
    loop.prompt = prompt;
    task.updatedAt = new Date();

    await this.deps.interactionLog?.append({
      type: 'ralph_prompt_updated',
      taskId: task.id,
      status: loop.status,
      previousPrompt,
      prompt: loop.prompt,
      timestamp: nowISO(),
    });

    return { ok: true, value: loop, changed: true };
  }

  pauseLoop(task: Task): RalphLoopServiceResult<RalphLoopState> {
    const loop = task.ralphLoop;
    if (!loop) return missingLoop();
    if (isTerminalRalphStatus(loop.status)) {
      return {
        ok: false,
        status: 409,
        body: { error: `cannot pause Ralph loop in terminal status: ${loop.status}`, status: loop.status },
      };
    }

    if (loop.status === 'running') {
      loop.status = 'paused';
      task.updatedAt = new Date();
      return { ok: true, value: loop, changed: true };
    }

    return { ok: true, value: loop, changed: false };
  }

  async resumeLoop(task: Task): Promise<RalphLoopServiceResult<RalphLoopState>> {
    const loop = task.ralphLoop;
    if (!loop) return missingLoop();
    if (isTerminalRalphStatus(loop.status)) {
      return {
        ok: false,
        status: 409,
        body: { error: `cannot resume Ralph loop in terminal status: ${loop.status}`, status: loop.status },
      };
    }

    const liveSessionId = await this.findLiveSession(task);
    if (!liveSessionId) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'cannot resume Ralph loop because no live agent session remains; conversation context is lost, so start a new task or attach a new loop to a new task',
          status: loop.status,
        },
      };
    }

    if (loop.status === 'paused') {
      const liveSession = task.sessions.find((s) => s.tmuxSession === liveSessionId);
      claimRalphLoopOwner(task, liveSession, { allowTransfer: loop.ownerSessionId !== liveSessionId });
      loop.status = 'running';
      task.updatedAt = new Date();
      await this.catchUpFromLatestStop(task);
      return { ok: true, value: loop, changed: true };
    }

    return { ok: true, value: loop, changed: false };
  }

  async handleStopEvent(
    task: Task,
    sessionId: string,
    event: AgentEvent,
    options: RalphStopHandlingOptions = {},
  ): Promise<void> {
    if (!task.ralphLoop || task.ralphLoop.status !== 'running') return;
    if (!this.deps.ralphCycler) return;
    if (!isStopFromMainTaskSession(task, sessionId, event)) return;

    const events = this.deps.monitor.getAgentEvents(sessionId);
    const stopFingerprint = ralphStopFingerprint(sessionId, events, event);
    await this.handleStopFingerprint(task, sessionId, stopFingerprint, options);
  }

  async reconcileStartupLoops(
    opts: ReconcileRalphLoopsOptions = {},
  ): Promise<RalphReconcileSummary> {
    const writeRecord = opts.appendIterationRecord ?? appendIterationRecord;
    const now = (opts.now ?? Date.now)();
    const probe = opts.probeStartupLiveness ?? probeStartupLiveness;
    const summary: RalphReconcileSummary = {
      examined: 0,
      preserved: 0,
      failed: 0,
      perTask: [],
    };

    for (const task of this.deps.taskStore.getAllTasks()) {
      const loop = task.ralphLoop;
      if (!loop || loop.status !== 'running') continue;

      summary.examined++;

      const liveSession = await probe(task, this.deps.terminalBackend);
      if (liveSession) {
        claimRalphLoopOwner(task, liveSession, { allowTransfer: !hasLiveRalphOwner(task) });
        summary.preserved++;
        summary.perTask.push({
          taskId: task.id,
          outcome: 'preserved',
          iterationNumber: loop.currentIteration,
        });
        continue;
      }

      // No live session: close the loop. Persist the crash record before
      // mutating loop state so a partial write still leaves an audit trail.
      const startedAt = loop.lastIterationStartedAt > 0 ? loop.lastIterationStartedAt : now;
      const record: RalphIterationRecord = {
        iterationNumber: loop.currentIteration,
        startedAt,
        endedAt: now,
        exitReason: 'kookr_crash',
        cumulativeCostUsd: null,
        gitBaselineRef: null,
        diffStats: null,
      };
      try {
        await writeRecord(task.cwd, record);
      } catch (err) {
        console.warn(
          `[ralph-recovery] iteration log append failed for task ${task.id}:`,
          err,
        );
      }

      loop.status = 'failed';
      task.updatedAt = new Date(now);
      summary.failed++;
      summary.perTask.push({
        taskId: task.id,
        outcome: 'failed',
        iterationNumber: loop.currentIteration,
      });
    }

    return summary;
  }

  private async claimLatestLiveOwner(task: Task): Promise<void> {
    const ownerSessionId = await this.findLiveSession(task);
    const ownerSession = ownerSessionId
      ? task.sessions.find((s) => s.tmuxSession === ownerSessionId)
      : undefined;
    claimRalphLoopOwner(task, ownerSession);
  }

  private async findLiveSession(task: Task): Promise<string | null> {
    const candidates = task.sessions.filter(isLiveRalphSession).map((s) => s.tmuxSession);
    if (candidates.length === 0) return null;
    if (!this.deps.terminalBackend) return candidates[candidates.length - 1] ?? null;

    for (let i = candidates.length - 1; i >= 0; i--) {
      const id = candidates[i];
      try {
        if (await this.deps.terminalBackend.isAlive(id)) return id;
      } catch {
        // Treat backend probe failures like dead sessions for this control path:
        // resuming without a live PTY would falsely imply conversation context survived.
      }
    }
    return null;
  }

  private async catchUpFromLatestStop(task: Task): Promise<void> {
    if (!task.ralphLoop || task.ralphLoop.status !== 'running') return;
    if (!this.deps.ralphCycler) return;

    const sessionId = await this.findLiveSession(task);
    if (!sessionId) return;

    const events = this.deps.monitor.getAgentEvents(sessionId);
    const latest = events[events.length - 1];
    if (!latest || !isStopFromMainTaskSession(task, sessionId, latest)) return;

    const stopFingerprint = ralphStopFingerprint(sessionId, events, latest);
    await this.handleStopFingerprint(task, sessionId, stopFingerprint);
  }

  private async handleStopFingerprint(
    task: Task,
    sessionId: string,
    stopFingerprint: string,
    options: RalphStopHandlingOptions = {},
  ): Promise<void> {
    if (!task.ralphLoop || task.ralphLoop.status !== 'running') return;
    const ralphCycler = this.deps.ralphCycler;
    if (!ralphCycler) return;
    if (task.ralphLoop.lastHandledStopFingerprint === stopFingerprint) return;
    if (task.ralphLoop.handlingStopFingerprint === stopFingerprint) return;
    task.ralphLoop.handlingStopFingerprint = stopFingerprint;

    try {
      const cumulativeCostUsd = options.cumulativeCostUsd !== undefined
        ? await options.cumulativeCostUsd
        : await this.scanCatchUpUsage(task);
      const action = await ralphCycler.handleStop(this.deps.taskStore, {
        taskId: task.id,
        sessionId,
        cumulativeCostUsd,
      });
      const currentLoop = this.deps.taskStore.getTask(task.id)?.ralphLoop;
      if (
        !currentLoop
        || currentLoop.status !== 'running'
        || currentLoop.handlingStopFingerprint !== stopFingerprint
      ) return;

      if (action.kind === 'launch_fresh') {
        const actionTask = this.deps.taskStore.getTask(action.taskId) ?? task;
        if (this.deps.monitor.refreshRalphZeroDiffStreak(sessionId)) {
          this.broadcastSnapshot();
        }
        try {
          const newSessionId = await this.launchFreshRuntime(actionTask, action.text);
          const loopAfterLaunch = this.deps.taskStore.getTask(task.id)?.ralphLoop;
          if (loopAfterLaunch?.handlingStopFingerprint === stopFingerprint) {
            delete loopAfterLaunch.handlingStopFingerprint;
            loopAfterLaunch.lastHandledStopFingerprint = stopFingerprint;
          }
          this.deps.monitor.refreshRalphZeroDiffStreak(newSessionId);
          this.broadcastSnapshot();
        } catch (err) {
          const loopAfterLaunch = this.deps.taskStore.getTask(task.id)?.ralphLoop;
          if (loopAfterLaunch?.handlingStopFingerprint === stopFingerprint) {
            delete loopAfterLaunch.handlingStopFingerprint;
            loopAfterLaunch.lastHandledStopFingerprint = stopFingerprint;
            if (!(err instanceof RalphLaunchInterruptedError)) {
              loopAfterLaunch.status = 'failed';
            }
          }
          if (err instanceof RalphLaunchInterruptedError) return;
          throw err;
        }
        return;
      }
      if (action.kind !== 'noop') {
        currentLoop.lastHandledStopFingerprint = stopFingerprint;
      }
      delete currentLoop.handlingStopFingerprint;
      if (this.deps.monitor.refreshRalphZeroDiffStreak(sessionId)) {
        this.broadcastSnapshot();
      }
    } catch (err) {
      const currentLoop = this.deps.taskStore.getTask(task.id)?.ralphLoop;
      if (currentLoop?.handlingStopFingerprint === stopFingerprint) {
        delete currentLoop.handlingStopFingerprint;
      }
      throw err;
    }
  }

  private async scanCatchUpUsage(task: Task): Promise<number | null> {
    if (!this.deps.tokenTracker) return task.tokenUsage?.costUsd ?? null;

    try {
      const changed = await this.deps.tokenTracker.scanTask(task.id);
      const usage = this.deps.tokenTracker.getUsage(task.id);
      const storedUsage = this.deps.taskStore.getTask(task.id)?.tokenUsage;
      if (usage && (changed || !sameTokenUsage(storedUsage, usage))) {
        this.deps.taskStore.updateTokenUsage(task.id, usage);
      }
      return this.deps.taskStore.getTask(task.id)?.tokenUsage?.costUsd ?? usage?.costUsd ?? null;
    } catch {
      return this.deps.taskStore.getTask(task.id)?.tokenUsage?.costUsd ?? null;
    }
  }

  private async launchFreshRuntime(task: Task, prompt: string): Promise<string> {
    const currentTask = this.deps.taskStore.getTask(task.id) ?? task;
    const loop = currentTask.ralphLoop;
    if (!loop) throw new Error(`Task ${task.id} has no Ralph loop`);

    const newTmuxName = `kookr-${randomUUID().slice(0, 8)}`;
    loop.ownerSessionId = newTmuxName;

    try {
      await this.deps.launchFreshTaskSession(currentTask, prompt, { tmuxName: newTmuxName });
    } catch (err) {
      if (currentTask.ralphLoop?.ownerSessionId === newTmuxName) {
        delete currentTask.ralphLoop.ownerSessionId;
      }
      throw err;
    }

    const liveTask = this.deps.taskStore.getTask(task.id) ?? currentTask;
    const liveLoop = liveTask.ralphLoop;
    if (!liveLoop || liveLoop.status !== 'running') {
      await this.deps.terminalBackend.killSession(newTmuxName).catch(() => undefined);
      if (liveTask.ralphLoop?.ownerSessionId === newTmuxName) {
        delete liveTask.ralphLoop.ownerSessionId;
      }
      throw new RalphLaunchInterruptedError(
        `loop status changed during launch (now ${liveLoop?.status ?? 'gone'})`,
      );
    }

    return newTmuxName;
  }

  private broadcastSnapshot(): void {
    this.deps.broadcastToAll(createSnapshotMessage({
      monitor: this.deps.monitor,
      serverCwd: this.deps.serverCwd,
    }));
  }
}

function assignRalphLoop(task: Task, input: RalphLoopRequest): void {
  task.ralphLoop = {
    prompt: input.prompt,
    iterationCap: input.iterationCap,
    ...(input.stopPredicate !== undefined ? { stopPredicate: input.stopPredicate } : {}),
    ...(input.zeroDiffConvergence !== undefined
      ? {
          zeroDiffConvergence: input.zeroDiffConvergence,
          zeroDiffStreak: 0,
        }
      : {}),
    ...(input.costCapUsd !== undefined ? { costCapUsd: input.costCapUsd } : {}),
    currentIteration: 0,
    status: 'running',
    lastIterationStartedAt: 0,
    cumulativeIterations: 0,
  };
}

function isTerminalRalphStatus(status: RalphLoopStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isLiveRalphSession(session: SessionInfo): boolean {
  if (session.lastStatus === 'completed' || session.lastStatus === 'aborted') return false;
  if (session.crashRecovered) return false;
  return true;
}

function hasLiveRalphOwner(task: Task): boolean {
  const ownerSessionId = task.ralphLoop?.ownerSessionId;
  return Boolean(ownerSessionId && task.sessions.some((s) => s.tmuxSession === ownerSessionId && isLiveRalphSession(s)));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function missingLoop(): RalphLoopServiceResult<never> {
  return { ok: false, status: 404, body: { error: 'task has no Ralph loop attached' } };
}

class RalphLaunchInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RalphLaunchInterruptedError';
  }
}
