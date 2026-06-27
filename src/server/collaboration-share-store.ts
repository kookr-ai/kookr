import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { atomicWriteFile, readJsonFile } from '../core/persistence-utils.js';
import { isSharedTaskId } from '../shared/contracts/contact-share.js';
import {
  COLLABORATION_CONTACT_SHARE_INVITE_SCHEMA_VERSION,
  type CollaborationContactShareInviteDirection,
  type CollaborationContactShareInvite,
  type CollaborationContactShareInviteStatus,
  type CollaborationGrantCapability,
  type CollaborationGrantRecord,
  type CollaborationGrantRevocationTombstone,
  type CollaborationPrincipal,
  type CollaborationSharedTaskRemoval,
  type CreateCollaborationContactShareInviteRequest,
  type DecideCollaborationContactShareRequest,
} from '../shared/contracts/collaboration-share.js';
import type { VerifiedDevicePrincipal } from '../shared/contracts/collaboration-pairing.js';
import { CollaborationAuditLog } from './collaboration-audit-log.js';

const COLLABORATION_SHARE_STORE_VERSION = 1;

type CollaborationShareAuditKind =
  | 'share.sent'
  | 'share.accepted'
  | 'share.declined'
  | 'share.revoked';

export interface ActiveCollaborationTaskShare {
  invite: CollaborationContactShareInvite;
  grant: CollaborationGrantRecord;
}

interface CollaborationShareStoreFile {
  version: number;
  policyVersion: number;
  invites: CollaborationContactShareInvite[];
  grants: CollaborationGrantRecord[];
  tombstones: CollaborationGrantRevocationTombstone[];
}

function emptyStoreFile(): CollaborationShareStoreFile {
  return { version: COLLABORATION_SHARE_STORE_VERSION, policyVersion: 0, invites: [], grants: [], tombstones: [] };
}

export class CollaborationShareError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseDateMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clonePrincipal(principal: CollaborationPrincipal): CollaborationPrincipal {
  return { ...principal };
}

function cloneInvite(invite: CollaborationContactShareInvite): CollaborationContactShareInvite {
  return {
    ...invite,
    principal: clonePrincipal(invite.principal),
    subject: { ...invite.subject },
    capabilities: [...invite.capabilities],
  };
}

function cloneGrant(grant: CollaborationGrantRecord): CollaborationGrantRecord {
  return {
    ...grant,
    principal: clonePrincipal(grant.principal),
    subject: { ...grant.subject },
    capabilities: [...grant.capabilities],
  };
}

function cloneTombstone(tombstone: CollaborationGrantRevocationTombstone): CollaborationGrantRevocationTombstone {
  return {
    ...tombstone,
    principal: clonePrincipal(tombstone.principal),
    subject: { ...tombstone.subject },
    capabilities: [...tombstone.capabilities],
  };
}

function samePrincipal(a: CollaborationPrincipal, b: CollaborationPrincipal): boolean {
  return a.kind === b.kind && a.contactId === b.contactId && a.deviceId === b.deviceId;
}

function allowedRequestKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function normalizeCapabilities(value: unknown): CollaborationGrantCapability[] | null {
  if (value === undefined) return ['viewTask'];
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((capability) => capability === 'viewTask') ? ['viewTask'] : null;
}

function parseInviteRequest(value: unknown): CreateCollaborationContactShareInviteRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!allowedRequestKeys(row, ['taskId', 'expiresAt', 'capabilities'])) return null;
  const taskId = normalizeString(row.taskId);
  if (!taskId || isSharedTaskId(taskId)) return null;
  const expiresAt = row.expiresAt === undefined ? undefined : normalizeString(row.expiresAt);
  if (row.expiresAt !== undefined && !expiresAt) return null;
  const capabilities = normalizeCapabilities(row.capabilities);
  if (!capabilities) return null;
  return {
    taskId,
    ...(expiresAt ? { expiresAt } : {}),
    capabilities,
  };
}

function parseDecisionRequest(value: unknown): DecideCollaborationContactShareRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!allowedRequestKeys(row, ['inviteId', 'decision'])) return null;
  const inviteId = normalizeString(row.inviteId);
  const decision = row.decision === 'accept' || row.decision === 'decline' || row.decision === 'revoke'
    ? row.decision
    : null;
  if (!inviteId || !decision) return null;
  return { inviteId, decision };
}

