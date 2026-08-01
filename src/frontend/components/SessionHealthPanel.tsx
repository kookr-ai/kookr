import React, { useEffect, useState } from 'react';
import {
  COORDINATED_STALL_ROOT_CAUSES,
  SESSION_HEALTH_CLASSIFICATIONS,
  type SessionHealthDiagnostics,
  type SessionHealthSnapshot,
} from '../../shared/protocol.js';
import { formatDiagnosticIdentifier } from './diagnostics-format.js';
import { getSessionHealth } from '../api/index.js';

const SESSION_HEALTH_CLASSIFICATION_SET = new Set<string>(SESSION_HEALTH_CLASSIFICATIONS);
const SESSION_HEALTH_SIGNAL_STATES = new Set(['fresh', 'stale', 'missing', 'unknown']);
const SESSION_HEALTH_TRANSPORT_STATES = new Set(['verified', 'missing', 'unverified', 'unknown']);
const SESSION_HEALTH_ATTACH_STATES = new Set(['alive', 'stalled', 'unknown']);
const COORDINATED_STALL_ROOT_CAUSE_SET = new Set<string>(COORDINATED_STALL_ROOT_CAUSES);

interface SessionHealthPanelProps {
  /** Optional fetch seam for tests and embedded diagnostic views. */
  load?: () => Promise<SessionHealthDiagnostics>;
}

