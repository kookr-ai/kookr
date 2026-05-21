import { mkdir } from 'node:fs/promises';
import { createHash, createPublicKey, createVerify, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { atomicWriteFile, readJsonFile } from '../core/persistence-utils.js';
import {
  COLLABORATION_DEVICE_AUTH_SCHEMA_VERSION,
  COLLABORATION_PAIRING_ACCEPT_SCHEMA_VERSION,
  COLLABORATION_PAIRING_OFFER_SCHEMA_VERSION,
  type AcceptPairingOfferRequest,
  type AcceptPairingOfferResponse,
  type ContactDeviceIdentity,
  type ContactIdentity,
  type CreatePairingOfferRequest,
  type CreatePairingOfferResponse,
  type PendingPairingVerification,
  type VerifyPairingResult,
  type VerifiedDevicePrincipal,
} from '../shared/contracts/collaboration-pairing.js';
import { CollaborationAuditLog } from './collaboration-audit-log.js';

const CONTACT_IDENTITY_STORE_VERSION = 1;
const MAX_PAIRING_TTL_MS = 30 * 60 * 1000;
const DEVICE_AUTH_MAX_SKEW_MS = 5 * 60 * 1000;

type PairingStatus = 'pending' | 'accepted' | 'verified' | 'expired' | 'rejected';
type PairingAuditEventKind =
  | 'pairing.created'
  | 'pairing.rejected'
  | 'pairing.accepted'
  | 'pairing.verified'
  | 'pairing.expired'
  | 'pairing.revoked';

interface PairingAuditDetail {
  pairingId?: string;
  contactId?: string;
  deviceId?: string;
  reason?: string;
  label?: string;
  expiresAt?: string;
  revokedAt?: string;
  verifiedFingerprint?: string;
}

interface PairingPartyMaterial {
  publicKey: string;
  nonce: string;
  commitment: string;
  expiresAt: string;
  label: string;
}

interface StoredPairingOffer extends PairingPartyMaterial {
  pairingId: string;
  createdAt: string;
  status: PairingStatus;
  accept?: PairingPartyMaterial;
  verifiedFingerprint?: string;
  verificationCode?: string;
  acceptedAt?: string;
  verifiedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
}

interface AcceptedAuthNonce {
  contactId: string;
  deviceId: string;
  nonce: string;
  acceptedAt: string;
  expiresAt: string;
}

interface ContactIdentityStoreFile {
  version: number;
  contacts: ContactIdentity[];
  pairingOffers: StoredPairingOffer[];
  acceptedAuthNonces: AcceptedAuthNonce[];
}

interface DeviceAuthInput {
  contactId?: string;
  deviceId?: string;
  audience: string;
  method: string;
  path: string;
  query?: string;
  bodySha256: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
}

export class CollaborationPairingError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message = code,
  ) {
    super(message);
  }
}

function cloneDevice(device: ContactDeviceIdentity): ContactDeviceIdentity {
  return { ...device };
}