function normalizePrincipal(value: unknown): CollaborationPrincipal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const contactId = normalizeString(row.contactId);
  const deviceId = normalizeString(row.deviceId);
  return row.kind === 'contact-device' && contactId && deviceId
    ? { kind: 'contact-device', contactId, deviceId }
    : null;
}

function normalizeInvite(value: unknown): CollaborationContactShareInvite | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const inviteId = normalizeString(row.inviteId);
  const principal = normalizePrincipal(row.principal);
  const direction = normalizeInviteDirection(row.direction);
  const subject = row.subject && typeof row.subject === 'object' && !Array.isArray(row.subject)
    ? row.subject as Record<string, unknown>
    : null;
  const taskId = normalizeString(subject?.taskId);
  const capabilities = normalizeCapabilities(row.capabilities);
  const status = normalizeInviteStatus(row.status);
  const createdAt = normalizeString(row.createdAt);
  const updatedAt = normalizeString(row.updatedAt);
  const expiresAt = normalizeString(row.expiresAt);
  const grantId = normalizeString(row.grantId);
  if (
    row.schemaVersion !== COLLABORATION_CONTACT_SHARE_INVITE_SCHEMA_VERSION
    || !inviteId
    || !direction
    || !principal
    || subject?.kind !== 'task'
    || !taskId
    || !capabilities
    || !status
    || !createdAt
    || !updatedAt
  ) {
    return null;
  }
  return {
    schemaVersion: COLLABORATION_CONTACT_SHARE_INVITE_SCHEMA_VERSION,
    inviteId,
    direction,
    principal,
    subject: { kind: 'task', taskId },
    capabilities,
    status,
    createdAt,
    updatedAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(grantId ? { grantId } : {}),
  };
}

function normalizeInviteStatus(value: unknown): CollaborationContactShareInviteStatus | null {
  return value === 'pending'
    || value === 'accepted'
    || value === 'declined'
    || value === 'revoked'
    || value === 'expired'
    ? value
    : null;
}

function normalizeInviteDirection(value: unknown): CollaborationContactShareInviteDirection | null {
  return value === 'inbound' || value === 'outbound' ? value : null;
}

function normalizeGrant(value: unknown): CollaborationGrantRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const grantId = normalizeString(row.grantId);
  const principal = normalizePrincipal(row.principal);
  const subject = row.subject && typeof row.subject === 'object' && !Array.isArray(row.subject)
    ? row.subject as Record<string, unknown>
    : null;
  const taskId = normalizeString(subject?.taskId);
  const capabilities = normalizeCapabilities(row.capabilities);
  const createdAt = normalizeString(row.createdAt);
  const expiresAt = normalizeString(row.expiresAt);
  const revokedAt = normalizeString(row.revokedAt);
  if (
    !grantId
    || !principal
    || subject?.kind !== 'task'
    || !taskId
    || !capabilities
    || typeof row.policyVersion !== 'number'
    || !Number.isInteger(row.policyVersion)
    || row.policyVersion < 1
    || !createdAt
  ) {
    return null;
  }
  return {
    grantId,
    principal,
    subject: { kind: 'task', taskId },
    capabilities,
    policyVersion: row.policyVersion,
    createdAt,
    ...(expiresAt ? { expiresAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

function normalizeTombstone(value: unknown): CollaborationGrantRevocationTombstone | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const tombstoneId = normalizeString(row.tombstoneId);
  const principal = normalizePrincipal(row.principal);
  const subject = row.subject && typeof row.subject === 'object' && !Array.isArray(row.subject)
    ? row.subject as Record<string, unknown>
    : null;
  const taskId = normalizeString(subject?.taskId);
  const capabilities = normalizeCapabilities(row.capabilities);
  const revokedAt = normalizeString(row.revokedAt);
  const inviteId = normalizeString(row.inviteId);
  const grantId = normalizeString(row.grantId);
  if (
    !tombstoneId
    || !principal
    || subject?.kind !== 'task'
    || !taskId
    || !capabilities
    || typeof row.policyVersion !== 'number'
    || !Number.isInteger(row.policyVersion)
    || row.policyVersion < 1
    || !revokedAt
  ) {
    return null;
  }
  return {
    tombstoneId,
    principal,
    subject: { kind: 'task', taskId },
    capabilities,
    policyVersion: row.policyVersion,
    revokedAt,
    ...(inviteId ? { inviteId } : {}),
    ...(grantId ? { grantId } : {}),
  };
}

function normalizeStoreFile(raw: unknown): CollaborationShareStoreFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyStoreFile();
  }
  const row = raw as Record<string, unknown>;
  if (row.version !== COLLABORATION_SHARE_STORE_VERSION) {
    // Unknown envelopes may have different trust-state semantics; fail closed instead of partially interpreting them.
    return emptyStoreFile();
  }
  const invites = Array.isArray(row.invites) ? row.invites.flatMap((invite) => {
    const normalized = normalizeInvite(invite);
    return normalized ? [normalized] : [];
  }) : [];
  const grants = Array.isArray(row.grants) ? row.grants.flatMap((grant) => {
    const normalized = normalizeGrant(grant);
    return normalized ? [normalized] : [];
  }) : [];
  const tombstones = Array.isArray(row.tombstones) ? row.tombstones.flatMap((tombstone) => {
    const normalized = normalizeTombstone(tombstone);
    return normalized ? [normalized] : [];
  }) : [];
  const policyVersion = typeof row.policyVersion === 'number' && Number.isInteger(row.policyVersion) && row.policyVersion >= 0
    ? row.policyVersion
    : Math.max(0, ...grants.map((grant) => grant.policyVersion), ...tombstones.map((tombstone) => tombstone.policyVersion));
  return { version: COLLABORATION_SHARE_STORE_VERSION, policyVersion, invites, grants, tombstones };
}

