export const COLLABORATION_CONTACT_SHARE_INVITE_SCHEMA_VERSION = 'collaboration-contact-share-invite.v1' as const;

export type CollaborationGrantCapability = 'viewTask';
export type CollaborationContactShareDecision = 'accept' | 'decline' | 'revoke';
export type CollaborationContactShareInviteStatus = 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired';
export type CollaborationContactShareInviteDirection = 'inbound' | 'outbound';

export interface CollaborationContactDevicePrincipal {
  kind: 'contact-device';
  contactId: string;
  deviceId: string;
}

export interface CollaborationTaskSubject {
  kind: 'task';
  taskId: string;
}

export type CollaborationPrincipal = CollaborationContactDevicePrincipal;
export type CollaborationSubject = CollaborationTaskSubject;

export interface CollaborationGrantRecord {
  grantId: string;
  principal: CollaborationPrincipal;
  subject: CollaborationSubject;
  capabilities: CollaborationGrantCapability[];
  policyVersion: number;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}

export interface CollaborationGrantRevocationTombstone {
  tombstoneId: string;
  principal: CollaborationPrincipal;
  subject: CollaborationSubject;
  capabilities: CollaborationGrantCapability[];
  policyVersion: number;
  revokedAt: string;
  inviteId?: string;
  grantId?: string;
}

export interface CollaborationContactShareInvite {
  schemaVersion: typeof COLLABORATION_CONTACT_SHARE_INVITE_SCHEMA_VERSION;
  inviteId: string;
  direction: CollaborationContactShareInviteDirection;
  principal: CollaborationPrincipal;
  subject: CollaborationSubject;
  capabilities: CollaborationGrantCapability[];
  status: CollaborationContactShareInviteStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  grantId?: string;
}

export interface CreateCollaborationContactShareInviteRequest {
  taskId: string;
  expiresAt?: string;
  capabilities?: CollaborationGrantCapability[];
}

export interface DecideCollaborationContactShareRequest {
  inviteId: string;
  decision: CollaborationContactShareDecision;
}