function cloneContact(contact: ContactIdentity): ContactIdentity {
  return {
    ...contact,
    devices: contact.devices.map(cloneDevice),
  };
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseDateMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidPublicKey(publicKey: string): boolean {
  try {
    createPublicKey(publicKey);
    return true;
  } catch {
    return false;
  }
}

function hashHex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function idFromPublicKey(prefix: string, publicKey: string): string {
  return `${prefix}-${createHash('sha256').update(publicKey).digest('base64url').slice(0, 24)}`;
}

function fingerprintForPairing(offer: PairingPartyMaterial, accept: PairingPartyMaterial): string {
  const digest = hashHex({
    schemaVersion: 'collaboration-pairing-fingerprint.v1',
    offer: {
      publicKey: offer.publicKey,
      nonce: offer.nonce,
      commitment: offer.commitment,
      expiresAt: offer.expiresAt,
      label: offer.label,
    },
    accept: {
      publicKey: accept.publicKey,
      nonce: accept.nonce,
      commitment: accept.commitment,
      expiresAt: accept.expiresAt,
      label: accept.label,
    },
  });
  return digest.slice(0, 32).match(/.{1,4}/g)?.join('-') ?? digest.slice(0, 32);
}

function verificationCodeForFingerprint(fingerprint: string): string {
  const digits = BigInt(`0x${fingerprint.replaceAll('-', '').slice(0, 12)}`).toString().padStart(6, '0');
  return digits.slice(-6);
}

function allowedRequestKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function parsePairingOfferRequest(value: unknown): CreatePairingOfferRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!allowedRequestKeys(row, ['publicKey', 'nonce', 'commitment', 'expiresAt', 'label'])) return null;
  const publicKey = normalizeString(row.publicKey);
  const nonce = normalizeString(row.nonce);
  const commitment = normalizeString(row.commitment);
  const expiresAt = normalizeString(row.expiresAt);
  const label = normalizeString(row.label);
  if (!publicKey || !nonce || !commitment || !expiresAt || !label || !isValidPublicKey(publicKey)) return null;
  return { publicKey, nonce, commitment, expiresAt, label };
}

function parseAcceptPairingRequest(value: unknown): AcceptPairingOfferRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!allowedRequestKeys(row, [
    'pairingId',
    'publicKey',
    'nonce',
    'commitment',
    'expiresAt',
    'label',
  ])) return null;
  const pairingId = normalizeString(row.pairingId);
  const publicKey = normalizeString(row.publicKey);
  const nonce = normalizeString(row.nonce);
  const commitment = normalizeString(row.commitment);
  const expiresAt = normalizeString(row.expiresAt);
  const label = normalizeString(row.label);
  if (!pairingId || !publicKey || !nonce || !commitment || !expiresAt || !label || !isValidPublicKey(publicKey)) {
    return null;
  }
  return { pairingId, publicKey, nonce, commitment, expiresAt, label };
}

function parseVerifyPairingRequest(value: unknown): {
  pairingId: string;
  verifiedFingerprint: string;
  verificationCode: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!allowedRequestKeys(row, ['pairingId', 'verifiedFingerprint', 'verificationCode'])) return null;
  const pairingId = normalizeString(row.pairingId);
  const verifiedFingerprint = normalizeString(row.verifiedFingerprint);
  const verificationCode = normalizeString(row.verificationCode);
  if (!pairingId || !verifiedFingerprint || !verificationCode) return null;
  return { pairingId, verifiedFingerprint, verificationCode };
}

function normalizeContact(value: unknown): ContactIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const contactId = normalizeString(row.contactId);
  const displayName = normalizeString(row.displayName);
  const verifiedFingerprint = normalizeString(row.verifiedFingerprint);
  const trustState = row.trustState === 'verified' || row.trustState === 'blocked' ? row.trustState : null;
  if (!contactId || !displayName || !verifiedFingerprint || !trustState || !Array.isArray(row.devices)) return null;
  const devices = row.devices.flatMap((device) => {
    if (!device || typeof device !== 'object' || Array.isArray(device)) return [];
    const raw = device as Record<string, unknown>;
    const deviceId = normalizeString(raw.deviceId);
    const publicKey = normalizeString(raw.publicKey);
    const verifiedAt = normalizeString(raw.verifiedAt);
    const deviceTrustState: ContactDeviceIdentity['trustState'] | null =
      raw.trustState === 'verified' || raw.trustState === 'revoked' ? raw.trustState : null;
    if (!deviceId || !publicKey || !verifiedAt || !deviceTrustState) return [];
    const label = normalizeString(raw.label);
    const revokedAt = normalizeString(raw.revokedAt);
    return [{
      deviceId,
      publicKey,
      ...(label ? { label } : {}),
      verifiedAt,
      trustState: deviceTrustState,
      ...(revokedAt ? { revokedAt } : {}),
    }];
  });
  return { contactId, displayName, verifiedFingerprint, trustState, devices };
}

