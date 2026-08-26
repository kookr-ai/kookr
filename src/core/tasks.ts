import { randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_TYPE, type AgentType } from './agent-types.js';
import { capCompletionDigestForStorage, type CompletionDigest } from './completion-digest.js';
import { evaluateCompletionSignal, type CompletionSignalDecision } from './completion-signal.js';
import { deterministicTaskName } from './task-naming.js';
import { deriveTaskProvenance } from './task-provenance.js';
import { displayPromptForTask } from './prompt-display.js';
import type { AgentEvent } from './types.js';
import type { IssueClaim } from './issue-claim-types.js';
import type { CriteriaCompletionVerdict } from '../shared/contracts/completion-digest.js';
import type { PendingAgentSignal } from '../shared/contracts/agent-signal.js';
import type { OperatorNeeded } from '../shared/contracts/operator-needed.js';
import type {
  TaskDependencyEdge,
  TaskDisposition,
  TaskLaunchIntent,
  TaskLaunchPermissionPosture,
  TaskPriorityUpdate,
  TaskRelaunchDisposition,
} from '../shared/contracts/task.js';
import { TASK_LAUNCH_INTENT_SCHEMA } from './task-launch-intent.js';
import type { ChildSessionInfo, GitInfo, SessionInfo, WorktreeHealth } from './session-read-model.js';
import { SessionRegistry } from './session-registry.js';
import type { LaunchPhaseTimings } from './launch-phase-timings.js';
import type { TokenUsage } from './usage-types.js';
import type {
  CreateTaskOptions,
  ReflectMeta,
  Task,
  TaskCompletionFeedback,
} from './task-read-model.js';
import { isTerminalStatus, type TaskStatus, type TerminationCause, type TurnState } from './task-status.js';
import {
  DETERMINISTIC_RELATION_CONFIDENCE,
  taskRelationKey,
  type TaskRelation,
  type TaskRelationInput,
  type TaskRelationType,
} from '../shared/contracts/task-relations.js';

export type {
  TaskRelation,
  TaskRelationEvidence,
  TaskRelationInput,
  TaskRelationLifecycle,
  TaskRelationSource,
  TaskRelationType,
} from '../shared/contracts/task-relations.js';

export type {
  BurnedOutTarget,
  CreateTaskOptions,
  RalphLoopState,
  RalphLoopStatus,
  RalphStallConfig,
  RalphZeroDiffConvergenceConfig,
  ReflectMeta,
  Task,
  TaskCompletionFeedback,
  TaskLaunchHealthFinding,
  TaskLaunchHealthSummary,
} from './task-read-model.js';
export type { ChildSessionInfo, GitInfo, SessionInfo, WorktreeHealth } from './session-read-model.js';
export { isActiveStatus, isTerminalStatus, isRecoverableTermination } from './task-status.js';
export type { TerminationReason, TerminationCause } from './task-status.js';
export type { TaskStatus } from './task-status.js';
export type { TokenUsage } from './usage-types.js';

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Claim (or transfer) the Ralph loop owner session on `task`.
 *
 * The owner is the terminal session whose conversation context the loop
 * belongs to. Only the most recent live session is ever the owner at a given
 * time — resume, crash recovery, and re-arm all transfer ownership.
 *
 * `allowTransfer: true` is required to move ownership from one session to
 * another. Without it, ownership is only set when no owner is recorded yet.
 */
export function claimRalphLoopOwner(
  task: Task,
  session: SessionInfo | undefined,
  opts: { allowTransfer?: boolean } = {},
): void {
  const loop = task.ralphLoop;
  if (!loop || !session) return;
  const isTransfer = Boolean(loop.ownerSessionId && loop.ownerSessionId !== session.tmuxSession);
  if (isTransfer && !opts.allowTransfer) return;

  if (!loop.ownerSessionId || isTransfer) loop.ownerSessionId = session.tmuxSession;
}

// Valid transitions: from -> set of allowed destinations
const VALID_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  open: new Set(['pending', 'inProgress', 'terminated', 'cancelled']),
  pending: new Set(['inProgress', 'cancelled']),
  inProgress: new Set(['open', 'completed', 'terminated', 'cancelled']),
  completed: new Set(['open']),
  terminated: new Set(['open', 'completed', 'cancelled']),
  cancelled: new Set(['open']),
};

function cloneTask(task: Task): Task {
  return structuredClone(task) as Task;
}

/**
 * Latest activity timestamp (ms) attributable to a task for snapshot-age
 * purposes. `updatedAt` normally dominates (every transition bumps it), but
 * `finishedAt`/`terminatedAt` are included defensively for legacy records.
 * Using `updatedAt` means any fresh mutation (rename, feedback, reopen) makes
 * an aged terminal task reappear in the snapshot — the operator-friendly
 * behavior. (Moved here from the server snapshot projection so
 * {@link TaskStore.listTasksForSnapshot} can filter pre-clone without a
 * core→server import; the projection re-exports it.)
 */
export function taskSnapshotRecencyMs(task: Pick<Task, 'updatedAt' | 'finishedAt' | 'terminatedAt'>): number {
  return Math.max(
    task.updatedAt.getTime(),
    task.finishedAt?.getTime() ?? 0,
    task.terminatedAt?.getTime() ?? 0,
  );
}

/** True when the task is terminal AND its last activity predates `cutoffMs`. */
export function isAgedTerminalTask(
  task: Pick<Task, 'status' | 'updatedAt' | 'finishedAt' | 'terminatedAt'>,
  cutoffMs: number,
): boolean {
  return isTerminalStatus(task.status) && taskSnapshotRecencyMs(task) < cutoffMs;
}

/**
 * How long an in-flight launch reservation stays authoritative. A launch that
 * hangs past this without attaching a session or failing loses its
 * reservation, so a wedged adapter cannot strand a pending task forever
 * (self-healing, mirrors WorktreeLeaseService's stale-overwrite).
 */
const LAUNCH_RESERVATION_TTL_MS = 10 * 60 * 1000;

interface LaunchReservation {
  reservedAt: number;
  token: string;
  countsAsActive: boolean;
}

export class TaskStore {
  private tasks = new Map<string, Task>();
  /**
   * In-flight launch reservations: taskId → reservedAt (epoch ms). The #700
   * fix (docs/reports/issue-700-multi-session-attach-audit.md): concurrent
   * promotePendingTasks invocations could all pick the same pending task
   * because its status only flips to inProgress when the adapter calls
   * addSession, seconds after the pick. beginLaunchWithToken() is the synchronous CAS
   * that closes that pick-to-launch window. Deliberately NOT persisted — a
   * reservation is meaningless across a restart (the launching process died).
   */
  private launchReservations = new Map<string, LaunchReservation>();
  private launchReservationSequence = 0;
  /**
   * Typed task-relation graph (issue #599). Keyed by
   * {@link taskRelationKey}`(source, target, type)` so dedup is a single map
   * lookup. The deterministic `parentTaskId` field on Task is the source of
   * truth for parent linkage; the relation graph is a parallel store that
   * detectors and inference can append to without ever mutating that field.
   */
  private relations = new Map<string, TaskRelation>();
  /**
   * Last completion-remediation fingerprint delivered per task (issue #1324):
   * taskId → the {@link evaluateCompletionSignal} `stateFingerprint` of the most
   * recent one-time reminder. Lets the Stop-hook policy inject a completion
   * reminder at most once per task state — a fresh reminder only after the task
   * state actually changes. Not persisted: a missing entry simply re-enables one
   * reminder, which is the safe default.
   */
  private completionRemediation = new Map<string, string>();
  /**
   * Recently processed client signalIds (issue #1541). Lets a durable outbox
   * drain safely replay the same `signalId` after a client timeout without
   * re-firing outcome hooks or churning raisedAt — even after the pending
   * signal was dismissed. In-memory only (24h TTL, capped); a restart simply
   * re-accepts a replay, which same-kind setPendingSignal still handles safely.
   */
  private processedSignalIds = new Map<string, { taskId: string; kind: PendingAgentSignal['kind']; atMs: number }>();
  /** Lifetime spending counter (USD); corrected task costs adjust it, and it survives task deletion. */
  private lifetimeSpendUsd: number = 0;

