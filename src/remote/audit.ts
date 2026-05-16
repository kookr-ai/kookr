export type RemoteAuditEntryState = 'intent' | 'result';
export type RemoteAuditOutcome = 'accepted' | 'rejected' | 'unknown';

export interface RemoteAuditBaseEntry {
  commandId: string;
  actorId: string;
  clientId: string;
  nodeId: string;
  sessionId: string;
  requestId: string;
  timestamp: string;
}

export interface RemoteAuditIntentEntry extends RemoteAuditBaseEntry {
  state: 'intent';
  action: string;
  baseRevision: number;
}

export interface RemoteAuditResultEntry extends RemoteAuditBaseEntry {
  state: 'result';
  outcome: RemoteAuditOutcome;
  reason?: string;
}

export type RemoteAuditEntry = RemoteAuditIntentEntry | RemoteAuditResultEntry;

export interface RemoteAuditScaffold {
  relayUrl: string;
  append(_entry: RemoteAuditEntry): Promise<void>;
}

export function createRemoteAuditScaffold(opts: { relayUrl: string }): RemoteAuditScaffold {
  return {
    relayUrl: opts.relayUrl,
    async append(_entry: RemoteAuditEntry): Promise<void> {
      // Phase 0a only defines the write-ahead shape. Durable writes arrive in
      // the later remote-command phase, still behind KOOKR_RELAY_URL.
    },
  };
}