function normalizePairingOffer(value: unknown): StoredPairingOffer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const pairingId = normalizeString(row.pairingId);
  const publicKey = normalizeString(row.publicKey);
  const nonce = normalizeString(row.nonce);
  const commitment = normalizeString(row.commitment);
  const expiresAt = normalizeString(row.expiresAt);
  const label = normalizeString(row.label);
  const createdAt = normalizeString(row.createdAt);
  const status = row.status === 'pending'
    || row.status === 'accepted'
    || row.status === 'verified'
    || row.status === 'expired'
    || row.status === 'rejected'
    ? row.status
    : null;
  if (!pairingId || !publicKey || !nonce || !commitment || !expiresAt || !label || !createdAt || !status) return null;
  const acceptedAt = normalizeString(row.acceptedAt);
  const verifiedAt = normalizeString(row.verifiedAt);
  const rejectedAt = normalizeString(row.rejectedAt);
  const rejectionReason = normalizeString(row.rejectionReason);
  const accept = parsePairingOfferRequest(row.accept);
  const verifiedFingerprint = normalizeString(row.verifiedFingerprint);
  const verificationCode = normalizeString(row.verificationCode);
  return {
    pairingId,
    publicKey,
    nonce,
    commitment,
    expiresAt,
    label,
    createdAt,
    status,
    ...(accept ? { accept } : {}),
    ...(verifiedFingerprint ? { verifiedFingerprint } : {}),
    ...(verificationCode ? { verificationCode } : {}),
    ...(acceptedAt ? { acceptedAt } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(rejectedAt ? { rejectedAt } : {}),
    ...(rejectionReason ? { rejectionReason } : {}),
  };
}

function normalizeAcceptedNonce(value: unknown): AcceptedAuthNonce | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const contactId = normalizeString(row.contactId);
  const deviceId = normalizeString(row.deviceId);
  const nonce = normalizeString(row.nonce);
  const acceptedAt = normalizeString(row.acceptedAt);
  const expiresAt = normalizeString(row.expiresAt);
  if (!contactId || !deviceId || !nonce || !acceptedAt) return null;
  return {
    contactId,
    deviceId,
    nonce,
    acceptedAt,
    expiresAt: expiresAt ?? new Date(Date.parse(acceptedAt) + DEVICE_AUTH_MAX_SKEW_MS).toISOString(),
  };
}

function normalizeStoreFile(raw: unknown): ContactIdentityStoreFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { version: CONTACT_IDENTITY_STORE_VERSION, contacts: [], pairingOffers: [], acceptedAuthNonces: [] };
  }
  const row = raw as Record<string, unknown>;
  const contacts = Array.isArray(row.contacts) ? row.contacts.flatMap((contact) => {
    const normalized = normalizeContact(contact);
    return normalized ? [normalized] : [];
  }) : [];
  const pairingOffers = Array.isArray(row.pairingOffers) ? row.pairingOffers.flatMap((offer) => {
    const normalized = normalizePairingOffer(offer);
    return normalized ? [normalized] : [];
  }) : [];
  const acceptedAuthNonces = Array.isArray(row.acceptedAuthNonces) ? row.acceptedAuthNonces.flatMap((nonce) => {
    const normalized = normalizeAcceptedNonce(nonce);
    return normalized ? [normalized] : [];
  }) : [];
  return { version: CONTACT_IDENTITY_STORE_VERSION, contacts, pairingOffers, acceptedAuthNonces };
}

