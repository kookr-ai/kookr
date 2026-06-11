import type { ServerMessage } from '../shared/contracts/messages.js';
import type { Scope } from './viewer-data-policy.js';

export interface SnapshotPayloadSizeObservation {
  payloadType: 'snapshot' | 'coordinator.snapshot';
  scopeKey: string;
  bytes: number;
  warnBytes: number;
  maxBytes: number;
  action: 'sent' | 'warned' | 'dropped';
}

export interface SnapshotPayloadSizePolicy {
  warnBytes: number;
  maxBytes: number;
  observe?: (observation: SnapshotPayloadSizeObservation) => void;
}

export function snapshotScopeKey(scope: Scope): string {
  return scope.kind === 'all' ? 'all' : `projects:${scope.projectIds.join(',')}`;
}

export function normalizeSnapshotPayloadSizePolicy(
  policy: SnapshotPayloadSizePolicy | undefined,
): SnapshotPayloadSizePolicy | undefined {
  if (!policy) return undefined;
  const maxBytes = Math.max(1, Math.floor(policy.maxBytes));
  const warnBytes = Math.max(1, Math.min(Math.floor(policy.warnBytes), maxBytes));
  return {
    warnBytes,
    maxBytes,
    ...(policy.observe ? { observe: policy.observe } : {}),
  };
}

export function shouldSendSerializedSnapshotFrame(
  data: string,
  payloadType: SnapshotPayloadSizeObservation['payloadType'],
  scopeKey: string,
  policy: SnapshotPayloadSizePolicy | undefined,
): boolean {
  if (!policy) return true;
  const bytes = Buffer.byteLength(data, 'utf8');
  const action: SnapshotPayloadSizeObservation['action'] =
    bytes > policy.maxBytes ? 'dropped' : bytes >= policy.warnBytes ? 'warned' : 'sent';
  policy.observe?.({
    payloadType,
    scopeKey,
    bytes,
    warnBytes: policy.warnBytes,
    maxBytes: policy.maxBytes,
    action,
  });
  if (action === 'dropped') {
    console.warn('[websocket] outbound snapshot payload exceeds hard cap; dropping frame', {
      payloadType,
      scopeKey,
      bytes,
      maxBytes: policy.maxBytes,
      warnBytes: policy.warnBytes,
    });
    return false;
  }
  if (action === 'warned') {
    console.warn('[websocket] outbound snapshot payload exceeds warning threshold', {
      payloadType,
      scopeKey,
      bytes,
      warnBytes: policy.warnBytes,
      maxBytes: policy.maxBytes,
    });
  }
  return true;
}

export function serializeServerMessageWithSnapshotPayloadPolicy(
  msg: ServerMessage,
  scopeKey: string,
  policy: SnapshotPayloadSizePolicy | undefined,
): string | null {
  const data = JSON.stringify(msg);
  if (msg.type !== 'snapshot' && msg.type !== 'coordinator.snapshot') return data;
  return shouldSendSerializedSnapshotFrame(
    data,
    msg.type,
    scopeKey,
    normalizeSnapshotPayloadSizePolicy(policy),
  )
    ? data
    : null;
}
