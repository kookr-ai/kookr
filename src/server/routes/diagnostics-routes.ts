import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { accessSync, constants as fsConstants } from 'node:fs';
import { timingSafeTokenEqual } from '../admin-token.js';
import { readInteractionLog } from '../../core/interaction-log.js';
import { computeTimeToUnblockFromDir } from '../../core/time-to-unblock.js';
import { emptyTimeToUnblockSnapshot, TIME_TO_UNBLOCK_WINDOW_MS } from '../../shared/contracts/time-to-unblock.js';
import { readTelemetryLog } from '../../core/telemetry.js';
import { analyzeSession } from '../../core/friction-analyzer.js';
import { buildLiveFrictionCalibrationSnapshot } from '../../core/live-friction-calibration.js';
import { getDetectionStats } from '../../core/detection-stats.js';
import { getStuckFlagPrecision } from '../../core/stuck-flag-precision.js';
import { buildLaunchDependencyDiagnostics } from '../../core/launch-dependency-diagnostics.js';
import { aggregateTerminalOutcomes } from '../../core/terminal-receipt.js';
import {
  generateReportFromFile,
  formatReport,
  DEFAULT_SHADOW_REPORT_MAX_BYTES,
  DEFAULT_SHADOW_REPORT_MAX_ENTRIES,
  DEFAULT_SHADOW_REPORT_MAX_AGE_MS,
  type ShadowReport,
} from '../../core/shadow-report.js';
import { getSnapshotAgentsRaw } from '../use-cases/get-snapshot.js';
import { buildReflectionRecommendationResponse } from '../reflection-task.js';
import {
  FindingEvidenceReviewService,
  FindingEvidenceReviewServiceError,
  getOrCreateFindingEvidenceReviewHmacKey,
  readFindingEvidenceReviewConfigFromEnv,
  type FindingEvidenceReviewMode,
  type FindingEvidenceReviewServiceConfig,
} from '../finding-evidence-review-service.js';
import { ReviewLogStore } from '../review-log-store.js';
import { buildDetectorProposalReportResponseV1 } from '../detector-proposal-report.js';
import { REQUEST_LATENCIES_ROUTE } from '../request-duration-metrics.js';
import {
  CONTROL_PLANE_LATENCIES_ROUTE,
  EMPTY_CONTROL_PLANE_LATENCY_SNAPSHOT,
} from '../control-plane-latency-metrics.js';
import {
  LAUNCH_OUTCOMES_ROUTE,
  emptyLaunchOutcomeMetricsSnapshot,
} from '../../core/launch-outcome-metrics.js';
import { HOT_PATHS_ROUTE, getHotPathSampler } from '../../core/hot-path-sampler.js';
import { EMPTY_TERMINAL_INPUT_RTT_SNAPSHOT } from '../terminal-input-rtt-metrics.js';
import { splitHookRequestBody } from '../hook-record-framing.js';
import type { BackendStats } from '../../adapters/terminal-backend.js';
import { probeSttHealth } from '../../adapters/circuit-breaker-stt-client.js';
import { validateSpeechServiceUrl } from '../speech-service-url.js';
import type { RouteDeps } from './shared.js';
import { isCrashLoopSkipReason, type CrashRecoveryResult } from '../crash-recovery.js';
import type { HookIngestionDiagnosticsSnapshot } from '../hook-ingestion.js';
import type { HookWatcherHealthSnapshot } from '../hook-watcher.js';
import { getAuthThrottleSnapshot } from '../auth.js';
import { DELIVERY_TRACE_SCHEMA_VERSION, type DeliveryTraceFilter } from '../../shared/contracts/delivery-trace.js';
import { SESSION_HEALTH_SCHEMA_VERSION } from '../../shared/contracts/session-health.js';
import { TIMER_HEALTH_SCHEMA_VERSION } from '../../shared/contracts/timer-health.js';
import {
  EMPTY_TIMER_HEALTH_SUMMARY,
  summarizeTimerHealth,
} from '../../core/timer-health.js';
import type { ScheduleStatusSnapshot } from '../../shared/contracts/schedule.js';
import type { SystemResourceStatus } from '../../shared/contracts/messages.js';
import {
  buildCapacityLedger,
  buildVettedIdeaRunwayReport,
  evaluateCapacityThroughputVerdict,
  evaluateHungSuspectCapacityFinding,
  evaluateIdleCapacityFinding,
  resolveIdleCapacitySignalInputs,
} from '../../core/capacity-ledger.js';
import { resolveTaskAttentionSignals } from '../task-attention-signals.js';
import { MAX_ACTIVE_TASKS } from '../config.js';
import {
  computeLessonYield,
  hooksDirFromKookrDir,
  type LessonYieldSnapshot,
} from '../../core/lesson-decision.js';
import { summarizeOssAttemptsForHealth } from '../oss-attempts-snapshot.js';
import { buildSystemdNotifierHealthBlock } from '../systemd-notify.js';
import { LessonYieldHealthCache } from '../lesson-yield-health-cache.js';
import { HealthBodyCacheStats } from '../health-body-cache-stats.js';
import { LastGoodHealthWriter, readLastGoodHealth } from '../last-good-health.js';
import {
  buildControlPlaneCollectionBlock,
  collectBounded,
  hookLagFreshnessFromSnapshot,
  raceWithDeadline,
  type ControlPlaneCollectionBlock,
  type DeadlineResult,
} from '../control-plane-health.js';
import { computeCiBlindDebt, type CiBlindDebt } from '../../core/ci-blind-debt.js';
import {
  formatProjectAutomationDigestLine,
  formatSafeModeDigestLine,
  resolveSafeModeStatus,
} from '../../core/automation-kill-switch.js';
import {
  buildPauseProvenance,
  evaluateSoftQuotaPause,
  getCurrentPauseRecord,
  resolveDefaultAgentQuotaSample,
  type OrchestrationQuotaSample,
} from '../../core/orchestration-pause.js';
import { readPauseStateSync } from '../orchestration-pause-service.js';
import {
  defaultRetroVerifyQueueDir,
  readPendingRetroVerify,
} from '../../core/retro-verify-queue.js';
import {
  listPipelineStarvationHealth,
  type PipelineStarvationHealthRepo,
} from '../../core/pipeline-starvation-state.js';
import type { InventPriorityClassHealthSnapshot } from '../invent-priority-health-refresher.js';
import { defaultPipelineStarvationStateDir } from '../../core/pipeline-starvation.js';
import {
  evaluateRelayOrphanBound,
  resolveRelayOrphanBound,
  type StaleProcessSummary,
} from '../../core/orphan-process-scanner.js';
import {
  createStaleProcessSummaryCache,
  type StaleProcessSummaryCache,
} from '../stale-dtach-pressure.js';
import { SCHEDULE_TICK_INTERVAL_MS } from '../schedule-runner.js';
import { getHelperLlmHealthSnapshot } from '../../core/llm-factory.js';

/**
 * How many missed schedule-runner tick intervals make GET `/api/ready`
 * `schedulerTick` critical-not-ready (issue #1707 / #1699 WS0). Two intervals
 * (~2 min at the default 60s cadence) is long enough that a single slow tick
 * does not flap readiness, and short enough that a dead tick loop is
 * visible to a process supervisor within a couple of minutes.
 */
export const SCHEDULER_TICK_STALE_INTERVALS = 2;

/**
 * How many paused-schedule names GET `/api/ready` `schedulesPaused.detail`
 * lists before collapsing the rest to "+N more" (issue #2427). Matches the
 * doctor / status-bar sample so a cheap probe names the same few schedules
 * an operator would see on those surfaces.
 */
export const PAUSED_SCHEDULES_READY_SAMPLE_LIMIT = 3;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REVIEW_ADMIN_TOKEN_HEADER = 'x-kookr-admin-token';
const REVIEW_CSRF_HEADER = 'x-kookr-finding-review-token';
const DEFAULT_HOOK_INGESTION_LAG_WARNING_THRESHOLD_MS = 2_000;
/** Cache TTL for lessonYield snapshots (per window; hook scans can be heavy). */
const LESSON_YIELD_CACHE_MS = 60_000;
const MAX_LESSON_YIELD_DAYS = 30;
/**
 * Hard ceiling for one lesson-yield hook-log scan (issue #1553). The hooks
 * corpus can reach gigabytes; an unbounded scan on the health hot path
 * saturated the main thread and OOM-crashed prod on 2026-07-26.
 */
const LESSON_YIELD_SCAN_TIMEOUT_MS = 30_000;
/**
 * Request-path budget for GET /api/diagnostics/lesson-yield on a cold cache
 * (issue #1585). The scan itself is bounded at LESSON_YIELD_SCAN_TIMEOUT_MS,
 * but 30s far exceeds a diagnostics endpoint's latency budget (prod re-confirmed
 * the request hangs past a 10s curl cap on 2026-07-26). The request path waits
 * at most this long for a first scan, then returns a 503 `lesson_yield_warming`
 * while the bounded scan finishes in the background and warms the cache for the
 * retry. Kept comfortably under the 10s acceptance ceiling.
 */
export const LESSON_YIELD_REQUEST_BUDGET_MS = 8_000;
/** After a failed/timed-out background refresh, do not retry before this. */
const LESSON_YIELD_REFRESH_FAILURE_BACKOFF_MS = 5 * 60_000;
/**
 * Cache TTL for GET /api/shadow-report (issue #1764). Report generation reads
 * a bounded tail of shadow-detection.jsonl; re-parsing on every dashboard
 * poll is pure waste and concurrent full parses were the OOM driver.
 */
const SHADOW_REPORT_CACHE_MS = 60_000;
/**
 * Cold-cache request budget for /api/shadow-report. The parse itself is
 * byte-bounded, but a first request must not pin the event loop past a
 * diagnostics latency budget while retries stack (the #1764 crash pattern).
 */
export const SHADOW_REPORT_REQUEST_BUDGET_MS = 8_000;
/**
 * Cache TTL for the assembled GET /api/health JSON body (issue #2429).
 * Concurrent diagnosis tools were stampeding `viewTasks()` and the rest of
 * the health walk; a 5s probe timed out with 0 bytes while a retry needed
 * 4s for 14KB. Gauges in a cached body can be up to this stale. Do not
 * apply this cache to GET /api/ready — readiness must stay a cheap live
 * verdict.
 */
export const HEALTH_BODY_CACHE_MS = 1_000;
/**
 * Per-component budget for the disk-backed reads inside a health assembly
 * (issue #2798): the retro-verify spool and pipeline-starvation state files. A
 * read slower than this degrades only its own block (recorded in
 * `controlPlane.timedOutComponents`) instead of stalling the whole assembly —
 * the in-memory gauges (agents, capacity, sessions) still collect and are never
 * zeroed by one slow provider. Comfortably under HEALTH_ASSEMBLY_DEADLINE_MS.
 */
export const HEALTH_COMPONENT_BUDGET_MS = 1_500;
/**
 * Cold-cache request budget for GET /api/health (issue #2798). With no cached
 * body to serve stale, the first caller would otherwise await the full assembly
 * with no bound. If the assembly does not finish within this deadline, the
 * request serves the on-disk last-good snapshot (worker/session counts intact)
 * marked `controlPlane.source: "last-good"`, or a typed `unavailable` body when
 * no last-good exists — never a hang, and never fabricated zero counts. The
 * single-flight assembly keeps running so the next poll recovers to live data.
 */
export const HEALTH_ASSEMBLY_DEADLINE_MS = 2_500;