export function collaborationDeviceRequestPayload(input: {
  contactId: string;
  deviceId: string;
  audience: string;
  method: string;
  path: string;
  query?: string;
  bodySha256: string;
  timestamp: string;
  nonce: string;
}): string {
  return JSON.stringify({
    schemaVersion: COLLABORATION_DEVICE_AUTH_SCHEMA_VERSION,
    contactId: input.contactId,
    deviceId: input.deviceId,
    audience: input.audience,
    method: input.method.toUpperCase(),
    path: input.path,
    query: input.query ?? '',
    bodySha256: input.bodySha256,
    timestamp: input.timestamp,
    nonce: input.nonce,
  });
}

export class ContactIdentityStore {
  private readonly filePath: string | null;
  private readonly auditLog: CollaborationAuditLog | null;
  private readonly now: () => Date;
  private readonly idGenerator: () => string;
  private contacts = new Map<string, ContactIdentity>();
  private pairingOffers = new Map<string, StoredPairingOffer>();
  private acceptedAuthNonces = new Map<string, AcceptedAuthNonce>();

  constructor(opts: {
    kookrDir?: string;
    filePath?: string;
    auditPath?: string;
    auditLog?: CollaborationAuditLog | null;
    now?: () => Date;
    idGenerator?: () => string;
  } = {}) {
    this.filePath = opts.filePath ?? (opts.kookrDir ? join(opts.kookrDir, 'collaboration-identities.json') : null);
    this.now = opts.now ?? (() => new Date());
    this.idGenerator = opts.idGenerator ?? (() => randomUUID());
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
    this.contacts = new Map(loaded.contacts.map((contact) => [contact.contactId, cloneContact(contact)]));
    this.pairingOffers = new Map(loaded.pairingOffers.map((offer) => [offer.pairingId, { ...offer }]));
    this.acceptedAuthNonces = new Map(
      loaded.acceptedAuthNonces
        .filter((nonce) => !this.isExpiredAuthNonce(nonce.expiresAt))
        .map((nonce) => [this.authNonceKey(nonce.contactId, nonce.deviceId, nonce.nonce), nonce]),
    );
  }

  async createPairingOffer(raw: unknown): Promise<CreatePairingOfferResponse> {
    const request = parsePairingOfferRequest(raw);
    if (!request) throw new CollaborationPairingError('invalid-pairing-offer', 400);
    const now = this.now();
    const expiresAtMs = parseDateMs(request.expiresAt);
    if (!expiresAtMs || expiresAtMs <= now.getTime() || expiresAtMs > now.getTime() + MAX_PAIRING_TTL_MS) {
      throw new CollaborationPairingError('invalid-pairing-expiry', 400);
    }

    const offer: StoredPairingOffer = {
      ...request,
      pairingId: this.idGenerator(),
      createdAt: now.toISOString(),
      status: 'pending',
    };
    this.pairingOffers.set(offer.pairingId, offer);
    await this.save();
    await this.appendAudit('pairing.created', {
      pairingId: offer.pairingId,
      expiresAt: offer.expiresAt,
      label: offer.label,
    });
    return {
      schemaVersion: COLLABORATION_PAIRING_OFFER_SCHEMA_VERSION,
      pairingId: offer.pairingId,
      publicKey: offer.publicKey,
      nonce: offer.nonce,
      commitment: offer.commitment,
      expiresAt: offer.expiresAt,
      label: offer.label,
      createdAt: offer.createdAt,
    };
  }

  previewPairingVerification(raw: unknown): PendingPairingVerification {
    const request = parseAcceptPairingRequest(raw);
    if (!request) throw new CollaborationPairingError('invalid-pairing-accept', 400);
    const offer = this.pairingOffers.get(request.pairingId);
    if (!offer) throw new CollaborationPairingError('pairing-not-found', 404);
    const acceptMaterial: PairingPartyMaterial = {
      publicKey: request.publicKey,
      nonce: request.nonce,
      commitment: request.commitment,
      expiresAt: request.expiresAt,
      label: request.label,
    };
    const verifiedFingerprint = fingerprintForPairing(offer, acceptMaterial);
    return {
      pairingId: offer.pairingId,
      verifiedFingerprint,
      verificationCode: verificationCodeForFingerprint(verifiedFingerprint),
      expiresAt: offer.expiresAt,
    };
  }

