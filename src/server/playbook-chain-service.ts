/**
 * Playbook chain service (RFC: docs/rfc/rfc-playbook-chains.md).
 *
 * Repeats a playbook launch as a sequence of ordinary tasks. The first
 * iteration is launched by {@link PlaybookChainService.startChain}; every later
 * one is launched by this service itself when the previous iteration's task
 * ends — the agent never has to remember to spawn a successor.
 *
 * The service is the only writer of `Task.chain`:
 *  - `startChain` stamps iteration 1 at task creation;
 *  - the sweep stamps each successor at its creation, and records why a chain
 *    ended on its newest task (the "tip");
 *  - `stopChain` records a stop request on the tip.
 *
 * Exactly-once: a successor is stamped with `chainId` + `iteration` atomically
 * when its task is created, so before launching iteration N+1 the sweep looks
 * for an existing N+1 and adopts it instead. That covers a crash at any point
 * between "tip finished" and "successor recorded". An in-process flag keeps two
 * sweeps from overlapping.
 *
 * Ordering: start the sweep only after startup recovery has run, because
 * recovery may reopen a completed or terminated tip that a premature sweep
 * would already have advanced past.
 */

import { randomUUID } from 'node:crypto';
import type { LaunchOpts } from '../shared/contracts/launch.js';
import type { TaskLaunchSource } from '../shared/contracts/task.js';
import type { ChainEndReason, ChainSpec, TaskChainState } from '../shared/contracts/playbook-chain.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { AgentEvent, Anomaly } from '../core/types.js';
import { deriveTurnStateDetails } from '../core/turn-state.js';
import { isBackgroundParked } from '../core/background-parked.js';
import {
  CHAIN_MAX_LAUNCH_FAILURES,
  decideChainStep,
  initialChainState,
  renderChainPreamble,
} from '../core/playbook-chain.js';
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
import {
  preparePlaybookLaunchWithMetadata,
  type PreparePlaybookLaunchInput,
  type PreparedPlaybookLaunch,
} from './use-cases/playbook-launch.js';

export const PLAYBOOK_CHAIN_SWEEP_INTERVAL_MS = 15_000;
/**
 * How long a chain tip must sit idle at its prompt, with nothing asked, before
 * the service completes it on the agent's behalf (the idle backstop).
 */
export const CHAIN_IDLE_COMPLETE_MS = 5 * 60_000;
/**
 * A chain tip that raised `completion-ready` is closed by the service once its
 * turn has ended and the signal is at least this old, so the agent's final
 * message is not cut off.
 */
export const CHAIN_SIGNAL_SETTLE_MS = 30_000;
/** ...or after this long regardless (agent signalled, then parked on background work). */
export const CHAIN_SIGNAL_CLOSE_CEILING_MS = 10 * 60_000;

export interface PlaybookChainLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface PlaybookChainServiceDeps {
  taskStore: TaskStore;
  launchTask: (opts: LaunchOpts, serverOpts?: LaunchTaskServerOptions) => Promise<LaunchResult>;
  /** Project id stamped on autonomous (successor) launches for the per-project automation pause. */
  resolveAutomationProjectId: (cwd: string) => Promise<string>;
  /** Live agent state per terminal session, read by the idle backstop. */
  monitor: {
    getCurrentAnomaly(agentId: string): Anomaly | null;
    getAgentEvents(agentId: string): AgentEvent[];
    getOutstandingSubagentCount(agentId: string): number;
  };
  /** True while the task's provider is paused (billing/quota); never idle-close those. */
  isProviderPaused?: (task: Task) => boolean;
  /**
   * Complete an iteration on the chain's behalf: either its agent raised
   * `completion-ready` (`'signalled'`) or it went idle without closing its task
   * (`'idle'`, the idle backstop). Wired to the normal lifecycle completion
   * after surfacing any dirty worktree; it must call `stillValid()` after that
   * await and skip the completion (returning false) if the situation changed.
   */
  completeIteration: (task: Task, how: 'signalled' | 'idle', stillValid: () => boolean) => Promise<boolean>;
  /** Injectable for tests; defaults to the real playbook resolver. */
  preparePlaybookLaunch?: (input: PreparePlaybookLaunchInput) => Promise<PreparedPlaybookLaunch>;
  /** Called after any chain state change or successor launch so the dashboard refreshes. */
  onChanged?: (taskId: string) => void;
  now?: () => Date;
  intervalMs?: number;
  logger?: PlaybookChainLogger;
}

