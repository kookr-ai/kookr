import type { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { deserializeSnoozed, type LoadTasksResult } from '../core/task-persistence.js';
import type { TaskStore } from '../core/tasks.js';
import type { Monitor } from '../core/monitor.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { Watchdog } from '../core/watchdog.js';
import type { ServerMessage } from '../shared/protocol.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import {
  appendDispositionEntry,
  auditRecoveryDispositions,
  type DispositionEntry,
  type DispositionKind,
} from '../core/disposition-ledger.js';
import { promotePendingTasks, registerNewAgent, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { recoverCrashedSessions, type CrashRecoveryResult } from './crash-recovery.js';
import { runPostRestartRecovery } from './post-restart-recovery.js';
import type { HookFileWatcher } from './hook-watcher.js';
import type { HookIngestion } from './hook-ingestion.js';
import type { ActivityLedger } from '../core/activity-ledger.js';
import type { ReconciliationResult } from './reconciliation.js';
import type { RalphLoopService } from './ralph-loop-service.js';

interface StartupRecoveryDeps {
  taskStore: TaskStore;
  queue: AttentionQueue;
  monitor: Monitor;
  watchdog: Watchdog;
  terminalBackend: TerminalBackend;
  hookWatcher: HookFileWatcher;
  suppressionTracker: SnoozeSuppressionTracker;
  interactionLog: DeferredInteractionLogWriter;
  adapterRegistry: AdapterRegistry;
  reconcileResult: ReconciliationResult;
  persisted: LoadTasksResult;
  lifecycleDeps: AgentLifecycleDeps;
  serverCwd: string;
  broadcastToAll: (msg: ServerMessage) => void;
  ralphLoopService: RalphLoopService;
  /** Used to hydrate the ingestion dedup cache before resumed sessions
   *  replay their hook files. See rfc-activity-log-reliability edge cases. */
  hookIngestion?: HookIngestion;
  activityLedger?: ActivityLedger;
  /** Shared boot epoch used by both recovery audit and session-health diagnostics. */
  restartEpoch: number;
  /**
   * Path to the recovery work-conservation ledger (issue #1540). When
   * absent, no disposition entries are written and the post-recovery audit
   * is skipped — matches the `auditLogPath` "no-op when unconfigured"
   * convention used elsewhere in this file's deps.
   */
  dispositionLedgerPath?: string;
  /**
   * Task ids `reconcileStaleOpenLaunches` terminated this boot (issue #1540
   * review fix). Together with the crash-recovery relaunched/skipped/failed
   * ids computed below, this defines the set the post-recovery audit checks
   * — see the audit block for why the raw `tasksTerminated` list is wrong to
   * audit directly.
   */
  staleOpenLaunchTaskIds?: string[];
  /** Live adapter-launch timeout used by crash recovery. */
  getLaunchTimeoutMs?: () => number;
}

interface PromotePendingStartupTasksDeps {
  taskStore: TaskStore;
  adapterRegistry: AdapterRegistry;
  lifecycleDeps: AgentLifecycleDeps;
  broadcastToAll: (msg: ServerMessage) => void;
  serverCwd: string;
}

export async function runStartupRecoveryPhase({
  taskStore,
  queue,
  monitor,
  watchdog,
  terminalBackend,
  hookWatcher,
  suppressionTracker,
  interactionLog,
  adapterRegistry,
  reconcileResult,
  persisted,
  lifecycleDeps,
  serverCwd,
  broadcastToAll,
  ralphLoopService,
  hookIngestion,
  activityLedger,
  restartEpoch,
  dispositionLedgerPath,
  staleOpenLaunchTaskIds = [],
  getLaunchTimeoutMs,
}: StartupRecoveryDeps): Promise<CrashRecoveryResult | null> {
  let startupRecoverySummary: CrashRecoveryResult | null = null;
  // LaunchDependencyAdmission is process-local, while parked launch intents
  // are durable. Rehydrate the degraded side before crash recovery or pending
  // promotion so a clean first check after restart is a bounded half-open
  // probe rather than an unguarded launch.
  if (lifecycleDeps.launchDependencyAdmission) {
    const successfulProbes: Array<{ dependencies: string[]; startedAt: number }> = [];
    const latestConfirmedAtByDependency = new Map<string, number>();
    for (const task of taskStore.listTasks()) {
      if (task.launchAdmission?.status === 'probing') {
        const liveProbeSession = task.status === 'inProgress'
          && task.sessions.some((session) => reconcileResult.resumed.includes(session.tmuxSession));
        if (liveProbeSession) {
          // The adapter attached a worker before the previous process died.
          // Reconciliation proved it is still live, which is sufficient probe
          // success evidence; do not poison that running task as parked.
          successfulProbes.push({
            dependencies: task.launchAdmission.dependencies.map((dependency) => dependency.dependency),
            // Invalid legacy timestamps cannot safely supersede any confirmed
            // evidence, but a live probe with no competing confirmation still
            // counts as success.
            startedAt: parseEvidenceTime(task.launchAdmission.startedAt, Number.NEGATIVE_INFINITY),
          });
          taskStore.setLaunchAdmission(task.id, undefined);
          continue;
        }
        if (task.status === 'completed' || task.status === 'terminated' || task.status === 'cancelled') {
          taskStore.setLaunchAdmission(task.id, undefined);
          continue;
        }
        const parked = {
          status: 'parked' as const,
          reason: 'dependency_degraded' as const,
          dependencies: task.launchAdmission.dependencies.map((dependency) => ({
            ...dependency,
            state: 'degraded' as const,
            reason: 'Recovery probe was interrupted by server restart',
          })),
          parkedAt: new Date().toISOString(),
        };
        if (task.status === 'inProgress') taskStore.reopenTask(task.id);
        if (taskStore.getTask(task.id)?.status === 'open') taskStore.pendTask(task.id);
        taskStore.setLaunchAdmission(task.id, parked);
        lifecycleDeps.launchDependencyAdmission.restoreParked(parked.dependencies);
        recordLatestConfirmedEvidence(
          latestConfirmedAtByDependency,
          parked.dependencies,
          parked.parkedAt,
        );
        continue;
      }
      if (task.status === 'pending' && task.launchAdmission?.status === 'parked') {
        lifecycleDeps.launchDependencyAdmission.restoreParked(task.launchAdmission.dependencies);
        if (task.launchAdmission.reason === 'dependency_degraded') {
          recordLatestConfirmedEvidence(
            latestConfirmedAtByDependency,
            task.launchAdmission.dependencies,
            task.launchAdmission.parkedAt,
          );
        }
      }
    }
    for (const probe of successfulProbes) {
      lifecycleDeps.launchDependencyAdmission.restoreSuccessfulProbe(
        probe.dependencies,
        probe.startedAt,
        latestConfirmedAtByDependency,
      );
    }
  }
  // Tracks crash-recovery's own outcome so the post-recovery audit below can
  // see it even on a boot with nothing to relaunch/fail. Populated whenever
  // recoverCrashedSessions actually runs. `startupRecoverySummary` is now
  // always assigned that same result (including skip-only boots) so health
  // can project counts (issue #2351); interaction-log noise stays gated.
  let crashRecoveryResult: CrashRecoveryResult | null = null;

  if (process.env.KOOKR_AUTO_RELAUNCH === 'false') {
    console.log('[crash-recovery] Disabled (KOOKR_AUTO_RELAUNCH=false), skipping');
  } else if (reconcileResult.markedCompleted.length > 0) {
    const recoveryResult = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult, {
      launchDependencyAdmission: lifecycleDeps.launchDependencyAdmission,
      dependencyPreflightRunner: lifecycleDeps.dependencyPreflightRunner,
      getLaunchTimeoutMs: getLaunchTimeoutMs ?? lifecycleDeps.getLaunchTimeoutMs,
    });
    crashRecoveryResult = recoveryResult;

    for (const entry of recoveryResult.relaunched) {
      const task = taskStore.getTask(entry.taskId);
      if (task) {
        await registerNewAgent(task, lifecycleDeps);
      }
      if (entry.mode === 'resumed') {
        console.log(
          `[crash-recovery] Resumed task ${entry.taskId} → session ${entry.newSessionId}`,
        );
      } else {
        const reason = entry.fallbackReason ?? 'unknown';
        console.log(
          `[crash-recovery] Fresh-launched task ${entry.taskId}: ${reason} → session ${entry.newSessionId}`,
        );
      }
    }
    for (const { sessionId, reason } of recoveryResult.skipped) {
      console.warn(`[crash-recovery] Skipped ${sessionId}: ${reason}`);
    }
    for (const { sessionId, error } of recoveryResult.failed) {
      console.error(`[crash-recovery] Failed ${sessionId}: ${error}`);
    }

    await writeCrashRecoveryDispositions(recoveryResult, restartEpoch, dispositionLedgerPath);

    // Always retain the structured result so /api/health can project skip
    // counts (including crash-loop) even when nothing relaunched/failed
    // (issue #2351). Interaction-log noise stays gated to material outcomes.
    startupRecoverySummary = recoveryResult;
    if (recoveryResult.relaunched.length > 0 || recoveryResult.failed.length > 0) {
      await interactionLog.append({
        type: 'crash_recovery',
        relaunched: recoveryResult.relaunched.length,
        skipped: recoveryResult.skipped.length,
        failed: recoveryResult.failed.length,
        details: recoveryResult,
        timestamp: new Date().toISOString(),
      });
      const resumedCount = recoveryResult.relaunched.filter((e) => e.mode === 'resumed').length;
      const freshCount = recoveryResult.relaunched.length - resumedCount;
      console.log(
        `[crash-recovery] Recovery complete: ${resumedCount} resumed, ${freshCount} fresh, `
        + `${recoveryResult.skipped.length} skipped, ${recoveryResult.failed.length} failed`,
      );
    } else if (recoveryResult.skipped.length > 0) {
      console.log(
        `[crash-recovery] Recovery complete: 0 relaunched, `
        + `${recoveryResult.skipped.length} skipped, 0 failed`,
      );
    }
  }

  const persistedSnoozes = [
    ...(persisted.snoozes ?? []),
    ...(persisted.snoozedFindings ?? []),
  ];
  const deserialized = deserializeSnoozed(persistedSnoozes, taskStore);
  if (deserialized.length > 0) {
    queue.importSnoozed(deserialized);
    console.log(`[snooze] Restored ${deserialized.length} snooze(s)`);
  }

  if (persisted.suppressionState && persisted.suppressionState.length > 0) {
    suppressionTracker.import(persisted.suppressionState);
    console.log(`[suppression] Restored ${persisted.suppressionState.length} suppression state(s)`);
  }

  for (const tmuxName of reconcileResult.resumed) {
    monitor.registerAgent(tmuxName);
    const resumedTask = taskStore.findTaskBySession(tmuxName);
    const resumedSession = resumedTask?.sessions.find((session) => session.tmuxSession === tmuxName);
    watchdog.registerAgent(tmuxName, resumedSession?.lastEventAt);
    // Hydrate dedup cache from the durable ledger BEFORE the file watcher
    // replays the JSONL — otherwise records that were already delivered (via
    // HTTP) and durably written before the crash would be re-injected on
    // replay. See rfc-activity-log-reliability edge cases.
    if (hookIngestion && activityLedger) {
      try {
        const hydration = await hookIngestion.hydrateFromLedger(tmuxName, activityLedger, {
          replayLiveState: true,
        });
        hookWatcher.watch(tmuxName, {
          replayExisting: true,
          suppressParseAlertsForExisting: true,
          useReplayCheckpoint: hydration.liveStateReplayed,
        });
        continue;
      } catch (err) {
        console.warn(`[hook-ingestion] hydrate failed for ${tmuxName}:`, err);
      }
    }
    hookWatcher.watch(tmuxName, { replayExisting: true, suppressParseAlertsForExisting: true });
  }

  // Drop durable resume offsets for sessions that were not re-armed above
  // (historical terminal / orphan debt). Live watches are retained. Safe only
  // after the re-watch loop so resumed sessions keep their checkpoints
  // (issue #2385).
  try {
    const pruned = hookWatcher.pruneStaleReplayCheckpoints({ dropUnwatched: true });
    if (pruned > 0) {
      console.log(
        `[hook-watcher] pruned ${pruned} stale replay checkpoint(s) after startup recovery`,
      );
    }
  } catch (err) {
    console.warn('[hook-watcher] stale replay checkpoint prune failed:', err);
  }

  // Post-restart transport verification (kookr-ai/kookr#1345). The resumed
  // sessions above are re-registered off process/socket liveness, which does
  // NOT catch a wedged internal attach (alive but emitting no bytes). Verify
  // each recovered session becomes observably live and self-heal only the attach
  // transport when it does not — the dtach master + agent are preserved. Runs
  // best-effort so a verification hiccup never blocks startup.
  if (reconcileResult.resumed.length > 0) {
    try {
      await runPostRestartRecovery({
        terminalBackend,
        taskStore,
        resumedSessions: reconcileResult.resumed,
        restartEpoch,
      });
    } catch (err) {
      console.warn('[post-restart-recovery] verification phase failed:', err);
    }
  }

  // Ralph startup reconcile. Runs AFTER recoverCrashedSessions so dead-but-relaunched
  // sessions count as "alive". Loops with no surviving session are marked `failed` with
  // a `kookr_crash` audit record; alive ones are left running and resume on the next Stop.
  const ralphSummary = await ralphLoopService.reconcileStartupLoops();
  if (ralphSummary.examined > 0) {
    console.log(
      `[ralph-recovery] Examined ${ralphSummary.examined} running loop(s): `
      + `${ralphSummary.preserved} preserved, ${ralphSummary.failed} failed.`,
    );
  }

  // Post-recovery audit (issue #1540 AC2, review fix for a blocking false-
  // positive bug): audit ONLY the task ids a write path actually attempted a
  // disposition for, not the raw `reconcileResult.tasksTerminated` list.
  //
  // Auditing the raw list is wrong because not every terminated task has a
  // code path that writes a disposition:
  //   - When KOOKR_AUTO_RELAUNCH=false, the whole crash-recovery block above
  //     (including `writeCrashRecoveryDispositions`) is skipped, so ZERO
  //     dispositions are written this boot — yet every terminated task would
  //     still get flagged as an offender.
  //   - A task whose sessions were ALL already dead before this boot (so none
  //     of them appear in this boot's `reconcileResult.markedCompleted`) is
  //     terminated by `reconcile()`'s auto-transition, but crash-recovery
  //     never sees it either, since it only iterates `markedCompleted`.
  //
  // The smallest correct fix: build the audited set from the union of ids
  // that DID get a disposition-write attempt this boot —
  // `staleOpenLaunchTaskIds` (written by `reconcileStaleOpenLaunches` itself,
  // now that the caller passes it a ledger path) plus every relaunched/
  // skipped/failed task id `writeCrashRecoveryDispositions` covers (mirroring
  // its own skip-classification so "already relaunched in this pass" siblings
  // aren't double-counted). Tasks outside that union have no contractual
  // writer and are intentionally excluded — flagging them would just be a
  // different false positive. Loud on failure (see `auditRecoveryDispositions`);
  // never throws, so an audit hiccup never blocks startup.
  const crashRecoveryAuditedTaskIds = new Set<string>();
  if (crashRecoveryResult) {
    for (const relaunch of crashRecoveryResult.relaunched) crashRecoveryAuditedTaskIds.add(relaunch.taskId);
    for (const skip of crashRecoveryResult.skipped) {
      if (classifyCrashRecoverySkip(skip.reason)) crashRecoveryAuditedTaskIds.add(skip.taskId);
    }
    for (const failure of crashRecoveryResult.failed) crashRecoveryAuditedTaskIds.add(failure.taskId);
  }
  const auditedTaskIds = new Set<string>([...staleOpenLaunchTaskIds, ...crashRecoveryAuditedTaskIds]);
  const disposedTasks = reconcileResult.tasksTerminated
    .filter((taskId) => auditedTaskIds.has(taskId))
    .map((taskId) => ({ taskId, status: 'terminated' }));

  if (dispositionLedgerPath && disposedTasks.length > 0) {
    await auditRecoveryDispositions(
      dispositionLedgerPath,
      disposedTasks,
      { startMs: restartEpoch, endMs: Date.now() },
    ).catch((err) => {
      console.error('[disposition-ledger] post-recovery audit failed:', err);
    });
  }

  return startupRecoverySummary;
}

