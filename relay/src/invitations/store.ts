import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

import type { GrantId, NodeId, PolicyVersion } from '../../../src/remote/ids.js';
import { asGrantId, asPolicyVersion } from '../../../src/remote/ids.js';
import type { PolicyGrantRecord, ShareGrant, ShareSubject } from '../../../src/remote/policy-sync.js';
import type { TaskShareGrantRequest, TaskShareMutableGrant } from '../../../src/remote/share-contract.js';

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
  memberDeviceId?: string;
  memberCsrfTokenHash?: string;
  controllerLease?: ControllerLeaseRecord;
  shareId?: string;
  passwordVerifier?: string;
  failedAcceptCount?: number;
  lockedUntil?: string;
  redactedShareLabel?: string;
  grantRequests?: TaskShareGrantRequest[];
  policyVersion: PolicyVersion;
}

export interface ControllerLeaseRecord {
  leaseId: string;
  deviceId: string;
  holderLabel?: string;
  acquiredAt: string;
  expiresAt: string;
  projectionVersion?: number;
  policyVersion?: PolicyVersion;
}

export interface ShareTicketSecret {
  shareId: string;
  password: string;
  redactedShareLabel: string;
}

export interface AcceptedInvitation {
  invitation: InvitationRecord;
  memberToken: string;
  csrfToken: string;
  deviceId: string;
  policyGrant: PolicyGrantRecord;
}

export type InvitationAcceptResult =
  | { ok: true; accepted: AcceptedInvitation }
  | { ok: false; reason: 'not-found' | 'expired' | 'revoked' | 'already-used' | 'invalid-password' | 'locked' };

export type InvitationRevokeResult =
  | { ok: true; invitation: InvitationRecord; alreadyRevoked: boolean }
  | { ok: false; reason: 'not-found' };

export type GrantRequestResult =
  | { ok: true; invitation: InvitationRecord; request: TaskShareGrantRequest }
  | { ok: false; reason: 'not-found' | 'expired' | 'revoked' | 'not-accepted' | 'empty-grants' | 'already-resolved' };

export type ControllerLeaseResult =
  | { ok: true; invitation: InvitationRecord; lease: ControllerLeaseRecord; previousLease?: ControllerLeaseRecord }
  | { ok: false; reason: 'not-found' | 'expired' | 'revoked' | 'not-accepted' | 'held-by-another-device'; lease?: ControllerLeaseRecord };

export type MemberBrowserSessionResult =
  | { ok: true; invitation: InvitationRecord; csrfToken: string; deviceId: string }
  | { ok: false; reason: 'not-found' | 'expired' | 'revoked' | 'not-accepted' };