export class CollaborationShareStore {
  private readonly filePath: string | null;
  private readonly auditLog: CollaborationAuditLog | null;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private readonly taskExists: (taskId: string) => boolean;
  private policyVersion = 0;
  private invites = new Map<string, CollaborationContactShareInvite>();
  private grants = new Map<string, CollaborationGrantRecord>();
  private tombstones = new Map<string, CollaborationGrantRevocationTombstone>();

  constructor(opts: {
    kookrDir?: string;
    filePath?: string;
    auditPath?: string;
    auditLog?: CollaborationAuditLog | null;
    now?: () => Date;
    idGenerator?: () => string;
    taskExists?: (taskId: string) => boolean;
  } = {}) {
    this.filePath = opts.filePath ?? (opts.kookrDir ? join(opts.kookrDir, 'collaboration-shares.json') : null);
    this.now = opts.now ?? (() => new Date());
    this.idGenerator = opts.idGenerator ?? (() => randomUUID());
    this.taskExists = opts.taskExists ?? (() => true);
    this.auditLog = opts.auditLog === undefined
      ? new CollaborationAuditLog({
          filePath: opts.auditPath ?? (opts.kookrDir ? join(opts.kookrDir, 'collaboration-audit.jsonl') : null),
          now: this.now,
          idGenerator: this.idGenerator,
        })
      : opts.auditLog;
  }

  async load(): Promise<void> {
    if (!this.filePath) return;
    const loaded = normalizeStoreFile(await readJsonFile<unknown>(this.filePath, null));
    this.policyVersion = loaded.policyVersion;
    this.invites = new Map(loaded.invites.map((invite) => [invite.inviteId, cloneInvite(invite)]));
    this.grants = new Map(loaded.grants.map((grant) => [grant.grantId, cloneGrant(grant)]));
    this.tombstones = new Map(loaded.tombstones.map((tombstone) => [tombstone.tombstoneId, cloneTombstone(tombstone)]));
  }

  async receiveInvite(
    verified: VerifiedDevicePrincipal,
    raw: unknown,
  ): Promise<CollaborationContactShareInvite> {
    return this.createInvite(verified, raw, 'inbound');
  }

  async createOutboundInvite(
    verified: VerifiedDevicePrincipal,
    raw: unknown,
  ): Promise<CollaborationContactShareInvite> {
    return this.createInvite(verified, raw, 'outbound');
  }

