import { useEffect } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type {
  CapacityResidualStatus,
  LaunchDependenciesStatus,
  LaunchDependencyStatusRow,
  LessonYieldStatus,
  PausedScheduleStatusRow,
  PipelineStarvationRepoStatus,
  PipelineStarvationStatus,
  ProdSmokeTickStatus,
  ResourceWatchdogStatus,
  PausedSchedulesStatus,
} from '../store/store-types.js';

/** Default poll interval for `/api/health` ops-health projections (smoke + watchdog + FAA residual + pipeline starvation + launch deps + paused schedules). */
export const OPS_HEALTH_POLL_INTERVAL_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function parseProdSmokeTick(value: unknown): ProdSmokeTickStatus | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const consecutiveFailures = rec.consecutiveFailures;
  if (typeof consecutiveFailures !== 'number' || !Number.isFinite(consecutiveFailures)) {
    return null;
  }
  const status = rec.status;
  const failingChecks = Array.isArray(rec.failingChecks)
    ? rec.failingChecks.filter((item): item is string => typeof item === 'string')
    : undefined;
  return {
    consecutiveFailures: Math.max(0, Math.floor(consecutiveFailures)),
    ...(status === 'ok' || status === 'alert' || status === 'unknown' ? { status } : {}),
    ...(failingChecks ? { failingChecks } : {}),
    ...(typeof rec.generatedAt === 'string' ? { generatedAt: rec.generatedAt } : {}),
    ...(typeof rec.firstFailedAt === 'string' ? { firstFailedAt: rec.firstFailedAt } : {}),
  };
}

function parseResourceWatchdog(value: unknown): ResourceWatchdogStatus | null {
  const rec = asRecord(value);
  if (!rec || typeof rec.enabled !== 'boolean') return null;
  return {
    enabled: rec.enabled,
    ...(typeof rec.lastDecision === 'string' || rec.lastDecision === null
      ? { lastDecision: rec.lastDecision as string | null }
      : {}),
    ...(typeof rec.pressureWhileDisabled === 'boolean'
      ? { pressureWhileDisabled: rec.pressureWhileDisabled }
      : {}),
    ...(typeof rec.pressureWhileDisabledReason === 'string' || rec.pressureWhileDisabledReason === null
      ? { pressureWhileDisabledReason: rec.pressureWhileDisabledReason as string | null }
      : {}),
  };
}

/**
 * Parse `GET /api/health.capacity` for the FAA residual pill (issue #2082).
 * Returns null when the block is missing or missing the FAA count field.
 */
export function parseCapacityResidual(value: unknown): CapacityResidualStatus | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const byClass = asRecord(rec.byClass);
  if (!byClass) return null;
  const finishedAwaitingAck = byClass.finishedAwaitingAck;
  if (typeof finishedAwaitingAck !== 'number' || !Number.isFinite(finishedAwaitingAck)) {
    return null;
  }
  const oldest = rec.oldestFinishedAwaitingAckAgeMs;
  const oldestFinishedAwaitingAckAgeMs =
    oldest === null
      ? null
      : typeof oldest === 'number' && Number.isFinite(oldest)
        ? Math.max(0, oldest)
        : null;
  return {
    finishedAwaitingAck: Math.max(0, Math.floor(finishedAwaitingAck)),
    oldestFinishedAwaitingAckAgeMs,
  };
}

/**
 * Parse `GET /api/health.launchDependencies` for the status-bar deps pill
 * (issue #2364). Returns null when the block is missing or totalDegradedTasks
 * is non-numeric. Slim rows drop affectedTaskIds.
 */
export function parseLaunchDependencies(value: unknown): LaunchDependenciesStatus | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const totalRaw = rec.totalDegradedTasks;
  if (typeof totalRaw !== 'number' || !Number.isFinite(totalRaw) || totalRaw < 0) {
    return null;
  }

  const dependencies: LaunchDependencyStatusRow[] = [];
  if (Array.isArray(rec.dependencies)) {
    for (const rowValue of rec.dependencies) {
      const row = asRecord(rowValue);
      if (!row) continue;
      const name = row.dependency;
      if (typeof name !== 'string' || name.length === 0) continue;
      const countRaw = row.degradedTaskCount;
      if (typeof countRaw !== 'number' || !Number.isFinite(countRaw) || countRaw < 0) continue;
      const categories: string[] = [];
      if (Array.isArray(row.categories)) {
        for (const cat of row.categories) {
          if (typeof cat === 'string' && cat.length > 0) categories.push(cat);
        }
      }
      dependencies.push({
        dependency: name,
        degradedTaskCount: Math.floor(countRaw),
        categories,
      });
    }
  }

  const findingsRaw = rec.totalFindings;
  const totalFindings =
    typeof findingsRaw === 'number' && Number.isFinite(findingsRaw) && findingsRaw >= 0
      ? Math.floor(findingsRaw)
      : undefined;

  return {
    totalDegradedTasks: Math.floor(totalRaw),
    ...(totalFindings !== undefined ? { totalFindings } : {}),
    dependencies,
  };
}

