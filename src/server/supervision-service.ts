/**
 * `SupervisionService` — the single owner of attached task supervisions at
 * runtime (RFC attachable-task-supervisor, P2a).
 *
 * Every 60 s `tick()` lists the supervisions under `<dataDir>/supervisions`,
 * builds a view of each supervisor from the task store and the monitor, asks
 * the pure `decide()` what to do, executes the actions, and persists the result
 * to `state.json` atomically. Nothing is kept in memory between ticks, so a
 * restarted server recomputes from files and current task state and cannot
 * deliver the deadline wake twice (R2).
 *
 * Autonomy gate. Delivering a wake and starting a replacement supervisor are
 * autonomous actuation. They are allowed only when ALL hold: the env kill
 * switch `KOOKR_SUPERVISION_WAKE_DISABLED` is off, the node is not draining,
 * and `mayAutonomousActuate({ source: 'supervision' })` allows it (global SAFE
 * MODE off, the SUPERVISOR task's project not paused). Status, the
 * `wakes-disabled` / dead-supervisor alerts and intentional endings keep
 * working when the gate is closed.
 *
 * Lifecycle rules. A supervisor that completed, signalled completion-ready, or
 * was cancelled/terminated by an operator ends the mandate and is never
 * revived; only a crash-like end is restarted. A supervision whose launch never
 * recorded a supervisor task is adopted from the idempotency key
 * `supervise-<id>`, else ended `launch-failed`. A replacement launch persists
 * `pendingEpisodeKey` first so a crash between launch and record adopts the task
 * instead of launching another.
 *
 * Operator alerts reuse the existing operational-alert channel: the caller
 * passes `alert` (index.ts wires `detectorBroadcast`, which broadcasts to the
 * dashboard and spools into the operator-signal outbox that the Telegram/Discord
 * delivery bridge drains). No second outbound path exists here.
 */

import { AgentInputRefusedError, asInputRefusal, guardChoiceDialog } from '../core/choice-dialog-guard.js';
import { mayAutonomousActuate, EMPTY_PAUSED_PROJECT_IDS } from '../core/automation-kill-switch.js';
import type { Monitor } from '../core/monitor.js';
import {
  DEFAULT_POLICY_CONFIG,
  MINUTE_MS,
  decide,
  nextWake,
  type PolicyConfig,
  type SupervisionAction,
  type SupervisorExit,
  type SupervisorView,
} from '../core/supervision/supervision-policy.js';
import {
  listSupervisionStates,
  readSupervisionBrief,
  readSupervisionState,
  supervisionBriefPath,
  writeSupervisionState,
  type SupervisionFs,
  type SupervisionHealth,
  type SupervisionState,
} from '../core/supervision/supervision-files.js';
import { isRecoverableTermination } from '../shared/contracts/task-status.js';
import { deriveTurnStateDetails } from '../core/turn-state.js';
import type { TaskStore } from '../core/tasks.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

export const SUPERVISION_TICK_INTERVAL_MS = 60_000;
/**
 * After startup recovery completes, the service still waits this long (hook replay can lag)
 * before it delivers, restarts, adopts or alerts. Nothing at all happens before recovery completes.
 */
export const SUPERVISION_SETTLE_MS = MINUTE_MS;
/** A task terminated for a recoverable reason this recently may still be relaunched by crash recovery. */
export const SUPERVISION_RECOVERY_GRACE_MS = 2 * MINUTE_MS;
const DEFAULT_HEARTBEAT_MIN = 45;

/** Same truthiness as `isSelfAdvancingDisabled`: set and not one of the explicit "off" spellings. */
export function isSupervisionWakeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.KOOKR_SUPERVISION_WAKE_DISABLED;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === '') return false;
  return !['0', 'false', 'no', 'off'].includes(value);
}

export function resolveHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.KOOKR_SUPERVISION_HEARTBEAT_MIN);
  const minutes = Number.isFinite(n) && n >= 1 ? n : DEFAULT_HEARTBEAT_MIN;
  return Math.round(minutes * MINUTE_MS);
}

