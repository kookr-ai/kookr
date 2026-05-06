import { randomUUID } from 'node:crypto';
import type { TaskStatus, AgentStatus, TokenUsage, GitInfo, CodexHookCapabilities } from './types.js';
import type { CompletionDigest } from './completion-digest.js';
import { DEFAULT_AGENT_TYPE, type AgentType } from './agent-types.js';

export type AutonomyLevel = 'supervised' | 'autonomous';

/**
 * User feedback on a completed task. Drives the per-task self-reflect loop.
 * `rating` is always required; `note` and `downReason` are optional enrichment.
 * Stored on `Task.completionFeedback` and persisted to the interaction log.
 */
export interface TaskCompletionFeedback {
  rating: 'up' | 'down';
  /** Free-text note, sanitized server-side before persistence. */
  note?: string;
  /** Only meaningful when rating === 'down'. */
  downReason?: 'agent_behavior' | 'my_prompt';
}

/**
 * Marker for a reflect task spawned to analyze a completed source task.
 * Persisted on the spawned task itself so cleanup logic can identify reflect tasks
 * by their relationship to a source task.
 */
export interface ReflectMeta {
  /** Source task this reflect is analyzing. */
  sourceTaskId: string;
  /** Path to the immutable feedback bundle dir the reflect was launched against. */
  bundlePath: string;
  /** 'up' triggers reinforcement branch in the skill; 'down' triggers fix-proposal branch. */
  direction: 'up' | 'down';
}

/**
 * Lifecycle status of a Ralph Wiggum-style iteration loop attached to a task.
 * See issue #440. Terminal states (`completed`, `failed`, `cancelled`) prevent
 * further iteration injection on Stop events.
 * See issue #440. Terminal states (`completed`, `failed`, `cancelled`) prevent
 * further iteration injection on Stop events.
 */
export type RalphLoopStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Per-task Ralph loop state. Drives the on-Stop iteration cycle: when the
 * agent emits Stop and `status === 'running'`, the controller evaluates the
 * iteration cap and the optional shell `stopPredicate`, then either re-injects
 * `prompt` or terminates the loop.
 *
 * All timestamps are ms-since-epoch numbers so the field round-trips through
 * JSON persistence without extra deserialization (Date objects would need
 * manual reconstruction in `loadTasks`).
 *
 * Fields are deliberately small — the iteration audit trail lives in a
 * separate JSONL file (`<task-dir>/ralph-iterations.jsonl`), not in this
 * struct, so per-task JSON does not balloon as iterations accumulate.
 */
export interface RalphZeroDiffConvergenceConfig {
  consecutiveIterations: number;
}

export interface RalphLoopState {
  /** Verbatim user prompt re-injected on every iteration. No length cap. */
  prompt: string;
  /** Hard ceiling. Always-checked, separate from any predicate. */
  iterationCap: number;
  /**
   * Optional user-supplied shell command. Exit code 0 = stop; non-zero or
   * timeout = keep looping. Executed with cwd = task workdir, env
   * `RALPH_ITERATION` and `RALPH_LAST_OUTPUT_FILE`. 5s timeout enforced
   * by the controller (not encoded here).
   */
  stopPredicate?: string;
  /** Optional convergence config — stop when N consecutive iterations produce zero diff. */
  zeroDiffConvergence?: RalphZeroDiffConvergenceConfig;
  /** Optional best-effort cost cap in USD. Fails closed when cost is unknown. */
  costCapUsd?: number;
  /** Current consecutive zero-diff streak. Reset on any non-zero diff. */
  zeroDiffStreak?: number;
  /** 0-based count of iterations that have started. Incremented on each re-inject. */
  currentIteration: number;
  status: RalphLoopStatus;
  /** When the most recent iteration was injected. 0 before the first iteration. */
  lastIterationStartedAt: number;
  /** Fingerprint of the last Stop event that was fully handled (launch + cleanup). */
  lastHandledStopFingerprint?: string;
  /** Fingerprint of the Stop event currently being handled (in-flight dedup guard). */
  handlingStopFingerprint?: string;
  /** Terminal session ID that owns this loop's conversation context. */
  ownerSessionId?: string;
  /** Claude/Codex runtime session ID for the owning session. */
  ownerRuntimeSessionId?: string;
  /** Transcript path for the owning runtime session. */
  ownerTranscriptPath?: string;
  /**
   * Sum of iterations across the loop's lifetime, including any iterations
   * before a pause/resume cycle. `currentIteration` is reset by re-arm; this
   * counter is not.
   */
  cumulativeIterations: number;
}

