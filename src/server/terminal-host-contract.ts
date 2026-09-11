import type { LocalDtachBackend } from '../adapters/local-dtach-backend.js';
import type { TerminalInputCoordinator } from './terminal-input-coordinator.js';
import type { LocalDtachBackendOptions } from '../adapters/local-dtach-shared.js';
import type { BackendError, BackendStats } from '../adapters/terminal-backend.js';
import type { IncomingHttpHeaders } from 'node:http';
import type { TerminalSessionDataSource } from '../core/ports/terminal-session-stream-port.js';
import type { TerminalSourceRange } from '../shared/terminal-stream.js';
import type { TerminalInputRttMetricsSnapshot } from './terminal-input-rtt-metrics.js';

type BackendOperations = Pick<LocalDtachBackend,
  'createSession' | 'killSession' | 'listSessions' | 'isAlive' | 'write' | 'writeSequence'
  | 'captureBytes' | 'captureStreamSnapshot' | 'captureCurrentFrame' | 'resize'
  | 'getStats' | 'getSessionStartedAt' | 'getSessionDiagnostics' | 'getPersistenceStats'
  | 'reconnectTransport' | 'verifyRecoveredSession' | 'recoverLaunchAbandonedSessions'>;
type InputOperations = Pick<TerminalInputCoordinator, keyof TerminalInputCoordinator>;
export type TerminalHostOperations = BackendOperations & {
  [K in keyof InputOperations as `input.${K}`]: InputOperations[K];
} & {
  'connection.renew'(id: string, leaseUntilMs: number): boolean;
  'connection.close'(id: string): boolean;
  'stream.subscribe'(id: string, sessionId: string): void;
  'stream.unsubscribe'(id: string): void;
  'stream.ack'(id: string, position: number): void;
};
export type TerminalHostMethod = keyof TerminalHostOperations;
export type TerminalHostRequest = {
  [K in TerminalHostMethod]: { kind: 'request'; generation: string; id: number; deadline: number;
    method: K; args: Parameters<TerminalHostOperations[K]> };
}[TerminalHostMethod];
export interface TerminalHostResponse {
  kind: 'response'; generation: string; id: number;
  result?: unknown;
  error?: { name: string; message: string; sessionId?: string; durationMs?: number };
  inputSnapshot?: ReturnType<TerminalInputCoordinator['getSnapshot']>;
  inputSnapshotVersion?: number;
  inputSessionId?: string;
}

export interface TerminalHostUpgrade {
  kind: 'upgrade'; generation: string; id: string; sessionId: string;
  role: 'owner' | 'viewer'; grantId?: string;
  grantExpiresAtMs: number | null; leaseUntilMs: number;
  method: string; url: string; headers: IncomingHttpHeaders; head: Uint8Array;
}
export type TerminalHostParentMessage = TerminalHostRequest | TerminalHostUpgrade
  | { kind: 'init'; generation: string; options: LocalDtachBackendOptions }
  | { kind: 'shutdown'; generation: string };
export type TerminalHostChildMessage = TerminalHostResponse
  | { kind: 'ready'; generation: string; instanceDir: string; stats: BackendStats }
  | { kind: 'stats'; generation: string; at: number; stats: BackendStats;
      persistence: ReturnType<LocalDtachBackend['getPersistenceStats']>;
      inputMetrics: ReturnType<TerminalInputCoordinator['getWriteMetrics']>;
      inputRtt: TerminalInputRttMetricsSnapshot;
      inputSnapshots: NonNullable<ReturnType<TerminalInputCoordinator['getSnapshot']>>[]; inputSnapshotVersion: number;
      connections: number; legacyConnections: number; channelBytes: number; streamBytes: number; reconstructionBytes: number;
      outputBytes: number; rssBytes: number }
  | { kind: 'backend-error'; generation: string; error: BackendError }
  | { kind: 'connection-closed'; generation: string; id: string }
  | { kind: 'activity'; generation: string; sessionId: string; activity: 'input' | 'keystroke' | 'opened' | 'replay' | 'live' | 'closed' }
  | { kind: 'stream-data'; generation: string; id: string; position: number; bytes: Uint8Array;
      source?: TerminalSessionDataSource; range?: TerminalSourceRange }
  | { kind: 'stream-gap'; generation: string; id: string };

/** IPC is private, but malformed or stale envelopes must not execute operations. */
export function isTerminalHostRequest(value: unknown, generation: string): value is TerminalHostRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<TerminalHostRequest>;
  return request.kind === 'request' && request.generation === generation
    && Number.isSafeInteger(request.id) && request.id! > 0
    && typeof request.deadline === 'number' && request.deadline > Date.now() && request.deadline <= Date.now() + 30_100
    && typeof request.method === 'string' && TERMINAL_HOST_METHODS.has(request.method)
    && Array.isArray(request.args) && request.args.length <= 4
    && terminalHostPayloadSize(request) <= 8 * 1024 * 1024;
}

/** A transport outage is deliberately distinct from a confirmed dead session. */
export class TerminalHostUnavailableError extends Error {
  constructor(message = 'Terminal host unavailable; input delivery may be uncertain') {
    super(message); this.name = 'TerminalHostUnavailableError';
  }
}

/** Conservative size accounting without JSON-expanding terminal byte arrays. */
export function terminalHostPayloadSize(value: unknown, depth = 0): number {
  if (depth > 8) return Infinity;
  if (value === null || value === undefined) return 8;
  if (typeof value === 'string') return value.length * 3 + 8;
  if (typeof value === 'number' || typeof value === 'boolean') return 8;
  if (value instanceof Uint8Array) return value.buffer.byteLength + 32;
  if (Array.isArray(value) || value instanceof Set) {
    const entries = [...value];
    if (entries.length > 4096) return Infinity;
    return entries.reduce((sum, entry) => sum + terminalHostPayloadSize(entry, depth + 1), 32);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length > 4096) return Infinity;
    return entries.reduce((sum, [key, entry]) => sum + key.length * 3 + terminalHostPayloadSize(entry, depth + 1), 32);
  }
  return Infinity;
}

export const TERMINAL_HOST_METHODS: ReadonlySet<string> = new Set<TerminalHostMethod>([
  'createSession', 'killSession', 'listSessions', 'isAlive', 'write', 'writeSequence',
  'captureBytes', 'captureStreamSnapshot', 'captureCurrentFrame', 'resize', 'getStats',
  'getSessionStartedAt', 'getSessionDiagnostics', 'getPersistenceStats', 'reconnectTransport',
  'verifyRecoveredSession', 'recoverLaunchAbandonedSessions', 'input.registerSession',
  'input.cleanupSession', 'input.getSnapshot', 'input.getWriteMetrics', 'input.writeInput',
  'input.writeInputSequence', 'input.markUserPromptSubmitted', 'input.markToolStarted',
  'input.markPermissionBlocked', 'input.markStopFailure', 'input.markTurnStopped',
  'input.markSessionEnded', 'input.markPromptReady', 'input.handleEmptyEnterIntent',
  'input.dispose', 'connection.renew', 'connection.close', 'stream.subscribe', 'stream.unsubscribe', 'stream.ack',
]);