  /**
   * Persistence dirty-set (#1755). Mutators mark the affected task id so the
   * SQLite flush path rewrites only changed rows instead of the whole store.
   * `getTaskForMutation` marks pessimistically (caller took a live ref).
   * Not part of the public read API; drained by the save scheduler.
   */
  private dirtyTaskIds = new Set<string>();
  private deletedTaskIds = new Set<string>();
  private relationsDirty = false;
  private metaDirty = false;

  /**
   * Session-info mutation facet (issue #1823). Owns attach/patch/child/git/
   * worktree/cwd session updates; TaskStore public methods delegate here so
   * callers keep a stable surface while the implementation lives elsewhere.
   */
  private readonly sessionRegistry = new SessionRegistry({
    getTask: (taskId) => this.tasks.get(taskId),
    markTaskDirty: (taskId) => this.markTaskDirty(taskId),
    onSessionAttached: (taskId) => {
      this.launchReservations.delete(taskId);
    },
  });

  /** Mark a task for the next persistence flush. */
  private markTaskDirty(id: string): void {
    this.dirtyTaskIds.add(id);
    this.deletedTaskIds.delete(id);
  }

  /** Mark a task deleted for the next persistence flush. */
  private markTaskDeleted(id: string): void {
    this.dirtyTaskIds.delete(id);
    this.deletedTaskIds.add(id);
  }

  private markRelationsDirty(): void {
    this.relationsDirty = true;
  }

  private markMetaDirty(): void {
    this.metaDirty = true;
  }

  /**
   * Drain dirty persistence state for a flush. Cleared even when the flush
   * later fails — the scheduler re-marks by setting its own dirty flag and
   * the next successful mutation path will re-dirty as needed; on save
   * failure the scheduler keeps its coalesced dirty bit so a force re-flush
   * re-reads current store state via a full re-mark path.
   *
   * Callers that need crash-safe re-flush after a failed write should call
   * {@link markAllDirtyForPersistence} before retrying.
   */
  drainDirtyState(): {
    dirtyTaskIds: string[];
    deletedTaskIds: string[];
    relationsDirty: boolean;
    metaDirty: boolean;
  } {
    const result = {
      dirtyTaskIds: Array.from(this.dirtyTaskIds),
      deletedTaskIds: Array.from(this.deletedTaskIds),
      relationsDirty: this.relationsDirty,
      metaDirty: this.metaDirty,
    };
    this.dirtyTaskIds.clear();
    this.deletedTaskIds.clear();
    this.relationsDirty = false;
    this.metaDirty = false;
    return result;
  }

  /** True when any persistence-relevant mutation is pending a flush. */
  hasDirtyPersistence(): boolean {
    return this.dirtyTaskIds.size > 0
      || this.deletedTaskIds.size > 0
      || this.relationsDirty
      || this.metaDirty;
  }

  /**
   * Mark every in-memory task + relations + meta dirty. Used after a failed
   * flush so the next write re-upserts authoritative state, and for full
   * export / import cutovers.
   */
  markAllDirtyForPersistence(): void {
    for (const id of this.tasks.keys()) this.dirtyTaskIds.add(id);
    this.deletedTaskIds.clear();
    this.relationsDirty = true;
    this.metaDirty = true;
  }

  /** Clear dirty tracking without writing (e.g. after a bulk load). */
  clearDirtyPersistence(): void {
    this.dirtyTaskIds.clear();
    this.deletedTaskIds.clear();
    this.relationsDirty = false;
    this.metaDirty = false;
  }

  /**
   * Creates and returns a snapshot of the newly stored task record. Code that
   * intentionally owns a multi-field state transition must opt in through
   * a narrower TaskStore mutation API (Ralph: {@link runRalphMutation};
   * other multi-field paths: {@link getTaskForMutation} until migrated).
   */
  createTask(opts: CreateTaskOptions): Task;
  createTask(prompt: string, cwd: string, criteria?: string, parentTaskId?: string): Task;
  createTask(promptOrOpts: string | CreateTaskOptions, cwdArg?: string, criteriaArg?: string, parentTaskIdArg?: string): Task {
    const opts: CreateTaskOptions = typeof promptOrOpts === 'string'
      ? { prompt: promptOrOpts, cwd: cwdArg!, criteria: criteriaArg, parentTaskId: parentTaskIdArg }
      : promptOrOpts;
    const {
      prompt,
      userPrompt,
      cwd,
      criteria,
      parentTaskId,
      launchSource,
      scheduleId,
      agentType,
      launchIntent,
      name,
      playbookId,
      playbookParameterValues,
      launchHealthSummary,
      launchAdmission,
      launchNote,
      projectId,
      metadata,
      priority,
      deliveryAuthorization,
      autoCloseOnSignal,
      unattended,
      migratedFromTaskId,
    } = opts;

    // Validate parent exists if specified
    if (parentTaskId !== undefined && !this.tasks.has(parentTaskId)) {
      throw new Error(`Parent task not found: ${parentTaskId}`);
    }

    // Resolve the auto-close-on-signal policy. An explicit value on the launch
    // opts always wins (including an explicit `false` to opt a successor out);
    // otherwise the child inherits the parent's policy so it propagates down a
    // self-continuation chain without relying on the agent forwarding a flag.
    // See docs/reference/auto-close-on-signal.md.
    const parentForInherit = parentTaskId !== undefined ? this.tasks.get(parentTaskId) : undefined;
    const effectiveAutoCloseOnSignal = autoCloseOnSignal !== undefined
      ? autoCloseOnSignal
      : parentForInherit?.autoCloseOnSignal === true;

    // Resolve the unattended/autonomous policy the same way (issue #1562). A
    // child spawned by an autonomous agent that does not forward `unattended`
    // still needs interactive-tool protection — the failure mode #1562 targets
    // lives in self-continuation chains where "nobody can answer" propagates
    // down. Explicit `false` on the launch opts opts a successor back out.
    const effectiveUnattended = unattended !== undefined
      ? unattended
      : parentForInherit?.unattended === true;

    const now = new Date();
    const effectiveAgentType = agentType ?? DEFAULT_AGENT_TYPE;
    const task: Task = {
      id: randomUUID(),
      prompt,
      userPrompt,
      cwd,
      criteria,
      agentType: effectiveAgentType,
      launchIntent: structuredClone(launchIntent ?? {
        schemaVersion: TASK_LAUNCH_INTENT_SCHEMA,
        agentType: effectiveAgentType,
      }) as TaskLaunchIntent,
      parentTaskId,
      // Immutable launch provenance (issue #1583). Derived once from the
      // launch signals present at creation; never mutated afterward.
      provenance: deriveTaskProvenance({ parentTaskId, launchSource, scheduleId }),
      status: 'open',
      sessions: [],
      createdAt: now,
      updatedAt: now,
    };
    // Name every task from birth (issue #1554). An explicit name (playbook or
    // user-supplied) wins and is authoritative; otherwise apply the
    // deterministic prompt-derived name and mark it `autoNamed` so the async
    // LLM namer may later upgrade it. This closes the killed-launcher gap where
    // `reconcileStaleOpenLaunches` terminated a task before post-launch naming
    // ever ran, leaving it terminal with `name=null`.
    const explicitName = name?.trim();
    if (explicitName) {
      task.name = explicitName;
    } else {
      // Derive from the display prompt (launch-context guardrail stripped),
      // matching what the async LLM namer and snapshot projection use, so the
      // placeholder is not the injected worktree preamble.
      task.name = deterministicTaskName(displayPromptForTask({ prompt, userPrompt }), cwd);
      task.autoNamed = true;
    }
    if (playbookId) task.playbookId = playbookId;
    if (projectId) task.projectId = projectId;
    // Cross-agent migration lineage (RFC: rfc-cross-agent-task-migration): a
    // continuation task records the interrupted task it continues. The reverse
    // link is written on the source via setMigrationLink().
    if (migratedFromTaskId) task.migratedFromTaskId = migratedFromTaskId;
    if (playbookParameterValues) {
      task.playbookParameterValues = structuredClone(playbookParameterValues) as Record<string, string>;
    }
    if (launchHealthSummary) {
      task.launchHealthSummary = structuredClone(launchHealthSummary);
    }
    if (launchAdmission) task.launchAdmission = structuredClone(launchAdmission);
    if (launchNote) task.launchNote = launchNote;
    if (metadata) task.metadata = structuredClone(metadata);
    if (priority === 'high') task.priority = priority;
    if (deliveryAuthorization) task.deliveryAuthorization = deliveryAuthorization;
    if (effectiveAutoCloseOnSignal) task.autoCloseOnSignal = true;
    if (effectiveUnattended) task.unattended = true;
    this.tasks.set(task.id, task);
    this.markTaskDirty(task.id);

    // Link child to parent
    if (parentTaskId !== undefined) {
      const parent = this.tasks.get(parentTaskId)!;
      if (!parent.childTaskIds) {
        parent.childTaskIds = [];
      }
      parent.childTaskIds.push(task.id);
      parent.updatedAt = new Date();
      this.markTaskDirty(parentTaskId);

      // Issue #599 acceptance criterion: a deterministic parentTaskId launch
      // also records a high-confidence `spawned_by` edge in the relation
      // graph. Source is 'api' because every parent-bearing createTask call
      // ultimately originates from the launch API surface (HTTP, kookr-spawn,
      // or programmatic). The parent pointer itself is unchanged.
      this.upsertRelation({
        sourceTaskId: task.id,
        targetTaskId: parentTaskId,
        type: 'spawned_by',
        confidence: DETERMINISTIC_RELATION_CONFIDENCE,
        source: 'api',
        evidence: [{
          snippet: `parentTaskId set on createTask for ${task.id}`,
          observedAt: now.toISOString(),
        }],
      });
    }

    return cloneTask(task);
  }

