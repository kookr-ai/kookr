import type { Context, Hono } from 'hono';
import {
  API_TOKEN_HEADER,
  getAuthThrottleSnapshot,
  parseCookieHeader,
  remoteAddrFromContext,
  resolveActor,
} from '../auth.js';
import {
  PROMETHEUS_CONTENT_TYPE,
  renderPrometheusExposition,
  type RingFleetBudgetMetricsSnapshot,
  type TerminalWriteMetricsSnapshot,
} from '../prometheus-exposition.js';
import { taskSaveMetrics } from '../../core/task-save-metrics.js';
import { buildCapacityLedger, type CapacityLedger } from '../../core/capacity-ledger.js';
import { resolveTaskAttentionSignals } from '../task-attention-signals.js';
import { MAX_ACTIVE_TASKS } from '../config.js';
import type { RouteDeps } from './shared.js';
import type { LessonYieldSnapshot } from '../../core/lesson-decision.js';
import { getGitHubStateFetchFailureSnapshot } from '../../adapters/github-fetcher.js';

export function registerMetricsRoutes(app: Hono, deps: RouteDeps): void {
  app.get('/metrics', (c) => {
    const authResponse = authorizeMetricsRequest(c, deps);
    if (authResponse) return authResponse;

    const requestDurations = deps.requestDurationMetrics?.snapshot() ?? {
      // Direct route tests may register this module without createRoutes(), which
      // normally wires the live request-duration metrics instance.
      schemaVersion: 'request-duration-metrics.v1',
      maxRoutes: 0,
      maxSamplesPerRoute: 0,
      routeCount: 0,
      droppedRouteCount: 0,
      routes: [],
    };

    const nonCriticalTimerPause = deps.nonCriticalTimerPause?.getSnapshot();
    const snapshotShed = deps.snapshotShed?.getSnapshotShedMetrics();
    const finishedAwaitingAckReclaim = deps.finishedAwaitingAckTtlReclaimMetrics?.getSnapshot();
    const hungSuspectReclaim = deps.hungSuspectTtlReclaimMetrics?.getSnapshot();
    const providerPausedOccupancy = deps.providerPausedOccupancyMetrics?.getSnapshot();
    const firstHookMiss = deps.firstHookMissMetrics?.getSnapshot();
    return c.body(renderPrometheusExposition({
      requestDurations,
      toolLatencies: deps.watchdog?.getToolLatencyMetrics().snapshot(),
      circuitBreakers: deps.circuitBreakerRegistry?.getAllSnapshots() ?? [],
      attentionQueueSuppressions: deps.queue?.getSuppressionCounts(),
      auditSinks: deps.auditSinks?.getAllSnapshots() ?? [],
      authThrottle: getAuthThrottleSnapshot(deps.apiAuth),
      webhookDeliveries: deps.webhookNotifier?.getDeliveryCounts(),
      terminalWrite: collectTerminalWriteMetrics(deps),
      terminalInputRtt: deps.terminalInputRttMetrics?.snapshot(),
      // Always-on process-wide ring (issue #1777) — no env flag.
      // Tests may inject deps.taskSaveMetrics to isolate parallel suites.
      taskSave: (deps.taskSaveMetrics ?? taskSaveMetrics).snapshot(),
      ringFleetBudget: collectRingFleetBudgetMetrics(deps),
      // Same buildCapacityLedger path as GET /api/health (issue #1856).
      capacity: collectCapacityLedger(deps),
      // Pure read of the last warm 24h health-cache snapshot (issue #1857).
      // Never scans hook logs on the scrape path — cold cache omits series.
      lessonYield: collectLessonYield(deps),
      // Health-body cache timing gauges (issue #2497). Pure read of the shared
      // stats the diagnostics route records on each assembly — cold cache (never
      // assembled) omits the series.
      healthBodyCache: deps.healthBodyCacheStats?.snapshot(deps.nowMs?.() ?? Date.now()),
      ...(finishedAwaitingAckReclaim
        ? {
            finishedAwaitingAckReclaim: {
              reclaimedTotal: finishedAwaitingAckReclaim.reclaimedTotal,
              reclaimAttempted: finishedAwaitingAckReclaim.reclaimAttempted,
              reclaimSucceeded: finishedAwaitingAckReclaim.reclaimSucceeded,
              capacityPressureEarlyReclaimedTotal:
                finishedAwaitingAckReclaim.capacityPressureEarlyReclaimedTotal,
              skippedBadRaisedAt: finishedAwaitingAckReclaim.skippedBadRaisedAt,
              skippedOpenPrFailsafe: finishedAwaitingAckReclaim.skippedOpenPrFailsafe,
              skippedOpenPrConfirmed: finishedAwaitingAckReclaim.skippedOpenPrConfirmed,
              skippedOpenPrUnknown: finishedAwaitingAckReclaim.skippedOpenPrUnknown,
              skippedUnderTtl: finishedAwaitingAckReclaim.skippedUnderTtl,
              autoCompletedTotal: finishedAwaitingAckReclaim.autoCompletedTotal,
              autoCompleteDeferredTotal: finishedAwaitingAckReclaim.autoCompleteDeferredTotal,
              autoCompleteAgeHistogram: finishedAwaitingAckReclaim.autoCompleteAgeHistogram,
            },
          }
        : {}),
      ...(hungSuspectReclaim
        ? {
            hungSuspectReclaim: {
              reclaimedTotal: hungSuspectReclaim.reclaimedTotal,
              reclaimAttempted: hungSuspectReclaim.reclaimAttempted,
              reclaimSucceeded: hungSuspectReclaim.reclaimSucceeded,
              skippedNoLiveness: hungSuspectReclaim.skippedNoLiveness,
              skippedOpenPrFailsafe: hungSuspectReclaim.skippedOpenPrFailsafe,
              skippedOpenPrConfirmed: hungSuspectReclaim.skippedOpenPrConfirmed,
              skippedOpenPrUnknown: hungSuspectReclaim.skippedOpenPrUnknown,
              skippedUnderTtl: hungSuspectReclaim.skippedUnderTtl,
              skippedExemptAnomaly: hungSuspectReclaim.skippedExemptAnomaly,
              skippedProviderPaused: hungSuspectReclaim.skippedProviderPaused,
            },
          }
        : {}),
      ...(providerPausedOccupancy
        ? {
            providerPausedOccupancy: {
              count: providerPausedOccupancy.count,
              oldestPauseAgeMs: providerPausedOccupancy.oldestPauseAgeMs,
              reclaimedTotal: providerPausedOccupancy.reclaimedTotal,
              reclaimAttempted: providerPausedOccupancy.reclaimAttempted,
              reclaimSucceeded: providerPausedOccupancy.reclaimSucceeded,
              skippedUnderTtl: providerPausedOccupancy.skippedUnderTtl,
              skippedOpenPrFailsafe: providerPausedOccupancy.skippedOpenPrFailsafe,
              skippedOpenPrConfirmed: providerPausedOccupancy.skippedOpenPrConfirmed,
              skippedOpenPrUnknown: providerPausedOccupancy.skippedOpenPrUnknown,
              skippedNoPauseStart: providerPausedOccupancy.skippedNoPauseStart,
              skippedAwaitingProviderReset:
                providerPausedOccupancy.skippedAwaitingProviderReset,
            },
          }
        : {}),
      ...(firstHookMiss
        ? { firstHookMiss: { firstHookMissTotal: firstHookMiss.firstHookMissTotal } }
        : {}),
      ...(nonCriticalTimerPause
        ? {
            nonCriticalTimerPause: {
              paused: nonCriticalTimerPause.paused,
              thresholdMs: nonCriticalTimerPause.thresholdMs,
              lastEventLoopDelayP95Ms: nonCriticalTimerPause.lastEventLoopDelayP95Ms,
              pausedTicksTotal: nonCriticalTimerPause.pausedTicksTotal,
            },
          }
        : {}),
      ...(snapshotShed
        ? {
            snapshotShed: {
              thresholdMs: snapshotShed.thresholdMs,
              lastEventLoopDelayP95Ms: snapshotShed.lastEventLoopDelayP95Ms,
              shedTotal: snapshotShed.shedTotal,
              gateShedTotal: snapshotShed.gateShedTotal,
            },
          }
        : {}),
      // Module-level process counters (issue #1946) — always-on, no deps wiring.
      githubStateFetchFailures: getGitHubStateFetchFailureSnapshot(),
    }), 200, {
      'Content-Type': PROMETHEUS_CONTENT_TYPE,
    });
  });
}

