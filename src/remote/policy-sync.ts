import type { GrantId, NodeId, PolicyVersion } from './ids.js';

export type ShareGrant = 'view' | 'write' | 'admin';

export type ShareSubject =
  | { kind: 'node'; nodeId: NodeId }
  | { kind: 'project'; nodeId: NodeId; projectId: string }
  | { kind: 'task'; nodeId: NodeId; taskId: string }
  | { kind: 'session'; nodeId: NodeId; sessionId: string };

export interface PolicyGrantRecord {
  grantId: GrantId;
  subject: ShareSubject;
  grants: ShareGrant[];
  policyVersion: PolicyVersion;
  expiresAt?: string;
}

export interface PolicySyncMessage {
  type: 'policy.sync';
  nodeId: NodeId;
  policyVersion: PolicyVersion;
  grants: PolicyGrantRecord[];
  revokedGrantIds: GrantId[];
}

export interface PolicyDeltaMessage {
  type: 'policy.delta';
  nodeId: NodeId;
  policyVersion: PolicyVersion;
  upserts: PolicyGrantRecord[];
  revokes: GrantId[];
}

export interface PolicyDeltaAckMessage {
  type: 'policy.delta.ack';
  nodeId: NodeId;
  policyVersion: PolicyVersion;
  appliedGrantIds: GrantId[];
  revokedGrantIds: GrantId[];
}

export interface PolicyRevokeMessage {
  type: 'policy.revoke';
  nodeId: NodeId;
  grantId: GrantId;
  policyVersion: PolicyVersion;
}

export type PolicySyncProtocolMessage =
  | PolicySyncMessage
  | PolicyDeltaMessage
  | PolicyDeltaAckMessage
  | PolicyRevokeMessage;