export function registerDiagnosticsRoutes(app: Hono, deps: RouteDeps): void {
  const { taskStore, queue, adapter, interactionLog, githubScanner, githubStateStore, buildInfo, serverStartedAt } = deps;
  let findingEvidenceReviewService: FindingEvidenceReviewService | undefined;
  let findingEvidenceReviewConfig: FindingEvidenceReviewServiceConfig | undefined;
  let findingEvidenceReviewLogStore: ReviewLogStore | undefined;
  // Issue #1538: cache lesson-yield snapshots so a frequent dashboard poll does
  // not re-scan every hook log every time. Keyed by window length in days so
  // /api/health (1d) and GET /api/diagnostics/lesson-yield?days=N share the
  // same single-flight + cache machinery.
  // Issue #1553: the /api/health request path NEVER awaits a scan — it serves
  // the cache stale-while-revalidate and a single-flight background scan
  // repopulates it. Awaiting the scan inline pinned the event loop against a
  // multi-GB hooks dir and OOM-crashed prod on 2026-07-26.
  // Issue #1585: the diagnostics request path is now cache-first too and waits
  // at most LESSON_YIELD_REQUEST_BUDGET_MS for a cold scan (never the full 30s
  // scan bound), so the endpoint can no longer hang.
  // Issue #1857: same cache instance is exposed on RouteDeps so `/metrics` can
  // render gauges from the last warm days=1 snapshot without scanning.
  const lessonYieldCache = deps.lessonYieldHealth ?? new LessonYieldHealthCache();
  let lessonYieldRefreshNotBeforeMs = 0;
  const lessonYieldScansInFlight = new Map<number, Promise<LessonYieldSnapshot>>();

  // Stale-process gauge (issues #1723 item 4, #2350): relay-server + dtach
  // class counts and RSS, so orphan accumulation is visible before it OOMs
  // anything. Served stale-while-revalidate via the shared
  // {@link StaleProcessSummaryCache} also used by the session reaper and
  // resource-watchdog pressure readers — one /proc walk per TTL window.
  // The request path NEVER awaits a /proc walk (issue #1553 lesson).
  const staleProcessSummaryCache: StaleProcessSummaryCache =
    deps.staleProcessSummaryCache ?? createStaleProcessSummaryCache();
  function getStaleProcessSummary(): StaleProcessSummary | null {
    return staleProcessSummaryCache.getSummary();
  }

  // Shadow report (issue #1764): bound parse + stale-while-revalidate +
  // single-flight. Concurrent full-file parses of a 172 MB+ log were the
  // 2026-08-01 OOM driver — one wedged request made the dashboard retry and
  // stack more parses until the heap limit.
  let shadowReportCache:
    | { expiresAtMs: number; logPath: string; report: ShadowReport }
    | undefined;
  let shadowReportInFlight: Promise<ShadowReport> | null = null;

  function runShadowReportScan(logPath: string): Promise<ShadowReport> {
    if (shadowReportInFlight) return shadowReportInFlight;
    const scan = generateReportFromFile(logPath, {
      maxBytes: DEFAULT_SHADOW_REPORT_MAX_BYTES,
      maxEntries: DEFAULT_SHADOW_REPORT_MAX_ENTRIES,
      maxAgeMs: DEFAULT_SHADOW_REPORT_MAX_AGE_MS,
    }).then((report) => {
      shadowReportCache = {
        expiresAtMs: Date.now() + SHADOW_REPORT_CACHE_MS,
        logPath,
        report,
      };
      return report;
    }).finally(() => {
      shadowReportInFlight = null;
    });
    shadowReportInFlight = scan;
    return scan;
  }

  /**
   * Single-flight lesson-yield scan per window length, hard-bounded by
   * LESSON_YIELD_SCAN_TIMEOUT_MS. Shared by the /api/health background
   * refresh and GET /api/diagnostics/lesson-yield so concurrent callers can
   * never stack duplicate scans. A completed scan warms the per-window cache
   * as a side effect.
   */
  function runLessonYieldScan(days: number): Promise<LessonYieldSnapshot> {
    const inFlight = lessonYieldScansInFlight.get(days);
    if (inFlight) return inFlight;
    const kookrDir = deps.kookrDir;
    if (!kookrDir) return Promise.reject(new Error('kookrDir unavailable'));
    const scan = computeLessonYield(
      // Cold/background path: cloning is fine here (not on the 1–5s timer /
      // terminal I/O path). Some scan helpers assume detached records.
      taskStore.listTasks(),
      hooksDirFromKookrDir(kookrDir),
      { days, signal: AbortSignal.timeout(LESSON_YIELD_SCAN_TIMEOUT_MS) },
    ).then((snapshot) => {
      lessonYieldCache.set(days, snapshot, Date.now() + LESSON_YIELD_CACHE_MS);
      return snapshot;
    }).finally(() => {
      lessonYieldScansInFlight.delete(days);
    });
    lessonYieldScansInFlight.set(days, scan);
    return scan;
  }

  // Issue #2429 + #2492: one assembled health body is reused for ~1s (TTL) and
  // while a rebuild is already in flight (single-flight). After the TTL expires
  // this is now true stale-while-revalidate (issue #2492): the next caller gets
  // the previous body immediately and one background assembly is kicked off to
  // refresh it, so concurrent Lucy/doctor/status probes never stack on the
  // expensive walk. Only a genuinely cold cache (nothing ever assembled) waits.
  // This helps the stampede-before-wedge case; it cannot heal a fully wedged
  // event loop (#2167). Overlapping probes must not start a second copy.
  // `cachedAtMs`/`assemblyMs` back the health-cache gauges (issue #2497).
  // /api/ready is intentionally uncached — see the route below.
  let healthBodyCache:
    | { cachedAtMs: number; expiresAtMs: number; assemblyMs: number; body: Record<string, unknown> }
    | undefined;
  let healthBodyInFlight: Promise<Record<string, unknown>> | undefined;
  const healthBodyStats = deps.healthBodyCacheStats ?? new HealthBodyCacheStats();
  // Last-good health mirror (issue #2495): after each successful assembly, drop
  // a redacted, size-capped copy on disk so an offline digest (`kookr ops digest
  // --offline`) can still quote a recent body + its mtime when the HTTP surface
  // is dark. Writer throttles itself (5s / gauge-edge) and never throws. Absent
  // when kookrDir is unwired (tests / non-server hosts) or a writer is injected.
  const lastGoodHealthWriter = deps.lastGoodHealthWriter
    ?? (deps.kookrDir ? new LastGoodHealthWriter({ kookrDir: deps.kookrDir }) : undefined);
  // #2492 SWR background-refresh scheduler. Default: setImmediate, so the refresh
  // runs on a later macrotask (after the stale body is returned and flushed) and
  // never on the request path. Injectable so tests drive it deterministically.
  const scheduleHealthRefresh: (task: () => void) => void =
    deps.healthRefreshScheduler ?? ((task) => { setImmediate(task); });

  async function assembleHealthBody(): Promise<Record<string, unknown>> {
    const terminalBackend = deps.terminalBackend;
    const backendWriteStats = terminalBackend?.getStats();
    let terminalBackendBlock: object | undefined;
    if (backendWriteStats) {
      terminalBackendBlock = {
        status: deriveTerminalBackendStatus(backendWriteStats),
        attachedSessions: backendWriteStats.attachedSessions,
        reattachCounts: backendWriteStats.reattachCounts,
        pendingWriters: backendWriteStats.pendingWriters,
        maxPendingWriters: backendWriteStats.maxPendingWriters,
        writeTimeoutCount: backendWriteStats.writeTimeoutCount,
        lastError: backendWriteStats.lastError,
        errorCount: backendWriteStats.errorCount,
        // Recovery recency (issue #2810): `lastError` is cleared once a
        // transient session fault recovers, so these timestamps let an operator
        // tell a fresh fault (lastErrorAt newer) from a recovered one.
        lastErrorAt: backendWriteStats.lastErrorAt ?? null,
        lastRecoveredAt: backendWriteStats.lastRecoveredAt ?? null,
        // Fleet ring budget pressure (issue #1779) — always present on the
        // live backend path so operators can chart zeros without a secret env.
        ringFleetBytes: backendWriteStats.ringFleetBytes ?? 0,
        ringFleetBudgetBytes: backendWriteStats.ringFleetBudgetBytes ?? 0,
        ringFleetOverBudgetBytes: backendWriteStats.ringFleetOverBudgetBytes ?? 0,
        ringShrunkenSessions: backendWriteStats.ringShrunkenSessions ?? 0,
        ringShrinkCount: backendWriteStats.ringShrinkCount ?? 0,
        // Launch recovery is an exact manifest/task handoff (#2762), distinct
        // from the generic host-stale and orphan process reapers.
        launchAbandonedRecoveredCount: backendWriteStats.launchAbandonedRecoveredCount ?? 0,
        launchAbandonedRecoveryFailureCount:
          backendWriteStats.launchAbandonedRecoveryFailureCount ?? 0,
      };
    }
    // Write-path saturation (issue #1776): mutex queue depth + coordinator
    // pendingWrites + WriteTimeoutError counts. Always present so operators
    // can chart zeros without a secret env flag; values stay 0 when deps are
    // not wired (tests / non-server hosts).
    const coordinatorWriteMetrics = deps.terminalInputCoordinator?.getWriteMetrics();
    const terminalWriteBlock = {
      pendingWriters: backendWriteStats?.pendingWriters ?? 0,
      maxPendingWriters: backendWriteStats?.maxPendingWriters ?? 0,
      writeTimeoutCount: backendWriteStats?.writeTimeoutCount ?? 0,
      pendingWrites: coordinatorWriteMetrics?.pendingWrites ?? 0,
      maxPendingWrites: coordinatorWriteMetrics?.maxPendingWrites ?? 0,
    };
    // Session reaper (issue #1720): cheap in-memory counters from the last
    // boot/periodic sweep — never a fresh disk/process scan on this request
    // path (issue #1553 lesson: an unbounded scan here previously OOM-crashed
    // prod).
    const sessionReaperBlock = deps.sessionReaper?.getHealthSnapshot();
    // Host-stale dtach reaper (issue #2356): last-sweep reaped/skip counters —
    // pure in-memory read, never a /proc scan on this path.
    const hostStaleDtachReaperBlock = deps.hostStaleDtachReaper?.getHealthSnapshot();

    // Non-critical timer pause (issue #1785): always-visible pause metric +
    // latest sample / threshold. Cheap in-memory read only.
    const nonCriticalTimerPauseBlock = deps.nonCriticalTimerPause?.getSnapshot() ?? {
      schemaVersion: 'non-critical-timer-pause.v1' as const,
      paused: false,
      thresholdMs: 0,
      lastEventLoopDelayP95Ms: null,
      pausedTicksTotal: 0,
    };

    // Snapshot rebuild shed (issue #1775): process-lifetime counter + threshold.
    const snapshotShedBlock = deps.snapshotShed?.getSnapshotShedMetrics() ?? {
      schemaVersion: 'snapshot-shed.v1' as const,
      thresholdMs: 0,
      lastEventLoopDelayP95Ms: null,
      shedTotal: 0,
    };

    // Resource watchdog snapshot is assembled later (after staleProcesses) so
    // issue #2039 can fold the cached dtach gauge into pressureWhileDisabled
    // without a second scan. See getHealthSnapshot({ staleDtachCount }).

    // Prod smoke tick (issue #2031): consecutiveFailures + failingChecks from
    // the durable alert artifact only — never re-run smoke checks here. Absent
    // when the tick is disabled (dep not wired).
    const prodSmokeTickBlock = deps.prodSmokeTick?.getHealthSnapshot();
    const idempotencyLedgerBlock = deps.idempotencyLedger?.getMetrics();

    // #808 / R10: surface the revocation sweep liveness + viewer count + grant
    // store writability so a dead sweep or a read-only store is visible to the
    // operator. Owner-only: viewers are denied every `/api/*` route but the
    // session exchange, so this block never reaches a viewer.
    let viewerBroadcasterBlock: object | undefined;
    if (deps.viewerShare) {
      viewerBroadcasterBlock = {
        ...deps.viewerShare.registry.broadcasterHealth(),
        grantStoreWritable: deps.viewerShare.grantStore.isWritable(),
      };
    }
    // viewTasks (no clone): capacity/diagnostics only read fields. Cloning the
    // full store on every /api/health poll was a hot-path tax linear in
    // completed-task history and starved terminal input under load.
    const tasks = taskStore.viewTasks();
    const launchDependencies = buildLaunchDependencyDiagnostics(
      tasks,
      deps.launchServiceDeps?.launchDependencyAdmission?.snapshot(),
    );
    const attentionQueueSampledAtMs = Date.now();
    // Capacity ledger (issue #1526 Phase B / FM9): during the 2026-07-24
    // deadlock every status surface showed "12 running" while the truth was
    // 11 finished-awaiting-ack + 1 hung + 0 actually working — nobody could
    // see WHY capacity was exhausted. `byClass` makes that breakdown visible.
    // Pure observability: classification never touches scheduling/capacity
    // behavior, and stays O(active tasks) on in-memory watchdog/queue state
    // only (no pane captures, no disk reads) so this is safe to poll.
    const capacitySampledAtMs = Date.now();
    // Reserved self-maintenance capacity (issue #1564): surface the reservation
    // in the ledger so an operator can verify at any time that a lucy-style
    // burst cannot consume the slots held back for kookr self-maintenance.
    const reservationSettings = deps.settings?.get();
    const capacity = buildCapacityLedger(tasks, {
      now: capacitySampledAtMs,
      maxActiveTasks: deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS,
      isHungSuspect: (task) =>
        resolveTaskAttentionSignals(task, { queue, watchdog: deps.watchdog }, capacitySampledAtMs).hungSuspect,
      isLaunching: (task) => taskStore.hasFreshActiveLaunchReservation(task.id),
      // FAA root-cause classification (issue #2142) must use the SAME live
      // thresholds the auto-close sweep uses, or a task the sweep already treats
      // as actionable would be miscounted as awaiting_poll. These are the same
      // getters lifecycle-timers threads into autoCloseStaleCompletionReadyTasks.
      faaStaleThresholdMs: deps.getAutoCloseCompletionReadyDelayMs?.(),
      faaTtlMs: deps.getCompletionReadyTtlMs?.(),
      ...(reservationSettings
        ? {
            reservedActiveSlots: reservationSettings.reservedActiveSlots,
            reservedSlotSources: reservationSettings.reservedSlotSources,
          }
        : {}),
    });

    // Automation kill-switch / SAFE MODE (issue #1710 / #1699 WS0.4). Live
    // settings read so engage/disengage is visible without a restart. Omitted
    // when settings are not wired (older test harnesses).
    let safeModeBlock:
      | { engaged: boolean; since?: string; digest?: string; loadError?: string }
      | undefined;
    if (reservationSettings) {
      const status = resolveSafeModeStatus({
        automationKillSwitch: reservationSettings.automationKillSwitch,
        safeModeSince: reservationSettings.safeModeSince,
        // Issue #2085: surface settings-load failures that forced fail-closed SAFE MODE.
        loadError: deps.settings?.getLoadError?.(),
      });
      const digest = formatSafeModeDigestLine(status);
      safeModeBlock = {
        engaged: status.engaged,
        ...(status.since ? { since: status.since } : {}),
        ...(digest ? { digest } : {}),
        ...(status.loadError ? { loadError: status.loadError } : {}),
      };
    }

    let projectAutomationBlock:
      | {
          pausedProjectIds: string[];
          paused: Array<{ projectId: string; since?: string }>;
          digest?: string;
          loadWarning?: string;
        }
      | undefined;
    if (deps.projectConfigStore) {
      const status = deps.projectConfigStore.getProjectAutomationStatus();
      const digest = formatProjectAutomationDigestLine(status);
      projectAutomationBlock = {
        pausedProjectIds: status.paused.map((row) => row.projectId),
        paused: status.paused,
        ...(digest ? { digest } : {}),
        ...(status.loadWarning ? { loadWarning: status.loadWarning } : {}),
      };
    }

    // Orchestration pause + default-agent quota utilization (issue #2672).
    // The pause record annotates SAFE MODE (who/why/since/source); the quota
    // sample drives the soft-quota rule. Both reads are cheap (one small JSON
    // file + an in-memory snapshot) so they stay on the health hot path.
    let orchestrationPauseBlock:
      | {
          paused: boolean;
          source?: string;
          since?: string;
          reason?: string;
          by?: string;
          currentPause?: {
            active: boolean;
            source?: string;
            since?: string;
            reason?: string;
            by?: string;
          };
          pauseProvenance?: {
            historicalOverlap: ReturnType<typeof buildPauseProvenance>['historicalOverlap'];
            incompleteRecords: ReturnType<typeof buildPauseProvenance>['incompleteRecords'];
          };
          defaultAgentQuota?: OrchestrationQuotaSample;
          recommendation?: string;
        }
      | undefined;
    if (reservationSettings && deps.kookrDir) {
      const state = readPauseStateSync(deps.kookrDir);
      const currentPause = getCurrentPauseRecord(state.records);
      const engaged =
        (deps.settings?.getLoadError?.() ?? undefined) !== undefined
        || reservationSettings.automationKillSwitch;
      const agentType = deps.getDefaultAgentType?.() ?? reservationSettings.defaultAgentType;
      const quotaSample = resolveDefaultAgentQuotaSample(
        agentType,
        deps.getQuotaStatus?.() ?? null,
      );
      const nowMs = Date.now();
      const pauseProvenance = buildPauseProvenance(state.records, {
        windowStartMs: nowMs - 24 * 60 * 60 * 1000,
        windowEndMs: nowMs,
      });
      const decisionRecord = currentPause
        ?? state.records.filter((record) => record.lifecycle === 'unresolved').at(-1)
        ?? null;
      const recommendation = evaluateSoftQuotaPause({
        utilization: quotaSample.utilization ?? null,
        resetsAt: quotaSample.resetsAt ?? null,
        nowMs: Date.now(),
        record: decisionRecord,
        safeModeEngaged: engaged,
      });
      orchestrationPauseBlock = {
        paused: engaged || currentPause !== null,
        ...(currentPause?.source ? { source: currentPause.source } : {}),
        ...(currentPause?.pausedAt ? { since: currentPause.pausedAt } : {}),
        ...(currentPause?.reason ? { reason: currentPause.reason } : {}),
        ...(currentPause?.pausedBy ? { by: currentPause.pausedBy } : {}),
        currentPause: {
          active: engaged || currentPause !== null,
          ...(currentPause?.source ? { source: currentPause.source } : {}),
          ...(currentPause?.pausedAt ? { since: currentPause.pausedAt } : {}),
          ...(currentPause?.reason ? { reason: currentPause.reason } : {}),
          ...(currentPause?.pausedBy ? { by: currentPause.pausedBy } : {}),
        },
        pauseProvenance: {
          historicalOverlap: pauseProvenance.historicalOverlap,
          incompleteRecords: pauseProvenance.incompleteRecords,
        },
        defaultAgentQuota: quotaSample,
        recommendation: recommendation.action,
      };
    }

    // Lesson yield (issue #1538) — last-24h flywheel health. Served
    // stale-while-revalidate (issue #1553): the response uses whatever
    // snapshot the last background scan produced (staleness is visible via
    // `generatedAt`), and an expired cache only *triggers* a bounded
    // fire-and-forget refresh. The request path never awaits a hook-log scan.
    // Full per-window queries use GET /api/diagnostics/lesson-yield?days=N.
    let lessonYieldBlock: LessonYieldSnapshot | undefined;
    if (deps.kookrDir) {
      const nowMs = Date.now();
      const cached = lessonYieldCache.getEntry(1);
      lessonYieldBlock = cached?.snapshot;
      const cacheFresh = cached !== undefined && cached.expiresAtMs > nowMs;
      if (!cacheFresh && nowMs >= lessonYieldRefreshNotBeforeMs) {
        runLessonYieldScan(1).catch(() => {
          // Soft: health stays 200 even if hook scans fail — but back off so
          // a persistently failing corpus cannot restart a scan per poll.
          lessonYieldRefreshNotBeforeMs = Date.now() + LESSON_YIELD_REFRESH_FAILURE_BACKOFF_MS;
        });
      }
    }

    // Component-collection provenance (issue #2798): the two disk-backed reads
    // below are bounded per-component so one slow/failing provider degrades only
    // its own block and is named in `controlPlane.{timedOut,errored}Components`,
    // rather than stalling the whole assembly or being an indistinguishable
    // silent omission. The cheap in-memory gauges above (agents, capacity,
    // sessions) always collect, so a degraded round never zeroes worker counts.
    const timedOutComponents: string[] = [];
    const erroredComponents: string[] = [];
    const recordComponentOutcome = (source: 'live' | 'timed-out' | 'error', name: string): void => {
      if (source === 'timed-out') timedOutComponents.push(name);
      else if (source === 'error') erroredComponents.push(name);
    };

    // CI-blind-merge debt (issue #1703) — retro-verify queue depth + blind-merge
    // count. The spool is a small JSONL under ~/.kookr (or
    // KOOKR_RETRO_VERIFY_QUEUE_DIR); a single read is cheap enough for the
    // health hot path (unlike lesson-yield's hook-log scan). Failures are
    // soft: health stays 200 and omits the block rather than 500.
    const ciBlindDebtOutcome = await collectBounded<CiBlindDebt>(
      'ciBlindDebt',
      async () => computeCiBlindDebt(await readPendingRetroVerify(defaultRetroVerifyQueueDir(process.env))),
      deps.healthComponentBudgetMs ?? HEALTH_COMPONENT_BUDGET_MS,
    );
    recordComponentOutcome(ciBlindDebtOutcome.source, ciBlindDebtOutcome.name);
    const ciBlindDebtBlock: CiBlindDebt | undefined = ciBlindDebtOutcome.value;

    // Pipeline starvation projection (RFC overnight-throughput PR1 / #1715).
    // Small per-repo JSON under playbook-state; soft-omit on failure.
    // Issue #2358: inventByPriorityClass rolls product vs micro invent mix.
    let pipelineStarvationBlock:
      | {
          schemaVersion: 'pipeline-starvation.v1';
          repos: Record<string, PipelineStarvationHealthRepo>;
          inventByPriorityClass?: InventPriorityClassHealthSnapshot;
        }
      | undefined;
    const pipelineStarvationOutcome = await collectBounded(
      'pipelineStarvation',
      async () => {
        const stateDir = deps.kookrDir
          ? `${deps.kookrDir}/playbook-state/pipeline-starvation`
          : defaultPipelineStarvationStateDir();
        return listPipelineStarvationHealth({ stateDir });
      },
      deps.healthComponentBudgetMs ?? HEALTH_COMPONENT_BUDGET_MS,
    );
    recordComponentOutcome(pipelineStarvationOutcome.source, pipelineStarvationOutcome.name);
    if (pipelineStarvationOutcome.value) {
      const pipelineStarvationRepos = pipelineStarvationOutcome.value;
      // Issue #2912: this is an in-memory snapshot only. The process-scoped
      // refresher owns boot/periodic ledger scans and single-flight publication.
      // Preserve the pre-existing soft-omit contract when the repo-state read
      // fails; a cached invent snapshot must not fabricate a healthy empty block.
      const inventByPriorityClass = deps.inventPriorityHealth?.getSnapshot();
      if (Object.keys(pipelineStarvationRepos).length > 0 || inventByPriorityClass) {
        pipelineStarvationBlock = {
          schemaVersion: 'pipeline-starvation.v1',
          repos: pipelineStarvationRepos,
          ...(inventByPriorityClass ? { inventByPriorityClass } : {}),
        };
      }
    }

    const staleProcesses = getStaleProcessSummary();
    // Resource watchdog (issue #1724 + #2039): last sample / trigger / throttle
    // / spawns-in-24h from the service's in-memory snapshot only — never a
    // fresh `/proc` or process-table scan on this request path (#1553). The
    // cached `staleProcesses.dtach` count is folded into
    // `pressureWhileDisabled` when the actuator is off.
    const resourceWatchdogBlock = deps.resourceWatchdog?.getHealthSnapshot({
      staleDtachCount: staleProcesses?.dtach.count ?? null,
    });
    // Issue #2895: latest post-recovery queue-fill decision from bounded
    // process-local memory only. Informational — it does not participate in
    // top-level health or GET /api/ready classification.
    const postRecoveryQueueFillBlock =
      deps.postRecoveryService?.getQueueFillHealthSnapshot();
    // Issue #2797: latest post-resume refill decision from bounded process-local
    // memory only. Lets a capacity report separate pause-expected silence from
    // post-resume idle capacity (intentional_idle vs refill_blocked vs
    // refilled). Informational — not part of top-level health / GET /api/ready.
    const postResumeRefillBlock =
      deps.postResumeRefillService?.getRefillHealthSnapshot();
    // Issue #2896: project the latest resource sampler's data-directory byte
    // capacity onto health without re-sampling the filesystem. Keep this
    // path-free because health and its last-good mirror are operator-visible.
    // A zero-byte reading is valid; only null marks an unavailable field.
    const latestResourceStatus = deps.getLatestResourceStatus?.() ?? null;
    const latestDataDirectory = latestResourceStatus?.host.dataDirectory ?? null;
    const hasCompleteDataDirectorySample =
      latestDataDirectory !== null
      && latestDataDirectory.diskFreeBytes !== null
      && latestDataDirectory.diskTotalBytes !== null
      && latestDataDirectory.diskFreePercent !== null;
    const dataDirectoryBlock = {
      status: hasCompleteDataDirectorySample ? 'known' as const : 'unknown' as const,
      diskFreeBytes: latestDataDirectory?.diskFreeBytes ?? null,
      diskTotalBytes: latestDataDirectory?.diskTotalBytes ?? null,
      diskFreePercent: latestDataDirectory?.diskFreePercent ?? null,
      sampledAt: latestResourceStatus?.sampledAt ?? null,
    };
    // Issue #2791: project the SAME already-sampled RSS/heap/event-loop/memory/
    // data-directory gauges onto the HTTP health path so a remote probe gets the
    // resource sample without opening a dashboard WebSocket (until now the only
    // carrier). Reuses `latestResourceStatus` fetched above — no re-sample, no
    // extra getter call — so this stays cheap on the health hot path. Kept
    // path-free like `dataDirectory` above (#2896): the data-directory `path` is
    // deliberately omitted from operator-visible health and its last-good mirror.
    // `ageMs` is the sample-freshness field the issue asks for — how stale the
    // gauges are relative to now, so a caller can tell a live sample from a
    // frozen one. Fields are bounded and secret-free (same shape already
    // broadcast over WS); `unavailable` is a fixed-size enum list, never history.
    const resourceStatusBlock = buildResourceStatusHealthBlock(
      latestResourceStatus,
      deps.nowMs?.() ?? Date.now(),
    );
    // Issue #1885: first-class finding when relay-server orphans exceed the
    // bound, so sentinel/reflection can cite a stable code instead of
    // re-deriving a threshold from the raw count. Absent when within bound.
    const relayOrphanFinding = staleProcesses
      ? evaluateRelayOrphanBound(staleProcesses, resolveRelayOrphanBound(process.env))
      : null;

    // Issue #1935: first-class finding when hungSuspect occupancy wastes
    // capacity (count ≥ 3 or ratio ≥ 0.3). Surfaces phantom waste even when
    // utilization looks healthy — the 7-hung/6-working grid must never
    // classify as purely healthy_throughput.
    const hungSuspectCapacityFinding = evaluateHungSuspectCapacityFinding(capacity);

    // Issue #2169: effective-utilization throughput verdict. The velocity probe
    // read nominal `active` (93.8%) and called it healthy_throughput while ~half
    // the slots were phantom-held. The verdict keys on effectiveWorking so the
    // probe / reflection / #2143 idle signal read productive utilization, not
    // the masked nominal figure. Always present (a headline, not a defect gate).
    const capacityThroughputVerdict = evaluateCapacityThroughputVerdict(capacity);

    // Issue #2143: supply-aware capacity signal. Idle slots with an empty queue
    // at/above the PR/day target are unused headroom (info-level), not a defect —
    // ending the recurring "sideways-on-capacity-fill" false-positive escalation.
    // The capacity-fill escalation now keys on vetted-idea *runway* shortfall (the
    // real scarce resource), not raw utilization. Inputs are operator/supervisor-
    // supplied via env; absent ⇒ pure idle-slot observability. Cheap in-memory
    // env read only — never a scan on this hot path.
    const idleCapacitySignalInputs = resolveIdleCapacitySignalInputs(process.env);
    const idleCapacityFinding = evaluateIdleCapacityFinding(capacity, idleCapacitySignalInputs);
    const vettedIdeaRunway = buildVettedIdeaRunwayReport(
      idleCapacitySignalInputs.vettedIdea,
      idleCapacitySignalInputs.runwayFloorDays,
    );

    // Issue #1989 / #2045: project hungSuspect TTL reclaim counters (including
    // skip-reason breakdown) onto /api/health. Cheap in-memory read only —
    // never a fresh reclaim scan on this path.
    const hungSuspectTtlReclaimSnapshot = deps.hungSuspectTtlReclaimMetrics?.getSnapshot();
    // Issue #2225: why open_pr_failsafe holds reclaim (delivery_open vs
    // delivery_state_unknown) with sample taskIds + PR linkage.
    const openPrFailsafeByReason = deps.openPrFailsafeReasonMetrics?.getSnapshot();
    const hungSuspectTtlReclaimBlock = hungSuspectTtlReclaimSnapshot
      ? {
          reclaimedTotal: hungSuspectTtlReclaimSnapshot.reclaimedTotal,
          reclaimAttempted: hungSuspectTtlReclaimSnapshot.reclaimAttempted,
          reclaimSucceeded: hungSuspectTtlReclaimSnapshot.reclaimSucceeded,
          skippedNoLiveness: hungSuspectTtlReclaimSnapshot.skippedNoLiveness,
          skippedOpenPrFailsafe: hungSuspectTtlReclaimSnapshot.skippedOpenPrFailsafe,
          skippedOpenPrConfirmed: hungSuspectTtlReclaimSnapshot.skippedOpenPrConfirmed,
          skippedOpenPrUnknown: hungSuspectTtlReclaimSnapshot.skippedOpenPrUnknown,
          skippedUnderTtl: hungSuspectTtlReclaimSnapshot.skippedUnderTtl,
          skippedExemptAnomaly: hungSuspectTtlReclaimSnapshot.skippedExemptAnomaly,
          skippedProviderPaused: hungSuspectTtlReclaimSnapshot.skippedProviderPaused,
          lastCandidatesConsidered: hungSuspectTtlReclaimSnapshot.lastCandidatesConsidered,
          // Issue #2072: task-id outcomes for the last reclaim pass so operators
          // can map hungSuspect candidates to skip/attempt classes.
          lastOutcomes: hungSuspectTtlReclaimSnapshot.lastOutcomes,
          lastAttemptedTaskIds: hungSuspectTtlReclaimSnapshot.lastAttemptedTaskIds,
          // Issue #2897: bounded sweep-failure signal — cumulative count plus
          // the sanitized category + timestamp of the current error state (both
          // null after a later successful pass). No raw exception text.
          sweepFailuresTotal: hungSuspectTtlReclaimSnapshot.sweepFailuresTotal,
          lastFailureCategory: hungSuspectTtlReclaimSnapshot.lastFailureCategory,
          lastFailureAtMs: hungSuspectTtlReclaimSnapshot.lastFailureAtMs,
          ...(openPrFailsafeByReason ? { openPrFailsafeByReason } : {}),
        }
      : undefined;

    // Issue #2070 / #2084: FAA reclaim + meta auto-complete counters, skip-reason
    // breakdown, and age histogram so residual finishedAwaitingAck holds stay
    // measurable (open-PR fail-safe vs under-TTL vs bad raisedAt). Cheap
    // in-memory only — never a fresh reclaim scan on this path.
    const finishedAwaitingAckReclaimSnapshot =
      deps.finishedAwaitingAckTtlReclaimMetrics?.getSnapshot();
    const finishedAwaitingAckReclaimBlock = finishedAwaitingAckReclaimSnapshot
      ? {
          reclaimedTotal: finishedAwaitingAckReclaimSnapshot.reclaimedTotal,
          reclaimAttempted: finishedAwaitingAckReclaimSnapshot.reclaimAttempted,
          reclaimSucceeded: finishedAwaitingAckReclaimSnapshot.reclaimSucceeded,
          // Issue #2355: pressure soft-TTL reclaim is a subset of reclaimedTotal.
          capacityPressureEarlyReclaimedTotal:
            finishedAwaitingAckReclaimSnapshot.capacityPressureEarlyReclaimedTotal,
          skippedBadRaisedAt: finishedAwaitingAckReclaimSnapshot.skippedBadRaisedAt,
          skippedOpenPrFailsafe: finishedAwaitingAckReclaimSnapshot.skippedOpenPrFailsafe,
          skippedOpenPrConfirmed: finishedAwaitingAckReclaimSnapshot.skippedOpenPrConfirmed,
          skippedOpenPrUnknown: finishedAwaitingAckReclaimSnapshot.skippedOpenPrUnknown,
          skippedUnderTtl: finishedAwaitingAckReclaimSnapshot.skippedUnderTtl,
          lastCandidatesConsidered:
            finishedAwaitingAckReclaimSnapshot.lastCandidatesConsidered,
          lastOutcomes: finishedAwaitingAckReclaimSnapshot.lastOutcomes,
          lastAttemptedTaskIds: finishedAwaitingAckReclaimSnapshot.lastAttemptedTaskIds,
          autoCompletedTotal: finishedAwaitingAckReclaimSnapshot.autoCompletedTotal,
          autoCompleteDeferredTotal:
            finishedAwaitingAckReclaimSnapshot.autoCompleteDeferredTotal,
          autoCompleteAgeHistogram:
            finishedAwaitingAckReclaimSnapshot.autoCompleteAgeHistogram,
          softTtlMs: finishedAwaitingAckReclaimSnapshot.softTtlMs,
          capacityEarlyReclaim: finishedAwaitingAckReclaimSnapshot.capacityEarlyReclaim,
        }
      : undefined;

    // Issue #2079: provider_paused occupancy (count + oldest pause age) and
    // hard-TTL reclaim counters. Cheap in-memory only — never a fresh scan.
    const providerPausedOccupancySnapshot =
      deps.providerPausedOccupancyMetrics?.getSnapshot();
    const providerPausedOccupancyBlock = providerPausedOccupancySnapshot
      ? {
          count: providerPausedOccupancySnapshot.count,
          oldestPauseAgeMs: providerPausedOccupancySnapshot.oldestPauseAgeMs,
          taskIds: providerPausedOccupancySnapshot.taskIds,
          reclaimedTotal: providerPausedOccupancySnapshot.reclaimedTotal,
          reclaimAttempted: providerPausedOccupancySnapshot.reclaimAttempted,
          reclaimSucceeded: providerPausedOccupancySnapshot.reclaimSucceeded,
          skippedUnderTtl: providerPausedOccupancySnapshot.skippedUnderTtl,
          skippedOpenPrFailsafe: providerPausedOccupancySnapshot.skippedOpenPrFailsafe,
          skippedOpenPrConfirmed: providerPausedOccupancySnapshot.skippedOpenPrConfirmed,
          skippedOpenPrUnknown: providerPausedOccupancySnapshot.skippedOpenPrUnknown,
          skippedNoPauseStart: providerPausedOccupancySnapshot.skippedNoPauseStart,
          skippedAwaitingProviderReset:
            providerPausedOccupancySnapshot.skippedAwaitingProviderReset,
          lastCandidatesConsidered:
            providerPausedOccupancySnapshot.lastCandidatesConsidered,
          lastOutcomes: providerPausedOccupancySnapshot.lastOutcomes,
          lastAttemptedTaskIds: providerPausedOccupancySnapshot.lastAttemptedTaskIds,
          hardTtlMs: providerPausedOccupancySnapshot.hardTtlMs,
          // Issue #2225: soft TTL + capacity-aware early reclaim policy.
          softTtlMs: providerPausedOccupancySnapshot.softTtlMs,
          effectiveTtlMs: providerPausedOccupancySnapshot.effectiveTtlMs,
          capacityEarlyReclaim: providerPausedOccupancySnapshot.capacityEarlyReclaim,
        }
      : undefined;

    // Issue #1750: top-level machine-readable serving SHA so deploy/outcome
    // probes (and extractServingSha in incident-close-out) can read the commit
    // this process is *actually* serving without digging into `build`.
    // `sha` + `gitSha` are aliases of the same value for probe compatibility.
    const servingSha =
      typeof buildInfo?.commitHash === 'string' && buildInfo.commitHash.length > 0
        ? buildInfo.commitHash
        : undefined;

    // Issue #2351: compact crash-recovery counts for remote / unattended polls.
    // Full entry lists stay on GET /api/startup-summary; health is counts only.
    // Omitted until recovery completes (or a summary already exists).
    const startupRecoveryBlock = resolveStartupRecoveryHealthBlock(
      deps,
      typeof serverStartedAt === 'string' ? serverStartedAt : undefined,
    );

    // Read the hook-ingestion diagnostics once and share it between the lag
    // summary block and the control-plane hook-lag freshness reading (#2798).
    const hookIngestionSnapshot = deps.hookIngestion?.getDiagnosticsSnapshot();

    // systemd notifier arming (issue #2853): project the process-local
    // readiness/watchdog arming state so a remote operator can tell whether
    // process-level watchdog integration is disabled — a cheap in-memory read
    // of the notifier's construction-time state, never a `systemctl` call or
    // filesystem work. Omitted when the notifier is not wired (tests /
    // non-server hosts). In production start.ts always wires it, so an unset
    // NOTIFY_SOCKET surfaces as `arming: "absent"` rather than a missing block.
    const systemdNotifierBlock = deps.systemdNotifier
      ? buildSystemdNotifierHealthBlock(deps.systemdNotifier)
      : undefined;

    // Control-plane collection provenance (issue #2798). This live assembly
    // stamps `source: "live"` and its own collection time; a degraded round
    // (one of the bounded components above timed out or failed) flips
    // collectionStatus to `degraded` while still serving the live gauges. The
    // cold-cache deadline fallback in getCachedHealthBody overwrites this block
    // with a `last-good` / `unavailable` verdict when it serves a preserved
    // snapshot instead.
    const controlPlaneNowMs = deps.nowMs?.() ?? Date.now();
    const controlPlaneBlock: ControlPlaneCollectionBlock = buildControlPlaneCollectionBlock({
      source: 'live',
      collectedAtMs: controlPlaneNowMs,
      nowMs: controlPlaneNowMs,
      timedOutComponents,
      erroredComponents,
      hookLag: hookLagFreshnessFromSnapshot(hookIngestionSnapshot, controlPlaneNowMs),
    });

    return {
      status: 'ok',
      agents: tasks.length,
      build: buildInfo,
      ...(servingSha ? { sha: servingSha, gitSha: servingSha } : {}),
      serverStartedAt,
      // Issue #1721: expose startup phase so operators/deploy can see
      // "listening, still recovering" vs "fully ready" without treating
      // liveness as readiness.
      ...(deps.startupReadiness ? { startup: deps.startupReadiness.getProgress() } : {}),
      // Issue #2790: did the previous process exit cleanly? `dirty` marks a
      // crash/OOM/SIGKILL, `clean` a graceful restart, `unknown` a first boot
      // or wiped/corrupt marker. Deterministic, bounded, secret-free — safe to
      // project verbatim. Computed before startup recovery, so it describes the
      // state at bind time, not after recovery churned the tasks.
      ...(deps.bootStatus ? { boot: deps.bootStatus } : {}),
      ...(startupRecoveryBlock ? { startupRecovery: startupRecoveryBlock } : {}),
      launchDependencies,
      attentionQueue: {
        activeFindingDepth: queue.getDepth(attentionQueueSampledAtMs),
        oldestFindingAgeMs: queue.getOldestFindingAgeMs(attentionQueueSampledAtMs),
      },
      capacity,
      capacityThroughputVerdict,
      ...(safeModeBlock ? { safeMode: safeModeBlock } : {}),
      ...(projectAutomationBlock ? { projectAutomation: projectAutomationBlock } : {}),
      ...(orchestrationPauseBlock ? { orchestrationPause: orchestrationPauseBlock } : {}),
      ...(lessonYieldBlock ? { lessonYield: lessonYieldBlock } : {}),
      // camelCase + snake_case: dashboard/status CLI use camelCase; daily
      // reports and the issue acceptance criterion name the metric
      // `ci_blind_debt`.
      ...(ciBlindDebtBlock
        ? { ciBlindDebt: ciBlindDebtBlock, ci_blind_debt: ciBlindDebtBlock }
        : {}),
      ...(pipelineStarvationBlock ? { pipelineStarvation: pipelineStarvationBlock } : {}),
      ...(terminalBackendBlock ? { terminalBackend: terminalBackendBlock } : {}),
      terminalWrite: terminalWriteBlock,
      ...(sessionReaperBlock ? { sessionReaper: sessionReaperBlock } : {}),
      ...(hostStaleDtachReaperBlock ? { hostStaleDtachReaper: hostStaleDtachReaperBlock } : {}),
      nonCriticalTimerPause: nonCriticalTimerPauseBlock,
      snapshotShed: snapshotShedBlock,
      ...(resourceWatchdogBlock ? { resourceWatchdog: resourceWatchdogBlock } : {}),
      ...(postRecoveryQueueFillBlock
        ? { postRecoveryQueueFill: postRecoveryQueueFillBlock }
        : {}),
      ...(postResumeRefillBlock
        ? { postResumeRefill: postResumeRefillBlock }
        : {}),
      dataDirectory: dataDirectoryBlock,
      // Issue #2791: full latest resource sample (RSS/heap/event-loop/memory/
      // data-directory) + freshness age, reused from the WS sampler.
      resourceStatus: resourceStatusBlock,
      ...(prodSmokeTickBlock ? { prodSmokeTick: prodSmokeTickBlock } : {}),
      ...(idempotencyLedgerBlock ? { idempotencyLedger: idempotencyLedgerBlock } : {}),
      // systemd notifier arming (issue #2853): process-local readiness/watchdog
      // state only — externalUnitStatus is always "unknown" (no systemctl probe).
      ...(systemdNotifierBlock ? { systemdNotifier: systemdNotifierBlock } : {}),
      ...(viewerBroadcasterBlock ? { viewerBroadcaster: viewerBroadcasterBlock } : {}),
      ...(deps.scheduleService ? { schedules: deps.scheduleService.getStatusSnapshot() } : {}),
      ...(deps.umbrellaChainAdvancer
        ? { umbrellaChains: deps.umbrellaChainAdvancer.getHealthSnapshot() }
        : {}),
      ...(staleProcesses ? { staleProcesses } : {}),
      // Payload-diet gauges (issue #2220): tracked/terminal task pressure + last
      // snapshot bytes. Same numbers already logged at boot/prune; health makes
      // them glanceable for operators and `kookr status` without grepping logs.
      ...(deps.getPayloadDietStats ? { payloadDiet: deps.getPayloadDietStats() } : {}),
      // Maintenance prune (issues #2344 emergency + #2345 schedule): schedule
      // enabled/interval + last-run counters, plus emergency edge counters.
      // Cheap in-memory read only — never starts a reclaim on this path.
      // Bootstrap always wires the getter (intervalHours=0 → enabled:false).
      ...(() => {
        const maintenancePrune = deps.getMaintenancePruneHealth?.();
        return maintenancePrune ? { maintenancePrune } : {};
      })(),
      // Hook replay-checkpoint gauges (issue #2281): session count + on-disk
      // file size. Cheap in-memory + stat; never a full JSON parse of the
      // multi-MB checkpoint store. Null when checkpoints are disabled.
      ...(deps.getHookReplayCheckpointStats
        ? { hookReplayCheckpoints: deps.getHookReplayCheckpointStats() }
        : {}),
      ...(relayOrphanFinding ? { relayOrphanFinding } : {}),
      ...(hungSuspectCapacityFinding ? { hungSuspectCapacityFinding } : {}),
      ...(idleCapacityFinding ? { idleCapacityFinding } : {}),
      ...(vettedIdeaRunway ? { vettedIdeaRunway } : {}),
      ...(hungSuspectTtlReclaimBlock ? { hungSuspectTtlReclaim: hungSuspectTtlReclaimBlock } : {}),
      ...(finishedAwaitingAckReclaimBlock
        ? { finishedAwaitingAckTtlReclaim: finishedAwaitingAckReclaimBlock }
        : {}),
      // Issue #2079: provider_paused occupancy count + oldest pause age + hard-TTL reclaim.
      ...(providerPausedOccupancyBlock
        ? { providerPausedOccupancy: providerPausedOccupancyBlock }
        : {}),
      // Issue #2036: post-spawn first-hook miss counter (cheap in-memory read).
      ...(deps.firstHookMissMetrics
        ? { firstHookMissTotal: deps.firstHookMissMetrics.getSnapshot().firstHookMissTotal }
        : {}),
      // Issue #2770: watchdog sweep fairness — probe-timeout counters plus the
      // last sweep's checked/skipped counts and oldest-check age, so an operator
      // can see when a hung probe is deferring work or the fleet is falling
      // behind its sweep cadence. Cheap in-memory read only — never a fresh sweep.
      ...(deps.watchdogSweepMetrics
        ? { watchdogSweep: deps.watchdogSweepMetrics.getSnapshot() }
        : {}),
      // Hook-ingestion lag summary (issue #2319): sessionCount / notableLagCount
      // + max/p95 from the in-memory diagnostics snapshot. Operators and drain
      // automation polling /api/health (and `kookr status`) see data-plane lag
      // without scraping /api/diagnostics/hook-ingestion. Never re-scans files.
      // Observability only; does not change /api/ready criticality.
      ...(hookIngestionSnapshot
        ? { hookIngestion: buildHookIngestionHealthSummary(hookIngestionSnapshot) }
        : {}),
      // Bounded-collection provenance (issue #2798): live/last-good/unavailable
      // source, last-good age, timed-out/failed component names, hook-lag
      // freshness. Read-only — this never restarts an agent or the daemon.
      controlPlane: controlPlaneBlock,
      // OSS attempts summary (issue #2332): open/total counts + last refresh +
      // issue-check error count so operators see contribution-gate pressure from
      // /api/health and `kookr status` without fetching the full attempts array.
      // Omitted when the OSS store is not wired (feature disabled).
      ...(deps.ossAttemptStore
        ? { ossAttempts: summarizeOssAttemptsForHealth(deps.ossAttemptStore) }
        : {}),
      // Issue #2641: secret-free helper-LLM pause / storm view from the
      // in-memory auth-pause map. Always present so last-good health and
      // `kookr ops digest` can name a paused provider without grepping logs.
      helperLlm: (deps.getHelperLlmHealthSnapshot ?? getHelperLlmHealthSnapshot)(),
      // Issue #2636: four-field timer-health summary so last-good health
      // (the snapshot Lucy reads after HTTP goes dark) can say whether a
      // safety-net timer is overdue without a second curl. Counts only —
      // the per-loop list stays on GET /api/diagnostics/timer-health.
      // Overdue reuses the existing 2×-interval rule, so a loop still
      // inside its first cadence after boot is not overdue. In-memory only.
      timerHealth: timerHealthSummaryForHealth(deps.timerHealth),
    };
  }

  // Start (or join) the single-flight assembly that repopulates the cache. Each
  // completed assembly records its walk duration and land time so the health
  // gauges (issue #2497) reflect the real cost, and resets the TTL.
  function startHealthAssembly(): Promise<Record<string, unknown>> {
    if (healthBodyInFlight) return healthBodyInFlight;
    const startedAtMs = deps.nowMs?.() ?? Date.now();
    let pending: Promise<Record<string, unknown>>;
    pending = assembleHealthBody()
      .then((body) => {
        const finishedAtMs = deps.nowMs?.() ?? Date.now();
        healthBodyCache = {
          cachedAtMs: finishedAtMs,
          expiresAtMs: finishedAtMs + HEALTH_BODY_CACHE_MS,
          assemblyMs: Math.max(0, finishedAtMs - startedAtMs),
          body,
        };
        healthBodyStats.record(healthBodyCache.assemblyMs, finishedAtMs);
        // Mirror the just-assembled body to the last-good file (issue #2495).
        // This is a *bounded synchronous* write (temp+rename of a ≤32 KiB blob,
        // throttled to ≤once/5s) — small and infrequent enough for the health
        // path, and it never throws, so a read-only state dir cannot turn an
        // assembly into a failure. On a cold cache the first request awaits this
        // `.then`, so the write is not off-thread; the throttle keeps warm-cache
        // reassemblies from paying it every second.
        lastGoodHealthWriter?.record(body);
        return body;
      })
      .finally(() => {
        if (healthBodyInFlight === pending) healthBodyInFlight = undefined;
      });
    healthBodyInFlight = pending;
    return pending;
  }

  // Stamp the point-in-time cache gauges onto a shallow copy of the cached body
  // so the served response reports its own staleness without mutating (and thus
  // freezing a stale age into) the shared cache entry.
  function serveHealthBody(
    entry: { cachedAtMs: number; assemblyMs: number; body: Record<string, unknown> },
    nowMs: number,
  ): Record<string, unknown> {
    return {
      ...entry.body,
      healthAssemblyMs: entry.assemblyMs,
      healthCacheAgeMs: Math.max(0, nowMs - entry.cachedAtMs),
    };
  }

  async function getCachedHealthBody(): Promise<Record<string, unknown>> {
    const now = deps.nowMs?.() ?? Date.now();
    if (healthBodyCache !== undefined) {
      // Stale-while-revalidate (issue #2492): if the TTL has expired but a
      // previous body exists, serve it immediately and kick off exactly one
      // background refresh. A wedged loop is out of scope for an in-process
      // cache — this only spares the stampede-before-wedge case.
      if (healthBodyCache.expiresAtMs <= now) {
        // Defer the refresh to a macrotask. assembleHealthBody has a large
        // *synchronous* prefix (viewTasks + capacity-ledger build) before its
        // first await, so calling startHealthAssembly() inline — even as a
        // discarded promise — would run that walk on the stale-serve path and
        // delay the "immediate" body #2492 promises. The default scheduler is
        // setImmediate so the cached body returns (and flushes) first; the kick
        // is injectable for deterministic tests. Single-flight still holds
        // because the deferred kicks run after this one set healthBodyInFlight.
        scheduleHealthRefresh(() => {
          void startHealthAssembly().catch(() => {
            // Soft: a failed background refresh must never surface — the stale
            // body was already served. The failed assembly clears
            // healthBodyInFlight, so the next request retries.
          });
        });
      }
      return serveHealthBody(healthBodyCache, now);
    }
    // Cold cache (issue #2798): with no stale body to serve, bound the first
    // assembly so a slow or wedged collector cannot hang the endpoint. On
    // success serve the fresh body; on a deadline (or a rejected assembly)
    // serve the on-disk last-good snapshot — worker/session counts intact —
    // or a typed `unavailable` body. The single-flight assembly keeps running,
    // so the next poll recovers to live data.
    const deadlineMs = deps.healthAssemblyDeadlineMs ?? HEALTH_ASSEMBLY_DEADLINE_MS;
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(), deadlineMs);
    (deadlineTimer as { unref?: () => void }).unref?.();
    let outcome: DeadlineResult<Record<string, unknown>>;
    try {
      outcome = await raceWithDeadline(startHealthAssembly(), deadlineController.signal);
    } finally {
      clearTimeout(deadlineTimer);
    }
    if (outcome.status === 'value' && healthBodyCache !== undefined) {
      return serveHealthBody(healthBodyCache, deps.nowMs?.() ?? Date.now());
    }
    // A genuine assembly *exception* is not a slow-collection case — surface it
    // (Hono → 500) so the failure stays visible, exactly as before #2798. The
    // rejected single-flight already cleared, so the next request rebuilds.
    if (outcome.status === 'error') {
      throw outcome.error;
    }
    // Deadline exceeded (slow / wedged collection): serve the preserved
    // last-good snapshot, or a typed unavailable body — never a hang.
    return serveColdDegradedBody(deps.nowMs?.() ?? Date.now());
  }

  // Build the degraded body served when a cold-cache assembly misses its
  // deadline (issue #2798). Prefers the durable on-disk last-good mirror
  // (issue #2495) so worker/session counts survive a slow round instead of
  // being reported as zero; falls back to a typed `unavailable` body that omits
  // counts entirely rather than fabricating zeros. Read-only: no restart.
  function serveColdDegradedBody(nowMs: number): Record<string, unknown> {
    const hookLag = hookLagFreshnessFromSnapshot(
      deps.hookIngestion?.getDiagnosticsSnapshot(),
      nowMs,
    );
    const mirror = deps.kookrDir ? readLastGoodHealth(deps.kookrDir, { now: nowMs }) : null;
    if (mirror) {
      const body: Record<string, unknown> = { ...mirror.snapshot.health };
      body.controlPlane = buildControlPlaneCollectionBlock({
        source: 'last-good',
        collectedAtMs: mirror.mtimeMs,
        nowMs,
        timedOutComponents: ['healthAssembly'],
        hookLag,
      });
      body.healthCacheAgeMs = mirror.ageMs;
      return body;
    }
    return {
      status: 'ok',
      controlPlane: buildControlPlaneCollectionBlock({
        source: 'unavailable',
        collectedAtMs: null,
        nowMs,
        timedOutComponents: ['healthAssembly'],
        hookLag,
      }),
    };
  }

  app.get('/api/health', async (c) => c.json(await getCachedHealthBody()));

  // Machine-readable readiness verdict for orchestrators / load balancers
  // (issue #660, extended by #1721 / #1707 / #1870 / #2427). Unlike /api/health —
  // which always returns 200 so the dashboard never sees a hard error — /api/ready
  // turns 503 when a *critical* subsystem is down or unavailable for new work:
  // startup recovery still in progress, operator drain mode, the terminal/dtach
  // backend in `error` (manifest-corrupt / dtach-unavailable), the persistence
  // directory unwritable, or the schedule-runner tick loop stale beyond N
  // tick-intervals (`schedulerTick`, issue #1707).
  // Non-critical degradation (terminal `degraded`, hook-ingestion lag,
  // fail-closed paused schedules) stays 200/ready so those signals do not
  // cordon a node out of rotation — `hookIngestion` (issue #1870) and
  // `schedulesPaused` (issue #2427) are reported for visibility only.
  // Read-only and unauthenticated by design: probes must reach it without an
  // admin token.
  //
  // Process supervisors for the *engine* MUST probe this path (`GET /api/ready`
  // on the dashboard server), NOT the detached relay's `/ready` (or historical
  // `/readyz`) endpoint — relay readiness only sees `dbReachable` +
  // `emergencyDisabled` and is blind to the schedule-runner (issue #1699 WS0).
  app.get('/api/ready', (c) => {
    const checks: Record<string, ReadinessCheck> = {};

    // Issue #1721: listen-early boot keeps this critical until recovery finishes.
    if (deps.startupReadiness) {
      const startup = deps.startupReadiness.toReadinessCheck();
      checks.startup = {
        critical: startup.critical,
        ready: startup.ready,
        status: startup.status,
        ...(startup.reason ? { reason: startup.reason } : {}),
        ...(startup.detail ? { detail: startup.detail } : {}),
      };
    }

    const terminalBackend = deps.terminalBackend;
    if (terminalBackend) {
      const status = deriveTerminalBackendStatus(terminalBackend.getStats());
      checks.terminalBackend = { critical: true, ready: status !== 'error', status };
    }

    if (deps.drainController) {
      const status = deps.drainController.status();
      checks.drainMode = {
        critical: true,
        ready: !status.draining,
        status: status.draining ? 'draining' : 'accepting',
        ...(status.draining ? { reason: 'drain-mode' } : {}),
      };
    }

    checks.persistence = checkPersistenceWritable(deps.kookrDir);

    // Issue #1707: schedule-runner liveness via lastTickCompletedAt.
    // Issue #2427: non-critical fail-closed pause visibility on the same
    // snapshot. Omitted when scheduling is not wired (tests / hermetic
    // boots) so those contexts stay fail-open.
    if (deps.scheduleService) {
      const scheduleStatus = deps.scheduleService.getStatusSnapshot();
      checks.schedulerTick = checkSchedulerTickReadiness(scheduleStatus);
      checks.schedulesPaused = checkSchedulesPausedReadiness(scheduleStatus);
    }

    // Issue #1870: non-critical hook-ingestion lag visibility. Surfaces stalled
    // lag on the readiness probe without flipping overall ready/503 — a blind
    // supervisor still accepts work, but operators/orchestrators can see lag.
    // Omitted when hook ingestion is not wired (tests / hermetic boots).
    if (deps.hookIngestion) {
      checks.hookIngestion = checkHookIngestionReadiness(deps.hookIngestion.getDiagnosticsSnapshot());
    }

    // Fail-open: a check only flips readiness when it is both critical and
    // not-ready. Non-critical checks are reported for visibility only.
    const ready = Object.values(checks).every((check) => check.ready || !check.critical);
    // Issue #1995: durable ops-status card on the ready→degraded edge so a
    // Discord outage still leaves an on-disk last-known-good digest. Fire-and-
    // forget; writer owns best-effort try/catch and edge de-dupe.
    if (deps.opsStatusWriter) {
      const failedCritical = Object.entries(checks)
        .filter(([, check]) => check.critical && !check.ready)
        .map(([name, check]) => `${name}:${check.status}`)
        .join(',');
      void deps.opsStatusWriter.noteReadyVerdict(
        ready,
        failedCritical.length > 0 ? failedCritical : undefined,
      );
    }
    return c.json({ ready, checks }, ready ? 200 : 503);
  });

  app.get('/api/health/stt', async (c) => {
    if (!deps.sttUrl) return c.json({ status: 'disabled' }, 200);
    // Issue #2057: refuse to probe SSRF-prone STT URLs even if mis-injected after boot.
    if (!validateSpeechServiceUrl(deps.sttUrl).ok) {
      return c.json({ status: 'unavailable', reason: 'invalid-stt-url' }, 200);
    }
    // Polling endpoint: frontend polls this and reads `status` from the body.
    // Returning 200 with status:'unavailable' lets the UI render a soft warning
    // without firing fetch() error handlers. Do not change to non-2xx.
    // STT health runs through the `stt` circuit breaker (issue #1772).
    const body = await probeSttHealth({
      sttUrl: deps.sttUrl,
      breaker: deps.circuitBreakerRegistry?.get('stt'),
    });
    return c.json(body, 200);
  });

  app.get('/api/health/tts', async (c) => {
    if (!deps.ttsUrl) return c.json({ status: 'disabled' }, 200);
    // Issue #2057: refuse to probe SSRF-prone TTS URLs even if mis-injected after boot.
    if (!validateSpeechServiceUrl(deps.ttsUrl).ok) {
      return c.json({ status: 'unavailable', reason: 'invalid-tts-url' }, 200);
    }
    try {
      const res = await fetch(`${deps.ttsUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return c.json({ status: 'unavailable' }, 200);
      return c.json(await res.json());
    } catch {
      // TTS is optional, so runtime probe failures are soft health signals.
      return c.json({ status: 'unavailable' }, 200);
    }
  });

  // Debug endpoint: full fidelity (not projected). Operators need the raw
  // toolResponse / toolInput / lastMessage for incident investigation.
  app.get('/api/snapshot', (c) => c.json(getSnapshotAgentsRaw({ monitor: deps.monitor })));

  app.get('/api/queue', (c) => c.json(queue.getAll()));

  app.get('/api/anomaly-stats', (c) =>
    // `stuckFlagPrecision` (issue #1653): waiting_on_input flags vs would-be
    // false positives suppressed by the liveness cross-check, plus the derived
    // precision ratio. Additive field — existing consumers ignore it.
    c.json({ ...getDetectionStats(), stuckFlagPrecision: getStuckFlagPrecision() }),
  );

  app.get(REQUEST_LATENCIES_ROUTE, (c) => {
    if (!deps.requestDurationMetrics) {
      // Direct diagnostics-route tests may register this module without the
      // createRoutes middleware that wires the live metrics instance.
      return c.json({
        schemaVersion: 'request-duration-metrics.v1',
        maxRoutes: 0,
        maxSamplesPerRoute: 0,
        routeCount: 0,
        droppedRouteCount: 0,
        routes: [],
      });
    }
    return c.json(deps.requestDurationMetrics.snapshot());
  });

  // Control-plane probe latency + completion status (issue #2774): p50/p95/p99
  // plus error/slow counts for `/api/health`, health subroutes, and `/api/ready`
  // — the surfaces excluded from the general request-latency histogram so an
  // unattended operator can see a slow or failing control plane, not just a
  // binary status. Falls back to an empty snapshot when direct diagnostics-route
  // tests register this module without the createRoutes middleware.
  app.get(CONTROL_PLANE_LATENCIES_ROUTE, (c) =>
    c.json(deps.controlPlaneLatencyMetrics?.snapshot() ?? EMPTY_CONTROL_PLANE_LATENCY_SNAPSHOT));

  // Hot-path ranking (issue #1781): top event-loop contributors over recent
  // windows (labeled timings around known heavy functions — snapshot rebuild,
  // task save, VT reconstruct, hook parse). Pure in-memory aggregation of a
  // bounded ring; never scans the filesystem or blocks the request path. No env
  // gate — visible by default so an operator has a ranked list after a lag/OOM
  // incident. `?topK=N` trims the per-window list.
  app.get(HOT_PATHS_ROUTE, (c) => {
    const sampler = deps.hotPathSampler ?? getHotPathSampler();
    const topK = parsePositiveInt(c.req.query('topK'));
    return c.json(sampler.snapshot(topK === undefined ? {} : { topK }));
  });

  // Issue #1773: keystroke → backend write-ack latency (p50/p95/p99) so the
  // terminal typing lag users feel is chartable without a secret env flag.
  // Falls back to an empty snapshot when direct tests register this module
  // without the createRoutes middleware that wires the live histogram.
  app.get('/api/diagnostics/terminal-input-rtt', (c) =>
    c.json(deps.terminalInputRttMetrics?.snapshot() ?? EMPTY_TERMINAL_INPUT_RTT_SNAPSHOT));

  app.get('/api/diagnostics/auth-throttle', (c) => c.json(getAuthThrottleSnapshot(deps.apiAuth)));

  app.get('/api/diagnostics/delivery-trace', (c) => {
    const snapshot = deps.deliveryTrace?.snapshot(parseDeliveryTraceFilter(c)) ?? {
      schemaVersion: DELIVERY_TRACE_SCHEMA_VERSION,
      maxRecords: 0,
      totalRecorded: 0,
      records: [],
    };
    const limit = parsePositiveInt(c.req.query('limit'));
    return c.json(limit === undefined ? snapshot : {
      ...snapshot,
      records: snapshot.records.slice(-limit),
    });
  });

  app.get('/api/diagnostics/hook-ingestion', (c) => c.json({
    schemaVersion: 'hook-ingestion-diagnostics-route.v1',
    ingestion: deps.hookIngestion?.getDiagnosticsSnapshot() ?? emptyHookIngestionDiagnosticsSnapshot(),
    watcher: deps.hookWatcher?.getHealthSnapshot() ?? emptyHookWatcherHealthSnapshot(),
  }));

  // Hung-task reap warnings (RFC rfc-reap-grace-warning.md): live warning state
  // + cumulative counters so an operator can answer "why is task X warned / not
  // warned right now" from a ground-truth read path.
  app.get('/api/diagnostics/reap-warnings', (c) => {
    const nowMs = Date.now();
    return c.json({
      schemaVersion: 'reap-warnings-diagnostics-route.v2',
      active: deps.reapWarningCoordinator?.snapshotState(nowMs) ?? [],
      metrics: deps.reapWarningCoordinator?.getMetrics() ?? null,
      // issue #2170: the FAA ack-path reaper's own grace/veto coordinator +
      // close counters, so an operator can answer "why is finished task X
      // warned / being reaped" from the same read path.
      faaAckReaper: {
        active: deps.faaAckReapWarningCoordinator?.snapshotState(nowMs) ?? [],
        warningMetrics: deps.faaAckReapWarningCoordinator?.getMetrics() ?? null,
        reaperMetrics: deps.faaAckReaperMetrics?.getSnapshot() ?? null,
      },
    });
  });

  // Per-agent-type launch success/failure rates (issue #1808): process-local
  // counters so handshake flakiness is visible without log spelunking.
  app.get(LAUNCH_OUTCOMES_ROUTE, (c) => (
    c.json(deps.launchOutcomeMetrics?.snapshot() ?? emptyLaunchOutcomeMetricsSnapshot())
  ));

  // Per-agent-type boot-latency reliability signal (issue #1898): which agents
  // the round-robin failover is deprioritizing and the slow/hung sample counts
  // behind that decision, so a deprioritized grok-build is diagnosable live.
  app.get('/api/diagnostics/agent-boot-latency', (c) => c.json({
    schemaVersion: 'agent-boot-latency-diagnostics-route.v1',
    agents: deps.agentBootLatency?.snapshot() ?? [],
  }));

  app.get('/api/diagnostics/launch-dependencies', (c) => (
    c.json(buildLaunchDependencyDiagnostics(
      taskStore.viewTasks(),
      deps.launchServiceDeps?.launchDependencyAdmission?.snapshot(),
    ))
  ));

  // Terminal-outcome histogram over a bounded trailing window (issue #2847):
  // classifies every terminal task's structured receipt by reason, source,
  // status, and work-disposition so Layer-3 reflection can tell expected
  // recovery from churn/force-reap/operator-cancel without reconstructing it
  // from timestamps. Legacy rows (no receipt) count as `unknown_legacy`. Pure
  // in-memory read over the already-bounded task view — never scans transcripts.
  // `?windowMs=` (or `?hours=`) selects the window; default 24h, capped at 30d.
  app.get('/api/diagnostics/terminal-outcomes', (c) => {
    const nowMs = deps.nowMs?.() ?? Date.now();
    const windowMs = parseTerminalOutcomeWindowMs(c.req.query('windowMs'), c.req.query('hours'));
    return c.json({
      schemaVersion: 'terminal-outcomes-diagnostics-route.v1',
      ...aggregateTerminalOutcomes(taskStore.viewTasks(), { nowMs, windowMs }),
    });
  });

  // Schedule terminal-reason rollup over a bounded trailing window (issue
  // #2877): aggregates classified schedule fires by terminal reason and by
  // resolved provider — with occupied slot-time — so the daily reflection can
  // spot a provider-wide timeout storm directly instead of joining
  // `/api/schedules` to `/api/tasks` per fire. Reads only the in-memory,
  // already-capped execution ledgers; never serializes task event histories.
  // `?windowMs=` (or `?hours=`) selects the window; default 24h, capped at 30d.
  // Empty rollup when scheduling is not configured.
  app.get('/api/diagnostics/schedule-terminal-reasons', (c) => {
    const nowMs = deps.nowMs?.() ?? Date.now();
    const windowMs = parseTerminalOutcomeWindowMs(c.req.query('windowMs'), c.req.query('hours'));
    const aggregate = deps.scheduleService
      ? deps.scheduleService.aggregateTerminalReasons({ nowMs, windowMs })
      : {
          windowMs,
          generatedAt: new Date(nowMs).toISOString(),
          total: 0,
          occupiedMs: 0,
          byReason: {},
          byProvider: {},
        };
    return c.json({
      schemaVersion: 'schedule-terminal-reasons-diagnostics-route.v1',
      ...aggregate,
    });
  });

  // Median human-reply wait over the last 24 hours (issue #2583). Reads the
  // existing session interaction JSONL files; does not invent a store.
  // The StatusBar chip hides itself below five samples — this route still
  // returns the raw snapshot so the threshold stays a UI rule.
  app.get('/api/diagnostics/time-to-unblock', async (c) => {
    const nowMs = deps.nowMs?.() ?? Date.now();
    if (!deps.kookrDir) {
      return c.json(emptyTimeToUnblockSnapshot(nowMs, TIME_TO_UNBLOCK_WINDOW_MS));
    }
    return c.json(await computeTimeToUnblockFromDir(deps.kookrDir, {
      nowMs,
      windowMs: TIME_TO_UNBLOCK_WINDOW_MS,
    }));
  });

  app.get('/api/diagnostics/session-health', (c) => {
    try {
      return c.json(deps.sessionHealthService?.getDiagnostics() ?? {
        schemaVersion: SESSION_HEALTH_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        restartEpoch: serverStartedAt,
        sessions: [],
        coordinatedStall: null,
      });
    } catch {
      return c.json({ error: 'session health diagnostics unavailable' }, 503);
    }
  });

  // Lifecycle-timer health (issue #1771): per-loop last-fired + overdue flag
  // so a silently-stopped periodic timer (save, liveness, …) is visible before
  // downstream damage. Pure in-memory read — never blocks the request path.
  app.get('/api/diagnostics/timer-health', (c) => {
    try {
      return c.json(
        deps.timerHealth?.snapshot() ?? {
          schemaVersion: TIMER_HEALTH_SCHEMA_VERSION,
          generatedAt: new Date().toISOString(),
          loops: [],
        },
      );
    } catch {
      return c.json({ error: 'timer health diagnostics unavailable' }, 503);
    }
  });

  // Lesson yield (issue #1538): lessons + explicit no-lesson declarations per
  // completed task, queryable over a recent window. Source: hook logs under
  // <kookrDir>/hooks/. Complements the durable spool (#1519) which only
  // covers write durability, not authoring trigger.
  app.get('/api/diagnostics/lesson-yield', async (c) => {
    if (!deps.kookrDir) {
      return c.json({ error: 'kookrDir unavailable; lesson yield requires hook logs' }, 503);
    }
    const daysRaw = c.req.query('days');
    let days = 1;
    if (daysRaw !== undefined) {
      const parsed = Number.parseInt(daysRaw, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return c.json({ error: 'days must be a positive integer' }, 400);
      }
      days = Math.min(parsed, MAX_LESSON_YIELD_DAYS);
    }

    // Cache-first, stale-while-revalidate (issue #1585). A fresh snapshot is
    // returned immediately; a stale one is served while a single-flight refresh
    // runs in the background. The request path never blocks on a full hook-log
    // scan — the prior inline `await runLessonYieldScan(days)` could stall up to
    // the 30s scan bound and hung past a 10s curl cap in prod on 2026-07-26.
    const nowMs = Date.now();
    const cached = lessonYieldCache.getEntry(days);
    if (cached && cached.expiresAtMs > nowMs) {
      return c.json(cached.snapshot);
    }

    const refresh = runLessonYieldScan(days);
    if (cached) {
      // Stale cache present: serve it now, let the refresh land in background.
      refresh.catch(() => { /* soft: staleness is visible via generatedAt */ });
      return c.json(cached.snapshot);
    }

    // Cold cache: wait for the first scan, but only up to the request budget.
    // If the budget elapses first the bounded scan keeps running and warms the
    // cache for the retry, so the client is never left blocked on the endpoint.
    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'budget'>((resolve) => {
      budgetTimer = setTimeout(() => resolve('budget'), LESSON_YIELD_REQUEST_BUDGET_MS);
    });
    try {
      const outcome = await Promise.race([refresh, budget]);
      if (outcome === 'budget') {
        // Do not orphan the still-pending scan's rejection.
        refresh.catch(() => { /* handled by the /api/health backoff path */ });
        return c.json(
          {
            error: 'lesson_yield_warming',
            message: `Snapshot for days=${days} is still computing; retry shortly.`,
            retryAfterMs: LESSON_YIELD_REQUEST_BUDGET_MS,
          },
          503,
        );
      }
      return c.json(outcome);
    } catch (err) {
      // `AbortSignal.timeout` rejects with a DOMException — match by name so
      // the verdict does not depend on DOMException's Error inheritance.
      const name = (err as { name?: string } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return c.json(
          { error: 'lesson_yield_scan_timeout', message: `Hook-log scan exceeded ${LESSON_YIELD_SCAN_TIMEOUT_MS}ms` },
          503,
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  });

  app.get('/api/live-friction-calibration', async (c) => {
    try {
      const logPath = interactionLog.getFilePath();
      const events = logPath ? await readInteractionLog(logPath) : [];
      const activeFindings = queue.inspectActive().map((entry) => ({
        agentId: entry.agentId,
        anomalyType: entry.anomaly.type,
      }));
      return c.json(buildLiveFrictionCalibrationSnapshot(events, activeFindings));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/finding-evidence-audit', (c) => c.json({
    records: deps.monitor.getFindingEvidenceAuditRecords(),
    reviewCandidates: deps.monitor.getFindingEvidenceReviewCandidates(20),
  }));

  app.get('/api/finding-evidence-operations-diagnostics', async (c) => {
    const auditRecords = deps.monitor.getFindingEvidenceAuditRecords();
    const reviewCandidates = deps.monitor.getFindingEvidenceReviewCandidates(20);
    const reviewLog = await getFindingEvidenceReviewLogStore().readAll();
    const proposalResponse = buildDetectorProposalReportResponseV1(reviewLog.records, reviewLog.diagnostics);
    let sampler:
      | { status: 'available'; value: Awaited<ReturnType<NonNullable<typeof deps.findingEvidenceReviewSampler>['getStatus']>> }
      | { status: 'unavailable'; error: string };
    if (!deps.findingEvidenceReviewSampler) {
      sampler = { status: 'unavailable', error: 'finding-review-sampler-unavailable' };
    } else {
      try {
        sampler = { status: 'available', value: await deps.findingEvidenceReviewSampler.getStatus() };
      } catch {
        sampler = { status: 'unavailable', error: 'finding-review-sampler-unavailable' };
      }
    }

    return c.json({
      schemaVersion: 'finding-evidence-operations-diagnostics.v1',
      audit: {
        recordsCount: auditRecords.length,
        reviewCandidatesCount: reviewCandidates.length,
      },
      reviewLog: buildReviewLogOperationsSummary(reviewLog.records, reviewLog.diagnostics),
      sampler,
      proposals: {
        reports: proposalResponse.reports.slice(0, 20).map((report) => ({
          detectorTarget: report.detectorTarget,
          candidateKind: report.candidateKind,
          reviewCounts: report.reviewCounts,
          proposal: {
            status: report.proposal.status,
            summary: report.proposal.summary,
          },
        })),
        diagnosticsCount: proposalResponse.diagnostics.length,
      },
    });
  });

  app.post('/api/finding-evidence-review', async (c) => {
    if (process.env.KOOKR_FINDING_REVIEW_ENABLED !== 'true') return c.json({ error: 'finding-review-disabled' }, 404);
    if (!deps.llmClient) return c.json({ error: 'finding-review-llm-unavailable' }, 503);
    if (!isAuthorizedFindingReviewRequest(getRemoteAddress(c), c.req.header(REVIEW_ADMIN_TOKEN_HEADER))) {
      return c.json({ error: 'finding-review-forbidden' }, 403);
    }
    const requiredToken = process.env.KOOKR_FINDING_REVIEW_TOKEN?.trim();
    if (requiredToken && !timingSafeTokenEqual(requiredToken, c.req.header(REVIEW_CSRF_HEADER))) {
      return c.json({ error: 'invalid-finding-review-token' }, 403);
    }

    let body: { mode?: unknown; limit?: unknown } = {};
    const text = await c.req.text();
    if (text.trim()) {
      try {
        body = JSON.parse(text) as { mode?: unknown; limit?: unknown };
      } catch {
        return c.json({ error: 'invalid-json' }, 400);
      }
    }

    const { service: reviewService, config: reviewConfig } = getFindingEvidenceReviewService();
    const mode = body.mode ?? 'estimate_only';
    if (mode !== 'estimate_only' && mode !== 'model_review' && mode !== 'persisted_review') {
      return c.json({ error: 'invalid-mode' }, 400);
    }
    if (mode !== 'estimate_only' && reviewConfig.dailyCostCents <= 0) {
      return c.json({ error: 'finding-review-budget-required' }, 403);
    }

    try {
      return c.json(await reviewService.review({
        mode: mode as FindingEvidenceReviewMode,
        limit: typeof body.limit === 'number' ? body.limit : undefined,
      }));
    } catch (err) {
      if (err instanceof FindingEvidenceReviewServiceError) {
        return c.json({ error: err.code, message: err.message }, err.status);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/finding-evidence-review-log', async (c) => {
    if (!isAuthorizedFindingReviewRequest(getRemoteAddress(c), c.req.header(REVIEW_ADMIN_TOKEN_HEADER))) {
      return c.json({ error: 'finding-review-forbidden' }, 403);
    }

    const limitParam = c.req.query('limit');
    const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;
    const read = await getFindingEvidenceReviewLogStore().readAll();
    const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
    return c.json({
      schemaVersion: 'finding-evidence-review-log-read.v1',
      records: read.records.slice(-boundedLimit),
      diagnostics: read.diagnostics,
    });
  });

  app.get('/api/finding-evidence-review-detector-proposals', async (c) => {
    if (!isAuthorizedFindingReviewRequest(getRemoteAddress(c), c.req.header(REVIEW_ADMIN_TOKEN_HEADER))) {
      return c.json({ error: 'finding-review-forbidden' }, 403);
    }

    const minReviewsParam = c.req.query('minReviews');
    const maxEvidenceParam = c.req.query('maxEvidence');
    const read = await getFindingEvidenceReviewLogStore().readAll();
    return c.json(buildDetectorProposalReportResponseV1(read.records, read.diagnostics, {
      minPopulationReviews: readPositiveIntQuery(minReviewsParam, 2, 100),
      maxEvidencePerReport: readPositiveIntQuery(maxEvidenceParam, 5, 50),
    }));
  });

  app.get('/api/finding-evidence-review-sampler', async (c) => {
    if (!isAuthorizedFindingReviewRequest(getRemoteAddress(c), c.req.header(REVIEW_ADMIN_TOKEN_HEADER))) {
      return c.json({ error: 'finding-review-forbidden' }, 403);
    }
    if (!deps.findingEvidenceReviewSampler) return c.json({ error: 'finding-review-sampler-unavailable' }, 503);
    return c.json(await deps.findingEvidenceReviewSampler.getStatus());
  });

  function getFindingEvidenceReviewService(): {
    service: FindingEvidenceReviewService;
    config: FindingEvidenceReviewServiceConfig;
  } {
    if (!findingEvidenceReviewService || !findingEvidenceReviewConfig) {
      findingEvidenceReviewConfig = readFindingEvidenceReviewConfigFromEnv(
        process.env,
        deps.findingEvidenceReviewHmacKey ?? (deps.kookrDir ? getOrCreateFindingEvidenceReviewHmacKey(deps.kookrDir) : Buffer.alloc(32, 0)),
        buildInfo?.commitHash,
      );
      findingEvidenceReviewService = new FindingEvidenceReviewService({
        candidateReader: {
          listReviewCandidates: (limit) => deps.monitor.getFindingEvidenceReviewCandidates(limit),
        },
        llmClient: deps.llmClient ?? null,
        config: findingEvidenceReviewConfig,
        reviewLogStore: getFindingEvidenceReviewLogStore(),
      });
    }
    return { service: findingEvidenceReviewService, config: findingEvidenceReviewConfig };
  }

  function getFindingEvidenceReviewLogStore(): ReviewLogStore {
    if (!findingEvidenceReviewLogStore) {
      findingEvidenceReviewLogStore = ReviewLogStore.forKookrDir(deps.kookrDir);
    }
    return findingEvidenceReviewLogStore;
  }

  app.get('/api/circuit-breakers', (c) => {
    if (!deps.circuitBreakerRegistry) return c.json([]);
    return c.json(deps.circuitBreakerRegistry.getAllSnapshots());
  });

  app.get('/api/tasks/:taskId/activity-diagnostics', async (c) => {
    const taskId = c.req.param('taskId');
    const task = taskStore.getTask(taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const kookrSessions = [];
    for (const session of task.sessions) {
      const kookrSessionId = session.tmuxSession;
      const monitorWindowSize = deps.monitor.getAgentEvents(kookrSessionId).length;
      const ledgerStats = deps.activityLedger
        ? await deps.activityLedger.stats(kookrSessionId)
        : undefined;
      const memMeta = deps.hookIngestion?.getActivityMeta(kookrSessionId);
      // Ledger is source of truth for durable counts; in-memory counters fill
      // gaps when the ledger is not configured.
      kookrSessions.push({
        kookrSessionId,
        parentSessionId: session.claudeSessionId,
        childSessionIds: Object.keys(session.childSessionIds ?? {}),
        rawRecordCount: ledgerStats?.rawRecordCount ?? memMeta?.totalEventsSeen ?? 0,
        parsedRecordCount: ledgerStats?.parsedRecordCount
          ?? ((memMeta?.parentEventCount ?? 0) + (memMeta?.childEventCount ?? 0)
              + (memMeta?.foreignEventCount ?? 0) + (memMeta?.unknownParentageCount ?? 0)),
        malformedRecordCount: ledgerStats?.malformedRecordCount ?? memMeta?.malformedRecordCount ?? 0,
        duplicateRecordCount: ledgerStats?.duplicateRecordCount ?? memMeta?.duplicateRecordCount ?? 0,
        unknownParentageCount: ledgerStats?.unknownParentageCount ?? memMeta?.unknownParentageCount ?? 0,
        droppedRecordCount: ledgerStats?.droppedRecordCount ?? memMeta?.droppedRecordCount ?? 0,
        monitorWindowSize,
        totalActivityEvents: ledgerStats?.rawRecordCount ?? memMeta?.totalEventsSeen ?? 0,
      });
    }

    return c.json({ taskId, kookrSessions });
  });

  app.post('/api/hook-event/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    if (!SESSION_ID_RE.test(sessionId)) {
      return c.json({ error: 'Invalid session id' }, 400);
    }
    const body = await c.req.text();
    if (!body.trim()) return c.json({ status: 'empty' }, 400);

    if (deps.hookIngestion) {
      // Active fast path: feed the body into the same ingestion service the
      // file watcher uses. Dedup by content hash keeps a single record from
      // reaching the adapter twice when the file watcher also delivers it.
      // See rfc-activity-log-reliability §5.
      const records = splitHookRequestBody(body);

      let dispatchedCount = 0;
      for (const record of records) {
        const result = deps.hookIngestion.ingestFromHttp(sessionId, record);
        if (result.dispatched) dispatchedCount += 1;
      }

      if (records.length === 1) {
        return c.json({ status: 'received', dispatched: dispatchedCount === 1 });
      }
      return c.json({
        status: 'received',
        dispatched: dispatchedCount > 0,
        recordCount: records.length,
        dispatchedCount,
      });
    }

    // Fallback: timing-only — shadow-detection era behavior.
    if (deps.httpPushTracker) {
      deps.httpPushTracker.recordHttpArrival(sessionId, body);
    }
    return c.json({ status: 'received' });
  });

  app.get('/api/shadow-report', async (c) => {
    const shadowLogPath = deps.shadowRegistry?.getLogFilePath();
    if (!shadowLogPath) return c.json({ error: 'Shadow detection not configured' }, 404);
    const format = c.req.query('format');

    // Stale-while-revalidate + concurrency 1 (issue #1764). Fresh cache →
    // immediate response. Stale cache → serve stale while single-flight
    // refresh runs. Cold + in-flight overlap → await the same promise (never
    // stack a second full parse). Cold + empty → wait up to the request budget.
    const nowMs = Date.now();
    const cached = shadowReportCache?.logPath === shadowLogPath
      ? shadowReportCache
      : undefined;
    if (cached && cached.expiresAtMs > nowMs) {
      if (format === 'text') return c.text(formatReport(cached.report));
      return c.json(cached.report);
    }

    const refresh = runShadowReportScan(shadowLogPath);
    if (cached) {
      refresh.catch(() => { /* soft: staleness is visible via generatedAt */ });
      if (format === 'text') return c.text(formatReport(cached.report));
      return c.json(cached.report);
    }

    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'budget'>((resolve) => {
      budgetTimer = setTimeout(() => resolve('budget'), SHADOW_REPORT_REQUEST_BUDGET_MS);
    });
    try {
      const outcome = await Promise.race([refresh, budget]);
      if (outcome === 'budget') {
        refresh.catch(() => { /* still warming for the next caller */ });
        return c.json(
          {
            error: 'shadow_report_warming',
            message: 'Shadow report is still computing; retry shortly.',
            retryAfterMs: SHADOW_REPORT_REQUEST_BUDGET_MS,
          },
          503,
        );
      }
      if (format === 'text') return c.text(formatReport(outcome));
      return c.json(outcome);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        500,
      );
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  });

  app.get('/api/reflect', async (c) => {
    try {
      const logPath = interactionLog.getFilePath();
      const events = logPath ? await readInteractionLog(logPath) : [];
      const report = analyzeSession(events);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/reflect/recommendation', async (c) => {
    try {
      const logPath = interactionLog.getFilePath();
      const events = logPath ? await readInteractionLog(logPath) : [];
      const report = analyzeSession(events);
      return c.json(buildReflectionRecommendationResponse(logPath, report));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/telemetry/report', async (c) => {
    try {
      const logPath = interactionLog.getFilePath();
      const { generateTelemetryReport } = await import('../../core/telemetry-report.js');
      const { getReconstructAbsoluteTuiScreenStats } = await import('../absolute-position-tui-screen.js');
      const { getAbsoluteTuiRecoveryStats } = await import('../session-bridge.js');
      // Live process counters for operators (not derived from client JSONL).
      const reconstructStats = getReconstructAbsoluteTuiScreenStats();
      const absoluteTuiRecoveryStats = getAbsoluteTuiRecoveryStats();

      if (!logPath) {
        return c.json({
          ...generateTelemetryReport([]),
          reconstructStats,
          absoluteTuiRecoveryStats,
        });
      }

      const telemetryPath = logPath.replace('interactions.jsonl', 'telemetry.jsonl');
      const events = await readTelemetryLog(telemetryPath);
      const report = generateTelemetryReport(events);
      return c.json({
        ...report,
        reconstructStats,
        absoluteTuiRecoveryStats,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Enriched snapshot keeps `active` for back-compat (issue #1947).
  app.get('/api/github/status', (c) => c.json(githubScanner.getStatusSnapshot()));

  app.get('/api/github/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    if (!taskStore.getTask(taskId)) {
      return c.json({ error: 'Task not found' }, 404);
    }
    const state = githubStateStore.getTaskState(taskId);
    return c.json(state);
  });

  app.get('/api/github', (c) => {
    const taskIds = githubStateStore.getTaskIdsWithReferences();
    const states = taskIds.map((id) => githubStateStore.getTaskState(id));
    return c.json(states);
  });

  // --- Self-diagnostic ---

  app.get('/api/diagnostic', (c) => {
    if (!deps.diagnosticRunner) return c.json({ report: null, lastError: null });
    return c.json(deps.diagnosticRunner.getStatus());
  });

  app.post('/api/diagnostic/run', (c) => {
    if (!deps.diagnosticRunner) return c.json({ error: 'Diagnostic runner not available' }, 503);
    console.log('[self-diagnostic] on-demand run triggered');
    const report = deps.diagnosticRunner.runNow();
    console.log(`[self-diagnostic] on-demand run complete, ${report.findings.length} findings`);
    return c.json({ report });
  });

  // Crash recovery startup summary endpoint (fetched once by frontend on mount).
  // Prefer the live getter (issue #1721 listen-early) so a post-listen recovery
  // result is visible once it lands; fall back to the static field for tests.
  app.get('/api/startup-summary', (c) =>
    c.json(deps.getStartupRecoverySummary?.() ?? deps.startupRecoverySummary ?? null),
  );

  app.get('/api/capture/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    try {
      const output = await adapter.captureDisplay(sessionId);
      return c.json({ sessionId, output, source: 'live' as const });
    } catch (err) {
      // Lucy's peek_kookr_task_output resolves a task then hits this endpoint
      // with the session id. After completion the ring is gone — fall back to
      // the durable task-tail store when present (rfc-task-tail-retrieval).
      const stored = deps.taskTailStore
        ? await deps.taskTailStore.getBySessionId(sessionId)
        : null;
      if (stored) {
        return c.json({
          sessionId,
          output: stored.text,
          source: 'persisted' as const,
          taskId: stored.taskId,
          capturedAt: stored.capturedAt,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message, sessionId }, 404);
    }
  });
}

const TERMINAL_OUTCOME_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const TERMINAL_OUTCOME_MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolve the terminal-outcome aggregation window from `?windowMs=` (or the
 * convenience `?hours=`), defaulting to 24h and clamping to [1 minute, 30 days]
 * so the histogram stays a bounded read (issue #2847). Non-numeric input falls
 * back to the default rather than erroring — this is a diagnostics glance.
 */
function parseTerminalOutcomeWindowMs(windowMsRaw?: string, hoursRaw?: string): number {
  let ms = TERMINAL_OUTCOME_DEFAULT_WINDOW_MS;
  if (windowMsRaw !== undefined) {
    const parsed = Number(windowMsRaw);
    if (Number.isFinite(parsed) && parsed > 0) ms = parsed;
  } else if (hoursRaw !== undefined) {
    const parsed = Number(hoursRaw);
    if (Number.isFinite(parsed) && parsed > 0) ms = parsed * 60 * 60 * 1000;
  }
  return Math.min(Math.max(ms, 60 * 1000), TERMINAL_OUTCOME_MAX_WINDOW_MS);
}

/**
 * Derive the terminal backend health status from its raw stats.
 * Per rfc-v8-tmux-removal.md §/api/health:
 *   - 'error'    on manifest-corrupt or dtach-unavailable (last error)
 *   - 'degraded' if there are pending writers or a recent last error
 *   - 'ok'       otherwise
 * Shared by GET /api/health (reporting) and GET /api/ready (verdict, #660).
 */
function deriveTerminalBackendStatus(stats: BackendStats): 'ok' | 'degraded' | 'error' {
  if (
    stats.lastError &&
    (stats.lastError.kind === 'manifest-corrupt' || stats.lastError.kind === 'dtach-unavailable')
  ) {
    return 'error';
  }
  // Success signals on the error bus must not pin the backend to `degraded`
  // via the sticky `lastError` slot: post-restart attach self-heal (#1345)
  // and a completed launch-abandoned boot reap (#2762).
  const benign = stats.lastError?.kind === 'session-recovery-repaired'
    || stats.lastError?.kind === 'launch-abandoned-recovered';
  if (stats.pendingWriters > 0 || (stats.lastError && !benign)) return 'degraded';
  return 'ok';
}

/** One subsystem entry in the GET /api/ready verdict (#660). */
interface ReadinessCheck {
  /** When true, a not-ready result flips the overall verdict to 503. */
  critical: boolean;
  ready: boolean;
  status: string;
  /** Machine-readable cause when not ready (e.g. errno code, error kind). */
  reason?: string;
  /** Optional operator-facing detail (e.g. startup phase description, #1721). */
  detail?: string;
}

/**
 * Cheap, non-flapping persistence writability probe for GET /api/ready:
 * a single access(2) on the state directory Kookr persists into — no agent
 * spawn, no file write. When the directory is not wired (tests / non-server
 * contexts) the check fails open so it never cordons a node it cannot assess.
 */
function checkPersistenceWritable(kookrDir: string | undefined): ReadinessCheck {
  if (!kookrDir) {
    return { critical: true, ready: true, status: 'unknown', reason: 'kookr-dir-unset' };
  }
  try {
    accessSync(kookrDir, fsConstants.W_OK);
    return { critical: true, ready: true, status: 'ok' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { critical: true, ready: false, status: 'error', reason: typeof code === 'string' ? code : 'unwritable' };
  }
}

/**
 * Critical schedule-runner liveness probe for GET `/api/ready` (issue #1707).
 *
 * Uses `lastTickCompletedAt` from {@link ScheduleService.getStatusSnapshot},
 * falling back to `runnerStartedAt` so the grace window before the first tick
 * does not false-not-ready a freshly started runner. Age beyond
 * {@link SCHEDULER_TICK_STALE_INTERVALS} × {@link SCHEDULE_TICK_INTERVAL_MS}
 * flips the check to not-ready (503 overall). Pure + optional `nowMs` for tests.
 *
 * When neither timestamp is present (runner not started yet — the brief window
 * between `markReady` and `startAfterListen`), fail open with
 * `status: 'starting'` so deploy gates are not blocked by schedule-runner boot
 * order.
 */
export function checkSchedulerTickReadiness(
  status: Pick<ScheduleStatusSnapshot, 'lastTickCompletedAt' | 'runnerStartedAt'>,
  nowMs: number = Date.now(),
  options?: { tickIntervalMs?: number; staleIntervals?: number },
): ReadinessCheck {
  const tickIntervalMs = options?.tickIntervalMs ?? SCHEDULE_TICK_INTERVAL_MS;
  const staleIntervals = options?.staleIntervals ?? SCHEDULER_TICK_STALE_INTERVALS;
  const maxAgeMs = tickIntervalMs * staleIntervals;

  const lastTick = status.lastTickCompletedAt;
  const runnerStarted = status.runnerStartedAt;
  const anchorIso = lastTick ?? runnerStarted;
  if (!anchorIso) {
    return {
      critical: true,
      ready: true,
      status: 'starting',
      reason: 'runner-not-started',
    };
  }

  const anchorMs = Date.parse(anchorIso);
  if (!Number.isFinite(anchorMs)) {
    return {
      critical: true,
      ready: false,
      status: 'error',
      reason: 'invalid-timestamp',
    };
  }

  const ageMs = nowMs - anchorMs;
  if (ageMs > maxAgeMs) {
    return {
      critical: true,
      ready: false,
      status: 'stale',
      reason: lastTick ? 'tick-stale' : 'no-tick-since-start',
      detail: `last progress ${Math.round(ageMs / 1000)}s ago (threshold ${Math.round(maxAgeMs / 1000)}s)`,
    };
  }

  return {
    critical: true,
    ready: true,
    status: lastTick ? 'ok' : 'awaiting-first-tick',
  };
}

/**
 * Non-critical hook-ingestion lag probe for GET `/api/ready` (issue #1870).
 *
 * Uses the existing {@link HookIngestion.getDiagnosticsSnapshot} surface: a
 * session is "stalled" when its last measured lag exceeds
 * `lagWarningThresholdMs`. Always `critical: false` so lag is visible in
 * `checks.hookIngestion` without cordoning the node (overall ready stays 200
 * when only this check fails). Pure for unit tests.
 */
export function checkHookIngestionReadiness(
  snapshot: Pick<HookIngestionDiagnosticsSnapshot, 'lagWarningThresholdMs' | 'sessionCount' | 'sessions'>,
): ReadinessCheck {
  const thresholdMs = snapshot.lagWarningThresholdMs;
  const stalled = snapshot.sessions.filter(
    (session) => session.lag.lastMs != null && session.lag.lastMs > thresholdMs,
  );

  if (stalled.length === 0) {
    return {
      critical: false,
      ready: true,
      status: snapshot.sessionCount === 0 ? 'idle' : 'ok',
    };
  }

  const worstLagMs = Math.max(
    ...stalled.map((session) => session.lag.lastMs as number),
  );
  return {
    critical: false,
    ready: false,
    status: 'stalled',
    reason: 'ingestion-lag',
    detail: `last lag ${worstLagMs}ms exceeds threshold ${thresholdMs}ms across ${stalled.length} session(s)`,
  };
}

/**
 * Non-critical fail-closed pause probe for GET `/api/ready` (issue #2427).
 *
 * A consecutive-failure pause is operator-owned: the runner already stopped
 * firing those schedules so the node is still safe to accept new work. This
 * check reports the pause on the cheap readiness probe so remote smoke/Lucy
 * can see a half-dead belt without opening the 14KB health blob. Always
 * `critical: false` — overall ready stays 200. Never resumes a pause.
 * Pure for unit tests.
 */
export function checkSchedulesPausedReadiness(
  status: Pick<ScheduleStatusSnapshot, 'schedulesPausedByFailure'>,
): ReadinessCheck {
  const paused = status.schedulesPausedByFailure ?? [];
  if (paused.length === 0) {
    return {
      critical: false,
      ready: true,
      status: 'ok',
    };
  }

  const names = paused.map((schedule) => schedule.name || schedule.id);
  const shown = names.slice(0, PAUSED_SCHEDULES_READY_SAMPLE_LIMIT);
  const extra = names.length - shown.length;
  const sample = extra > 0 ? `${shown.join(', ')} (+${extra} more)` : shown.join(', ');
  const count = paused.length;
  return {
    critical: false,
    ready: false,
    status: 'paused',
    reason: 'consecutive-failures',
    detail: `${count} schedule${count === 1 ? '' : 's'} paused: ${sample}`,
  };
}

/**
 * Compact crash-recovery counts for GET `/api/health` (issue #2351).
 *
 * Counts only — full relaunched/skipped/failed entry lists stay on
 * `GET /api/startup-summary`. `crashLoopSkips` is the subset of `skipped`
 * whose reason came from either crash-loop guard (see crash-recovery.ts).
 */
export interface StartupRecoveryHealthSummary {
  relaunched: number;
  skipped: number;
  failed: number;
  crashLoopSkips: number;
  generatedAt: string;
}

const EMPTY_CRASH_RECOVERY_RESULT: CrashRecoveryResult = {
  relaunched: [],
  skipped: [],
  failed: [],
};

/**
 * Project a full crash-recovery result into health counts.
 */
export function buildStartupRecoveryHealthSummary(
  summary: Pick<CrashRecoveryResult, 'relaunched' | 'skipped' | 'failed'>,
  generatedAt: string,
): StartupRecoveryHealthSummary {
  let crashLoopSkips = 0;
  for (const entry of summary.skipped) {
    if (typeof entry.reason === 'string' && isCrashLoopSkipReason(entry.reason)) {
      crashLoopSkips += 1;
    }
  }
  return {
    relaunched: summary.relaunched.length,
    skipped: summary.skipped.length,
    failed: summary.failed.length,
    crashLoopSkips,
    generatedAt,
  };
}

/**
 * Resolve the optional `startupRecovery` health block (issue #2351).
 *
 * - Omitted before recovery completes when no summary has been stored yet.
 * - After `startupReadiness` reports `readyAt` (or once a summary exists),
 *   returns counts — zeros when crash recovery had nothing to report.
 * - `generatedAt` prefers readiness `readyAt`, then the caller fallback
 *   (typically `serverStartedAt`), then "now" for partial test harnesses.
 */
export function resolveStartupRecoveryHealthBlock(
  deps: Pick<
    RouteDeps,
    'getStartupRecoverySummary' | 'startupRecoverySummary' | 'startupReadiness'
  >,
  fallbackGeneratedAt?: string,
): StartupRecoveryHealthSummary | undefined {
  const summary =
    deps.getStartupRecoverySummary?.() ?? deps.startupRecoverySummary ?? null;
  const readyAt = deps.startupReadiness?.getProgress()?.readyAt;
  if (summary == null && readyAt == null) return undefined;

  const generatedAt =
    readyAt ??
    (typeof fallbackGeneratedAt === 'string' && fallbackGeneratedAt.length > 0
      ? fallbackGeneratedAt
      : new Date().toISOString());

  return buildStartupRecoveryHealthSummary(
    summary ?? EMPTY_CRASH_RECOVERY_RESULT,
    generatedAt,
  );
}

/**
 * Four-field timer-health counts for GET `/api/health` (issue #2636).
 * Prefer the tracker's `summary()` (uses register time for oldest never-fired);
 * fall back to summarizing a stubbed `snapshot()` so partial test harnesses
 * still publish the block. Always returns a summary so last-good health has
 * the keys even when no tracker is wired (all zeros).
 */
function timerHealthSummaryForHealth(
  recorder: RouteDeps['timerHealth'],
) {
  if (!recorder) return EMPTY_TIMER_HEALTH_SUMMARY;
  if (typeof recorder.summary === 'function') return recorder.summary();
  return summarizeTimerHealth(recorder.snapshot());
}

/**
 * Latest resource sample projected onto GET `/api/health` (issue #2791).
 *
 * Until now the RSS/heap/event-loop/memory/data-directory gauges were only
 * pushed to dashboard WebSocket clients as `resourceStatus`. The HTTP health
 * response is the dependable remote probe, so this block reuses the SAME cached
 * sample the background {@link ResourceStatusService} already maintains — no
 * re-sample, no fresh `/proc` or filesystem walk on the health hot path.
 *
 * Deliberately path-free: the data-directory `path` is omitted to match the
 * `dataDirectory` health block (#2896), since health and its last-good mirror
 * are operator-visible. `ageMs` is the sample-freshness field — how stale the
 * gauges are relative to the health assembly, so a caller can tell a live
 * sample from a frozen one. `status` is `known` once a sample exists and
 * `unknown` before the first tick (or when the getter is unwired).
 */
export interface ResourceStatusHealthBlock {
  status: 'known' | 'unknown';
  sampledAt: string | null;
  ageMs: number | null;
  sampleGapMs: number | null;
  timerDriftMs: number | null;
  host: {
    cpuUsagePercent: number | null;
    memoryUsedPercent: number | null;
    memoryFreeBytes: number | null;
    memoryTotalBytes: number | null;
    dataDirectory: {
      diskFreeBytes: number | null;
      diskTotalBytes: number | null;
      diskFreePercent: number | null;
      diskFreeInodes: number | null;
      diskTotalInodes: number | null;
    };
  };
  server: {
    eventLoopDelayP95Ms: number | null;
    processRssBytes: number | null;
    processHeapUsedBytes: number | null;
    processHeapTotalBytes: number | null;
  };
  unavailable: SystemResourceStatus['unavailable'];
}

export function buildResourceStatusHealthBlock(
  latest: SystemResourceStatus | null,
  nowMs: number,
): ResourceStatusHealthBlock {
  if (!latest) {
    return {
      status: 'unknown',
      sampledAt: null,
      ageMs: null,
      sampleGapMs: null,
      timerDriftMs: null,
      host: {
        cpuUsagePercent: null,
        memoryUsedPercent: null,
        memoryFreeBytes: null,
        memoryTotalBytes: null,
        dataDirectory: {
          diskFreeBytes: null,
          diskTotalBytes: null,
          diskFreePercent: null,
          diskFreeInodes: null,
          diskTotalInodes: null,
        },
      },
      server: {
        eventLoopDelayP95Ms: null,
        processRssBytes: null,
        processHeapUsedBytes: null,
        processHeapTotalBytes: null,
      },
      unavailable: [],
    };
  }
  // Freshness: clamp at 0 so a small clock skew never reports a negative age,
  // and leave null when the sampler stamped an unparseable timestamp.
  const sampledAtMs = Date.parse(latest.sampledAt);
  const ageMs = Number.isFinite(sampledAtMs) ? Math.max(0, nowMs - sampledAtMs) : null;
  return {
    status: 'known',
    sampledAt: latest.sampledAt,
    ageMs,
    sampleGapMs: latest.sampleGapMs,
    timerDriftMs: latest.timerDriftMs,
    host: {
      cpuUsagePercent: latest.host.cpuUsagePercent,
      memoryUsedPercent: latest.host.memoryUsedPercent,
      memoryFreeBytes: latest.host.memoryFreeBytes,
      memoryTotalBytes: latest.host.memoryTotalBytes,
      dataDirectory: {
        diskFreeBytes: latest.host.dataDirectory.diskFreeBytes,
        diskTotalBytes: latest.host.dataDirectory.diskTotalBytes,
        diskFreePercent: latest.host.dataDirectory.diskFreePercent,
        diskFreeInodes: latest.host.dataDirectory.diskFreeInodes ?? null,
        diskTotalInodes: latest.host.dataDirectory.diskTotalInodes ?? null,
      },
    },
    server: {
      eventLoopDelayP95Ms: latest.server.eventLoopDelayP95Ms,
      processRssBytes: latest.server.processRssBytes,
      processHeapUsedBytes: latest.server.processHeapUsedBytes,
      processHeapTotalBytes: latest.server.processHeapTotalBytes,
    },
    unavailable: latest.unavailable,
  };
}

/**
 * Slim hook-ingestion lag gauges for GET `/api/health` (issue #2319).
 *
 * Projects counters already on {@link HookIngestionDiagnosticsSnapshot}
 * plus max/p95 lag rolled up from in-memory session lag samples — never
 * re-scans hook files. Omitted from health when ingestion is unwired.
 * Observability only; does not affect `/api/ready` criticality.
 */
export interface HookIngestionHealthSummary {
  sessionCount: number;
  notableLagCount: number;
  lagWarningThresholdMs: number;
  maxLagMs: number | null;
  p95LagMs: number | null;
  generatedAt: string;
}

export function buildHookIngestionHealthSummary(
  snapshot: Pick<
    HookIngestionDiagnosticsSnapshot,
    | 'sessionCount'
    | 'notableLagCount'
    | 'lagWarningThresholdMs'
    | 'generatedAt'
    | 'sessions'
  >,
): HookIngestionHealthSummary {
  let maxLagMs: number | null = null;
  let p95LagMs: number | null = null;
  for (const session of snapshot.sessions) {
    const maxMs = session.lag?.maxMs;
    if (typeof maxMs === 'number' && Number.isFinite(maxMs)) {
      maxLagMs = maxLagMs === null ? maxMs : Math.max(maxLagMs, maxMs);
    }
    const p95Ms = session.lag?.p95Ms;
    if (typeof p95Ms === 'number' && Number.isFinite(p95Ms)) {
      // Worst-session p95: a compact fleet-wide stall signal without re-aggregating
      // every lag sample (per-session p95 is already computed in the snapshot).
      p95LagMs = p95LagMs === null ? p95Ms : Math.max(p95LagMs, p95Ms);
    }
  }
  return {
    sessionCount: snapshot.sessionCount,
    notableLagCount: snapshot.notableLagCount,
    lagWarningThresholdMs: snapshot.lagWarningThresholdMs,
    maxLagMs,
    p95LagMs,
    generatedAt: snapshot.generatedAt,
  };
}

function parseDeliveryTraceFilter(c: Context): DeliveryTraceFilter {
  const filter: DeliveryTraceFilter = {};
  const findingId = c.req.query('findingId')?.trim();
  const correlationId = c.req.query('correlationId')?.trim();
  const agentId = c.req.query('agentId')?.trim();
  const fingerprintHash = c.req.query('fingerprintHash')?.trim();
  if (findingId) filter.findingId = findingId;
  if (correlationId) filter.correlationId = correlationId;
  if (agentId) filter.agentId = agentId;
  if (fingerprintHash) filter.fingerprintHash = fingerprintHash;
  return filter;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function emptyHookIngestionDiagnosticsSnapshot(): HookIngestionDiagnosticsSnapshot {
  return {
    schemaVersion: 'hook-ingestion-diagnostics.v1',
    generatedAt: new Date().toISOString(),
    lagWarningThresholdMs: DEFAULT_HOOK_INGESTION_LAG_WARNING_THRESHOLD_MS,
    sessionCount: 0,
    totalArrivals: 0,
    missingWriteTimestampCount: 0,
    notableLagCount: 0,
    sessions: [],
  };
}

function emptyHookWatcherHealthSnapshot(): HookWatcherHealthSnapshot {
  return {
    schemaVersion: 'hook-watcher-health.v1',
    generatedAt: new Date().toISOString(),
    sessionCount: 0,
    sessions: [],
  };
}

function isAuthorizedFindingReviewRequest(remoteAddress: string | undefined, adminTokenHeader: string | undefined): boolean {
  const configuredAdminToken = process.env.KOOKR_FINDING_REVIEW_ADMIN_TOKEN?.trim();
  if (configuredAdminToken && timingSafeTokenEqual(configuredAdminToken, adminTokenHeader)) return true;
  return remoteAddress !== undefined && isLoopbackAddress(remoteAddress);
}

function getRemoteAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized === '::ffff:127.0.0.1'
    || normalized === '127.0.0.1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

function buildReviewLogOperationsSummary(
  records: Awaited<ReturnType<ReviewLogStore['readAll']>>['records'],
  diagnostics: Awaited<ReturnType<ReviewLogStore['readAll']>>['diagnostics'],
): {
  recordsCount: number;
  validReviews: number;
  invalidAttempts: number;
  diagnosticsCount: number;
  verdictCounts: Record<string, number>;
} {
  const verdictCounts: Record<string, number> = {};
  let validReviews = 0;
  let invalidAttempts = 0;
  for (const record of records) {
    if (record.kind === 'valid_review') {
      validReviews += 1;
      verdictCounts[record.review.verdict] = (verdictCounts[record.review.verdict] ?? 0) + 1;
    } else {
      invalidAttempts += 1;
    }
  }
  return {
    recordsCount: records.length,
    validReviews,
    invalidAttempts,
    diagnosticsCount: diagnostics.length,
    verdictCounts,
  };
}

function readPositiveIntQuery(value: string | undefined, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
