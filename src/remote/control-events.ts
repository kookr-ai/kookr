import type { NodeEpoch, NodeId, ServerRevision } from './ids.js';

export type RemoteControlEventKind = 'snapshot' | 'state.delta';

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

export type RemoteControlEvent<P = unknown> =
  | RemoteSnapshotEvent<P>
  | RemoteStateDeltaEvent<P>;

export function isRemoteControlEvent(value: unknown): value is RemoteControlEvent {
  const msg = value as Partial<RemoteControlEvent>;
  return typeof value === 'object'
    && value !== null
    && typeof msg.nodeId === 'string'
    && typeof msg.nodeEpoch === 'string'
    && typeof msg.serverRevision === 'number'
    && typeof msg.ts === 'string'
    && (msg.kind === 'snapshot' || msg.kind === 'state.delta')
    && 'payload' in msg;
}
