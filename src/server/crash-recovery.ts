import { access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskStore, SessionInfo, Task } from '../core/tasks.js';
import { AdapterRegistry, type ResumeContext } from '../adapters/agent-adapter.js';
import type { ReconciliationResult } from './reconciliation.js';
import { hashPrompt } from './hash-prompt.js';

export interface CrashRecoveryEntry {
  taskId: string;
  oldSessionId: string;
  newSessionId: string;
  /**
   * How the new session was launched.
   * - 'resumed': the new session was launched via `claude --resume <id> --fork-session`,
   *   continuing the prior conversation on a forked branch.
   * - 'fresh': the new session was launched from the original prompt (v2 behavior).
   */
  mode: 'resumed' | 'fresh';
  /**
   * When `mode === 'fresh'` AND a resume was considered but not used, the reason.
   * Empty when no resume was applicable (e.g., adapter doesn't support resume).
   */
  fallbackReason?: string;
}

export interface CrashRecoverySkip {
  taskId: string;
  sessionId: string;
  reason: string;
}

export interface CrashRecoveryFailure {
  taskId: string;
  sessionId: string;
  error: string;
}

export interface CrashRecoveryResult {
  relaunched: CrashRecoveryEntry[];
  skipped: CrashRecoverySkip[];
  failed: CrashRecoveryFailure[];
}

/** How recently a session must have been relaunched to be considered a rapid crash-loop (ms). */
const CRASH_LOOP_WINDOW_MS = 60_000;

/**
 * Attempt to relaunch sessions that died in a crash.
 *
 * Called once at startup, AFTER reconcile() has run and marked dead sessions
 * as completed (potentially auto-completing their tasks too).
 *
 * Uses the existing adapter.launch() path — no new launch method needed.
 * This ensures addSession(), tmuxToTaskId, settings files, and git info
 * are all handled correctly through the same code path as normal launches.
 *
 * Returns a structured result for logging and UI delivery.
 */