export class PlaybookChainError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
    this.name = 'PlaybookChainError';
  }
}

export interface StartChainInput extends PreparePlaybookLaunchInput {
  spec: ChainSpec;
  launchSource: TaskLaunchSource;
}

export type StopChainResult =
  | { ok: true; tip: Task; alreadyRequested: boolean }
  | { ok: false; status: 404 | 409; error: string };

/**
 * Launch errors that mean "not now" rather than "this launch is broken": the
 * successor is retried on the next sweep and the attempt is not counted.
 */
function isHoldError(err: unknown): boolean {
  return err instanceof AutomationKillSwitchError
    || err instanceof DrainModeError
    || err instanceof HostLoadAdmissionError
    || err instanceof PendingQueueFullError
    || err instanceof QuotaHeadroomAdmissionError
    || err instanceof SpawnBurstLimitError;
}

export class PlaybookChainService {
  private readonly now: () => Date;
  private readonly prepare: (input: PreparePlaybookLaunchInput) => Promise<PreparedPlaybookLaunch>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;
  /** Consecutive failed successor launches per chain. In memory: a restart grants a few more tries. */
  private readonly launchFailures = new Map<string, number>();
  /** Tip id → when the service first saw it idle with nothing asked. Reset on any activity. */
  private readonly idleSince = new Map<string, number>();

  constructor(private readonly deps: PlaybookChainServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.prepare = deps.preparePlaybookLaunch ?? preparePlaybookLaunchWithMetadata;
  }

