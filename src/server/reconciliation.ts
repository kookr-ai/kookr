import { stat } from 'node:fs/promises';
import type { Task, TaskStore } from '../core/tasks.js';
import { appendDispositionEntry } from '../core/disposition-ledger.js';
import { deterministicTaskName } from '../core/task-naming.js';
import { displayPromptForTask } from '../core/prompt-display.js';
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
                || session.gitDir !== info.gitDir
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
    const allSessionsDone = latestTask.sessions.length > 0
      && latestTask.sessions.every((s) => s.lastStatus === 'completed' || s.lastStatus === 'aborted');

    // A durable probe marker means this was an admission attempt, not an
    // ordinary worker that should become terminal. If its session died with
    // the server, preserve the same launch intent for another bounded probe.
    // This conversion happens before terminal transitions, whose invariant is
    // that every admission marker is cleared.
    if (
      latestTask.launchAdmission?.status === 'probing'
      && (latestTask.status === 'inProgress' || latestTask.status === 'open')
      && allSessionsDone
    ) {
      const probing = latestTask.launchAdmission;
      if (latestTask.status === 'inProgress') taskStore.reopenTask(latestTask.id);
      if (taskStore.getTask(latestTask.id)?.status === 'open') taskStore.pendTask(latestTask.id);
      taskStore.setLaunchAdmission(latestTask.id, {
        status: 'parked',
        reason: 'dependency_degraded',
        dependencies: probing.dependencies.map((dependency) => ({
          ...dependency,
          state: 'degraded',
          reason: 'Recovery probe was interrupted by server restart',
        })),
        parkedAt: new Date().toISOString(),
      });
      continue;
    }
    if (
      !ralphActive &&
      (latestTask.status === 'inProgress' || latestTask.status === 'open') &&
      allSessionsDone
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
        // No clean-finish evidence: a likely crash whose precise cause (OOM,
        // restart, killed) reconcile cannot distinguish per-task. Record
        // `unknown` — recoverable, so crash-recovery may relaunch it (#1664).
        taskStore.terminateTask(latestTask.id, {
          reason: 'unknown',
          detail: 'all sessions died without a clean turn',
        });
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
 * BOOT-ONLY sweep for launches that died with the previous process (issue
 * #1526 Phase C / #1528). A task in `open` status with ZERO sessions exists
 * only while a launch is in flight (`launchTaskCore` creates it, then awaits
 * `adapter.launch`, which attaches the first session). A launch cannot
 * survive a process restart — `beginLaunch` reservations are deliberately
 * in-memory only — so at boot every open/zero-session task without a fresh
 * reservation is stale by construction: its launcher is gone, no session will
 * ever attach, and `reconcile()`'s dead-session logic never touches it
 * (that path requires `sessions.length > 0`).
 *
 * Disposition follows reconcile's existing crash convention: no session ever
 * attached, so there is no positive completed_turn evidence — the task goes
 * `open → inProgress → terminated` (user must acknowledge or reopen), the
 * same terminal status a mid-turn crash gets, and it records a queryable
 * `stale_open_launch` {@link Task.disposition} (issue #1588). Deleting the
 * record instead would silently erase the evidence that a scheduled fire died
 * — the same no-silent-loss rule the in-process launch-failure cleanup now
 * follows (it disposes rather than deletes).
 *
 * What distinguishes a legitimately mid-flight launch: a FRESH
 * `beginLaunch` reservation (`taskStore.hasFreshLaunchReservation`). At boot
 * the reservation map is empty, so nothing is protected — correct, because
 * no launch survives the restart. The guard is what makes this function safe
 * against misuse from a periodic path, and it is the tested discriminator.
 *
 * Returns the terminated task ids; the caller merges them into
 * `ReconciliationResult.tasksTerminated` so downstream boot handling (issue
 * claim release, onTaskOutcome, logging) treats them like any other
 * boot-terminated task.
 */
export function reconcileStaleOpenLaunches(
  taskStore: TaskStore,
  dispositionLedgerPath?: string,
): string[] {
  const terminated: string[] = [];
  for (const task of taskStore.listTasks()) {
    if (task.status !== 'open') continue;
    if (task.sessions.length > 0) continue;
    if (taskStore.hasFreshLaunchReservation(task.id)) continue;
    try {
      if (task.launchAdmission?.status === 'probing') {
        taskStore.setLaunchAdmission(task.id, {
          status: 'parked',
          reason: 'dependency_degraded',
          dependencies: task.launchAdmission.dependencies.map((dependency) => ({
            ...dependency,
            state: 'degraded',
            reason: 'Recovery probe was interrupted by server restart',
          })),
          parkedAt: new Date().toISOString(),
        });
        taskStore.pendTask(task.id);
        console.warn(
          `[startup-reconcile] re-parked interrupted dependency probe for task ${task.id}`,
        );
        continue;
      }
      // Belt-and-braces backstop (issue #1554): tasks created after the
      // creation-time naming change already carry a name, but a legacy task
      // persisted before it may still be nameless here. Give it the
      // deterministic fallback before terminating so no task ever reaches a
      // terminal state with `name=null`.
      if (!task.name) {
        taskStore.renameTask(task.id, deterministicTaskName(displayPromptForTask(task), task.cwd));
      }
      // Never silently terminate a persisted task (issue #1588): record a
      // queryable disposition first so the terminal record explains WHY it
      // died (its launcher process is gone), and so a retried POST with the
      // same idempotency key can replay it. First-write-wins, so a task that
      // was already disposed in-process keeps its original reason.
      taskStore.setDisposition(task.id, {
        reason: 'stale_open_launch',
        at: new Date().toISOString(),
        source: 'startup-reconcile',
        detail: 'open task with zero sessions at boot — its launcher died with the previous process',
      });
      // open → inProgress → terminated: the status machine has no direct
      // open→terminated edge; reconcile()'s dead-session path uses the same
      // two-step transition.
      taskStore.startTask(task.id);
      // Its launcher died with the previous process — a restart cohort (#1664).
      taskStore.terminateTask(task.id, {
        reason: 'server-restart',
        detail: 'launcher died with the previous process (boot sweep)',
      });
      terminated.push(task.id);
      console.warn(
        `[startup-reconcile] terminated stale launch task ${task.id} ` +
        '(open with zero sessions — its launcher died with the previous process)',
      );
      // Work-conservation ledger entry (issue #1540): zero sessions ever
      // attached, so no work was produced to lose — 'obsolete' is accurate,
      // not a euphemism. Fire-and-forget (mirrors the worktree-cleanup
      // pattern in agent-lifecycle.ts): this sweep's own `try` already
      // guards `terminated.push`, and a ledger-write hiccup must not stop
      // the loop from disposing the next stale task. Logged loudly on
      // failure so it's never silent.
      if (dispositionLedgerPath) {
        appendDispositionEntry(dispositionLedgerPath, {
          schemaVersion: 'disposition-ledger.v1',
          taskId: task.id,
          disposition: 'obsolete',
          detail: 'obsolete-because: launcher died before any session attached — no work was ever produced',
          incidentId: `stale-open-launch-${new Date().toISOString().slice(0, 10)}`,
          source: 'startup-reconcile',
          at: new Date().toISOString(),
        }).catch((err) => {
          console.error(`[disposition-ledger] failed to record entry for task ${task.id}:`, err);
        });
      }
    } catch (err) {
      console.error(
        `[startup-reconcile] failed to terminate stale launch task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return terminated;
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
