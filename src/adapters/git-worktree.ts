import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { TaskStore, Task } from '../core/tasks.js';
import type { DeferredInteractionLogWriter, InteractionEvent } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import { classifyGitError, DEFAULT_GIT_MAX_BUFFER, DEFAULT_GIT_TIMEOUT_MS, gitExecEnv } from '../core/git-helpers.js';
import { resolveWorktreeMergeStatus } from '../core/worktree-merge-status.js';
import type {
  WorktreeCleanupBlocker,
  WorktreeCleanupEvidence,
  WorktreeCleanupVerdict,
  WorktreeDirtySummary,
} from '../shared/contracts/worktree-cleanup-verdict.js';
import { isProtectedWorktreePath } from './worktree-marker.js';
import { getWorktreeRemovalGuardReason, removeRegisteredWorktree, samePath } from './worktree-safety.js';

const execFile = promisify(execFileCb);

/** Run a git command and return trimmed stdout, or null on failure. */
async function git(...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', args, {
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      env: gitExecEnv(),
    });
    return stdout.trim();
  } catch (err) {
    const kind = classifyGitError(err);
    if (kind !== 'failed') {
      console.warn('[git-worktree] git subprocess guard tripped', {
        kind,
        args,
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      });
    }
    return null;
  }
}

/**
 * Count changed paths by category from `git status --porcelain` output.
 *
 * Each line is `XY PATH`, where X is the index status and Y the worktree
 * status. A path is counted once, under the most significant of its two
 * codes (rename > add > delete > modify), so `MM` and `AM` don't double-count.
 */
export function parsePorcelainStatus(output: string): WorktreeDirtySummary {
  const summary: WorktreeDirtySummary = {
    modified: 0,
    added: 0,
    deleted: 0,
    renamed: 0,
    untracked: 0,
  };
  for (const line of output.split('\n')) {
    if (line.trim().length === 0) continue;
    const codes = line.slice(0, 2);
    if (codes === '??') {
      summary.untracked++;
    } else if (codes.includes('R')) {
      summary.renamed++;
    } else if (codes.includes('A')) {
      summary.added++;
    } else if (codes.includes('D')) {
      summary.deleted++;
    } else {
      // M, C, T, U and any future code — all "changed in place".
      summary.modified++;
    }
  }
  return summary;
}

/**
 * Cleanliness half of the cascade: uncommitted changes, then unmerged commits.
 *
 * Both probes run before any verdict is returned, so the dialog can show the
 * full picture ("3 modified, and 2 commits ahead") rather than only the first
 * thing that tripped. Blocker precedence is unchanged from the original
 * early-return order, so the verdict itself is identical.
 *
 * Note `aheadCount` is display-only evidence measured against the remote-
 * tracking default branch when available. Removal safety comes from the
 * shared ancestor/patch-equivalence classification, so squash merges can be
 * removable even when their original commit SHAs remain ahead.
 */
async function inspectCleanliness(
  worktreePath: string,
  branch: string | undefined,
  isDetached: boolean | undefined,
): Promise<{ blocker?: WorktreeCleanupBlocker; evidence: WorktreeCleanupEvidence }> {
  const evidence: WorktreeCleanupEvidence = {};

  // Detached HEAD — can't verify merge status
  if (isDetached) return { blocker: 'detached-head', evidence };
  // No branch info — treat as dirty (conservative)
  if (!branch) return { blocker: 'no-branch', evidence };

  const status = await git('-C', worktreePath, 'status', '--porcelain');
  if (status !== null) {
    evidence.dirty = parsePorcelainStatus(status);
  }

  const mergeStatus = await resolveWorktreeMergeStatus(worktreePath, branch, {
    allowLocalFallback: true,
    includeAheadCount: true,
  });
  if (mergeStatus?.aheadCount !== undefined) evidence.aheadCount = mergeStatus.aheadCount;

  if (status === null) return { blocker: 'git-status-failed', evidence };
  if (status.length > 0) return { blocker: 'uncommitted-changes', evidence };
  // A missing baseline, failed merge probe, or failed ahead-count probe means
  // the dialog cannot prove removability. Keep the old fail-closed behavior.
  if (!mergeStatus || mergeStatus.mergeCheckFailed || mergeStatus.aheadCountCheckFailed) {
    return { blocker: 'unmerged-check-failed', evidence };
  }
  if (mergeStatus.classification === 'unique_commits') return { blocker: 'unmerged-commits', evidence };

  return { evidence };
}

