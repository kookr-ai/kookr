import type { TaskStore } from '../core/tasks.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import { getGitInfo } from '../adapters/git-info.js';

export interface ReconciliationResult {
  /** Sessions that are alive and monitoring can resume */
  resumed: string[];
  /** Sessions that were dead and marked completed */
  markedCompleted: string[];
  /**
   * Tasks auto-transitioned to completed because all sessions finished.
   *
   * Kept for backward-compat with callers like `lifecycle-timers.ts` that
   * branch on `tasksCompleted.length > 0`. After rfc-task-loss-prevention
   * this array is populated only by crash-recovery / backfill paths that
   * accept the completed interpretation; reconcile-driven dead-session
   * transitions now go to `tasksTerminated`. See D1.
   */
  tasksCompleted: string[];
  /**
   * Tasks auto-transitioned to 'terminated' because all their sessions are
   * dead. User must acknowledge (→ completed) or reopen before these are
   * sweepable. Populated by reconcile-driven transitions only.
   */
  tasksTerminated: string[];
  /** Backend sessions not found in tasks (orphans from a prior run) */
  orphans: string[];
}

/**
 * Reconcile persisted task state with live backend sessions.
 * Used both at startup and periodically while running.
 * - If task has session and backend confirms it alive: resume monitoring
 * - If task has session and backend says dead: mark session completed
 * - If all sessions for an inProgress/open task are done: transition the task
 *   to 'terminated' (user must acknowledge → completed, or reopen)
 * - If backend session exists but not in tasks: report orphan
 *
 * V8 (rfc-v8-tmux-removal.md) replaced the `TerminalManager` parameter with
 * `TerminalBackend`, dropped the tmux-specific mouse-option remediation
 * (dtach has no equivalent concept), and simplified to one live-session
 * source of truth — `backend.listSessions()`.
 *
 * See rfc-task-loss-prevention.md D1 for why reconcile no longer
 * auto-completes tasks.
 */
export async function reconcile(
  taskStore: TaskStore,
  backend: TerminalBackend,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    resumed: [],
    markedCompleted: [],
    tasksCompleted: [],
    tasksTerminated: [],
    orphans: [],
  };

  const liveSessions = new Set(await backend.listSessions());

  const accountedFor = new Set<string>();

  for (const task of taskStore.listTasks()) {
    for (const session of task.sessions) {
      if (session.lastStatus === 'completed' || session.lastStatus === 'aborted') {
        continue;
      }

      accountedFor.add(session.tmuxSession);

      if (liveSessions.has(session.tmuxSession)) {
        result.resumed.push(session.tmuxSession);
        if (!session.gitBranch && !session.gitIsDetached) {
          getGitInfo(session.cwd)
            .then((info) => {
              if (info) {
                taskStore.updateSessionGitInfo(task.id, session.tmuxSession, info);
              }
            })
            .catch(() => { /* graceful degradation */ });
        }
      } else {
        taskStore.updateSession(task.id, session.tmuxSession, {
          lastStatus: 'completed',
        });
        result.markedCompleted.push(session.tmuxSession);
      }
    }

    // Auto-transition task when all sessions are done. See
    // rfc-task-loss-prevention.md D1 for why this goes to 'terminated', not
    // 'completed'.
    //
    // Ralph loops are exempt: between iterations the prior session is dead
    // and the next has not yet been registered. The loop service drives the
    // gap; reconciliation must not racily mark the parent task 'terminated'
    // during that window. See docs/rfc/rfc-ralph-loop-batch-mode-findings.md
    // Phase 0.
    const ralphActive =
      task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
    if (
      !ralphActive &&
      (task.status === 'inProgress' || task.status === 'open') &&
      task.sessions.length > 0 &&
      task.sessions.every((s) => s.lastStatus === 'completed' || s.lastStatus === 'aborted')
    ) {
      if (task.status === 'open') {
        taskStore.startTask(task.id);
      }
      taskStore.terminateTask(task.id);
      result.tasksTerminated.push(task.id);
    }
  }

  for (const name of liveSessions) {
    if (!accountedFor.has(name)) {
      result.orphans.push(name);
    }
  }

  return result;
}