/**
 * Parse `GET /api/health.schedules` for the status-bar paused-schedules
 * pill (issue #2432). Returns null when the block is missing or
 * `schedulesPausedByFailure` is present but not an array. An omitted
 * array becomes an empty projection — the scheduler is wired, nothing
 * is fail-closed paused.
 */
export function parseSchedules(value: unknown): PausedSchedulesStatus | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const raw = rec.schedulesPausedByFailure;
  if (raw == null) return { schedulesPausedByFailure: [] };
  if (!Array.isArray(raw)) return null;

  const schedulesPausedByFailure: PausedScheduleStatusRow[] = [];
  for (const entry of raw) {
    const row = asRecord(entry);
    if (!row) continue;
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const name = typeof row.name === 'string' && row.name.length > 0 ? row.name : id;
    const failsRaw = row.consecutiveFailures;
    const consecutiveFailures =
      typeof failsRaw === 'number' && Number.isFinite(failsRaw)
        ? Math.max(0, Math.floor(failsRaw))
        : 0;
    schedulesPausedByFailure.push({ id, name, consecutiveFailures });
  }
  return { schedulesPausedByFailure };
}

/**
 * Parse `GET /api/health.pipelineStarvation` for the Diagnostics card (issue #2259).
 * Guards on schemaVersion; unknown/renamed fields are dropped (optional).
 */
export function parsePipelineStarvation(value: unknown): PipelineStarvationStatus | null {
  const rec = asRecord(value);
  if (!rec || rec.schemaVersion !== 'pipeline-starvation.v1') return null;
  const reposRaw = asRecord(rec.repos);
  if (!reposRaw) return { schemaVersion: 'pipeline-starvation.v1', repos: {} };

  const repos: Record<string, PipelineStarvationRepoStatus> = {};
  for (const [key, rowValue] of Object.entries(reposRaw)) {
    const row = asRecord(rowValue);
    if (!row) continue;
    const consecutive = row.consecutiveBlockedEmpty;
    if (typeof consecutive !== 'number' || !Number.isFinite(consecutive)) continue;
    const cooldownRaw = row.effectiveScoutCooldownMs;
    const effectiveScoutCooldownMs =
      typeof cooldownRaw === 'number' && Number.isFinite(cooldownRaw) && cooldownRaw > 0
        ? Math.floor(cooldownRaw)
        : 0;
    const repoName = typeof row.repo === 'string' && row.repo.length > 0 ? row.repo : key;
    const parsed: PipelineStarvationRepoStatus = {
      repo: repoName,
      consecutiveBlockedEmpty: Math.max(0, Math.floor(consecutive)),
      effectiveScoutCooldownMs,
    };
    const lastBlockedEmptyAt = parseOptionalString(row.lastBlockedEmptyAt);
    if (lastBlockedEmptyAt !== undefined) parsed.lastBlockedEmptyAt = lastBlockedEmptyAt;
    const lastSpawnSkipReason = parseOptionalString(row.lastSpawnSkipReason);
    if (lastSpawnSkipReason !== undefined) parsed.lastSpawnSkipReason = lastSpawnSkipReason;
    const lastStarvationScoutTaskId = parseOptionalString(row.lastStarvationScoutTaskId);
    if (lastStarvationScoutTaskId !== undefined) parsed.lastStarvationScoutTaskId = lastStarvationScoutTaskId;
    const lastStarvationScoutAt = parseOptionalString(row.lastStarvationScoutAt);
    if (lastStarvationScoutAt !== undefined) parsed.lastStarvationScoutAt = lastStarvationScoutAt;
    const lastStarvationAlertAt = parseOptionalString(row.lastStarvationAlertAt);
    if (lastStarvationAlertAt !== undefined) parsed.lastStarvationAlertAt = lastStarvationAlertAt;
    const lastBatchKickAt = parseOptionalString(row.lastBatchKickAt);
    if (lastBatchKickAt !== undefined) parsed.lastBatchKickAt = lastBatchKickAt;
    if (typeof row.updatedAt === 'string') parsed.updatedAt = row.updatedAt;
    repos[key] = parsed;
  }

  return { schemaVersion: 'pipeline-starvation.v1', repos };
}