export interface CreateTaskOptions {
  prompt: string;
  cwd: string;
  criteria?: string;
  parentTaskId?: string;
  autonomy?: AutonomyLevel;
  agentType?: AgentType;
  /** Original playbook parameter values, for relaunch pre-fill. */
  playbookParameterValues?: Record<string, string>;
}

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`Invalid transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface SessionInfo {
  tmuxSession: string;
  agentType: AgentType;
  cwd: string;
  createdAt: Date;
  claudeSessionId?: string;
  transcriptPath?: string;
  codexHookCapabilities?: CodexHookCapabilities;
  lastStatus?: AgentStatus | 'completed' | 'aborted';
  /** Last hook event timestamp (ms since epoch). Persisted for watchdog restart recovery. */
  lastEventAt?: number;
  gitBranch?: string;
  gitCommit?: string;
  gitIsWorktree?: boolean;
  gitIsDetached?: boolean;
  /** Set to true when this session was terminated by a crash and a replacement was launched. */
  crashRecovered?: boolean;
  /** How many times this session chain has been relaunched (0 = original). */
  relaunchCount?: number;
  /** Timestamp (ms since epoch) when this session chain was last relaunched. */
  lastRelaunchedAt?: number;
  /**
   * Set to true on a NEW session that was launched via `claude --resume <id> --fork-session`
   * after a crash, vs a fresh launch from the original prompt. The dead predecessor
   * retains the existing `crashRecovered: true` flag. See docs/rfc/rfc-crash-recovery-resume.md.
   */
  resumedFromCrash?: boolean;
}

export interface Task {
  id: string;
  name?: string;
  prompt: string;
  cwd: string;
  criteria?: string;
  agentType: AgentType;
  playbookId?: string;
  /** Original playbook parameter values, for relaunch pre-fill. */
  playbookParameterValues?: Record<string, string>;
  parentTaskId?: string;
  childTaskIds?: string[];
  /** Normalized project identifier (e.g. "github.com/owner/repo" or "local/dirname"). */
  projectId?: string;
  status: TaskStatus;
  sessions: SessionInfo[];
  tokenUsage?: TokenUsage;
  /** Summary of what the agent accomplished, generated on task completion. */
  completionDigest?: CompletionDigest;
  /** User feedback on the completed task. Drives the per-task self-reflect loop. */
  completionFeedback?: TaskCompletionFeedback;
  /** Marker present iff this task is itself a reflect spawn analyzing another task. */
  reflectMeta?: ReflectMeta;
  /** Autonomy level: 'supervised' (default) pauses on needs_input; 'autonomous' auto-proceeds stop-type. */
  autonomy: AutonomyLevel;
  /** Auto-proceed delay in ms. Default: 180_000 (3 minutes). */
  autoProceedDelayMs?: number;
  /** Number of auto-proceed attempts (persisted for crash recovery). Reset on autonomy change or user respond. */
  autoProceedRetries?: number;
  createdAt: Date;
  updatedAt: Date;
  /** Set when the task transitions to 'terminated' via reconciliation. */
  terminatedAt?: Date;
  /**
   * Ralph Wiggum-style iteration loop state. Present only when the task was
   * launched (or upgraded) into Ralph mode. Absence = no loop. See issue #440.
   */
  ralphLoop?: RalphLoopState;
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

  if (!loop.ownerSessionId || isTransfer) {
    loop.ownerSessionId = session.tmuxSession;
    delete loop.ownerRuntimeSessionId;
    delete loop.ownerTranscriptPath;
  }
  if (!loop.ownerRuntimeSessionId && session.claudeSessionId) {
    loop.ownerRuntimeSessionId = session.claudeSessionId;
  }
  if (!loop.ownerTranscriptPath && session.transcriptPath) {
    loop.ownerTranscriptPath = session.transcriptPath;
  }
}

/**
 * Exhaustive classifier: a status is "terminal" when the task has reached an end state.
 * The switch body forces a compile error when a new TaskStatus is added, so every caller
 * that uses this helper is re-routed through a deliberate classification decision.
 */
export function isTerminalStatus(s: TaskStatus): boolean {
  switch (s) {
    case 'completed':
    case 'terminated':
    case 'cancelled':
      return true;
    case 'open':
    case 'pending':
    case 'inProgress':
      return false;
  }
}

export function isActiveStatus(s: TaskStatus): boolean {
  return !isTerminalStatus(s);
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
    const { prompt, cwd, criteria, parentTaskId, autonomy, agentType, playbookParameterValues } = opts;

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
      autonomy: autonomy ?? 'supervised',
      createdAt: now,
      updatedAt: now,
    };
    if (playbookParameterValues) task.playbookParameterValues = playbookParameterValues;
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
    // The Ralph loop's owner refs are seeded at attach time when claudeSessionId
    // and transcriptPath are usually still undefined. Re-claim here so late-
    // arriving fields (set when the agent's SessionStart hook fires) propagate
    // into ownerRuntimeSessionId / ownerTranscriptPath. Without this,
    // isStopFromMainTaskSession rejects every Stop event, the iteration counter
    // never increments, and the loop never re-fires.
    if (task.ralphLoop && task.ralphLoop.ownerSessionId === tmuxName) {
      claimRalphLoopOwner(task, session);
    }
    task.updatedAt = new Date();
    return task;
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
      // Default missing autonomy field for tasks created before this feature
      if (!task.autonomy) task.autonomy = 'supervised';
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

  /** Reset auto-proceed retry counter (e.g. after user responds manually). */
  resetAutoProceedRetries(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.autoProceedRetries = 0;
    task.updatedAt = new Date();
  }

  /** Increment auto-proceed retry counter. */
  incrementAutoProceedRetries(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.autoProceedRetries = (task.autoProceedRetries ?? 0) + 1;
    task.updatedAt = new Date();
  }

  /** Change a task's autonomy level. Returns the previous level, or undefined if task not found. */
  setAutonomy(taskId: string, level: AutonomyLevel): AutonomyLevel | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const from = task.autonomy;
    task.autonomy = level;
    task.updatedAt = new Date();
    if (level === 'supervised') {
      task.autoProceedRetries = 0;
    }
    return from;
  }
}