function parseEvidenceTime(value: string, fallback: number): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function recordLatestConfirmedEvidence(
  latestByDependency: Map<string, number>,
  dependencies: readonly { dependency: string }[],
  evidenceAt: string,
): void {
  const confirmedAt = parseEvidenceTime(evidenceAt, Number.POSITIVE_INFINITY);
  for (const dependency of dependencies) {
    latestByDependency.set(
      dependency.dependency,
      Math.max(latestByDependency.get(dependency.dependency) ?? Number.NEGATIVE_INFINITY, confirmedAt),
    );
  }
}

/**
 * Record a work-conservation disposition entry for every task
 * `recoverCrashedSessions` touched (issue #1540 AC1). No-op when
 * `dispositionLedgerPath` isn't configured. Best-effort per entry — a ledger-
 * write failure is logged loudly but must not abort startup.
 */
async function writeCrashRecoveryDispositions(
  recoveryResult: CrashRecoveryResult,
  restartEpoch: number,
  dispositionLedgerPath: string | undefined,
): Promise<void> {
  if (!dispositionLedgerPath) return;
  const ledgerPath = dispositionLedgerPath;
  const incidentId = String(restartEpoch);
  const source = 'crash-recovery';

  const write = async (entry: DispositionEntry): Promise<void> => {
    try {
      await appendDispositionEntry(ledgerPath, entry);
    } catch (err) {
      console.error(`[disposition-ledger] failed to record entry for task ${entry.taskId}:`, err);
    }
  };

  for (const relaunch of recoveryResult.relaunched) {
    await write({
      schemaVersion: 'disposition-ledger.v1',
      taskId: relaunch.taskId,
      disposition: 'respawned',
      detail: `respawned-as: session ${relaunch.newSessionId} (${relaunch.mode === 'resumed' ? 'resumed conversation' : 'fresh launch'})`,
      incidentId,
      source,
      at: new Date().toISOString(),
    });
  }

  for (const skip of recoveryResult.skipped) {
    const classification = classifyCrashRecoverySkip(skip.reason);
    if (!classification) continue; // already covered by a sibling session's 'respawned' entry above
    await write({
      schemaVersion: 'disposition-ledger.v1',
      taskId: skip.taskId,
      disposition: classification.kind,
      detail: classification.detail,
      incidentId,
      source,
      at: new Date().toISOString(),
    });
  }

  for (const failure of recoveryResult.failed) {
    await write({
      schemaVersion: 'disposition-ledger.v1',
      taskId: failure.taskId,
      disposition: 'needs-human',
      detail: `needs-human: crash-recovery relaunch failed: ${failure.error}`,
      incidentId,
      source,
      at: new Date().toISOString(),
    });
  }
}