  /** Start periodic sweeps. Call only after startup recovery has finished. */
  start(): void {
    if (this.timer) return;
    void this.sweep();
    this.timer = setInterval(() => { void this.sweep(); }, this.deps.intervalMs ?? PLAYBOOK_CHAIN_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Launch iteration 1 of a new chain. */
  async startChain(input: StartChainInput): Promise<LaunchResult> {
    const { spec, launchSource, ...prepareInput } = input;
    const prepared = await this.prepare(prepareInput);
    // The chain id is minted here (not taken from the first task's id) so a
    // launch that creates the task and then fails can be found and ended:
    // otherwise the sweep would see a never-started iteration 1 and keep the
    // chain going in the background after the caller was told it failed.
    const chain: TaskChainState = { ...initialChainState(spec, this.now()), chainId: randomUUID() };
    let result: LaunchResult;
    try {
      result = await this.deps.launchTask(
        chainLaunchOpts(prepared, chain, launchSource),
        { deliveryPolicy: prepared.deliveryPolicy, chain },
      );
    } catch (err) {
      for (const task of this.deps.taskStore.viewTasks()) {
        if (task.chain?.chainId !== chain.chainId || task.chain.ended) continue;
        this.deps.taskStore.updateChain(task.id, (state) => ({
          ...state,
          ended: {
            at: this.now().toISOString(),
            reason: 'launch_failed',
            detail: `the first iteration failed to launch: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
          },
        }));
      }
      throw err;
    }
    if (result.duplicate) {
      throw new PlaybookChainError('launch was deduplicated against an existing task; chain not started', 409);
    }
    this.deps.logger?.info?.(
      `[playbook-chain] started chain ${chain.chainId} with task ${result.task.id} (${describeBounds(chain)}) playbook=${prepared.playbook.id}`,
    );
    return result;
  }

  /**
   * Ask the chain containing `taskId` to stop after its current iteration.
   * Any member's id is accepted; the request lands on the chain's tip.
   */
  stopChain(taskId: string, by: 'operator' | 'agent', reason?: string): StopChainResult {
    const member = this.deps.taskStore.getTask(taskId);
    if (!member) return { ok: false, status: 404, error: `Task not found: ${taskId}` };
    if (!member.chain) return { ok: false, status: 409, error: `Task ${taskId} is not part of a playbook chain` };
    const tip = this.findTip(member.chain.chainId);
    if (!tip?.chain) return { ok: false, status: 404, error: `Chain ${member.chain.chainId} has no tasks left` };
    if (tip.chain.ended) {
      return { ok: false, status: 409, error: `Chain already ended (${tip.chain.ended.reason})` };
    }
    if (tip.chain.stopRequest) return { ok: true, tip, alreadyRequested: true };
    const trimmed = reason?.trim().slice(0, 500);
    const updated = this.deps.taskStore.updateChain(tip.id, (chain) => ({
      ...chain,
      stopRequest: { at: this.now().toISOString(), by, ...(trimmed ? { reason: trimmed } : {}) },
    }));
    this.deps.logger?.info?.(
      `[playbook-chain] stop requested for chain ${tip.chain.chainId} by ${by} at iteration ${tip.chain.iteration}${trimmed ? `: ${trimmed}` : ''}`,
    );
    this.deps.onChanged?.(tip.id);
    return { ok: true, tip: updated ?? tip, alreadyRequested: false };
  }

  /** Every member of a chain, oldest first. */
  listChain(chainId: string): Task[] {
    return this.deps.taskStore.viewTasks()
      .filter((task) => task.chain?.chainId === chainId)
      .sort((a, b) => (a.chain!.iteration - b.chain!.iteration))
      .map((task) => this.deps.taskStore.getTask(task.id)!)
      .filter(Boolean);
  }

  /** The chain's newest task: the member with the highest iteration. */
  findTip(chainId: string): Task | undefined {
    let tip: Task | undefined;
    for (const task of this.deps.taskStore.viewTasks()) {
      if (task.chain?.chainId !== chainId) continue;
      if (!tip || task.chain.iteration > tip.chain!.iteration) tip = task;
    }
    return tip ? this.deps.taskStore.getTask(tip.id) : undefined;
  }

  /** One pass over every chain whose tip has not ended. Never runs twice at once. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const tip of this.unsettledTips()) {
        try {
          await this.advance(tip);
        } catch (err) {
          this.deps.logger?.error?.(
            `[playbook-chain] sweep failed for chain ${tip.chain?.chainId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  private unsettledTips(): Task[] {
    const tips = new Map<string, Task>();
    for (const task of this.deps.taskStore.viewTasks()) {
      if (!task.chain) continue;
      const current = tips.get(task.chain.chainId);
      if (!current || task.chain.iteration > current.chain!.iteration) tips.set(task.chain.chainId, task);
    }
    return [...tips.values()].filter((tip) => !tip.chain!.ended && !tip.chain!.successorTaskId);
  }

  private async advance(tipRef: Task): Promise<void> {
    const tip = this.deps.taskStore.getTask(tipRef.id);
    if (!tip?.chain || tip.chain.ended || tip.chain.successorTaskId) return;
    const decision = decideChainStep({
      status: tip.status,
      chain: tip.chain,
      createdAt: tip.createdAt,
      finishedAt: tip.finishedAt,
      firstSessionAt: firstSessionAt(tip),
      sessionCount: tip.sessions.length,
      terminalReceipt: tip.terminalReceipt,
    }, this.now());

    if (decision.kind === 'wait') {
      if (tip.status !== 'inProgress') return;
      if (tip.pendingSignal?.kind === 'completion_ready') await this.closeSignalledTip(tip);
      else await this.checkIdleBackstop(tip);
      return;
    }
    this.idleSince.delete(tip.id);
    if (decision.kind === 'end') {
      this.endChain(tip, decision.reason, decision.detail);
      return;
    }

    // Exactly-once: a successor created before a crash (or by a concurrent
    // path) is already stamped with this iteration. Adopt it.
    const existing = this.deps.taskStore.viewTasks().find((task) =>
      task.chain?.chainId === tip.chain!.chainId && task.chain.iteration === decision.next.iteration);
    if (existing) {
      this.linkSuccessor(tip.id, existing.id);
      return;
    }

    const chainId = tip.chain.chainId;
    try {
      const result = await this.launchSuccessor(tip, decision.next);
      this.launchFailures.delete(chainId);
      this.linkSuccessor(tip.id, result.task.id);
      this.deps.logger?.info?.(
        `[playbook-chain] chain ${chainId}: launched iteration ${decision.next.iteration} as task ${result.task.id}`
        + `${result.queued ? ' (queued)' : ''}`,
      );
      this.deps.onChanged?.(result.task.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isHoldError(err)) {
        this.deps.logger?.info?.(`[playbook-chain] chain ${chainId}: next iteration held (${message}); will retry`);
        return;
      }
      // The launcher created the task before failing: it is now the tip and
      // its classification (never started) accounts for this failure.
      const created = this.deps.taskStore.viewTasks().find((task) =>
        task.chain?.chainId === chainId && task.chain.iteration === decision.next.iteration);
      if (created) {
        this.linkSuccessor(tip.id, created.id);
        this.deps.logger?.warn?.(`[playbook-chain] chain ${chainId}: iteration ${decision.next.iteration} failed to start: ${message}`);
        return;
      }
      const failures = (this.launchFailures.get(chainId) ?? 0) + 1;
      this.launchFailures.set(chainId, failures);
      this.deps.logger?.warn?.(
        `[playbook-chain] chain ${chainId}: launching iteration ${decision.next.iteration} failed (${failures}/${CHAIN_MAX_LAUNCH_FAILURES}): ${message}`,
      );
      if (failures >= CHAIN_MAX_LAUNCH_FAILURES) {
        this.launchFailures.delete(chainId);
        this.endChain(tip, 'launch_failed', message.slice(0, 500));
      }
    }
  }

  /**
   * Idle backstop (RFC R3). An iteration whose agent finished but never closed
   * its task would stall the chain forever. Kookr's `needs_input` anomaly (not
   * a question) marks an agent idle at its prompt; it is not raised while the
   * agent is parked on background shells or crons, and the Monitor suppresses
   * it while subagents are outstanding. Once a tip has been in that state for
   * {@link CHAIN_IDLE_COMPLETE_MS} without interruption, complete it so the
   * next sweep can advance the chain. A live AskUserQuestion never qualifies.
   */
  private isIdle(taskId: string): boolean {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task || task.status !== 'inProgress' || task.pendingSignal) return false;
    if (this.deps.isProviderPaused?.(task) === true) return false;
    return isIdleWithoutQuestion(this.deps.monitor, task);
  }

  private async checkIdleBackstop(tip: Task): Promise<void> {
    const idle = this.isIdle(tip.id);
    if (!idle) {
      this.idleSince.delete(tip.id);
      return;
    }
    const nowMs = this.now().getTime();
    const since = this.idleSince.get(tip.id);
    if (since === undefined) {
      this.idleSince.set(tip.id, nowMs);
      return;
    }
    if (nowMs - since < CHAIN_IDLE_COMPLETE_MS) return;
    this.idleSince.delete(tip.id);
    this.deps.logger?.info?.(
      `[playbook-chain] chain ${tip.chain?.chainId}: iteration ${tip.chain?.iteration} (task ${tip.id}) `
      + `idle for ${Math.round((nowMs - since) / 60_000)} min without closing; completing it`,
    );
    const completed = await this.deps.completeIteration(tip, 'idle', () => this.isIdle(tip.id));
    if (!completed) return;
    const startedMs = firstSessionAt(tip)?.getTime() ?? since;
    const activeMs = Math.max(0, since - startedMs);
    this.deps.taskStore.updateChain(tip.id, (chain) => ({ ...chain, idleClosedAfterActiveMs: activeMs }));
    this.deps.onChanged?.(tip.id);
  }

  /**
   * The agent raised `completion-ready`: for a chain that is the iteration
   * boundary. Kookr's generic auto-close would wait out the review window
   * (`autoCloseCompletionReadyDelayMin`) and hold for an open PR, which the
   * research playbook deliberately leaves open — so the chain closes the tip
   * itself once the agent's turn has ended (or after a ceiling).
   */
  private async closeSignalledTip(tip: Task): Promise<void> {
    this.idleSince.delete(tip.id);
    const raisedAtMs = Date.parse(tip.pendingSignal?.raisedAt ?? '');
    if (!Number.isFinite(raisedAtMs)) return;
    const ageMs = this.now().getTime() - raisedAtMs;
    if (ageMs < CHAIN_SIGNAL_SETTLE_MS) return;
    if (ageMs < CHAIN_SIGNAL_CLOSE_CEILING_MS && turnIsRunning(this.deps.monitor, tip)) return;
    const stillSignalled = (): boolean => {
      const current = this.deps.taskStore.getTask(tip.id);
      return current?.status === 'inProgress' && current.pendingSignal?.kind === 'completion_ready';
    };
    this.deps.logger?.info?.(
      `[playbook-chain] chain ${tip.chain?.chainId}: iteration ${tip.chain?.iteration} (task ${tip.id}) signalled completion; closing it`,
    );
    const completed = await this.deps.completeIteration(tip, 'signalled', stillSignalled);
    if (completed) this.deps.onChanged?.(tip.id);
  }

  private async launchSuccessor(tip: Task, next: TaskChainState): Promise<LaunchResult> {
    const source = tip.playbookSource;
    if (!source) throw new Error(`chain tip ${tip.id} has no recorded playbook source`);
    const intent = tip.launchIntent;
    const prepared = await this.prepare({
      // Project-scope playbooks are read from the source checkout; other
      // scopes resolve their own directory and ignore it. No explicit
      // projectId: prepare re-derives it from the same parameters, and an
      // explicit one is checked strictly against the cwd's own project, which
      // a playbook targeting another repository legitimately fails.
      playbookSourceCwd: source.scope === 'project' ? source.sourceCwd : tip.cwd,
      taskTargetCwd: tip.cwd,
      taskTargetCwdExplicit: false,
      playbookPath: source.id,
      scope: source.scope,
      parameterValues: { ...(tip.playbookParameterValues ?? {}) },
      // Pin the agent the chain has been running on; never fall back to the
      // spawn default for a successor.
      agentType: tip.agentType,
      ...(intent?.modelTier === undefined && intent?.effort ? { effort: intent.effort } : {}),
      ...(intent?.modelTier === undefined && intent?.model ? { model: intent.model } : {}),
    });
    const automationProjectId = await this.deps.resolveAutomationProjectId(prepared.launchOpts.cwd);
    return this.deps.launchTask(
      {
        ...chainLaunchOpts(prepared, next, 'chain'),
        parentTaskId: tip.id,
        ...(intent?.modelTier !== undefined ? { modelTier: intent.modelTier } : {}),
      },
      { deliveryPolicy: prepared.deliveryPolicy, automationProjectId, chain: next },
    );
  }

  /**
   * Record that `predecessorId` advanced to `successorId`. A stop request that
   * landed on the predecessor while the successor was being launched is
   * carried over, so it is never lost whichever way the launch went.
   */
  private linkSuccessor(predecessorId: string, successorId: string): void {
    this.deps.taskStore.updateChain(predecessorId, (chain) => ({ ...chain, successorTaskId: successorId }));
    const stopRequest = this.deps.taskStore.getTask(predecessorId)?.chain?.stopRequest;
    if (stopRequest && !this.deps.taskStore.getTask(successorId)?.chain?.stopRequest) {
      this.deps.taskStore.updateChain(successorId, (chain) => ({ ...chain, stopRequest }));
    }
  }

  private endChain(tip: Task, reason: ChainEndReason, detail?: string): void {
    this.deps.taskStore.updateChain(tip.id, (chain) => ({
      ...chain,
      ended: { at: this.now().toISOString(), reason, ...(detail ? { detail } : {}) },
    }));
    this.deps.logger?.info?.(
      `[playbook-chain] chain ${tip.chain?.chainId} ended after iteration ${tip.chain?.iteration}: ${reason}${detail ? ` — ${detail}` : ''}`,
    );
    this.deps.onChanged?.(tip.id);
  }
}

/** Launch options shared by the first iteration and every successor. */
function chainLaunchOpts(prepared: PreparedPlaybookLaunch, chain: TaskChainState, launchSource: TaskLaunchSource): LaunchOpts {
  return {
    ...prepared.launchOpts,
    prompt: `${renderChainPreamble(chain)}\n\n${prepared.launchOpts.prompt}`,
    // Each iteration completes as soon as its agent raises completion-ready,
    // so the chain does not wait out the one-hour review grace between
    // iterations.
    autoCloseOnSignal: true,
    // Every iteration has the same playbook prompt; never collapse them.
    disableDedup: true,
    // Nobody is expected to answer an iteration's questions: interactive tools
    // fail fast and flag the task instead of parking the chain for the night.
    unattended: true,
    launchSource,
  };
}

/**
 * True when the tip's one live session is parked at its prompt with nothing
 * asked AND nothing of its own still running. The `needs_input` anomaly alone
 * is not enough: its background-work suppression expires (a long background
 * shell after the watchdog's park grace, a slow subagent after its TTL), so
 * the raw Stop's background counts and the untimed subagent count are checked
 * here too — a lead waiting on a long refresh or a slow worker is never cut off.
 */
function isIdleWithoutQuestion(monitor: PlaybookChainServiceDeps['monitor'], task: Task): boolean {
  const live = task.sessions.filter(
    (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && !s.crashRecovered,
  );
  if (live.length !== 1) return false;
  const sessionId = live[0].tmuxSession;
  const anomaly = monitor.getCurrentAnomaly(sessionId);
  if (anomaly?.type !== 'needs_input' || anomaly.subType === 'ask_user_question') return false;
  if (monitor.getOutstandingSubagentCount(sessionId) > 0) return false;
  const { turnState, effectiveEvent } = deriveTurnStateDetails(monitor.getAgentEvents(sessionId));
  if (turnState !== 'completed_turn' || effectiveEvent?.type !== 'stop') return false;
  return !isBackgroundParked(effectiveEvent);
}

/** True while the tip's live session is mid-turn (tool calls / reasoning). */
function turnIsRunning(monitor: PlaybookChainServiceDeps['monitor'], task: Task): boolean {
  const live = task.sessions.filter(
    (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && !s.crashRecovered,
  );
  const session = live[live.length - 1];
  if (!session) return false;
  return deriveTurnStateDetails(monitor.getAgentEvents(session.tmuxSession)).turnState === 'running';
}

function firstSessionAt(task: Task): Date | undefined {
  let earliest: Date | undefined;
  for (const session of task.sessions) {
    const at = session.createdAt instanceof Date ? session.createdAt : new Date(session.createdAt);
    if (!Number.isFinite(at.getTime())) continue;
    if (!earliest || at < earliest) earliest = at;
  }
  return earliest;
}

function describeBounds(chain: TaskChainState): string {
  const parts: string[] = [];
  if (chain.maxIterations !== undefined) parts.push(`${chain.maxIterations} iterations`);
  if (chain.deadlineAt !== undefined) parts.push(`until ${chain.deadlineAt}`);
  return parts.join(', ');
}
