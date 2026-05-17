import type { NodeHello } from '../../src/remote/handshake.js';
import type { MemberBlockedReason, MemberShareState, MemberTerminalSharingStatus } from '../../src/shared/contracts/session-sharing-public.js';
import type { InvitationRecord } from './invitations/store.js';

export interface MemberNodeState {
  displayName?: string;
  connected: boolean;
  lastSeen?: string;
  hello?: NodeHello;
  policySyncStatus: 'synced' | 'syncing' | 'lagging';
  lastPolicyAckAt?: string;
}

export function memberBlockedMessage(reason: MemberBlockedReason): string {
  switch (reason) {
    case 'policy.grantRequired':
      return 'Terminal input requires owner approval.';
    case 'policy.syncPending':
    case 'policy.syncFailed':
      return 'The owner is still applying your approval.';
    case 'node.offline':
      return 'The owner node is offline right now.';
    case 'node.featureUnavailable':
      return 'Terminal sharing is not available for this session.';
    case 'node.untrusted':
      return 'The owner has not enabled terminal sharing on this node.';
  }
}

export function buildMemberShareState(input: {
  invitation: InvitationRecord;
  node: MemberNodeState;
  now?: Date;
}): MemberShareState {
  const now = input.now ?? new Date();
  const checkedAt = now.toISOString();
  const invitation = input.invitation;
  const expired = Date.parse(invitation.expiresAt) <= now.getTime();
  const nodeNextRetryAt = input.node.connected ? undefined : new Date(now.getTime() + 5_000).toISOString();
  const terminal = buildTerminalStatus({ invitation, node: input.node, expired, nextRetryAt: nodeNextRetryAt });
  return {
    schemaVersion: 'member-share-state.v1',
    invitationId: invitation.invitationId,
    nodeId: invitation.nodeId,
    share: {
      state: invitation.revokedAt ? 'revoked' : expired ? 'expired' : invitation.acceptedAt ? 'approved' : 'pending',
      ...(invitation.redactedShareLabel ? { label: invitation.redactedShareLabel } : {}),
      expiresAt: invitation.expiresAt,
    },
    grants: invitation.grants.filter((grant): grant is MemberShareState['grants'][number] => (
      grant === 'view'
      || grant === 'terminalInput'
      || grant === 'launch'
      || grant === 'stop'
      || grant === 'permissionApprove'
    )),
    grantRequests: (invitation.grantRequests ?? []).map((request) => ({
      requestId: request.requestId,
      invitationId: request.invitationId,
      requestedGrants: [...request.requestedGrants],
      status: request.status,
      requestedAt: request.requestedAt,
      ...(request.comment ? { comment: request.comment } : {}),
      ...(request.resolvedAt ? { resolvedAt: request.resolvedAt } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
    })),
    node: {
      online: input.node.connected,
      ...(input.node.displayName ? { displayName: input.node.displayName } : {}),
      ...(input.node.lastSeen ? { lastSeenAt: input.node.lastSeen } : {}),
      ...(nodeNextRetryAt ? { nextRetryAt: nodeNextRetryAt } : {}),
    },
    terminal,
    freshness: {
      checkedAt,
      ...(input.node.lastSeen ? { lastNodeSeenAt: input.node.lastSeen } : {}),
      ...(input.node.lastPolicyAckAt ? { lastPolicyAckAt: input.node.lastPolicyAckAt } : {}),
      ...(nodeNextRetryAt ? { nextRetryAt: nodeNextRetryAt } : {}),
    },
  };
}

function buildTerminalStatus(input: {
  invitation: InvitationRecord;
  node: MemberNodeState;
  expired: boolean;
  nextRetryAt?: string;
}): MemberTerminalSharingStatus {
  if (input.invitation.revokedAt) return { state: 'revoked' };
  if (input.expired) return { state: 'expired' };
  if (input.invitation.grants.includes('terminalInput')) {
    if (!input.node.connected) return blocked('node.offline', input.nextRetryAt);
    const features = new Set(input.node.hello?.supportedFeatures ?? []);
    if (!features.has('terminal-stream') && !features.has('terminal-input')) {
      return blocked('node.untrusted', input.nextRetryAt);
    }
    if (!features.has('terminal-stream') || !features.has('terminal-input')) {
      return blocked('node.featureUnavailable', input.nextRetryAt);
    }
    if (input.node.policySyncStatus === 'syncing') return blocked('policy.syncPending', input.nextRetryAt);
    if (input.node.policySyncStatus === 'lagging') return blocked('policy.syncFailed', input.nextRetryAt);
    return { state: 'available' };
  }
  const requests = input.invitation.grantRequests ?? [];
  const pending = [...requests].reverse().find((request) => (
    request.status === 'pending' && request.requestedGrants.includes('terminalInput')
  ));
  if (pending) return { state: 'pendingApproval', requestId: pending.requestId };
  const denied = [...requests].reverse().find((request) => (
    request.status === 'denied' && request.requestedGrants.includes('terminalInput')
  ));
  if (denied) return { state: 'denied', deniedAt: denied.resolvedAt ?? denied.requestedAt };
  return blocked('policy.grantRequired', input.nextRetryAt);
}

function blocked(reason: MemberBlockedReason, nextRetryAt?: string): MemberTerminalSharingStatus {
  return {
    state: 'blocked',
    reason,
    message: memberBlockedMessage(reason),
    ...(nextRetryAt ? { nextRetryAt } : {}),
  };
}
