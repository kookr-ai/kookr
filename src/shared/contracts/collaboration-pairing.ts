export const COLLABORATION_PAIRING_OFFER_SCHEMA_VERSION = 'collaboration-pairing-offer.v1' as const;
export const COLLABORATION_PAIRING_ACCEPT_SCHEMA_VERSION = 'collaboration-pairing-accept.v1' as const;
export const COLLABORATION_DEVICE_AUTH_SCHEMA_VERSION = 'collaboration-device-auth.v1' as const;

export type ContactDeviceTrustState = 'verified' | 'revoked';
export type ContactTrustState = 'verified' | 'blocked';

export interface ContactDeviceIdentity {
  deviceId: string;
  publicKey: string;
  label?: string;
  verifiedAt: string;
  trustState: ContactDeviceTrustState;
  revokedAt?: string;
}

export interface ContactIdentity {
  contactId: string;
  displayName: string;
  verifiedFingerprint: string;
  trustState: ContactTrustState;
  devices: ContactDeviceIdentity[];
}

export interface CreatePairingOfferRequest {
  publicKey: string;
  nonce: string;
  commitment: string;
  expiresAt: string;
  label: string;
}

export interface CreatePairingOfferResponse {
  schemaVersion: typeof COLLABORATION_PAIRING_OFFER_SCHEMA_VERSION;
  pairingId: string;
  publicKey: string;
  nonce: string;
  commitment: string;
  expiresAt: string;
  label: string;
  createdAt: string;
}

export interface AcceptPairingOfferRequest {
  pairingId: string;
  publicKey: string;
  nonce: string;
  commitment: string;
  expiresAt: string;
  label: string;
}

export interface AcceptPairingOfferResponse {
  schemaVersion: typeof COLLABORATION_PAIRING_ACCEPT_SCHEMA_VERSION;
  pairingId: string;
  verifiedFingerprint: string;
  verificationCode: string;
  expiresAt: string;
  acceptedAt: string;
  trustState: 'pending-local-verification';
}

export interface PendingPairingVerification {
  pairingId: string;
  verifiedFingerprint: string;
  verificationCode: string;
  expiresAt: string;
}

export interface VerifyPairingRequest {
  pairingId: string;
  verifiedFingerprint: string;
  verificationCode: string;
}

export interface VerifyPairingResult {
  pairingId: string;
  contact: ContactIdentity;
  device: ContactDeviceIdentity;
  verifiedFingerprint: string;
  verificationCode: string;
  verifiedAt: string;
}

export interface VerifiedDevicePrincipal {
  contactId: string;
  deviceId: string;
}

function normalizedRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

export function parseVerifyPairingRequest(value: unknown): VerifyPairingRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!hasOnlyKeys(row, ['pairingId', 'verifiedFingerprint', 'verificationCode'])) return null;
  const pairingId = normalizedRequiredString(row.pairingId);
  const verifiedFingerprint = normalizedRequiredString(row.verifiedFingerprint);
  const verificationCode = normalizedRequiredString(row.verificationCode);
  if (!pairingId || !verifiedFingerprint || !verificationCode) return null;
  return { pairingId, verifiedFingerprint, verificationCode };
}