  getTask(id: string): Task | undefined {
    const task = this.tasks.get(id);
    return task ? cloneTask(task) : undefined;
  }

  /**
   * Record cross-agent migration lineage (RFC: rfc-cross-agent-task-migration).
   * Sets `migratedToTaskId` on the interrupted source task, pointing at the
   * continuation task that took over its work under a different agent. The
   * forward link (`migratedFromTaskId`) is set at continuation-task creation.
   * `agentType` is deliberately NOT touched — the source keeps its original
   * agent so cost/outcome ledgers stay truthful. No-op if the source is unknown.
   */
  setMigrationLink(sourceTaskId: string, continuationTaskId: string): void {
    const source = this.tasks.get(sourceTaskId);
    if (!source) return;
    source.migratedToTaskId = continuationTaskId;
    source.updatedAt = new Date();
    this.markTaskDirty(sourceTaskId);
  }

  /**
   * Return the stored mutable task for code paths that intentionally own a
   * multi-field state transition. Prefer narrower TaskStore methods for simple
   * updates; this exists so mutable access is explicit rather than accidental.
   *
   * Ralph loop control paths must use {@link runRalphMutation} instead (issue
   * #1461). Remaining production callers outside Ralph should migrate to
   * narrower methods; tests may continue using this helper for fixtures.
   */
  getTaskForMutation(id: string): Task | undefined {
    const task = this.tasks.get(id);
    if (task) this.markTaskDirty(id);
    return task;
  }

