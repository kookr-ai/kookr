import type { Context, Hono } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { createHash, timingSafeEqual } from 'node:crypto';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { readInteractionLog } from '../../core/interaction-log.js';
import { readTelemetryLog } from '../../core/telemetry.js';
import { analyzeSession } from '../../core/friction-analyzer.js';
import { buildLiveFrictionCalibrationSnapshot } from '../../core/live-friction-calibration.js';
import { getDetectionStats } from '../../core/detection-stats.js';
import { getStuckFlagPrecision } from '../../core/stuck-flag-precision.js';
import { buildLaunchDependencyDiagnostics } from '../../core/launch-dependency-diagnostics.js';
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
  LAUNCH_OUTCOMES_ROUTE,
  emptyLaunchOutcomeMetricsSnapshot,
} from '../../core/launch-outcome-metrics.js';
import { HOT_PATHS_ROUTE, getHotPathSampler } from '../../core/hot-path-sampler.js';
import { EMPTY_TERMINAL_INPUT_RTT_SNAPSHOT } from '../terminal-input-rtt-metrics.js';
import { splitHookRequestBody } from '../hook-record-framing.js';
import type { BackendStats } from '../../adapters/terminal-backend.js';
import { probeSttHealth } from '../../adapters/circuit-breaker-stt-client.js';
import type { RouteDeps } from './shared.js';
import type { HookIngestionDiagnosticsSnapshot } from '../hook-ingestion.js';
import type { HookWatcherHealthSnapshot } from '../hook-watcher.js';
import { getAuthThrottleSnapshot } from '../auth.js';
import { DELIVERY_TRACE_SCHEMA_VERSION, type DeliveryTraceFilter } from '../../shared/contracts/delivery-trace.js';
import { SESSION_HEALTH_SCHEMA_VERSION } from '../../shared/contracts/session-health.js';
import { TIMER_HEALTH_SCHEMA_VERSION } from '../../shared/contracts/timer-health.js';
import type { ScheduleStatusSnapshot } from '../../shared/contracts/schedule.js';
import { buildCapacityLedger } from '../../core/capacity-ledger.js';
import { resolveTaskAttentionSignals } from '../task-attention-signals.js';
import { MAX_ACTIVE_TASKS } from '../config.js';
import {
  computeLessonYield,
  hooksDirFromKookrDir,
  type LessonYieldSnapshot,
} from '../../core/lesson-decision.js';
import { computeCiBlindDebt, type CiBlindDebt } from '../../core/ci-blind-debt.js';
import {
  formatSafeModeDigestLine,
  resolveSafeModeStatus,
} from '../../core/automation-kill-switch.js';
import {
  defaultRetroVerifyQueueDir,
  readPendingRetroVerify,
} from '../../core/retro-verify-queue.js';
import {
  scanStaleProcesses,
  summarizeStaleProcesses,
  type StaleProcessSummary,
} from '../../core/orphan-process-scanner.js';
import { listProcessSnapshots } from '../../adapters/proc-process-lister.js';
import { SCHEDULE_TICK_INTERVAL_MS } from '../schedule-runner.js';

/**
 * How many missed schedule-runner tick intervals make GET `/api/ready`
 * `schedulerTick` critical-not-ready (issue #1707 / #1699 WS0). Two intervals
 * (~2 min at the default 60s cadence) is long enough that a single slow tick
 * does not flap readiness, and short enough that a dead tick loop is
 * visible to a process supervisor within a couple of minutes.
 */
