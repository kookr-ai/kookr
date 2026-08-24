import type { TaskStore } from '../core/tasks.js';
import type { LaunchOpts, LaunchResult } from './launch-service.js';
import type {
  ProviderTransientRetryRequest,
  ProviderTransientAlertRequest,
} from '../core/silent-failure-classifier.js';
import { isValidLaunchPin } from '../shared/contracts/agent-types.js';

/**
 * Bounded auto-retry + operator-alert handlers for `provider_transient` silent
 * failures (issue #1712). Extracted from the composition root so the
 * setTimeout/re-launch logic is unit-testable in isolation: the completion path
 * (`agent-lifecycle.completeTask`) only sees the two hook signatures.
 *
 * A retry re-fires the ORIGINAL failing task's work as a fresh schedule-tagged
 * launch, carrying `retryOf`/`retryAttempt` lineage so a second failure knows
 * it has spent its budget. Every failure mode is swallowed and logged — a retry
 * that cannot launch must never throw back into the terminal-classification
 * path, and the schedule's own next cron remains the backstop.
 */

export interface ProviderTransientRetryDeps {
  taskStore: Pick<TaskStore, 'getTask' | 'setRetryLineage'>;
  /** Launch a fresh task. The composition root binds this to the real launch service. */
  launchTask: (opts: LaunchOpts) => Promise<LaunchResult>;
  /**
   * Timer used to apply the backoff. Injectable for tests; defaults to an
   * unref'd `setTimeout` so a pending retry never keeps the process alive.
   */
  setTimeoutFn?: (cb: () => void, ms: number) => void;
  logger?: Pick<Console, 'warn' | 'log'>;
}

function defaultSetTimeout(cb: () => void, ms: number): void {
  const handle = setTimeout(cb, ms);
  // Node's Timeout has unref(); guard for non-Node timer shims.
  (handle as { unref?: () => void }).unref?.();
}

/**
 * Build the retry hook. Reads the ORIGINAL task's launch shape, waits out the
 * backoff, then spawns a schedule-provenance retry with lineage stamped.
 */
export function createProviderTransientRetryHandler(
  deps: ProviderTransientRetryDeps,
): (req: ProviderTransientRetryRequest) => void {
  const schedule = deps.setTimeoutFn ?? defaultSetTimeout;
  const logger = deps.logger ?? console;

  return (req: ProviderTransientRetryRequest): void => {
    const original = deps.taskStore.getTask(req.originalTaskId);
    if (!original) {
      logger.warn(`[provider-transient-retry] original task ${req.originalTaskId} gone; skipping retry`);
      return;
    }
    // Only schedule-provenance work is auto-retried (the classifier already
    // enforces this, but the launch shape depends on it, so re-check here).
    const scheduleId = original.provenance?.kind === 'schedule' ? original.provenance.sourceId : undefined;
    const launchPins = original.metadata?.launchPins;
    if (launchPins?.state === 'unknown' || launchPins?.state === 'malformed'
      || (launchPins?.state === 'known-pinned'
        && ((launchPins.effort !== undefined && !isValidLaunchPin(launchPins.effort))
          || (launchPins.model !== undefined && !isValidLaunchPin(launchPins.model))))) {
      logger.warn(`[provider-transient-retry] task ${req.originalTaskId} has unsafe launch pins; skipping automatic retry`);
      return;
    }
    const knownLaunchPins = launchPins?.state === 'known-pinned' ? launchPins : undefined;

    const launchOpts: LaunchOpts = {
      prompt: original.prompt,
      cwd: original.cwd,
      ...(original.criteria ? { criteria: original.criteria } : {}),
      ...(original.name ? { name: original.name } : {}),
      ...(original.playbookId ? { playbookId: original.playbookId } : {}),
      ...(original.playbookParameterValues ? { playbookParameterValues: original.playbookParameterValues } : {}),
      ...(original.projectId ? { projectId: original.projectId } : {}),
      agentType: original.agentType,
      ...(knownLaunchPins?.effort !== undefined ? { effort: knownLaunchPins.effort } : {}),
      ...(knownLaunchPins?.model !== undefined ? { model: knownLaunchPins.model } : {}),
      // A retry is always a distinct fire — never dedup it onto the failed task.
      disableDedup: true,
      launchSource: 'schedule',
      ...(scheduleId ? { scheduleId } : {}),
      // Inherit the auto-close policy so the retry self-releases like the fire it replaces.
      ...(original.autoCloseOnSignal !== undefined ? { autoCloseOnSignal: original.autoCloseOnSignal } : {}),
    };

    schedule(() => {
      void (async () => {
        try {
          const result = await deps.launchTask(launchOpts);
          deps.taskStore.setRetryLineage(result.task.id, {
            retryOf: req.originalTaskId,
            retryAttempt: req.attempt,
          });
          logger.log(
            `[provider-transient-retry] attempt ${req.attempt} for ${req.originalTaskId} → task ${result.task.id}`,
          );
        } catch (err) {
          logger.warn(
            `[provider-transient-retry] attempt ${req.attempt} for ${req.originalTaskId} failed to launch:`,
            err instanceof Error ? err.message : err,
          );
        }
      })();
    }, req.delayMs);
  };
}

export interface ProviderTransientAlertDeps {
  /**
   * Raise a durable operator alert. The composition root binds this to a
   * critical dashboard broadcast — the 2026-07-30 incident starved silently
   * because an exhausted retryable failure produced no operator signal at all.
   */
  enqueueAlert: (input: { taskId: string; note: string }) => void | Promise<void>;
  logger?: Pick<Console, 'warn'>;
}

/**
 * Build the exhaustion-alert hook. Emits one durable operator alert when a
 * provider-transient failure has spent its retry budget.
 */
export function createProviderTransientAlertHandler(
  deps: ProviderTransientAlertDeps,
): (req: ProviderTransientAlertRequest) => Promise<void> {
  const logger = deps.logger ?? console;
  return async (req: ProviderTransientAlertRequest): Promise<void> => {
    const note =
      `Scheduled task ${req.originalTaskId} failed with a provider-transient error ` +
      `after ${req.attempts} auto-retr${req.attempts === 1 ? 'y' : 'ies'} — needs operator attention` +
      (req.reason ? ` (${req.reason})` : '');
    try {
      await deps.enqueueAlert({ taskId: req.failedTaskId, note });
    } catch (err) {
      logger.warn(
        `[provider-transient-retry] alert enqueue failed for ${req.failedTaskId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  };
}