  /**
   * Ralph-owned multi-field state transition port (issue #1461).
   *
   * Replaces {@link getTaskForMutation} for `ralph-loop-service` and
   * `ralph-cycler` so Ralph mutation sites are greppable and the general
   * escape hatch can be closed without Ralph churn.
   *
   * Prefer performing mutations *inside* the mutator callback (sync Ralph
   * transitions). Returning the live task is reserved for multi-step async
   * flows that must hold a reference across awaits — call sites should
   * document that with a short comment. Confine mutations to `ralphLoop`
   * fields and `updatedAt`.
   *
   * @returns The mutator's return value, or `undefined` if the task id is unknown.
   */
  runRalphMutation<T>(taskId: string, mutator: (task: Task) => T): T | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    this.markTaskDirty(taskId);
    return mutator(task);
  }

  /**
   * Read the pending agent → user signal for a task (RFC:
   * rfc-agent-signal-surface). Used by the snapshot projection to join the
   * signal onto the client-facing AgentState. Returns undefined for unknown
   * tasks or tasks with no raised signal.
   */
  getPendingSignal(taskId: string): PendingAgentSignal | undefined {
    return this.tasks.get(taskId)?.pendingSignal;
  }

  /**
   * Raise the pending signal for a task. Idempotent per kind (issue #1324): if a
   * signal of the same kind is already pending, the original `raisedAt` is
   * preserved so a re-raise does not churn the review window or the surfacing;
   * only a newly supplied note is merged in. Raising a different kind replaces
   * the prior signal. No-op for unknown tasks. Returns true when a task was found.
   *
   * When `signal.signalId` is set (issue #1541), a pure replay of that id is
   * recorded in {@link processedSignalIds} so later drains short-circuit via
   * {@link getProcessedSignal}.
   */
  setPendingSignal(taskId: string, signal: PendingAgentSignal): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    this.markTaskDirty(taskId);
    const existing = task.pendingSignal;
    if (existing && existing.kind === signal.kind) {
      // Same-kind re-raise: keep the first raisedAt, adopt a fresh note only if
      // one was provided. This is the store-level idempotency behind a repeated
      // `kookr signal completion-ready`.
      //
      // Deliberate trade-off: pinning raisedAt also drops the incidental
      // "re-raise refreshes the auto-close review window" side effect. If a task
      // keeps an old completion_ready signal across a *new* live session start
      // (crash-recovery/ralph relaunch without a clear), a re-raise no longer
      // advances raisedAt past that start, so the stale-completion auto-close in
      // completion-ready-cleanup keeps skipping it. That errs toward NOT
      // auto-closing (a human completes it) — the safe direction — and refreshing
      // the window on every re-raise is exactly the churn #1324 removes.
      task.pendingSignal = {
        ...existing,
        ...(signal.note !== undefined ? { note: signal.note } : {}),
        // Keep the first signalId for the pending row; a replay of a *different*
        // id still lands as same-kind (raisedAt preserved) but is tracked below.
        ...(existing.signalId ? {} : (signal.signalId ? { signalId: signal.signalId } : {})),
        // Preserve the first provenance stamp (http vs outbox) so later
        // complete-path inference stays stable across same-kind re-raises.
        ...(existing.source ? {} : (signal.source ? { source: signal.source } : {})),
      };
    } else {
      task.pendingSignal = signal;
    }
    if (signal.signalId) {
      this.recordProcessedSignal(signal.signalId, taskId, signal.kind);
    }
    task.updatedAt = new Date();
    return true;
  }

  /**
   * Look up a previously processed client signalId (issue #1541). Returns the
   * recorded task/kind when the id was seen within the TTL window, else undefined.
   */
  getProcessedSignal(
    signalId: string,
    nowMs: number = Date.now(),
  ): { taskId: string; kind: PendingAgentSignal['kind'] } | undefined {
    this.compactProcessedSignalIds(nowMs);
    const entry = this.processedSignalIds.get(signalId);
    if (!entry) return undefined;
    return { taskId: entry.taskId, kind: entry.kind };
  }

  private recordProcessedSignal(
    signalId: string,
    taskId: string,
    kind: PendingAgentSignal['kind'],
    nowMs: number = Date.now(),
  ): void {
    this.processedSignalIds.set(signalId, { taskId, kind, atMs: nowMs });
    this.compactProcessedSignalIds(nowMs);
  }

  private compactProcessedSignalIds(nowMs: number): void {
    const ttlMs = 24 * 60 * 60 * 1000;
    const maxEntries = 2_000;
    for (const [id, entry] of this.processedSignalIds) {
      if (nowMs - entry.atMs > ttlMs) this.processedSignalIds.delete(id);
    }
    if (this.processedSignalIds.size <= maxEntries) return;
    const ordered = [...this.processedSignalIds.entries()]
      .sort((a, b) => a[1].atMs - b[1].atMs);
    const drop = this.processedSignalIds.size - maxEntries;
    for (let i = 0; i < drop; i++) {
      this.processedSignalIds.delete(ordered[i]![0]);
    }
  }

  /**
   * Read the fingerprint of the last completion remediation delivered for a task
   * (issue #1324). Undefined when no reminder has been recorded yet, which the
   * policy treats as "a reminder is allowed".
   */
  getCompletionRemediationFingerprint(taskId: string): string | undefined {
    return this.completionRemediation.get(taskId);
  }

  /**
   * Record that a completion remediation was delivered for the current task
   * state (issue #1324). Passing the {@link evaluateCompletionSignal}
   * `stateFingerprint` suppresses an identical reminder until the state changes.
   */
  recordCompletionRemediation(taskId: string, fingerprint: string): void {
    this.completionRemediation.set(taskId, fingerprint);
  }

  /**
   * Decide what the Stop-hook completion policy should do for a task (issue
   * #1324), wiring the store's own state — status, any pending signal, delivery
   * posture, and the last remediation fingerprint — into
   * {@link evaluateCompletionSignal}. The call latches the once-per-state
   * reminder: a `remediate` decision records its fingerprint, so an identical
   * follow-up call returns `remediation_already_delivered` until the task state
   * changes. Idempotent for already-signaled tasks (returns `skip`). Never
   * marks a delivery-gated task ready before its delivery is satisfied.
   */
  evaluateCompletionSignal(
    taskId: string,
    events: AgentEvent[],
    opts: { agentId?: string; deliverySatisfied?: boolean } = {},
  ): CompletionSignalDecision {
    const task = this.tasks.get(taskId);
    if (!task) {
      return { action: 'skip', reason: 'unknown_task', detail: `Unknown task: ${taskId}.` };
    }
    const decision = evaluateCompletionSignal({
      taskId,
      agentId: opts.agentId ?? taskId,
      status: task.status,
      pendingSignalKind: task.pendingSignal?.kind,
      deliveryAuthorization: task.deliveryAuthorization,
      deliverySatisfied: opts.deliverySatisfied,
      events,
      lastRemediationFingerprint: this.getCompletionRemediationFingerprint(taskId),
    });
    // Latch at decision time, not delivery time: once we decide to remediate we
    // record the fingerprint immediately, so a caller that retries — or crashes
    // mid-delivery — still gets at-most-once feedback per state. This mirrors the
    // Stop nudge's "commit the marker before blocking" rule (bin/kookr-stop-nudge.js):
    // for a "non-repetitive" gate, a missed reminder is preferable to a repeated one.
    if (decision.action === 'remediate' && decision.stateFingerprint) {
      this.recordCompletionRemediation(taskId, decision.stateFingerprint);
    }
    return decision;
  }

  /**
   * Clear any pending signal for a task. No-op when the task is unknown or has
   * no signal. Returns true when a signal was actually cleared (so callers can
   * skip a redundant broadcast).
   */
  clearPendingSignal(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task?.pendingSignal) return false;
    delete task.pendingSignal;
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
    return true;
  }

  /**
   * Flag a task operator-needed after an unattended agent's interactive-tool
   * call was denied (issue #1562). First-write-wins: a repeated denied call on
   * the same task keeps the original marker rather than churning `updatedAt`
   * (and the snapshot broadcast) on every retry. Returns true only when the
   * marker was newly set, so callers can log/broadcast exactly once.
   */
  setOperatorNeeded(taskId: string, flag: OperatorNeeded): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.operatorNeeded) return false;
    task.operatorNeeded = structuredClone(flag);
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
    return true;
  }

  listTasks(filter?: { status?: TaskStatus }): Task[] {
    const all = Array.from(this.tasks.values());
    if (filter?.status) {
      return all.filter((t) => t.status === filter.status).map(cloneTask);
    }
    return all.map(cloneTask);
  }

  /**
   * Non-cloning read view of every task. Returns the LIVE task objects:
   * callers MUST NOT mutate them and MUST NOT retain them across store
   * mutations — read synchronously, derive, and drop. Exists for hot read
   * paths (snapshot-broadcast enrichment, issue #1749) where the per-task
   * `structuredClone` in {@link listTasks} costs ~58 MB of heap churn and
   * ~110 ms of blocked event loop per call at 800 tasks, which turned
   * hook-event bursts into heap-limit OOMs.
   *
   * **Hot-path rule:** timers, WS fan-out, and terminal-adjacent code must
   * prefer {@link viewLiveTasks} / {@link countTasks} so historical completed
   * records never tax the event loop. Use this full view only when cold
   * paths (persistence, analytics, operator dumps) truly need every record.
   */
  viewTasks(): readonly Task[] {
    return Array.from(this.tasks.values());
  }

  /**
   * Non-cloning view of **non-terminal** tasks only (`open` / `pending` /
   * `inProgress`). Hot paths (liveness residual counts, capacity, watchdog
   * pruning of active Ralph loops, session health) MUST use this so an
   * unbounded pile of completed tasks cannot slow terminal input or
   * WebSocket heartbeats. Returns live store objects — read-only contract
   * same as {@link viewTasks}.
   */
  viewLiveTasks(): readonly Task[] {
    const out: Task[] = [];
    for (const task of this.tasks.values()) {
      if (!isTerminalStatus(task.status)) out.push(task);
    }
    return out;
  }

  /**
   * O(n) count without allocating task arrays or cloning. Optional status
   * filter. Use for health `agents` gauges and capacity ledgers that only
   * need cardinality.
   */
  countTasks(filter?: { status?: TaskStatus; liveOnly?: boolean }): number {
    let n = 0;
    for (const task of this.tasks.values()) {
      if (filter?.status !== undefined && task.status !== filter.status) continue;
      if (filter?.liveOnly && isTerminalStatus(task.status)) continue;
      n += 1;
    }
    return n;
  }

  /**
   * Cloning accessor for snapshot builds that filters BEFORE cloning
   * (issue #1749 follow-up). The client snapshot path discards terminal tasks
   * older than its age cutoff anyway, but the old flow cloned all of them
   * first — ~78 MB of garbage per snapshot build at 814 tasks, 98% of it
   * terminal — and that transient churn is what ratcheted V8's retained arena
   * toward the heap limit. Skipping aged terminal tasks pre-clone keeps the
   * safe detached-copy semantics for what remains (the projection embeds task
   * sub-objects like `tokenUsage`/`ralphLoop` by reference, so the clone is
   * load-bearing here — do NOT swap in {@link viewTasks}).
   * Without a cutoff this is exactly {@link getAllTasks}.
   *
   * The clone set is bounded strictly by age + count (issue #2408). Tasks
   * owning a live monitor session are NOT exempted from the bounds here: the
   * old `protectSessionIds` exemption deep-cloned nearly the whole terminal
   * fleet on high-throughput days (its purpose was only to keep the
   * projection's session-suppression index complete), yet the projection
   * re-applied the same cutoff/cap and dropped those tasks from the payload
   * anyway. Ghost-agent suppression now runs off `droppedTerminalSessions`:
   * pass a `Set` and this call fills it, during the same walk, with the
   * `tmuxSession`s of the terminal tasks it dropped — the projection uses that
   * as `suppressSessionIds`, with no clones and no second scan.
   */
  listTasksForSnapshot(opts?: {
    excludeTerminalBeforeMs?: number;
    /**
     * Cap on terminal tasks kept after the age cutoff. Most recent first (by
     * {@link taskSnapshotRecencyMs}). Live/non-terminal tasks are never capped.
     * When unset, no count cap is applied (raw/debug path).
     */
    maxTerminalTasks?: number;
    /**
     * Ghost-agent guard collector (issue #2408). When provided, the `tmuxSession`
     * of every terminal task this call DROPS (aged past the cutoff, or capped
     * out) is added here during the same walk — no second scan. The snapshot
     * projection uses it as `suppressSessionIds` so a live monitor state whose
     * owning terminal task was dropped is suppressed instead of leaking as an
     * unattributed "ghost" agent. Filled with dropped ids only; kept tasks are
     * never added (their sessions are already in the projection's index).
     */
    droppedTerminalSessions?: Set<string>;
  }): Task[] {
    const cutoff = opts?.excludeTerminalBeforeMs;
    const maxTerminal = opts?.maxTerminalTasks;
    const dropped = opts?.droppedTerminalSessions;
    const applyTerminalCap =
      maxTerminal !== undefined
      && Number.isFinite(maxTerminal)
      && maxTerminal >= 0;

    const recordDropped = (task: Task): void => {
      if (!dropped) return;
      for (const s of task.sessions) dropped.add(s.tmuxSession);
    };

    // Fast path: no count cap → single-pass clone (age filter only).
    if (!applyTerminalCap) {
      const out: Task[] = [];
      for (const task of this.tasks.values()) {
        if (cutoff !== undefined && isAgedTerminalTask(task, cutoff)) {
          recordDropped(task);
          continue;
        }
        out.push(cloneTask(task));
      }
      return out;
    }

    // Count-capped path: keep all live/pending, then the most recent N
    // terminals that survive the age cutoff. Cloning only the retained set
    // avoids the ~hundreds-of-MB transient cost of cloning every same-day
    // terminal task on high-throughput hosts.
    const always: Task[] = [];
    const terminalCandidates: Task[] = [];
    for (const task of this.tasks.values()) {
      if (isTerminalStatus(task.status)) {
        if (cutoff !== undefined && isAgedTerminalTask(task, cutoff)) {
          recordDropped(task);
          continue;
        }
        terminalCandidates.push(task);
        continue;
      }
      always.push(task);
    }

    const terminalCap = Math.floor(maxTerminal as number);
    let terminals = terminalCandidates;
    if (terminalCandidates.length > terminalCap) {
      const sorted = [...terminalCandidates]
        .sort((a, b) => taskSnapshotRecencyMs(b) - taskSnapshotRecencyMs(a));
      terminals = sorted.slice(0, terminalCap);
      // Terminals beyond the cap are dropped too — record them for the guard.
      for (const task of sorted.slice(terminalCap)) recordDropped(task);
    }

    return [...always, ...terminals].map((task) => cloneTask(task));
  }

  private transition(id: string, to: TaskStatus): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    if (!VALID_TRANSITIONS[task.status].has(to)) {
      throw new InvalidTransitionError(task.status, to);
    }
    const now = new Date();
    const dependencyAdmission = task.launchAdmission !== undefined;
    const dependencyCleanupSessionId = task.launchAdmission?.status === 'probing'
      ? task.launchAdmission.sessionId
      : undefined;
    const dependencyCleanupFence = dependencyCleanupSessionId !== undefined
      && task.sessions.some(
        (session) => session.tmuxSession === dependencyCleanupSessionId
          && session.lastStatus !== 'completed'
          && session.lastStatus !== 'aborted',
      );
    task.status = to;
    task.updatedAt = now;
    if (isTerminalStatus(to)) {
      task.finishedAt ??= now;
    } else {
      delete task.finishedAt;
    }
    if (dependencyAdmission && isTerminalStatus(to) && !dependencyCleanupFence) {
      // Terminal work is no longer retryable pending intent. Remove the
      // admission marker and its pre-launch health snapshot so diagnostics and
      // the next startup cannot resurrect canceled/terminated parked work. A
      // probing marker with an unproven physical session is cleanup ownership,
      // not retry intent, and survives only until reconciliation proves that
      // exact session absent.
      task.launchAdmission = undefined;
      task.launchHealthSummary = undefined;
    }
    this.markTaskDirty(id);
    return task;
  }

  startTask(id: string): Task {
    return cloneTask(this.transition(id, 'inProgress'));
  }

  completeTask(id: string): Task {
    return cloneTask(this.transition(id, 'completed'));
  }

  /**
   * Transition a task to 'terminated': all sessions died without explicit user action.
   * The user must acknowledge (→ completed) or reopen (→ open) to progress.
   *
   * `cause` records WHY the task died (issue #1664) so a swept cohort is
   * diagnosable and the recovery path can tell a resumable kill from a
   * deliberate one. When omitted the reason defaults to `unknown` — a
   * terminated task always has a non-empty `terminationReason`.
   */
  terminateTask(id: string, cause?: TerminationCause): Task {
    const task = this.transition(id, 'terminated');
    task.terminatedAt = new Date();
    task.terminationReason = cause?.reason ?? 'unknown';
    if (cause?.signal) task.terminationSignal = cause.signal;
    if (cause?.detail) task.terminationDetail = cause.detail;
    return cloneTask(task);
  }

  cancelTask(id: string): Task {
    return cloneTask(this.transition(id, 'cancelled'));
  }

  /**
   * Record a pre-session disposition on a task WITHOUT deleting it (issue
   * #1588). This is the queryable evidence that a launch-timeout cleanup,
   * boot-time stale-open-launch reconcile, or overload shed disposed of the
   * task on purpose — replacing the old "silently `deleteTask`" behaviour that
   * erased the record and let a retry create a duplicate.
   *
   * First-write-wins: if several paths race to dispose the same task, the root
   * cause is preserved. No-op for an unknown task or one already disposed.
   * Bumps `updatedAt` so the aged-record prune's recency window protects the
   * freshly-disposed record until it is genuinely old. Does NOT change status —
   * callers that also want the task terminal call `terminateTask` alongside.
   */
  setDisposition(id: string, disposition: TaskDisposition): void {
    const task = this.tasks.get(id);
    if (!task || task.disposition) return;
    task.disposition = { ...disposition };
    task.updatedAt = new Date();
    this.markTaskDirty(id);
  }

  /**
   * Persist a fail-closed automatic-relaunch outcome. First-write-wins keeps
   * repeated recovery ticks from obscuring the original missing/malformed data.
   */
  setRelaunchDisposition(id: string, disposition: TaskRelaunchDisposition): void {
    const task = this.tasks.get(id);
    if (!task || task.relaunchDisposition || !disposition) return;
    task.relaunchDisposition = structuredClone(disposition);
    task.updatedAt = new Date();
    this.markTaskDirty(id);
  }

  /**
   * Record per-phase launch timings on a task (issue #1589). Written by the
   * launch service on every launch attempt that reaches the adapter — on
   * success (the full `preflight → … → ack` sequence) and on
   * timeout/error (with {@link LaunchPhaseTimings.incompletePhase} naming the
   * phase that consumed the time). Last-write-wins so the failure snapshot,
   * written after the success attempt's would-be value, is authoritative. Does
   * NOT change status or bump `updatedAt` on its own — callers pair it with
   * setDisposition/terminateTask, which already bump recency. No-op for an
   * unknown task.
   */
  setLaunchPhaseTimings(id: string, timings: LaunchPhaseTimings): void {
    const task = this.tasks.get(id);
    if (!task) return;
    task.launchPhaseTimings = structuredClone(timings);
    this.markTaskDirty(id);
  }

  pendTask(id: string): Task {
    return cloneTask(this.transition(id, 'pending'));
  }

  /** Update the pre-worker dependency admission marker without changing status. */
  setLaunchAdmission(id: string, admission: Task['launchAdmission'] | undefined): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.launchAdmission = admission ? structuredClone(admission) : undefined;
    task.updatedAt = new Date();
    this.markTaskDirty(id);
    return cloneTask(task);
  }

  /** Clear or replace the launch-time dependency health snapshot. */
  setLaunchHealthSummary(id: string, summary: Task['launchHealthSummary'] | undefined): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.launchHealthSummary = summary ? structuredClone(summary) : undefined;
    task.updatedAt = new Date();
    this.markTaskDirty(id);
    return cloneTask(task);
  }

  /** Clear or replace the advisory text paired with launch-health findings. */
  setLaunchNote(id: string, note: string | undefined): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    task.launchNote = note;
    task.updatedAt = new Date();
    this.markTaskDirty(id);
    return cloneTask(task);
  }

  reopenTask(id: string): Task {
    return cloneTask(this.transition(id, 'open'));
  }

  deleteTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    this.launchReservations.delete(id);
    this.completionRemediation.delete(id);
    // Unlink from parent
    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent?.childTaskIds) {
        parent.childTaskIds = parent.childTaskIds.filter((cid) => cid !== id);
        parent.updatedAt = new Date();
        this.markTaskDirty(task.parentTaskId);
      }
    }
    this.tasks.delete(id);
    this.markTaskDeleted(id);
    // Drop any relation that references the deleted task on either side.
    let droppedRelation = false;
    for (const [key, rel] of this.relations) {
      if (rel.sourceTaskId === id || rel.targetTaskId === id) {
        this.relations.delete(key);
        droppedRelation = true;
      }
    }
    if (droppedRelation) this.markRelationsDirty();
  }

  /**
   * Synchronous launch-reservation CAS (#700 fix). Returns true when the
   * caller now exclusively owns the right to launch this task; false when the
   * task is missing, not launchable (already inProgress/terminal), or another
   * launcher holds a fresh reservation. No await may sit between a
   * getNextPending() pick and this call — Node's single thread then makes the
   * pick-and-reserve atomic.
   */
  /**
   * Token-bearing reservation variant for async launch owners. A stale owner
   * whose await outlives the reservation TTL can use the token to prove it
   * still owns the task and cannot release a replacement owner's lease.
   */
  beginLaunchWithToken(taskId: string): string | undefined {
    return this.beginReservationWithToken(taskId, true);
  }

  /**
   * Fence a pre-launch durability barrier without claiming a worker slot.
   *
   * Persistence owners must exclude promoters just like launch owners: a
   * stale rejected write must never dispose work that another owner started.
   * They are not, however, physical or in-flight workers, so capacity must not
   * count them. This matters most for confirmed-degraded parked work, whose
   * admission invariant is zero slots.
   */
  beginLaunchPersistenceWithToken(taskId: string): string | undefined {
    return this.beginReservationWithToken(taskId, false);
  }

  private beginReservationWithToken(
    taskId: string,
    countsAsActive: boolean,
  ): string | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (task.status !== 'open' && task.status !== 'pending') return undefined;
    if (this.hasFreshLaunchReservation(taskId)) return undefined;
    const token = `launch-reservation-${++this.launchReservationSequence}`;
    this.launchReservations.set(taskId, { reservedAt: Date.now(), token, countsAsActive });
    return token;
  }

  /** Release a launch reservation, optionally only for its exact owner. */
  endLaunch(taskId: string, token: string): void {
    if (this.launchReservations.get(taskId)?.token !== token) return;
    this.launchReservations.delete(taskId);
  }

  /** True only while the exact async owner still holds a fresh reservation. */
  ownsLaunchReservation(taskId: string, token: string): boolean {
    return this.hasFreshLaunchReservation(taskId)
      && this.launchReservations.get(taskId)?.token === token;
  }

  /** True when another live async owner has replaced the caller's lease. */
  hasForeignFreshLaunchReservation(taskId: string, token: string): boolean {
    if (!this.hasFreshLaunchReservation(taskId)) return false;
    return this.launchReservations.get(taskId)?.token !== token;
  }

  /**
   * Read reservation freshness for ownership/exclusion. Both physical-launch
   * and persistence-only reservations block another promoter.
   */
  hasFreshLaunchReservation(taskId: string): boolean {
    const reservation = this.launchReservations.get(taskId);
    if (reservation === undefined) return false;
    if (Date.now() - reservation.reservedAt >= LAUNCH_RESERVATION_TTL_MS) {
      this.launchReservations.delete(taskId);
      return false;
    }
    return true;
  }

  /** True only for a fresh reservation that occupies a worker slot. */
  hasFreshActiveLaunchReservation(taskId: string): boolean {
    return this.hasFreshLaunchReservation(taskId)
      && this.launchReservations.get(taskId)?.countsAsActive === true;
  }

  /**
   * Count tasks that occupy a concurrency slot: inProgress, plus tasks with a
   * fresh slot-occupying launch reservation. Counting launch reservations closes the
   * second half of the #700 race — the old inProgress-only count let the
   * promotion loop over-launch past the cap while launches were mid-await.
   */
  getActiveCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'inProgress') count++;
      else if (
        (task.status === 'open' || task.status === 'pending')
        && this.hasFreshActiveLaunchReservation(task.id)
      ) count++;
    }
    return count;
  }

  /** Get the oldest pending task (FIFO queue order), skipping tasks already reserved for launch. */
  getNextPending(): Task | undefined {
    let oldest: Task | undefined;
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' && !this.hasFreshLaunchReservation(task.id)) {
        if (!oldest || task.createdAt < oldest.createdAt) {
          oldest = task;
        }
      }
    }
    return oldest ? cloneTask(oldest) : undefined;
  }

  /**
   * Count work in the capacity queue. Dependency-blocked parked work does not
   * consume this limit; a half-open probe waiting for capacity does.
   */
  getPendingCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (
        task.status === 'pending'
        && (
          task.launchAdmission?.status !== 'parked'
          || task.launchAdmission.reason === 'half_open_waiting_for_capacity'
        )
      ) count++;
    }
    return count;
  }

  renameTask(id: string, name: string): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    task.name = name.trim() || undefined;
    // A rename yields an authoritative name (LLM upgrade, user edit, or the
    // reconcile backstop); it is no longer the creation-time placeholder, so
    // the auto-name marker is cleared and future auto-naming will not touch it.
    delete task.autoNamed;
    task.updatedAt = new Date();
    this.markTaskDirty(id);
    return cloneTask(task);
  }

  setTaskPriority(id: string, priority: TaskPriorityUpdate): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    if (priority === 'high') {
      task.priority = 'high';
    } else {
      delete task.priority;
    }
    task.updatedAt = new Date();
    this.markTaskDirty(id);
    return cloneTask(task);
  }

  setTaskEdges(id: string, patch: { blocks?: TaskDependencyEdge[]; blocked_by?: TaskDependencyEdge[] }): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    if (patch.blocks !== undefined) {
      task.blocks = [...patch.blocks];
    }
    if (patch.blocked_by !== undefined) {
      task.blocked_by = [...patch.blocked_by];
    }
    task.updatedAt = new Date();
    this.markTaskDirty(id);
    return cloneTask(task);
  }

  /** @see SessionRegistry.addSession */
  addSession(taskId: string, session: SessionInfo): Task {
    return this.sessionRegistry.addSession(taskId, session);
  }

  /** @see SessionRegistry.recordAbandonedLaunchSession */
  recordAbandonedLaunchSession(taskId: string, session: SessionInfo): void {
    this.sessionRegistry.recordAbandonedLaunchSession(taskId, session);
  }

  /** @see SessionRegistry.updateSession */
  updateSession(
    taskId: string,
    tmuxName: string,
    patch: Partial<SessionInfo>,
  ): Task {
    return this.sessionRegistry.updateSession(taskId, tmuxName, patch);
  }

  /** @see SessionRegistry.recordChildSession */
  recordChildSession(
    taskId: string,
    tmuxName: string,
    childSessionId: string,
    info: ChildSessionInfo,
  ): void {
    this.sessionRegistry.recordChildSession(taskId, tmuxName, childSessionId, info);
  }

  /** @see SessionRegistry.updateSessionGitInfo */
  updateSessionGitInfo(taskId: string, tmuxSession: string, gitInfo: GitInfo): void {
    this.sessionRegistry.updateSessionGitInfo(taskId, tmuxSession, gitInfo);
  }

  /** @see SessionRegistry.updateSessionWorktreeHealth */
  updateSessionWorktreeHealth(
    taskId: string,
    tmuxSession: string,
    health: WorktreeHealth,
    opts: { registryStale?: boolean } = {},
  ): void {
    this.sessionRegistry.updateSessionWorktreeHealth(taskId, tmuxSession, health, opts);
  }

  /** @see SessionRegistry.updateSessionCwd */
  updateSessionCwd(taskId: string, tmuxSession: string, cwd: string): void {
    this.sessionRegistry.updateSessionCwd(taskId, tmuxSession, cwd);
  }

  setCompletionDigest(taskId: string, digest: CompletionDigest): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    // Hard UTF-8 byte cap on bullets/filesChanged so memory + tasks.json stay
    // bounded (issue #1780). Client projection still count-caps for the wire.
    const capped = capCompletionDigestForStorage(digest);
    const criteriaVerdict = capped.criteriaVerdict ?? task.completionDigest?.criteriaVerdict;
    task.completionDigest = criteriaVerdict ? { ...capped, criteriaVerdict } : capped;
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
  }

  setCriteriaVerdict(taskId: string, verdict: CriteriaCompletionVerdict): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.completionDigest = {
      ...(task.completionDigest ?? { bullets: ['Task completed'], filesChanged: [] }),
      criteriaVerdict: structuredClone(verdict) as CriteriaCompletionVerdict,
    };
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
  }

  /**
   * Stamp provider-transient retry lineage on a freshly-spawned retry task
   * (issue #1712). `retryOf` is the ORIGINAL failing task (the lineage root) and
   * `retryAttempt` is the 1-based attempt number, which the completion path
   * reads to enforce the bounded-retry cap. No-op for an unknown task.
   */
  setRetryLineage(taskId: string, lineage: { retryOf: string; retryAttempt: number }): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.retryOf = lineage.retryOf;
    task.retryAttempt = lineage.retryAttempt;
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
  }

  /**
   * Upsert user feedback on a completed task. Returns true if the value changed,
   * false if it was a no-op (existing feedback deep-equal to the input). Callers
   * use the boolean to suppress redundant interaction-log emissions.
   */
  setCompletionFeedback(taskId: string, feedback: TaskCompletionFeedback): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const existing = task.completionFeedback;
    if (existing
      && existing.rating === feedback.rating
      && (existing.note ?? '') === (feedback.note ?? '')
      && existing.downReason === feedback.downReason) {
      return false;
    }
    task.completionFeedback = feedback;
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
    return true;
  }

  setReflectMeta(taskId: string, meta: ReflectMeta): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.reflectMeta = meta;
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
  }

  setLaunchPermissionPosture(taskId: string, posture: TaskLaunchPermissionPosture | undefined): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (posture) {
      task.metadata = {
        ...(task.metadata ?? {}),
        launchPermissionPosture: structuredClone(posture),
      };
    } else if (task.metadata?.launchPermissionPosture) {
      const metadata = structuredClone(task.metadata);
      delete metadata.launchPermissionPosture;
      task.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
    }
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
    return cloneTask(task);
  }

  updateTokenUsage(taskId: string, usage: TokenUsage): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    // Apply the current task's spending delta, including downward corrections
    // when a later transcript scan replaces fallback pricing with exact data.
    const previousCost = task.tokenUsage?.costUsd ?? 0;
    const delta = usage.costUsd - previousCost;
    if (Number.isFinite(delta) && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) {
      this.lifetimeSpendUsd += delta;
      this.markMetaDirty();
    }
    task.tokenUsage = structuredClone(usage) as TokenUsage;
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
    return cloneTask(task);
  }

  /**
   * Roll a task's own `tokenUsage` up with every descendant's (children,
   * grandchildren, …) so a parent/batch task shows aggregate spend
   * (issue #1307). Read-only: this does NOT mutate any task's own
   * `tokenUsage`, so per-task totals (outcome ledger, lifetime spend) stay
   * un-double-counted. Returns undefined when neither the task nor any
   * descendant has metered usage.
   *
   * `provider`/`model` are carried onto the aggregate only when every
   * contributing task agrees. A batch that mixes vendors (e.g. a Claude parent
   * orchestrating Codex children) reports neither, because a single blended
   * cost cannot be attributed to one price.
   * `pricingQuality` is carried only when every contributing record has the
   * field; when present, `fallback` wins over `exact`.
   */
  getAggregateTokenUsage(taskId: string): TokenUsage | undefined {
    if (!this.tasks.has(taskId)) return undefined;
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, costUsd = 0;
    let sawUsage = false;
    let provider: TokenUsage['provider'] | undefined;
    let model: string | undefined;
    let pricingQuality: TokenUsage['pricingQuality'];
    let pricingQualityComplete = true;
    let providerUniform = true;
    let modelUniform = true;
    const visited = new Set<string>();
    const stack = [taskId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue; // guard against relation cycles / DAG re-convergence
      visited.add(id);
      const task = this.tasks.get(id);
      if (!task) continue;
      const usage = task.tokenUsage;
      if (usage) {
        if (!sawUsage) {
          sawUsage = true;
          provider = usage.provider;
          model = usage.model;
        } else {
          if (usage.provider !== provider) providerUniform = false;
          if (usage.model !== model) modelUniform = false;
        }
        if (usage.pricingQuality == null) {
          pricingQualityComplete = false;
        } else if (usage.pricingQuality === 'fallback') {
          pricingQuality = 'fallback';
        } else if (pricingQuality !== 'fallback') {
          pricingQuality = 'exact';
        }
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        cacheReadTokens += usage.cacheReadTokens;
        cacheWriteTokens += usage.cacheWriteTokens;
        if (Number.isFinite(usage.costUsd)) costUsd += usage.costUsd;
      }
      for (const childId of task.childTaskIds ?? []) stack.push(childId);
    }
    if (!sawUsage) return undefined;
    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd,
      ...(providerUniform && provider ? { provider } : {}),
      ...(modelUniform && model ? { model } : {}),
      ...(pricingQualityComplete && pricingQuality ? { pricingQuality } : {}),
    };
  }

  getActiveSessions(): Array<{ taskId: string; session: SessionInfo }> {
    const result: Array<{ taskId: string; session: SessionInfo }> = [];
    for (const task of this.tasks.values()) {
      for (const session of task.sessions) {
        if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
          result.push({ taskId: task.id, session: structuredClone(session) as SessionInfo });
        }
      }
    }
    return result;
  }

  /** Set the projectId on a task. */
  setProjectId(taskId: string, projectId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.projectId = projectId;
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
  }

  /**
   * Set the issue-ownership claim projection on a task (RFC:
   * rfc-issue-ownership-lock R3). Sole legitimate caller is
   * IssueClaimRegistry — enforced by a call-site guard test; do NOT call
   * this from anywhere else.
   */
  setIssueClaim(taskId: string, claim: IssueClaim): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.issueClaim = structuredClone(claim);
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
  }

  /**
   * Clear the issue-ownership claim projection (RFC R3). Sole legitimate
   * caller is IssueClaimRegistry — see setIssueClaim.
   */
  clearIssueClaim(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task?.issueClaim) return;
    delete task.issueClaim;
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
  }

  /** Override the agentType on a task. Used by the demo recorder to surface a Codex agent alongside Claude agents without touching adapter routing. */
  setAgentType(taskId: string, agentType: AgentType): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.agentType = agentType;
    task.updatedAt = new Date();
    this.markTaskDirty(taskId);
  }

  /** Get all unique project IDs across all tasks. */
  getProjectIds(): string[] {
    const ids = new Set<string>();
    for (const task of this.tasks.values()) {
      if (task.projectId) ids.add(task.projectId);
    }
    return Array.from(ids);
  }

  /** List tasks belonging to a specific project. */
  listTasksByProject(projectId: string): Task[] {
    return Array.from(this.tasks.values()).filter((t) => t.projectId === projectId).map(cloneTask);
  }

  /** Find the task that owns a given tmux session name. O(n) scan. */
  findTaskBySession(tmuxSessionName: string): Task | undefined {
    const task = this.viewTaskBySession(tmuxSessionName);
    return task === undefined ? undefined : cloneTask(task);
  }

  /**
   * Non-cloning {@link findTaskBySession} (issue #2413). Returns the live
   * store object — read-only contract same as {@link viewTasks}. Hot paths
   * that only *read* owner fields (attention signals, hung-task evaluation,
   * scope checks) MUST use this or {@link findTaskIdBySession}: the cloning
   * variant `structuredClone`s a ~50 KB task record per call, and per-tick /
   * per-event callers were a dominant main-thread cost on high-throughput
   * hosts (event-loop p95 ~2s → terminal stream stutter).
   */
  viewTaskBySession(tmuxSessionName: string): Task | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessions.some((s) => s.tmuxSession === tmuxSessionName)) {
        return task;
      }
    }
    return undefined;
  }

  /**
   * Id-only {@link findTaskBySession} (issue #2413) — no clone, no object
   * handed out. The cheapest owner lookup for callers that only need the task
   * id (attention-queue snooze keys, hook ingestion attribution, monitor
   * event attribution).
   */
  findTaskIdBySession(tmuxSessionName: string): string | undefined {
    return this.viewTaskBySession(tmuxSessionName)?.id;
  }

  /**
   * Lightweight session refs for fleet health projection (SessionHealthService).
   *
   * Walks the live task map without `structuredClone`. By default skips
   * terminal tasks (`completed` / `terminated` / `cancelled`) — health is only
   * actionable for live work, and projecting every historical session on a
   * fleet cache tick (250ms) was blocking the event loop for tens of seconds
   * of cumulative work once hundreds of completed tasks accumulated (terminal
   * input lag, health timeouts). Each ref is a plain value object safe to
   * retain; it does not alias mutable store state.
   *
   * Pass `{ includeTerminalTasks: true }` for diagnostic dumps that need the
   * full historical set.
   */
  listSessionHealthRefs(opts?: {
    includeTerminalTasks?: boolean;
  }): Array<{
    sessionId: string;
    taskStatus: TaskStatus;
    turnState?: TurnState;
    transcriptPath?: string;
  }> {
    const includeTerminal = opts?.includeTerminalTasks === true;
    const out: Array<{
      sessionId: string;
      taskStatus: TaskStatus;
      turnState?: TurnState;
      transcriptPath?: string;
    }> = [];
    for (const task of this.tasks.values()) {
      if (!includeTerminal && isTerminalStatus(task.status)) continue;
      for (const session of task.sessions) {
        out.push({
          sessionId: session.tmuxSession,
          taskStatus: task.status,
          ...(session.lastTurnState ? { turnState: session.lastTurnState } : {}),
          ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
        });
      }
    }
    return out;
  }

  /** Get all tasks as an array (for serialization) */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values()).map(cloneTask);
  }

  /**
   * Upsert a typed relation. Returns the resulting record. Dedup key is
   * `(sourceTaskId, targetTaskId, type)`: if a record already exists under
   * that key, the input updates its `confidence`, `source`, `lifecycle` and
   * extends `evidence` (each evidence entry deduped on `snippet|path`), and
   * bumps `updatedAt`. `id` and `createdAt` are preserved.
   *
   * Existence of source/target tasks is NOT validated — callers may record a
   * relation that points to a task they have not yet stored (used by detectors
   * working from external state).
   */
  upsertRelation(input: TaskRelationInput): TaskRelation {
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error(`relation confidence must be in [0, 1], got ${input.confidence}`);
    }
    const key = taskRelationKey(input.sourceTaskId, input.targetTaskId, input.type);
    const nowIso = new Date().toISOString();
    const inputEvidence = input.evidence ?? [];
    const existing = this.relations.get(key);

    if (existing) {
      existing.confidence = input.confidence;
      existing.source = input.source;
      existing.lifecycle = input.lifecycle ?? existing.lifecycle;
      existing.updatedAt = nowIso;
      if (inputEvidence.length > 0) {
        const evidenceKey = (e: { snippet?: string; path?: string }): string =>
          JSON.stringify([e.snippet ?? null, e.path ?? null]);
        const seen = new Set(existing.evidence.map(evidenceKey));
        for (const ev of inputEvidence) {
          const dedupKey = evidenceKey(ev);
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          existing.evidence.push({ ...ev });
        }
      }
      this.markRelationsDirty();
      return structuredClone(existing) as TaskRelation;
    }

    const record: TaskRelation = {
      id: randomUUID(),
      sourceTaskId: input.sourceTaskId,
      targetTaskId: input.targetTaskId,
      type: input.type,
      confidence: input.confidence,
      source: input.source,
      evidence: inputEvidence.map((e) => ({ ...e })),
      createdAt: nowIso,
      updatedAt: nowIso,
      lifecycle: input.lifecycle ?? 'active',
    };
    this.relations.set(key, record);
    this.markRelationsDirty();
    return structuredClone(record) as TaskRelation;
  }

  /** Return all stored relations. Snapshot copies; safe to mutate. */
  listRelations(filter?: {
    sourceTaskId?: string;
    targetTaskId?: string;
    type?: TaskRelationType;
    taskId?: string;
  }): TaskRelation[] {
    const out: TaskRelation[] = [];
    for (const rel of this.relations.values()) {
      if (filter?.sourceTaskId && rel.sourceTaskId !== filter.sourceTaskId) continue;
      if (filter?.targetTaskId && rel.targetTaskId !== filter.targetTaskId) continue;
      if (filter?.type && rel.type !== filter.type) continue;
      if (filter?.taskId && rel.sourceTaskId !== filter.taskId && rel.targetTaskId !== filter.taskId) continue;
      out.push(structuredClone(rel) as TaskRelation);
    }
    return out;
  }

  /**
   * Bulk-replace the relation set, e.g. on persistence load. Records are
   * accepted as-is (after a key dedup pass); callers MUST have already
   * validated/normalized them.
   */
  loadRelations(relations: TaskRelation[]): void {
    this.relations.clear();
    for (const rel of relations) {
      const key = taskRelationKey(rel.sourceTaskId, rel.targetTaskId, rel.type);
      this.relations.set(key, structuredClone(rel) as TaskRelation);
    }
    // Bulk load is authoritative; nothing to flush until the next mutation.
    this.relationsDirty = false;
  }

  /** Load tasks from an array (for deserialization) */
  loadTasks(tasks: Task[], savedLifetimeSpendUsd?: number): void {
    this.tasks.clear();
    for (const task of tasks) {
      const loaded = cloneTask(task);
      // Soft migrate oversized digests persisted before the write-time cap
      // (issue #1780) so the next saveTasks rewrite drops the bloat.
      if (loaded.completionDigest) {
        loaded.completionDigest = capCompletionDigestForStorage(loaded.completionDigest);
      }
      this.tasks.set(task.id, loaded);
    }
    if (savedLifetimeSpendUsd !== undefined && Number.isFinite(savedLifetimeSpendUsd) && savedLifetimeSpendUsd > 0) {
      this.lifetimeSpendUsd = savedLifetimeSpendUsd;
    } else {
      // Bootstrap: reconstruct from existing task data
      this.lifetimeSpendUsd = 0;
      for (const task of tasks) {
        const cost = task.tokenUsage?.costUsd ?? 0;
        if (Number.isFinite(cost) && cost > 0) {
          this.lifetimeSpendUsd += cost;
        }
      }
    }
    // Bulk load is authoritative; do not flush the whole store as "dirty".
    this.clearDirtyPersistence();
  }

  /** Get the lifetime total spending in USD. */
  getLifetimeSpendUsd(): number {
    return this.lifetimeSpendUsd;
  }
}
