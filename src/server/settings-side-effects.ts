import type { Monitor } from '../core/monitor.js';
import type { GitHubScannerService } from '../core/github-scanner-service.js';
import { saveSettings, type KookrSettings } from '../core/settings-store.js';
import type { Watchdog } from '../core/watchdog.js';

interface ApplySettingsSideEffectsDeps {
  prevSettings: KookrSettings;
  newSettings: KookrSettings;
  settingsFile: string;
  githubScanner: GitHubScannerService;
  watchdog: Watchdog;
  monitor: Monitor;
}

export async function applySettingsSideEffects({
  prevSettings,
  newSettings,
  settingsFile,
  githubScanner,
  watchdog,
  monitor,
}: ApplySettingsSideEffectsDeps): Promise<string[]> {
  await saveSettings(settingsFile, newSettings);

  const warnings: string[] = [];

  // --- GitHub polling side effects ---
  const pollingToggled = prevSettings.githubPollingEnabled !== newSettings.githubPollingEnabled;
  const intervalChanged = prevSettings.githubPollingIntervalSec !== newSettings.githubPollingIntervalSec;

  if (pollingToggled && !newSettings.githubPollingEnabled) {
    githubScanner.stop();
    console.log('[settings] GitHub polling disabled');
  } else if (pollingToggled && newSettings.githubPollingEnabled) {
    const started = await githubScanner.start();
    console.log(`[settings] GitHub polling ${started ? 'enabled' : 'failed to enable (gh CLI unavailable)'}`);
  } else if (intervalChanged && newSettings.githubPollingEnabled) {
    const pollingIntervalMs = newSettings.githubPollingIntervalSec * 1000;
    githubScanner.reconfigure({
      stateFetchIntervalMs: pollingIntervalMs,
      referenceExtractionIntervalMs: pollingIntervalMs,
    });
    console.log(
      `[settings] GitHub polling interval → ${newSettings.githubPollingIntervalSec}s `
      + `(was ${prevSettings.githubPollingIntervalSec}s)`,
    );
  }

  // --- Watchdog stale threshold side effects ---
  if (prevSettings.watchdogStaleThresholdSec !== newSettings.watchdogStaleThresholdSec) {
    try {
      watchdog.reconfigure({
        staleThresholdMs: newSettings.watchdogStaleThresholdSec * 1000,
        unconditionalStaleThresholdMs: newSettings.watchdogStaleThresholdSec * 2 * 1000,
      });
      console.log(
        `[settings] watchdog staleThreshold → ${newSettings.watchdogStaleThresholdSec}s `
        + `(was ${prevSettings.watchdogStaleThresholdSec}s, `
        + `unconditional → ${newSettings.watchdogStaleThresholdSec * 2}s)`,
      );
    } catch (err) {
      const msg = `watchdog reconfigure failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[settings] ${msg}`);
      warnings.push(msg);
    }
  }

  // --- Repeated error threshold side effects ---
  if (prevSettings.repeatedErrorThreshold !== newSettings.repeatedErrorThreshold) {
    monitor.setAnomalyConfig({ repeatedErrorThreshold: newSettings.repeatedErrorThreshold });
    console.log(
      `[settings] anomaly repeatedErrorThreshold → ${newSettings.repeatedErrorThreshold} `
      + `(was ${prevSettings.repeatedErrorThreshold})`,
    );
  }

  // --- Max active tasks side effects ---
  if (prevSettings.maxActiveTasks !== newSettings.maxActiveTasks) {
    console.log(`[settings] maxActiveTasks → ${newSettings.maxActiveTasks} (was ${prevSettings.maxActiveTasks})`);
  }

  // --- Automation kill-switch / SAFE MODE (issue #1710) ---
  if (prevSettings.automationKillSwitch !== newSettings.automationKillSwitch) {
    if (newSettings.automationKillSwitch) {
      console.warn(
        `[settings] automation kill-switch ENGAGED — SAFE MODE since ${newSettings.safeModeSince ?? 'now'} `
        + `(schedule fires + autonomous launches halted; manual launches remain accepted)`,
      );
    } else {
      console.warn('[settings] automation kill-switch DISENGAGED — autonomous actuation restored');
    }
  }

  // --- Auto-close delay side effects ---
  // No reconfigure needed: the liveness tick reads the delay through a live
  // getter each pass. Logged for operability so a change is visible in the log.
  if (prevSettings.autoCloseCompletionReadyDelayMin !== newSettings.autoCloseCompletionReadyDelayMin) {
    console.log(
      `[settings] autoCloseCompletionReadyDelayMin → ${newSettings.autoCloseCompletionReadyDelayMin}min `
      + `(was ${prevSettings.autoCloseCompletionReadyDelayMin}min)`,
    );
  }

  // --- Completion-ready TTL escalation side effects (issue #1526 Phase A) ---
  // No reconfigure needed: the liveness tick reads the TTL through a live
  // getter each pass, same pattern as the auto-close delay above.
  if (prevSettings.completionReadyTtlMinutes !== newSettings.completionReadyTtlMinutes) {
    console.log(
      `[settings] completionReadyTtlMinutes → ${newSettings.completionReadyTtlMinutes}min `
      + `(was ${prevSettings.completionReadyTtlMinutes}min)`,
    );
  }

  // --- Hung-task reaper side effects (issue #1526 Phase A) ---
  if (prevSettings.hungTaskReapEnabled !== newSettings.hungTaskReapEnabled) {
    console.log(`[settings] hungTaskReapEnabled → ${newSettings.hungTaskReapEnabled} (was ${prevSettings.hungTaskReapEnabled})`);
  }
  if (prevSettings.hungTaskReapMinutes !== newSettings.hungTaskReapMinutes) {
    console.log(
      `[settings] hungTaskReapMinutes → ${newSettings.hungTaskReapMinutes}min `
      + `(was ${prevSettings.hungTaskReapMinutes}min)`,
    );
  }
  if (prevSettings.hungTaskReapWarningEnabled !== newSettings.hungTaskReapWarningEnabled) {
    console.log(
      `[settings] hungTaskReapWarningEnabled → ${newSettings.hungTaskReapWarningEnabled} `
      + `(was ${prevSettings.hungTaskReapWarningEnabled})`,
    );
  }
  if (prevSettings.hungTaskReapGraceSeconds !== newSettings.hungTaskReapGraceSeconds) {
    console.log(
      `[settings] hungTaskReapGraceSeconds → ${newSettings.hungTaskReapGraceSeconds}s `
      + `(was ${prevSettings.hungTaskReapGraceSeconds}s)`,
    );
  }

  // --- Phase-C capacity knobs (issue #1526 Phase C / #1862) ---
  // No reconfigure needed: launch, scheduler, pending-TTL, and burst budget
  // paths all read these through live getters. Logged so capacity setting
  // flips are visible in postmortems (spawn 429 / hung capacity events).
  if (prevSettings.launchTimeoutSeconds !== newSettings.launchTimeoutSeconds) {
    console.log(
      `[settings] launchTimeoutSeconds → ${newSettings.launchTimeoutSeconds}s `
      + `(was ${prevSettings.launchTimeoutSeconds}s)`,
    );
  }
  if (prevSettings.deadManScheduleMinutes !== newSettings.deadManScheduleMinutes) {
    console.log(
      `[settings] deadManScheduleMinutes → ${newSettings.deadManScheduleMinutes}min `
      + `(was ${prevSettings.deadManScheduleMinutes}min)`,
    );
  }
  if (prevSettings.staleScheduleAlarmMinutes !== newSettings.staleScheduleAlarmMinutes) {
    console.log(
      `[settings] staleScheduleAlarmMinutes → ${newSettings.staleScheduleAlarmMinutes}min `
      + `(was ${prevSettings.staleScheduleAlarmMinutes}min)`,
    );
  }
  if (prevSettings.maxPendingTasks !== newSettings.maxPendingTasks) {
    console.log(
      `[settings] maxPendingTasks → ${newSettings.maxPendingTasks} `
      + `(was ${prevSettings.maxPendingTasks})`,
    );
  }
  if (prevSettings.pendingTaskTtlMinutes !== newSettings.pendingTaskTtlMinutes) {
    console.log(
      `[settings] pendingTaskTtlMinutes → ${newSettings.pendingTaskTtlMinutes}min `
      + `(was ${prevSettings.pendingTaskTtlMinutes}min)`,
    );
  }
  if (prevSettings.finishedAwaitingAckTtlMinutes !== newSettings.finishedAwaitingAckTtlMinutes) {
    console.log(
      `[settings] finishedAwaitingAckTtlMinutes → ${newSettings.finishedAwaitingAckTtlMinutes}min `
      + `(was ${prevSettings.finishedAwaitingAckTtlMinutes}min)`,
    );
  }
  // issue #2170: ack-path reaper knobs read via live getters on the next
  // liveness tick — no reconfigure needed, logged for postmortem visibility.
  if (prevSettings.finishedAwaitingAckAckReaperEnabled !== newSettings.finishedAwaitingAckAckReaperEnabled) {
    console.log(
      `[settings] finishedAwaitingAckAckReaperEnabled → ${newSettings.finishedAwaitingAckAckReaperEnabled} `
      + `(was ${prevSettings.finishedAwaitingAckAckReaperEnabled})`,
    );
  }
  if (prevSettings.finishedAwaitingAckAckReapMinutes !== newSettings.finishedAwaitingAckAckReapMinutes) {
    console.log(
      `[settings] finishedAwaitingAckAckReapMinutes → ${newSettings.finishedAwaitingAckAckReapMinutes}min `
      + `(was ${prevSettings.finishedAwaitingAckAckReapMinutes}min)`,
    );
  }
  if (prevSettings.finishedAwaitingAckAckReapGraceSeconds !== newSettings.finishedAwaitingAckAckReapGraceSeconds) {
    console.log(
      `[settings] finishedAwaitingAckAckReapGraceSeconds → ${newSettings.finishedAwaitingAckAckReapGraceSeconds}s `
      + `(was ${prevSettings.finishedAwaitingAckAckReapGraceSeconds}s)`,
    );
  }
  if (prevSettings.hungSuspectTtlMinutes !== newSettings.hungSuspectTtlMinutes) {
    console.log(
      `[settings] hungSuspectTtlMinutes → ${newSettings.hungSuspectTtlMinutes}min `
      + `(was ${prevSettings.hungSuspectTtlMinutes}min)`,
    );
  }
  if (prevSettings.spawnBurstLimit !== newSettings.spawnBurstLimit) {
    console.log(
      `[settings] spawnBurstLimit → ${newSettings.spawnBurstLimit} `
      + `(was ${prevSettings.spawnBurstLimit})`,
    );
  }
  if (prevSettings.spawnBurstWindowMinutes !== newSettings.spawnBurstWindowMinutes) {
    console.log(
      `[settings] spawnBurstWindowMinutes → ${newSettings.spawnBurstWindowMinutes}min `
      + `(was ${prevSettings.spawnBurstWindowMinutes}min)`,
    );
  }

  // --- Post-merge cleanup budget side effects (issue #1560) ---
  // No reconfigure needed: the liveness tick reads the budget through a live
  // getter each pass, same pattern as the auto-close delay above.
  if (prevSettings.postMergeCleanupBudgetMinutes !== newSettings.postMergeCleanupBudgetMinutes) {
    console.log(
      `[settings] postMergeCleanupBudgetMinutes → ${newSettings.postMergeCleanupBudgetMinutes}min `
      + `(was ${prevSettings.postMergeCleanupBudgetMinutes}min)`,
    );
  }

  return warnings;
}
