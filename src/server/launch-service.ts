import { stat } from 'node:fs/promises';
import type { Task, TaskLaunchHealthSummary, TaskStore } from '../core/tasks.js';
import type { LaunchOpts, LaunchResult as SharedLaunchResult } from '../shared/contracts/launch.js';
import type { DeliveryAuthorization, TaskDispositionReason } from '../shared/contracts/task.js';
import {
  type AgentType,
  type AgentSelection,
  DEFAULT_AGENT_TYPE,
  ROUND_ROBIN_AGENT_TYPE,
  resolveRoundRobinAgent,
  isValidEffortForAgent,
  effortLevelsForAgent,
  isValidModelForAgent,
  modelsForAgent,
} from '../core/agent-types.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { LaunchDependency } from '../core/playbook.js';
import {
  redactDiagnosticText,
  type DependencyPreflightRunner,
  type LaunchPreflightFinding,
} from '../core/launch-dependency-preflight.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import { defaultVerdictPath } from '../core/ralph-iteration-verdict.js';
import { MAX_ACTIVE_TASKS } from './config.js';
import { registerNewAgent, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { hashPrompt } from './hash-prompt.js';
import { runLaunchDependencyPreflights } from './launch-dependency-runner.js';
import { canonicalizeCwd } from './cwd.js';
import { normalizePromptFileReferences } from './prompt-file-paths.js';
import { applyWorktreeGuardrails, type DeliveryPolicy } from './worktree-guardrails.js';
import type { IdempotencyLedger } from '../core/idempotency-ledger.js';
import { isTerminalStatus } from '../core/task-status.js';
import { buildCapacityLedger, isReservedSlotLaunch, type CapacityLedger } from '../core/capacity-ledger.js';
import { spawnBudgetKey, type SpawnRateLimiter, type SpawnRateVerdict } from '../core/spawn-rate-limiter.js';
import { LaunchPhaseTracker, type LaunchPhaseTimings } from '../core/launch-phase-timings.js';

export type { LaunchOpts } from '../shared/contracts/launch.js';
export type LaunchResult = SharedLaunchResult<Task>;

export interface LaunchTaskServerOptions {
  /** Server-internal policy resolved from trusted launch context, never from shared LaunchOpts. */
  deliveryPolicy?: DeliveryPolicy;
}

export interface LaunchServiceDeps {
  taskStore: TaskStore;
  adapterRegistry: AdapterRegistry;
  lifecycleDeps: AgentLifecycleDeps;
  /** Optional live session probe used to keep dedup from trusting stale inProgress records. */
  terminalBackend?: Pick<TerminalBackend, 'isAlive'>;
  /** Live getter for max concurrent tasks. Falls back to static default if not provided. */
  getMaxActiveTasks?: () => number;
  /**
   * Live getter for the configured default agent selection. Falls back to the
   * registry default if not provided. May return the `round-robin` sentinel,
   * which {@link roundRobinCursor} resolves to a concrete agent.
   */
  getDefaultAgentType?: () => AgentSelection;
  /**
   * Round-robin rotation cursor. `peek()` reads the rotation index for the
   * next launch *without* advancing; `advance()` moves the cursor forward and
   * persists it. The launch service peeks when resolving the `round-robin`
   * sentinel and advances only once a task record is actually committed, so a
   * deduplicated or rejected launch never consumes a rotation slot and skews
   * the alternation.
   */
  roundRobinCursor?: { peek: () => number; advance: () => void };
  interactionLog?: DeferredInteractionLogWriter;
  dependencyPreflightRunner?: DependencyPreflightRunner;
  /**
   * Operator drain gate (issue #659). When provided and returning false, the
   * node is draining and {@link launchTask} refuses new launches by throwing
   * {@link DrainModeError}. Omitted (or always-true) means the node accepts
   * launches normally — in-flight agents are never affected either way.
   */
  isAccepting?: () => boolean;
  /**
   * Test seam for the launch cwd existence check (RFC F12). E2E specs launch
   * tasks into the fictional `/test/project` against FakeTerminalBackend,
   * where nothing is ever spawned in that directory; a no-op override keeps
   * those launches accepted. Omitted in production: launches into a missing
   * cwd are rejected with {@link CwdValidationError}.
   */
  validateLaunchCwd?: (cwd: string) => Promise<void>;
  /** True when launches should be audited as running without permission prompts. */
  bypassAllPermissions?: boolean;
  /**
   * Durable idempotency ledger (issue #1526 Phase B). When provided AND the
   * launch request carries `opts.idempotencyKey`, {@link launchTask} routes
   * through the reserve/replay wrapper instead of launching directly.
   * Omitted, or a launch with no key, behaves exactly as before (no
   * idempotency protection) — this keeps every existing caller unaffected.
   */
  idempotencyLedger?: IdempotencyLedger;
  /**
   * Live getter for the adapter-launch hard timeout, in milliseconds (issue
   * #1526 Phase C / #1528, `launchTimeoutSeconds` setting). Read per launch so
   * a settings change applies without a restart. Absent (older wiring/tests)
   * or non-positive/non-finite values fall back to
   * {@link DEFAULT_LAUNCH_TIMEOUT_MS}.
   */
  getLaunchTimeoutMs?: () => number;
  /**
   * Live getter for the pending-queue depth limit (issue #1526 Phase C / C3,
   * `maxPendingTasks` setting). When a launch would pend at capacity and the
   * pending count is already at this limit, `launchTask` throws
   * {@link PendingQueueFullError} instead of silently enqueueing. Absent
   * falls back to {@link DEFAULT_MAX_PENDING_TASKS}.
   */
  getMaxPendingTasks?: () => number;
  /**
   * Per-source spawn budget (issue #1526 Phase C / C3, `spawnBurstLimit` /
   * `spawnBurstWindowMinutes` settings). When provided, task creation is
   * counted per launch source (actor-qualified via `opts.launchActorId`);
   * exceeding the sliding-window budget throws {@link SpawnBurstLimitError}.
   * Schedule-fired launches (`launchSource: 'schedule'`) are exempt — see the
   * limiter's module docs for why. Absent (older wiring/tests) means no
   * budget enforcement.
   */
  spawnRateLimiter?: SpawnRateLimiter;
  /**
   * Reserved self-maintenance slot count (issue #1564, `reservedActiveSlots`
   * setting). When provided and > 0, a launch whose source/actor is NOT in
   * {@link getReservedSlotSources} is admitted only while the active count is
   * below `maxActiveTasks - reservedActiveSlots`; at or above that it pends
   * instead of consuming a reserved slot. Privileged launches use the full
   * `maxActiveTasks`. Absent (older wiring/tests) ⇒ no reservation, unchanged.
   */
  getReservedActiveSlots?: () => number;
  /**
   * Live getter for the privileged reserved-slot source/actor identifiers
   * (issue #1564, `reservedSlotSources` setting). A launch is privileged when
   * its `launchSource` or attributed `launchActorId` matches an entry. Absent
   * ⇒ empty list (no launch is privileged, so the reservation, if any, holds
   * slots back from everyone — the conservative default).
   */
  getReservedSlotSources?: () => readonly string[];
  /**
   * Rich capacity-ledger snapshot for backpressure error bodies (issue #1526
   * Phase C / C3). Wired in production to the SAME builder `GET /api/health`
   * uses (watchdog-aware `hungSuspect` classification) so a 429 body and the
   * health endpoint tell one story. Absent, a degraded snapshot is built from
   * the task store alone (hungSuspect always 0).
   */
  getCapacityLedger?: () => CapacityLedger;
}

/**
 * Default pending-queue depth limit. Mirrors the `maxPendingTasks` settings
 * default (24); the settings range is 4–200.
 */
export const DEFAULT_MAX_PENDING_TASKS = 24;

/**
 * Default hard ceiling on one `adapter.launch()` await (issue #1528). Mirrors
 * the `launchTimeoutSeconds` settings default (180s); the settings range is
 * 30–900s.
 */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 180_000;

/**
 * Thrown by {@link launchTask} when the server is in operator drain mode and is
 * refusing new task launches. Callers map this to HTTP 503 (issue #659).
 */
export class DrainModeError extends Error {
  readonly code = 'draining';
  constructor() {
    super('Server is draining; not accepting new task launches');
    this.name = 'DrainModeError';
  }
}

/**
 * Thrown by {@link launchTask} when a per-task `effort` override is not valid
 * for the resolved agent type (#681). Validation happens here — not at the
 * route — because a `round-robin` selection only resolves to a concrete agent
 * inside this service, and `minimal`/`none`/`ultra` (codex-only) are
 * agent-specific. The API maps this to HTTP 400.
 */
export class EffortValidationError extends Error {
  readonly code = 'invalid_effort';
  constructor(message: string) {
    super(message);
    this.name = 'EffortValidationError';
  }
}

/** Type guard for {@link EffortValidationError}, for callers mapping to 400. */
export function isEffortValidationError(err: unknown): err is EffortValidationError {
  return err instanceof EffortValidationError;
}

/**
 * Thrown by {@link launchTask} when a per-task `model` pin is not on the
 * resolved agent's known-model allowlist (#1518). Same placement as effort
 * validation (after round-robin resolves). The API maps this to HTTP 400.
 */
export class ModelValidationError extends Error {
  readonly code = 'invalid_model';
  constructor(message: string) {
    super(message);
    this.name = 'ModelValidationError';
  }
}

/** Type guard for {@link ModelValidationError}, for callers mapping to 400. */
export function isModelValidationError(err: unknown): err is ModelValidationError {
  return err instanceof ModelValidationError;
}

/**
 * Thrown by {@link launchTask} when the requested working directory does not
 * exist (or is not a directory) on this machine. Validated up front — before
 * any task record or terminal session is created — because launching into a
 * missing cwd otherwise fails seconds later with a cryptic backend error
 * ("dtach socket did not appear...") that buries the real cause (RFC F12).
 * The REST API maps this to HTTP 400; the WS path surfaces it as an alert
 * whose summary leads with the missing-directory cause.
 */
export class CwdValidationError extends Error {
  readonly code = 'invalid_cwd';
  constructor(message: string) {
    super(message);
    this.name = 'CwdValidationError';
  }
}

/** Type guard for {@link CwdValidationError}, for callers mapping to 400. */
export function isCwdValidationError(err: unknown): err is CwdValidationError {
  return err instanceof CwdValidationError;
}

/**
 * Thrown by {@link launchTask} when `adapter.launch()` does not settle within
 * the configured `launchTimeoutSeconds` (issue #1526 Phase C / #1528). By the
 * time this propagates, the launch has already been cleaned up exactly like a
 * thrown launch: reservation released (`endLaunch`) and the task DISPOSED —
 * marked terminal with a `launch_timeout` {@link Task.disposition} rather than
 * deleted (issue #1588), so the record stays queryable, a terminal task can't
 * block dedup, no capacity slot stays held, and a retry with the same
 * idempotency key replays this task instead of creating a sibling. A
 * schedule-fired launch that hits this records `dispatch_failed`
 * (reasonCode `launch_error`) through the runner's normal error path.
 */
export class LaunchTimeoutError extends Error {
  readonly code = 'launch_timeout';
  constructor(agentType: string, taskId: string, timeoutMs: number) {
    super(
      `Agent launch timed out after ${Math.round(timeoutMs / 1000)}s ` +
      `(agent ${agentType}, task ${taskId}) — launch abandoned and task cleaned up`,
    );
    this.name = 'LaunchTimeoutError';
  }
}

/** Type guard for {@link LaunchTimeoutError}. */
export function isLaunchTimeoutError(err: unknown): err is LaunchTimeoutError {
  return err instanceof LaunchTimeoutError;
}

/**
 * Thrown by {@link launchTask} when a launch would pend at capacity but the
 * pending queue is already at its depth limit (issue #1526 Phase C / C3,
 * FM3). Carries the capacity-ledger snapshot so every surface can render WHY:
 * REST maps this to HTTP 429 with the ledger in the body, the WS path renders
 * the breakdown into its alert, and a schedule fire records `dispatch_failed`
 * with reasonCode `pending_queue_full` — never a silent drop. Thrown BEFORE
 * any task record exists, so there is nothing to clean up.
 */
export class PendingQueueFullError extends Error {
  readonly code = 'pending_queue_full';
  constructor(
    /** Capacity-ledger snapshot at rejection time (same shape as `GET /api/health` `capacity`). */
    readonly capacity: CapacityLedger,
    /** The `maxPendingTasks` limit that was hit. */
    readonly maxPendingTasks: number,
  ) {
    super(
      `Pending queue is full (${capacity.pendingQueueDepth}/${maxPendingTasks} queued, ` +
      `${capacity.active}/${capacity.maxActiveTasks} active) — launch rejected. ` +
      'Retry after capacity frees, or raise maxPendingTasks.',
    );
    this.name = 'PendingQueueFullError';
  }
}

/** Type guard for {@link PendingQueueFullError}, for callers mapping to 429. */
export function isPendingQueueFullError(err: unknown): err is PendingQueueFullError {
  return err instanceof PendingQueueFullError;
}

/**
 * Thrown by {@link launchTask} when the caller's per-source spawn budget is
 * exhausted (issue #1526 Phase C / C3, `spawnBurstLimit` per
 * `spawnBurstWindowMinutes`). Same 429-with-ledger shape as
 * {@link PendingQueueFullError}, distinct code so a runaway caller can tell
 * "you specifically are bursting" apart from "the shared queue is full".
 * Thrown before any task record exists. Schedule fires never hit this — they
 * are exempt from the budget.
 */
export class SpawnBurstLimitError extends Error {
  readonly code = 'spawn_burst_limit';
  /** Budget bucket that was exhausted (launch source, actor-qualified when attributed). */
  readonly source: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly retryAfterMs: number;
  constructor(
    verdict: SpawnRateVerdict,
    /** Capacity-ledger snapshot at rejection time. */
    readonly capacity: CapacityLedger,
  ) {
    super(
      `Spawn burst limit reached for source "${verdict.source}": ` +
      `${verdict.count}/${verdict.limit} launches in the last ${Math.round(verdict.windowMs / 60_000)}m — ` +
      `launch rejected. Retry in ~${Math.ceil(verdict.retryAfterMs / 1000)}s.`,
    );
    this.name = 'SpawnBurstLimitError';
    this.source = verdict.source;
    this.limit = verdict.limit;
    this.windowMs = verdict.windowMs;
    this.retryAfterMs = verdict.retryAfterMs;
  }
}

/** Type guard for {@link SpawnBurstLimitError}, for callers mapping to 429. */
export function isSpawnBurstLimitError(err: unknown): err is SpawnBurstLimitError {
  return err instanceof SpawnBurstLimitError;
}

/**
 * Capacity-ledger snapshot for backpressure error bodies. Prefers the wired
 * health-grade builder; falls back to a task-store-only snapshot (no watchdog
 * ⇒ `hungSuspect` reads 0) so the error body always carries a breakdown.
 */
function snapshotCapacityLedger(deps: LaunchServiceDeps, maxActive: number): CapacityLedger {
  if (deps.getCapacityLedger) return deps.getCapacityLedger();
  const reservedActiveSlots = deps.getReservedActiveSlots?.();
  return buildCapacityLedger(deps.taskStore.listTasks(), {
    now: Date.now(),
    maxActiveTasks: maxActive,
    isHungSuspect: () => false,
    isLaunching: (task) => deps.taskStore.hasFreshLaunchReservation(task.id),
    // Issue #1564: reflect the reservation in the degraded snapshot too, so a
    // backpressure error body carries the same guarantee /api/health shows.
    ...(reservedActiveSlots !== undefined
      ? { reservedActiveSlots, reservedSlotSources: deps.getReservedSlotSources?.() ?? [] }
      : {}),
  });
}

/**
 * Effective active-task cap for THIS launch (issue #1564). Privileged
 * (reserved-slot) launches see the full `maxActive`; every other launch is
 * capped at `maxActive - reservedActiveSlots` so it cannot consume a slot the
 * reservation is holding for kookr self-maintenance. Absent reservation
 * (`getReservedActiveSlots` unset or 0) ⇒ `maxActive` for everyone, unchanged.
 */
function effectiveMaxActiveForLaunch(
  deps: LaunchServiceDeps,
  maxActive: number,
  launchSource: string,
  launchActorId: string | undefined,
): number {
  const reserved = deps.getReservedActiveSlots?.() ?? 0;
  if (reserved <= 0) return maxActive;
  const reservedSources = deps.getReservedSlotSources?.() ?? [];
  if (isReservedSlotLaunch(launchSource, launchActorId, reservedSources)) return maxActive;
  return Math.max(0, maxActive - reserved);
}

/**
 * Race one adapter launch against the hard timeout (issue #1528).
 *
 * On timeout, the caller cleans up (endLaunch, then DISPOSES the task terminal
 * with a `launch_timeout` disposition rather than deleting it — issue #1588)
 * and moves on; the underlying promise is NOT cancelled — adapters expose no
 * abort hook for an in-flight launch — so this helper pins down what a LATE
 * settlement can do:
 *
 * - Late REJECTION is swallowed (logged). The common case: the task is now
 *   terminal, so the adapter's own `taskStore.addSession` throws ("Cannot
 *   attach session to terminal task") and the launch rejects on its own — the
 *   same self-clean the old `deleteTask` produced via "Task not found", now via
 *   the terminal guard (issue #1588) so the disposed record stays session-free.
 *   NOTE the honest caveat: if the adapter created a terminal session before
 *   that throw, the session process leaks until reconcile reports it — boot and
 *   periodic `reconcile()` list sessions with no owning task as `orphans`
 *   (logged, not killed). In the #1528 incident the hang was *before* session
 *   creation (buildAgentLaunchContext), so the typical timeout leaks nothing.
 * - Late RESOLUTION (a session id came back after we gave up) is neutralized
 *   with the one cleanup hook adapters do expose: `adapter.stop(sessionId)`
 *   kills the orphaned terminal session, best-effort. State cannot be
 *   corrupted either way — the success path (posture stamping, round-robin
 *   advance, registerNewAgent) only runs when the race resolves in time, and a
 *   late `addSession` onto the terminated disposed task is refused outright, so
 *   the record never gains a phantom session.
 */
async function raceLaunchAgainstTimeout(
  launchPromise: Promise<string>,
  timeoutMs: number,
  ctx: { taskId: string; agentType: AgentType; adapter: Pick<import('../adapters/agent-adapter.js').AgentAdapter, 'stop'> },
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      launchPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new LaunchTimeoutError(ctx.agentType, ctx.taskId, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (timedOut) {
      // Settle-once: whatever the abandoned launch does later is observed,
      // logged, and defused — never allowed back into launch state.
      launchPromise.then(
        (sessionId) => {
          console.warn(
            `[launch] adapter ${ctx.agentType} settled LATE after timeout for task ${ctx.taskId} ` +
            `(session ${sessionId}) — stopping orphaned session`,
          );
          void Promise.resolve(ctx.adapter.stop(sessionId)).catch((stopErr) => {
            console.warn(
              `[launch] failed to stop late-settled session ${sessionId}: ` +
              `${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
            );
          });
        },
        (err) => {
          console.warn(
            `[launch] abandoned launch for task ${ctx.taskId} rejected after timeout (ignored): ` +
            `${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    }
  }
}

/** Resolve the effective launch timeout from the live getter, defensively. */
function resolveLaunchTimeoutMs(deps: LaunchServiceDeps): number {
  const value = deps.getLaunchTimeoutMs?.();
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return DEFAULT_LAUNCH_TIMEOUT_MS;
}

/** Fail fast when the launch cwd is missing or not a directory (RFC F12). */
async function assertLaunchCwdExists(cwd: string): Promise<void> {
  let stats;
  try {
    stats = await stat(cwd);
  } catch {
    throw new CwdValidationError(`Working directory does not exist: ${cwd}`);
  }
  if (!stats.isDirectory()) {
    throw new CwdValidationError(`Working directory is not a directory: ${cwd}`);
  }
}

/** Active statuses — tasks in these states block duplicate submissions. */
const ACTIVE_STATUSES = new Set(['open', 'pending', 'inProgress']);

function allowRemoteChatCodex(): boolean {
  return process.env.KOOKR_REMOTE_CHAT_ALLOW_CODEX === '1';
}

/**
 * Check if an active task with the same prompt hash and canonical cwd already
 * exists. Returns the existing task if found, undefined otherwise.
 *
 * Dedup key is (promptHash, agentType, canonicalCwd). Two launches with the
 * same prompt in different directories are different tasks; two launches with
 * the same prompt in the same directory — even reached via symlink, trailing
 * slash, relative path, or case-aliased path on case-insensitive FS — dedup
 * to the first.
 */
export function checkSubmission(
  taskStore: TaskStore,
  prompt: string,
  agentType: AgentType,
  cwd: string,
): Task | undefined {
  const hash = hashPrompt(prompt);
  const canonicalIncoming = canonicalizeCwd(cwd);
  for (const task of taskStore.listTasks()) {
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    if (task.agentType !== agentType) continue;
    if (hashPrompt(task.prompt) !== hash) continue;
    if (canonicalizeCwd(task.cwd) !== canonicalIncoming) continue;
    // Verify live status — don't rely on cached state
    const liveTask = taskStore.getTask(task.id);
    if (liveTask && liveTask.agentType === agentType && ACTIVE_STATUSES.has(liveTask.status)) {
      return liveTask;
    }
  }
  return undefined;
}

function isSessionTerminal(session: Task['sessions'][number]): boolean {
  return session.lastStatus === 'completed' || session.lastStatus === 'aborted';
}

function isRalphLoopActive(task: Task): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}

async function hasLiveBackingSession(
  task: Task,
  terminalBackend: Pick<TerminalBackend, 'isAlive'>,
): Promise<boolean> {
  const sessions = task.sessions.filter((session) => !isSessionTerminal(session));
  if (sessions.length === 0) return false;

  for (const session of sessions) {
    try {
      if (await terminalBackend.isAlive(session.tmuxSession)) return true;
    } catch {
      // Treat backend probe failures like a missing session for dedup. The
      // stale record will be reconciled below instead of blocking a retry.
    }
  }
  return false;
}

function reconcileStaleDuplicate(taskStore: TaskStore, task: Task): void {
  const current = taskStore.getTask(task.id);
  if (!current || current.status !== 'inProgress') return;

  for (const session of current.sessions) {
    if (!isSessionTerminal(session)) {
      taskStore.updateSession(current.id, session.tmuxSession, { lastStatus: 'completed' });
    }
  }

  const updated = taskStore.getTask(current.id);
  if (
    updated?.status === 'inProgress'
    && (updated.sessions.length === 0 || updated.sessions.every(isSessionTerminal))
  ) {
    taskStore.terminateTask(updated.id, {
      reason: 'unknown',
      detail: 'stale duplicate reconciled at launch (dead sessions)',
    });
  }
}

async function validateDuplicateCandidate(
  deps: LaunchServiceDeps,
  candidate: Task,
): Promise<Task | undefined> {
  if (candidate.status !== 'inProgress') return candidate;
  if (isRalphLoopActive(candidate)) return candidate;
  if (!deps.terminalBackend) return candidate;
  if (await hasLiveBackingSession(candidate, deps.terminalBackend)) return candidate;

  reconcileStaleDuplicate(deps.taskStore, candidate);
  return undefined;
}

/**
 * Unified launch orchestration: create task, check concurrency, launch via
 * adapter, and run post-launch registration. Used by both the WS message
 * router and the REST API.
 *
 * Idempotency (issue #1526 Phase B) is a thin wrapper around the core launch
 * logic ({@link launchTaskCore}) rather than woven through it: when
 * `opts.idempotencyKey` and `deps.idempotencyLedger` are both present, this
 * function reserves the key, delegates to `launchTaskCore` for the entire
 * existing launch pipeline (validation, dedup, concurrency, adapter launch),
 * and finalizes or releases the reservation based on the outcome. Every
 * existing caller that never sets `idempotencyKey` is byte-for-byte
 * unaffected — the wrapper is skipped entirely.
 */
export async function launchTask(
  deps: LaunchServiceDeps,
  opts: LaunchOpts,
  serverOpts: LaunchTaskServerOptions = {},
): Promise<LaunchResult> {
  if (opts.idempotencyKey === undefined || !deps.idempotencyLedger) {
    return launchTaskCore(deps, opts, serverOpts);
  }
  return launchTaskIdempotent(deps, opts, serverOpts, deps.idempotencyLedger, opts.idempotencyKey);
}

/**
 * Whether a store-resident task should be handed back as a replay, or
 * treated as though its reservation never happened (issue #1526 Phase B
 * review item 2).
 *
 * A non-terminal task (open/pending/inProgress) is always replayable — it's
 * the same live task the caller is retrying for.
 *
 * A TERMINAL task is replayable when either:
 *  - it actually ran (`sessions.length > 0`): an agent was launched (it may
 *    have completed, or died and been terminated — either way real work
 *    happened, so replaying it is the point of this feature; re-launching
 *    would duplicate that work); or
 *  - it carries a pre-session `disposition` (issue #1588): a launch-timeout /
 *    launch-error / stale-open-launch path disposed of it before any session.
 *    Returning it as a replay is exactly the create-then-lose fix — the caller
 *    gets the original disposed task (with its reason visible) instead of the
 *    key being cleared and a duplicate task being created.
 *
 * A terminal, zero-session task with NO disposition never ran at all — e.g. it
 * was queued at the concurrency cap (`launchTaskCore`'s maxActive branch never
 * calls `adapter.launch`) and then reaped, cancelled, or TTL-expired before
 * promotion ever launched it. Replaying that dead reference would hand the
 * caller a task that will never do the work it's retrying for, so this case is
 * deliberately NOT a replay: the stale entry is cleared and the caller competes
 * for ownership again, actually launching the work.
 */
function isReplayableTask(task: Task): boolean {
  return !isTerminalStatus(task.status) || task.sessions.length > 0 || task.disposition !== undefined;
}

/**
 * Marker linking a thrown launch error back to the persisted, disposed task
 * `launchTaskCore` left behind (issue #1588). `launchTaskIdempotent` reads it
 * to finalize the idempotency key to that task — so a retry returns the
 * disposed task — instead of releasing the key and letting the retry create a
 * sibling. A Symbol key never shows up in JSON serialization of the error.
 */
const DISPOSED_TASK_ID = Symbol('kookr.disposedTaskId');

function markDisposedTask(err: unknown, taskId: string): void {
  if (err && typeof err === 'object') {
    (err as Record<symbol, unknown>)[DISPOSED_TASK_ID] = taskId;
  }
}

function disposedTaskId(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const value = (err as Record<symbol, unknown>)[DISPOSED_TASK_ID];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Marker carrying the per-phase launch timings (issue #1589) back to the
 * schedule runner on a thrown launch. A schedule fire that fails records
 * `dispatch_failed` WITHOUT ever calling `markExecutionAccepted`, so its ledger
 * row has no taskId to link the disposed task by — the runner reads this off
 * the error instead and stamps the timings onto the `dispatch_failed` row, so a
 * failed fire is diagnosable straight from the ledger. A Symbol key never shows
 * up in JSON serialization of the error.
 */
const LAUNCH_PHASE_TIMINGS = Symbol('kookr.launchPhaseTimings');

function attachLaunchPhaseTimings(err: unknown, timings: LaunchPhaseTimings): void {
  if (err && typeof err === 'object') {
    (err as Record<symbol, unknown>)[LAUNCH_PHASE_TIMINGS] = timings;
  }
}

/** Read the per-phase launch timings attached to a thrown launch error (issue #1589). */
export function launchPhaseTimingsOf(err: unknown): LaunchPhaseTimings | undefined {
  if (err && typeof err === 'object') {
    const value = (err as Record<symbol, unknown>)[LAUNCH_PHASE_TIMINGS];
    if (value && typeof value === 'object') return value as LaunchPhaseTimings;
  }
  return undefined;
}

/**
 * Reserve/replay wrapper (see {@link launchTask} docs). Loops rather than
 * recursing when a reservation resolves to "try again" (the owner's launch
 * failed, a replay pointed at a since-deleted task, or a replay pointed at a
 * terminal task that never actually ran — see {@link isReplayableTask}) —
 * every case means this call should now compete for ownership itself.
 */
async function launchTaskIdempotent(
  deps: LaunchServiceDeps,
  opts: LaunchOpts,
  serverOpts: LaunchTaskServerOptions,
  ledger: IdempotencyLedger,
  idempotencyKey: string,
): Promise<LaunchResult> {
  for (;;) {
    const reservation = ledger.reserveOrWait(idempotencyKey);

    if (reservation.kind === 'replay') {
      const task = deps.taskStore.getTask(reservation.taskId);
      if (task && isReplayableTask(task)) {
        return { task, queued: task.status === 'pending', idempotentReplay: true };
      }
      // Either the finalized task no longer exists (e.g. deleted), or it's
      // terminal-and-never-ran (issue #1526 Phase B review item 2) — the key
      // must not stay permanently bound to a dead/non-working reference.
      await ledger.clear(idempotencyKey);
      continue;
    }

    if (reservation.kind === 'wait') {
      const outcome = await reservation.wait();
      if (outcome.ok) {
        const task = deps.taskStore.getTask(outcome.taskId);
        if (task && isReplayableTask(task)) {
          return { task, queued: task.status === 'pending', idempotentReplay: true };
        }
        // Task missing, or terminal-and-never-ran. The owner already
        // finalized this key, so the next `reserveOrWait` call below returns
        // 'replay' (not 'own') and the branch above clears it — no need to
        // duplicate the clear() call here.
      }
      continue;
    }

    // reservation.kind === 'own'
    let result: LaunchResult;
    try {
      result = await launchTaskCore(deps, opts, serverOpts);
    } catch (err) {
      const disposedId = disposedTaskId(err);
      if (disposedId && deps.taskStore.getTask(disposedId)) {
        // launchTaskCore left a persisted, disposed task behind (issue #1588:
        // launch timeout / launch error). Finalize the key to it so a retry
        // returns THIS disposed task (idempotentReplay) with its reason
        // visible, never a silently-created sibling. finalize() never rejects.
        await reservation.finalize(disposedId);
      } else {
        // No lasting record (a validation/backpressure rejection before
        // createTask) — release so a retry is treated as fresh.
        await reservation.release();
      }
      throw err;
    }
    // A real task now exists — possibly with a live spawned agent. From here
    // on we must NEVER throw or release() (issue #1526 Phase B review item
    // 1): `finalize` is best-effort by design (see IdempotencyLedger docs)
    // and its returned promise never rejects, so a ledger persist failure
    // can only cost cross-restart durability, never turn this success into
    // an error for the caller or drop same-process replay protection.
    await reservation.finalize(result.task.id);
    return result;
  }
}

async function launchTaskCore(
  deps: LaunchServiceDeps,
  opts: LaunchOpts,
  serverOpts: LaunchTaskServerOptions = {},
): Promise<LaunchResult> {
  const { taskStore, adapterRegistry, lifecycleDeps } = deps;
  // Per-phase launch instrumentation (issue #1589). Timing starts at the top of
  // the launch pipeline so the `preflight` phase captures the pre-reservation
  // work (cwd check, advisory dependency preflight, worktree guardrails, dedup,
  // backpressure, createTask) — the reported symptom is `POST /api/tasks` held
  // >90s, which includes exactly that window. The tracker is only persisted once
  // a launch actually reaches the adapter; a dedup hit or a queued-at-capacity
  // return is not a launch attempt and records nothing.
  const phaseTracker = new LaunchPhaseTracker();
  phaseTracker.enter('preflight');
  // Operator drain gate (issue #659): refuse new launches while draining, before
  // any task record or side effect is created. In-flight agents are untouched.
  if (deps.isAccepting && !deps.isAccepting()) {
    throw new DrainModeError();
  }
  // Fail fast on a missing working directory (RFC F12) — before dedup, task
  // creation, or any spawn attempt, so the caller gets the actual cause
  // instead of a delayed "dtach socket did not appear" session failure and no
  // cleanup is needed.
  await (deps.validateLaunchCwd ?? assertLaunchCwdExists)(opts.cwd);
  const maxActive = deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
  // Resolve the agent for this launch. An explicit per-launch request wins
  // over the configured default; either may be the `round-robin` sentinel,
  // which is resolved to a concrete agent *here* — before dedup and task
  // creation — so the task record always stores a concrete agent type.
  const requestedAgent: AgentSelection =
    opts.agentType ??
    deps.getDefaultAgentType?.() ??
    adapterRegistry.getDefaultType() ??
    DEFAULT_AGENT_TYPE;
  const isRoundRobin = requestedAgent === ROUND_ROBIN_AGENT_TYPE;
  // `peek` (not advance): the rotation cursor must only move once a task is
  // actually committed, so a deduplicated or rejected launch does not consume
  // a rotation slot. The matching `advance()` calls fire after `createTask`.
  const agentType: AgentType = isRoundRobin
    ? resolveRoundRobinAgent(
        deps.roundRobinCursor?.peek() ?? 0,
        adapterRegistry.getTypes(),
      )
    : requestedAgent;

  // Validate a per-task effort override against the *resolved* agent's allowed
  // set (#681), before any side effect or task record. Done here — not at the
  // route — because round-robin only resolves to a concrete agent now, and the
  // allowed set is agent-specific (`minimal`/`none`/`ultra` are codex-only). The
  // per-agent-type *default* is applied inside the adapter and
  // validated when settings are saved, so it is not re-checked here.
  if (opts.effort !== undefined && !isValidEffortForAgent(agentType, opts.effort)) {
    throw new EffortValidationError(
      `Invalid effort "${opts.effort}" for agent ${agentType}; ` +
      `valid levels: ${effortLevelsForAgent(agentType).join(', ')}`,
    );
  }

  // Validate a per-task model pin against the *resolved* agent's allowlist
  // (#1518). Same placement as effort — after round-robin, before side effects.
  // No silent fallback: unknown models throw rather than launch with the CLI
  // default. codex-cli / grok-build currently have empty allowlists.
  if (opts.model !== undefined && !isValidModelForAgent(agentType, opts.model)) {
    const valid = modelsForAgent(agentType);
    throw new ModelValidationError(
      valid.length === 0
        ? `Invalid model "${opts.model}" for agent ${agentType}; this agent does not accept a per-task model pin`
        : `Invalid model "${opts.model}" for agent ${agentType}; ` +
          `valid models: ${valid.join(', ')} (dated suffixes of those bases also accepted)`,
    );
  }

  // R19 trust-boundary check (rfc-remote-chat-trigger §4): Telegram-spawned
  // Codex is opt-in because its permission model is more permissive than
  // Claude Code's supervised path. The integration checks this before
  // confirmation; this server-side check is the defense-in-depth boundary.
  if (
    opts.launchSource === 'remote-chat-telegram' &&
    agentType !== 'claude-code' &&
    !(agentType === 'codex-cli' && allowRemoteChatCodex())
  ) {
    throw new Error(
      `R19: remote-chat-telegram tasks cannot use ${agentType} unless KOOKR_REMOTE_CHAT_ALLOW_CODEX=1`,
    );
  }

  const dependencyFindings = sanitizeLaunchPreflightFindings(await collectAdvisoryDependencyFindings(
    deps.dependencyPreflightRunner ?? runLaunchDependencyPreflights,
    opts.dependencies,
  ));
  const launchHealthSummary = summarizeLaunchHealth(dependencyFindings);
  const launchNote = formatLaunchNote(dependencyFindings);

  const userPrompt = normalizePromptFileReferences(opts.prompt, opts.cwd);
  const deliveryAuthorization: DeliveryAuthorization = serverOpts.deliveryPolicy ?? 'ask-first';
  const guardedPrompt = await applyWorktreeGuardrails(opts.prompt, opts.cwd, deliveryAuthorization);
  const effectivePrompt = normalizePromptFileReferences(guardedPrompt, opts.cwd);
  const bypassAllPermissions = deps.bypassAllPermissions === true;

  // Dedup: if an active task with the same prompt and canonical cwd exists,
  // return it idempotently
  if (!opts.disableDedup) {
    let staleDuplicate: Task | undefined;
    let existing: Task | undefined;
    while ((existing = checkSubmission(taskStore, effectivePrompt, agentType, opts.cwd))) {
      const activeDuplicate = await validateDuplicateCandidate(deps, existing);
      if (activeDuplicate) {
        const canonicalCwd = canonicalizeCwd(opts.cwd);
        console.log(`[dedup] Rejected duplicate prompt (existing task ${activeDuplicate.id}, status=${activeDuplicate.status}, cwd=${canonicalCwd})`);
        await deps.interactionLog?.append({
          type: 'submission_rejected_dedup',
          existingTaskId: activeDuplicate.id,
          promptHash: hashPrompt(effectivePrompt),
          canonicalCwd,
          timestamp: nowISO(),
        });
        return { task: activeDuplicate, queued: false, duplicate: true };
      }
      staleDuplicate = existing;
    }
    if (staleDuplicate) {
      console.log(`[dedup] Ignored stale duplicate prompt (existing task ${staleDuplicate.id}, status=${staleDuplicate.status}, cwd=${canonicalizeCwd(opts.cwd)})`);
    }
  }

  // --- Server-side backpressure (issue #1526 Phase C / C3) ---
  // Both guards run AFTER dedup (an idempotent replay of an existing task
  // must never be rejected — it creates nothing) and BEFORE createTask (a
  // rejected launch must leave no task record). No await sits between these
  // checks and createTask, so the counts they read cannot go stale.
  //
  // 1) Per-source spawn budget. Checked first: it identifies the misbehaving
  //    CALLER, which is more actionable than the shared-queue state — a
  //    runaway burst should see "you are bursting" even once it has also
  //    filled the queue. Schedule fires are exempt (see SpawnRateLimiter
  //    module docs): their cadence is operator-configured and already bounded
  //    by per-schedule coalescing + dead-man alerting.
  const launchSourceForBudget = opts.launchSource ?? 'api';
  // Reserved self-maintenance capacity (issue #1564): a non-privileged launch
  // (e.g. a lucy burst) is capped below the full pool so the last
  // `reservedActiveSlots` slots stay available for kookr self-maintenance.
  // Privileged launches (source/actor in `reservedSlotSources`) see the full
  // cap. Absent reservation ⇒ `effectiveMaxActive === maxActive`, unchanged.
  const effectiveMaxActive = effectiveMaxActiveForLaunch(
    deps,
    maxActive,
    launchSourceForBudget,
    opts.launchActorId,
  );
  if (deps.spawnRateLimiter && launchSourceForBudget !== 'schedule') {
    const verdict = deps.spawnRateLimiter.tryAcquire(
      spawnBudgetKey(launchSourceForBudget, opts.launchActorId),
    );
    if (!verdict.allowed) {
      console.warn(
        `[backpressure] spawn burst limit hit for source "${verdict.source}" ` +
        `(${verdict.count}/${verdict.limit} in ${Math.round(verdict.windowMs / 60_000)}m)`,
      );
      throw new SpawnBurstLimitError(verdict, snapshotCapacityLedger(deps, maxActive));
    }
  }

  // 2) Pending-queue depth limit (FM3). Only bites when the launch would
  //    actually pend (node at capacity): below capacity the task launches
  //    immediately and queue depth is irrelevant, so behavior is unchanged.
  if (taskStore.getActiveCount() >= effectiveMaxActive) {
    const maxPending = deps.getMaxPendingTasks?.() ?? DEFAULT_MAX_PENDING_TASKS;
    if (taskStore.getPendingCount() >= maxPending) {
      console.warn(
        `[backpressure] pending queue full (${taskStore.getPendingCount()}/${maxPending}) at capacity — rejecting launch`,
      );
      throw new PendingQueueFullError(snapshotCapacityLedger(deps, maxActive), maxPending);
    }
  }

  const task = taskStore.createTask({
    prompt: effectivePrompt,
    userPrompt,
    cwd: opts.cwd,
    criteria: opts.criteria,
    parentTaskId: opts.parentTaskId,
    // Launch provenance signals (issue #1583). createTask derives the immutable
    // Task.provenance from these plus parentTaskId; the metadata.launchSource
    // stamp below stays for the backpressure/promotion-guard consumers.
    launchSource: opts.launchSource,
    scheduleId: opts.scheduleId,
    agentType,
    name: opts.name,
    playbookId: opts.playbookId,
    projectId: opts.projectId,
    playbookParameterValues: opts.playbookParameterValues,
    // metadata.launchSource (issue #1526 Phase C / C3): stamp provenance on
    // the record so the promotion posture guard can recognize schedule-fired
    // pendings as self-releasing. Additive — absent when no source was given.
    metadata: (opts.metadataIntent || opts.launchSource)
      ? {
          ...(opts.metadataIntent ? { intent: opts.metadataIntent } : {}),
          ...(opts.launchSource ? { launchSource: opts.launchSource } : {}),
        }
      : undefined,
    launchHealthSummary,
    launchNote,
    deliveryAuthorization,
    autoCloseOnSignal: opts.autoCloseOnSignal,
    unattended: opts.unattended,
  });

  if (taskStore.getActiveCount() >= effectiveMaxActive) {
    const queuedTask = taskStore.pendTask(task.id);
    // The task record is committed (queued for promotion), so the round-robin
    // launch consumed its slot — advance the rotation.
    if (isRoundRobin) deps.roundRobinCursor?.advance();
    return { task: queuedTask, queued: true };
  }

  // PR4: ralph-loop launches need verdict env injected so iteration 0 can
  // write a verdict. Subsequent iterations get this via `launchFreshRuntime`;
  // this fills the gap on the first launch.
  // #681 / #1518: thread per-task effort and model pins through to the adapter.
  // Per-agent-type effort defaults are resolved inside the adapter; model has
  // no Kookr-global default for claude-code. When none of these are set,
  // adapterOpts stays `undefined`; the adapter still selects its CLI defaults.
  // Always carries the per-phase instrumentation callback (issue #1589) so the
  // adapter can mark the `session-create`/`agent-boot`/`ack` boundaries that
  // live inside `adapter.launch()`; the other fields stay conditional so a
  // launch with none of them is byte-identical to pre-#1589 apart from onPhase.
  const adapterOpts: import('../adapters/agent-adapter.js').AdapterLaunchOptions = {
    onPhase: (phase) => phaseTracker.enter(phase),
    ...(opts.ralphVerdictEnv
      ? {
          extraEnv: {
            RALPH_VERDICT_FILE: defaultVerdictPath(opts.cwd, task.id),
            RALPH_ITERATION: '0',
          },
        }
      : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.sandboxProfile ? { sandboxProfile: opts.sandboxProfile } : {}),
  };

  // #700 defense-in-depth: reserve the just-created task for this launch so a
  // concurrent promoter can never race it, and so getActiveCount counts the
  // in-flight launch against the cap (audit item 1, second launch site).
  phaseTracker.enter('reserve');
  taskStore.beginLaunch(task.id);
  // The disposition guard wraps ONLY the launch race — the point before which
  // no session has attached. Post-attach bookkeeping (posture stamping, audit
  // append) runs AFTER this block, so a bookkeeping fault can never dispose a
  // task that already reached a live session (issue #1588 review).
  try {
    // Hard timeout around the adapter launch (issue #1526 Phase C / #1528):
    // a launch that hangs (CPU saturation wedging the spawn path) fails fast
    // through the SAME catch/cleanup as any thrown launch instead of holding
    // its beginLaunch reservation — and its schedule's 'reserved' execution —
    // for hours. Late settlement of the abandoned promise is defused inside
    // the race helper.
    const adapter = adapterRegistry.get(agentType);
    await raceLaunchAgainstTimeout(
      adapter.launch(task.id, promptWithLaunchNote(task), opts.cwd, undefined, adapterOpts),
      resolveLaunchTimeoutMs(deps),
      { taskId: task.id, agentType, adapter },
    );
  } catch (err) {
    // Never silently delete a persisted task (issue #1588). A launch that
    // timed out or threw before any session attached still left a real record;
    // deleting it (the old behaviour) erased the evidence AND let a retried
    // POST with the same idempotency key create a duplicate. Instead, record a
    // queryable disposition and mark the task terminal so:
    //   - `GET /api/tasks/:id` shows WHY it died (reason + timestamp), and
    //   - a retry finalizes on this task (see launchTaskIdempotent) and gets it
    //     back as an idempotent replay rather than a sibling.
    // The round-robin cursor was not advanced yet, so the rotation is untouched.
    // A terminal task never matches the active-only dedup, so future retries
    // are not blocked (the original goal of the delete) — they simply replay.
    // A late-settling abandoned launch cannot corrupt this terminal record:
    // TaskStore.addSession refuses to attach a session to a terminal task.
    taskStore.endLaunch(task.id);
    // Instrumentation (issue #1589): the launch was abandoned mid-phase. abort()
    // flags the in-flight phase as `incompletePhase` — the phase that consumed
    // the time. Persist it on the disposed task (so `GET /api/tasks/:id` shows
    // WHERE it hung) and attach it to the error so a schedule fire's
    // `dispatch_failed` ledger row can carry the same breakdown without a taskId
    // link. Both are best-effort and must never mask the original launch error.
    phaseTracker.abort();
    const phaseTimings = phaseTracker.snapshot();
    taskStore.setLaunchPhaseTimings(task.id, phaseTimings);
    attachLaunchPhaseTimings(err, phaseTimings);
    const reason: TaskDispositionReason = isLaunchTimeoutError(err) ? 'launch_timeout' : 'launch_error';
    taskStore.setDisposition(task.id, {
      reason,
      at: nowISO(),
      source: 'launch-service',
      detail: err instanceof Error ? err.message : String(err),
    });
    try {
      taskStore.terminateTask(task.id);
    } catch (terminateErr) {
      // Best-effort: the disposition (the queryable evidence) is already
      // written, so a failed terminal transition must not mask the original
      // launch error the caller needs to see.
      console.error(`[launch] failed to terminate disposed task ${task.id}:`, terminateErr);
    }
    markDisposedTask(err, task.id);
    throw err;
  }
  // --- Launch succeeded: a session is attached and the agent is live. ---
  // Instrumentation (issue #1589): finalize and persist the full
  // `preflight → reserve → session-create → agent-boot → ack` breakdown on the
  // task so a slow-but-successful launch is as diagnosable as a failed one.
  phaseTracker.complete();
  taskStore.setLaunchPhaseTimings(task.id, phaseTracker.snapshot());
  if (bypassAllPermissions) {
    const launchPermissionPosture = {
      bypassAllPermissions: true as const,
      mode: 'bypass-all' as const,
      capturedAt: nowISO(),
    };
    taskStore.setLaunchPermissionPosture(task.id, launchPermissionPosture);
    // Best-effort audit append: an interaction-log I/O fault must NOT fail —
    // or dispose — a launch that already spawned an agent (issue #1588 review).
    try {
      await deps.interactionLog?.append({
        type: 'task_launch_permission_posture',
        taskId: task.id,
        agentType,
        bypassAllPermissions: true,
        mode: 'bypass-all',
        timestamp: launchPermissionPosture.capturedAt,
      });
    } catch (logErr) {
      console.error(`[launch] failed to append launch-permission-posture audit for task ${task.id}:`, logErr);
    }
  } else {
    taskStore.setLaunchPermissionPosture(task.id, undefined);
  }
  // The launch succeeded — advance the rotation now that the task is live.
  if (isRoundRobin) deps.roundRobinCursor?.advance();
  const source = opts.launchSource ?? 'api';
  console.log(`[launch] source=${source} agent=${agentType} taskId=${task.id} cwd=${opts.cwd}`);
  const launchedTask = taskStore.getTask(task.id) ?? task;
  await registerNewAgent(launchedTask, lifecycleDeps);
  return { task: launchedTask, queued: false };
}

export function promptWithLaunchNote(task: Pick<Task, 'prompt' | 'launchNote'>): string {
  return task.launchNote ? `${task.launchNote}\n\n${task.prompt}` : task.prompt;
}

function summarizeLaunchHealth(findings: LaunchPreflightFinding[]): TaskLaunchHealthSummary | undefined {
  if (findings.length === 0) return undefined;
  return {
    degradedDependencies: [...new Set(findings.map((finding) => finding.dependency))],
    findings,
  };
}

function sanitizeLaunchPreflightFindings(findings: LaunchPreflightFinding[]): LaunchPreflightFinding[] {
  return findings.map((finding) => ({
    ...finding,
    ...(finding.detail ? { detail: redactDiagnosticText(finding.detail, 500) } : {}),
  }));
}

function formatLaunchNote(findings: LaunchPreflightFinding[]): string | undefined {
  if (findings.length === 0) return undefined;
  const lines = findings.map((finding) => {
    const detail = finding.detail ? ` Detail: ${finding.detail}` : '';
    return `- ${finding.summary} (${finding.category}).${detail} Recommended action: ${finding.recommendedAction}`;
  });
  return [
    '[Kookr launch warning] One or more advisory launch dependencies are degraded. Continue the task without assuming those services are available.',
    ...lines,
  ].join('\n');
}

async function collectAdvisoryDependencyFindings(
  runner: DependencyPreflightRunner,
  dependencies: LaunchDependency[] | undefined,
): Promise<LaunchPreflightFinding[]> {
  try {
    return await runner(dependencies);
  } catch (err) {
    console.warn('[launch] advisory dependency preflight failed internally:', err);
    if (!dependencies?.includes('kb')) return [];
    return [{
      dependency: 'kb',
      status: 'failed',
      category: 'unknown',
      summary: 'KB dependency preflight could not complete',
      detail: redactDiagnosticText(err instanceof Error ? err.message : String(err), 500),
      recommendedAction: 'Run `kb doctor --format=json` manually and address the reported KB failure.',
    }];
  }
}

/**
 * Launch a fresh runtime session for an already-existing task (used by the
 * Ralph loop service to re-inject the loop prompt after each iteration).
 * Returns the new tmux session name.
 *
 * Deliberately NOT subject to the drain gate (issue #659): this continues
 * *in-flight* work on an existing task rather than creating a new one, and
 * drain's contract is that already-running agents and in-flight work run to
 * completion. The cordon is enforced on {@link launchTask} (new-task creation)
 * and on the scheduler, not here.
 */
export async function launchFreshTaskSession(
  deps: LaunchServiceDeps,
  task: Task,
  prompt: string,
  opts?: import('../adapters/agent-adapter.js').AdapterLaunchOptions,
): Promise<string> {
  const sessionId = await deps.adapterRegistry.get(task.agentType).launch(
    task.id,
    prompt,
    task.cwd,
    undefined,
    opts,
  );
  const launchedTask = deps.taskStore.getTask(task.id) ?? task;
  await registerNewAgent(launchedTask, deps.lifecycleDeps);
  return sessionId;
}
