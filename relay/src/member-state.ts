import type { NodeHello } from '../../src/remote/handshake.js';
import type { MemberBlockedReason, MemberShareState, MemberTerminalSharingStatus } from '../../src/shared/contracts/session-sharing-public.js';
import { isGuestLinkTaskShare, type InvitationRecord } from './invitations/store.js';

export interface MemberNodeState {
  displayName?: string;
  connected: boolean;
  lastSeen?: string;
  hello?: NodeHello;
  policySyncStatus: 'notSent' | 'sentAwaitingAck' | 'acked' | 'stale' | 'timedOut' | 'failed';
  lastPolicyAckAt?: string;
}

export function memberBlockedMessage(reason: MemberBlockedReason): string {
  switch (reason) {
    case 'policy.grantRequired':
      return 'Terminal viewing requires owner approval.';
    case 'policy.syncPending':
      return 'The owner is still applying your approval.';
    case 'policy.syncFailed':
      return 'The owner could not apply the latest sharing policy.';
    case 'policy.syncTimedOut':
      return 'The owner has not acknowledged the latest sharing policy yet.';
    case 'policy.syncStale':
      return 'The owner is using an older sharing policy.';
    case 'node.offline':
      return 'The owner node is offline right now.';
    case 'node.featureUnavailable':
      return 'Terminal sharing is not available for this session.';
    case 'node.untrusted':
      return 'The owner has not enabled terminal sharing on this node.';
    case 'guest.terminalDisabled':
      return 'Guest Links are view-only and do not support terminal viewing.';
    case 'transport.insecure':
      return 'Terminal sharing requires HTTPS for public links.';
  }
}