export async function recoverCrashedSessions(
  taskStore: TaskStore,
  adapterRegistry: AdapterRegistry,
  reconcileResult: ReconciliationResult,
): Promise<CrashRecoveryResult> {
  const result: CrashRecoveryResult = {
    relaunched: [],
    skipped: [],
    failed: [],
  };

  if (reconcileResult.markedCompleted.length === 0) {
    return result;
  }

  // === Dedup: identify tasks and prompts that already have live sessions ===
  // Sessions in reconcileResult.resumed are alive — their tasks don't need recovery.
  const tasksWithLiveSessions = new Set<string>();
  const livePromptHashes = new Set<string>();

  for (const tmuxName of reconcileResult.resumed) {
    const match = findTaskAndSession(taskStore, tmuxName);
    if (match) {
      tasksWithLiveSessions.add(match.task.id);
      livePromptHashes.add(promptDedupKey(match.task.agentType, match.task.prompt));
    }
  }

  // Track what we've already relaunched in THIS pass to prevent intra-pass duplicates
  // (e.g., same task has multiple dead sessions from previous crash cycles).
  const relaunchedTaskIds = new Set<string>();
  const relaunchedPromptHashes = new Set<string>();

  // Build a lookup of which sessions were just marked completed by reconcile.
  // These are the candidates for crash recovery.
  for (const tmuxName of reconcileResult.markedCompleted) {
    const match = findTaskAndSession(taskStore, tmuxName);
    if (!match) continue;
    const { task, session } = match;

    // Guard: task already has a live session (resumed by reconcile)
    if (tasksWithLiveSessions.has(task.id)) {
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: 'task already has a running session',
      });
      continue;
    }

    // Guard: task already relaunched in this recovery pass
    if (relaunchedTaskIds.has(task.id)) {
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: 'task already relaunched in this recovery pass',
      });
      continue;
    }

    // Guard: another task with an identical prompt is already running or was just relaunched
    const promptHash = promptDedupKey(task.agentType, task.prompt);
    if (livePromptHashes.has(promptHash) || relaunchedPromptHashes.has(promptHash)) {
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: 'duplicate prompt already running or relaunched',
      });
      continue;
    }

    // Guard: rapid crash-loop detection.
    // If this session was recently relaunched (within 60s), skip it.
    // This prevents infinite loops when Kookr itself crashes on startup.
    // A time-based guard (not a boolean) allows recovery across multiple
    // daily crashes — only rapid succession is blocked.
    if (
      session.relaunchCount != null &&
      session.relaunchCount > 0 &&
      session.lastRelaunchedAt != null
    ) {
      const elapsed = Date.now() - session.lastRelaunchedAt;
      if (elapsed < CRASH_LOOP_WINDOW_MS) {
        result.skipped.push({
          taskId: task.id,
          sessionId: tmuxName,
          reason: `rapid crash-loop (relaunched ${Math.round(elapsed / 1000)}s ago, window is ${CRASH_LOOP_WINDOW_MS / 1000}s)`,
        });
        continue;
      }
    }

    // Guard: CWD must exist (worktree may have been cleaned up)
    const cwdExists = await directoryExists(session.cwd);
    if (!cwdExists) {
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: `CWD does not exist: ${session.cwd}`,
      });
      continue;
    }

    // Clean up stale .git/index.lock if present (left by agents mid-git-operation at crash time)
    await removeStaleGitLock(session.cwd);

    // Reopen the task if reconcile auto-transitioned it. 'terminated' is the
    // new default after rfc-task-loss-prevention; 'completed' is kept for
    // backward-compat with any existing tasks already in that state.
    if (task.status === 'completed' || task.status === 'terminated') {
      taskStore.reopenTask(task.id);
    }

    // Mark the old session as crash-recovered
    taskStore.updateSession(task.id, tmuxName, {
      crashRecovered: true,
    });

    // Decide whether to resume or fresh-launch. Resume is preferred when the
    // dead session has a persisted claudeSessionId — that means the agent
    // emitted SessionStart before the crash, so the conversation is resumable.
    // See docs/rfc/rfc-crash-recovery-resume.md.
    const { resumeContext, fallbackReason } = await buildResumeContext(task, session);

    // Launch a new session using the EXISTING launch path.
    // adapter.launch() handles: sessionId creation, addSession(), sessionToTaskId,
    // settings file generation, and git info capture. When `resumeContext`
    // is provided AND the adapter supports resume (Claude Code), the launch
    // continues the prior conversation on a forked branch.
    try {
      const adapter = adapterRegistry.get(task.agentType);
      const newSessionId = await adapter.launch(task.id, task.prompt, session.cwd, resumeContext);

      // Transfer relaunch metadata to the new session. Mark resumedFromCrash
      // only when we actually requested resume; the adapter may have ignored
      // it (e.g., Codex always launches fresh today), so the flag is only set
      // when our intent was resume.
      const updates: Partial<SessionInfo> = {
        relaunchCount: (session.relaunchCount ?? 0) + 1,
        lastRelaunchedAt: Date.now(),
      };
      const adapterSupportsResume = task.agentType === 'claude-code';
      const actuallyResumed = !!resumeContext && adapterSupportsResume;
      if (actuallyResumed) {
        updates.resumedFromCrash = true;
      }
      taskStore.updateSession(task.id, newSessionId, updates);

      relaunchedTaskIds.add(task.id);
      relaunchedPromptHashes.add(promptHash);

      const entry: CrashRecoveryEntry = {
        taskId: task.id,
        oldSessionId: tmuxName,
        newSessionId,
        mode: actuallyResumed ? 'resumed' : 'fresh',
      };
      if (entry.mode === 'fresh') {
        entry.fallbackReason = resumeContext
          ? 'agent type does not support resume'
          : fallbackReason;
      }
      result.relaunched.push(entry);
    } catch (err) {
      result.failed.push({
        taskId: task.id,
        sessionId: tmuxName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Decide whether the given dead session is resumable, and if so build a
 * ResumeContext to hand to `adapter.launch()`. Returns `undefined` context
 * with a `fallbackReason` when resume is not applicable, so the caller can
 * surface the reason on the recovery entry.
 *
 * Performs the transcript-existence pre-flight here (rather than only in the
 * adapter) so the recovery entry's `mode` and `fallbackReason` reflect what
 * actually launched. The adapter does its own pre-flight too as defense in
 * depth.
 */
async function buildResumeContext(
  _task: Task,
  session: SessionInfo,
): Promise<{ resumeContext: ResumeContext | undefined; fallbackReason: string | undefined }> {
  if (!session.claudeSessionId) {
    return { resumeContext: undefined, fallbackReason: 'no claudeSessionId persisted' };
  }
  if (session.transcriptPath && !(await fileExists(session.transcriptPath))) {
    return { resumeContext: undefined, fallbackReason: 'transcript file missing' };
  }
  return {
    resumeContext: {
      sessionId: session.claudeSessionId,
      transcriptPath: session.transcriptPath,
    },
    fallbackReason: undefined,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function promptDedupKey(agentType: string, prompt: string): string {
  return `${agentType}:${hashPrompt(prompt)}`;
}

function findTaskAndSession(
  taskStore: TaskStore,
  tmuxName: string,
): { task: Task; session: SessionInfo } | null {
  const task = taskStore.findTaskBySession(tmuxName);
  if (!task) return null;
  const session = task.sessions.find((s) => s.tmuxSession === tmuxName);
  return session ? { task, session } : null;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function removeStaleGitLock(cwd: string): Promise<void> {
  const lockFile = join(cwd, '.git', 'index.lock');
  try {
    await access(lockFile);
    await unlink(lockFile);
    console.log(`[crash-recovery] Removed stale ${lockFile}`);
  } catch {
    // No lock file or not a git repo — fine
  }
}