/**
 * Decide whether a task's worktree can be removed, and why not.
 *
 * The single source of truth for that question. `cleanupSingleWorktree` calls
 * it to decide; the completion dialog calls it (over `worktree:inspectCleanup`)
 * to display. Because both read one verdict, the dialog cannot claim an
 * outcome the cleanup won't honor.
 *
 * The verdict is a snapshot — cleanup re-inspects at execution time, and
 * `removeRegisteredWorktree` re-validates worktree identity under a lock.
 */
export async function inspectWorktreeCleanup(
  taskStore: TaskStore,
  taskId: string,
  worktreePath: string,
): Promise<WorktreeCleanupVerdict> {
  const task = taskStore.getTask(taskId);
  const session = task ? getSessionForWorktree(task, worktreePath) : undefined;
  const branch = session?.gitBranch;
  const base = {
    worktreePath,
    worktreeName: basename(worktreePath),
    ...(branch !== undefined ? { branch } : {}),
    checkedAt: nowISO(),
  };
  const blocked = (blocker: WorktreeCleanupBlocker): WorktreeCleanupVerdict => ({
    ...base,
    removable: false,
    blocker,
    evidence: {},
  });

  if (!existsSync(worktreePath)) return blocked('not-found');

  // Identity/protection guards run before any content inspection — same order
  // as the cleanup, so a clean primary checkout can never be reported as
  // removable.
  const guardReason = await getWorktreeRemovalGuardReason(worktreePath, { branch });
  if (guardReason) return blocked(guardReason);
  if (isProtectedWorktreePath(worktreePath)) return blocked('protected-marker');
  if (isSharedWorktree(taskStore, taskId, worktreePath)) return blocked('shared-with-active-task');

  const { blocker, evidence } = await inspectCleanliness(worktreePath, branch, session?.gitIsDetached);
  return {
    ...base,
    removable: blocker === undefined,
    ...(blocker !== undefined ? { blocker } : {}),
    evidence,
  };
}

type WorktreeSkippedEvent = Extract<InteractionEvent, { type: 'worktree_skipped' }>;
type WorktreeKeptEvent = Extract<InteractionEvent, { type: 'worktree_kept' }>;

/**
 * The log records identity/protection blockers as `worktree_skipped` (closed
 * reason union) and cleanliness blockers as `worktree_kept` (free-form reason).
 * Returns null for the cleanliness blockers, which belong in the other event.
 */
function skippedReasonForBlocker(blocker: WorktreeCleanupBlocker): WorktreeSkippedEvent['reason'] | null {
  switch (blocker) {
    case 'not-found':
      return 'not found';
    case 'protected-marker':
      return 'protected';
    case 'shared-with-active-task':
      return 'shared';
    case 'primary-working-tree':
    case 'not-a-linked-worktree':
    case 'protected-branch':
    case 'repository-context-unavailable':
    case 'repository-context-mismatch':
      // Guard reasons were already logged verbatim.
      return blocker;
    default:
      return null;
  }
}

/** Free-form `worktree_kept` reason, preserving the pre-refactor wording. */
function keptReasonForBlocker(blocker: WorktreeCleanupBlocker): string {
  switch (blocker) {
    case 'detached-head':
      return 'detached HEAD';
    case 'no-branch':
      return 'no branch info';
    case 'uncommitted-changes':
      return 'uncommitted changes';
    case 'unmerged-commits':
      return 'unmerged commits';
    case 'git-status-failed':
      return 'git status failed';
    case 'unmerged-check-failed':
      return 'unmerged commits check failed';
    default:
      return blocker;
  }
}

/**
 * Build the interaction-log event for a blocked cleanup.
 *
 * Branch presence mirrors the pre-refactor calls exactly: guard reasons carried
 * it, `protected`/`shared`/`not found` did not.
 */
function blockedCleanupEvent(
  blocker: WorktreeCleanupBlocker,
  taskId: string,
  worktreePath: string,
  branch: string | undefined,
): WorktreeSkippedEvent | WorktreeKeptEvent {
  const timestamp = nowISO();
  const skippedReason = skippedReasonForBlocker(blocker);
  if (skippedReason !== null) {
    const carriesBranch = skippedReason !== 'not found'
      && skippedReason !== 'protected'
      && skippedReason !== 'shared';
    return {
      type: 'worktree_skipped',
      taskId,
      worktreePath,
      ...(carriesBranch && branch !== undefined ? { branch } : {}),
      reason: skippedReason,
      timestamp,
    };
  }
  return {
    type: 'worktree_kept',
    taskId,
    worktreePath,
    branch,
    reason: keptReasonForBlocker(blocker),
    timestamp,
  };
}

