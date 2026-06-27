import { stat } from 'node:fs/promises';
import type { Task, TaskStore } from '../core/tasks.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import { getGitInfo } from '../adapters/git-info.js';
import type { WorktreeRegistry } from '../adapters/git-worktree-registry.js';

/**
 * Default on-disk existence probe for {@link reconcile}'s `pathExists`
 * dependency. Any stat failure (ENOENT, EACCES, ...) is treated as "not
 * verifiably present" — callers only use this to corroborate a registry miss,
 * so the conservative answer for an unreadable path is `false`.
 */
async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface ReconciliationResult {
  /** Sessions that are alive and monitoring can resume */
  resumed: string[];
  /** Sessions that were dead and marked completed */
  markedCompleted: string[];
  /**
   * Tasks auto-transitioned to `completed` because all sessions finished.
   *
   * After rfc-task-loss-prevention (D1), a dead-session task is auto-completed
   * here ONLY when there is positive evidence the agent finished gracefully —
   * its most recent session's last turn state was `completed_turn` (a normal
   * Stop with nothing pending). This closes the self-continuation gap (#693): a
   * task whose final act is to spawn a successor and end its turn reaches a
   * terminal status without manual cleanup. Dead-session tasks WITHOUT that
   * clean-finish signal (a crash mid-turn) still go to `tasksTerminated` so the
   * user must acknowledge — preserving D1.
   *
   * `lifecycle-timers.ts` branches on `tasksCompleted.length > 0` to promote
   * pending tasks and broadcast, same as for `tasksTerminated`.
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
  /**
   * Sessions whose cwd no longer appears in the git worktree registry AND is
   * verifiably gone from disk. A registry miss alone is not enough — the
   * snapshot can hiccup or simply not cover the session's repo (F14).
   */
  worktreesMissing: string[];
  /** Sessions whose worktree registry entry is prunable/stale */
  worktreesStale: string[];
  /** Sessions whose git/worktree metadata changed */
  worktreesChanged: string[];
}

/**
 * Reconcile persisted task state with live backend sessions.
 * Used both at startup and periodically while running.
 * - If task has session and backend confirms it alive: resume monitoring
 * - If task has session and backend says dead: mark session completed
 * - If all sessions for an inProgress/open task are done: transition the task
 *   to 'completed' when its most recent session ended on a clean `completed_turn`
 *   (a graceful finish — see #693), otherwise to 'terminated' (a likely crash;
 *   user must acknowledge → completed, or reopen)
 * - If backend session exists but not in tasks: report orphan
 *
 * V8 (rfc-v8-tmux-removal.md) replaced the `TerminalManager` parameter with
 * `TerminalBackend`, dropped the tmux-specific mouse-option remediation
 * (dtach has no equivalent concept), and simplified to one live-session
 * source of truth — `backend.listSessions()`.
 *
 * See rfc-task-loss-prevention.md D1 for why a crashed (mid-turn) dead-session
 * task goes to `terminated` rather than `completed`. Issue #693 narrows that: a
 * dead-session task whose agent finished a clean turn (`completed_turn`) is a
 * graceful completion, not a crash, so it is auto-completed directly.
 */
