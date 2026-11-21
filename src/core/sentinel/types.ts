/**
 * Shared types of the supervisor sentinel's guard (RFC `docs/rfc/rfc-supervisor-sentinel.md` §1-§3,
 * issue #4239).
 *
 * The guard's duties are pure functions: `(facts, state, now) → decision`. Facts come from
 * read-only ports, filled by server adapters. A decision carries a reason (R5: every decision,
 * including "nothing", is logged) and a list of effects. Effects are plain data: the escalation
 * router dedups and formats them, and an interpreter (P1+) carries them out. In P0 nothing is
 * carried out; every effect is logged as "would have done".
 *
 * Unknown facts (R3) are the {@link UNKNOWN} sentinel value, never 0 or `undefined`, so a missing
 * value can never be read as "quiet", "healthy" or "moving" by accident.
 */

export const UNKNOWN = 'unknown' as const;
export type Unknown = typeof UNKNOWN;
/** A fact that may not be known. Always test with {@link isKnown}. */
export type Known<T> = T | Unknown;

export function isKnown<T>(value: Known<T>): value is T {
  return value !== UNKNOWN;
}

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** Duty names, as used by `--live` (RFC §0). */
export const SENTINEL_DUTIES = ['backstop', 'crash-recovery', 'worker-events', 'compaction', 'progress', 'expiry'] as const;
export type SentinelDuty = (typeof SENTINEL_DUTIES)[number];

// ---------------------------------------------------------------------------
// Facts (RFC §1). Times are epoch milliseconds.
// ---------------------------------------------------------------------------

/** A live descendant process of the lead's session, excluding the agent and its shell. */
export interface DescendantProcess {
  pid: number;
  command: string;
  startedAtMs: number;
}

/** The disposition-ledger entry of a terminal task (`core/disposition-ledger.ts`). */
export interface DispositionFact {
  kind: 'respawned' | 'obsolete' | 'needs-human';
  /** The recovery subsystem that wrote it: `hung-suspect-ttl`, `hung-task-reaper`, `crash-recovery`, … */
  source: string;
}

export interface LeadTerminalFact {
  status: 'completed' | 'terminated' | 'cancelled';
  /** `TerminalTransitionSource` of the terminal receipt (`user`, `watchdog`, `task_self`, …). */
  transitionSource: string;
  /** `TerminalReasonCategory` of the terminal receipt (`timeout`, `provider_failure`, `manual`, …). */
  reason: string;
  terminalAtMs: number;
  disposition: Known<DispositionFact | null>;
}

export interface LeadFacts {
  taskId: string;
  name: string;
  /** False once the task is terminal. */
  live: boolean;
  /** Set when the task is terminal. */
  terminal?: LeadTerminalFact;
  /** Time of the lead's last screen change (watchdog `lastPaneChangeAt`). */
  lastScreenChangeAtMs: Known<number>;
  /** Live descendant processes of the lead's session. */
  descendants: Known<DescendantProcess[]>;
  /** When the lead last raised `completion_ready`, if it did. */
  completionReadyAtMs: Known<number | null>;
}

/** A standalone marker line found in an assistant entry (RFC §2.4, §2.5). */
export type TranscriptMarkerKind = 'HANDOFF READY' | 'HANDOFF LATER' | 'WAITING ON OPERATOR';
export interface TranscriptMarker {
  kind: TranscriptMarkerKind;
  atMs: number;
  /** The text after `WAITING ON OPERATOR:`, if any. */
  detail?: string;
}

/** Read from the lead's transcript by `server/sentinel/transcript-facts.ts`. */
export interface TranscriptFacts {
  /** `input + cache_read + cache_creation` of the latest assistant entry with non-zero usage. */
  contextTokens: Known<number>;
  /** Time of the latest `turn_duration` entry. */
  lastTurnEndAtMs: Known<number>;
  /** Time of the latest assistant entry. */
  lastAssistantAtMs: Known<number>;
  /** Times of every `compact_boundary` entry, ascending. */
  compactBoundariesAtMs: Known<number[]>;
  /** Standalone marker lines in assistant entries, ascending by time. */
  markers: Known<TranscriptMarker[]>;
}

/** A worker of the lead (a task whose `parentTaskId` is the lead). */
export interface ChildFact {
  taskId: string;
  name: string;
  startedAtMs: number;
  /** Set once the worker is terminal. */
  ended?: {
    atMs: number;
    status: 'completed' | 'terminated' | 'cancelled';
    /** Disposition source, or the transition source when there is no ledger entry. */
    source: Known<string>;
    /** True when it ended with a delivered result (a completion or a merge). */
    delivered: boolean;
  };
}

export interface OperatorActivityFacts {
  /** The operator's latest own input to the lead (dashboard, Telegram, Lucy, operator-via-sentinel). */
  lastOperatorInputAtMs: Known<number | null>;
}