  private async createInvite(
    verified: VerifiedDevicePrincipal,
    raw: unknown,
    direction: CollaborationContactShareInviteDirection,
  ): Promise<CollaborationContactShareInvite> {
    const request = parseInviteRequest(raw);
    if (!request) throw new CollaborationShareError('invalid-contact-share-invite', 400);
    const now = this.now();
    if (request.expiresAt) {
      const expiresAtMs = parseDateMs(request.expiresAt);
      if (!expiresAtMs || expiresAtMs <= now.getTime()) {
        throw new CollaborationShareError('invalid-contact-share-expiry', 400);
      }
    }
    if (direction === 'outbound' && !this.taskExists(request.taskId)) {
      throw new CollaborationShareError('task-not-found', 404);
    }

    const timestamp = now.toISOString();
    const invite: CollaborationContactShareInvite = {
      schemaVersion: COLLABORATION_CONTACT_SHARE_INVITE_SCHEMA_VERSION,
      inviteId: `collab-invite-${this.idGenerator()}`,
      direction,
      principal: { kind: 'contact-device', contactId: verified.contactId, deviceId: verified.deviceId },
      subject: { kind: 'task', taskId: request.taskId },
      capabilities: ['viewTask'],
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    };
    this.invites.set(invite.inviteId, cloneInvite(invite));
    await this.save();
    await this.appendAudit('share.sent', {
      inviteId: invite.inviteId,
      contactId: verified.contactId,
      deviceId: verified.deviceId,
      taskId: invite.subject.taskId,
    });
    return cloneInvite(invite);
  }

  async decide(
    verified: VerifiedDevicePrincipal,
    raw: unknown,
  ): Promise<{
    invite: CollaborationContactShareInvite;
    grant?: CollaborationGrantRecord;
    tombstone?: CollaborationGrantRevocationTombstone;
  }> {
    const request = parseDecisionRequest(raw);
    if (!request) throw new CollaborationShareError('invalid-contact-share-decision', 400);
    const invite = this.invites.get(request.inviteId);
    if (!invite) throw new CollaborationShareError('contact-share-invite-not-found', 404);
    const principal: CollaborationPrincipal = { kind: 'contact-device', contactId: verified.contactId, deviceId: verified.deviceId };
    if (!samePrincipal(invite.principal, principal)) {
      throw new CollaborationShareError('contact-share-principal-mismatch', 403);
    }
    if (this.expireInviteIfNeeded(invite)) {
      await this.save();
      throw new CollaborationShareError('contact-share-invite-expired', 410);
    }

    switch (request.decision) {
      case 'accept':
        return this.acceptInvite(invite);
      case 'decline':
        return this.declineInvite(invite);
      case 'revoke':
        return this.revokeInvite(invite);
    }
  }

  getGrant(grantId: string): CollaborationGrantRecord | undefined {
    const grant = this.grants.get(grantId);
    if (!grant || grant.revokedAt || this.isGrantTombstoned(grant) || this.isExpired(grant.expiresAt)) return undefined;
    return cloneGrant(grant);
  }

  listActiveTaskSharesForPrincipal(principal: VerifiedDevicePrincipal): ActiveCollaborationTaskShare[] {
    const normalized: CollaborationPrincipal = {
      kind: 'contact-device',
      contactId: principal.contactId,
      deviceId: principal.deviceId,
    };
    return [...this.invites.values()].flatMap((invite) => {
      if (
        invite.direction !== 'outbound'
        || invite.status !== 'accepted'
        || !invite.grantId
        || !samePrincipal(invite.principal, normalized)
      ) {
        return [];
      }
      const grant = this.getGrant(invite.grantId);
      if (!grant || !grant.capabilities.includes('viewTask')) return [];
      return [{ invite: cloneInvite(invite), grant }];
    });
  }

  listRemovedTaskSharesForPrincipal(principal: VerifiedDevicePrincipal): CollaborationSharedTaskRemoval[] {
    const normalized: CollaborationPrincipal = {
      kind: 'contact-device',
      contactId: principal.contactId,
      deviceId: principal.deviceId,
    };
    return [...this.invites.values()].flatMap<CollaborationSharedTaskRemoval>((invite) => {
      if (
        invite.direction !== 'outbound'
        || !samePrincipal(invite.principal, normalized)
      ) {
        return [];
      }
      const tombstone = this.tombstoneForInvite(invite);
      if (tombstone) {
        const removal: CollaborationSharedTaskRemoval = {
          inviteId: invite.inviteId,
          reason: 'revoked',
          policyVersion: tombstone.policyVersion,
          removedAt: tombstone.revokedAt,
        };
        return [removal];
      }
      if (!invite.grantId) return [];
      const grant = this.grants.get(invite.grantId);
      if (grant && this.isExpired(grant.expiresAt)) {
        const removal: CollaborationSharedTaskRemoval = {
          inviteId: invite.inviteId,
          reason: 'expired',
          policyVersion: grant.policyVersion,
          removedAt: grant.expiresAt,
        };
        return [removal];
      }
      return [];
    });
  }

