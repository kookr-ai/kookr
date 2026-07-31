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

import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
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

/**
 * Rotate before the live file exceeds this size (issue #1764).
 * Was 256 MiB — far too large for any per-request full or even partial
 * parse; 16 MiB keeps a useful heartbeat window while bounding disk +
 * report cost. Override via ShadowDetectorRegistryOptions.maxLogBytes.
 */
const DEFAULT_MAX_LOG_BYTES = 16 * 1024 * 1024;
const DEFAULT_ROTATED_GENERATIONS = 2;

export interface ShadowDetectorRegistryOptions {
  /** Rotate shadow-detection.jsonl before an append would exceed this size. */
  maxLogBytes?: number;
  /** Number of rotated files to retain, e.g. 2 keeps .1 and .2. */
  rotatedGenerations?: number;
}

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
  private appendQueue: Promise<void> = Promise.resolve();
  private maxLogBytes: number;
  private rotatedGenerations: number;

  constructor(logFilePath?: string, options: ShadowDetectorRegistryOptions = {}) {
    this.logFilePath = logFilePath ?? join(homedir(), '.kookr', 'shadow-detection.jsonl');
    this.maxLogBytes = Math.max(1, Math.floor(options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES));
    this.rotatedGenerations = Math.max(1, Math.floor(options.rotatedGenerations ?? DEFAULT_ROTATED_GENERATIONS));
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
      void this.appendEntries(entries);
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

  /** Await pending fire-and-forget writes (for tests and orderly shutdown hooks). */
  async flush(): Promise<void> {
    await this.appendQueue.catch(() => {});
  }

  private appendEntries(entries: ShadowLogEntry[]): Promise<void> {
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const next = this.appendQueue
      .catch(() => { /* keep the queue alive after an earlier write failure */ })
      .then(() => this.appendLines(lines))
      .catch(() => { /* fire-and-forget */ });
    this.appendQueue = next;
    return next;
  }

  private async appendLines(lines: string): Promise<void> {
    await mkdir(dirname(this.logFilePath), { recursive: true });

    let currentSize = 0;
    try {
      currentSize = (await stat(this.logFilePath)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    if (currentSize > 0 && currentSize + Buffer.byteLength(lines, 'utf8') > this.maxLogBytes) {
      await this.rotateLog();
    }

    await appendFile(this.logFilePath, lines, 'utf-8');
  }

  private async rotateLog(): Promise<void> {
    try {
      await unlink(`${this.logFilePath}.${this.rotatedGenerations}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    for (let generation = this.rotatedGenerations - 1; generation >= 1; generation--) {
      try {
        await rename(`${this.logFilePath}.${generation}`, `${this.logFilePath}.${generation + 1}`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    try {
      await rename(this.logFilePath, `${this.logFilePath}.1`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