export interface HandoffFacts {
  /** mtime of `<dir>/handoff.md`; null when the file does not exist. */
  handoffMtimeMs: Known<number | null>;
  /** mtime of `<dir>/fleet-state.json`; null when the file does not exist. */
  fleetStateMtimeMs: Known<number | null>;
  /** Long jobs declared in `fleet-state.json` (RFC §2.5). */
  declaredJobs: Known<Array<{ pid: number; alive: boolean; expectedEndAtMs?: number }>>;
}

export interface SentinelFacts {
  lead: LeadFacts;
  transcript: TranscriptFacts;
  children: Known<ChildFact[]>;
  operator: OperatorActivityFacts;
  handoff: HandoffFacts;
}

// ---------------------------------------------------------------------------
// State (persisted in `~/.kookr/sentinels/<id>/state.json` by the service).
// ---------------------------------------------------------------------------

export interface SentinelState {
  sentinelId: string;
  leadTaskId: string;
  startedAtMs: number;
  expiresAtMs: number;
  /** Duties that act. Empty in P0: every duty runs as a dry run. */
  liveDuties: SentinelDuty[];
  /** The directory holding `handoff.md` and `fleet-state.json`. */
  handoffDir: string;
  /** Dedup keys of conditions already contacted, with their expiry (RFC §3). */
  dedup: Record<string, number>;
  /** When the guard last typed (or, in dry run, would have typed) a line into the lead. */
  lastGuardLineAtMs?: number;
  backstop: { lastTickAtMs?: number };
  crashRecovery: {
    reopenCount: number;
    lastReopenAtMs?: number;
    /** `reopen:<lead>:<terminalAt>` keys already acted on. */
    reopenKeys: string[];
    /** Set by "Leave it (no reopen)": an episode whose reclaim alerts instead of reopening. */
    suppressedAfterMs?: number;
    lastCompletionReadyAlertAtMs?: number;
  };
  workerEvents: {
    /** `<taskId>:<endedAt>` of ends already told to the lead. */
    reported: string[];
    /** Times of reclaims of the lead's workers, for the 4-hour reclaim-loop rule. */
    reclaimsAtMs: number[];
  };
  compaction: {
    requestedAtMs?: number;
    sentAtMs?: number;
    /** A `HANDOFF LATER` defers the next request until this time. */
    deferredUntilMs?: number;
    /** When the context first reached the 850k escalation threshold, in this episode. */
    over850kSinceMs?: number;
    lastSentAtMs?: number;
    failures: number;
  };
  progress: {
    fingerprint?: string;
    changedAtMs?: number;
    noticeAtMs?: number;
  };
}

export function initialSentinelState(input: {
  sentinelId: string;
  leadTaskId: string;
  startedAtMs: number;
  expiresAtMs: number;
  handoffDir: string;
}): SentinelState {
  return {
    ...input,
    liveDuties: [],
    dedup: {},
    backstop: {},
    crashRecovery: { reopenCount: 0, reopenKeys: [] },
    workerEvents: { reported: [], reclaimsAtMs: [] },
    compaction: { failures: 0 },
    progress: {},
  };
}

// ---------------------------------------------------------------------------
// Decisions and effects.
// ---------------------------------------------------------------------------

export interface AskOption {
  /** Stable id the guard acts on when the operator answers. */
  id: string;
  label: string;
}

export type SentinelEffect =
  /** Type one line into the lead through `GuardedInputSender` (`source: 'sentinel'`). */
  | { kind: 'type-line'; trigger: string; text: string; dedupKey?: string }
  /** A guard-owned system ask (RFC §3). */
  | { kind: 'ask'; trigger: string; question: string; options: AskOption[]; allowFreeText: boolean; dedupKey: string }
  /** An operational alert (no model needed). */
  | { kind: 'alert'; trigger: string; summary: string; severity: 'info' | 'warning' | 'critical'; dedupKey?: string }
  /** `kookr reopen` of the terminal lead, idempotent on `idempotencyKey`. */
  | { kind: 'reopen'; trigger: string; idempotencyKey: string; reason: string }
  /** End the sentinel itself. */
  | { kind: 'end-sentinel'; trigger: string; reason: string };

export interface DutyDecision {
  duty: SentinelDuty;
  /** Short machine code, for example `tick-due`, `below-threshold`, `blocked-operator-unknown`. */
  decision: string;
  /** Human-readable reason, with the facts behind it. */
  reason: string;
  effects: SentinelEffect[];
}

export interface DutyResult {
  decision: DutyDecision;
  state: SentinelState;
}

/** Every duty has this shape. `now` is passed in; duties never read a clock. */
export type Duty = (facts: SentinelFacts, state: SentinelState, nowMs: number) => DutyResult;

/** Latest of the known values, or UNKNOWN when none is known. */
export function latestKnown(...values: Array<Known<number | null>>): Known<number> {
  let best: number | undefined;
  for (const v of values) {
    if (!isKnown(v) || v === null) continue;
    if (best === undefined || v > best) best = v;
  }
  return best === undefined ? UNKNOWN : best;
}

/** `HH:MM` in UTC. */
export function hhmm(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

export function minutes(ms: number): number {
  return Math.floor(ms / MINUTE_MS);
}