  listTombstones(): CollaborationGrantRevocationTombstone[] {
    return [...this.tombstones.values()].map(cloneTombstone);
  }

  diagnostics(): {
    pendingInvites: number;
    activeGrants: number;
    expiredGrants: number;
    revokedShares: number;
    tombstones: number;
  } {
    const grants = [...this.grants.values()];
    return {
      pendingInvites: [...this.invites.values()].filter((invite) => invite.status === 'pending').length,
      activeGrants: grants.filter((grant) => this.getGrant(grant.grantId)).length,
      expiredGrants: grants.filter((grant) => this.isExpired(grant.expiresAt)).length,
      revokedShares: [...this.invites.values()].filter((invite) => invite.status === 'revoked').length,
      tombstones: this.tombstones.size,
    };
  }

  private async acceptInvite(invite: CollaborationContactShareInvite): Promise<{ invite: CollaborationContactShareInvite; grant: CollaborationGrantRecord }> {
    if (this.isInviteTombstoned(invite) || invite.status === 'revoked') {
      throw new CollaborationShareError('contact-share-revoked', 410);
    }
    if (invite.direction === 'inbound') throw new CollaborationShareError('contact-share-grant-not-local', 409);
    if (invite.status === 'declined') throw new CollaborationShareError('contact-share-declined', 409);
    if (invite.status === 'accepted' && invite.grantId) {
      const existing = this.grants.get(invite.grantId);
      if (existing && !existing.revokedAt && !this.isGrantTombstoned(existing) && !this.isExpired(existing.expiresAt)) {
        return { invite: cloneInvite(invite), grant: cloneGrant(existing) };
      }
      if (existing && this.isExpired(existing.expiresAt)) throw new CollaborationShareError('contact-share-invite-expired', 410);
      throw new CollaborationShareError('contact-share-revoked', 410);
    }
    if (invite.status !== 'pending') throw new CollaborationShareError('contact-share-not-acceptable', 409);

    const now = this.now().toISOString();
    const grant: CollaborationGrantRecord = {
      grantId: `collab-grant-${this.idGenerator()}`,
      principal: clonePrincipal(invite.principal),
      subject: { ...invite.subject },
      capabilities: ['viewTask'],
      policyVersion: this.nextPolicyVersion(),
      createdAt: now,
      ...(invite.expiresAt ? { expiresAt: invite.expiresAt } : {}),
    };
    invite.status = 'accepted';
    invite.updatedAt = now;
    invite.grantId = grant.grantId;
    this.grants.set(grant.grantId, cloneGrant(grant));
    await this.save();
    await this.appendAudit('share.accepted', this.auditDetail(invite, grant.grantId, grant.policyVersion));
    return { invite: cloneInvite(invite), grant: cloneGrant(grant) };
  }

  private async declineInvite(invite: CollaborationContactShareInvite): Promise<{ invite: CollaborationContactShareInvite }> {
    if (invite.status === 'accepted') throw new CollaborationShareError('contact-share-already-accepted', 409);
    if (invite.status === 'revoked' || this.isInviteTombstoned(invite)) {
      throw new CollaborationShareError('contact-share-revoked', 410);
    }
    if (invite.status === 'declined') return { invite: cloneInvite(invite) };
    const now = this.now().toISOString();
    invite.status = 'declined';
    invite.updatedAt = now;
    await this.save();
    await this.appendAudit('share.declined', this.auditDetail(invite));
    return { invite: cloneInvite(invite) };
  }

