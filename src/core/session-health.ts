import { isTerminalStatus, type TaskStatus, type TurnState } from '../shared/contracts/task-status.js';
import {
  SESSION_HEALTH_SCHEMA_VERSION,
  type CoordinatedStallFinding,
  type SessionHealthBrowser,
  type SessionHealthClassification,
  type SessionHealthPtySignal,
  type SessionHealthSignal,
  type SessionHealthSnapshot,
  type SessionHealthTranscriptSignal,
} from '../shared/contracts/session-health.js';

export interface SessionHealthPolicy {
  workingStaleMs: number;
  browserStaleMs: number;
  coordinationWindowMs: number;
  minimumCoordinatedSessions: number;
}

export interface BrowserBridgeHealthInput {
  bridgeOpen: boolean;
  lastOpenAt: number | null;
  lastReplayAt: number | null;
  lastLiveByteAt: number | null;
}

/** Server-side input; adapter identity and process details never enter the wire snapshot. */
export interface SessionHealthInput {
  sessionId: string;
  now: number;
  restartEpoch: number;
  taskStatus?: TaskStatus;
  turnState?: TurnState;
  pty: {
    ringHead: number;
    lastByteAt: number | null;
  };
  hooks: {
    lastEventAt: number | null;
  };
  transcript: {
    present: boolean;
    lastRecordAt: number | null;
  };
  backend: {
    socketPresent: boolean | null;
    identityVerified: boolean | null;
    masterPid: number | null;
    agentPid: number | null;
    attachChildAlive: boolean | null;
    recoveryInProgress?: boolean;
    attachGeneration: number;
    reattachCount: number;
    lastAttachAt: number | null;
  };
  browser: BrowserBridgeHealthInput;
}

export { SESSION_HEALTH_SCHEMA_VERSION } from '../shared/contracts/session-health.js';

export const DEFAULT_SESSION_HEALTH_POLICY: Readonly<SessionHealthPolicy> = {
  workingStaleMs: 30_000,
  browserStaleMs: 10_000,
  coordinationWindowMs: 30_000,
  minimumCoordinatedSessions: 2,
};

