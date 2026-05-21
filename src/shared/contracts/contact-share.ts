import type { NodeId, SessionEpoch, SessionId } from '../../remote/ids.js';
import type { RemoteTaskProjectionStatus } from '../../remote/share-contract.js';

export const SHARED_TASK_ID_PREFIX = 'shared:';

export type ContactTrustState = 'verified' | 'rotated-unverified' | 'blocked';
export type ContactShareEnvelopeKind =
  | 'share.invite'
  | 'share.accept'
  | 'share.refuse'
  | 'share.revoke'
  | 'grant.request'
  | 'grant.resolve'
  | 'shared-task.update';

export type ContactShareLifecycle = 'pending' | 'accepted' | 'refused' | 'revoked' | 'expired';
export type ContactShareGrant = 'view' | 'terminalView';

export interface KookrContactDevice {
  deviceId: string;
  publicKey: string;
  label?: string;
  lastSeenAt?: string;
}

export interface KookrContact {
  contactId: string;
  displayName: string;
  verifiedFingerprint: string;
  devices: KookrContactDevice[];
  trustState: ContactTrustState;
}

export interface ContactShareEnvelope {
  schemaVersion: 'contact-share-envelope.v1';
  envelopeId: string;
  shareId: string;
  decisionVersion: number;
  previousEnvelopeId?: string;
  senderContactId: string;
  recipientContactId: string;
  recipientDeviceId: string;
  kind: ContactShareEnvelopeKind;
  createdAt: string;
  expiresAt?: string;
  ciphertext: string;
  senderSignature: string;
}

export interface SharedTask {
  kind: 'shared-task';
  sharedTaskId: string;
  ownerContactId: string;
  ownerDisplayName: string;
  ownerNodeLabel?: string;
  originNodeId: NodeId;
  remoteTaskId: string;
  shareId: string;
  terminalSubject?: {
    sessionId: SessionId;
    sessionEpoch: SessionEpoch;
    projectionId?: string;
    sessionAlias?: 'primary';
  };
  localDisplayLabel: string;
  lifecycle: ContactShareLifecycle;
  expiresAt?: string;
  grants: ContactShareGrant[];
  source: 'contact-share';
  remoteStatus: RemoteTaskProjectionStatus;
  remoteProjectionUpdatedAt?: string;
  updatedAt: string;
}

export interface ContactShareInboxItem {
  shareId: string;
  envelopeId: string;
  senderContactId: string;
  senderDisplayName: string;
  recipientDeviceId: string;
  lifecycle: ContactShareLifecycle;
  notificationTitle: string;
  notificationBody: string;
  redacted: true;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface DecryptedContactShareInvite {
  shareId: string;
  ownerContactId: string;
  ownerDisplayName: string;
  ownerNodeLabel?: string;
  originNodeId: NodeId;
  remoteTaskId: string;
  taskLabel: string;
  grants: ContactShareGrant[];
  remoteStatus: RemoteTaskProjectionStatus;
  terminalSubject?: SharedTask['terminalSubject'];
}

export interface ListContactShareContactsApiResponse {
  contacts: KookrContact[];
}

export interface ListContactShareInboxApiResponse {
  inbox: ContactShareInboxItem[];
}

export interface ListSharedTasksApiResponse {
  sharedTasks: SharedTask[];
}

export interface CreateContactShareApiResponse {
  envelope: ContactShareEnvelope;
  notification: {
    title: string;
    body: string;
    redacted: true;
  };
}

export interface AcceptContactShareApiResponse {
  sharedTask: SharedTask;
}

const ENVELOPE_KINDS: readonly ContactShareEnvelopeKind[] = [
  'share.invite',
  'share.accept',
  'share.refuse',
  'share.revoke',
  'grant.request',
  'grant.resolve',
  'shared-task.update',
];

const CONTACT_SHARE_ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'envelopeId',
  'shareId',
  'decisionVersion',
  'previousEnvelopeId',
  'senderContactId',
  'recipientContactId',
  'recipientDeviceId',
  'kind',
  'createdAt',
  'expiresAt',
  'ciphertext',
  'senderSignature',
]);

export function isSharedTaskId(taskId: string): boolean {
  return taskId.startsWith(SHARED_TASK_ID_PREFIX);
}

export function sharedTaskIdForShare(shareId: string): string {
  return `${SHARED_TASK_ID_PREFIX}${shareId}`;
}

export function isContactShareEnvelope(value: unknown): value is ContactShareEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const envelope = value as Partial<ContactShareEnvelope> & Record<string, unknown>;
  if (!Object.keys(envelope).every((key) => CONTACT_SHARE_ENVELOPE_KEYS.has(key))) return false;
  if (
    envelope.schemaVersion !== 'contact-share-envelope.v1'
    || typeof envelope.envelopeId !== 'string'
    || typeof envelope.shareId !== 'string'
    || typeof envelope.decisionVersion !== 'number'
    || !Number.isInteger(envelope.decisionVersion)
    || envelope.decisionVersion < 0
    || (envelope.previousEnvelopeId !== undefined && typeof envelope.previousEnvelopeId !== 'string')
    || typeof envelope.senderContactId !== 'string'
    || typeof envelope.recipientContactId !== 'string'
    || typeof envelope.recipientDeviceId !== 'string'
    || !ENVELOPE_KINDS.includes(envelope.kind as ContactShareEnvelopeKind)
    || typeof envelope.createdAt !== 'string'
    || (envelope.expiresAt !== undefined && (
      typeof envelope.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(envelope.expiresAt))
    ))
    || typeof envelope.ciphertext !== 'string'
    || envelope.ciphertext.length === 0
    || typeof envelope.senderSignature !== 'string'
    || envelope.senderSignature.length === 0
  ) {
    return false;
  }
  return true;
}
