import type { TaskStatus, TurnState } from './task-status.js';

/** Versioned wire contract for the cross-signal terminal health surface. */
export const SESSION_HEALTH_SCHEMA_VERSION = 'session-health.v1' as const;

export const SESSION_HEALTH_CLASSIFICATIONS = [
  'healthy-working',
  'healthy-idle',
  'provider-or-agent-stalled',
  'terminal-attach-stalled',
  'browser-bridge-stalled',
  'session-lost',
  'recovery-in-progress',
  'health-unknown',
] as const;
export type SessionHealthClassification = typeof SESSION_HEALTH_CLASSIFICATIONS[number];

export type SessionHealthSignalState = 'fresh' | 'stale' | 'missing' | 'unknown';

export interface SessionHealthSignal {
  state: SessionHealthSignalState;
  lastProgressAt: string | null;
  ageMs: number | null;
}

export interface SessionHealthPtySignal extends SessionHealthSignal {
  ringHead: number;
}

export interface SessionHealthTranscriptSignal extends SessionHealthSignal {
  present: boolean;
}

export type SessionHealthTransportState = 'verified' | 'missing' | 'unverified' | 'unknown';
export type SessionHealthAttachState = 'alive' | 'stalled' | 'unknown';

/**
 * Stable, machine-readable reason codes for a `health-unknown` classification
 * (issue #2793). The classification stays deliberately conservative — these
 * codes only explain *why* it is unknown so remote automation can decide
 * whether it is looking at missing telemetry or a real stall, without parsing
 * the free-form `evidence` strings.
 */
export const SESSION_HEALTH_UNKNOWN_REASONS = [
  'no-independent-signals',
  'backend-attach-unavailable',
  'turn-state-unknown',
  'provider-signals-unavailable',
] as const;
export type SessionHealthUnknownReason = typeof SESSION_HEALTH_UNKNOWN_REASONS[number];

/**
 * Bounded next-check hint a remote operator can act on for a `health-unknown`
 * session. Deliberately a small closed vocabulary so automation can switch on
 * it. `escalate` is reserved for cases that resolve to a real stall and is
 * therefore never emitted alongside `health-unknown`, but is part of the stable
 * decision vocabulary the diagnostics contract exposes.
 */
export const SESSION_HEALTH_NEXT_CHECKS = [
  'wait',
  'reattach',
  'inspect-hooks',
  'escalate',
] as const;
export type SessionHealthNextCheck = typeof SESSION_HEALTH_NEXT_CHECKS[number];

/**
 * Machine-readable detail attached only to `health-unknown` snapshots. Bounded
 * and deterministic: a fixed reason code, a fixed next-check hint, and the ages
 * (ms) of the independent signals at classification time (null when the signal
 * is missing/unknown).
 */
export interface SessionHealthUnknownDetail {
  reason: SessionHealthUnknownReason;
  nextCheck: SessionHealthNextCheck;
  signalAgesMs: {
    pty: number | null;
    hooks: number | null;
    transcript: number | null;
  };
}

/** Privacy-safe backend state for browser/diagnostic consumers. */
export interface SessionHealthBackend {
  transportState: SessionHealthTransportState;
  attachState: SessionHealthAttachState;
  recoveryInProgress: boolean;
  attachGeneration: number;
  reattachCount: number;
  lastAttachAt: string | null;
}

export interface SessionHealthBrowser {
  bridgeOpen: boolean;
  lastOpenAt: string | null;
  lastReplayAt: string | null;
  lastLiveByteAt: string | null;
  freshBytesAfterReplay: boolean;
  replayedOnly: boolean;
}

export interface SessionHealthProgress {
  lastProgressAt: string | null;
  stallAgeMs: number | null;
}

export const COORDINATED_STALL_ROOT_CAUSES = [
  'coordinated-terminal-path-stall',
  'coordinated-provider-stall',
] as const;
export type CoordinatedStallRootCause = typeof COORDINATED_STALL_ROOT_CAUSES[number];

export interface CoordinatedStallFinding {
  id: string;
  rootCause: CoordinatedStallRootCause;
  detectedAt: string;
  sessionIds: string[];
  windowMs: number;
  restartEpoch: string;
  postRestart: boolean;
  evidence: string[];
}

export interface SessionHealthSnapshot {
  schemaVersion: typeof SESSION_HEALTH_SCHEMA_VERSION;
  sessionId: string;
  generatedAt: string;
  restartEpoch: string;
  classification: SessionHealthClassification;
  task: {
    status: TaskStatus | null;
    turnState: TurnState | null;
  };
  signals: {
    pty: SessionHealthPtySignal;
    hooks: SessionHealthSignal;
    transcript: SessionHealthTranscriptSignal;
  };
  backend: SessionHealthBackend;
  browser: SessionHealthBrowser;
  progress: SessionHealthProgress;
  evidence: string[];
  /** Present only when `classification === 'health-unknown'` (issue #2793). */
  unknownDetail?: SessionHealthUnknownDetail;
  coordinatedStall?: CoordinatedStallFinding;
}

export interface SessionHealthDiagnostics {
  schemaVersion: typeof SESSION_HEALTH_SCHEMA_VERSION;
  generatedAt: string;
  restartEpoch: string;
  sessions: SessionHealthSnapshot[];
  coordinatedStall: CoordinatedStallFinding | null;
}
