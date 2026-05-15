import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { GrantId, NodeId, PolicyVersion } from '../../../src/remote/ids.js';
import { asGrantId, asPolicyVersion } from '../../../src/remote/ids.js';
import type { PolicyGrantRecord, ShareGrant, ShareSubject } from '../../../src/remote/policy-sync.js';

export interface InvitationRecord {
  invitationId: string;
  nodeId: NodeId;
  subject: ShareSubject;
  grants: ShareGrant[];
  grantId: GrantId;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt?: string;
  acceptedAt?: string;
  acceptedBy?: string;
  memberTokenHash?: string;
  memberId?: string;
  policyVersion: PolicyVersion;
}
export interface AcceptedInvitation {
  invitation: InvitationRecord;
  memberToken: string;
  policyGrant: PolicyGrantRecord;
}

export type InvitationAcceptResult =
  | { ok: true; accepted: AcceptedInvitation }
  | { ok: false; reason: 'not-found' | 'expired' | 'revoked' | 'already-used' };

export type InvitationRevokeResult =
  | { ok: true; invitation: InvitationRecord; alreadyRevoked: boolean }
  | { ok: false; reason: 'not-found' };

export interface InvitationStoreOptions {
  now?: () => Date;
  tokenBytes?: number;
  defaultTtlMs?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function issueToken(prefix: string, tokenBytes: number): string {
  return `${prefix}_${randomBytes(tokenBytes).toString('base64url')}`;
}

export class InvitationStore {
  private readonly invitations = new Map<string, InvitationRecord>();
  private readonly invitationTokenIndex = new Map<string, string>();
  private readonly memberTokenIndex = new Map<string, string>();
  private policyVersion = 0;
  private readonly now: () => Date;
  private readonly tokenBytes: number;
  private readonly defaultTtlMs: number;

  constructor(opts: InvitationStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.tokenBytes = opts.tokenBytes ?? 24;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  create(input: {
    nodeId: NodeId;
    subject?: ShareSubject;
    grants: ShareGrant[];
    ttlMs?: number;
  }): { invitation: InvitationRecord; token: string } {
    const token = issueToken('kookr_inv_v1', this.tokenBytes);
    const invitationId = `inv-${randomUUID()}`;
    const grantId = asGrantId(`grant-${randomUUID()}`);
    const now = this.now();
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    this.policyVersion += 1;
    const invitation: InvitationRecord = {
      invitationId,
      nodeId: input.nodeId,
      subject: input.subject ?? { kind: 'node', nodeId: input.nodeId },
      grants: [...input.grants],
      grantId,
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      policyVersion: asPolicyVersion(this.policyVersion),
    };
    this.invitations.set(invitationId, invitation);
    this.invitationTokenIndex.set(invitation.tokenHash, invitationId);
    return { invitation: { ...invitation, grants: [...invitation.grants] }, token };
  }

  accept(token: string, acceptedBy?: string): InvitationAcceptResult {
    const invitationId = this.invitationTokenIndex.get(hashToken(token));
    if (!invitationId) return { ok: false, reason: 'not-found' };
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    if (invitation.revokedAt) return { ok: false, reason: 'revoked' };
    if (invitation.acceptedAt) return { ok: false, reason: 'already-used' };
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) return { ok: false, reason: 'expired' };

    const memberToken = issueToken('kookr_member_v1', this.tokenBytes);
    const memberTokenHash = hashToken(memberToken);
    const accepted = {
      ...invitation,
      acceptedAt: this.now().toISOString(),
      ...(acceptedBy ? { acceptedBy } : {}),
      memberId: `member-${randomUUID()}`,
      memberTokenHash,
    };
    this.invitations.set(invitationId, accepted);
    this.memberTokenIndex.set(memberTokenHash, invitationId);
    const policyGrant: PolicyGrantRecord = {
      grantId: accepted.grantId,
      subject: accepted.subject,
      grants: [...accepted.grants],
      policyVersion: accepted.policyVersion,
      expiresAt: accepted.expiresAt,
    };
    return {
      ok: true,
      accepted: {
        invitation: { ...accepted, grants: [...accepted.grants] },
        memberToken,
        policyGrant,
      },
    };
  }

  revoke(invitationId: string): InvitationRevokeResult {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    const alreadyRevoked = Boolean(invitation.revokedAt);
    if (!alreadyRevoked) {
      this.policyVersion += 1;
      invitation.revokedAt = this.now().toISOString();
      invitation.policyVersion = asPolicyVersion(this.policyVersion);
    }
    return { ok: true, invitation: { ...invitation, grants: [...invitation.grants] }, alreadyRevoked };
  }

  authenticateMember(token: string): InvitationRecord | null {
    const invitationId = this.memberTokenIndex.get(hashToken(token));
    if (!invitationId) return null;
    const invitation = this.invitations.get(invitationId);
    if (!invitation || !invitation.acceptedAt || invitation.revokedAt) return null;
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) return null;
    return { ...invitation, grants: [...invitation.grants] };
  }

  currentPolicyVersion(): PolicyVersion {
    return asPolicyVersion(this.policyVersion);
  }

  activePolicyGrantsForNode(nodeId: NodeId): PolicyGrantRecord[] {
    const nowMs = this.now().getTime();
    return [...this.invitations.values()]
      .filter((invitation) => (
        invitation.nodeId === nodeId
        && Boolean(invitation.acceptedAt)
        && !invitation.revokedAt
        && Date.parse(invitation.expiresAt) > nowMs
      ))
      .map((invitation) => ({
        grantId: invitation.grantId,
        subject: invitation.subject,
        grants: [...invitation.grants],
        policyVersion: invitation.policyVersion,
        expiresAt: invitation.expiresAt,
      }));
  }

  revokedGrantIdsForNode(nodeId: NodeId): GrantId[] {
    return [...this.invitations.values()]
      .filter((invitation) => invitation.nodeId === nodeId && Boolean(invitation.revokedAt))
      .map((invitation) => invitation.grantId);
  }

  list(): InvitationRecord[] {
    return [...this.invitations.values()].map((invitation) => ({ ...invitation, grants: [...invitation.grants] }));
  }
}