type WakeKind = 'heartbeat' | 'deadline' | 'final';

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The one-line wake typed into the supervisor's prompt. */
export function formatWakeLine(kind: WakeKind, state: SupervisionState, briefPath: string): string {
  const n = state.targets.length;
  const targets = `${n} target${n === 1 ? '' : 's'}`;
  const head = `[kookr supervision ${state.supervisionId}]`;
  switch (kind) {
    case 'heartbeat':
      return `${head} mandate until ${hhmm(state.deadlineAt)} · ${targets} · brief: ${briefPath}`;
    case 'deadline':
      return `${head} mandate ended: recap and signal completion-ready · brief: ${briefPath}`;
    case 'final':
      return `${head} ${targets} finished: recap and signal completion-ready · brief: ${briefPath}`;
  }
}

export interface LaunchSupervisorInput {
  prompt: string;
  /** The previous supervisor's working directory; the wiring derives the project stamp from it. */
  cwd: string;
  idempotencyKey: string;
}

export interface SupervisionServiceDeps {
  dataDir: string;
  taskStore: Pick<TaskStore, 'getTask' | 'getAllTasks' | 'listRelations' | 'upsertRelation'>;
  monitor: Pick<Monitor, 'getAgentEvents' | 'isAwaitingChoice' | 'getEventCounts'>;
  adapter: Pick<AgentAdapter, 'sendInput'>;
  /** Launch a fresh task-supervisor task (playbook + autonomous gate live in the wiring). Returns its task id. */
  launchSupervisor: (input: LaunchSupervisorInput) => Promise<{ taskId: string }>;
  /** End a superseded supervisor task. Best effort. */
  abortTask: (taskId: string) => Promise<void>;
  /** Working directory for a replacement when the old supervisor's task is gone. */
  defaultCwd: string;
  alert: (msg: Extract<ServerMessage, { type: 'alert' }>) => void;
  isAccepting?: () => boolean;
  isAutomationEnabled?: () => boolean;
  getPausedProjectIds?: () => ReadonlySet<string>;
  /** Project identity of a working directory; the supervisor task's cwd is what gets paused/gated. */
  getProjectId?: (cwd: string) => string | Promise<string>;
  /**
   * Epoch ms at which startup recovery (session reattach, hook replay, crash relaunch) finished,
   * or undefined while it is still running. Omitted in minimal harnesses: treated as long complete.
   */
  getStartupReadyAtMs?: () => number | undefined;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  fs?: SupervisionFs;
  log?: (line: string) => void;
}

export interface SupervisionStatus {
  supervisionId: string;
  state: SupervisionState;
  /** `ended` once ended; `dead` when the supervisor crashed right now; otherwise the persisted health. */
  health: SupervisionHealth;
  nextWake?: { kind: 'heartbeat' | 'deadline'; at: string };
  /** False while wakes are gated: kill switch, or (as of the last tick) SAFE MODE, drain or a paused project. */
  wakesEnabled: boolean;
  supervisor: { taskId: string | null; taskTerminal: boolean; hasLiveSession: boolean; deliverable: boolean; exit?: SupervisorExit };
  targets: Array<{ taskId: string; name: string; status: string }>;
  briefPath: string;
}

type SupervisorTask = NonNullable<ReturnType<SupervisionServiceDeps['taskStore']['getTask']>>;

export class SupervisionService {
  private chain: Promise<unknown> = Promise.resolve();
  private tickPending = false;
  /** Per-supervision gate result of the last tick, for status. */
  private readonly gateByProject = new Map<string, boolean>();

  constructor(private readonly deps: SupervisionServiceDeps) {}

