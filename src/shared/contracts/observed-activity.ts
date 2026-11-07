/**
 * Hermes observed-activity bridge — shared wire contract
 * (jeanibarz/hermes-fleet#15, RFC `rfc-hermes-observed-activity-bridge`).
 *
 * These are the PURE DATA shapes the backend {@link ObservedActivityStore}
 * produces and the monitor's observed lane renders. They live in `shared/` so
 * both the server (store + broadcaster) and the frontend (store slice + lane UI)
 * depend on one definition without the frontend importing from `server/`
 * (layering: `server → shared`, `frontend → shared`, never `shared → server`).
 *
 * The lane is operator-global and NEVER bound to a `Task`; see the RFC for the
 * integrity (R5), no-false-liveness (R6) and restart-honesty (R7) invariants.
 */

/** Self-reported Hermes state. Deliberately minimal (RFC §Design 3). */
export type ObservedState = 'working' | 'idle' | 'done';

/**
 * Effective state after server-side decay. `stale` is derived (never reported by
 * the producer) when a `working` session misses its heartbeat window — it is the
 * "stale-while-working" signal, distinct from a self-reported `idle`/`done`.
 */
export type ObservedEffectiveState = ObservedState | 'stale';

export interface ObservedSessionRecord {
  sessionId: string;
  state: ObservedState;
  label?: string;
  /** Server clock at last accepted pulse (ms). Decay is computed from THIS. */
  receivedAt: number;
  /** Server clock at first accepted pulse (ms). */
  firstSeen: number;
  pulseCount: number;
}

export interface ObservedSessionView extends ObservedSessionRecord {
  /** `state` after `receivedAt`-based decay — what the monitor renders. */
  effectiveState: ObservedEffectiveState;
  /** Age of the last pulse in ms, at snapshot time. */
  ageMs: number;
}

export interface ObservedActivityCounters {
  accepted: number;
  deduped: number;
  rejected: Record<string, number>;
  lastAcceptedAt: number | null;
  lastRejectAt: number | null;
  /** Server start time (ms) — lets the UI say "no pulses since boot at HH:MM". */
  startedAt: number;
}

export interface ObservedActivitySnapshot {
  sessions: ObservedSessionView[];
  counters: ObservedActivityCounters;
  now: number;
}
