import { randomUUID } from 'node:crypto';
import { DEFAULT_AGENT_TYPE, type AgentType } from './agent-types.js';
import type { CompletionDigest } from './completion-digest.js';
import type { ChildSessionInfo, GitInfo, SessionInfo, WorktreeHealth } from './session-read-model.js';
import type { TaskStatus } from './task-status.js';
import type { TokenUsage } from './usage-types.js';
import type {
  CreateTaskOptions,
  ReflectMeta,
  Task,
  TaskCompletionFeedback,
} from './task-read-model.js';

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

export class TaskStore {
  private tasks = new Map<string, Task>();
  /** Monotonically increasing lifetime spending counter (USD). Survives task deletion. */
  private lifetimeSpendUsd: number = 0;

  createTask(opts: CreateTaskOptions): Task;
  createTask(prompt: string, cwd: string, criteria?: string, parentTaskId?: string): Task;
  createTask(promptOrOpts: string | CreateTaskOptions, cwdArg?: string, criteriaArg?: string, parentTaskIdArg?: string): Task {
    const opts: CreateTaskOptions = typeof promptOrOpts === 'string'
      ? { prompt: promptOrOpts, cwd: cwdArg!, criteria: criteriaArg, parentTaskId: parentTaskIdArg }
      : promptOrOpts;
    const {
      prompt,
      cwd,
      criteria,
      parentTaskId,
      agentType,
      playbookParameterValues,
      launchHealthSummary,
      launchNote,
    } = opts;

    // Validate parent exists if specified
    if (parentTaskId !== undefined && !this.tasks.has(parentTaskId)) {
      throw new Error(`Parent task not found: ${parentTaskId}`);
    }

    const now = new Date();
    const task: Task = {
      id: randomUUID(),
      prompt,
      cwd,
      criteria,
      agentType: agentType ?? DEFAULT_AGENT_TYPE,
      parentTaskId,
      status: 'open',
      sessions: [],
      createdAt: now,
      updatedAt: now,
    };
    if (playbookParameterValues) task.playbookParameterValues = playbookParameterValues;
    if (launchHealthSummary) task.launchHealthSummary = launchHealthSummary;
    if (launchNote) task.launchNote = launchNote;
    this.tasks.set(task.id, task);

    // Link child to parent
    if (parentTaskId !== undefined) {
      const parent = this.tasks.get(parentTaskId)!;
      if (!parent.childTaskIds) {
        parent.childTaskIds = [];
      }
      parent.childTaskIds.push(task.id);
      parent.updatedAt = new Date();
    }

    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(filter?: { status?: TaskStatus }): Task[] {
    const all = Array.from(this.tasks.values());
    if (filter?.status) {
      return all.filter((t) => t.status === filter.status);
    }
    return all;
  }

  private transition(id: string, to: TaskStatus): Task {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    if (!VALID_TRANSITIONS[task.status].has(to)) {
      throw new InvalidTransitionError(task.status, to);
    }
    task.status = to;
    task.updatedAt = new Date();
    return task;
  }

  startTask(id: string): Task {
    return this.transition(id, 'inProgress');
  }

  completeTask(id: string): Task {
    return this.transition(id, 'completed');
  }

  /**
   * Transition a task to 'terminated': all sessions died without explicit user action.
   * The user must acknowledge (→ completed) or reopen (→ open) to progress.
   */
  terminateTask(id: string): Task {
    const task = this.transition(id, 'terminated');
    task.terminatedAt = new Date();
    return task;
  }

  cancelTask(id: string): Task {
    return this.transition(id, 'cancelled');
  }

  pendTask(id: string): Task {
    return this.transition(id, 'pending');
  }

  reopenTask(id: string): Task {
    return this.transition(id, 'open');
  }

  deleteTask(id: string): void {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Task not found: ${id}`);
    // Unlink from parent
    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId);
      if (parent?.childTaskIds) {
        parent.childTaskIds = parent.childTaskIds.filter((cid) => cid !== id);
        parent.updatedAt = new Date();
      }
    }
    this.tasks.delete(id);
  }

  /** Count tasks that are actively running (inProgress with live sessions). */
  getActiveCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'inProgress') count++;
    }
    return count;
  }

  /** Get the oldest pending task (FIFO queue order). */
  getNextPending(): Task | undefined {
    let oldest: Task | undefined;
    for (const task of this.tasks.values()) {
      if (task.status === 'pending') {
        if (!oldest || task.createdAt < oldest.createdAt) {
          oldest = task;
        }
      }
    }
    return oldest;
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
    return task;
  }

  addSession(taskId: string, session: SessionInfo): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    task.sessions.push(session);
    task.updatedAt = new Date();

    // Auto-transition to inProgress when a session is added (covers both fresh and promoted tasks)
    if (task.status === 'open' || task.status === 'pending') {
      task.status = 'inProgress';
    }

    return task;
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
    return task;
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
    task.completionDigest = digest;
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

  updateTokenUsage(taskId: string, usage: TokenUsage): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    // Accumulate spending delta into lifetime counter
    const previousCost = task.tokenUsage?.costUsd ?? 0;
    const delta = usage.costUsd - previousCost;
    if (Number.isFinite(delta) && delta > 0) {
      this.lifetimeSpendUsd += delta;
    }
    task.tokenUsage = usage;
    task.updatedAt = new Date();
    return task;
  }

  getActiveSessions(): Array<{ taskId: string; session: SessionInfo }> {
    const result: Array<{ taskId: string; session: SessionInfo }> = [];
    for (const task of this.tasks.values()) {
      for (const session of task.sessions) {
        if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
          result.push({ taskId: task.id, session });
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
    return Array.from(this.tasks.values()).filter((t) => t.projectId === projectId);
  }

  /** Find the task that owns a given tmux session name. O(n) scan. */
  findTaskBySession(tmuxSessionName: string): Task | undefined {
    for (const task of this.tasks.values()) {
      if (task.sessions.some((s) => s.tmuxSession === tmuxSessionName)) {
        return task;
      }
    }
    return undefined;
  }

  /** Get all tasks as an array (for serialization) */
  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  /** Load tasks from an array (for deserialization) */
  loadTasks(tasks: Task[], savedLifetimeSpendUsd?: number): void {
    this.tasks.clear();
    for (const task of tasks) {
      this.tasks.set(task.id, task);
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
