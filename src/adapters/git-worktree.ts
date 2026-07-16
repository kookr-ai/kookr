import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import type { TaskStore, Task } from '../core/tasks.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import { classifyGitError, DEFAULT_GIT_MAX_BUFFER, DEFAULT_GIT_TIMEOUT_MS, gitExecEnv } from '../core/git-helpers.js';
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

/** Resolve the default branch name (e.g. main, master) from origin/HEAD. */
async function getDefaultBranch(worktreePath: string): Promise<string> {
  const ref = await git('-C', worktreePath, 'symbolic-ref', 'refs/remotes/origin/HEAD');
  if (ref) {
    // "refs/remotes/origin/main" → "main"
    const parts = ref.split('/');
    return parts[parts.length - 1];
  }
  return 'main';
}

/**
 * Check whether a worktree is clean:
 * - No uncommitted changes (git status --porcelain)
 * - All commits merged to default branch (git log default..branch --oneline)
 *
 * Returns { clean: true } or { clean: false, reason: string }.
 */
async function isClean(
  worktreePath: string,
  branch: string | undefined,
  isDetached: boolean | undefined,
): Promise<{ clean: true } | { clean: false; reason: string }> {
  // Detached HEAD — can't verify merge status
  if (isDetached) {
    return { clean: false, reason: 'detached HEAD' };
  }

  // No branch info — treat as dirty (conservative)
  if (!branch) {
    return { clean: false, reason: 'no branch info' };
  }

  // Check for uncommitted changes
  const status = await git('-C', worktreePath, 'status', '--porcelain');
  if (status === null) {
    return { clean: false, reason: 'git status failed' };
  }
  if (status.length > 0) {
    return { clean: false, reason: 'uncommitted changes' };
  }

  // Check for unmerged commits
  const defaultBranch = await getDefaultBranch(worktreePath);
  const unmerged = await git('-C', worktreePath, 'log', `${defaultBranch}..${branch}`, '--oneline');
  if (unmerged === null) {
    // git log failed — branch might not exist locally, treat as dirty
    return { clean: false, reason: 'unmerged commits check failed' };
  }
  if (unmerged.length > 0) {
    return { clean: false, reason: 'unmerged commits' };
  }

  return { clean: true };
}

/** Run `git worktree prune` to clean up stale registry entries. */
async function pruneStaleEntries(repoPath: string): Promise<void> {
  await git('-C', repoPath, 'worktree', 'prune');
}

/** Delete a fully-merged local branch. Uses -d (safe delete — fails if not merged). */
async function deleteBranch(repoPath: string, branch: string): Promise<boolean> {
  const result = await git('-C', repoPath, 'branch', '-d', branch);
  return result !== null;
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
  // The path is already gone, so its owning repository can no longer be
  // established safely. Do not guess a repo for pruning.
  if (!existsSync(worktreePath)) {
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

  const session = getSessionForWorktree(task, worktreePath);
  const branch = session?.gitBranch;
  const isDetached = session?.gitIsDetached;

  // Always-on removal backstop. This must run before the marker, cleanliness,
  // or task-state checks so a clean, unmarked primary checkout can never reach
  // a recursive filesystem delete. Registry membership also prevents
  // arbitrary recorded paths from being treated as disposable worktrees.
  const guardReason = await getWorktreeRemovalGuardReason(worktreePath, { branch });
  if (guardReason) {
    await interactionLog?.append({
      type: 'worktree_skipped',
      taskId,
      worktreePath,
      branch,
      reason: guardReason,
      timestamp: nowISO(),
    });
    return;
  }

  // Protected worktree
  if (isProtectedWorktreePath(worktreePath)) {
    await interactionLog?.append({
      type: 'worktree_skipped',
      taskId,
      worktreePath,
      reason: 'protected',
      timestamp: nowISO(),
    });
    return;
  }

  // Shared with another active task
  if (isSharedWorktree(taskStore, taskId, worktreePath)) {
    await interactionLog?.append({
      type: 'worktree_skipped',
      taskId,
      worktreePath,
      reason: 'shared',
      timestamp: nowISO(),
    });
    return;
  }

  // Safety checks
  const result = await isClean(worktreePath, branch, isDetached);
  if (!result.clean) {
    await interactionLog?.append({
      type: 'worktree_kept',
      taskId,
      worktreePath,
      branch,
      reason: result.reason,
      timestamp: nowISO(),
    });
    return;
  }

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
    await deleteBranch(repoPath, cleanedBranch);
  }

  await interactionLog?.append({
    type: 'worktree_cleaned',
    taskId,
    worktreePath,
    branch: cleanedBranch,
    timestamp: nowISO(),
  });
}