  async acceptPairingOffer(raw: unknown): Promise<AcceptPairingOfferResponse> {
    const request = parseAcceptPairingRequest(raw);
    if (!request) throw new CollaborationPairingError('invalid-pairing-accept', 400);
    const offer = this.pairingOffers.get(request.pairingId);
    if (!offer) throw new CollaborationPairingError('pairing-not-found', 404);

    const now = this.now();
    if (offer.status !== 'pending') {
      await this.appendAudit('pairing.rejected', { pairingId: offer.pairingId, reason: 'pairing-replay' });
      throw new CollaborationPairingError('pairing-replay', 409);
    }
    const offerExpiresAtMs = parseDateMs(offer.expiresAt);
    const acceptExpiresAtMs = parseDateMs(request.expiresAt);
    if (!offerExpiresAtMs || offerExpiresAtMs <= now.getTime() || !acceptExpiresAtMs || acceptExpiresAtMs <= now.getTime()) {
      offer.status = 'expired';
      offer.rejectedAt = now.toISOString();
      offer.rejectionReason = 'pairing-expired';
      await this.save();
      await this.appendAudit('pairing.expired', { pairingId: offer.pairingId, expiresAt: offer.expiresAt });
      throw new CollaborationPairingError('pairing-expired', 410);
    }

    const acceptMaterial: PairingPartyMaterial = {
      publicKey: request.publicKey,
      nonce: request.nonce,
      commitment: request.commitment,
      expiresAt: request.expiresAt,
      label: request.label,
    };
    const verifiedFingerprint = fingerprintForPairing(offer, acceptMaterial);
    const verificationCode = verificationCodeForFingerprint(verifiedFingerprint);
    offer.status = 'accepted';
    offer.accept = acceptMaterial;
    offer.verifiedFingerprint = verifiedFingerprint;
    offer.verificationCode = verificationCode;
    offer.acceptedAt = now.toISOString();
    await this.save();
    await this.appendAudit('pairing.accepted', {
      pairingId: offer.pairingId,
      verifiedFingerprint,
      label: request.label,
    });
    return {
      schemaVersion: COLLABORATION_PAIRING_ACCEPT_SCHEMA_VERSION,
      pairingId: offer.pairingId,
      verifiedFingerprint,
      verificationCode,
      expiresAt: offer.expiresAt,
      acceptedAt: offer.acceptedAt,
      trustState: 'pending-local-verification',
    };
  }

