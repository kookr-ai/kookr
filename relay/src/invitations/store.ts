import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

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
  shareId?: string;
  passwordVerifier?: string;
  failedAcceptCount?: number;
  lockedUntil?: string;
  redactedShareLabel?: string;
  policyVersion: PolicyVersion;
}

export interface ShareTicketSecret {
  shareId: string;
  password: string;
  redactedShareLabel: string;
}

export interface AcceptedInvitation {
  invitation: InvitationRecord;
  memberToken: string;
  policyGrant: PolicyGrantRecord;
}

export type InvitationAcceptResult =
  | { ok: true; accepted: AcceptedInvitation }
  | { ok: false; reason: 'not-found' | 'expired' | 'revoked' | 'already-used' | 'invalid-password' | 'locked' };

export type InvitationRevokeResult =
  | { ok: true; invitation: InvitationRecord; alreadyRevoked: boolean }
  | { ok: false; reason: 'not-found' };

export interface InvitationStoreOptions {
  now?: () => Date;
  tokenBytes?: number;
  defaultTtlMs?: number;
  shareId?: () => string;
  sharePassword?: () => string;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const SHARE_ID_DIGITS = 6;
const SHARE_PASSWORD_BYTES = 7;
export const SHARE_TICKET_MAX_FAILED_ATTEMPTS = 5;
export const SHARE_TICKET_LOCKOUT_MS = 15 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function issueToken(prefix: string, tokenBytes: number): string {
  return `${prefix}_${randomBytes(tokenBytes).toString('base64url')}`;
}

function issueShareId(): string {
  const value = randomBytes(4).readUInt32BE(0) % (10 ** SHARE_ID_DIGITS);
  const digits = value.toString().padStart(SHARE_ID_DIGITS, '0');
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function normalizeShareId(shareId: string): string {
  const digits = shareId.replace(/\D/g, '');
  if (digits.length !== SHARE_ID_DIGITS) return '';
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

function redactShareId(shareId: string): string {
  const normalized = normalizeShareId(shareId);
  if (!normalized) return '***';
  return `${normalized.slice(0, 3)}-***`;
}

function issueSharePassword(): string {
  return randomBytes(SHARE_PASSWORD_BYTES).toString('base64url');
}

function createPasswordVerifier(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const digest = createHash('sha256').update(`${salt}:${password}`).digest('base64url');
  return `sha256:${salt}:${digest}`;
}

function verifyPassword(password: string, verifier: string): boolean {
  const [scheme, salt, expected] = verifier.split(':');
  if (scheme !== 'sha256' || !salt || !expected) return false;
  const actual = createHash('sha256').update(`${salt}:${password}`).digest('base64url');
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

export class InvitationStore {
  private readonly invitations = new Map<string, InvitationRecord>();
  private readonly invitationTokenIndex = new Map<string, string>();
  private readonly shareIdIndex = new Map<string, string>();
  private readonly memberTokenIndex = new Map<string, string>();
  private policyVersion = 0;
  private readonly now: () => Date;
  private readonly tokenBytes: number;
  private readonly defaultTtlMs: number;
  private readonly nextShareId: () => string;
  private readonly nextSharePassword: () => string;

  constructor(opts: InvitationStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.tokenBytes = opts.tokenBytes ?? 24;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.nextShareId = opts.shareId ?? issueShareId;
    this.nextSharePassword = opts.sharePassword ?? issueSharePassword;
  }

  create(input: {
    nodeId: NodeId;
    subject?: ShareSubject;
    grants: ShareGrant[];
    ttlMs?: number;
    shareTicket?: boolean;
  }): { invitation: InvitationRecord; token: string; shareTicket?: ShareTicketSecret } {
    const token = issueToken('kookr_inv_v1', this.tokenBytes);
    const invitationId = `inv-${randomUUID()}`;
    const grantId = asGrantId(`grant-${randomUUID()}`);
    const now = this.now();
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    const shareTicket = input.shareTicket ? this.createShareTicket() : undefined;
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
      ...(shareTicket ? {
        shareId: shareTicket.shareId,
        passwordVerifier: createPasswordVerifier(shareTicket.password),
        failedAcceptCount: 0,
        redactedShareLabel: shareTicket.redactedShareLabel,
      } : {}),
      policyVersion: asPolicyVersion(this.policyVersion),
    };
    this.invitations.set(invitationId, invitation);
    this.invitationTokenIndex.set(invitation.tokenHash, invitationId);
    if (shareTicket) this.shareIdIndex.set(shareTicket.shareId, invitationId);
    return { invitation: { ...invitation, grants: [...invitation.grants] }, token, ...(shareTicket ? { shareTicket } : {}) };
  }

  accept(token: string, acceptedBy?: string): InvitationAcceptResult {
    const invitationId = this.invitationTokenIndex.get(hashToken(token));
    if (!invitationId) return { ok: false, reason: 'not-found' };
    return this.acceptByInvitationId(invitationId, acceptedBy);
  }

  acceptTicket(shareId: string, password: string, acceptedBy?: string): InvitationAcceptResult {
    const normalizedShareId = normalizeShareId(shareId);
    if (!normalizedShareId || !password) return { ok: false, reason: 'not-found' };
    const invitationId = this.shareIdIndex.get(normalizedShareId);
    if (!invitationId) return { ok: false, reason: 'not-found' };
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    if (invitation.lockedUntil && Date.parse(invitation.lockedUntil) > this.now().getTime()) {
      return { ok: false, reason: 'locked' };
    }
    if (!invitation.passwordVerifier || !verifyPassword(password, invitation.passwordVerifier)) {
      const failedAcceptCount = (invitation.failedAcceptCount ?? 0) + 1;
      const lockedUntil = failedAcceptCount >= SHARE_TICKET_MAX_FAILED_ATTEMPTS
        ? new Date(this.now().getTime() + SHARE_TICKET_LOCKOUT_MS).toISOString()
        : invitation.lockedUntil;
      this.invitations.set(invitationId, {
        ...invitation,
        failedAcceptCount,
        ...(lockedUntil ? { lockedUntil } : {}),
      });
      return { ok: false, reason: lockedUntil ? 'locked' : 'invalid-password' };
    }
    return this.acceptByInvitationId(invitationId, acceptedBy);
  }

  private acceptByInvitationId(invitationId: string, acceptedBy?: string): InvitationAcceptResult {
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

  private createShareTicket(): ShareTicketSecret {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const shareId = normalizeShareId(this.nextShareId());
      if (!shareId || this.shareIdIndex.has(shareId)) continue;
      const password = this.nextSharePassword();
      return { shareId, password, redactedShareLabel: redactShareId(shareId) };
    }
    throw new Error('failed to allocate unique share ID');
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
