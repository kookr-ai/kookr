import { randomUUID } from 'node:crypto';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import { withTimeout } from '../core/with-timeout.js';
import { buildTaskCompletionMetadata } from './completion-metadata.js';
import type { RalphCycler, RalphCyclerEvent } from '../core/ralph-cycler.js';
import { nowISO, type DeferredInteractionLogWriter, type InteractionEvent } from '../core/interaction-log.js';
import {
  appendIterationRecord,
  readIterationLog,
  type RalphIterationExitReason,
  type RalphIterationRecord,
} from '../core/ralph-iteration-log.js';
import {
  classifyTerminalExit,
  escalationDetail,
} from '../core/ralph-terminal-relaunch-policy.js';
import type { RalphNeedsHumanReason } from '../shared/contracts/ralph.js';
import type { RelaunchArbiter } from './relaunch-arbiter.js';
import {
  canonicalizeTarget,
  defaultVerdictPath,
  readVerdictFile,
  unlinkVerdictFile,
} from '../core/ralph-iteration-verdict.js';
import { renderIterationPrompt } from '../core/ralph-iteration-template.js';
import { isStopFromMainTaskSession, ralphStopFingerprint } from './ralph/stop-event-ownership.js';
import type { Monitor } from '../core/monitor.js';
import type {
  DeliverySnapshot,
  LoopDeliveryWatchdogRegistry,
} from '../core/loop-delivery-watchdog.js';
import {
  claimRalphLoopOwner,
  isTerminalStatus,
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

/**
 * Default cap on automatic terminal relaunches before a loop escalates to
 * `needs-human` (`relaunch_exhausted`). Bounds runaway relaunch of a
 * structurally-stuck loop that has no cost cap to backstop it. Overridable via
 * `terminalRelaunchMax` (env `KOOKR_LOOP_TERMINAL_RELAUNCH_MAX`); `0` disables
 * the cap (unbounded relaunch).
 */
const DEFAULT_TERMINAL_RELAUNCH_MAX = 20;

export interface RalphLoopRequest {
  prompt: string;
  iterationCap: number;
  stopPredicate?: string;
  /** Engine-only stall channel — exit 0 = treat iteration as a stall verdict. */
  stallPredicate?: string;
  zeroDiffConvergence?: { consecutiveIterations: number };
  costCapUsd?: number;
  stallConfig?: import('../core/tasks.js').RalphStallConfig;
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
  launchFreshTaskSession: (task: Task, prompt: string, opts?: { tmuxName?: string; extraEnv?: Record<string, string> }) => Promise<string>;
  completeTask: (taskId: string) => Promise<void>;
  /**
   * Delivery-aware loop watchdog (issue #1902). Sampled once per iteration
   * boundary with the loop's cumulative delivery snapshot. Absent (or a `0`
   * threshold) ⇒ delivery-stall detection is off. Paired with
   * {@link resolveDeliverySnapshot}; both must be present for sampling to run.
   */
  loopDeliveryWatchdog?: LoopDeliveryWatchdogRegistry;
  /**
   * Resolves a task's cumulative delivery snapshot (commits / PRs opened / PRs
   * merged) for the delivery watchdog. Wired at bootstrap to read the loop's
   * branch commit count + `GitHubStateStore`; may be async (it runs git).
   * Absent ⇒ the watchdog is never sampled. A `null` result skips the sample
   * (fail-open — a delivery source that can't be read must never flag a loop).
   */
  resolveDeliverySnapshot?: (
    task: Task,
  ) => DeliverySnapshot | null | Promise<DeliverySnapshot | null>;
  /**
   * WS0.5 lease-gated relaunch arbiter (issue #1711). When wired, the
   * terminal-relaunch policy (issue #1901) consults it before re-arming a
   * capped/stalled loop so concurrent actuators cannot double-launch the same
   * issue and a post-run cooldown throttles thundering-herd relaunch. Absent ⇒
   * automatic terminal relaunch is disabled (escalation still fires).
   */
  relaunchArbiter?: Pick<RelaunchArbiter, 'tryAcquire' | 'release'>;
  /**
   * Kill-switch for automatic terminal relaunch (issue #1901). `false` disables
   * re-arming on a relaunch-eligible terminal exit (needs-human escalation on
   * budget exhaustion still fires). Absent / any other value ⇒ enabled.
   */
  terminalRelaunchEnabled?: boolean;
  /**
   * Cap on cumulative automatic terminal relaunches before a loop escalates to
   * needs-human (`relaunch_exhausted`) instead of re-arming again (issue #1901).
   * `0` disables the cap (unbounded). Absent ⇒ {@link DEFAULT_TERMINAL_RELAUNCH_MAX}.
   */
  terminalRelaunchMax?: number;
  /** Override clock for the needs-human `since` stamp (tests). */
  now?: () => number;
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
    /** Exit reason written on fail; absent when preserved. */
    exitReason?: RalphIterationExitReason;
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

export interface ReconcileOrphanedRalphLoopsOptions {
  /** Test seam: replaces the JSONL writer. */
  appendIterationRecord?: typeof appendIterationRecord;
  /** Test seam: clock for the `endedAt` field on the terminal record. */
  now?: () => number;
}

/** Per-probe timeout for `probeStartupLiveness` (ms). Hardcoded; not configurable. */
const STARTUP_PROBE_TIMEOUT_MS = 500;

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
  stallPredicate?: unknown;
  zeroDiffConvergence?: unknown;
  costCapUsd?: unknown;
  stallConfig?: unknown;
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
  if (body.stallPredicate !== undefined && typeof body.stallPredicate !== 'string') {
    return { ok: false, error: 'stallPredicate, when present, must be a string' };
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

  let parsedStallConfig: import('../core/tasks.js').RalphStallConfig | undefined;
  if (body.stallConfig !== undefined) {
    const result = validateStallConfig(body.stallConfig);
    if (!result.ok) return { ok: false, error: result.error };
    parsedStallConfig = result.value;
  }

  return {
    ok: true,
    value: {
      prompt: body.prompt,
      iterationCap: body.iterationCap,
      ...(body.stopPredicate !== undefined ? { stopPredicate: body.stopPredicate } : {}),
      ...(body.stallPredicate !== undefined ? { stallPredicate: body.stallPredicate } : {}),
      ...(body.zeroDiffConvergence !== undefined
        ? {
            zeroDiffConvergence: {
              consecutiveIterations: body.zeroDiffConvergence.consecutiveIterations as number,
            },
          }
        : {}),
      ...(body.costCapUsd !== undefined ? { costCapUsd: body.costCapUsd } : {}),
      ...(parsedStallConfig ? { stallConfig: parsedStallConfig } : {}),
    },
  };
}

function validateStallConfig(value: unknown):
  | { ok: true; value: import('../core/tasks.js').RalphStallConfig }
  | { ok: false; error: string } {
  if (!isPlainObject(value)) {
    return { ok: false, error: 'stallConfig, when present, must be an object' };
  }
  const cfg = value as Record<string, unknown>;
  const out: import('../core/tasks.js').RalphStallConfig = {};

  if (cfg.consecutiveStallsPerTarget !== undefined) {
    if (!isPositiveInt(cfg.consecutiveStallsPerTarget)) {
      return { ok: false, error: 'stallConfig.consecutiveStallsPerTarget must be a positive integer' };
    }
    out.consecutiveStallsPerTarget = cfg.consecutiveStallsPerTarget;
  }
  if (cfg.loopShape !== undefined) {
    if (cfg.loopShape !== 'single-target' && cfg.loopShape !== 'multi-target') {
      return { ok: false, error: "stallConfig.loopShape must be 'single-target' or 'multi-target'" };
    }
    out.loopShape = cfg.loopShape;
  }
  if (cfg.consecutiveStallsForSingleTargetTermination !== undefined) {
    if (!isPositiveInt(cfg.consecutiveStallsForSingleTargetTermination)) {
      return { ok: false, error: 'stallConfig.consecutiveStallsForSingleTargetTermination must be a positive integer' };
    }
    out.consecutiveStallsForSingleTargetTermination = cfg.consecutiveStallsForSingleTargetTermination;
  }
  if (cfg.declaredTargets !== undefined) {
    if (!Array.isArray(cfg.declaredTargets)) {
      return { ok: false, error: 'stallConfig.declaredTargets, when present, must be an array of strings' };
    }
    if (!cfg.declaredTargets.every((t) => typeof t === 'string' && t.length > 0)) {
      return { ok: false, error: 'stallConfig.declaredTargets must contain only non-empty strings' };
    }
    const seen = new Set<string>();
    for (const t of cfg.declaredTargets) {
      if (seen.has(t)) {
        return { ok: false, error: `stallConfig.declaredTargets contains duplicate entry: ${t}` };
      }
      seen.add(t);
    }
    out.declaredTargets = cfg.declaredTargets as string[];
  }
  if (cfg.burnedTargetDecayIterations !== undefined) {
    if (!isPositiveInt(cfg.burnedTargetDecayIterations)) {
      return { ok: false, error: 'stallConfig.burnedTargetDecayIterations must be a positive integer' };
    }
    out.burnedTargetDecayIterations = cfg.burnedTargetDecayIterations;
  }
  if (cfg.iterationCostCapUsd !== undefined) {
    if (typeof cfg.iterationCostCapUsd !== 'number' || !Number.isFinite(cfg.iterationCostCapUsd) || cfg.iterationCostCapUsd <= 0) {
      return { ok: false, error: 'stallConfig.iterationCostCapUsd, when present, must be a positive finite number' };
    }
    out.iterationCostCapUsd = cfg.iterationCostCapUsd;
  }
  if (cfg.consecutiveIterationCostCapHits !== undefined) {
    if (!isPositiveInt(cfg.consecutiveIterationCostCapHits)) {
      return { ok: false, error: 'stallConfig.consecutiveIterationCostCapHits must be a positive integer' };
    }
    out.consecutiveIterationCostCapHits = cfg.consecutiveIterationCostCapHits;
  }
  return { ok: true, value: out };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export class RalphLoopService {
  private readonly deps: RalphLoopServiceDeps;

  constructor(deps: RalphLoopServiceDeps) {
    this.deps = deps;
  }

  async startLoop(task: Task, input: RalphLoopRequest): Promise<RalphLoopServiceResult<RalphLoopState>> {
    // Live ref across awaits (claim owner, stop catch-up). Prefer in-callback
    // mutation for sync Ralph transitions; multi-step async keeps a held ref.
    const currentTask = this.deps.taskStore.runRalphMutation(task.id, (t) => t);
    if (!currentTask) return missingTask();
    assignRalphLoop(currentTask, input);
    await this.claimLatestLiveOwner(currentTask);
    currentTask.updatedAt = new Date();

    await this.catchUpFromLatestStop(currentTask);
    return { ok: true, value: structuredClone(currentTask.ralphLoop!), changed: true };
  }

  async attachLoop(task: Task, input: RalphLoopRequest): Promise<RalphLoopServiceResult<RalphLoopState>> {
    const conflict = this.deps.taskStore.runRalphMutation(task.id, (currentTask) => {
      if (currentTask.ralphLoop && (currentTask.ralphLoop.status === 'running' || currentTask.ralphLoop.status === 'paused')) {
        return {
          ok: false as const,
          status: 409 as const,
          body: {
            error: 'task already has an active Ralph loop',
            status: currentTask.ralphLoop.status,
            currentIteration: currentTask.ralphLoop.currentIteration,
          },
        };
      }
      return null;
    });
    if (conflict === undefined) return missingTask();
    if (conflict) return conflict;

    return this.startLoop(task, input);
  }

  cancelLoop(task: Task): RalphLoopServiceResult<RalphLoopStatus> {
    return this.deps.taskStore.runRalphMutation(task.id, (currentTask) => {
      const loop = currentTask.ralphLoop;
      if (!loop) return missingLoop();

      if (loop.status === 'running' || loop.status === 'paused') {
        loop.status = 'cancelled';
        currentTask.updatedAt = new Date();
        return { ok: true as const, value: loop.status, changed: true };
      }

      return { ok: true as const, value: loop.status, changed: false };
    }) ?? missingTask();
  }

  completeLoop(task: Task): RalphLoopServiceResult<RalphLoopStatus> {
    return this.deps.taskStore.runRalphMutation(task.id, (currentTask) => {
      const loop = currentTask.ralphLoop;
      if (!loop) return missingLoop();

      if (loop.status === 'running' || loop.status === 'paused') {
        loop.status = 'completed';
        currentTask.updatedAt = new Date();
        return { ok: true as const, value: loop.status, changed: true };
      }

      if (loop.status === 'completed') {
        return { ok: true as const, value: loop.status, changed: false };
      }

      return {
        ok: false as const,
        status: 409 as const,
        body: {
          error: `cannot complete Ralph loop with status ${loop.status}`,
          status: loop.status,
        },
      };
    }) ?? missingTask();
  }

  async modifyBurnedTargets(
    taskId: string,
    input: { remove: string[]; clear: boolean },
  ): Promise<RalphLoopServiceResult<NonNullable<RalphLoopState['burnedOutTargets']>>> {
    type BurnedResult = RalphLoopServiceResult<NonNullable<RalphLoopState['burnedOutTargets']>> & {
      audit?: {
        previous: NonNullable<RalphLoopState['burnedOutTargets']>;
        actuallyRemoved: NonNullable<RalphLoopState['burnedOutTargets']>;
        iteration: number;
      };
    };

    const result = this.deps.taskStore.runRalphMutation(taskId, (currentTask): BurnedResult => {
      const loop = currentTask.ralphLoop;
      if (!loop) return missingLoop();

      if (input.remove.length === 0 && !input.clear) {
        return {
          ok: true,
          value: structuredClone(loop.burnedOutTargets ?? []),
          changed: false,
        };
      }

      const previous = (loop.burnedOutTargets ?? []).map((target) => ({ ...target }));
      if (input.clear) {
        loop.burnedOutTargets = [];
      } else {
        const removeSet = new Set(input.remove.map((target) => canonicalizeTarget(target)));
        loop.burnedOutTargets = (loop.burnedOutTargets ?? []).filter((target) => !removeSet.has(target.target));
      }

      const remaining = new Set((loop.burnedOutTargets ?? []).map((target) => target.target));
      const actuallyRemoved = previous.filter((target) => !remaining.has(target.target));
      currentTask.updatedAt = new Date();
      return {
        ok: true,
        value: structuredClone(loop.burnedOutTargets ?? []),
        changed: true,
        audit: { previous, actuallyRemoved, iteration: loop.currentIteration },
      };
    });
    if (result === undefined) return missingTask();
    if (!result.ok || !result.audit) return result;

    const { previous, actuallyRemoved, iteration } = result.audit;
    if (this.deps.interactionLog) {
      const ts = nowISO();
      try {
        await this.deps.interactionLog.append({
          type: 'ralph_burned_targets_modified',
          taskId,
          removed: actuallyRemoved.map((target) => target.target),
          cleared: input.clear,
          previousBurnedOutTargets: previous,
          timestamp: ts,
        });
      } catch (err) {
        console.warn(`[ralph-loop-service] ralph_burned_targets_modified audit append failed for task ${taskId}:`, err);
      }

      for (const target of actuallyRemoved) {
        if (!target.burned) continue;
        void this.deps.interactionLog.append({
          type: 'ralph_target_unburned',
          taskId,
          target: target.target,
          iteration,
          via: 'patch_burned_targets',
          timestamp: ts,
        }).catch(() => undefined);
      }
    }

    return {
      ok: true,
      value: result.value,
      changed: true,
    };
  }

  markLoopFailed(taskId: string): boolean {
    return this.deps.taskStore.runRalphMutation(taskId, (currentTask) => {
      if (!currentTask.ralphLoop) return false;
      currentTask.ralphLoop.status = 'failed';
      currentTask.updatedAt = new Date();
      return true;
    }) ?? false;
  }

  async finalizeCompletedLoopStop(task: Task, sessionId: string, event: AgentEvent): Promise<boolean> {
    if (!task.ralphLoop || task.ralphLoop.status !== 'completed') return false;
    if (event.type !== 'stop') return false;
    if (!isStopFromMainTaskSession(task, sessionId, event)) return false;

    // Live ref: may await completion metadata + finalize across steps.
    const currentTask = this.deps.taskStore.runRalphMutation(task.id, (t) => t);
    if (!currentTask) return false;
    const completeTask = this.deps.completeTask;
    let finalizeTask: ((taskId: string) => Promise<void>) | undefined;
    if (currentTask.status === 'inProgress') {
      if (!completeTask) return false;
      finalizeTask = completeTask;
    }

    if (!currentTask.completionDigest) {
      const events = this.deps.monitor.getAgentEvents(sessionId);
      const metadata = await buildTaskCompletionMetadata(currentTask, events);
      this.deps.taskStore.setCompletionDigest(task.id, metadata.digest);
      if (metadata.taskTokenUsage) {
        this.deps.taskStore.updateTokenUsage(task.id, metadata.taskTokenUsage);
      }
    }

    if (finalizeTask) await finalizeTask(task.id);

    return true;
  }

  async updatePrompt(task: Task, prompt: unknown): Promise<RalphLoopServiceResult<RalphLoopState>> {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      return { ok: false, status: 400, body: { error: 'prompt is required and must be a non-empty string' } };
    }

    type UpdatePromptMutation =
      | RalphLoopServiceResult<RalphLoopState>
      | {
          ok: true;
          value: RalphLoopState;
          changed: true;
          previousPrompt: string;
          taskId: string;
          status: 'running' | 'paused';
        };

    const result = this.deps.taskStore.runRalphMutation(task.id, (currentTask): UpdatePromptMutation => {
      const loop = currentTask.ralphLoop;
      if (!loop) return missingLoop();
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
      currentTask.updatedAt = new Date();
      const status: 'running' | 'paused' = loop.status;
      return {
        ok: true,
        value: structuredClone(loop),
        changed: true,
        previousPrompt,
        taskId: currentTask.id,
        status,
      };
    });
    if (result === undefined) return missingTask();
    if (!result.ok) return result;
    if (!('previousPrompt' in result)) return result;

    await this.deps.interactionLog?.append({
      type: 'ralph_prompt_updated',
      taskId: result.taskId,
      status: result.status,
      previousPrompt: result.previousPrompt,
      prompt,
      timestamp: nowISO(),
    });

    return { ok: true, value: result.value, changed: true };
  }

  pauseLoop(task: Task): RalphLoopServiceResult<RalphLoopState> {
    return this.deps.taskStore.runRalphMutation(task.id, (currentTask) => {
      const loop = currentTask.ralphLoop;
      if (!loop) return missingLoop();
      if (isTerminalRalphStatus(loop.status)) {
        return {
          ok: false as const,
          status: 409 as const,
          body: { error: `cannot pause Ralph loop in terminal status: ${loop.status}`, status: loop.status },
        };
      }

      if (loop.status === 'running') {
        loop.status = 'paused';
        currentTask.updatedAt = new Date();
        return { ok: true as const, value: structuredClone(loop), changed: true };
      }

      return { ok: true as const, value: structuredClone(loop), changed: false };
    }) ?? missingTask();
  }

  async resumeLoop(task: Task): Promise<RalphLoopServiceResult<RalphLoopState>> {
    // Live ref across findLiveSession + catchUpFromLatestStop awaits.
    const currentTask = this.deps.taskStore.runRalphMutation(task.id, (t) => t);
    if (!currentTask) return missingTask();
    const loop = currentTask.ralphLoop;
    if (!loop) return missingLoop();
    if (isTerminalRalphStatus(loop.status)) {
      return {
        ok: false,
        status: 409,
        body: { error: `cannot resume Ralph loop in terminal status: ${loop.status}`, status: loop.status },
      };
    }

    const liveSessionId = await this.findLiveSession(currentTask);
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
      const liveSession = currentTask.sessions.find((s) => s.tmuxSession === liveSessionId);
      claimRalphLoopOwner(currentTask, liveSession, { allowTransfer: loop.ownerSessionId !== liveSessionId });
      loop.status = 'running';
      currentTask.updatedAt = new Date();
      await this.catchUpFromLatestStop(currentTask);
      return { ok: true, value: structuredClone(loop), changed: true };
    }

    return { ok: true, value: structuredClone(loop), changed: false };
  }

  async handleStopEvent(
    task: Task,
    sessionId: string,
    event: AgentEvent,
    options: RalphStopHandlingOptions = {},
  ): Promise<void> {
    // Live ref across stop fingerprint handling (cycler + launch awaits).
    const currentTask = this.deps.taskStore.runRalphMutation(task.id, (t) => t);
    if (!currentTask) return;
    if (!currentTask.ralphLoop || currentTask.ralphLoop.status !== 'running') return;
    if (!this.deps.ralphCycler) return;
    if (!isStopFromMainTaskSession(currentTask, sessionId, event)) return;

    const events = this.deps.monitor.getAgentEvents(sessionId);
    const stopFingerprint = ralphStopFingerprint(sessionId, events, event);
    await this.handleStopFingerprint(currentTask, sessionId, stopFingerprint, options);
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

    for (const taskSnapshot of this.deps.taskStore.getAllTasks()) {
      // Live ref: probe + audit write + status mutation span awaits.
      const task = this.deps.taskStore.runRalphMutation(taskSnapshot.id, (t) => t);
      if (!task) continue;
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
        exitReason: 'kookr_crash',
      });
    }

    return summary;
  }

  /**
   * In-process recovery for Ralph loops orphaned as `running` after their
   * owning task reached a terminal status (issue #2193 gap 1).
   *
   * `reconcileStartupLoops` only runs at boot. When the first-hook-miss reaper
   * (or any other path) terminates a task mid-iteration without touching
   * `ralphLoop`, the loop stays `status:"running"` forever — Stop never fires,
   * and bare (unscheduled) loops have no self-heal. This sweep mirrors the
   * startup contract on every liveness tick: write a terminal iteration record
   * and set `ralphLoop.status = 'failed'`.
   */
  async reconcileOrphanedLoops(
    opts: ReconcileOrphanedRalphLoopsOptions = {},
  ): Promise<RalphReconcileSummary> {
    const writeRecord = opts.appendIterationRecord ?? appendIterationRecord;
    const now = (opts.now ?? Date.now)();
    const summary: RalphReconcileSummary = {
      examined: 0,
      preserved: 0,
      failed: 0,
      perTask: [],
    };

    // viewTasks (no clone): eligibility only needs id/status/ralphLoop.status.
    // Mutations go through runRalphMutation for a live ref.
    for (const taskSnapshot of this.deps.taskStore.viewTasks()) {
      if (!isTerminalStatus(taskSnapshot.status)) continue;
      if (!taskSnapshot.ralphLoop || taskSnapshot.ralphLoop.status !== 'running') continue;
      const task = this.deps.taskStore.runRalphMutation(taskSnapshot.id, (t) => t);
      if (!task) continue;
      const loop = task.ralphLoop;
      if (!loop || loop.status !== 'running') continue;

      summary.examined++;

      const exitReason = exitReasonForOrphanedLoop(task);
      const startedAt = loop.lastIterationStartedAt > 0 ? loop.lastIterationStartedAt : now;
      const record: RalphIterationRecord = {
        iterationNumber: loop.currentIteration,
        startedAt,
        endedAt: now,
        exitReason,
        cumulativeCostUsd: null,
        gitBaselineRef: null,
        diffStats: null,
      };
      try {
        await writeRecord(task.cwd, record);
      } catch (err) {
        console.warn(
          `[ralph-orphan-recovery] iteration log append failed for task ${task.id}:`,
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
        exitReason,
      });
      console.warn(
        `[ralph-orphan-recovery] closed orphaned loop on task ${task.id} `
        + `(exitReason=${exitReason}, iteration=${loop.currentIteration})`,
      );
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
    // Live ref across cost scan / verdict read / cycler / launch awaits.
    // Re-fetch loop after each await so concurrent status changes are visible.
    const currentTask = this.deps.taskStore.runRalphMutation(task.id, (t) => t);
    if (!currentTask?.ralphLoop || currentTask.ralphLoop.status !== 'running') return;
    const ralphCycler = this.deps.ralphCycler;
    if (!ralphCycler) return;
    if (currentTask.ralphLoop.lastHandledStopFingerprint === stopFingerprint) return;
    if (currentTask.ralphLoop.handlingStopFingerprint === stopFingerprint) return;
    currentTask.ralphLoop.handlingStopFingerprint = stopFingerprint;

    try {
      const cumulativeCostUsd = options.cumulativeCostUsd !== undefined
        ? await options.cumulativeCostUsd
        : await this.scanCatchUpUsage(currentTask);

      // Read + consume the agent's verdict file (if any) BEFORE invoking the
      // cycler. The cycler stays IO-free (boundary-critic STRUCTURAL): it
      // receives the parsed verdict via options and decides what to do.
      // Malformed / oversize / wrong-iteration files are recorded as warnings
      // on RalphLoopState and treated as legacy `continued`.
      const verdict = await this.readAndConsumeVerdictFile(currentTask);

      const action = await ralphCycler.handleStop(this.deps.taskStore, {
        taskId: currentTask.id,
        sessionId,
        cumulativeCostUsd,
        verdict,
      });
      // Fire any interaction-log events the cycler decided should fire.
      this.fireCyclerEvents(action.events);

      // Delivery-aware loop watchdog (issue #1902). A stop event is one
      // completed iteration — the natural cadence for judging DELIVERY
      // progress (commits/PRs/merges), which is coarse (minutes/iterations),
      // not the 5s liveness cadence. Fail-open: never let a sampling error
      // interrupt the loop.
      await this.sampleDeliveryProgress(currentTask.id);

      // Terminal-loop relaunch policy (issue #1901 / WS2.3). On a `terminate`
      // action the cycler has already written a terminal `loop.status`; decide
      // whether to re-arm (arbiter-gated) or escalate to a visible needs-human
      // state. This runs BEFORE the running-status guard below, which would
      // otherwise return early on any terminal status.
      if (action.kind === 'terminate') {
        await this.handleTerminalExit(currentTask.id, action.reason, stopFingerprint);
        return;
      }

      const currentLoop = this.deps.taskStore.runRalphMutation(currentTask.id, (t) => t.ralphLoop);
      if (
        !currentLoop
        || currentLoop.status !== 'running'
        || currentLoop.handlingStopFingerprint !== stopFingerprint
      ) return;

      if (action.kind === 'launch_fresh') {
        const actionTask = this.deps.taskStore.runRalphMutation(action.taskId, (t) => t);
        if (!actionTask) return;
        if (this.deps.monitor.refreshRalphZeroDiffStreak(sessionId)) {
          this.broadcastSnapshot();
        }
        try {
          const newSessionId = await this.launchFreshRuntime(actionTask, action.text);
          this.deps.taskStore.runRalphMutation(currentTask.id, (t) => {
            const loopAfterLaunch = t.ralphLoop;
            if (loopAfterLaunch?.handlingStopFingerprint === stopFingerprint) {
              delete loopAfterLaunch.handlingStopFingerprint;
              loopAfterLaunch.lastHandledStopFingerprint = stopFingerprint;
            }
          });
          this.deps.monitor.refreshRalphZeroDiffStreak(newSessionId);
          this.broadcastSnapshot();
        } catch (err) {
          this.deps.taskStore.runRalphMutation(currentTask.id, (t) => {
            const loopAfterLaunch = t.ralphLoop;
            if (loopAfterLaunch?.handlingStopFingerprint === stopFingerprint) {
              delete loopAfterLaunch.handlingStopFingerprint;
              loopAfterLaunch.lastHandledStopFingerprint = stopFingerprint;
              if (!(err instanceof RalphLaunchInterruptedError)) {
                loopAfterLaunch.status = 'failed';
              }
            }
          });
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
      this.deps.taskStore.runRalphMutation(currentTask.id, (t) => {
        if (t.ralphLoop?.handlingStopFingerprint === stopFingerprint) {
          delete t.ralphLoop.handlingStopFingerprint;
        }
      });
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
    // Live ref across verdict unlink / template render / session launch awaits.
    const currentTask = this.deps.taskStore.runRalphMutation(task.id, (t) => t);
    if (!currentTask) throw new Error(`Task not found: ${task.id}`);
    const loop = currentTask.ralphLoop;
    if (!loop) throw new Error(`Task ${task.id} has no Ralph loop`);

    // Pre-launch verdict-file unlink — closes cross-iteration carryover by
    // construction. If a stale file was present (e.g., from a kookr_crash
    // mid-iteration), emit `ralph_stale_verdict_unlinked` so the operator
    // can see the recovery path fired. Idempotent: missing file is a no-op.
    const verdictPath = defaultVerdictPath(currentTask.cwd, currentTask.id);
    await this.unlinkAndAuditVerdictFile(currentTask, verdictPath);

    // Per-iteration template render — substitutes {{ralph.x}} tokens. Pure
    // function with marker-presence opt-in: a prompt without any {{ralph.x}}
    // is forwarded unchanged.
    const renderedPrompt = await this.renderForLaunch(currentTask, loop, prompt);

    const newTmuxName = `kookr-${randomUUID().slice(0, 8)}`;
    loop.ownerSessionId = newTmuxName;

    try {
      await this.deps.launchFreshTaskSession(currentTask, renderedPrompt, {
        tmuxName: newTmuxName,
        // Generic env-extension point. The agent reads `$RALPH_VERDICT_FILE`
        // and writes its verdict JSON to that absolute path — works
        // regardless of any `cd` the agent does mid-iteration.
        // `RALPH_ITERATION` mirrors the `{{ralph.iteration}}` template var so
        // bash-style verdict writers (`"iteration":${RALPH_ITERATION}`) emit
        // the current iteration; without this the engine rejects every
        // post-iter-0 verdict with `iteration_mismatch` and stall counts
        // never accrue.
        extraEnv: {
          RALPH_VERDICT_FILE: verdictPath,
          RALPH_ITERATION: String(loop.currentIteration),
        },
      });
    } catch (err) {
      this.deps.taskStore.runRalphMutation(task.id, (t) => {
        if (t.ralphLoop?.ownerSessionId === newTmuxName) {
          delete t.ralphLoop.ownerSessionId;
        }
      });
      throw err;
    }

    const postLaunch = this.deps.taskStore.runRalphMutation(task.id, (liveTask) => {
      const liveLoop = liveTask.ralphLoop;
      if (!liveLoop || liveLoop.status !== 'running') {
        if (liveTask.ralphLoop?.ownerSessionId === newTmuxName) {
          delete liveTask.ralphLoop.ownerSessionId;
        }
        return { ok: false as const, status: liveLoop?.status };
      }
      return { ok: true as const };
    }) ?? { ok: false as const, status: undefined as RalphLoopStatus | undefined };

    if (!postLaunch.ok) {
      await this.deps.terminalBackend.killSession(newTmuxName).catch(() => undefined);
      throw new RalphLaunchInterruptedError(
        `loop status changed during launch (now ${postLaunch.status ?? 'gone'})`,
      );
    }

    return newTmuxName;
  }

  /**
   * Delete the verdict file at `path` and emit `ralph_stale_verdict_unlinked`
   * if a file actually existed (i.e. we had to remove it, indicating prior
   * recovery state). Best-effort.
   */
  private async unlinkAndAuditVerdictFile(task: Task, path: string): Promise<void> {
    let existed = false;
    try {
      const { lstat } = await import('node:fs/promises');
      await lstat(path);
      existed = true;
    } catch {
      // ENOENT: no stale file; nothing to audit.
    }
    await unlinkVerdictFile(path);
    if (existed && this.deps.interactionLog) {
      void this.deps.interactionLog.append({
        type: 'ralph_stale_verdict_unlinked',
        taskId: task.id,
        path,
        iteration: task.ralphLoop?.currentIteration ?? -1,
        timestamp: nowISO(),
      }).catch(() => undefined);
    }
  }

  /**
   * Apply per-iteration template substitution to `prompt`. Reads recent
   * iteration records from the JSONL log only when the prompt contains a
   * `{{ralph.recentVerdicts}}` token — cheap-fail fast otherwise.
   */
  private async renderForLaunch(task: Task, loop: RalphLoopState, prompt: string): Promise<string> {
    let recentRecords: RalphIterationRecord[] | undefined;
    if (prompt.includes('{{ralph.recentVerdicts}}')) {
      try {
        const model = await readIterationLog(task.cwd, { limit: 50, loop });
        recentRecords = model.iterations;
      } catch {
        // Log-read failure should not break iteration launch. The token
        // expands to '' which is what the playbook author opted into.
        recentRecords = [];
      }
    }
    return renderIterationPrompt(prompt, {
      iteration: loop.currentIteration,
      cumulativeIterations: loop.cumulativeIterations,
      burnedOutTargets: loop.burnedOutTargets,
      recentRecords,
    });
  }

  /**
   * Read + delete the agent's verdict file. Returns the parsed verdict on
   * success; on any failure (missing, malformed, oversize, symlink, wrong
   * iteration) returns undefined and updates the loop's verdictWarningCount
   * + lastVerdictWarningReason fields, plus emits a `ralph_verdict_warning`
   * interaction-log event when applicable. Missing-file is NOT a warning.
   */
  private async readAndConsumeVerdictFile(task: Task) {
    const loop = task.ralphLoop;
    if (!loop) return undefined;
    const path = defaultVerdictPath(task.cwd, task.id);
    let result;
    try {
      result = await readVerdictFile(path, loop.currentIteration);
    } catch (err) {
      console.warn(`[ralph-loop-service] verdict file read failed for task ${task.id}:`, err);
      return undefined;
    }
    // Always unlink after read — closes the file's lifecycle on the read
    // side, mirroring the launch-side pre-unlink. Idempotent.
    await unlinkVerdictFile(path).catch(() => undefined);

    if (result.failure === 'missing' || result.failure === null) {
      return result.verdict ?? undefined;
    }
    // Real warning: mismatch / malformed / oversize / symlink / schema.
    loop.verdictWarningCount = (loop.verdictWarningCount ?? 0) + 1;
    loop.lastVerdictWarningReason = result.reason ?? `verdict file ${result.failure}`;
    if (this.deps.interactionLog) {
      void this.deps.interactionLog.append({
        type: 'ralph_verdict_warning',
        taskId: task.id,
        iteration: loop.currentIteration,
        failure: result.failure,
        reason: result.reason ?? 'unknown',
        timestamp: nowISO(),
      }).catch(() => undefined);
    }
    return undefined;
  }

  /**
   * Forward cycler-decided events to the interaction log. The cycler stays
   * IO-free; the service is the single point of audit-trail emission.
   */
  private fireCyclerEvents(events: RalphCyclerEvent[] | undefined): void {
    // Defensive: legacy/test cycler stubs may return without an `events`
    // array. The cycler contract guarantees `events: RalphCyclerEvent[]`,
    // but being lenient here keeps test doubles simple.
    if (!events || events.length === 0 || !this.deps.interactionLog) return;
    const ts = nowISO();
    for (const e of events) {
      const event: InteractionEvent = { ...e, timestamp: ts };
      void this.deps.interactionLog.append(event).catch(() => undefined);
    }
  }

  /**
   * Feed one delivery snapshot to the loop watchdog for a just-completed
   * iteration (issue #1902). No-op unless both the watchdog registry and the
   * snapshot resolver are wired and the watchdog is enabled. On the sample
   * where a loop flips to (or out of) flagged, emit a single warn line — once
   * per transition, never per sample, to avoid a log storm on a chronically
   * stalled loop. Never throws.
   */
  private async sampleDeliveryProgress(taskId: string): Promise<void> {
    const registry = this.deps.loopDeliveryWatchdog;
    const resolve = this.deps.resolveDeliverySnapshot;
    if (!registry?.enabled || !resolve) return;
    try {
      const task = this.deps.taskStore.getTask(taskId);
      if (!task?.ralphLoop || task.ralphLoop.status !== 'running') return;
      const snapshot = await resolve(task);
      const result = registry.sample(taskId, snapshot);
      if (!result.transitioned) return;
      if (result.flagged) {
        console.warn(
          `[loop-delivery-watchdog] task ${taskId} flagged: no delivery progress `
          + `(commit/PR/merge) over ${result.consecutiveNoProgress} consecutive iterations`,
        );
      } else {
        console.warn(
          `[loop-delivery-watchdog] task ${taskId} recovered: delivery progress resumed`,
        );
      }
    } catch (err) {
      console.warn(`[loop-delivery-watchdog] delivery sampling failed for task ${taskId}:`, err);
    }
  }

  /**
   * Terminal-loop relaunch policy consumer (issue #1901 / WS2.3). Called once
   * per `terminate` action from the cycler. Classifies the exit reason and
   * either re-arms the loop (arbiter-gated) or escalates it to a visible
   * needs-human state. `stop` dispositions (clean completion, user stops,
   * crashes owned elsewhere) are left untouched — the cycler already wrote the
   * terminal status.
   */
  private async handleTerminalExit(
    taskId: string,
    reason: RalphIterationExitReason,
    stopFingerprint: string,
  ): Promise<void> {
    const decision = classifyTerminalExit(reason);
    if (decision.disposition === 'stop') return;
    if (decision.disposition === 'escalate') {
      this.escalateNeedsHuman(taskId, reason, decision.escalationReason ?? 'budget_exhausted');
      return;
    }
    await this.tryTerminalRelaunch(taskId, reason, stopFingerprint);
  }

  /**
   * Move a terminated loop into an explicit needs-human state (issue #1901).
   * The cycler left `status` terminal (usually `completed`); this stamps the
   * `needsHuman` marker so the snapshot surfaces the loop as escalated rather
   * than silently done, emits an audit event, and warns once.
   */
  private escalateNeedsHuman(
    taskId: string,
    exitReason: RalphIterationExitReason,
    reason: RalphNeedsHumanReason,
  ): void {
    const now = (this.deps.now ?? Date.now)();
    const updated = this.deps.taskStore.runRalphMutation(taskId, (t) => {
      const loop = t.ralphLoop;
      if (!loop) return false;
      loop.needsHuman = {
        reason,
        exitReason,
        since: now,
        detail: escalationDetail(reason, exitReason),
      };
      t.updatedAt = new Date(now);
      return true;
    });
    if (!updated) return;
    // Release the relaunch lease so a needs-human issue is not pinned against
    // the task's liveness. Without this, a loop that already relaunched (and so
    // holds the lease under `taskId`) would keep the lease until the task itself
    // reaches a terminal status — silently denying every other actuator,
    // including a human manual re-dispatch, with `reason: 'held'`. Releasing
    // starts the arbiter cooldown and lets a human intervene after it. Idempotent
    // (no-op when this task does not hold the lease).
    this.releaseRelaunchLease(taskId);
    console.warn(
      `[ralph-terminal-policy] task ${taskId} needs human: ${reason} (exit=${exitReason})`,
    );
    void this.deps.interactionLog?.append({
      type: 'ralph_loop_needs_human',
      taskId,
      exitReason,
      reason,
      timestamp: nowISO(),
    }).catch(() => undefined);
    this.broadcastSnapshot();
  }

  /**
   * Release the relaunch lease held by `taskId` for its issue claim, if any
   * (issue #1901). Safe no-op when no arbiter is wired, the task has no issue
   * claim, or the lease is held by someone else.
   */
  private releaseRelaunchLease(taskId: string): void {
    const arbiter = this.deps.relaunchArbiter;
    if (!arbiter) return;
    const claim = this.deps.taskStore.getTask(taskId)?.issueClaim;
    if (!claim) return;
    arbiter.release({ repo: claim.repo, number: claim.number }, taskId);
  }

  /**
   * Re-arm a capped/stalled loop, gated by the WS0.5 relaunch arbiter
   * (issue #1711). Requires both a wired arbiter and an issue claim on the task
   * (the arbiter keys on issue identity). On admission the loop is re-armed in
   * place with a fresh iteration budget and a new agent session is launched; on
   * denial (another actuator holds the issue, or a cooldown is active) no
   * relaunch happens — the arbiter is the single mutual-exclusion layer that
   * prevents duplicate PRs.
   */
  private async tryTerminalRelaunch(
    taskId: string,
    reason: RalphIterationExitReason,
    stopFingerprint: string,
  ): Promise<void> {
    const arbiter = this.deps.relaunchArbiter;
    // Actuation off (no arbiter wired, or kill-switch): leave the loop
    // terminal. Not a needs-human case — a capped loop with nothing relaunching
    // it is the pre-#1901 default, not a budget failure.
    if (!arbiter || this.deps.terminalRelaunchEnabled === false) return;

    const task = this.deps.taskStore.getTask(taskId);
    const claim = task?.issueClaim;
    // No issue identity ⇒ nothing to arbitrate on; skip (in-place relaunch of a
    // claimless loop would bypass the single dedup layer by design).
    if (!claim) return;
    const key = { repo: claim.repo, number: claim.number };

    // Runaway guard: a structurally-stuck loop (repeated iteration_cap /
    // target_stalled) with no cost cap would otherwise re-arm forever. Once the
    // cumulative relaunch count reaches the cap, escalate to needs-human instead
    // of re-arming. `max <= 0` disables the cap (unbounded relaunch).
    const max = this.deps.terminalRelaunchMax ?? DEFAULT_TERMINAL_RELAUNCH_MAX;
    const priorCount = task?.ralphLoop?.terminalRelaunchCount ?? 0;
    if (max > 0 && priorCount >= max) {
      this.escalateNeedsHuman(taskId, reason, 'relaunch_exhausted');
      return;
    }

    const acquire = arbiter.tryAcquire(key, taskId);
    if (!acquire.ok) {
      void this.deps.interactionLog?.append({
        type: 'ralph_terminal_relaunch',
        taskId,
        exitReason: reason,
        outcome: acquire.reason === 'backoff' ? 'skipped_backoff' : 'skipped_held',
        timestamp: nowISO(),
      }).catch(() => undefined);
      return;
    }

    // Admitted: re-arm in place with a fresh iteration budget. Clearing burned
    // targets and cost streaks gives the relaunch a clean slate; a fresh
    // `currentIteration` restores headroom under the iteration cap.
    const now = (this.deps.now ?? Date.now)();
    const rearmed = this.deps.taskStore.runRalphMutation(taskId, (t) => {
      const loop = t.ralphLoop;
      if (!loop) return null;
      loop.status = 'running';
      loop.currentIteration = 0;
      loop.zeroDiffStreak = 0;
      loop.consecutiveIterationCostCapStreak = 0;
      loop.burnedOutTargets = [];
      // Cumulative across re-arms (NOT reset with currentIteration) so the
      // runaway guard can bound total relaunches.
      loop.terminalRelaunchCount = (loop.terminalRelaunchCount ?? 0) + 1;
      delete loop.needsHuman;
      delete loop.handlingStopFingerprint;
      loop.lastHandledStopFingerprint = stopFingerprint;
      loop.lastIterationStartedAt = now;
      t.updatedAt = new Date(now);
      return t;
    });
    if (!rearmed) {
      arbiter.release(key, taskId);
      return;
    }

    try {
      const newSessionId = await this.launchFreshRuntime(rearmed, rearmed.ralphLoop!.prompt);
      this.deps.monitor.refreshRalphZeroDiffStreak(newSessionId);
      void this.deps.interactionLog?.append({
        type: 'ralph_terminal_relaunch',
        taskId,
        exitReason: reason,
        outcome: 'relaunched',
        timestamp: nowISO(),
      }).catch(() => undefined);
      this.broadcastSnapshot();
    } catch (err) {
      // Launch failed: release the lease so the cooldown starts and another
      // actuator can retry after it, and mark the loop failed.
      arbiter.release(key, taskId);
      this.deps.taskStore.runRalphMutation(taskId, (t) => {
        if (t.ralphLoop?.status === 'running') {
          t.ralphLoop.status = 'failed';
        }
      });
      if (err instanceof RalphLaunchInterruptedError) return;
      throw err;
    }
  }

  private broadcastSnapshot(): void {
    this.deps.broadcastToAll(createSnapshotMessage({
      monitor: this.deps.monitor,
      serverCwd: this.deps.serverCwd,
      relationTaskStore: this.deps.taskStore,
    }));
  }
}

function assignRalphLoop(task: Task, input: RalphLoopRequest): void {
  task.ralphLoop = {
    prompt: input.prompt,
    iterationCap: input.iterationCap,
    ...(input.stopPredicate !== undefined ? { stopPredicate: input.stopPredicate } : {}),
    ...(input.stallPredicate !== undefined ? { stallPredicate: input.stallPredicate } : {}),
    ...(input.zeroDiffConvergence !== undefined
      ? {
          zeroDiffConvergence: input.zeroDiffConvergence,
          zeroDiffStreak: 0,
        }
      : {}),
    ...(input.costCapUsd !== undefined ? { costCapUsd: input.costCapUsd } : {}),
    ...(input.stallConfig !== undefined ? { stallConfig: input.stallConfig } : {}),
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

/**
 * Map a terminal task's disposition onto a Ralph iteration exit reason for
 * orphan-loop recovery (issue #2193). Prefer the disposition that reaped the
 * session; fall back to `session_dead` when the task is terminal for any other
 * reason with the loop still marked running.
 */
export function exitReasonForOrphanedLoop(task: Task): RalphIterationExitReason {
  // Prefer the disposition that reaped the session. Everything else that left
  // a terminal task with a still-running loop maps to session_dead (hung reap,
  // hungSuspect TTL, provider_paused TTL, missing disposition, etc.).
  if (task.disposition?.reason === 'first_hook_miss') return 'first_hook_miss';
  return 'session_dead';
}

function missingLoop(): RalphLoopServiceResult<never> {
  return { ok: false, status: 404, body: { error: 'task has no Ralph loop attached' } };
}

function missingTask(): RalphLoopServiceResult<never> {
  return { ok: false, status: 404, body: { error: 'Task not found' } };
}

class RalphLaunchInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RalphLaunchInterruptedError';
  }
}