  async verifyAcceptedPairing(raw: unknown): Promise<VerifyPairingResult> {
    const input = parseVerifyPairingRequest(raw);
    if (!input) throw new CollaborationPairingError('invalid-pairing-verification', 400);
    const offer = this.pairingOffers.get(input.pairingId);
    if (!offer || offer.status !== 'accepted' || !offer.accept || !offer.verifiedFingerprint || !offer.verificationCode) {
      throw new CollaborationPairingError('pairing-not-ready-for-verification', 409);
    }
    const now = this.now();
    const offerExpiresAtMs = parseDateMs(offer.expiresAt);
    const acceptExpiresAtMs = parseDateMs(offer.accept.expiresAt);
    if (!offerExpiresAtMs || offerExpiresAtMs <= now.getTime() || !acceptExpiresAtMs || acceptExpiresAtMs <= now.getTime()) {
      offer.status = 'expired';
      offer.rejectedAt = now.toISOString();
      offer.rejectionReason = 'pairing-expired';
      await this.save();
      await this.appendAudit('pairing.expired', { pairingId: offer.pairingId, expiresAt: offer.expiresAt });
      throw new CollaborationPairingError('pairing-expired', 410);
    }
    if (input.verifiedFingerprint !== offer.verifiedFingerprint || input.verificationCode !== offer.verificationCode) {
      await this.rejectOffer(offer, 'pairing-verification-mismatch', now);
      throw new CollaborationPairingError('pairing-verification-mismatch', 409);
    }

    const verifiedAt = now.toISOString();
    const contactId = idFromPublicKey('contact', offer.accept.publicKey);
    const deviceId = idFromPublicKey('device', offer.accept.publicKey);
    const existingContact = this.contacts.get(contactId);
    const existingDevice = existingContact?.devices.find((candidate) => candidate.deviceId === deviceId);
    if (existingContact?.trustState === 'blocked' || existingDevice?.trustState === 'revoked') {
      await this.appendAudit('pairing.rejected', { pairingId: offer.pairingId, reason: 'device-revoked' });
      throw new CollaborationPairingError('device-revoked', 409);
    }

    const device: ContactDeviceIdentity = {
      deviceId,
      publicKey: offer.accept.publicKey,
      label: offer.accept.label,
      verifiedAt,
      trustState: 'verified',
    };
    const contact: ContactIdentity = {
      contactId,
      displayName: offer.accept.label,
      verifiedFingerprint: offer.verifiedFingerprint,
      trustState: 'verified',
      devices: [device],
    };
    this.contacts.set(contactId, cloneContact(contact));
    offer.status = 'verified';
    offer.verifiedAt = verifiedAt;
    await this.save();
    await this.appendAudit('pairing.verified', {
      pairingId: offer.pairingId,
      contactId,
      deviceId,
      verifiedFingerprint: offer.verifiedFingerprint,
    });
    return {
      pairingId: offer.pairingId,
      contact: cloneContact(contact),
      device: cloneDevice(device),
      verifiedFingerprint: offer.verifiedFingerprint,
      verificationCode: offer.verificationCode,
      verifiedAt,
    };
  }

  listContacts(): ContactIdentity[] {
    return [...this.contacts.values()].map(cloneContact);
  }

  diagnostics(): {
    trustedContacts: number;
    blockedContacts: number;
    verifiedDevices: number;
    revokedDevices: number;
  } {
    const contacts = [...this.contacts.values()];
    return {
      trustedContacts: contacts.filter((contact) => contact.trustState === 'verified').length,
      blockedContacts: contacts.filter((contact) => contact.trustState === 'blocked').length,
      verifiedDevices: contacts.reduce((count, contact) => (
        count + contact.devices.filter((device) => device.trustState === 'verified').length
      ), 0),
      revokedDevices: contacts.reduce((count, contact) => (
        count + contact.devices.filter((device) => device.trustState === 'revoked').length
      ), 0),
    };
  }