export function SessionHealthPanel({ load = fetchSessionHealth }: SessionHealthPanelProps) {
  const [report, setReport] = useState<SessionHealthDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await load();
        if (!cancelled) {
          setReport(next);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setReport(null);
          setError('Session health is unavailable.');
        }
      }
    };
    void refresh();
    const interval = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [load]);

  return (
    <section className="detection-stats-section session-health-section" aria-label="Session Health">
      <div className="session-health-header">
        <span>Session Health</span>
        {report ? <time dateTime={report.generatedAt}>Updated {formatUpdatedAt(report.generatedAt)}</time> : null}
        {report?.coordinatedStall ? <span className="finding-evidence-pill finding-evidence-pill--warn">coordinated stall</span> : null}
      </div>
      <div className="session-health-body" aria-live="polite">
        {error ? <div className="diagnostic-error">{error}</div> : null}
        {!error && !report ? <div className="diagnostic-muted">Loading session signals…</div> : null}
        {report?.sessions?.length === 0 ? <div className="diagnostic-muted">No tracked terminal sessions.</div> : null}
        {report?.sessions?.length ? (
          <table className="session-health-table">
            <caption className="sr-only">Per-session terminal health signals</caption>
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">Classification</th>
                <th scope="col">PTY</th>
                <th scope="col">Hooks</th>
                <th scope="col">Transcript</th>
                <th scope="col">Browser</th>
                <th scope="col">Attach</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>{report.sessions.map((session) => <SessionHealthRow key={session.sessionId} session={session} />)}</tbody>
          </table>
        ) : null}
        {report?.coordinatedStall ? (
          <div className="diagnostic-findings">
            <div className="diagnostic-finding">
              <strong>Coordinated stall</strong>
              <span>Root cause: {formatClassification(report.coordinatedStall.rootCause)}</span>
              <span>Affected sessions: {report.coordinatedStall.sessionIds.join(', ')}</span>
              <span>Observed window: {report.coordinatedStall.windowMs}ms</span>
              <span>Evidence: {report.coordinatedStall.evidence.join(' · ')}</span>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function SessionHealthRow({ session }: { session: SessionHealthSnapshot }) {
  return (
    <tr className={`session-health-row session-health-row--${session.classification}`}>
      <th scope="row">{session.sessionId}</th>
      <td><span className="session-health-classification">{formatClassification(session.classification)}</span></td>
      <td>{formatSignalCell('PTY', session.signals.pty)}</td>
      <td>{formatSignalCell('Hooks', session.signals.hooks)}</td>
      <td>{formatSignalCell('Transcript', session.signals.transcript)}</td>
      <td>{session.browser.bridgeOpen ? (session.browser.replayedOnly ? 'Replayed only' : 'Open') : 'Closed'}</td>
      <td>Generation ×{session.backend.attachGeneration}<br />Reattachments ×{session.backend.reattachCount}</td>
      <td className="session-health-evidence">
        {session.evidence.map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
      </td>
    </tr>
  );
}

function formatSignalCell(label: string, signal: { state: string; lastProgressAt: string | null; ageMs: number | null }): React.ReactNode {
  const timestamp = signal.lastProgressAt ?? 'no timestamp';
  return <span aria-label={`${label} ${formatSignal(signal.state)}, last progress ${timestamp}`} title={timestamp}>
    {formatSignal(signal.state)}{formatAge(signal.ageMs)}
  </span>;
}

async function fetchSessionHealth(): Promise<SessionHealthDiagnostics> {
  const body = await getSessionHealth();
  if (!isSessionHealthDiagnostics(body)) throw new Error('invalid session health response');
  return body;
}

function formatClassification(value: SessionHealthSnapshot['classification']): string {
  return formatDiagnosticIdentifier(value);
}

function formatSignal(value: string): string {
  return formatDiagnosticIdentifier(value);
}

function formatAge(ageMs: number | null): string {
  if (ageMs === null) return '';
  if (ageMs < 1_000) return ' · <1s';
  if (ageMs < 60_000) return ` · ${Math.round(ageMs / 1_000)}s`;
  return ` · ${Math.round(ageMs / 60_000)}m`;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function isSessionHealthDiagnostics(value: unknown): value is SessionHealthDiagnostics {
  if (!isRecord(value)
    || value.schemaVersion !== 'session-health.v1'
    || !isTimestamp(value.generatedAt)
    || !isTimestamp(value.restartEpoch)
    || !Array.isArray(value.sessions)) return false;
  if (value.coordinatedStall !== null && !isCoordinatedStall(value.coordinatedStall)) return false;
  return value.sessions.every((session) => {
    if (!isRecord(session)
      || typeof session.sessionId !== 'string'
      || session.sessionId.length === 0
      || session.schemaVersion !== 'session-health.v1'
      || !isTimestamp(session.generatedAt)
      || !isTimestamp(session.restartEpoch)
      || typeof session.classification !== 'string'
      || !SESSION_HEALTH_CLASSIFICATION_SET.has(session.classification)) return false;
    const signals = session.signals;
    const backend = session.backend;
    const browser = session.browser;
    const progress = session.progress;
    const task = session.task;
    return isRecord(task)
      && (task.status === null || typeof task.status === 'string')
      && (task.turnState === null || typeof task.turnState === 'string')
      && isSessionHealthPtySignal(isRecord(signals) ? signals.pty : undefined)
      && isSessionHealthSignal(isRecord(signals) ? signals.hooks : undefined)
      && isSessionHealthTranscriptSignal(isRecord(signals) ? signals.transcript : undefined)
      && isSessionHealthBackend(backend)
      && isSessionHealthBrowser(browser)
      && isSessionHealthProgress(progress)
      && Array.isArray(session.evidence)
      && session.evidence.every((item) => typeof item === 'string')
      && (session.coordinatedStall === undefined || isCoordinatedStall(session.coordinatedStall));
  });
}

function isSessionHealthSignal(value: unknown): boolean {
  return isRecord(value)
    && typeof value.state === 'string'
    && SESSION_HEALTH_SIGNAL_STATES.has(value.state)
    && isNullableTimestamp(value.lastProgressAt)
    && isNullableAge(value.ageMs);
}

function isSessionHealthPtySignal(value: unknown): boolean {
  return isSessionHealthSignal(value) && isRecord(value) && isNonNegativeFiniteNumber(value.ringHead);
}

function isSessionHealthTranscriptSignal(value: unknown): boolean {
  return isSessionHealthSignal(value) && isRecord(value) && typeof value.present === 'boolean';
}

function isSessionHealthBackend(value: unknown): boolean {
  return isRecord(value)
    && typeof value.transportState === 'string'
    && SESSION_HEALTH_TRANSPORT_STATES.has(value.transportState)
    && typeof value.attachState === 'string'
    && SESSION_HEALTH_ATTACH_STATES.has(value.attachState)
    && typeof value.recoveryInProgress === 'boolean'
    && isNonNegativeFiniteNumber(value.attachGeneration)
    && isNonNegativeFiniteNumber(value.reattachCount)
    && isNullableTimestamp(value.lastAttachAt);
}

function isSessionHealthBrowser(value: unknown): boolean {
  return isRecord(value)
    && typeof value.bridgeOpen === 'boolean'
    && isNullableTimestamp(value.lastOpenAt)
    && isNullableTimestamp(value.lastReplayAt)
    && isNullableTimestamp(value.lastLiveByteAt)
    && typeof value.freshBytesAfterReplay === 'boolean'
    && typeof value.replayedOnly === 'boolean';
}

function isSessionHealthProgress(value: unknown): boolean {
  return isRecord(value)
    && isNullableTimestamp(value.lastProgressAt)
    && isNullableAge(value.stallAgeMs);
}

function isCoordinatedStall(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.rootCause === 'string'
    && COORDINATED_STALL_ROOT_CAUSE_SET.has(value.rootCause)
    && isTimestamp(value.detectedAt)
    && Array.isArray(value.sessionIds)
    && value.sessionIds.every((id) => typeof id === 'string')
    && isNonNegativeFiniteNumber(value.windowMs)
    && isTimestamp(value.restartEpoch)
    && typeof value.postRestart === 'boolean'
    && Array.isArray(value.evidence)
    && value.evidence.every((item) => typeof item === 'string');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isNullableAge(value: unknown): value is number | null {
  return value === null || isNonNegativeFiniteNumber(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