/** Run `git worktree prune` to clean up stale registry entries. */
async function pruneStaleEntries(repoPath: string): Promise<void> {
  await git('-C', repoPath, 'worktree', 'prune');
}

type CleanupAbortCheck = () => boolean;

/** Delete a safely classified local branch, preserving -d's guard when possible. */
async function deleteBranch(
  repoPath: string,
  branch: string,
  shouldAbort?: CleanupAbortCheck,
): Promise<boolean> {
  if (shouldAbort?.()) return false;

  const result = await git('-C', repoPath, 'branch', '-d', branch);
  if (result !== null) return true;

  if (shouldAbort?.()) return false;

  // A branch can be checked out by a worktree owned outside Kookr's task
  // registry. Never fall back to update-ref while Git still reports it as
  // occupied, and fail closed if the occupancy probe itself is unavailable.
  const worktrees = await git('-C', repoPath, 'worktree', 'list', '--porcelain');
  if (worktrees === null) return false;
  const branchRef = `branch refs/heads/${branch}`;
  if (worktrees.split(/\r?\n/).some((line) => line === branchRef)) return false;

  // `branch -d` only understands raw ancestry. Revalidate against the same
  // squash-aware classifier, then compare-and-delete the exact ref that was
  // classified. A concurrent ref replacement must make deletion fail rather
  // than turn the safe fallback into an unconditional force-delete.
  const expectedOid = await git('-C', repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`);
  if (!expectedOid) return false;

  const mergeStatus = await resolveWorktreeMergeStatus(repoPath, branch, {
    allowLocalFallback: true,
  });
  if (!mergeStatus || (mergeStatus.classification !== 'merged' && mergeStatus.classification !== 'patch_equivalent')) {
    return false;
  }

  if (shouldAbort?.()) return false;

  // Recheck both lifecycle state and Git worktree occupancy immediately
  // before the compare-and-delete mutation.
  const worktreesBeforeDelete = await git('-C', repoPath, 'worktree', 'list', '--porcelain');
  if (worktreesBeforeDelete === null || worktreesBeforeDelete.split(/\r?\n/).some((line) => line === branchRef)) {
    return false;
  }
  if (shouldAbort?.()) return false;

  return (await git('-C', repoPath, 'update-ref', '-d', `refs/heads/${branch}`, expectedOid)) !== null;
}

/** Collect all unique worktree paths from a task's sessions. */
function getWorktreePaths(task: Task): string[] {
  const paths = new Set<string>();
  for (const s of task.sessions) {
    if (s.gitIsWorktree && s.cwd) {
      paths.add(s.cwd);
    }
  }
  return [...paths];
}

/** Check if any other open/inProgress task uses this worktree path. */
function isSharedWorktree(taskStore: TaskStore, taskId: string, worktreePath: string): boolean {
  const activeTasks = [
    ...taskStore.listTasks({ status: 'open' }),
    ...taskStore.listTasks({ status: 'inProgress' }),
  ];
  for (const task of activeTasks) {
    if (task.id === taskId) continue;
    for (const s of task.sessions) {
      if (s.gitIsWorktree && s.cwd && samePath(s.cwd, worktreePath)) {
        return true;
      }
    }
  }
  return false;
}

/** Get session info for a worktree path from the task. */
function getSessionForWorktree(task: Task, worktreePath: string) {
  return task.sessions.find((s) => s.gitIsWorktree && s.cwd && samePath(s.cwd, worktreePath));
}

function markWorktreeCleanedUp(taskStore: TaskStore, taskId: string, task: Task, worktreePath: string): void {
  for (const session of task.sessions) {
    if (session.gitIsWorktree && session.cwd && samePath(session.cwd, worktreePath)) {
      taskStore.updateSessionWorktreeHealth(taskId, session.tmuxSession, 'cleaned_up');
    }
  }
}

/**
 * Inspect every worktree a task owns, without touching any of them.
 *
 * Enumerates paths through the same `getWorktreePaths` the cleanup uses, so
 * the dialog is answering for exactly the set that cleanup would act on —
 * a task with two worktrees gets two verdicts, not a guess about the first.
 */
export async function inspectTaskWorktrees(
  taskStore: TaskStore,
  taskId: string,
): Promise<WorktreeCleanupVerdict[]> {
  const task = taskStore.getTask(taskId);
  if (!task) return [];
  return Promise.all(
    getWorktreePaths(task).map((path) => inspectWorktreeCleanup(taskStore, taskId, path)),
  );
}

/**
 * Clean up worktrees for a completed/cancelled task.
 * Fires asynchronously — does NOT block the caller.
 * Checks task.status before each destructive step to abort if reopened.
 */
export async function cleanupTaskWorktrees(
  taskStore: TaskStore,
  taskId: string,
  interactionLog?: DeferredInteractionLogWriter,
): Promise<void> {
  const task = taskStore.getTask(taskId);
  if (!task) return;

  const paths = getWorktreePaths(task);
  if (paths.length === 0) return;

  for (const worktreePath of paths) {
    try {
      await cleanupSingleWorktree(taskStore, taskId, task, worktreePath, interactionLog);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await interactionLog?.append({
        type: 'worktree_cleanup_failed',
        taskId,
        worktreePath,
        error: message,
        timestamp: nowISO(),
      });
    }
  }
}

async function cleanupSingleWorktree(
  taskStore: TaskStore,
  taskId: string,
  task: Task,
  worktreePath: string,
  interactionLog?: DeferredInteractionLogWriter,
): Promise<void> {
  // The same inspection the completion dialog displays. Running the guard
  // cascade here — rather than re-implementing it — is what keeps the dialog's
  // claim and this outcome from drifting apart.
  const verdict = await inspectWorktreeCleanup(taskStore, taskId, worktreePath);

  // The path is already gone, so its owning repository can no longer be
  // established safely. Do not guess a repo for pruning.
  if (verdict.blocker === 'not-found') {
    markWorktreeCleanedUp(taskStore, taskId, task, worktreePath);
    await interactionLog?.append({
      type: 'worktree_skipped',
      taskId,
      worktreePath,
      reason: 'not found',
      timestamp: nowISO(),
    });
    return;
  }

  if (verdict.blocker !== undefined) {
    await interactionLog?.append(
      blockedCleanupEvent(verdict.blocker, taskId, worktreePath, verdict.branch),
    );
    return;
  }

  const session = getSessionForWorktree(task, worktreePath);
  const branch = verdict.branch;
  const isDetached = session?.gitIsDetached;

  // --- Destructive steps: check task status before each ---

  // Guard: abort if task was reopened
  if (taskStore.getTask(taskId)?.status === 'open') {
    await interactionLog?.append({
      type: 'worktree_skipped',
      taskId,
      worktreePath,
      reason: 'task reopened',
      timestamp: nowISO(),
    });
    return;
  }

  // Step 1: Remove the registered worktree through Git. `force` preserves the
  // existing automatic cleanup behavior for ignored build outputs, but it is
  // accepted only after the shared identity/protection guard and clean-tree
  // checks above pass.
  const removal = await removeRegisteredWorktree(worktreePath, {
    force: true,
    expectedHead: session?.gitCommit,
    expectedBranch: branch,
    expectedDetached: isDetached,
    expectedGitDir: session?.gitDir,
  });
  if (!removal.removed || !removal.target) {
    await interactionLog?.append({
      type: 'worktree_cleanup_failed',
      taskId,
      worktreePath,
      branch,
      error: removal.stderr ?? removal.reason ?? 'worktree removal failed',
      timestamp: nowISO(),
    });
    return;
  }

  const repoPath = removal.target.commonDir;
  const cleanedBranch = removal.target.branch;
  markWorktreeCleanedUp(taskStore, taskId, task, worktreePath);

  // Guard again before prune + branch delete
  if (taskStore.getTask(taskId)?.status === 'open') {
    await interactionLog?.append({
      type: 'worktree_skipped',
      taskId,
      worktreePath,
      reason: 'task reopened',
      timestamp: nowISO(),
    });
    return;
  }

  // Step 2: Prune git worktree registry
  await pruneStaleEntries(repoPath);

  // Step 3: Delete merged branch
  if (cleanedBranch) {
    const branchDeleted = await deleteBranch(
      repoPath,
      cleanedBranch,
      () => taskStore.getTask(taskId)?.status === 'open',
    );
    if (!branchDeleted) {
      await interactionLog?.append({
        type: 'worktree_cleanup_failed',
        taskId,
        worktreePath,
        branch: cleanedBranch,
        error: 'branch deletion failed after worktree removal',
        timestamp: nowISO(),
      });
      return;
    }
  }

  await interactionLog?.append({
    type: 'worktree_cleaned',
    taskId,
    worktreePath,
    branch: cleanedBranch,
    timestamp: nowISO(),
  });
}
