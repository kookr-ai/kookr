import type { CollaborationPrincipal } from './collaboration-share.js';

export const COLLABORATION_AUDIT_SCHEMA_VERSION = 'collaboration-audit.v1' as const;

export type CollaborationAuditActor =
  | CollaborationPrincipal
  | { kind: 'local-owner' }
  | { kind: 'peer-bootstrap' }
  | { kind: 'unknown-peer'; contactIdPresent: boolean; deviceIdPresent: boolean }
  /** A read-only shared-view viewer, identified only by its grant id (#808). */
  | { kind: 'viewer'; grantId: string };

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
  | 'policy.denied'
  // Read-only shared-view grant lifecycle (#808, RFC R10). `created`/`revoked`
  // are owner control-surface actions; `session-established` marks a viewer
  // cookie exchange; `sweep-evicted` marks the revocation sweep dropping a live
  // viewer socket.
  | 'viewer-grant.created'
  | 'viewer-grant.revoked'
  | 'viewer-grant.session-established'
  | 'viewer-grant.sweep-evicted';

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