export function classifySessionHealth(
  input: SessionHealthInput,
  policyOverrides: Partial<SessionHealthPolicy> = {},
): SessionHealthSnapshot {
  const policy = { ...DEFAULT_SESSION_HEALTH_POLICY, ...policyOverrides };
  const pty: SessionHealthPtySignal = {
    ...projectSignal(
      input.pty.lastByteAt,
      input.now,
      policy.workingStaleMs,
      input.pty.ringHead > 0,
      input.restartEpoch,
    ),
    ringHead: input.pty.ringHead,
  };
  const hooks = projectSignal(
    input.hooks.lastEventAt,
    input.now,
    policy.workingStaleMs,
    false,
    input.restartEpoch,
  );
  const transcript = projectTranscriptSignal(input, policy.workingStaleMs);
  const browser = projectBrowser(input.browser);
  const taskStatus = input.taskStatus ?? null;
  const turnState = input.turnState ?? null;
  const providerFresh = hooks.state === 'fresh' || transcript.state === 'fresh';
  const providerSignalObserved = hooks.state === 'fresh'
    || hooks.state === 'stale'
    || transcript.state === 'fresh'
    || transcript.state === 'stale';
  const backendAttachStalled = input.backend.socketPresent === true
    && input.backend.identityVerified === true
    && input.backend.attachChildAlive === false;
  const backendAttachUnknown = input.backend.socketPresent === null
    || input.backend.identityVerified === null
    || input.backend.attachChildAlive === null;
  const backendLost = input.backend.socketPresent === false
    || input.backend.identityVerified === false;
  const noIndependentSignals = input.backend.socketPresent === null
    && input.backend.identityVerified === null
    && input.backend.attachChildAlive === null
    && pty.state === 'missing'
    && hooks.state === 'missing'
    && transcript.state === 'missing';
  const browserStalled = input.browser.bridgeOpen
    && pty.state === 'fresh'
    && (() => {
      const browserActivityAt = input.browser.lastLiveByteAt
        ?? input.browser.lastReplayAt
        ?? input.browser.lastOpenAt;
      return browserActivityAt !== null
        && input.now - browserActivityAt > policy.browserStaleMs;
    })();

  let classification: SessionHealthClassification;
  const evidence: string[] = [];

  // Transport loss/recovery is actionable even when the task's last turn was
  // idle. A dead socket must not be hidden behind a stale completed-turn label.
  if (input.backend.recoveryInProgress === true) {
    classification = 'recovery-in-progress';
    evidence.push('terminal transport recovery is in progress');
  } else if (backendLost) {
    classification = 'session-lost';
    evidence.push(input.backend.socketPresent === false ? 'dtach socket is not present' : 'dtach master/socket identity could not be verified');
  } else if (noIndependentSignals) {
    classification = 'health-unknown';
    evidence.push('insufficient independent signals to classify the session');
  } else if (backendAttachStalled) {
    classification = 'terminal-attach-stalled';
    evidence.push('dtach socket is live but Kookr attach child is not alive');
  } else if (backendAttachUnknown) {
    classification = 'health-unknown';
    evidence.push('backend attach health is unavailable');
  } else if (isTerminalStatus(taskStatus ?? 'open') || turnState === 'completed_turn' || turnState === 'waiting_for_input') {
    classification = 'healthy-idle';
    evidence.push(`task is ${taskStatus ?? 'active'} with turn state ${turnState ?? 'unknown'}`);
  } else if (turnState === 'unknown' || turnState === null) {
    classification = 'health-unknown';
    evidence.push('insufficient independent signals to classify the session');
  } else if (turnState === 'blocked') {
    classification = 'provider-or-agent-stalled';
    evidence.push('provider turn is blocked');
  } else if (browserStalled) {
    classification = 'browser-bridge-stalled';
    evidence.push('PTY progress is fresh but the open browser bridge has no recent live bytes');
  } else if (!providerSignalObserved) {
    classification = 'health-unknown';
    evidence.push('hook and transcript progress signals are unavailable');
  } else if (pty.state !== 'fresh' && providerFresh) {
    classification = 'terminal-attach-stalled';
    evidence.push('PTY/ring progress is stale while hooks or transcript progress is fresh');
  } else if (pty.state === 'fresh' && providerFresh) {
    classification = 'healthy-working';
    evidence.push('PTY/ring, hook, and transcript progress are advancing');
  } else {
    classification = 'provider-or-agent-stalled';
    evidence.push('provider and transcript progress are stale while the session transport remains live');
  }

  if (input.browser.bridgeOpen && browser.replayedOnly) {
    evidence.push('browser has replayed ring data but no fresh post-replay bytes');
  }
  if (transcript.state === 'missing' || transcript.state === 'unknown') {
    evidence.push(`transcript signal is ${transcript.state}`);
  }
  if (input.pty.lastByteAt !== null && input.pty.lastByteAt < input.restartEpoch) {
    evidence.push('PTY/ring progress predates the current server restart epoch');
  }

  const progressAt = latestTimestamp([
    input.pty.lastByteAt,
    input.hooks.lastEventAt,
    input.transcript.lastRecordAt,
  ]);
  const stallAgeMs = progressAt === null ? null : Math.max(0, input.now - progressAt);

  return {
    schemaVersion: SESSION_HEALTH_SCHEMA_VERSION,
    sessionId: input.sessionId,
    generatedAt: toIso(input.now),
    restartEpoch: toIso(input.restartEpoch),
    classification,
    task: { status: taskStatus, turnState },
    signals: { pty, hooks, transcript },
    backend: projectBackend(input.backend),
    browser,
    progress: {
      lastProgressAt: toNullableIso(progressAt),
      stallAgeMs,
    },
    evidence,
  };
}