export function buildMemberShareState(input: {
  invitation: InvitationRecord;
  node: MemberNodeState;
  deviceId?: string;
  now?: Date;
}): MemberShareState {
  const now = input.now ?? new Date();
  const checkedAt = now.toISOString();
  const invitation = input.invitation;
  const expired = Date.parse(invitation.expiresAt) <= now.getTime();
  const nodeNextRetryAt = input.node.connected ? undefined : new Date(now.getTime() + 5_000).toISOString();
  const terminal = buildTerminalStatus({
    invitation,
    node: input.node,
    expired,
    nextRetryAt: nodeNextRetryAt,
    memberSessionId: invitation.memberId,
  });
  const guestLink = isGuestLinkTaskShare(invitation);
  const guestSessionTerminalApproved = hasGuestSessionTerminalView(invitation, invitation.memberId);
  const controllerLease = guestLink ? { state: 'available' as const } : controllerLeaseState(invitation, input.deviceId, now);
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
      || (grant === 'terminalView' && (!guestLink || guestSessionTerminalApproved))
      || (!guestLink && (
        grant === 'terminalInput'
        || grant === 'launch'
        || grant === 'stop'
        || grant === 'permissionApprove'
      ))
    )),
    grantRequests: (invitation.grantRequests ?? [])
      .filter((request) => !guestLink || (
        request.requestedBy === invitation.memberId
        && request.requestedGrants.length > 0
        && request.requestedGrants.every((grant) => grant === 'terminalView')
      ))
      .map((request) => ({
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
    controllerLease,
    freshness: {
      checkedAt,
      ...(input.node.lastSeen ? { lastNodeSeenAt: input.node.lastSeen } : {}),
      ...(input.node.lastPolicyAckAt ? { lastPolicyAckAt: input.node.lastPolicyAckAt } : {}),
      ...(nodeNextRetryAt ? { nextRetryAt: nodeNextRetryAt } : {}),
    },
  };
}

function controllerLeaseState(
  invitation: InvitationRecord,
  deviceId: string | undefined,
  now: Date,
): NonNullable<MemberShareState['controllerLease']> {
  const lease = invitation.controllerLease;
  if (!lease || Date.parse(lease.expiresAt) <= now.getTime()) {
    return { state: 'available' };
  }
  if (deviceId && lease.deviceId === deviceId) {
    return {
      state: 'heldByThisDevice',
      ...(lease.holderLabel ? { holderLabel: lease.holderLabel } : {}),
      expiresAt: lease.expiresAt,
    };
  }
  return {
    state: 'heldByAnotherDevice',
    ...(lease.holderLabel ? { holderLabel: lease.holderLabel } : {}),
    expiresAt: lease.expiresAt,
  };
}

function buildTerminalStatus(input: {
  invitation: InvitationRecord;
  node: MemberNodeState;
  expired: boolean;
  nextRetryAt?: string;
  memberSessionId?: string;
}): MemberTerminalSharingStatus {
  if (input.invitation.revokedAt) return { state: 'revoked' };
  if (input.expired) return { state: 'expired' };
  const guestLink = isGuestLinkTaskShare(input.invitation);
  const hasTerminalInput = !guestLink && input.invitation.grants.includes('terminalInput');
  const guestSessionMayViewTerminal = hasGuestSessionTerminalView(input.invitation, input.memberSessionId);
  const hasTerminalView = (!guestLink && (input.invitation.grants.includes('terminalView') || hasTerminalInput))
    || guestSessionMayViewTerminal;
  if (hasTerminalView || hasTerminalInput) {
    if (!input.node.connected) return blocked('node.offline', input.nextRetryAt);
    const features = new Set(input.node.hello?.supportedFeatures ?? []);
    const needsTerminalInput = !guestLink && hasTerminalInput;
    if (!features.has('terminal-stream') && (!needsTerminalInput || !features.has('terminal-input'))) {
      return blocked('node.untrusted', input.nextRetryAt);
    }
    if (!features.has('terminal-stream') || (needsTerminalInput && !features.has('terminal-input'))) {
      return blocked('node.featureUnavailable', input.nextRetryAt);
    }
    if (input.node.policySyncStatus === 'notSent' || input.node.policySyncStatus === 'sentAwaitingAck') {
      return blocked('policy.syncPending', input.nextRetryAt);
    }
    if (input.node.policySyncStatus === 'timedOut') return blocked('policy.syncTimedOut', input.nextRetryAt);
    if (input.node.policySyncStatus === 'stale') return blocked('policy.syncStale', input.nextRetryAt);
    if (input.node.policySyncStatus === 'failed') return blocked('policy.syncFailed', input.nextRetryAt);
    return needsTerminalInput ? { state: 'available' } : { state: 'viewOnly' };
  }
  const requests = input.invitation.grantRequests ?? [];
  const pending = [...requests].reverse().find((request) => (
    request.status === 'pending'
    && request.requestedBy === input.memberSessionId
    && (request.requestedGrants.includes('terminalInput') || request.requestedGrants.includes('terminalView'))
  ));
  if (pending) return { state: 'pendingApproval', requestId: pending.requestId };
  const denied = [...requests].reverse().find((request) => (
    request.status === 'denied'
    && request.requestedBy === input.memberSessionId
    && (request.requestedGrants.includes('terminalInput') || request.requestedGrants.includes('terminalView'))
  ));
  if (denied) return { state: 'denied', deniedAt: denied.resolvedAt ?? denied.requestedAt };
  return blocked('policy.grantRequired', input.nextRetryAt);
}

function hasGuestSessionTerminalView(invitation: InvitationRecord, memberSessionId: string | undefined): boolean {
  return isGuestLinkTaskShare(invitation) && (invitation.grantRequests ?? []).some((request) => (
    request.status === 'approved'
    && request.requestedBy === memberSessionId
    && request.requestedGrants.length > 0
    && request.requestedGrants.every((grant) => grant === 'terminalView')
  ));
}

function blocked(reason: MemberBlockedReason, nextRetryAt?: string): MemberTerminalSharingStatus {
  return {
    state: 'blocked',
    reason,
    message: memberBlockedMessage(reason),
    ...(nextRetryAt ? { nextRetryAt } : {}),
  };
}
