import { randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_TYPE, type AgentType } from './agent-types.js';
import type { CompletionDigest } from './completion-digest.js';
import { evaluateCompletionSignal, type CompletionSignalDecision } from './completion-signal.js';
import type { AgentEvent } from './types.js';
import type { IssueClaim } from './issue-claim-types.js';
import type { CriteriaCompletionVerdict } from '../shared/contracts/completion-digest.js';
import type { PendingAgentSignal } from '../shared/contracts/agent-signal.js';
import type {
  TaskDependencyEdge,
  TaskLaunchPermissionPosture,
  TaskPriorityUpdate,
} from '../shared/contracts/task.js';
import type { ChildSessionInfo, GitInfo, SessionInfo, WorktreeHealth } from './session-read-model.js';
import type { TokenUsage } from './usage-types.js';
import type {
  CreateTaskOptions,
  ReflectMeta,
  Task,
  TaskCompletionFeedback,
} from './task-read-model.js';
import { isTerminalStatus, type TaskStatus } from './task-status.js';
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
export { isActiveStatus, isTerminalStatus } from './task-status.js';
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
 * How long an in-flight launch reservation stays authoritative. A launch that
 * hangs past this without attaching a session or failing loses its
 * reservation, so a wedged adapter cannot strand a pending task forever
 * (self-healing, mirrors WorktreeLeaseService's stale-overwrite).
 */
const LAUNCH_RESERVATION_TTL_MS = 10 * 60 * 1000;

export class TaskStore {
  private tasks = new Map<string, Task>();
  /**
   * In-flight launch reservations: taskId → reservedAt (epoch ms). The #700
   * fix (docs/reports/issue-700-multi-session-attach-audit.md): concurrent
   * promotePendingTasks invocations could all pick the same pending task
   * because its status only flips to inProgress when the adapter calls
   * addSession, seconds after the pick. beginLaunch() is the synchronous CAS
   * that closes that pick-to-launch window. Deliberately NOT persisted — a
   * reservation is meaningless across a restart (the launching process died).
   */
  private launchReservations = new Map<string, number>();
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
  /** Lifetime spending counter (USD); corrected task costs adjust it, and it survives task deletion. */
  private lifetimeSpendUsd: number = 0;

  /**
   * Creates and returns a snapshot of the newly stored task record. Code that
   * intentionally owns a multi-field state transition must opt in through
   * getTaskForMutation or a narrower TaskStore mutation API.
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
      agentType,
      name,
      playbookId,
      playbookParameterValues,
      launchHealthSummary,
      launchNote,
      projectId,
      metadata,
      priority,
      deliveryAuthorization,
      autoCloseOnSignal,
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

    const now = new Date();
    const task: Task = {
      id: randomUUID(),
      prompt,
      userPrompt,
      cwd,
      criteria,
      agentType: agentType ?? DEFAULT_AGENT_TYPE,
      parentTaskId,
      status: 'open',
      sessions: [],
      createdAt: now,
      updatedAt: now,
    };
    if (name) task.name = name.trim() || undefined;
    if (playbookId) task.playbookId = playbookId;
    if (projectId) task.projectId = projectId;
    if (playbookParameterValues) {
      task.playbookParameterValues = structuredClone(playbookParameterValues) as Record<string, string>;
    }
    if (launchHealthSummary) {
      task.launchHealthSummary = structuredClone(launchHealthSummary);
    }
    if (launchNote) task.launchNote = launchNote;
    if (metadata) task.metadata = structuredClone(metadata);
    if (priority === 'high') task.priority = priority;
    if (deliveryAuthorization) task.deliveryAuthorization = deliveryAuthorization;
    if (effectiveAutoCloseOnSignal) task.autoCloseOnSignal = true;
    this.tasks.set(task.id, task);

    // Link child to parent
    if (parentTaskId !== undefined) {
      const parent = this.tasks.get(parentTaskId)!;
      if (!parent.childTaskIds) {
        parent.childTaskIds = [];
      }
      parent.childTaskIds.push(task.id);
      parent.updatedAt = new Date();

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
   * Return the stored mutable task for code paths that intentionally own a
   * multi-field state transition. Prefer narrower TaskStore methods for simple
   * updates; this exists so mutable access is explicit rather than accidental.
   */
  getTaskForMutation(id: string): Task | undefined {
    return this.tasks.get(id);
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
   */
  setPendingSignal(taskId: string, signal: PendingAgentSignal): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
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
      };
    } else {
      task.pendingSignal = signal;
    }
    task.updatedAt = new Date();
    return true;
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
    return true;
  }

  listTasks(filter?: { status?: TaskStatus }): Task[] {
    const all = Array.from(this.tasks.values());
    if (filter?.status) {
      return all.filter((t) => t.status === filter.status).map(cloneTask);
    }
    return all.map(cloneTask);
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
    task.status = to;
    task.updatedAt = now;
    if (isTerminalStatus(to)) {
      task.finishedAt ??= now;
    } else {
      delete task.finishedAt;
    }
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
   */
  terminateTask(id: string): Task {
    const task = this.transition(id, 'terminated');
    task.terminatedAt = new Date();
    return cloneTask(task);
  }

  cancelTask(id: string): Task {
    return cloneTask(this.transition(id, 'cancelled'));
  }

  pendTask(id: string): Task {
    return cloneTask(this.transition(id, 'pending'));
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
      }
    }
    this.tasks.delete(id);
    // Drop any relation that references the deleted task on either side.
    for (const [key, rel] of this.relations) {
      if (rel.sourceTaskId === id || rel.targetTaskId === id) {
        this.relations.delete(key);
      }
    }
  }

  /**
   * Synchronous launch-reservation CAS (#700 fix). Returns true when the
   * caller now exclusively owns the right to launch this task; false when the
   * task is missing, not launchable (already inProgress/terminal), or another
   * launcher holds a fresh reservation. No await may sit between a
   * getNextPending() pick and this call — Node's single thread then makes the
   * pick-and-reserve atomic.
   */
  beginLaunch(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== 'open' && task.status !== 'pending') return false;
    if (this.hasFreshLaunchReservation(taskId)) return false;
    this.launchReservations.set(taskId, Date.now());
    return true;
  }

  /** Release a launch reservation (launch failed or was abandoned). */
  endLaunch(taskId: string): void {
    this.launchReservations.delete(taskId);
  }

  private hasFreshLaunchReservation(taskId: string): boolean {
    const reservedAt = this.launchReservations.get(taskId);
    if (reservedAt === undefined) return false;
    if (Date.now() - reservedAt >= LAUNCH_RESERVATION_TTL_MS) {
      this.launchReservations.delete(taskId);
      return false;
    }
    return true;
  }

  /**
   * Count tasks that occupy a concurrency slot: inProgress, plus tasks with a
   * fresh in-flight launch reservation. Counting reservations closes the
   * second half of the #700 race — the old inProgress-only count let the
   * promotion loop over-launch past the cap while launches were mid-await.
   */
  getActiveCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'inProgress') count++;
      else if ((task.status === 'open' || task.status === 'pending') && this.hasFreshLaunchReservation(task.id)) count++;
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

  /** Count pending tasks. */
  getPendingCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'pending') count++;
    }
    return count;
  }

  renameTask(id: string, name: string): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    task.name = name.trim() || undefined;
    task.updatedAt = new Date();
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
    return cloneTask(task);
  }

  addSession(taskId: string, session: SessionInfo): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    // The launch this reservation guarded has landed.
    this.launchReservations.delete(taskId);
    // Detection funnel (#700 audit item 2): every attach path crosses here.
    // A second not-known-dead session cannot be *prevented* at this point
    // (the process already exists — prevention is beginLaunch upstream), but
    // it must be a loud, attributable event instead of a supervisor
    // discovery. Exclusions, matching the other live-session predicates in
    // the codebase: crash-recovered siblings (reconcile stamped the dead
    // ones; the recovered marker itself is a legit re-attach), and Ralph
    // tasks entirely — a Ralph iteration relaunch attaches a fresh session
    // while the prior iteration's record keeps lastStatus undefined, so the
    // filter would false-positive on every iteration ≥ 2 and drown the
    // signal (Ralph's own liveness probe guards its duplicates).
    const liveSiblings = task.sessions.filter(
      (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && !s.crashRecovered,
    );
    if (liveSiblings.length > 0 && !task.ralphLoop) {
      console.error(
        `[tasks] duplicate-session attach on ${taskId}: new session ${session.tmuxSession} joins `
        + `${liveSiblings.length} not-known-dead session(s) (${liveSiblings.map((s) => s.tmuxSession).join(', ')}) `
        + '— see docs/reports/issue-700-multi-session-attach-audit.md',
      );
    }
    task.sessions.push(structuredClone(session) as SessionInfo);
    task.updatedAt = new Date();

    // Auto-transition to inProgress when a session is added (covers both fresh and promoted tasks)
    if (task.status === 'open' || task.status === 'pending') {
      task.status = 'inProgress';
    }

    return cloneTask(task);
  }

  updateSession(
    taskId: string,
    tmuxName: string,
    patch: Partial<SessionInfo>,
  ): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const session = task.sessions.find((s) => s.tmuxSession === tmuxName);
    if (!session) {
      throw new Error(`Session not found: ${tmuxName}`);
    }
    Object.assign(session, patch);
    task.updatedAt = new Date();
    return cloneTask(task);
  }

  /**
   * Idempotently record a non-parent runtime session id observed on this
   * Kookr session's hook file. First-write wins per child id — repeated
   * SessionStart events for the same child do not overwrite firstSeenAt.
   * See rfc-activity-log-reliability §2.
   */
  recordChildSession(
    taskId: string,
    tmuxName: string,
    childSessionId: string,
    info: ChildSessionInfo,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const session = task.sessions.find((s) => s.tmuxSession === tmuxName);
    if (!session) return;
    const existing = session.childSessionIds ?? {};
    if (existing[childSessionId]) return;
    session.childSessionIds = { ...existing, [childSessionId]: info };
    task.updatedAt = new Date();
  }

  updateSessionGitInfo(taskId: string, tmuxSession: string, gitInfo: GitInfo): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const session = task.sessions.find((s) => s.tmuxSession === tmuxSession);
    if (!session) return;
    session.gitBranch = gitInfo.branch ?? undefined;
    session.gitCommit = gitInfo.commit ?? undefined;
    session.gitDir = gitInfo.gitDir;
    session.gitIsWorktree = gitInfo.isWorktree || undefined;
    session.gitIsDetached = gitInfo.isDetached || undefined;
    task.updatedAt = new Date();
  }

  updateSessionWorktreeHealth(
    taskId: string,
    tmuxSession: string,
    health: WorktreeHealth,
    opts: { registryStale?: boolean } = {},
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const session = task.sessions.find((s) => s.tmuxSession === tmuxSession);
    if (!session) return;
    session.worktreeHealth = health;
    session.worktreeHealthObservedAt = new Date().toISOString();
    session.worktreeRegistryStale = opts.registryStale || undefined;
    task.updatedAt = new Date();
  }

  updateSessionCwd(taskId: string, tmuxSession: string, cwd: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const session = task.sessions.find((s) => s.tmuxSession === tmuxSession);
    if (!session) return;
    session.cwd = cwd;
    task.updatedAt = new Date();
  }

  setCompletionDigest(taskId: string, digest: CompletionDigest): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    const criteriaVerdict = digest.criteriaVerdict ?? task.completionDigest?.criteriaVerdict;
    task.completionDigest = criteriaVerdict ? { ...digest, criteriaVerdict } : digest;
    task.updatedAt = new Date();
  }

  setCriteriaVerdict(taskId: string, verdict: CriteriaCompletionVerdict): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.completionDigest = {
      ...(task.completionDigest ?? { bullets: ['Task completed'], filesChanged: [] }),
      criteriaVerdict: structuredClone(verdict) as CriteriaCompletionVerdict,
    };
    task.updatedAt = new Date();
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
    return true;
  }

  setReflectMeta(taskId: string, meta: ReflectMeta): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.reflectMeta = meta;
    task.updatedAt = new Date();
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
    }
    task.tokenUsage = structuredClone(usage) as TokenUsage;
    task.updatedAt = new Date();
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
  }

  /** Override the agentType on a task. Used by the demo recorder to surface a Codex agent alongside Claude agents without touching adapter routing. */
  setAgentType(taskId: string, agentType: AgentType): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.agentType = agentType;
    task.updatedAt = new Date();
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
    for (const task of this.tasks.values()) {
      if (task.sessions.some((s) => s.tmuxSession === tmuxSessionName)) {
        return cloneTask(task);
      }
    }
    return undefined;
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
  }

  /** Load tasks from an array (for deserialization) */
  loadTasks(tasks: Task[], savedLifetimeSpendUsd?: number): void {
    this.tasks.clear();
    for (const task of tasks) {
      this.tasks.set(task.id, cloneTask(task));
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
  }

  /** Get the lifetime total spending in USD. */
  getLifetimeSpendUsd(): number {
    return this.lifetimeSpendUsd;
  }
}
