import { randomUUID } from 'node:crypto';
import type { DeferredTelemetryLogWriter, TelemetryEvent } from './telemetry.js';

// --- Suggestion lifecycle tracking ---

export interface SuggestionLifecycle {
  suggestionId: string;
  agentId: string;
  displayedAt: number;       // Date.now() when suggestion was broadcast
  outcome: 'used' | 'cleared' | 'pending';
  resolvedAt?: number;
  durationMs?: number;
}

const activeLifecycles = new Map<string, SuggestionLifecycle>();

/** Generate a unique suggestion ID. */
export function generateSuggestionId(): string {
  return randomUUID().slice(0, 12);
}

/** Get the active suggestion ID for an agent (if any). */
export function getActiveSuggestionId(agentId: string): string | undefined {
  return activeLifecycles.get(agentId)?.suggestionId;
}

/**
 * Start a new suggestion lifecycle for an agent.
 * If one already exists (pending), resolve it as 'cleared' first.
 */
export function startLifecycle(
  agentId: string,
  suggestionId: string,
  telemetryLog?: DeferredTelemetryLogWriter | null,
): void {
  const existing = activeLifecycles.get(agentId);
  if (existing && existing.outcome === 'pending') {
    resolveLifecycle(agentId, 'cleared', telemetryLog);
  }
  activeLifecycles.set(agentId, {
    suggestionId,
    agentId,
    displayedAt: Date.now(),
    outcome: 'pending',
  });
}

/**
 * Resolve an active suggestion lifecycle.
 * No-op if already resolved or no lifecycle exists for this agent.
 */
export function resolveLifecycle(
  agentId: string,
  outcome: 'used' | 'cleared',
  telemetryLog?: DeferredTelemetryLogWriter | null,
): void {
  const lc = activeLifecycles.get(agentId);
  if (!lc || lc.outcome !== 'pending') return;

  const resolvedAt = Date.now();
  lc.outcome = outcome;
  lc.resolvedAt = resolvedAt;
  lc.durationMs = Math.max(0, resolvedAt - lc.displayedAt);

  // Write telemetry event (fire-and-forget)
  if (telemetryLog) {
    const event: TelemetryEvent = {
      type: 'suggestion_lifecycle',
      timestamp: new Date(resolvedAt).toISOString(),
      sessionId: '',  // Filled by DeferredTelemetryLogWriter
      platform: 'unknown',
      suggestionId: lc.suggestionId,
      agentId: lc.agentId,
      displayedAt: new Date(lc.displayedAt).toISOString(),
      durationMs: lc.durationMs,
      outcome,
    };
    telemetryLog.append(event).catch((err) => {
      console.warn(
        `[suggestion-telemetry] Write failed for ${lc.agentId}/${lc.suggestionId} outcome=${outcome}: ${err instanceof Error ? err.message : err}`,
      );
    });
  }

  activeLifecycles.delete(agentId);
}

/**
 * Drain all pending lifecycles on shutdown, resolving them as 'cleared'.
 */
export function drainLifecycles(telemetryLog?: DeferredTelemetryLogWriter | null): void {
  for (const [agentId, lc] of activeLifecycles) {
    if (lc.outcome === 'pending') {
      resolveLifecycle(agentId, 'cleared', telemetryLog);
    }
  }
}

/** Visible for testing: clear all lifecycle state. */
export function _resetLifecycles(): void {
  activeLifecycles.clear();
}