function nonNegIntFloor(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.floor(num);
}

/**
 * Parse `GET /api/health.lessonYield` for the Diagnostics card (issue #2395).
 * Guards on schemaVersion (`lesson-yield.v2`) and requires numeric decided +
 * completedInWindow (the yield denominator). Buckets default to zero; a missing
 * `yieldRate` is recomputed from the documented `decided / completedInWindow`
 * definition. Drops the heavy `byCompletionPath` tree — parity with the compact
 * `kookr status` gauge (issue #2305).
 */
export function parseLessonYield(value: unknown): LessonYieldStatus | null {
  const rec = asRecord(value);
  if (!rec || rec.schemaVersion !== 'lesson-yield.v2') return null;

  const decidedRaw = rec.decided;
  if (typeof decidedRaw !== 'number' || !Number.isFinite(decidedRaw) || decidedRaw < 0) {
    return null;
  }
  const completedRaw = rec.completedInWindow;
  if (typeof completedRaw !== 'number' || !Number.isFinite(completedRaw) || completedRaw < 0) {
    return null;
  }
  const decided = Math.floor(decidedRaw);
  const completedInWindow = Math.floor(completedRaw);

  const yieldRaw = rec.yieldRate;
  const yieldRate =
    typeof yieldRaw === 'number' && Number.isFinite(yieldRaw) && yieldRaw >= 0
      ? yieldRaw
      : completedInWindow === 0
        ? 0
        : decided / completedInWindow;

  const windowRaw = rec.windowDays;
  const windowDays =
    typeof windowRaw === 'number' && Number.isFinite(windowRaw) && windowRaw > 0
      ? Math.floor(windowRaw)
      : 1;

  const bucketsRec = asRecord(rec.buckets);
  const buckets = {
    wroteLesson: nonNegIntFloor(bucketsRec?.wroteLesson),
    explicitSkip: nonNegIntFloor(bucketsRec?.explicitSkip),
    searchOnly: nonNegIntFloor(bucketsRec?.searchOnly),
    noKbActivity: nonNegIntFloor(bucketsRec?.noKbActivity),
  };

  return { windowDays, yieldRate, decided, completedInWindow, buckets };
}

/**
 * Poll `GET /api/health` for smoke-tick failing streak, resourceWatchdog
 * enablement, capacity FAA residual, pipeline-starvation drought state,
 * launch-dependency degradation, fail-closed paused schedules, and
 * lesson-authoring yield, and push the slim projections into the store for
 * status-bar pills and the Diagnostics panel (issues #2037, #2082, #2259,
 * #2364, #2432, #2395). Soft-fails on network/parse errors so the dashboard
 * stays up.
 */
export function useOpsHealthPoll(intervalMs: number = OPS_HEALTH_POLL_INTERVAL_MS): void {
  const handleOpsHealth = useKookrStore((s) => s.handleOpsHealth);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function poll(): Promise<void> {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok || cancelled) return;
        const body: unknown = await res.json();
        if (cancelled) return;
        const rec = asRecord(body);
        if (!rec) return;
        handleOpsHealth({
          prodSmokeTick: parseProdSmokeTick(rec.prodSmokeTick),
          resourceWatchdog: parseResourceWatchdog(rec.resourceWatchdog),
          capacityResidual: parseCapacityResidual(rec.capacity),
          pipelineStarvation: parsePipelineStarvation(rec.pipelineStarvation),
          launchDependencies: parseLaunchDependencies(rec.launchDependencies),
          pausedSchedules: parseSchedules(rec.schedules),
          lessonYield: parseLessonYield(rec.lessonYield),
        });
      } catch {
        // Soft: pills stay at last known state; dashboard remains usable.
      }
    }

    void poll();
    if (intervalMs > 0) {
      timer = setInterval(() => {
        void poll();
      }, intervalMs);
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [handleOpsHealth, intervalMs]);
}