export interface InvitationStoreOptions {
  now?: () => Date;
  tokenBytes?: number;
  defaultTtlMs?: number;
  shareId?: () => string;
  sharePassword?: () => string;
  initialInvitations?: InvitationRecord[];
  onSave?: (invitation: InvitationRecord) => void;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const LONG_SHARE_ENTROPY_THRESHOLD_MS = DEFAULT_TTL_MS;
const SHARE_ID_DIGITS = 6;
const SHARE_PASSWORD_BYTES = 7;
const LONG_SHARE_PASSWORD_BYTES = 10;
export const SHARE_TICKET_MAX_FAILED_ATTEMPTS = 5;
export const SHARE_TICKET_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_GRANT_REQUEST_COMMENT_LENGTH = 160;
const PASSWORD_VERIFIER_SCHEME = 'scrypt';
const PASSWORD_VERIFIER_KEY_LENGTH = 32;
const PASSWORD_VERIFIER_N = 16_384;
const PASSWORD_VERIFIER_R = 8;
const PASSWORD_VERIFIER_P = 1;

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

function issueSharePassword(ttlMs: number): string {
  return randomBytes(ttlMs > LONG_SHARE_ENTROPY_THRESHOLD_MS ? LONG_SHARE_PASSWORD_BYTES : SHARE_PASSWORD_BYTES).toString('base64url');
}

function createPasswordVerifier(password: string): string {
  const salt = randomBytes(16).toString('base64url');
  const digest = scryptSync(password, salt, PASSWORD_VERIFIER_KEY_LENGTH, {
    N: PASSWORD_VERIFIER_N,
    r: PASSWORD_VERIFIER_R,
    p: PASSWORD_VERIFIER_P,
  }).toString('base64url');
  return `${PASSWORD_VERIFIER_SCHEME}:${PASSWORD_VERIFIER_N}:${PASSWORD_VERIFIER_R}:${PASSWORD_VERIFIER_P}:${salt}:${digest}`;
}

function cloneInvitation(invitation: InvitationRecord): InvitationRecord {
  return {
    ...invitation,
    ...(invitation.controllerLease ? { controllerLease: { ...invitation.controllerLease } } : {}),
    grants: [...invitation.grants],
    ...(invitation.grantRequests ? { grantRequests: invitation.grantRequests.map((request) => ({
      ...request,
      requestedGrants: [...request.requestedGrants],
    })) } : {}),
  };
}

function normalizeTerminalGrantDependency(grants: ShareGrant[]): ShareGrant[] {
  const normalized = [...grants];
  if (normalized.includes('terminalInput') && !normalized.includes('terminalView')) {
    const inputIndex = normalized.indexOf('terminalInput');
    normalized.splice(Math.max(0, inputIndex), 0, 'terminalView');
  }
  return [...new Set(normalized)];
}

function normalizeShareGrants(grants: ShareGrant[]): ShareGrant[] {
  return normalizeTerminalGrantDependency(grants);
}

function normalizeMutableShareGrants(grants: TaskShareMutableGrant[]): TaskShareMutableGrant[] {
  return normalizeTerminalGrantDependency(grants) as TaskShareMutableGrant[];
}

function normalizeInvitationRecord(invitation: InvitationRecord): InvitationRecord {
  return {
    ...invitation,
    grants: normalizeShareGrants(invitation.grants),
    ...(invitation.grantRequests ? {
      grantRequests: invitation.grantRequests.map((request) => ({
        ...request,
        requestedGrants: normalizeMutableShareGrants(request.requestedGrants),
      })),
    } : {}),
  };
}

function sanitizeGrantRequestComment(comment: string | undefined): string | undefined {
  if (comment === undefined) return undefined;
  const sanitized = comment
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
    .slice(0, MAX_GRANT_REQUEST_COMMENT_LENGTH);
  return sanitized || undefined;
}

function verifyPassword(password: string, verifier: string): boolean {
  const [scheme, nRaw, rRaw, pRaw, salt, expected] = verifier.split(':');
  if (scheme !== PASSWORD_VERIFIER_SCHEME || !salt || !expected) return false;
  const N = Number.parseInt(nRaw ?? '', 10);
  const r = Number.parseInt(rRaw ?? '', 10);
  const p = Number.parseInt(pRaw ?? '', 10);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const actual = scryptSync(password, salt, PASSWORD_VERIFIER_KEY_LENGTH, { N, r, p }).toString('base64url');
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

export function isInvitationRecord(value: unknown): value is InvitationRecord {
  const invitation = value as Partial<InvitationRecord>;
  return typeof value === 'object'
    && value !== null
    && typeof invitation.invitationId === 'string'
    && typeof invitation.nodeId === 'string'
    && typeof invitation.subject === 'object'
    && invitation.subject !== null
    && Array.isArray(invitation.grants)
    && invitation.grants.every((grant) => typeof grant === 'string')
    && typeof invitation.grantId === 'string'
    && typeof invitation.tokenHash === 'string'
    && typeof invitation.createdAt === 'string'
    && typeof invitation.expiresAt === 'string'
    && typeof invitation.policyVersion === 'number'
    && (invitation.revokedAt === undefined || typeof invitation.revokedAt === 'string')
    && (invitation.acceptedAt === undefined || typeof invitation.acceptedAt === 'string')
    && (invitation.acceptedBy === undefined || typeof invitation.acceptedBy === 'string')
    && (invitation.memberTokenHash === undefined || typeof invitation.memberTokenHash === 'string')
    && (invitation.memberId === undefined || typeof invitation.memberId === 'string')
    && (invitation.memberDeviceId === undefined || typeof invitation.memberDeviceId === 'string')
    && (invitation.memberCsrfTokenHash === undefined || typeof invitation.memberCsrfTokenHash === 'string')
    && (
      invitation.controllerLease === undefined
      || (
        typeof invitation.controllerLease === 'object'
        && invitation.controllerLease !== null
        && typeof invitation.controllerLease.leaseId === 'string'
        && typeof invitation.controllerLease.deviceId === 'string'
        && typeof invitation.controllerLease.acquiredAt === 'string'
        && typeof invitation.controllerLease.expiresAt === 'string'
      )
    )
    && (invitation.shareId === undefined || typeof invitation.shareId === 'string')
    && (invitation.passwordVerifier === undefined || typeof invitation.passwordVerifier === 'string')
    && (invitation.failedAcceptCount === undefined || typeof invitation.failedAcceptCount === 'number')
    && (invitation.lockedUntil === undefined || typeof invitation.lockedUntil === 'string')
    && (invitation.redactedShareLabel === undefined || typeof invitation.redactedShareLabel === 'string')
    && (invitation.grantRequests === undefined || Array.isArray(invitation.grantRequests));
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
  private readonly nextSharePassword: (ttlMs: number) => string;
  private readonly onSave?: (invitation: InvitationRecord) => void;

  constructor(opts: InvitationStoreOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.tokenBytes = opts.tokenBytes ?? 24;
    this.defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.nextShareId = opts.shareId ?? issueShareId;
    this.nextSharePassword = opts.sharePassword
      ? () => opts.sharePassword!()
      : issueSharePassword;
    this.onSave = opts.onSave;
    for (const invitation of opts.initialInvitations ?? []) {
      const normalized = normalizeInvitationRecord(invitation);
      this.remember(normalized);
      this.policyVersion = Math.max(this.policyVersion, Number(invitation.policyVersion));
    }
  }

  private remember(invitation: InvitationRecord): void {
    this.invitations.set(invitation.invitationId, invitation);
    this.invitationTokenIndex.set(invitation.tokenHash, invitation.invitationId);
    if (invitation.shareId) this.shareIdIndex.set(invitation.shareId, invitation.invitationId);
    if (invitation.memberTokenHash) this.memberTokenIndex.set(invitation.memberTokenHash, invitation.invitationId);
  }

  private save(invitation: InvitationRecord): void {
    this.onSave?.(cloneInvitation(invitation));
    this.remember(invitation);
  }

  create(input: {
    nodeId: NodeId;
    subject?: ShareSubject;
    grants: ShareGrant[];
    ttlMs?: number;
    shareTicket?: boolean;
    displayLabel?: string;
  }): { invitation: InvitationRecord; token: string; shareTicket?: ShareTicketSecret } {
    const token = issueToken('kookr_inv_v1', this.tokenBytes);
    const invitationId = `inv-${randomUUID()}`;
    const grantId = asGrantId(`grant-${randomUUID()}`);
    const now = this.now();
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    const shareTicket = input.shareTicket ? this.createShareTicket(ttlMs) : undefined;
    this.policyVersion += 1;
    const invitation: InvitationRecord = {
      invitationId,
      nodeId: input.nodeId,
      subject: input.subject ?? { kind: 'node', nodeId: input.nodeId },
      grants: normalizeShareGrants(input.grants),
      grantId,
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      ...(shareTicket ? {
        shareId: shareTicket.shareId,
        passwordVerifier: createPasswordVerifier(shareTicket.password),
        failedAcceptCount: 0,
        redactedShareLabel: input.displayLabel ?? shareTicket.redactedShareLabel,
      } : {}),
      policyVersion: asPolicyVersion(this.policyVersion),
    };
    this.save(invitation);
    return { invitation: cloneInvitation(invitation), token, ...(shareTicket ? { shareTicket } : {}) };
  }

  accept(token: string, acceptedBy?: string, deviceId?: string): InvitationAcceptResult {
    const invitationId = this.invitationTokenIndex.get(hashToken(token));
    if (!invitationId) return { ok: false, reason: 'not-found' };
    return this.acceptByInvitationId(invitationId, acceptedBy, deviceId);
  }

  acceptTicket(shareId: string, password: string, acceptedBy?: string, deviceId?: string): InvitationAcceptResult {
    const normalizedShareId = normalizeShareId(shareId);
    if (!normalizedShareId || !password) return { ok: false, reason: 'not-found' };
    const invitationId = this.shareIdIndex.get(normalizedShareId);
    if (!invitationId) return { ok: false, reason: 'not-found' };
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    const nowMs = this.now().getTime();
    const lockedUntilMs = invitation.lockedUntil ? Date.parse(invitation.lockedUntil) : Number.NaN;
    if (Number.isFinite(lockedUntilMs) && lockedUntilMs > nowMs) {
      return { ok: false, reason: 'locked' };
    }
    const decayedFailures = Number.isFinite(lockedUntilMs) && lockedUntilMs <= nowMs
      ? 0
      : (invitation.failedAcceptCount ?? 0);
    if (!invitation.passwordVerifier || !verifyPassword(password, invitation.passwordVerifier)) {
      const failedAcceptCount = decayedFailures + 1;
      const lockedUntil = failedAcceptCount >= SHARE_TICKET_MAX_FAILED_ATTEMPTS
        ? new Date(this.now().getTime() + SHARE_TICKET_LOCKOUT_MS).toISOString()
        : undefined;
      const { lockedUntil: _previousLockedUntil, ...unlockedInvitation } = invitation;
      this.save({
        ...unlockedInvitation,
        failedAcceptCount,
        ...(lockedUntil ? { lockedUntil } : {}),
      });
      return { ok: false, reason: lockedUntil ? 'locked' : 'invalid-password' };
    }
    return this.acceptByInvitationId(invitationId, acceptedBy, deviceId);
  }

  resetShareTicket(invitationId: string): { ok: true; invitation: InvitationRecord; shareTicket: ShareTicketSecret } | { ok: false; reason: 'not-found' | 'not-share-ticket' } {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    if (!invitation.shareId) return { ok: false, reason: 'not-share-ticket' };
    const remainingTtlMs = Math.max(0, Date.parse(invitation.expiresAt) - this.now().getTime());
    const password = this.nextSharePassword(remainingTtlMs);
    const { lockedUntil: _lockedUntil, ...unlockedInvitation } = invitation;
    const updated: InvitationRecord = {
      ...unlockedInvitation,
      passwordVerifier: createPasswordVerifier(password),
      failedAcceptCount: 0,
    };
    this.save(updated);
    return {
      ok: true,
      invitation: cloneInvitation(updated),
      shareTicket: {
        shareId: invitation.shareId,
        password,
        redactedShareLabel: invitation.redactedShareLabel ?? redactShareId(invitation.shareId),
      },
    };
  }

  private acceptByInvitationId(invitationId: string, acceptedBy?: string, deviceId?: string): InvitationAcceptResult {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    if (invitation.revokedAt) return { ok: false, reason: 'revoked' };
    if (invitation.acceptedAt) return { ok: false, reason: 'already-used' };
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) return { ok: false, reason: 'expired' };

    const memberToken = issueToken('kookr_member_v1', this.tokenBytes);
    const csrfToken = issueToken('kookr_csrf_v1', this.tokenBytes);
    const memberTokenHash = hashToken(memberToken);
    const accepted = {
      ...invitation,
      acceptedAt: this.now().toISOString(),
      ...(acceptedBy ? { acceptedBy } : {}),
      memberId: `member-${randomUUID()}`,
      memberDeviceId: deviceId ?? `device-${randomUUID()}`,
      memberTokenHash,
      memberCsrfTokenHash: hashToken(csrfToken),
    };
    this.save(accepted);
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
        invitation: cloneInvitation(accepted),
        memberToken,
        csrfToken,
        deviceId: accepted.memberDeviceId,
        policyGrant,
      },
    };
  }

  verifyMemberCsrfToken(invitationId: string, csrfToken: string): boolean {
    const invitation = this.invitations.get(invitationId);
    if (!invitation?.memberCsrfTokenHash) return false;
    const expected = Buffer.from(invitation.memberCsrfTokenHash);
    const actual = Buffer.from(hashToken(csrfToken));
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  ensureMemberBrowserSession(input: {
    invitationId: string;
    deviceId?: string;
    csrfToken?: string;
  }): MemberBrowserSessionResult {
    const invitation = this.invitations.get(input.invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    if (invitation.revokedAt) return { ok: false, reason: 'revoked' };
    if (!invitation.acceptedAt) return { ok: false, reason: 'not-accepted' };
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) return { ok: false, reason: 'expired' };

    const deviceId = input.deviceId || invitation.memberDeviceId || `device-${randomUUID()}`;
    const csrfTokenValid = input.csrfToken
      ? this.verifyMemberCsrfToken(invitation.invitationId, input.csrfToken)
      : false;
    const csrfToken = csrfTokenValid
      ? input.csrfToken!
      : issueToken('kookr_csrf_v1', this.tokenBytes);
    const needsSave = !invitation.memberDeviceId || !csrfTokenValid;
    const updated: InvitationRecord = {
      ...invitation,
      ...(invitation.memberDeviceId ? {} : { memberDeviceId: deviceId }),
      ...(csrfTokenValid ? {} : { memberCsrfTokenHash: hashToken(csrfToken) }),
    };
    if (needsSave) this.save(updated);
    return {
      ok: true,
      invitation: cloneInvitation(updated),
      csrfToken,
      deviceId,
    };
  }

  acquireControllerLease(input: {
    invitationId: string;
    deviceId: string;
    holderLabel?: string;
    ttlMs?: number;
    takeover?: boolean;
    projectionVersion?: number;
    policyVersion?: PolicyVersion;
  }): ControllerLeaseResult {
    const invitation = this.invitations.get(input.invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    if (invitation.revokedAt) return { ok: false, reason: 'revoked' };
    if (!invitation.acceptedAt) return { ok: false, reason: 'not-accepted' };
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) return { ok: false, reason: 'expired' };
    const now = this.now();
    const current = invitation.controllerLease;
    const currentActive = current && Date.parse(current.expiresAt) > now.getTime() ? current : undefined;
    if (currentActive && currentActive.deviceId !== input.deviceId && !input.takeover) {
      return { ok: false, reason: 'held-by-another-device', lease: { ...currentActive } };
    }
    const lease: ControllerLeaseRecord = {
      leaseId: `lease-${randomUUID()}`,
      deviceId: input.deviceId,
      ...(input.holderLabel ? { holderLabel: input.holderLabel.slice(0, 80) } : {}),
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + Math.max(1_000, input.ttlMs ?? 30_000)).toISOString(),
      ...(typeof input.projectionVersion === 'number' ? { projectionVersion: input.projectionVersion } : {}),
      ...(input.policyVersion !== undefined ? { policyVersion: input.policyVersion } : {}),
    };
    const updated = { ...invitation, controllerLease: lease };
    this.save(updated);
    return {
      ok: true,
      invitation: cloneInvitation(updated),
      lease: { ...lease },
      ...(currentActive ? { previousLease: { ...currentActive } } : {}),
    };
  }

  private createShareTicket(ttlMs: number): ShareTicketSecret {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const shareId = normalizeShareId(this.nextShareId());
      if (!shareId || this.shareIdIndex.has(shareId)) continue;
      const password = this.nextSharePassword(ttlMs);
      return { shareId, password, redactedShareLabel: redactShareId(shareId) };
    }
    throw new Error('failed to allocate unique share ID');
  }

  revoke(invitationId: string): InvitationRevokeResult {
    const invitation = this.invitations.get(invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    const alreadyRevoked = Boolean(invitation.revokedAt);
    let updated = invitation;
    if (!alreadyRevoked) {
      this.policyVersion += 1;
      updated = {
        ...invitation,
        revokedAt: this.now().toISOString(),
        policyVersion: asPolicyVersion(this.policyVersion),
      };
      this.save(updated);
    }
    return { ok: true, invitation: cloneInvitation(updated), alreadyRevoked };
  }

  requestGrants(input: {
    invitationId: string;
    requestedGrants: TaskShareMutableGrant[];
    requestedBy?: string;
    comment?: string;
  }): GrantRequestResult {
    const invitation = this.invitations.get(input.invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    if (invitation.revokedAt) return { ok: false, reason: 'revoked' };
    if (!invitation.acceptedAt) return { ok: false, reason: 'not-accepted' };
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) return { ok: false, reason: 'expired' };
    const requestedGrants = normalizeMutableShareGrants(input.requestedGrants).filter((grant) => !invitation.grants.includes(grant));
    if (requestedGrants.length === 0) return { ok: false, reason: 'empty-grants' };
    const request: TaskShareGrantRequest = {
      requestId: `grant-req-${randomUUID()}`,
      invitationId: input.invitationId,
      requestedGrants,
      status: 'pending',
      requestedAt: this.now().toISOString(),
      ...(input.requestedBy ? { requestedBy: input.requestedBy } : {}),
      ...(sanitizeGrantRequestComment(input.comment) ? { comment: sanitizeGrantRequestComment(input.comment) } : {}),
    };
    const updated = {
      ...invitation,
      grantRequests: [...(invitation.grantRequests ?? []), request],
    };
    this.save(updated);
    return { ok: true, invitation: cloneInvitation(updated), request: { ...request, requestedGrants: [...request.requestedGrants] } };
  }

  resolveGrantRequest(input: {
    invitationId: string;
    requestId: string;
    approve: boolean;
  }): GrantRequestResult {
    const invitation = this.invitations.get(input.invitationId);
    if (!invitation) return { ok: false, reason: 'not-found' };
    if (invitation.revokedAt) return { ok: false, reason: 'revoked' };
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) return { ok: false, reason: 'expired' };
    const requests = invitation.grantRequests ?? [];
    const request = requests.find((candidate) => candidate.requestId === input.requestId);
    if (!request) return { ok: false, reason: 'not-found' };
    if (request.status !== 'pending') return { ok: false, reason: 'already-resolved' };
    const resolvedRequest: TaskShareGrantRequest = {
      ...request,
      status: input.approve ? 'approved' : 'denied',
      resolution: input.approve ? 'approved' : 'denied',
      resolvedAt: this.now().toISOString(),
    };
    const nextGrants = input.approve
      ? normalizeShareGrants([...invitation.grants, ...request.requestedGrants])
      : invitation.grants;
    if (input.approve) this.policyVersion += 1;
    const updated: InvitationRecord = {
      ...invitation,
      grants: nextGrants,
      grantRequests: requests.map((candidate) => candidate.requestId === input.requestId ? resolvedRequest : candidate),
      ...(input.approve ? { policyVersion: asPolicyVersion(this.policyVersion) } : {}),
    };
    this.save(updated);
    return { ok: true, invitation: cloneInvitation(updated), request: { ...resolvedRequest, requestedGrants: [...resolvedRequest.requestedGrants] } };
  }

  authenticateMember(token: string): InvitationRecord | null {
    const invitationId = this.memberTokenIndex.get(hashToken(token));
    if (!invitationId) return null;
    const invitation = this.invitations.get(invitationId);
    if (!invitation || !invitation.acceptedAt || invitation.revokedAt) return null;
    if (Date.parse(invitation.expiresAt) <= this.now().getTime()) return null;
    return cloneInvitation(invitation);
  }

  findByMemberToken(token: string): InvitationRecord | null {
    const invitationId = this.memberTokenIndex.get(hashToken(token));
    if (!invitationId) return null;
    const invitation = this.invitations.get(invitationId);
    if (!invitation || !invitation.acceptedAt) return null;
    // Status pages need to render revoked/expired share state instead of treating the member token as unknown.
    return cloneInvitation(invitation);
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
    return [...this.invitations.values()].map(cloneInvitation);
  }
}
