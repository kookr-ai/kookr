import type { CollaborationPrincipal } from './collaboration-share.js';

export const COLLABORATION_AUDIT_SCHEMA_VERSION = 'collaboration-audit.v1' as const;

export type CollaborationAuditActor =
  | CollaborationPrincipal
  | { kind: 'local-owner' }
  | { kind: 'peer-bootstrap' }
  | { kind: 'unknown-peer'; contactIdPresent: boolean; deviceIdPresent: boolean };

export type CollaborationAuditTransportKind =
  | 'privateNetwork'
  | 'selfHostedRelay'
  | 'hostedRelay'
  | 'local';

export type CollaborationAuditEventKind =
  | 'profile.changed'
  | 'contact.paired'
  | 'pairing.created'
  | 'pairing.accepted'
  | 'pairing.rejected'
  | 'pairing.expired'
  | 'device.revoked'
  | 'share.sent'
  | 'share.accepted'
  | 'share.refused'
  | 'share.revoked'
  | 'peer.disconnected'
  | 'policy.denied';

export interface CollaborationAuditEvent {
  schemaVersion: typeof COLLABORATION_AUDIT_SCHEMA_VERSION;
  auditEventId: string;
  ts: string;
  ownerNodeId: string;
  actor: CollaborationAuditActor;
  profileId?: string;
  transportKind: CollaborationAuditTransportKind;
  event: CollaborationAuditEventKind;
  taskId?: string;
  pairingId?: string;
  shareId?: string;
  grantId?: string;
  policyVersion?: number;
  decision?: 'allowed' | 'denied';
  reason?: string;
}

export interface CollaborationAuditFailure {
  at: string;
  reason: string;
}
