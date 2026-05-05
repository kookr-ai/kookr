/**
 * Shadow detection infrastructure for safe validation of new detection strategies.
 *
 * New strategies run in shadow mode: they evaluate against live data but their
 * verdicts are logged, not acted upon. The real detector continues to drive the
 * attention queue. After sufficient production traffic, an offline report compares
 * shadow vs. real verdicts using interval-based coverage metrics.
 *
 * Fire-and-forget logging: never throws, never blocks the caller.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Anomaly, AnomalyType, AnomalyConfidence } from './types.js';

// --- Strategy mode ---

export type StrategyMode = 'off' | 'shadow' | 'active';

export interface DetectionStrategyConfig {
  paneSemantics: StrategyMode;
  processLiveness: StrategyMode;
  httpPush: StrategyMode;
  combined: StrategyMode;
}

export const DEFAULT_STRATEGY_CONFIG: DetectionStrategyConfig = {
  paneSemantics: 'shadow',
  processLiveness: 'shadow',
  httpPush: 'shadow',
  combined: 'shadow',
};

// --- Shadow strategy interface ---

export type ShadowSource = 'http_push' | 'pane_semantics' | 'process_liveness' | 'combined';

export interface ShadowInputs {
  /** Pane text already captured by the watchdog */
  paneText: string;
  /** The real detector's current verdict for this agent */
  realAnomaly: Anomaly | null;
}

export interface ShadowStrategy {
  readonly source: ShadowSource;
  /** Evaluate and return the strategy's current anomaly verdict for this agent. */
  evaluate(agentId: string, inputs: ShadowInputs): Anomaly | null;
}

// --- Log entry types ---

export interface ShadowTransition {
  kind: 'transition';
  timestamp: string;
  agentId: string;
  source: ShadowSource;
  transition: 'entered_anomaly' | 'cleared_anomaly';
  anomalyType: AnomalyType;
  /** Strategy confidence at the moment of transition. Absent on cleared events. */
  confidence?: AnomalyConfidence;
  realState: { anomaly: AnomalyType | null; since: string | null };
  signals: Record<string, unknown>;
}

export interface ShadowHeartbeat {
  kind: 'heartbeat';
  timestamp: string;
  agentId: string;
  source: ShadowSource;
  shadowState: AnomalyType | null;
  /** Strategy confidence on this tick. Absent when shadowState is null (healthy). */
  confidence?: AnomalyConfidence;
  realState: AnomalyType | null;
}

export type ShadowLogEntry = ShadowTransition | ShadowHeartbeat;

// --- Registry ---

/**
 * Tracks shadow strategies, detects state transitions, and logs entries.
 * The registry maintains per-agent per-strategy state so it can detect
 * transitions (anomaly started/cleared) vs steady state (heartbeats).
 */
export class ShadowDetectorRegistry {
  private strategies: ShadowStrategy[] = [];
  /** Previous shadow verdict per (agentId, source) — null means healthy */
  private previousState = new Map<string, AnomalyType | null>();
  private logFilePath: string;

  constructor(logFilePath?: string) {
    this.logFilePath = logFilePath ?? join(homedir(), '.kookr', 'shadow-detection.jsonl');
  }

  register(strategy: ShadowStrategy): void {
    this.strategies.push(strategy);
  }

  getStrategies(): readonly ShadowStrategy[] {
    return this.strategies;
  }

  /**
   * Run all registered shadow strategies for an agent and log results.
   * Called on each watchdog tick, after the real detector has run.
   *
   * Returns the shadow verdicts (for testing; production callers ignore the return).
   */
  evaluate(agentId: string, inputs: ShadowInputs, now = new Date()): ShadowLogEntry[] {
    const entries: ShadowLogEntry[] = [];

    for (const strategy of this.strategies) {
      const shadowAnomaly = strategy.evaluate(agentId, inputs);
      const shadowType = shadowAnomaly?.type ?? null;
      const shadowConfidence = shadowAnomaly?.confidence;
      const stateKey = `${agentId}:${strategy.source}`;
      const previousType = this.previousState.get(stateKey) ?? null;

      // Detect transitions
      if (shadowType !== previousType) {
        if (shadowType !== null) {
          // Entered anomaly
          const transition: ShadowTransition = {
            kind: 'transition',
            timestamp: now.toISOString(),
            agentId,
            source: strategy.source,
            transition: 'entered_anomaly',
            anomalyType: shadowType,
            ...(shadowConfidence ? { confidence: shadowConfidence } : {}),
            realState: {
              anomaly: inputs.realAnomaly?.type ?? null,
              since: inputs.realAnomaly?.detectedAt.toISOString() ?? null,
            },
            signals: shadowAnomaly ? { explanation: shadowAnomaly.explanation } : {},
          };
          entries.push(transition);
        }
        if (previousType !== null) {
          // Cleared anomaly
          const transition: ShadowTransition = {
            kind: 'transition',
            timestamp: now.toISOString(),
            agentId,
            source: strategy.source,
            transition: 'cleared_anomaly',
            anomalyType: previousType,
            realState: {
              anomaly: inputs.realAnomaly?.type ?? null,
              since: inputs.realAnomaly?.detectedAt.toISOString() ?? null,
            },
            signals: {},
          };
          entries.push(transition);
        }
        this.previousState.set(stateKey, shadowType);
      }

      // Always log heartbeat
      const heartbeat: ShadowHeartbeat = {
        kind: 'heartbeat',
        timestamp: now.toISOString(),
        agentId,
        source: strategy.source,
        shadowState: shadowType,
        ...(shadowConfidence && shadowType !== null ? { confidence: shadowConfidence } : {}),
        realState: inputs.realAnomaly?.type ?? null,
      };
      entries.push(heartbeat);
    }

    // Fire-and-forget: log all entries
    if (entries.length > 0) {
      this.appendEntries(entries);
    }

    return entries;
  }

  /**
   * Clean up state for an unregistered agent.
   */
  unregisterAgent(agentId: string): void {
    for (const strategy of this.strategies) {
      this.previousState.delete(`${agentId}:${strategy.source}`);
    }
  }

  /**
   * Get the current shadow state for an agent+strategy (for testing).
   */
  getState(agentId: string, source: ShadowSource): AnomalyType | null {
    return this.previousState.get(`${agentId}:${source}`) ?? null;
  }

  /** Get the log file path (for testing/report). */
  getLogFilePath(): string {
    return this.logFilePath;
  }

  private appendEntries(entries: ShadowLogEntry[]): void {
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    mkdir(dirname(this.logFilePath), { recursive: true })
      .then(() => appendFile(this.logFilePath, lines, 'utf-8'))
      .catch(() => { /* fire-and-forget */ });
  }
}