  private async revokeInvite(invite: CollaborationContactShareInvite): Promise<{
    invite: CollaborationContactShareInvite;
    tombstone: CollaborationGrantRevocationTombstone;
  }> {
    const existing = this.tombstoneForInvite(invite);
    if (existing) return { invite: cloneInvite(invite), tombstone: cloneTombstone(existing) };

    const now = this.now().toISOString();
    const grant = invite.grantId ? this.grants.get(invite.grantId) : undefined;
    const policyVersion = this.nextPolicyVersion();
    if (grant) {
      grant.revokedAt = now;
      grant.policyVersion = policyVersion;
    }
    invite.status = 'revoked';
    invite.updatedAt = now;
    const tombstone: CollaborationGrantRevocationTombstone = {
      tombstoneId: `collab-tombstone-${this.idGenerator()}`,
      principal: clonePrincipal(invite.principal),
      subject: { ...invite.subject },
      capabilities: ['viewTask'],
      policyVersion,
      revokedAt: now,
      inviteId: invite.inviteId,
      ...(invite.grantId ? { grantId: invite.grantId } : {}),
    };
    this.tombstones.set(tombstone.tombstoneId, cloneTombstone(tombstone));
    await this.save();
    await this.appendAudit('share.revoked', this.auditDetail(invite, invite.grantId, policyVersion));
    return { invite: cloneInvite(invite), tombstone: cloneTombstone(tombstone) };
  }

  private expireInviteIfNeeded(invite: CollaborationContactShareInvite): boolean {
    if (invite.status !== 'pending' || !invite.expiresAt) return false;
    const expiresAtMs = parseDateMs(invite.expiresAt);
    if (!expiresAtMs || expiresAtMs > this.now().getTime()) return false;
    invite.status = 'expired';
    invite.updatedAt = this.now().toISOString();
    return true;
  }

  private isExpired(expiresAt: string | undefined): boolean {
    if (!expiresAt) return false;
    const expiresAtMs = parseDateMs(expiresAt);
    return !expiresAtMs || expiresAtMs <= this.now().getTime();
  }

  private isInviteTombstoned(invite: CollaborationContactShareInvite): boolean {
    return Boolean(this.tombstoneForInvite(invite));
  }

  private tombstoneForInvite(invite: CollaborationContactShareInvite): CollaborationGrantRevocationTombstone | undefined {
    return [...this.tombstones.values()].find((tombstone) => (
      tombstone.inviteId === invite.inviteId
      || Boolean(invite.grantId && tombstone.grantId === invite.grantId)
    ));
  }

  private isGrantTombstoned(grant: CollaborationGrantRecord): boolean {
    return [...this.tombstones.values()].some((tombstone) => (
      tombstone.grantId === grant.grantId
    ));
  }

  private nextPolicyVersion(): number {
    this.policyVersion += 1;
    return this.policyVersion;
  }

  private async save(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    const data: CollaborationShareStoreFile = {
      version: COLLABORATION_SHARE_STORE_VERSION,
      policyVersion: this.policyVersion,
      invites: [...this.invites.values()].map(cloneInvite),
      grants: [...this.grants.values()].map(cloneGrant),
      tombstones: [...this.tombstones.values()].map(cloneTombstone),
    };
    await atomicWriteFile(this.filePath, JSON.stringify(data, null, 2));
  }

  private auditDetail(invite: CollaborationContactShareInvite, grantId?: string, policyVersion?: number): Record<string, unknown> {
    return {
      inviteId: invite.inviteId,
      contactId: invite.principal.contactId,
      deviceId: invite.principal.deviceId,
      taskId: invite.subject.taskId,
      ...(grantId ? { grantId } : {}),
      ...(policyVersion ? { policyVersion } : {}),
    };
  }

  private async appendAudit(kind: CollaborationShareAuditKind, detail: Record<string, unknown>): Promise<void> {
    if (!this.auditLog) return;
    const event = kind === 'share.declined' ? 'share.refused' : kind;
    await this.auditLog.append({
      actor: {
        kind: 'contact-device',
        contactId: String(detail.contactId),
        deviceId: String(detail.deviceId),
      },
      event,
      taskId: typeof detail.taskId === 'string' ? detail.taskId : undefined,
      shareId: typeof detail.inviteId === 'string' ? detail.inviteId : undefined,
      grantId: typeof detail.grantId === 'string' ? detail.grantId : undefined,
      policyVersion: typeof detail.policyVersion === 'number' ? detail.policyVersion : undefined,
      decision: kind === 'share.declined' ? 'denied' : 'allowed',
    });
  }
}