function projectBackend(input: SessionHealthInput['backend']): SessionHealthSnapshot['backend'] {
  return {
    transportState: projectTransportState(input),
    attachState: projectAttachState(input.attachChildAlive),
    recoveryInProgress: input.recoveryInProgress ?? false,
    attachGeneration: input.attachGeneration,
    reattachCount: input.reattachCount,
    lastAttachAt: toNullableIso(input.lastAttachAt),
  };
}

function projectTransportState(
  input: SessionHealthInput['backend'],
): SessionHealthSnapshot['backend']['transportState'] {
  if (input.socketPresent === false) return 'missing';
  if (input.identityVerified === false) return 'unverified';
  if (input.socketPresent === null || input.identityVerified === null) return 'unknown';
  return 'verified';
}

function projectAttachState(
  attachChildAlive: boolean | null,
): SessionHealthSnapshot['backend']['attachState'] {
  if (attachChildAlive === null) return 'unknown';
  return attachChildAlive ? 'alive' : 'stalled';
}

export function detectCoordinatedStall(
  sessions: readonly SessionHealthSnapshot[],
  policyOverrides: Partial<SessionHealthPolicy> = {},
): CoordinatedStallFinding | null {
  const policy = { ...DEFAULT_SESSION_HEALTH_POLICY, ...policyOverrides };
  const candidates = sessions
    .filter((session) => (
      session.task.turnState === 'running'
      && (session.classification === 'terminal-attach-stalled' || session.classification === 'provider-or-agent-stalled')
    ))
    .map((session) => {
      const lastProgressAt = coordinationProgressAt(session) ?? Number.NaN;
      const generatedAt = Date.parse(session.generatedAt);
      const stallAgeMs = !Number.isFinite(lastProgressAt) || !Number.isFinite(generatedAt)
        ? null
        : Math.max(0, generatedAt - lastProgressAt);
      return { session, lastProgressAt, stallAgeMs };
    })
    .filter(({ lastProgressAt, stallAgeMs }) => Number.isFinite(lastProgressAt) && (stallAgeMs ?? 0) >= policy.workingStaleMs);

  if (candidates.length < policy.minimumCoordinatedSessions) return null;

  const earliest = Math.min(...candidates.map((candidate) => candidate.lastProgressAt));
  const latest = Math.max(...candidates.map((candidate) => candidate.lastProgressAt));
  const windowMs = latest - earliest;
  if (windowMs > policy.coordinationWindowMs) return null;

  const sessionIds = candidates.map(({ session }) => session.sessionId).sort();
  const restartEpoch = candidates[0].session.restartEpoch;
  const restartAt = Date.parse(restartEpoch);
  const postRestart = Number.isFinite(restartAt)
    && candidates.every(({ lastProgressAt }) => lastProgressAt >= restartAt);
  const hasTerminalAttachStall = candidates.some(({ session }) => session.classification === 'terminal-attach-stalled');
  return {
    id: `coordinated-stall:${restartEpoch}:${sessionIds.join(',')}`,
    rootCause: hasTerminalAttachStall ? 'coordinated-terminal-path-stall' : 'coordinated-provider-stall',
    detectedAt: candidates[0].session.generatedAt,
    sessionIds,
    windowMs,
    restartEpoch,
    postRestart,
    evidence: [
      `${sessionIds.length} working sessions stopped advancing within ${windowMs}ms`,
      postRestart ? 'all observed progress is after the current server restart epoch' : 'the stall includes progress from before the current server restart epoch',
  ],
  };
}

function coordinationProgressAt(session: SessionHealthSnapshot): number | null {
  if (session.classification === 'terminal-attach-stalled') {
    return parseTimestamp(session.signals.pty.lastProgressAt);
  }
  return latestTimestamp([
    parseTimestamp(session.signals.hooks.lastProgressAt),
    parseTimestamp(session.signals.transcript.lastProgressAt),
  ]);
}

export class SessionHealthTracker {
  private readonly bridgeStates = new Map<string, MutableBrowserBridgeHealth>();

  recordBridgeOpened(sessionId: string, at = Date.now()): void {
    const state = this.getOrCreate(sessionId);
    if (state.openBridges === 0) {
      state.lastReplayAt = null;
      state.lastLiveByteAt = null;
    }
    state.openBridges += 1;
    state.lastOpenAt = at;
  }

