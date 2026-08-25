import { access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskStore, SessionInfo, Task } from '../core/tasks.js';
import { isRecoverableTermination } from '../core/task-status.js';
import { AdapterRegistry, type AdapterLaunchOptions, type ResumeContext } from '../adapters/agent-adapter.js';
import type { ReconciliationResult } from './reconciliation.js';
import { hashPrompt } from './hash-prompt.js';
import {
  launchIntentFingerprint,
  validatePersistedLaunchIntent,
} from '../core/task-launch-intent.js';
import { defaultVerdictPath } from '../core/ralph-iteration-verdict.js';
import type { DependencyPreflightRunner } from '../core/launch-dependency-preflight.js';
import { runLaunchDependencyPreflights } from './launch-dependency-runner.js';
import {
  type LaunchDependencyAdmission,
  type LaunchDependencyAdmissionDecision,
} from '../core/launch-dependency-admission.js';
import type { TaskLaunchAdmission } from '../shared/contracts/task.js';

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

export interface CrashRecoveryOptions {
  /** Shared provider circuit used to gate automatic recovery launches. */
  launchDependencyAdmission?: LaunchDependencyAdmission;
  /** Injectable health runner for recovery tests and bounded provider probes. */
  dependencyPreflightRunner?: DependencyPreflightRunner;
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
  options: CrashRecoveryOptions = {},
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
      livePromptHashes.add(promptDedupKey(match.task.agentType, match.task.prompt, match.task.launchIntent));
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