/**
 * Classify a `CrashRecoverySkip.reason` into a work-conservation disposition.
 * Reason strings are crash-recovery.ts's own guard messages (see
 * `recoverCrashedSessions`) — matched by prefix since they carry variable
 * detail (elapsed time, cwd path). Returns `null` when the task's disposition
 * is already recorded elsewhere in this same pass (a sibling session's
 * relaunch). Falls back to `obsolete` for the remaining known reasons (the
 * work is demonstrably covered — a live/duplicate/already-clean session) and
 * escalates the two genuinely ambiguous guards (crash-loop, missing cwd) to
 * `needs-human` rather than guessing.
 */
function classifyCrashRecoverySkip(reason: string): { kind: DispositionKind; detail: string } | null {
  if (reason === 'task already relaunched in this recovery pass') return null;
  if (reason.startsWith('rapid crash-loop')) {
    return {
      kind: 'needs-human',
      detail: `needs-human: skipped by crash-loop protection (${reason}); repeated crashes need investigation before auto-resuming`,
    };
  }
  if (reason.startsWith('CWD does not exist')) {
    return {
      kind: 'needs-human',
      detail: `needs-human: crash-recovery could not resume — ${reason}`,
    };
  }
  return { kind: 'obsolete', detail: `obsolete-because: ${reason}` };
}

export async function promotePendingStartupTasks({
  taskStore,
  adapterRegistry,
  lifecycleDeps,
  broadcastToAll,
  serverCwd,
}: PromotePendingStartupTasksDeps): Promise<void> {
  const promoted = await promotePendingTasks({
    taskStore,
    adapterRegistry,
    lifecycleDeps,
    broadcastToAll,
    serverCwd,
  });

  if (promoted > 0) {
    console.log(`[startup] Promoted ${promoted} pending task(s) to active`);
  }
}
