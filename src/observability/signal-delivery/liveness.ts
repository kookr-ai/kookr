/**
 * Liveness staleness registry (issue #1716).
 *
 * A JSON registry lists artifacts that must stay fresh — the gate heartbeat,
 * the contribution ledger, the delivery poller's own heartbeat — each with a
 * maximum tolerated age. An hourly check compares every entry's age against its
 * budget; a stale (or missing) artifact emits one operator signal, and re-emits
 * at most once per `reEmitIntervalMs` (default 6h) while it stays stale. When an
 * artifact recovers, a single `clear` signal fires and the entry re-arms.
 *
 * Pure edge logic: the caller supplies the current age of each artifact and the
 * previously-persisted state, and owns writing back `nextState`.
 */

import type { OperatorSignalKind } from './operator-signal.js';

/** Default re-emit spacing for a still-stale artifact. */
export const DEFAULT_LIVENESS_REEMIT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface LivenessRegistryEntry {
  /** Stable artifact name, e.g. `gate-heartbeat`. */
  name: string;
  /** Maximum tolerated age before the artifact is considered stale. */
  maxAgeMs: number;
  /** Optional path (informational; the age source resolves it). */
  path?: string;
  /** When false, the entry is skipped (e.g. schedules disabled). Defaults true. */
  enabled?: boolean;
}

export interface LivenessSignal {
  key: string;
  kind: OperatorSignalKind;
  source: string;
  title: string;
  detail?: string;
}

export interface LivenessEntryState {
  /** Whether the artifact was stale at the last check. */
  stale: boolean;
  /** Epoch-ms of the last stale signal emitted, or null if none. */
  lastEmittedAt: number | null;
}

export type LivenessState = Record<string, LivenessEntryState>;

export interface CheckLivenessInput {
  registry: readonly LivenessRegistryEntry[];
  /**
   * Current age of an artifact in ms, or null when the artifact is missing /
   * unreadable (treated as stale regardless of budget).
   */
  ageMsOf: (entry: LivenessRegistryEntry) => number | null;
  now: number;
  prevState: LivenessState;
  reEmitIntervalMs?: number;
}

export interface CheckLivenessResult {
  signals: LivenessSignal[];
  nextState: LivenessState;
}

/**
 * Evaluate the registry and return the signals to emit plus the state to
 * persist. One stale signal per artifact per `reEmitIntervalMs`; one clear
 * signal when a previously-stale artifact recovers.
 */
export function checkLiveness(input: CheckLivenessInput): CheckLivenessResult {
  const reEmit = input.reEmitIntervalMs ?? DEFAULT_LIVENESS_REEMIT_INTERVAL_MS;
  const signals: LivenessSignal[] = [];
  const nextState: LivenessState = {};

  for (const entry of input.registry) {
    if (entry.enabled === false) {
      // Disabled entries carry their prior state forward untouched.
      const prior = input.prevState[entry.name];
      if (prior) nextState[entry.name] = prior;
      continue;
    }

    const prior = input.prevState[entry.name] ?? { stale: false, lastEmittedAt: null };
    const age = input.ageMsOf(entry);
    const missing = age === null;
    const stale = missing || age > entry.maxAgeMs;

    if (stale) {
      const due = prior.lastEmittedAt === null || input.now - prior.lastEmittedAt >= reEmit;
      if (due) {
        signals.push({
          key: `liveness:${entry.name}:stale`,
          kind: 'alert',
          source: 'liveness',
          title: missing
            ? `${entry.name} artifact missing`
            : `${entry.name} is stale (${describeAge(age)} > ${describeAge(entry.maxAgeMs)} budget)`,
          detail: entry.path ? `artifact: ${entry.path}` : undefined,
        });
        nextState[entry.name] = { stale: true, lastEmittedAt: input.now };
      } else {
        nextState[entry.name] = { stale: true, lastEmittedAt: prior.lastEmittedAt };
      }
      continue;
    }

    // Fresh now. Emit a clear only if we had previously alerted on staleness.
    if (prior.stale) {
      signals.push({
        key: `liveness:${entry.name}:clear`,
        kind: 'clear',
        source: 'liveness',
        title: `${entry.name} is fresh again`,
        detail: entry.path ? `artifact: ${entry.path}` : undefined,
      });
    }
    nextState[entry.name] = { stale: false, lastEmittedAt: null };
  }

  return { signals, nextState };
}

function describeAge(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 6) / 10;
  return `${hours}h`;
}
