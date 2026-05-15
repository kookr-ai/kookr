import type { ActorId, ClientId, LeaseId, NodeEpoch, NodeId, ServerRevision, SessionEpoch, SessionId } from './ids.js';

export type RemoteControlEventKind = 'snapshot' | 'state.delta' | 'lease.changed';

export interface RemoteControlEventBase<K extends RemoteControlEventKind, P> {
  nodeId: NodeId;
  nodeEpoch: NodeEpoch;
  serverRevision: ServerRevision;
  ts: string;
  kind: K;
  payload: P;
}

export type RemoteSnapshotEvent<P = unknown> = RemoteControlEventBase<'snapshot', P>;
export type RemoteStateDeltaEvent<P = unknown> = RemoteControlEventBase<'state.delta', P>;
export type ClientVisibleLeaseState =
  | 'none'
  | 'acquiring'
  | 'held-local'
  | 'held-remote'
  | 'held-uncertain'
  | 'held-presumed-lost'
  | 'revoked';

export type LeaseRevocationReason =
  | 'owner-override'
  | 'heartbeat-timeout'
  | 'node-disconnect'
  | 'policy-revoke'
  | 'session-epoch-bump'
  | 'released';

export interface LeaseChangedPayload {
  sessionId: SessionId;
  sessionEpoch: SessionEpoch;
  leaseId?: LeaseId;
  previousState: ClientVisibleLeaseState;
  newState: ClientVisibleLeaseState;
  actorId?: ActorId;
  clientId?: ClientId;
  reason?: LeaseRevocationReason;
}

export type LeaseChangedEvent = RemoteControlEventBase<'lease.changed', LeaseChangedPayload>;

export type RemoteControlEvent<P = unknown> =
  | RemoteSnapshotEvent<P>
  | RemoteStateDeltaEvent<P>
  | LeaseChangedEvent;

export function isRemoteControlEvent(value: unknown): value is RemoteControlEvent {
  const msg = value as Partial<RemoteControlEvent>;
  return typeof value === 'object'
    && value !== null
    && typeof msg.nodeId === 'string'
    && typeof msg.nodeEpoch === 'string'
    && typeof msg.serverRevision === 'number'
    && typeof msg.ts === 'string'
    && (msg.kind === 'snapshot' || msg.kind === 'state.delta' || msg.kind === 'lease.changed')
    && 'payload' in msg;
}
