import type { TaskStore } from '../core/tasks.js';
import type { LaunchOpts, LaunchResult, LaunchTaskServerOptions } from './launch-service.js';
import { resolveScheduleAutomationProjectId } from '../core/automation-kill-switch.js';
import { getProjectId } from '../core/project-identity.js';
import type {
  ProviderTransientRetryRequest,
  ProviderTransientAlertRequest,
} from '../core/silent-failure-classifier.js';
import { launchIntentPins, validatePersistedLaunchIntent } from '../core/task-launch-intent.js';

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
  taskStore: Pick<TaskStore, 'getTask' | 'setRetryLineage'>
    & Partial<Pick<TaskStore, 'setRelaunchDisposition'>>;
  /** Launch a fresh task. The composition root binds this to the real launch service. */
  launchTask: (opts: LaunchOpts, serverOpts?: LaunchTaskServerOptions) => Promise<LaunchResult>;
  /** Test seam; default is basename map then getProjectId(cwd). */
  resolveAutomationProjectId?: (opts: LaunchOpts) => string | Promise<string>;
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
    const intent = validatePersistedLaunchIntent(original);
    if (!intent.ok) {
      deps.taskStore.setRelaunchDisposition?.(original.id, {
        outcome: 'not_relaunched',
        source: 'provider-transient-retry',
        reason: intent.reason,
        at: new Date().toISOString(),
        detail: intent.detail,
      });
      logger.warn(`[provider-transient-retry] task ${original.id} has no replayable launch intent; skipping retry: ${intent.detail}`);
      return;
    }
    const pins = launchIntentPins(intent.intent);
    const replayTier = intent.intent.modelTier;

    const launchOpts: LaunchOpts = {
      prompt: intent.intent.prompt ?? original.prompt,
      cwd: intent.intent.cwd ?? original.cwd,
      ...(original.criteria ? { criteria: original.criteria } : {}),
      ...(original.name ? { name: original.name } : {}),
      ...(original.playbookId ? { playbookId: original.playbookId } : {}),
      ...(original.playbookSource ? { playbookSource: structuredClone(original.playbookSource) } : {}),
      ...(original.playbookParameterValues ? { playbookParameterValues: original.playbookParameterValues } : {}),
      ...((intent.intent.projectId ?? original.projectId)
        ? { projectId: intent.intent.projectId ?? original.projectId }
        : {}),
      agentType: intent.intent.agentType,
      ...(replayTier !== undefined
        ? { modelTier: replayTier }
        : {
            ...(pins.model !== undefined ? { model: pins.model } : {}),
            ...(pins.effort !== undefined ? { effort: pins.effort } : {}),
          }),
      ...(intent.intent.ralphVerdictEnv ? { ralphVerdictEnv: true } : {}),
      ...(intent.intent.dependencies ? { dependencies: [...intent.intent.dependencies] } : {}),
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
          const projectId = deps.resolveAutomationProjectId
            ? await deps.resolveAutomationProjectId(launchOpts)
            : resolveScheduleAutomationProjectId({
                playbookPath: original.playbookId,
                cwdProjectId: await getProjectId(launchOpts.cwd),
              });
          const result = await deps.launchTask(launchOpts, { automationProjectId: projectId });
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
