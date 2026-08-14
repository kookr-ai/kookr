import type { ChildSessionInfo, GitInfo, SessionInfo, WorktreeHealth } from './session-read-model.js';
import type { Task } from './task-read-model.js';
import { isTerminalStatus } from './task-status.js';

/**
 * Host port for {@link SessionRegistry}: the registry mutates session fields on
 * live Task objects owned by TaskStore, and reports dirty state so persistence
 * can flush. Launch-reservation clearing stays on TaskStore (not peeled here).
 */
export interface SessionRegistryHost {
  getTask(taskId: string): Task | undefined;
  markTaskDirty(taskId: string): void;
  /**
   * Called after a session is successfully attached. TaskStore uses this to
   * drop the in-flight launch reservation without SessionRegistry owning that
   * ledger (issue #1823 first peel — LaunchReservationLedger is a later slice).
   */
  onSessionAttached(taskId: string): void;
}

function cloneTask(task: Task): Task {
  return structuredClone(task) as Task;
}

/**
 * Session-info mutation facet peeled from TaskStore (issue #1823).
 *
 * Owns attach / patch / child-session / git / worktree-health / cwd updates on
 * `task.sessions`. TaskStore composes this and keeps thin public delegates so
 * the Expand-Migrate-Contract first slice preserves the existing call surface.
 */
export class SessionRegistry {
  constructor(private readonly host: SessionRegistryHost) {}

  addSession(taskId: string, session: SessionInfo): Task {
    const task = this.host.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    // A terminal task cannot gain a new live session (issue #1588). The only
    // caller is an adapter mid-launch; the sole way to reach here on a terminal
    // task is an abandoned launch that late-settles AFTER a launch-timeout
    // disposed+terminated the task (see raceLaunchAgainstTimeout). Refusing
    // keeps the disposed record session-free and makes the late launch reject
    // on its own — exactly the "Task not found" rejection the old deleteTask
    // used to produce. Legit relaunch reopens the task first (crash-recovery.ts
    // reopenTask → open) so this never fires on a live path.
    if (isTerminalStatus(task.status)) {
      throw new Error(`Cannot attach session to terminal task ${taskId} (status=${task.status})`);
    }
    // The launch this reservation guarded has landed.
    this.host.onSessionAttached(taskId);
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
    this.host.markTaskDirty(taskId);

    return cloneTask(task);
  }

  /**
   * Link a dtach master to a task as an already-dead (`aborted`) session even
   * when the task is terminal (issue #2500).
   *
   * Unlike {@link addSession} this is terminal-safe — it neither refuses a
   * terminal task nor transitions status — because its sole purpose is to give
   * the session reaper an *owner* for a master whose launch was abandoned at the
   * top-level launch timeout. A launch-timeout task otherwise finishes with an
   * empty session list, so a late-booting master the reaper then finds has no
   * owning task and is classified `unowned` (reaped only after 24h / 2h under
   * pressure) instead of `terminal-task-leak` (60s). Recording it here — before
   * OR after the terminal transition — makes the reaper own it as a
   * terminal-task-leak. Idempotent per session id; the session is stamped
   * `lastStatus: 'aborted'` so reconcile never treats it as resumable (it must
   * not be re-attached across a restart).
   */
  recordAbandonedLaunchSession(taskId: string, session: SessionInfo): void {
    const task = this.host.getTask(taskId);
    if (!task) return;
    if (task.sessions.some((s) => s.tmuxSession === session.tmuxSession)) return;
    task.sessions.push(structuredClone({ ...session, lastStatus: 'aborted' }) as SessionInfo);
    task.updatedAt = new Date();
    this.host.markTaskDirty(taskId);
  }

  updateSession(
    taskId: string,
    tmuxName: string,
    patch: Partial<SessionInfo>,
  ): Task {
    const task = this.host.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    const session = task.sessions.find((s) => s.tmuxSession === tmuxName);
    if (!session) {
      throw new Error(`Session not found: ${tmuxName}`);
    }
    Object.assign(session, patch);
    task.updatedAt = new Date();
    this.host.markTaskDirty(taskId);
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
    const task = this.host.getTask(taskId);
    if (!task) return;
    const session = task.sessions.find((s) => s.tmuxSession === tmuxName);
    if (!session) return;
    const existing = session.childSessionIds ?? {};
    if (existing[childSessionId]) return;
    session.childSessionIds = { ...existing, [childSessionId]: info };
    task.updatedAt = new Date();
    this.host.markTaskDirty(taskId);
  }

  updateSessionGitInfo(taskId: string, tmuxSession: string, gitInfo: GitInfo): void {
    const task = this.host.getTask(taskId);
    if (!task) return;
    const session = task.sessions.find((s) => s.tmuxSession === tmuxSession);
    if (!session) return;
    session.gitBranch = gitInfo.branch ?? undefined;
    session.gitCommit = gitInfo.commit ?? undefined;
    session.gitDir = gitInfo.gitDir;
    session.gitIsWorktree = gitInfo.isWorktree || undefined;
    session.gitIsDetached = gitInfo.isDetached || undefined;
    task.updatedAt = new Date();
    this.host.markTaskDirty(taskId);
  }

  updateSessionWorktreeHealth(
    taskId: string,
    tmuxSession: string,
    health: WorktreeHealth,
    opts: { registryStale?: boolean } = {},
  ): void {
    const task = this.host.getTask(taskId);
    if (!task) return;
    const session = task.sessions.find((s) => s.tmuxSession === tmuxSession);
    if (!session) return;
    session.worktreeHealth = health;
    session.worktreeHealthObservedAt = new Date().toISOString();
    session.worktreeRegistryStale = opts.registryStale || undefined;
    task.updatedAt = new Date();
    this.host.markTaskDirty(taskId);
  }

  updateSessionCwd(taskId: string, tmuxSession: string, cwd: string): void {
    const task = this.host.getTask(taskId);
    if (!task) return;
    const session = task.sessions.find((s) => s.tmuxSession === tmuxSession);
    if (!session) return;
    session.cwd = cwd;
    task.updatedAt = new Date();
    this.host.markTaskDirty(taskId);
  }
}