/**
 * Build the live capacity ledger for `/metrics` using the same inputs as
 * `GET /api/health` (issue #1856). Returns a zeroed ledger when `taskStore`
 * is not wired (lightweight unit harnesses).
 */
export function collectCapacityLedger(deps: Pick<
  RouteDeps,
  'taskStore' | 'queue' | 'watchdog' | 'getMaxActiveTasks' | 'settings'
>): CapacityLedger {
  const capacitySampledAtMs = Date.now();
  const maxActiveTasks = deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
  const tasks = deps.taskStore?.listTasks() ?? [];
  const reservationSettings = deps.settings?.get();
  return buildCapacityLedger(tasks, {
    now: capacitySampledAtMs,
    maxActiveTasks,
    isHungSuspect: (task) =>
      resolveTaskAttentionSignals(
        task,
        { queue: deps.queue, watchdog: deps.watchdog },
        capacitySampledAtMs,
      ).hungSuspect,
    isLaunching: (task) => deps.taskStore?.hasFreshLaunchReservation(task.id) ?? false,
    ...(reservationSettings
      ? {
          reservedActiveSlots: reservationSettings.reservedActiveSlots,
          reservedSlotSources: reservationSettings.reservedSlotSources,
        }
      : {}),
  });
}

/** Assemble terminalWrite saturation gauges from backend + coordinator (issue #1776). */
export function collectTerminalWriteMetrics(deps: Pick<
  RouteDeps,
  'terminalBackend' | 'terminalInputCoordinator'
>): TerminalWriteMetricsSnapshot {
  const backend = deps.terminalBackend?.getStats();
  const coordinator = deps.terminalInputCoordinator?.getWriteMetrics();
  return {
    pendingWriters: backend?.pendingWriters ?? 0,
    maxPendingWriters: backend?.maxPendingWriters ?? 0,
    writeTimeoutCount: backend?.writeTimeoutCount ?? 0,
    pendingWrites: coordinator?.pendingWrites ?? 0,
    maxPendingWrites: coordinator?.maxPendingWrites ?? 0,
  };
}

