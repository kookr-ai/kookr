import { access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskStore, SessionInfo, Task } from '../core/tasks.js';
import { isRecoverableTermination, isTerminalStatus } from '../core/task-status.js';
import {
  AdapterRegistry,
  type AdapterLaunchOptions,
  type AgentAdapter,
  type ResumeContext,
} from '../adapters/agent-adapter.js';
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
import {
  isSameTaskLaunchAdmission,
  taskOwnsLiveProbeSession,
  taskAdmissionForDeniedDecision,
  taskAdmissionForFailedProbe,
  taskAdmissionForProbe,
  taskAdmissionForProbeCapacityWait,
} from '../core/launch-dependency-task-admission.js';
import {
  DEFAULT_LAUNCH_TIMEOUT_MS,
  allocateLaunchSessionId,
  isLaunchTimeoutError,
  noteLaunchSession,
  reapLaunchSession,
  raceLaunchAgainstTimeout,
  type LaunchReapGuard,
} from './launch-timeout.js';

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
  /** Live adapter-launch timeout used by startup recovery. */
  getLaunchTimeoutMs?: () => number;
  /** Force durable task state at crash-sensitive pre-launch boundaries. */
  flushTasks?: () => Promise<void>;
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
      const liveIntent = validatePersistedLaunchIntent(match.task);
      livePromptHashes.add(promptDedupKey(
        match.task.agentType,
        liveIntent.ok ? liveIntent.intent.prompt ?? match.task.prompt : match.task.prompt,
        liveIntent.ok ? liveIntent.intent : match.task.launchIntent,
      ));
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
    const identityPrompt = intent.intent.prompt ?? task.userPrompt ?? task.prompt;
    // Task.prompt already contains the worktree/delivery-policy guardrails
    // applied at initial admission. The raw intent prompt remains the stable
    // dedup identity, but must not replace the guarded prompt on relaunch.
    const effectivePrompt = task.prompt;
    const originalCwd = intent.intent.cwd ?? session.cwd;
    const promptHash = promptDedupKey(task.agentType, identityPrompt, intent.intent);
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
    const cwdExists = await directoryExists(originalCwd);
    if (!cwdExists) {
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: `CWD does not exist: ${originalCwd}`,
      });
      continue;
    }

    // Clean up stale .git/index.lock if present (left by agents mid-git-operation at crash time)
    await removeStaleGitLock(originalCwd);

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

    const dependencyAdmission = await evaluateRecoveryDependencyAdmission(intent.intent, options);
    // Dependency collection is asynchronous. Cancellation or another state
    // transition during that await must dominate the stale recovery attempt:
    // never restore admission metadata or launch a worker onto a task that is
    // no longer the open task this recovery reserved.
    const currentAfterAdmission = taskStore.getTask(task.id);
    if (!currentAfterAdmission || currentAfterAdmission.status !== 'open') {
      if (dependencyAdmission?.admit) {
        options.launchDependencyAdmission?.releaseProbe(dependencyAdmission.probe);
      }
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: 'task changed state while recovery dependency admission was in flight',
      });
      continue;
    }
    let launchReservationToken = taskStore.beginLaunchWithToken(task.id);
    if (!launchReservationToken) {
      if (dependencyAdmission?.admit) {
        options.launchDependencyAdmission?.releaseProbe(dependencyAdmission.probe);
      }
      result.skipped.push({
        taskId: task.id,
        sessionId: tmuxName,
        reason: 'task launch ownership is held by another recovery path',
      });
      continue;
    }
    try {
      const priorAdmission = currentAfterAdmission.launchAdmission;
      let admissionMarkerWrittenByOwner: Task['launchAdmission'];
      if (dependencyAdmission && !dependencyAdmission.admit) {
        const deniedAdmission = taskAdmissionForDeniedDecision(
          dependencyAdmission,
          new Date().toISOString(),
        );
        admissionMarkerWrittenByOwner = deniedAdmission;
        taskStore.setLaunchAdmission(task.id, deniedAdmission);
        taskStore.pendTask(task.id);
        // The confirmed denial must survive the same restart that is performing
        // recovery; acknowledge the skip only after the parked marker is durable.
        try {
          await options.flushTasks?.();
        } catch (err) {
          const current = taskStore.getTask(task.id);
          if (
            current
            && !isTerminalStatus(current.status)
            && !taskStore.hasForeignFreshLaunchReservation(task.id, launchReservationToken)
            && isSameTaskLaunchAdmission(current.launchAdmission, admissionMarkerWrittenByOwner)
          ) {
            taskStore.setLaunchAdmission(task.id, priorAdmission);
          }
          result.failed.push({
            taskId: task.id,
            sessionId: tmuxName,
            error: `dependency admission persistence failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
        result.skipped.push({
          taskId: task.id,
          sessionId: tmuxName,
          reason: `launch dependency admission parked: ${dependencyAdmission.reason}`,
        });
        continue;
      }
      if (dependencyAdmission && priorAdmission) {
        taskStore.setLaunchAdmission(task.id, undefined);
        if (priorAdmission.status === 'parked') {
          taskStore.setLaunchHealthSummary(task.id, undefined);
          taskStore.setLaunchNote(task.id, undefined);
        }
      }

      // Launch a new session using the EXISTING launch path.
      // adapter.launch() handles: sessionId creation, addSession(), sessionToTaskId,
      // settings file generation, and git info capture. When `resumeContext`
      // is provided AND the adapter supports resume (Claude Code), the launch
      // continues the prior conversation on a forked branch.
      let adapterLaunchSettled = false;
      let adapterLaunchStarted = false;
      let launchAdapter: AgentAdapter | undefined;
      let expectedProbeSessionId: string | undefined;
      const launchReapGuard: LaunchReapGuard = { reaped: false };
      const priorSessionIds = new Set(task.sessions.map((candidate) => candidate.tmuxSession));
      try {
        const adapter = adapterRegistry.get(task.agentType);
        launchAdapter = adapter;
        expectedProbeSessionId = dependencyAdmission?.admit && dependencyAdmission.probe
          ? allocateLaunchSessionId()
          : undefined;
        const launchOptions = {
          ...buildRecoveryLaunchOptions(task.id, originalCwd, intent.intent),
          onSessionCreated: (sessionId: string) => {
            const lateCleanup = noteLaunchSession(
              launchReapGuard,
              adapter,
              task.agentType,
              task.id,
              sessionId,
            );
            if (!lateCleanup) return;
            try {
              taskStore.recordAbandonedLaunchSession(task.id, {
                tmuxSession: sessionId,
                agentType: task.agentType,
                cwd: originalCwd,
                createdAt: new Date(),
              });
              taskStore.updateSession(task.id, sessionId, { lastStatus: undefined });
            } catch {
              // The adapter may attach immediately after reporting creation.
            }
            void lateCleanup.then(
              async () => {
                try {
                  taskStore.updateSession(task.id, sessionId, { lastStatus: 'aborted' });
                } catch {
                  // Task deletion after proven cleanup needs no bookkeeping.
                }
                await options.flushTasks?.().catch(() => undefined);
              },
              async () => {
                const current = taskStore.getTask(task.id);
                if (
                  admissionMarkerWrittenByOwner?.status === 'probing'
                  && isSameTaskLaunchAdmission(current?.launchAdmission, admissionMarkerWrittenByOwner)
                ) {
                  options.launchDependencyAdmission?.retainProbeCleanup(
                    admissionMarkerWrittenByOwner.dependencies,
                    task.id,
                  );
                }
                await options.flushTasks?.().catch(() => undefined);
              },
            );
          },
          ...(expectedProbeSessionId ? { tmuxName: expectedProbeSessionId } : {}),
        };
        if (dependencyAdmission?.admit && dependencyAdmission.probe) {
          const probeAdmission = taskAdmissionForProbe(
            dependencyAdmission,
            new Date().toISOString(),
            expectedProbeSessionId,
          );
          admissionMarkerWrittenByOwner = probeAdmission;
          taskStore.setLaunchAdmission(task.id, probeAdmission);
          // A restarted process must see that this task owned the half-open
          // attempt before a replacement session can exist.
          await options.flushTasks?.();
          const currentAfterBarrier = taskStore.getTask(task.id);
          if (!currentAfterBarrier || currentAfterBarrier.status !== 'open') {
            options.launchDependencyAdmission?.releaseProbe(dependencyAdmission.probe);
            if (isSameTaskLaunchAdmission(
              currentAfterBarrier?.launchAdmission,
              admissionMarkerWrittenByOwner,
            )) {
              taskStore.setLaunchAdmission(task.id, undefined);
              taskStore.setLaunchHealthSummary(task.id, undefined);
            }
            result.skipped.push({
              taskId: task.id,
              sessionId: tmuxName,
              reason: 'task changed state while its probe marker was persisted',
            });
            continue;
          }
          if (!taskStore.ownsLaunchReservation(task.id, launchReservationToken)) {
            const renewedToken = taskStore.beginLaunchWithToken(task.id);
            if (!renewedToken) {
              options.launchDependencyAdmission?.releaseProbe(dependencyAdmission.probe);
              result.skipped.push({
                taskId: task.id,
                sessionId: tmuxName,
                reason: 'task lost crash-recovery launch ownership while persisting its probe marker',
              });
              continue;
            }
            launchReservationToken = renewedToken;
          }
          if (!options.launchDependencyAdmission?.isProbeActive(dependencyAdmission.probe)) {
            options.launchDependencyAdmission?.releaseProbe(dependencyAdmission.probe);
            const refreshed = options.launchDependencyAdmission?.evaluate(intent.intent.dependencies);
            const refreshedAdmission = refreshed && !refreshed.admit
              ? taskAdmissionForDeniedDecision(refreshed, new Date().toISOString())
              : refreshed?.admit
                ? taskAdmissionForProbeCapacityWait(refreshed, new Date().toISOString())
                : undefined;
            if (refreshed?.admit) options.launchDependencyAdmission?.releaseProbe(refreshed.probe);
            taskStore.pendTask(task.id);
            admissionMarkerWrittenByOwner = refreshedAdmission;
            taskStore.setLaunchAdmission(task.id, refreshedAdmission);
            await options.flushTasks?.();
            result.skipped.push({
              taskId: task.id,
              sessionId: tmuxName,
              reason: 'dependency probe ownership changed before adapter launch; task re-parked',
            });
            continue;
          }
        }
        adapterLaunchStarted = true;
        const launchPromise = adapter.launch(task.id, effectivePrompt, originalCwd, resumeContext, launchOptions);
        const configuredTimeout = options.getLaunchTimeoutMs?.();
        const launchTimeoutMs = typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0
          ? configuredTimeout
          : DEFAULT_LAUNCH_TIMEOUT_MS;
        const newSessionId = await raceLaunchAgainstTimeout(launchPromise, launchTimeoutMs, {
          taskId: task.id,
          agentType: task.agentType,
          adapter,
          reapGuard: launchReapGuard,
          reapKnownSessionOnTimeout: true,
        });
        adapterLaunchSettled = true;
        if (dependencyAdmission?.admit) {
          if (dependencyAdmission.probe) {
            await options.flushTasks?.().catch((flushErr) => {
              console.error(
                `[crash-recovery] Post-attach probe persistence failed for task ${task.id}:`,
                flushErr instanceof Error ? flushErr.message : flushErr,
              );
            });
          }
          if (taskOwnsLiveProbeSession(
            taskStore.getTask(task.id),
            admissionMarkerWrittenByOwner,
          )) {
            options.launchDependencyAdmission?.completeProbe(dependencyAdmission.probe, true);
            taskStore.setLaunchAdmission(task.id, undefined);
          }
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
        if (dependencyAdmission?.admit && dependencyAdmission.probe && !adapterLaunchStarted) {
          options.launchDependencyAdmission?.releaseProbe(dependencyAdmission.probe);
          const current = taskStore.getTask(task.id);
          const ownsFailedProbeMarker = Boolean(
            current
            && !taskStore.hasForeignFreshLaunchReservation(task.id, launchReservationToken)
            && isSameTaskLaunchAdmission(current.launchAdmission, admissionMarkerWrittenByOwner)
          );
          if (ownsFailedProbeMarker) {
            if (current && !isTerminalStatus(current.status)) {
              taskStore.setLaunchAdmission(task.id, priorAdmission);
              if (current.status === 'inProgress') taskStore.reopenTask(task.id);
              if (taskStore.getTask(task.id)?.status === 'open') taskStore.pendTask(task.id);
            } else {
              // No adapter call crossed the failed barrier, so a terminal task
              // cannot own physical cleanup from this exact probe attempt.
              taskStore.setLaunchAdmission(task.id, undefined);
              taskStore.setLaunchHealthSummary(task.id, undefined);
            }
          }
          result.failed.push({
            taskId: task.id,
            sessionId: tmuxName,
            error: `dependency probe persistence failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
        // onSessionCreated fires as soon as the physical terminal exists, before
        // TaskStore attachment. Reap that session for every unsettled recovery
        // launch failure so healthy/no-probe recovery cannot leak an orphan.
        let failedSessionReapError: unknown;
        let failedLaunchSessionId: string | undefined;
        const ownedLaunchAtFailure = taskStore.ownsLaunchReservation(
          task.id,
          launchReservationToken,
        );
        if (!adapterLaunchSettled) {
          const failedSessionId = launchReapGuard.sessionId ?? (ownedLaunchAtFailure
            ? taskStore.getTask(task.id)?.sessions
              .filter((candidate) => !priorSessionIds.has(candidate.tmuxSession))
              .at(-1)?.tmuxSession
            : undefined);
          if (failedSessionId) {
            failedLaunchSessionId = failedSessionId;
            try {
              taskStore.updateSession(task.id, failedSessionId, { lastStatus: 'aborted' });
            } catch {
              taskStore.recordAbandonedLaunchSession(task.id, {
                tmuxSession: failedSessionId,
                agentType: task.agentType,
                cwd: originalCwd,
                createdAt: new Date(),
              });
            }
            // Do not claim cleanup before physical stop succeeds. Leaving the
            // session unknown also makes a concurrent cancellation attempt
            // the same idempotent stop instead of skipping it.
            taskStore.updateSession(task.id, failedSessionId, { lastStatus: undefined });
            if (!launchReapGuard.reaped) {
              const adapter = launchAdapter ?? adapterRegistry.get(task.agentType);
              try {
                await (launchReapGuard.reapPromise
                  ?? reapLaunchSession(
                    launchReapGuard,
                    adapter,
                    task.agentType,
                    task.id,
                    failedSessionId,
                  ));
                taskStore.updateSession(task.id, failedSessionId, { lastStatus: 'aborted' });
              } catch (stopErr) {
                failedSessionReapError = stopErr;
              }
            }
          } else if (
            dependencyAdmission?.admit
            && dependencyAdmission.probe
            && expectedProbeSessionId
            && isLaunchTimeoutError(err)
          ) {
            failedLaunchSessionId = expectedProbeSessionId;
            failedSessionReapError = new Error(
              `dependency probe launch timed out before session ${expectedProbeSessionId} creation settled`,
            );
          }
        }
        if (failedSessionReapError) {
          if (dependencyAdmission?.admit && dependencyAdmission.probe) {
            const current = taskStore.getTask(task.id);
            if (
              admissionMarkerWrittenByOwner?.status === 'probing'
              && isSameTaskLaunchAdmission(current?.launchAdmission, admissionMarkerWrittenByOwner)
            ) {
              options.launchDependencyAdmission?.retainProbeCleanup(
                admissionMarkerWrittenByOwner.dependencies,
                task.id,
              );
            }
            if (
              current
              && !isTerminalStatus(current.status)
              && isSameTaskLaunchAdmission(current.launchAdmission, admissionMarkerWrittenByOwner)
            ) {
              if (failedLaunchSessionId && current.sessions.some(
                (session) => session.tmuxSession === failedLaunchSessionId,
              )) {
                taskStore.updateSession(task.id, failedLaunchSessionId, { lastStatus: undefined });
              }
              if (current.status === 'pending' || current.status === 'open') {
                taskStore.startTask(task.id);
              }
            } else if (
              current
              && admissionMarkerWrittenByOwner?.status === 'probing'
              && isSameTaskLaunchAdmission(current.launchAdmission, admissionMarkerWrittenByOwner)
            ) {
              taskStore.setLaunchAdmission(task.id, admissionMarkerWrittenByOwner);
            }
            await options.flushTasks?.().catch((flushErr) => {
              console.error(
                `[crash-recovery] Failed to persist retained cleanup fence for task ${task.id}:`,
                flushErr instanceof Error ? flushErr.message : flushErr,
              );
            });
          } else {
            const current = taskStore.getTask(task.id);
            const hasForeignLiveSession = current?.sessions.some(
              (session) => session.tmuxSession !== failedLaunchSessionId
                && session.lastStatus !== 'completed'
                && session.lastStatus !== 'aborted',
            ) ?? false;
            const hasReplacementSession = current?.sessions.some(
              (session) => session.tmuxSession !== failedLaunchSessionId
                && !priorSessionIds.has(session.tmuxSession),
            ) ?? false;
            const hasReplacementOwner = taskStore.hasForeignFreshLaunchReservation?.(
              task.id,
              launchReservationToken,
            ) ?? false;
            if (
              current
              && !isTerminalStatus(current.status)
              && !hasReplacementOwner
              && !hasReplacementSession
              && (ownedLaunchAtFailure || (failedLaunchSessionId && !hasForeignLiveSession))
            ) {
              taskStore.cancelTask(task.id);
            }
          }
          result.failed.push({
            taskId: task.id,
            sessionId: tmuxName,
            error: `failed launch session remains owned after cleanup rejection: ${failedSessionReapError instanceof Error ? failedSessionReapError.message : String(failedSessionReapError)}`,
          });
          // A probe retains its durable exact-session marker and busy circuit.
          // Ordinary recovery is terminal so its linked session is eligible
          // for the periodic terminal-leak reaper.
          continue;
        }
        if (dependencyAdmission?.admit && dependencyAdmission.probe && !adapterLaunchSettled) {
          const currentAtFailure = taskStore.getTask(task.id);
          if (!isSameTaskLaunchAdmission(
            currentAtFailure?.launchAdmission,
            admissionMarkerWrittenByOwner,
          )) {
            result.failed.push({
              taskId: task.id,
              sessionId: tmuxName,
              error: `stale failed dependency probe owner: ${err instanceof Error ? err.message : String(err)}`,
            });
            continue;
          }
          if (
            !currentAtFailure
            || currentAtFailure.status === 'completed'
            || currentAtFailure.status === 'terminated'
            || currentAtFailure.status === 'cancelled'
          ) {
            options.launchDependencyAdmission?.releaseProbe(dependencyAdmission.probe);
            if (currentAtFailure?.launchAdmission?.status === 'probing') {
              taskStore.setLaunchAdmission(task.id, undefined);
              taskStore.setLaunchHealthSummary(task.id, undefined);
            }
          } else {
            options.launchDependencyAdmission?.completeProbe(dependencyAdmission.probe, false);
          }
          const current = taskStore.getTask(task.id);
          if (current && !isTerminalStatus(current.status)) {
            taskStore.setLaunchAdmission(
              task.id,
              taskAdmissionForFailedProbe(dependencyAdmission, new Date().toISOString()),
            );
          }
          if (current?.status === 'inProgress') taskStore.reopenTask(task.id);
          if (taskStore.getTask(task.id)?.status === 'open') taskStore.pendTask(task.id);
          const afterTransition = taskStore.getTask(task.id);
          if (
            afterTransition
            && afterTransition.status !== 'completed'
            && afterTransition.status !== 'terminated'
            && afterTransition.status !== 'cancelled'
          ) {
            result.skipped.push({
              taskId: task.id,
              sessionId: tmuxName,
              reason: `recovery probe failed and task was re-parked: ${err instanceof Error ? err.message : String(err)}`,
            });
          } else {
            if (afterTransition) taskStore.setLaunchAdmission(task.id, undefined);
            result.skipped.push({
              taskId: task.id,
              sessionId: tmuxName,
              reason: 'task became terminal while its recovery probe was in flight',
            });
          }
          continue;
        }
        result.failed.push({
          taskId: task.id,
          sessionId: tmuxName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      taskStore.endLaunch(task.id, launchReservationToken);
    }
  }

  return result;
}

async function evaluateRecoveryDependencyAdmission(
  intent: NonNullable<Task['launchIntent']>,
  options: CrashRecoveryOptions,
): Promise<LaunchDependencyAdmissionDecision | undefined> {
  const admission = options.launchDependencyAdmission;
  const dependencies = intent.dependencies;
  if (!admission || !dependencies || dependencies.length === 0) return undefined;

  let findings: Array<{ dependency: string; category: string; summary?: string }>;
  try {
    findings = await (options.dependencyPreflightRunner ?? runLaunchDependencyPreflights)(dependencies);
  } catch (err) {
    // Recovery must remain fail-open when health collection itself is broken.
    console.warn(
      '[crash-recovery] dependency preflight could not complete:',
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

function buildRecoveryLaunchOptions(
  taskId: string,
  cwd: string,
  intent: NonNullable<Task['launchIntent']>,
): AdapterLaunchOptions {
  return {
    ...(intent.effort !== undefined ? { effort: intent.effort } : {}),
    ...(intent.model !== undefined ? { model: intent.model } : {}),
    ...(intent.ralphVerdictEnv
      ? {
          extraEnv: {
            RALPH_VERDICT_FILE: defaultVerdictPath(cwd, taskId),
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
