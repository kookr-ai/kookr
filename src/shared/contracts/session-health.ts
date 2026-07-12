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
  coordinatedStall?: CoordinatedStallFinding;
}

export interface SessionHealthDiagnostics {
  schemaVersion: typeof SESSION_HEALTH_SCHEMA_VERSION;
  generatedAt: string;
  restartEpoch: string;
  sessions: SessionHealthSnapshot[];
  coordinatedStall: CoordinatedStallFinding | null;
}