/** Assemble fleet ring budget pressure gauges (issue #1779). Always-on zeros. */
export function collectRingFleetBudgetMetrics(deps: Pick<
  RouteDeps,
  'terminalBackend'
>): RingFleetBudgetMetricsSnapshot {
  const backend = deps.terminalBackend?.getStats();
  return {
    ringFleetBytes: backend?.ringFleetBytes ?? 0,
    ringFleetBudgetBytes: backend?.ringFleetBudgetBytes ?? 0,
    ringFleetOverBudgetBytes: backend?.ringFleetOverBudgetBytes ?? 0,
    ringShrunkenSessions: backend?.ringShrunkenSessions ?? 0,
    ringShrinkCount: backend?.ringShrinkCount ?? 0,
  };
}

/**
 * Pure read of the last warm 24h lesson-yield health-cache snapshot for
 * `/metrics` (issue #1857). Returns undefined when cold so series are omitted.
 * Must never scan hook logs — reuse diagnostics' cache only.
 */
export function collectLessonYield(deps: Pick<
  RouteDeps,
  'lessonYieldHealth'
>): LessonYieldSnapshot | undefined {
  return deps.lessonYieldHealth?.getCached24h();
}

function authorizeMetricsRequest(c: Context, deps: RouteDeps): Response | undefined {
  const apiAuth = deps.apiAuth;
  if (!apiAuth?.required || !apiAuth.token) return undefined;

  const actor = resolveActor(apiAuth, {
    authorization: c.req.header('authorization'),
    apiTokenHeader: c.req.header(API_TOKEN_HEADER),
    cookies: parseCookieHeader(c.req.header('cookie')),
    remoteAddr: remoteAddrFromContext(c),
  });
  if (!actor) return c.json({ error: 'unauthorized' }, 401);
  if (actor.kind !== 'owner') return c.json({ error: 'forbidden' }, 403);
  c.set('actor', actor);
  return undefined;
}