  async revokeDevice(contactId: string, deviceId: string): Promise<ContactDeviceIdentity | null> {
    const contact = this.contacts.get(contactId);
    const device = contact?.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!contact || !device) return null;
    const revokedAt = this.now().toISOString();
    device.trustState = 'revoked';
    device.revokedAt = revokedAt;
    await this.save();
    await this.appendAudit('pairing.revoked', { contactId, deviceId, revokedAt });
    return cloneDevice(device);
  }

  async verifyDeviceRequest(input: DeviceAuthInput): Promise<VerifiedDevicePrincipal> {
    if (!input.contactId || !input.deviceId || !input.timestamp || !input.nonce || !input.signature) {
      throw new CollaborationPairingError('unverified-device', 401);
    }
    const contact = this.contacts.get(input.contactId);
    const device = contact?.devices.find((candidate) => candidate.deviceId === input.deviceId);
    if (!contact || contact.trustState !== 'verified' || !device || device.trustState !== 'verified') {
      throw new CollaborationPairingError('unverified-device', 401);
    }
    const timestampMs = parseDateMs(input.timestamp);
    if (!timestampMs || Math.abs(this.now().getTime() - timestampMs) > DEVICE_AUTH_MAX_SKEW_MS) {
      throw new CollaborationPairingError('stale-device-signature', 401);
    }
    this.pruneAcceptedAuthNonces();
    const nonceKey = this.authNonceKey(input.contactId, input.deviceId, input.nonce);
    if (this.acceptedAuthNonces.has(nonceKey)) {
      throw new CollaborationPairingError('replayed-device-signature', 401);
    }
    const verifier = createVerify('sha256');
    verifier.update(collaborationDeviceRequestPayload({
      contactId: input.contactId,
      deviceId: input.deviceId,
      audience: input.audience,
      method: input.method,
      path: input.path,
      query: input.query,
      bodySha256: input.bodySha256,
      timestamp: input.timestamp,
      nonce: input.nonce,
    }));
    verifier.end();
    let verified = false;
    try {
      verified = verifier.verify(device.publicKey, input.signature, 'base64url');
    } catch {
      verified = false;
    }
    if (!verified) {
      throw new CollaborationPairingError('unverified-device', 401);
    }
    this.acceptedAuthNonces.set(nonceKey, {
      contactId: input.contactId,
      deviceId: input.deviceId,
      nonce: input.nonce,
      acceptedAt: this.now().toISOString(),
      expiresAt: new Date(Math.max(this.now().getTime(), timestampMs) + DEVICE_AUTH_MAX_SKEW_MS).toISOString(),
    });
    await this.save();
    return { contactId: input.contactId, deviceId: input.deviceId };
  }

  private authNonceKey(contactId: string, deviceId: string, nonce: string): string {
    return `${contactId}\0${deviceId}\0${nonce}`;
  }

  private isExpiredAuthNonce(acceptedAt: string): boolean {
    const expiresAtMs = parseDateMs(acceptedAt);
    return !expiresAtMs || this.now().getTime() > expiresAtMs;
  }

  private pruneAcceptedAuthNonces(): void {
    for (const [key, nonce] of this.acceptedAuthNonces) {
      if (this.isExpiredAuthNonce(nonce.expiresAt)) this.acceptedAuthNonces.delete(key);
    }
  }

  private async rejectOffer(offer: StoredPairingOffer, reason: string, now: Date): Promise<void> {
    offer.status = 'rejected';
    offer.rejectedAt = now.toISOString();
    offer.rejectionReason = reason;
    await this.save();
    await this.appendAudit('pairing.rejected', { pairingId: offer.pairingId, reason });
  }

  private async save(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true });
    this.pruneAcceptedAuthNonces();
    const data: ContactIdentityStoreFile = {
      version: CONTACT_IDENTITY_STORE_VERSION,
      contacts: this.listContacts(),
      pairingOffers: [...this.pairingOffers.values()].map((offer) => ({ ...offer })),
      acceptedAuthNonces: [...this.acceptedAuthNonces.values()]
        .filter((nonce) => !this.isExpiredAuthNonce(nonce.expiresAt)),
    };
    await atomicWriteFile(this.filePath, JSON.stringify(data, null, 2));
  }

  private async appendAudit(kind: PairingAuditEventKind, detail: PairingAuditDetail): Promise<void> {
    if (!this.auditLog) return;
    const actor = detail.contactId && detail.deviceId
      ? { kind: 'contact-device' as const, contactId: String(detail.contactId), deviceId: String(detail.deviceId) }
      : kind === 'pairing.accepted'
        ? { kind: 'peer-bootstrap' as const }
        : { kind: 'local-owner' as const };
    const event = kind === 'pairing.verified'
      ? 'contact.paired'
      : kind === 'pairing.revoked'
        ? 'device.revoked'
        : kind;
    await this.auditLog.append({
      actor,
      event,
      pairingId: detail.pairingId,
      decision: kind === 'pairing.rejected' || kind === 'pairing.expired' ? 'denied' : 'allowed',
      reason: detail.reason,
    });
  }
}