export async function reconcile(
  taskStore: TaskStore,
  backend: TerminalBackend,
  worktreeRegistry?: Pick<WorktreeRegistry, 'byPath' | 'snapshot'>,
  pathExists: (path: string) => Promise<boolean> = defaultPathExists,
): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    resumed: [],
    markedCompleted: [],
    tasksCompleted: [],
    tasksTerminated: [],
    orphans: [],
    worktreesMissing: [],
    worktreesStale: [],
    worktreesChanged: [],
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
        const registryEntry = worktreeRegistry?.byPath(session.cwd);
        const registrySnapshot = worktreeRegistry?.snapshot();
        const shouldTrackWorktreeHealth = session.gitIsWorktree === true || Boolean(registryEntry);
        if (!shouldTrackWorktreeHealth && session.worktreeHealth) {
          taskStore.updateSession(task.id, session.tmuxSession, {
            worktreeHealth: undefined,
            worktreeHealthObservedAt: undefined,
            worktreeRegistryStale: undefined,
          });
          result.worktreesChanged.push(session.tmuxSession);
        } else if (shouldTrackWorktreeHealth && registrySnapshot?.lastError) {
          taskStore.updateSessionWorktreeHealth(task.id, session.tmuxSession, 'stale', { registryStale: true });
          result.worktreesStale.push(session.tmuxSession);
        } else if (shouldTrackWorktreeHealth && worktreeRegistry && registrySnapshot?.refreshedAt && !registryEntry) {
          // The registry snapshot (built from `git worktree list --porcelain`)
          // is not authoritative on its own: a transient refresh hiccup, or a
          // session cwd living outside the refreshed repos, both produce a
          // registry miss for a perfectly healthy worktree. Corroborate with
          // the filesystem before raising the alarm (F14).
          if (await pathExists(session.cwd)) {
            // Directory is intact — the registry miss is a blind spot, not a
            // deleted worktree. Mark 'ok' rather than leaving health
            // unchanged so a previously persisted false 'missing_unexpectedly'
            // self-heals on the next reconcile sweep. (The health union in
            // core/session-read-model.ts has no softer "registry doesn't know
            // this path" state, and 'stale' is reserved for prunable entries /
            // failed refreshes.)
            taskStore.updateSessionWorktreeHealth(task.id, session.tmuxSession, 'ok');
          } else {
            taskStore.updateSessionWorktreeHealth(task.id, session.tmuxSession, 'missing_unexpectedly');
            result.worktreesMissing.push(session.tmuxSession);
          }
        } else if (shouldTrackWorktreeHealth && registryEntry?.isPrunable) {
          taskStore.updateSessionWorktreeHealth(task.id, session.tmuxSession, 'stale');
          result.worktreesStale.push(session.tmuxSession);
        } else if (shouldTrackWorktreeHealth && registryEntry) {
          taskStore.updateSessionWorktreeHealth(task.id, session.tmuxSession, 'ok');
        }

        if ((!session.gitBranch && !session.gitIsDetached) || registryEntry) {
          try {
            const info = await getGitInfo(session.cwd, worktreeRegistry);
            if (info) {
              const changed =
                session.gitBranch !== (info.branch ?? undefined)
                || session.gitCommit !== (info.commit ?? undefined)
                || session.gitIsWorktree !== (info.isWorktree || undefined)
                || session.gitIsDetached !== (info.isDetached || undefined);
              taskStore.updateSessionGitInfo(task.id, session.tmuxSession, info);
              if (changed) result.worktreesChanged.push(session.tmuxSession);
            }
          } catch {
            // graceful degradation
          }
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
    const latestTask = taskStore.getTask(task.id) ?? task;
    const ralphActive =
      latestTask.ralphLoop?.status === 'running' || latestTask.ralphLoop?.status === 'paused';
    if (
      !ralphActive &&
      (latestTask.status === 'inProgress' || latestTask.status === 'open') &&
      latestTask.sessions.length > 0 &&
      latestTask.sessions.every((s) => s.lastStatus === 'completed' || s.lastStatus === 'aborted')
    ) {
      if (latestTask.status === 'open') {
        taskStore.startTask(latestTask.id);
      }
      // Clean finish → complete directly; likely crash → terminate for ack.
      // See `endedOnCleanTurn` for the distinction (#693).
      if (endedOnCleanTurn(latestTask)) {
        taskStore.completeTask(latestTask.id);
        result.tasksCompleted.push(latestTask.id);
      } else {
        taskStore.terminateTask(latestTask.id);
        result.tasksTerminated.push(latestTask.id);
      }
    }
  }

  for (const name of liveSessions) {
    if (!accountedFor.has(name)) {
      result.orphans.push(name);
    }
  }

  return result;
}

/**
 * A dead-session task ended on a clean turn boundary when its most recent
 * session reported `completed_turn` as its last turn state — the agent emitted
 * a normal Stop and was idle with nothing pending before the session went away.
 *
 * This is the positive "graceful finish" signal reconcile lacked when
 * rfc-task-loss-prevention D1 forced every dead-session task to `terminated`.
 * With it, a spawned task that finishes its turn — even one whose final act is
 * to hand off to a successor — is auto-completed safely, while a session that
 * died mid-turn (no `completed_turn` recorded) is still treated as a crash and
 * routed to `terminated` for user acknowledgement. The most recent session is
 * authoritative so a crash-recovery relaunch chain is judged by its newest leg.
 * See #693.
 */
function endedOnCleanTurn(task: Task): boolean {
  const sessions = task.sessions;
  if (sessions.length === 0) return false;
  return sessions[sessions.length - 1].lastTurnState === 'completed_turn';
}
