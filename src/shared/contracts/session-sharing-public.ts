import type { NodeId, Seq, SessionEpoch, SessionId } from '../../remote/ids.js';
import type { TaskShareGrant, TaskShareGrantRequest } from './remote-share.js';

export type MemberBlockedReason =
  | 'policy.grantRequired'
  | 'policy.syncPending'
  | 'policy.syncFailed'
  | 'policy.syncTimedOut'
  | 'policy.syncStale'
  | 'node.offline'
  | 'node.featureUnavailable'
  | 'node.untrusted'
  | 'guest.terminalDisabled'
  | 'transport.insecure';

export type MemberTerminalSharingStatus =
  | { state: 'available' }
  | { state: 'viewOnly' }
  | { state: 'pendingApproval'; requestId: string }
  | { state: 'denied'; deniedAt: string; canRequestAgainAt?: string }
  | { state: 'blocked'; reason: MemberBlockedReason; message: string; nextRetryAt?: string }
  | { state: 'revoked' }
  | { state: 'expired' };

export type MemberShareLifecycleState =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'revoked'
  | 'expired';

export type MemberGrantRequest = Omit<TaskShareGrantRequest, 'requestedBy'>;

export interface MemberShareState {
  schemaVersion: 'member-share-state.v1';
  invitationId: string;
  nodeId: NodeId;
  share: {
    state: MemberShareLifecycleState;
    label?: string;
    expiresAt: string;
  };
  grants: TaskShareGrant[];
  grantRequests: MemberGrantRequest[];
  node: {
    online: boolean;
    displayName?: string;
    lastSeenAt?: string;
    nextRetryAt?: string;
  };
  terminal: MemberTerminalSharingStatus;
  freshness: {
    checkedAt: string;
    lastNodeSeenAt?: string;
    lastPolicyAckAt?: string;
    nextRetryAt?: string;
  };
  controllerLease?: {
    state: 'available' | 'heldByThisDevice' | 'heldByAnotherDevice';
    holderLabel?: string;
    expiresAt?: string;
  };
  terminalReplayCursor?: {
    sessionId: SessionId;
    projectionId?: string;
    sessionAlias?: 'primary';
    sessionEpoch: SessionEpoch;
    afterSeq: Seq;
  };
}

export interface MemberShareStateResponse {
  state: MemberShareState;
}