  recordBridgeReplay(sessionId: string, at = Date.now()): void {
    this.getOrCreate(sessionId).lastReplayAt = at;
  }

  recordBridgeLiveBytes(sessionId: string, at = Date.now()): void {
    this.getOrCreate(sessionId).lastLiveByteAt = at;
  }

  recordBridgeClosed(sessionId: string): void {
    const state = this.bridgeStates.get(sessionId);
    if (!state) return;
    state.openBridges = Math.max(0, state.openBridges - 1);
  }

  clear(sessionId: string): void {
    this.bridgeStates.delete(sessionId);
  }

  getBrowserHealth(sessionId: string): BrowserBridgeHealthInput {
    const state = this.bridgeStates.get(sessionId);
    return {
      bridgeOpen: (state?.openBridges ?? 0) > 0,
      lastOpenAt: state?.lastOpenAt ?? null,
      lastReplayAt: state?.lastReplayAt ?? null,
      lastLiveByteAt: state?.lastLiveByteAt ?? null,
    };
  }

  private getOrCreate(sessionId: string): MutableBrowserBridgeHealth {
    let state = this.bridgeStates.get(sessionId);
    if (!state) {
      state = { openBridges: 0, lastOpenAt: null, lastReplayAt: null, lastLiveByteAt: null };
      this.bridgeStates.set(sessionId, state);
    }
    return state;
  }
}

interface MutableBrowserBridgeHealth {
  openBridges: number;
  lastOpenAt: number | null;
  lastReplayAt: number | null;
  lastLiveByteAt: number | null;
}

function projectSignal(
  timestamp: number | null,
  now: number,
  staleAfterMs: number,
  hasHistoricalData = false,
  freshAfter: number | undefined = undefined,
): SessionHealthSignal {
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return {
      state: hasHistoricalData ? 'unknown' : 'missing',
      lastProgressAt: null,
      ageMs: null,
    };
  }
  const ageMs = Math.max(0, now - timestamp);
  if (freshAfter !== undefined && timestamp < freshAfter) {
    return {
      state: 'unknown',
      lastProgressAt: toIso(timestamp),
      ageMs,
    };
  }
  return {
    state: ageMs <= staleAfterMs ? 'fresh' : 'stale',
    lastProgressAt: toIso(timestamp),
    ageMs,
  };
}

function projectTranscriptSignal(input: SessionHealthInput, staleAfterMs: number): SessionHealthTranscriptSignal {
  const signal = input.transcript.present
    ? projectSignal(input.transcript.lastRecordAt, input.now, staleAfterMs, false, input.restartEpoch)
    : { state: 'missing' as const, lastProgressAt: null, ageMs: null };
  return { ...signal, present: input.transcript.present };
}

function projectBrowser(input: BrowserBridgeHealthInput): SessionHealthBrowser {
  const freshBytesAfterReplay = input.lastLiveByteAt !== null
    && (input.lastReplayAt === null || input.lastLiveByteAt >= input.lastReplayAt);
  return {
    bridgeOpen: input.bridgeOpen,
    lastOpenAt: toNullableIso(input.lastOpenAt),
    lastReplayAt: toNullableIso(input.lastReplayAt),
    lastLiveByteAt: toNullableIso(input.lastLiveByteAt),
    freshBytesAfterReplay,
    replayedOnly: input.bridgeOpen && input.lastReplayAt !== null && !freshBytesAfterReplay,
  };
}

function latestTimestamp(timestamps: readonly (number | null)[]): number | null {
  const valid = timestamps.filter((value): value is number => value !== null && Number.isFinite(value));
  return valid.length > 0 ? Math.max(...valid) : null;
}

function parseTimestamp(timestamp: string | null): number | null {
  if (timestamp === null) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function toNullableIso(timestamp: number | null): string | null {
  return timestamp === null || !Number.isFinite(timestamp) ? null : toIso(timestamp);
}
