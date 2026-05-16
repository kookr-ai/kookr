import { Buffer } from 'node:buffer';

import type { TerminalBackend, SessionId as BackendSessionId } from '../adapters/terminal-backend.js';
import type { RemoteNodeClient } from './node-client.js';
import type { SessionEpoch, SessionId } from './ids.js';
import type { TerminalBytesEvent } from './stream-events.js';

export interface SessionStreamPublisherOptions {
  terminalBackend: Pick<TerminalBackend, 'listSessions' | 'onData'>;
  remoteNodeClient: Pick<RemoteNodeClient, 'status' | 'publish'>;
  env?: Partial<Record<'KOOKR_RELAY_TRUSTED', string | undefined>>;
  syncIntervalMs?: number;
  now?: () => Date;
  logger?: Pick<typeof console, 'warn'>;
}

interface SessionStreamState {
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  nextSeq: number;
  unsubscribe: () => void;
}

export interface SessionStreamPublisher {
  start(): Promise<void>;
  stop(): void;
  syncSessions(): Promise<void>;
  currentCursor(sessionId: string): { sessionEpoch: SessionEpoch; lastSeq: number } | null;
  readonly trusted: boolean;
}

const DEFAULT_SYNC_INTERVAL_MS = 2_000;

function asSessionId(value: string): SessionId {
  return value as SessionId;
}

function asSessionEpoch(value: string): SessionEpoch {
  return value as SessionEpoch;
}

export function isRelayTerminalStreamingTrusted(env: Partial<Record<'KOOKR_RELAY_TRUSTED', string | undefined>> = process.env): boolean {
  return env.KOOKR_RELAY_TRUSTED === 'true';
}

export function createSessionStreamPublisher(opts: SessionStreamPublisherOptions): SessionStreamPublisher {
  const syncIntervalMs = opts.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const now = opts.now ?? (() => new Date());
  const logger = opts.logger ?? console;
  const states = new Map<BackendSessionId, SessionStreamState>();
  const lastEpochBySession = new Map<BackendSessionId, number>();
  const trusted = isRelayTerminalStreamingTrusted(opts.env);
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const publishBytes = (state: SessionStreamState, data: Uint8Array): void => {
    const event: TerminalBytesEvent = {
      nodeId: opts.remoteNodeClient.status.nodeId,
      nodeEpoch: opts.remoteNodeClient.status.nodeEpoch,
      sessionId: state.sessionId,
      sessionEpoch: state.sessionEpoch,
      seq: state.nextSeq as TerminalBytesEvent['seq'],
      ts: now().toISOString(),
      kind: 'terminal.bytes',
      payload: {
        encoding: 'base64',
        data: Buffer.from(data).toString('base64'),
        byteLength: data.byteLength,
      },
    };
    state.nextSeq += 1;
    opts.remoteNodeClient.publish(event);
  };

  const subscribe = (id: BackendSessionId): void => {
    if (states.has(id) || stopped) return;
    const epoch = (lastEpochBySession.get(id) ?? 0) + 1;
    lastEpochBySession.set(id, epoch);
    const state: SessionStreamState = {
      sessionId: asSessionId(id),
      sessionEpoch: asSessionEpoch(String(epoch)),
      nextSeq: 1,
      unsubscribe: () => {},
    };
    state.unsubscribe = opts.terminalBackend.onData(id, (data) => {
      publishBytes(state, data);
    });
    states.set(id, state);
  };

  const unsubscribeMissing = (alive: Set<BackendSessionId>): void => {
    for (const [id, state] of states) {
      if (alive.has(id)) continue;
      state.unsubscribe();
      states.delete(id);
    }
  };

  const publisher: SessionStreamPublisher = {
    get trusted(): boolean {
      return trusted;
    },
    async start(): Promise<void> {
      if (stopped || !trusted) {
        if (!trusted) {
          logger.warn('[remote-terminal] KOOKR_RELAY_TRUSTED is not true; remote terminal viewing disabled');
        }
        return;
      }
      await publisher.syncSessions();
      syncTimer = setInterval(() => {
        void publisher.syncSessions().catch((err) => {
          logger.warn(`[remote-terminal] session stream sync failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }, syncIntervalMs);
    },
    stop(): void {
      stopped = true;
      if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
      }
      for (const state of states.values()) state.unsubscribe();
      states.clear();
    },
    async syncSessions(): Promise<void> {
      if (stopped || !trusted) return;
      const alive = new Set(await opts.terminalBackend.listSessions());
      unsubscribeMissing(alive);
      for (const id of alive) subscribe(id);
    },
    currentCursor(sessionId: string): { sessionEpoch: SessionEpoch; lastSeq: number } | null {
      const state = states.get(sessionId);
      if (!state) return null;
      return {
        sessionEpoch: state.sessionEpoch,
        lastSeq: Math.max(0, state.nextSeq - 1),
      };
    },
  };

  return publisher;
}