    // Guard: the task was terminated for a deliberate, non-recoverable reason
    // (an operator kill or a supervisor sweep). Auto-resuming those would undo
    // an intentional stop; only restart/oom/timeout/unknown terminations are
    // resumable. Terminations recorded before #1664 have no reason and are
    // treated as `unknown` (recoverable), preserving prior behavior.
    if (task.status === 'terminated' && !isRecoverableTermination(task.terminationReason)) {
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: `non-recoverable termination (${task.terminationReason})`,
      });
      continue;
    }

    // Guard: a spawned task whose agent finished its turn cleanly is done, not
    // crashed. Such a task ended on `completed_turn` (a normal Stop, nothing
    // pending) and reconcile auto-completed it (#693); relaunching here would
    // re-run finished work and re-spawn its successor — exactly the
    // self-continuation churn this fix retires. Scoped to spawned tasks
    // (`parentTaskId` set): human-launched interactive tasks have no parent and
    // are untouched, so idle-interactive crash recovery is unaffected.
    if (task.parentTaskId !== undefined && session.lastTurnState === 'completed_turn') {
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: 'spawned task finished its turn cleanly; nothing to recover',
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

    const intent = validatePersistedLaunchIntent(task);
    if (!intent.ok) {
      taskStore.setRelaunchDisposition(task.id, {
        outcome: 'not_relaunched',
        source: 'crash-recovery',
        reason: intent.reason,
        at: new Date().toISOString(),
        detail: intent.detail,
      });
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: intent.detail,
      });
      continue;
    }

    // Guard: another task with an identical prompt is already running or was just relaunched
    const promptHash = promptDedupKey(task.agentType, task.prompt, task.launchIntent);
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

    const dependencyAdmission = await evaluateRecoveryDependencyAdmission(task, options);
    if (dependencyAdmission && !dependencyAdmission.admit) {
      taskStore.setLaunchAdmission(task.id, toTaskLaunchAdmission(dependencyAdmission));
      taskStore.pendTask(task.id);
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: `launch dependency admission parked: ${dependencyAdmission.reason}`,
      });
      continue;
    }
    if (dependencyAdmission && task.launchAdmission) {
      taskStore.setLaunchAdmission(task.id, undefined);
      if (task.launchAdmission.status === 'parked') {
        taskStore.setLaunchHealthSummary(task.id, undefined);
      }
    }

    // Launch a new session using the EXISTING launch path.
    // adapter.launch() handles: sessionId creation, addSession(), sessionToTaskId,
    // settings file generation, and git info capture. When `resumeContext`
    // is provided AND the adapter supports resume (Claude Code), the launch
    // continues the prior conversation on a forked branch.
    try {
      const adapter = adapterRegistry.get(task.agentType);
      const launchOptions = buildRecoveryLaunchOptions(task, intent.intent);
      const newSessionId = Object.keys(launchOptions).length > 0
        ? await adapter.launch(task.id, task.prompt, session.cwd, resumeContext, launchOptions)
        : await adapter.launch(task.id, task.prompt, session.cwd, resumeContext);
      if (dependencyAdmission?.admit) {
        options.launchDependencyAdmission?.completeProbe(dependencyAdmission.probe, true);
      }

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
      if (dependencyAdmission?.admit) {
        options.launchDependencyAdmission?.completeProbe(dependencyAdmission.probe, false);
      }
      result.failed.push({
        taskId: task.id,
        sessionId: tmuxName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

async function evaluateRecoveryDependencyAdmission(
  task: Task,
  options: CrashRecoveryOptions,
): Promise<LaunchDependencyAdmissionDecision | undefined> {
  const admission = options.launchDependencyAdmission;
  const dependencies = task.launchIntent?.dependencies;
  if (!admission || !dependencies || dependencies.length === 0) return undefined;

  let findings: Array<{ dependency: string; category: string; summary?: string }>;
  try {
    findings = await (options.dependencyPreflightRunner ?? runLaunchDependencyPreflights)(dependencies);
  } catch (err) {
    // Recovery must remain fail-open when health collection itself is broken.
    console.warn(
      `[crash-recovery] dependency preflight could not complete for task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
    findings = dependencies.map((dependency) => ({
      dependency,
      category: 'unknown',
      summary: 'Dependency health collection did not complete',
    }));
  }
  admission.observe(dependencies, findings);
  return admission.evaluate(dependencies);
}

function toTaskLaunchAdmission(
  decision: Extract<LaunchDependencyAdmissionDecision, { admit: false }>,
): TaskLaunchAdmission {
  return {
    status: 'parked',
    reason: decision.reason,
    dependencies: decision.dependencies.map((dependency) => ({ ...dependency })),
    parkedAt: new Date().toISOString(),
  };
}

function buildRecoveryLaunchOptions(task: Task, validatedIntent: Task['launchIntent']): AdapterLaunchOptions {
  const intent = validatedIntent;
  const originalIntent = task.launchIntent;
  return {
    ...(intent?.effort !== undefined ? { effort: intent.effort } : {}),
    ...(intent?.model !== undefined ? { model: intent.model } : {}),
    ...(originalIntent?.ralphVerdictEnv
      ? {
          extraEnv: {
            RALPH_VERDICT_FILE: defaultVerdictPath(task.cwd, task.id),
            RALPH_ITERATION: '0',
          },
        }
      : {}),
  };
}

/**
 * Decide whether the given dead session is resumable, and if so build a
 * ResumeContext to hand to `adapter.launch()`. Returns `undefined` context
 * with a `fallbackReason` when resume is not applicable, so the caller can
 * surface the reason on the recovery entry.
 *
 * Performs a best-effort transcript-existence pre-flight here. A stale
 * transcript path must not force a fresh launch when the provider session id is
 * still known: Claude Code can validate the id itself, and preserving the
 * conversation is more important than trusting Kookr's cached path.
 */
async function buildResumeContext(
  _task: Task,
  session: SessionInfo,
): Promise<{ resumeContext: ResumeContext | undefined; fallbackReason: string | undefined }> {
  if (!session.claudeSessionId) {
    return { resumeContext: undefined, fallbackReason: 'no claudeSessionId persisted' };
  }
  if (session.transcriptPath && !(await fileExists(session.transcriptPath))) {
    return {
      resumeContext: { sessionId: session.claudeSessionId },
      fallbackReason: undefined,
    };
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

function promptDedupKey(agentType: string, prompt: string, intent: Task['launchIntent']): string {
  return `${agentType}:${hashPrompt(prompt)}:${launchIntentFingerprint(intent) ?? 'legacy'}`;
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