export const SCHEDULER_TICK_STALE_INTERVALS = 2;

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
 * Cache TTL for the stale-process scan (issue #1723). A `/proc` walk is cheap
 * (a few ms) but a frequent health poll should not repeat it every request, so
 * the block is served stale-while-revalidate off a short-lived cache.
 */
const STALE_PROCESS_CACHE_MS = 15_000;
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
 * Scan `/proc` for stale relay-server + dtach processes and summarize per class.
 * Returns null on any platform without `/proc` (empty summary would be
 * indistinguishable from "clean"; null lets the block be omitted). Never throws.
 */
function scanStaleProcessSummary(): StaleProcessSummary | null {
  try {
    const snapshots = listProcessSnapshots();
    if (snapshots.length === 0) return null; // no /proc (non-Linux/sandbox)
    return summarizeStaleProcesses(
      scanStaleProcesses({
        listProcesses: () => snapshots,
        now: Date.now(),
        cwdExists: (dir) => existsSync(dir),
      }),
    );
  } catch {
    return null;
  }
}

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
  const lessonYieldCache = new Map<
    number,
    { expiresAtMs: number; snapshot: LessonYieldSnapshot }
  >();
  let lessonYieldRefreshNotBeforeMs = 0;
  const lessonYieldScansInFlight = new Map<number, Promise<LessonYieldSnapshot>>();

  // Stale-process gauge (issue #1723 item 4): relay-server + dtach class counts
  // and RSS, so orphan accumulation is visible before it OOMs anything. Served
  // stale-while-revalidate (like lessonYield): the request path NEVER awaits a
  // /proc walk — it returns the last cached summary and, when that is stale,
  // triggers a single-flight background refresh. A full-host /proc walk on the
  // health hot path is exactly what the 2026-07-26 OOM hotfix (c9792048)
  // removed for lessonYield; this block must not reintroduce it.
  let staleProcessCache: { expiresAtMs: number; summary: StaleProcessSummary | null } | null = null;
  let staleProcessScanInFlight = false;
  function refreshStaleProcessSummary(): void {
    if (staleProcessScanInFlight) return;
    staleProcessScanInFlight = true;
    // Defer off the request tick; the scan is sync but must not block the
    // response. setImmediate keeps it a fire-and-forget background refresh.
    setImmediate(() => {
      try {
        const summary = scanStaleProcessSummary();
        staleProcessCache = { expiresAtMs: Date.now() + STALE_PROCESS_CACHE_MS, summary };
      } catch {
        staleProcessCache = { expiresAtMs: Date.now() + STALE_PROCESS_CACHE_MS, summary: null };
      } finally {
        staleProcessScanInFlight = false;
      }
    });
  }
  function getStaleProcessSummary(): StaleProcessSummary | null {
    const cached = staleProcessCache;
    if (!cached || cached.expiresAtMs <= Date.now()) refreshStaleProcessSummary();
    return cached?.summary ?? null; // undefined until the first background scan warms the cache
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
      taskStore.listTasks(),
      hooksDirFromKookrDir(kookrDir),
      { days, signal: AbortSignal.timeout(LESSON_YIELD_SCAN_TIMEOUT_MS) },
    ).then((snapshot) => {
      lessonYieldCache.set(days, {
        expiresAtMs: Date.now() + LESSON_YIELD_CACHE_MS,
        snapshot,
      });
      return snapshot;
    }).finally(() => {
      lessonYieldScansInFlight.delete(days);
    });
    lessonYieldScansInFlight.set(days, scan);
    return scan;
  }

  app.get('/api/health', async (c) => {
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

    // Resource watchdog (issue #1724): last sample / trigger / throttle /
    // spawns-in-24h from the service's in-memory snapshot only — never a
    // fresh `/proc` or process-table scan on this request path (#1553).
    const resourceWatchdogBlock = deps.resourceWatchdog?.getHealthSnapshot();

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
    const tasks = taskStore.listTasks();
    const launchDependencies = buildLaunchDependencyDiagnostics(tasks);
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
      isLaunching: (task) => taskStore.hasFreshLaunchReservation(task.id),
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
    let safeModeBlock: { engaged: boolean; since?: string; digest?: string } | undefined;
    if (reservationSettings) {
      const status = resolveSafeModeStatus({
        automationKillSwitch: reservationSettings.automationKillSwitch,
        safeModeSince: reservationSettings.safeModeSince,
      });
      const digest = formatSafeModeDigestLine(status);
      safeModeBlock = {
        engaged: status.engaged,
        ...(status.since ? { since: status.since } : {}),
        ...(digest ? { digest } : {}),
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
      const cached = lessonYieldCache.get(1);
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

    // CI-blind-merge debt (issue #1703) — retro-verify queue depth + blind-merge
    // count. The spool is a small JSONL under ~/.kookr (or
    // KOOKR_RETRO_VERIFY_QUEUE_DIR); a single read is cheap enough for the
    // health hot path (unlike lesson-yield's hook-log scan). Failures are
    // soft: health stays 200 and omits the block rather than 500.
    let ciBlindDebtBlock: CiBlindDebt | undefined;
    try {
      const spoolDir = defaultRetroVerifyQueueDir(process.env);
      const pending = await readPendingRetroVerify(spoolDir);
      ciBlindDebtBlock = computeCiBlindDebt(pending);
    } catch {
      ciBlindDebtBlock = undefined;
    }

    const staleProcesses = getStaleProcessSummary();

    // Issue #1750: top-level machine-readable serving SHA so deploy/outcome
    // probes (and extractServingSha in incident-close-out) can read the commit
    // this process is *actually* serving without digging into `build`.
    // `sha` + `gitSha` are aliases of the same value for probe compatibility.
    const servingSha =
      typeof buildInfo?.commitHash === 'string' && buildInfo.commitHash.length > 0
        ? buildInfo.commitHash
        : undefined;

    return c.json({
      status: 'ok',
      agents: tasks.length,
      build: buildInfo,
      ...(servingSha ? { sha: servingSha, gitSha: servingSha } : {}),
      serverStartedAt,
      // Issue #1721: expose startup phase so operators/deploy can see
      // "listening, still recovering" vs "fully ready" without treating
      // liveness as readiness.
      ...(deps.startupReadiness ? { startup: deps.startupReadiness.getProgress() } : {}),
      launchDependencies,
      attentionQueue: {
        activeFindingDepth: queue.getDepth(attentionQueueSampledAtMs),
        oldestFindingAgeMs: queue.getOldestFindingAgeMs(attentionQueueSampledAtMs),
      },
      capacity,
      ...(safeModeBlock ? { safeMode: safeModeBlock } : {}),
      ...(lessonYieldBlock ? { lessonYield: lessonYieldBlock } : {}),
      // camelCase + snake_case: dashboard/status CLI use camelCase; daily
      // reports and the issue acceptance criterion name the metric
      // `ci_blind_debt`.
      ...(ciBlindDebtBlock
        ? { ciBlindDebt: ciBlindDebtBlock, ci_blind_debt: ciBlindDebtBlock }
        : {}),
      ...(terminalBackendBlock ? { terminalBackend: terminalBackendBlock } : {}),
      terminalWrite: terminalWriteBlock,
      ...(sessionReaperBlock ? { sessionReaper: sessionReaperBlock } : {}),
      ...(resourceWatchdogBlock ? { resourceWatchdog: resourceWatchdogBlock } : {}),
      ...(viewerBroadcasterBlock ? { viewerBroadcaster: viewerBroadcasterBlock } : {}),
      ...(deps.scheduleService ? { schedules: deps.scheduleService.getStatusSnapshot() } : {}),
      ...(staleProcesses ? { staleProcesses } : {}),
    });
  });

  // Machine-readable readiness verdict for orchestrators / load balancers
  // (issue #660, extended by #1721 / #1707). Unlike /api/health — which always
  // returns 200 so the dashboard never sees a hard error — /api/ready turns 503
  // when a *critical* subsystem is down or unavailable for new work: startup
  // recovery still in progress, operator drain mode, the terminal/dtach backend
  // in `error` (manifest-corrupt / dtach-unavailable), the persistence
  // directory unwritable, or the schedule-runner tick loop stale beyond N
  // tick-intervals (`schedulerTick`, issue #1707).
  // Non-critical degradation (terminal `degraded`) stays 200/ready so
  // transient blips do not cordon a node out of rotation.
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
    // Omitted when scheduling is not wired (tests / hermetic boots) so those
    // contexts stay fail-open.
    if (deps.scheduleService) {
      checks.schedulerTick = checkSchedulerTickReadiness(deps.scheduleService.getStatusSnapshot());
    }

    // Fail-open: a check only flips readiness when it is both critical and
    // not-ready. Non-critical checks are reported for visibility only.
    const ready = Object.values(checks).every((check) => check.ready || !check.critical);
    return c.json({ ready, checks }, ready ? 200 : 503);
  });

  app.get('/api/health/stt', async (c) => {
    if (!deps.sttUrl) return c.json({ status: 'disabled' }, 200);
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

  // Per-agent-type launch success/failure rates (issue #1808): process-local
  // counters so handshake flakiness is visible without log spelunking.
  app.get(LAUNCH_OUTCOMES_ROUTE, (c) => (
    c.json(deps.launchOutcomeMetrics?.snapshot() ?? emptyLaunchOutcomeMetricsSnapshot())
  ));

  app.get('/api/diagnostics/launch-dependencies', (c) => (
    c.json(buildLaunchDependencyDiagnostics(taskStore.listTasks()))
  ));

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
    const cached = lessonYieldCache.get(days);
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
      if (!logPath) {
        const { generateTelemetryReport } = await import('../../core/telemetry-report.js');
        return c.json(generateTelemetryReport([]));
      }

      const telemetryPath = logPath.replace('interactions.jsonl', 'telemetry.jsonl');
      const events = await readTelemetryLog(telemetryPath);
      const { generateTelemetryReport } = await import('../../core/telemetry-report.js');
      const report = generateTelemetryReport(events);
      return c.json(report);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/github/status', (c) => c.json({ active: githubScanner.isActive() }));

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
  // A successful post-restart self-heal (kookr-ai/kookr#1345) is a benign
  // success signal on the error bus, not a fault — it must not leave the backend
  // pinned to `degraded` forever via the sticky `lastError` slot.
  const benign = stats.lastError?.kind === 'session-recovery-repaired';
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

function timingSafeTokenEqual(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const presentedBytes = Buffer.from(presented, 'utf8');
  const expectedDigest = createHash('sha256').update(expectedBytes).digest();
  const presentedDigest = createHash('sha256').update(presentedBytes).digest();
  const equalLength = expectedBytes.length === presentedBytes.length;
  const equalDigest = timingSafeEqual(expectedDigest, presentedDigest);
  return equalLength && equalDigest;
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
