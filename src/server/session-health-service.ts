import { statSync } from 'node:fs';
import {
  classifySessionHealth,
  detectCoordinatedStall,
  type SessionHealthInput,
  type SessionHealthPolicy,
  type SessionHealthTracker,
} from '../core/session-health.js';
import type { TaskStatus, TurnState } from '../shared/contracts/task-status.js';
import type { TerminalSessionDiagnostics } from '../adapters/terminal-backend.js';
import {
  SESSION_HEALTH_SCHEMA_VERSION,
  type CoordinatedStallFinding,
  type SessionHealthDiagnostics,
  type SessionHealthSnapshot,
} from '../shared/contracts/session-health.js';

const FLEET_PROJECTION_CACHE_TTL_MS = 250;

export interface SessionHealthSessionRef {
  sessionId: string;
  taskStatus: TaskStatus;
  turnState?: TurnState;
  transcriptPath?: string;
}

export interface SessionHealthServiceDeps {
  listSessions: () => readonly SessionHealthSessionRef[];
  /** Live turn state accessor; the snapshot callback can override this value. */
  getTurnState?: (sessionId: string) => TurnState | undefined;
  getWatchdogState?: (sessionId: string) => { lastEventAt: number } | undefined;
  getBackendDiagnostics?: (sessionId: string) => TerminalSessionDiagnostics | null | undefined;
  browser: Pick<SessionHealthTracker, 'getBrowserHealth'>;
  restartEpoch: number;
  now?: () => number;
  policy?: Partial<SessionHealthPolicy>;
}

/**
 * Joins the task/session records with live signal sources and delegates the
 * actual classification to the pure core model. This is the shared read path
 * for the diagnostics endpoint and WebSocket agent snapshots.
 */
export class SessionHealthService {
  private fleetCache: FleetHealthProjection | undefined;

  constructor(private readonly deps: SessionHealthServiceDeps) {}

  getSessionHealth(sessionId: string, turnStateOverride?: TurnState): SessionHealthSnapshot | undefined {
    const now = this.now();
    const fleet = this.getFleetProjection(now);
    if (turnStateOverride === undefined) {
      return fleet.sessions.find((candidate) => candidate.sessionId === sessionId);
    }
    const cachedSession = fleet.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (cachedSession?.task.turnState === turnStateOverride) return cachedSession;

    // Monitor supplies its already-derived live turn state. Rebuild only that
    // session before correlation so the WS snapshot cannot lag the REST root
    // finding while retaining a short fleet cache for snapshot fan-out.
    const session = this.deps.listSessions().find((candidate) => candidate.sessionId === sessionId);
    if (!session) return undefined;
    const overridden = this.buildSessionHealth(session, turnStateOverride, now);
    const sessions = fleet.sessions.map((candidate) => candidate.sessionId === sessionId ? overridden : candidate);
    const coordinatedStall = detectCoordinatedStall(sessions, this.deps.policy);
    return this.annotateCoordination(sessions, coordinatedStall)
      .find((candidate) => candidate.sessionId === sessionId);
  }

  getDiagnostics(): SessionHealthDiagnostics {
    const now = this.now();
    const projection = this.getFleetProjection(now);

    return {
      schemaVersion: SESSION_HEALTH_SCHEMA_VERSION,
      generatedAt: new Date(now).toISOString(),
      restartEpoch: new Date(this.deps.restartEpoch).toISOString(),
      sessions: [...projection.sessions],
      coordinatedStall: projection.coordinatedStall,
    };
  }

  private getFleetProjection(now: number): FleetHealthProjection {
    if (this.fleetCache && now - this.fleetCache.sampledAt < FLEET_PROJECTION_CACHE_TTL_MS) {
      return this.fleetCache;
    }
    const sessions = this.deps.listSessions().map((session) => this.buildSessionHealth(session, undefined, now));
    const coordinatedStall = detectCoordinatedStall(sessions, this.deps.policy);
    const projection: FleetHealthProjection = {
      sampledAt: now,
      sessions: this.annotateCoordination(sessions, coordinatedStall),
      coordinatedStall,
    };
    this.fleetCache = projection;
    return projection;
  }

  private annotateCoordination(
    sessions: SessionHealthSnapshot[],
    coordinatedStall: CoordinatedStallFinding | null,
  ): SessionHealthSnapshot[] {
    if (!coordinatedStall) return sessions;
    return sessions.map((session) => coordinatedStall.sessionIds.includes(session.sessionId)
      ? { ...session, coordinatedStall }
      : session);
  }

  private buildSessionHealth(session: SessionHealthSessionRef, turnStateOverride: TurnState | undefined, now: number): SessionHealthSnapshot {
    const transcript = readTranscriptSignal(session.transcriptPath);
    const watchdog = this.deps.getWatchdogState?.(session.sessionId);
    const backend = this.deps.getBackendDiagnostics?.(session.sessionId);
    const browser = this.deps.browser.getBrowserHealth(session.sessionId);
    const input: SessionHealthInput = {
      sessionId: session.sessionId,
      now,
      restartEpoch: this.deps.restartEpoch,
      taskStatus: session.taskStatus,
      turnState: turnStateOverride ?? this.deps.getTurnState?.(session.sessionId) ?? session.turnState,
      pty: {
        ringHead: backend?.ringHead ?? 0,
        lastByteAt: backend?.lastByteAt ?? null,
      },
      hooks: {
        lastEventAt: watchdog?.lastEventAt ?? null,
      },
      transcript,
      backend: {
        socketPresent: backend?.socketPresent ?? null,
        identityVerified: backend?.identityVerified ?? null,
        masterPid: backend?.masterPid ?? null,
        agentPid: backend?.agentPid ?? null,
        attachChildAlive: backend?.attachChildAlive ?? null,
        recoveryInProgress: backend?.recoveryInProgress ?? false,
        attachGeneration: backend?.attachGeneration ?? 0,
        reattachCount: backend?.reattachCount ?? 0,
        lastAttachAt: backend?.lastAttachAt ?? null,
      },
      browser,
    };
    return classifySessionHealth(input, this.deps.policy);
  }

  private now(): number {
    const now = this.deps.now?.() ?? Date.now();
    return Number.isFinite(now) ? now : Date.now();
  }
}

interface FleetHealthProjection {
  sampledAt: number;
  sessions: SessionHealthSnapshot[];
  coordinatedStall: CoordinatedStallFinding | null;
}

function readTranscriptSignal(path: string | undefined): SessionHealthInput['transcript'] {
  // Transcript paths are intentionally not exposed. A missing/unreadable
  // transcript is a missing signal, not a filesystem error for this
  // best-effort diagnostics projection.
  if (!path) return { present: false, lastRecordAt: null };
  try {
    const stats = statSync(path);
    return {
      present: true,
      lastRecordAt: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null,
    };
  } catch {
    return { present: false, lastRecordAt: null };
  }
}