  /** True once startup recovery has completed and the post-recovery settle window has passed. */
  private recoverySettled(): boolean {
    if (!this.deps.getStartupReadyAtMs) return true;
    const readyAt = this.deps.getStartupReadyAtMs();
    return readyAt !== undefined && this.now().getTime() - readyAt >= SUPERVISION_SETTLE_MS;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(l)))(`[supervision] ${line}`);
  }

  /** Run `fn` after every earlier mutation, so a tick and an operator `end` never interleave. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private activeSessionId(taskId: string | null): string | undefined {
    if (taskId === null) return undefined;
    const task = this.deps.taskStore.getTask(taskId);
    return task?.sessions.find((s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted')?.tmuxSession;
  }

  /** Classify a supervisor that is no longer serving; undefined while it is. Only `crashed` may be revived. */
  private classifyExit(task: SupervisorTask | undefined, hasSession: boolean): SupervisorExit | undefined {
    if (!task) return 'operator'; // deleted or pruned: not a crash
    switch (task.status) {
      case 'completed':
        return 'finished';
      case 'cancelled':
        return 'operator';
      case 'terminated':
        return task.terminationReason === 'manual' || task.terminationReason === 'supervisor' ? 'operator' : 'crashed';
      default:
        if (task.pendingSignal?.kind === 'completion_ready') return 'finished';
        return task.status === 'inProgress' && !hasSession ? 'crashed' : undefined;
    }
  }

  private buildView(state: SupervisionState): SupervisorView {
    const task = state.supervisorTaskId === null ? undefined : this.deps.taskStore.getTask(state.supervisorTaskId);
    const taskTerminal = !task || isTerminalStatus(task.status);
    const sessionId = taskTerminal ? undefined : this.activeSessionId(state.supervisorTaskId);
    // A launched-but-not-yet-running supervisor (open / pending) is alive, just not deliverable.
    const hasLiveSession = !taskTerminal && (task?.status !== 'inProgress' || sessionId !== undefined);
    let deliverable = false;
    if (sessionId !== undefined) {
      const { effectiveEvent } = deriveTurnStateDetails(this.deps.monitor.getAgentEvents(sessionId));
      deliverable = effectiveEvent?.type === 'stop' && !this.deps.monitor.isAwaitingChoice(sessionId);
    }
    const allTargetsTerminal = state.targets.length > 0 && state.targets.every((t) => {
      const target = this.deps.taskStore.getTask(t.taskId);
      return !target || isTerminalStatus(target.status);
    });
    const exit = state.supervisorTaskId === null ? undefined : this.classifyExit(task, sessionId !== undefined);
    // Defence in depth: a recoverable termination moments ago may still be relaunched by crash recovery.
    // Not a crash yet; if it is still terminal once the grace has passed, it is.
    const recovering = exit === 'crashed' && task?.status === 'terminated'
      && isRecoverableTermination(task.terminationReason)
      && this.now().getTime() - task.updatedAt.getTime() < SUPERVISION_RECOVERY_GRACE_MS;
    return {
      ...(recovering ? { recovering: true } : {}),
      taskTerminal,
      hasLiveSession,
      deliverable,
      allTargetsTerminal,
      ...(exit ? { exit } : {}),
      ...(state.supervisorEventAt ? { lastActivityAt: state.supervisorEventAt } : {}),
    };
  }

  /** Global part of the autonomy gate (kill switch, drain). */
  private globallyGated(): boolean {
    return isSupervisionWakeDisabled(this.env) || (this.deps.isAccepting !== undefined && !this.deps.isAccepting());
  }

  /** The full gate for one supervision: global, SAFE MODE, and the SUPERVISOR task's project pause. */
  private async actuationAllowed(state: SupervisionState): Promise<boolean> {
    if (this.globallyGated()) return false;
    const task = state.supervisorTaskId === null ? undefined : this.deps.taskStore.getTask(state.supervisorTaskId);
    const projectId = this.deps.getProjectId ? await this.deps.getProjectId(task?.cwd ?? this.deps.defaultCwd) : undefined;
    return mayAutonomousActuate({
      source: 'supervision',
      projectId,
      globalEnabled: this.deps.isAutomationEnabled?.() ?? true,
      pausedProjectIds: this.deps.getPausedProjectIds?.() ?? EMPTY_PAUSED_PROJECT_IDS,
    }) === 'allow';
  }

  private policyConfig(actuationAllowed: boolean): PolicyConfig {
    return { ...DEFAULT_POLICY_CONFIG, heartbeatMs: resolveHeartbeatMs(this.env), actuationAllowed };
  }

  /** One pass over every active supervision. Never throws; a tick already pending is not queued twice. */
  tick(): Promise<void> {
    if (this.tickPending) return Promise.resolve();
    this.tickPending = true;
    return this.serial(async () => {
      this.tickPending = false;
      // Gate EVERY actuation on startup recovery: right after a restart the supervisor may be
      // `terminated` only because crash recovery has not relaunched it yet.
      if (!this.recoverySettled()) return;
      try {
        for (const initial of listSupervisionStates(this.deps.dataDir)) {
          if (initial.endedAt !== undefined) continue;
          try {
            await this.tickOne(initial);
          } catch (err) {
            this.log(`tick failed for ${initial.supervisionId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        this.log(`tick failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private findTaskByKey(key: string): SupervisorTask | undefined {
    return this.deps.taskStore.getAllTasks().find((t) => t.launchIntent?.idempotencyKey === key);
  }

  private async tickOne(initial: SupervisionState): Promise<void> {
    const now = this.now();
    let state = await this.reconcile(initial, now);
    if (state.endedAt !== undefined) return;
    state = this.trackActivity(state, now);
    const allowed = await this.actuationAllowed(state);
    this.gateByProject.set(state.supervisionId, allowed);
    const actions = decide(state, this.buildView(state), now, this.policyConfig(allowed));
    for (const action of actions) state = await this.execute(state, action, now);
  }

  /** Adopt a launch that finished without being recorded, or end a mandate that never got a supervisor. */
  private async reconcile(state: SupervisionState, now: Date): Promise<SupervisionState> {
    if (state.supervisorTaskId === null) {
      const age = now.getTime() - Date.parse(state.createdAt);
      if (age < DEFAULT_POLICY_CONFIG.launchGraceMs) return state;
      const found = this.findTaskByKey(`supervise-${state.supervisionId}`);
      if (found) {
        this.log(`adopting supervisor ${found.id} for ${state.supervisionId} (launch was not recorded)`);
        return this.completeEpisode(state, found.id, now, false);
      }
      const ended = this.persist(state, { endedAt: now.toISOString(), endedReason: 'launch-failed', health: 'ended' });
      this.raiseAlert(ended, 'launch-failed');
      return ended;
    }
    if (state.pendingEpisodeKey !== undefined) {
      const found = this.findTaskByKey(state.pendingEpisodeKey);
      if (found && found.id !== state.supervisorTaskId) {
        this.log(`adopting replacement supervisor ${found.id} for ${state.supervisionId} (crash before it was recorded)`);
        return this.completeEpisode(state, found.id, now, true);
      }
      return this.persist(state, { pendingEpisodeKey: undefined });
    }
    return state;
  }

  /** Remember when the supervisor session last produced a hook event (hung detection). */
  private trackActivity(state: SupervisionState, now: Date): SupervisionState {
    const sessionId = this.activeSessionId(state.supervisorTaskId);
    if (sessionId === undefined) return state;
    const count = this.deps.monitor.getEventCounts()[sessionId];
    if (count === undefined || count === state.supervisorEventCount) return state;
    return this.persist(state, { supervisorEventCount: count, supervisorEventAt: now.toISOString() });
  }

  private persist(state: SupervisionState, patch: Partial<SupervisionState>): SupervisionState {
    const next: SupervisionState = { ...state, ...patch };
    for (const key of Object.keys(patch) as Array<keyof SupervisionState>) {
      if (patch[key] === undefined) delete next[key];
    }
    writeSupervisionState(this.deps.dataDir, next, this.deps.fs);
    return next;
  }

  private async execute(state: SupervisionState, action: SupervisionAction, now: Date): Promise<SupervisionState> {
    const nowIso = now.toISOString();
    const heartbeatMs = resolveHeartbeatMs(this.env);
    switch (action.type) {
      case 'markHealth':
        return this.persist(state, {
          health: action.health,
          undeliverableTicks: action.undeliverableTicks,
          undeliverableSince: action.undeliverableSince,
        });
      case 'markEnded':
        return this.persist(state, { endedAt: nowIso, endedReason: action.reason, health: 'ended' });
      case 'alertOperator':
        return this.alertOperator(state, action.reason);
      case 'deliverHeartbeat':
      case 'deliverDeadline':
      case 'deliverFinal': {
        const kind: WakeKind = action.type === 'deliverHeartbeat' ? 'heartbeat' : action.type === 'deliverDeadline' ? 'deadline' : 'final';
        // At most once for the deadline wake: persist the attempt BEFORE typing.
        if (kind === 'deadline') state = this.persist(state, { deadlineWakeAttemptedAt: nowIso });
        const outcome = await this.deliver(state, kind);
        if (outcome !== 'sent') {
          // Definitely not sent: the deadline wake may be retried. Ambiguous (failed): never retype it.
          if (kind === 'deadline' && outcome === 'refused') state = this.persist(state, { deadlineWakeAttemptedAt: undefined });
          // Refused or failed: an undeliverable tick, never retried within this tick.
          const ticks = (state.undeliverableTicks ?? 0) + 1;
          return this.persist(state, {
            undeliverableTicks: ticks,
            undeliverableSince: state.undeliverableSince ?? nowIso,
            ...(ticks >= DEFAULT_POLICY_CONFIG.undeliverableTicks ? { health: 'degraded:undeliverable' as const } : {}),
          });
        }
        return this.persist(state, {
          lastDeliveredAt: nowIso,
          undeliverableTicks: 0,
          undeliverableSince: undefined,
          health: 'healthy',
          lastAlertReason: undefined,
          ...(kind === 'heartbeat' ? { nextHeartbeatAt: new Date(now.getTime() + heartbeatMs).toISOString() } : {}),
          ...(kind === 'deadline' ? { deadlineWakeDeliveredAt: nowIso } : {}),
          ...(kind === 'final' ? { finalWakeDeliveredAt: nowIso } : {}),
        });
      }
      case 'restartEpisode':
        return this.restartEpisode(state, action.cause, now);
    }
  }

  /** Type the wake through the P0 choice-dialog guard. True only when the adapter accepted it. */
  private async deliver(state: SupervisionState, kind: WakeKind): Promise<'sent' | 'refused' | 'failed'> {
    const sessionId = this.activeSessionId(state.supervisorTaskId);
    if (sessionId === undefined) return 'refused';
    const line = formatWakeLine(kind, state, supervisionBriefPath(this.deps.dataDir, state.supervisionId));
    try {
      const opts = guardChoiceDialog(sessionId, (id) => this.deps.monitor.isAwaitingChoice(id));
      try {
        await (opts ? this.deps.adapter.sendInput(sessionId, line, opts) : this.deps.adapter.sendInput(sessionId, line));
      } catch (err) {
        throw asInputRefusal(err, sessionId);
      }
      return 'sent';
    } catch (err) {
      this.log(`${kind} wake for ${state.supervisionId} not delivered: ${err instanceof Error ? err.message : String(err)}`);
      // A guard refusal definitely typed nothing submittable; any other error is ambiguous.
      return err instanceof AgentInputRefusedError ? 'refused' : 'failed';
    }
  }

  private raiseAlert(state: SupervisionState, reason: string): void {
    const critical = reason === 'restart-limit-reached' || reason === 'restart-failed' || reason === 'launch-failed';
    this.deps.alert({
      type: 'alert',
      agentId: OPERATIONAL_ALERT_AGENT_ID,
      summary: `Supervision ${state.supervisionId}: supervisor needs attention (${reason})`,
      details:
        `Supervisor task ${state.supervisorTaskId ?? 'none'} for ${state.targets.length} target(s) ` +
        `(mandate until ${state.deadlineAt}): ${reason}. Fresh episodes used: ${state.restartCount ?? 0}. ` +
        `Check with \`kookr supervision status ${state.supervisionId}\`.`,
      severity: critical ? 'critical' : 'warning',
      operationalAlert: {
        key: `supervision:${state.supervisionId}:${reason}:${state.restartCount ?? 0}`,
        metric: 'supervision_watchdog',
        state: 'fired',
      },
    });
  }

  private alertOperator(state: SupervisionState, reason: string): SupervisionState {
    this.raiseAlert(state, reason);
    return this.persist(state, { lastAlertReason: reason });
  }

  /** Record `newId` as the supervisor: move the `supervises` projection, reset health, and end a still-live predecessor. */
  private async completeEpisode(state: SupervisionState, newId: string, now: Date, endPrevious: boolean): Promise<SupervisionState> {
    const nowIso = now.toISOString();
    const previousId = state.supervisorTaskId;
    if (previousId !== null && previousId !== newId) {
      for (const rel of this.deps.taskStore.listRelations({ sourceTaskId: previousId, type: 'supervises' })) {
        if (rel.lifecycle !== 'active') continue;
        this.deps.taskStore.upsertRelation({
          sourceTaskId: rel.sourceTaskId,
          targetTaskId: rel.targetTaskId,
          type: 'supervises',
          confidence: rel.confidence,
          source: rel.source,
          lifecycle: 'superseded',
        });
      }
    }
    for (const t of state.targets) {
      this.deps.taskStore.upsertRelation({
        sourceTaskId: newId,
        targetTaskId: t.taskId,
        type: 'supervises',
        confidence: 1,
        source: 'api',
        evidence: [{ snippet: `supervision:${state.supervisionId}`, observedAt: nowIso }],
      });
    }

    state = this.persist(state, {
      supervisorTaskId: newId,
      episodes: [...(state.episodes ?? []), { supervisorTaskId: newId, startedAt: nowIso }],
      health: 'healthy',
      undeliverableTicks: 0,
      undeliverableSince: undefined,
      nextHeartbeatAt: new Date(now.getTime() + resolveHeartbeatMs(this.env)).toISOString(),
      lastAlertReason: undefined,
      pendingEpisodeKey: undefined,
      supervisorEventCount: undefined,
      supervisorEventAt: undefined,
    });

    if (endPrevious && previousId !== null && previousId !== newId) {
      // Re-read fresh: only a predecessor that is still non-terminal needs ending.
      const fresh = this.deps.taskStore.getTask(previousId);
      if (fresh && !isTerminalStatus(fresh.status)) {
        try {
          await this.deps.abortTask(previousId);
        } catch (err) {
          this.log(`could not end superseded supervisor ${previousId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    return state;
  }

  private async restartEpisode(state: SupervisionState, cause: string, now: Date): Promise<SupervisionState> {
    const nowIso = now.toISOString();
    const attempt = (state.restartCount ?? 0) + 1;
    const key = `supervision-${state.supervisionId}-episode-${attempt}`;
    // Persist the attempt and its key BEFORE launching: a crash mid-launch cannot loop, and the
    // next tick adopts the task created under the key rather than launching another.
    state = this.persist(state, { restartCount: attempt, lastRestartAt: nowIso, pendingEpisodeKey: key });
    const previousId = state.supervisorTaskId;
    const previous = previousId === null ? undefined : this.deps.taskStore.getTask(previousId);
    const brief = readSupervisionBrief(this.deps.dataDir, state.supervisionId) ?? '';
    const prompt = [
      `You are a fresh episode of supervision ${state.supervisionId}; the previous supervisor ${previousId ?? '(none)'} stopped (${cause}). Re-read the targets before acting.`,
      '',
      brief,
    ].join('\n');

    let newId: string;
    try {
      ({ taskId: newId } = await this.deps.launchSupervisor({
        prompt,
        cwd: previous?.cwd ?? this.deps.defaultCwd,
        idempotencyKey: key,
      }));
    } catch (err) {
      this.log(`fresh episode for ${state.supervisionId} failed to launch: ${err instanceof Error ? err.message : String(err)}`);
      // The key stays: the outcome may be unknown, and the next tick adopts the task if one exists.
      return this.alertOperator(state, 'restart-failed');
    }
    return this.completeEpisode(state, newId, now, true);
  }

  // ---- operator end + status ----

  /** End a mandate on the operator's say-so. Cancels no task. Undefined for an unknown id; idempotent. */
  end(supervisionId: string): Promise<SupervisionStatus | undefined> {
    return this.serial(async () => {
      const state = readSupervisionState(this.deps.dataDir, supervisionId);
      if (!state) return undefined;
      const ended = state.endedAt !== undefined
        ? state
        : this.persist(state, { endedAt: this.now().toISOString(), endedReason: 'operator', health: 'ended' });
      return this.statusOf(ended);
    });
  }

  private statusOf(state: SupervisionState): SupervisionStatus {
    const view = this.buildView(state);
    const health: SupervisionHealth = state.endedAt !== undefined
      ? 'ended'
      : view.exit === 'crashed' ? 'dead' : (state.health ?? 'healthy');
    const cfg = this.policyConfig(true);
    const next = nextWake(state, cfg);
    return {
      supervisionId: state.supervisionId,
      state,
      health,
      ...(next ? { nextWake: next } : {}),
      wakesEnabled: !this.globallyGated() && (this.gateByProject.get(state.supervisionId) ?? true),
      supervisor: {
        taskId: state.supervisorTaskId,
        taskTerminal: view.taskTerminal,
        hasLiveSession: view.hasLiveSession,
        deliverable: view.deliverable,
        ...(view.exit ? { exit: view.exit } : {}),
      },
      targets: state.targets.map((t) => ({
        taskId: t.taskId,
        name: t.name,
        status: this.deps.taskStore.getTask(t.taskId)?.status ?? 'unknown',
      })),
      briefPath: supervisionBriefPath(this.deps.dataDir, state.supervisionId),
    };
  }

  list(): SupervisionStatus[] {
    return listSupervisionStates(this.deps.dataDir).map((s) => this.statusOf(s));
  }

  get(supervisionId: string): SupervisionStatus | undefined {
    const state = readSupervisionState(this.deps.dataDir, supervisionId);
    return state ? this.statusOf(state) : undefined;
  }
}
