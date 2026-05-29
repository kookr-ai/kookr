import { Buffer } from 'node:buffer';

import type { TerminalSessionStreamPort } from '../core/ports/terminal-session-stream-port.js';
import type { RemoteNodeClient } from './node-client.js';
import type { Seq, SessionEpoch, SessionId } from './ids.js';
import type { TerminalBytesEvent } from './stream-events.js';
import { TerminalPublicationGate, type TerminalPublicationRule, type TerminalPublicationInstallResult } from './terminal-publication-gate.js';
import { encryptContactTerminalPayload } from './terminal-frame-crypto.js';

export interface SessionStreamPublisherOptions {
  terminalBackend: TerminalSessionStreamPort;
  remoteNodeClient: Pick<RemoteNodeClient, 'status' | 'publish'>;
  env?: Partial<Record<'KOOKR_RELAY_TRUSTED', string | undefined>>;
  syncIntervalMs?: number;
  now?: () => Date;
  logger?: Pick<typeof console, 'warn'>;
  publicationGate?: TerminalPublicationGate;
}

interface SessionStreamState {
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  nextSeq: number;
  unsubscribe: () => void;
}

type BackendSessionId = string;

export interface SessionStreamPublisher {
  start(): Promise<void>;
  stop(): void;
  syncSessions(): Promise<void>;
  currentCursor(sessionId: string): { sessionEpoch: SessionEpoch; lastSeq: number } | null;
  installPublicationRule(rule: Omit<TerminalPublicationRule, 'minSeqExclusive'>): TerminalPublicationInstallResult;
  recordDemandProof(input: Parameters<TerminalPublicationGate['recordDemandProof']>[0]): boolean;
  revokePublicationScope(publicationScopeId: string): void;
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
  const publicationGate = opts.publicationGate ?? new TerminalPublicationGate(now);
  const states = new Map<BackendSessionId, SessionStreamState>();
  const lastEpochBySession = new Map<BackendSessionId, number>();
  const trusted = isRelayTerminalStreamingTrusted(opts.env);
  let syncTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const publishBytes = (state: SessionStreamState, data: Uint8Array): void => {
    const seq = state.nextSeq as Seq;
    state.nextSeq += 1;
    const event: TerminalBytesEvent = {
      nodeId: opts.remoteNodeClient.status.nodeId,
      nodeEpoch: opts.remoteNodeClient.status.nodeEpoch,
      sessionId: state.sessionId,
      sessionEpoch: state.sessionEpoch,
      seq,
      ts: now().toISOString(),
      kind: 'terminal.bytes',
      payload: {
        encoding: 'base64',
        data: Buffer.from(data).toString('base64'),
        byteLength: data.byteLength,
      },
    };
    for (const publication of publicationGate.metadataForEvent(event)) {
      if (publication.streamEncryption?.kind === 'contact-e2ee') {
        const encrypted = encryptContactTerminalPayload(event.payload, {
          recipientDeviceId: publication.streamEncryption.recipientDeviceId,
          recipientPublicKey: publication.streamEncryption.recipientPublicKey,
          streamKeyId: publication.streamEncryption.streamKeyId,
          aad: `${event.nodeId}:${event.sessionId}:${event.sessionEpoch}:${event.seq}`,
        });
        opts.remoteNodeClient.publish({
          ...event,
          payload: encrypted.payload,
          publication: {
            publicationScopeId: publication.publicationScopeId,
            principal: publication.principal,
            policyVersion: publication.policyVersion,
            streamEncryption: encrypted.streamEncryption,
          },
        });
        continue;
      }
      opts.remoteNodeClient.publish({
        ...event,
        publication: {
          publicationScopeId: publication.publicationScopeId,
          principal: publication.principal,
          policyVersion: publication.policyVersion,
          ...(publication.streamEncryption ? { streamEncryption: publication.streamEncryption } : {}),
        },
      });
    }
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
    installPublicationRule(rule): TerminalPublicationInstallResult {
      return publicationGate.installRule(
        { ...rule, minSeqExclusive: 0 as Seq },
        publisher.currentCursor(rule.sessionId) as { sessionEpoch: SessionEpoch; lastSeq: Seq } | null,
      );
    },
    recordDemandProof(input: Parameters<TerminalPublicationGate['recordDemandProof']>[0]): boolean {
      return publicationGate.recordDemandProof(input);
    },
    revokePublicationScope(publicationScopeId: string): void {
      publicationGate.revokeScope(publicationScopeId);
    },
  };

  return publisher;
}
