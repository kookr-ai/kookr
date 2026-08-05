import { useEffect } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type {
  CapacityResidualStatus,
  ProdSmokeTickStatus,
  ResourceWatchdogStatus,
} from '../store/store-types.js';

/** Default poll interval for `/api/health` ops-health projections (smoke + watchdog + FAA residual). */
export const OPS_HEALTH_POLL_INTERVAL_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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
 * Poll `GET /api/health` for smoke-tick failing streak, resourceWatchdog
 * enablement, and capacity FAA residual, and push the slim projections into
 * the store for status-bar pills (issues #2037, #2082). Soft-fails on
 * network/parse errors so the dashboard stays up.
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
