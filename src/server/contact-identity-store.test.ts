import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  collaborationDeviceRequestPayload,
  CollaborationPairingError,
  ContactIdentityStore,
} from './contact-identity-store.js';

function keyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString().trim(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function signDeviceRequest(input: {
  privateKey: string;
  contactId: string;
  deviceId: string;
  audience?: string;
  method: string;
  path: string;
  query?: string;
  bodySha256?: string;
  timestamp: string;
  nonce: string;
}): string {
  const signer = createSign('sha256');
  signer.update(collaborationDeviceRequestPayload({
    ...input,
    audience: input.audience ?? 'http://127.0.0.1:4802',
    query: input.query ?? '',
    bodySha256: input.bodySha256 ?? createHash('sha256').update('').digest('hex'),
  }));
  signer.end();
  return signer.sign(input.privateKey, 'base64url');
}

async function tempKookrDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-contact-identity-'));
}

async function auditRows(kookrDir: string): Promise<Array<{ kind: string; detail: Record<string, unknown> }>> {
  const raw = await readFile(join(kookrDir, 'collaboration-audit.jsonl'), 'utf-8');
  return raw.trim().split('\n').map((line) => JSON.parse(line) as { kind: string; detail: Record<string, unknown> });
}

async function createVerifiedPairing(opts: {
  kookrDir?: string;
  now?: () => Date;
  idGenerator?: () => string;
  store?: ContactIdentityStore;
} = {}) {
  const initiator = keyPair();
  const recipient = keyPair();
  const store = opts.store ?? new ContactIdentityStore({
    kookrDir: opts.kookrDir,
    now: opts.now,
    idGenerator: opts.idGenerator,
  });
  await store.load();
  const offer = await store.createPairingOffer({
    publicKey: initiator.publicKey,
    nonce: 'offer-nonce',
    commitment: 'offer-commitment',
    expiresAt: '2026-05-21T00:10:00.000Z',
    label: 'Jean desktop',
  });
  const acceptDraft = {
    pairingId: offer.pairingId,
    publicKey: recipient.publicKey,
    nonce: 'accept-nonce',
    commitment: 'accept-commitment',
    expiresAt: '2026-05-21T00:10:00.000Z',
    label: 'Alice laptop',
  };
  const verification = store.previewPairingVerification(acceptDraft);
  const accepted = await store.acceptPairingOffer({
    ...acceptDraft,
  });
  const verified = await store.verifyAcceptedPairing({
    pairingId: offer.pairingId,
    verifiedFingerprint: verification.verifiedFingerprint,
    verificationCode: verification.verificationCode,
  });
  return { store, initiator, recipient, offer, accepted, verified };
}

describe('ContactIdentityStore', () => {
  it('persists verified contact/device trust only after explicit fingerprint and code verification', async () => {
    const kookrDir = await tempKookrDir();
    const now = () => new Date('2026-05-21T00:00:00.000Z');
    const { accepted, verified } = await createVerifiedPairing({
      kookrDir,
      now,
      idGenerator: (() => {
        let next = 0;
        return () => `id-${++next}`;
      })(),
    });

    expect(accepted).toEqual(expect.objectContaining({
      trustState: 'pending-local-verification',
      verifiedFingerprint: verified.verifiedFingerprint,
      verificationCode: verified.verificationCode,
    }));
    expect(verified.contact).toMatchObject({
      displayName: 'Alice laptop',
      trustState: 'verified',
      verifiedFingerprint: verified.verifiedFingerprint,
    });
    expect(verified.device).toMatchObject({
      publicKey: expect.stringContaining('BEGIN PUBLIC KEY'),
      trustState: 'verified',
      verifiedAt: '2026-05-21T00:00:00.000Z',
    });

    const reloaded = new ContactIdentityStore({ kookrDir });
    await reloaded.load();
    expect(reloaded.listContacts()).toEqual([verified.contact]);
    expect(reloaded.listContacts()[0]).not.toHaveProperty('privateKey');
    expect(reloaded.listContacts()[0]?.devices[0]).not.toHaveProperty('privateKey');

    await expect(auditRows(kookrDir)).resolves.toEqual([
      expect.objectContaining({
        kind: 'pairing.created',
        detail: expect.objectContaining({ pairingId: verified.pairingId, label: 'Jean desktop' }),
      }),
      expect.objectContaining({ kind: 'pairing.accepted' }),
      expect.objectContaining({ kind: 'pairing.verified' }),
    ]);
  });

  it('rejects mismatched, replayed, and expired pairing messages with audit evidence', async () => {
    const kookrDir = await tempKookrDir();
    let current = new Date('2026-05-21T00:00:00.000Z');
    let id = 0;
    const store = new ContactIdentityStore({
      kookrDir,
      now: () => current,
      idGenerator: () => `id-${++id}`,
    });

    const initiator = keyPair();
    const recipient = keyPair();
    const offer = await store.createPairingOffer({
      publicKey: initiator.publicKey,
      nonce: 'bad-offer-nonce',
      commitment: 'bad-offer-commitment',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Jean desktop',
    });
    const mismatchAccepted = await store.acceptPairingOffer({
      pairingId: offer.pairingId,
      publicKey: recipient.publicKey,
      nonce: 'bad-accept-nonce',
      commitment: 'bad-accept-commitment',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Alice laptop',
    });
    await expect(store.verifyAcceptedPairing({
      pairingId: mismatchAccepted.pairingId,
      verifiedFingerprint: 'wrong-fingerprint',
      verificationCode: '000000',
    })).rejects.toMatchObject({ code: 'pairing-verification-mismatch', status: 409 });

    const successful = await createVerifiedPairing({ store });
    await expect(store.acceptPairingOffer({
      pairingId: successful.offer.pairingId,
      publicKey: successful.recipient.publicKey,
      nonce: 'accept-nonce',
      commitment: 'accept-commitment',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Alice laptop',
    })).rejects.toMatchObject({ code: 'pairing-replay', status: 409 });

    const expiringOffer = await store.createPairingOffer({
      publicKey: initiator.publicKey,
      nonce: 'expiring-offer-nonce',
      commitment: 'expiring-offer-commitment',
      expiresAt: '2026-05-21T00:05:00.000Z',
      label: 'Jean desktop',
    });
    current = new Date('2026-05-21T00:06:00.000Z');
    await expect(store.acceptPairingOffer({
      pairingId: expiringOffer.pairingId,
      publicKey: recipient.publicKey,
      nonce: 'expired-accept-nonce',
      commitment: 'expired-accept-commitment',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Alice laptop',
    })).rejects.toMatchObject({ code: 'pairing-expired', status: 410 });

    const rows = await auditRows(kookrDir);
    expect(rows.map((row) => row.kind)).toEqual([
      'pairing.created',
      'pairing.accepted',
      'pairing.rejected',
      'pairing.created',
      'pairing.accepted',
      'pairing.verified',
      'pairing.rejected',
      'pairing.created',
      'pairing.expired',
    ]);
    expect(rows.filter((row) => row.kind === 'pairing.rejected').map((row) => row.detail.reason))
      .toEqual(['pairing-verification-mismatch', 'pairing-replay']);
  });

  it('authenticates only verified device signatures and denies revoked devices', async () => {
    const kookrDir = await tempKookrDir();
    let current = new Date('2026-05-21T00:00:00.000Z');
    const { store, recipient, verified } = await createVerifiedPairing({
      kookrDir,
      now: () => current,
    });
    const auth = {
      contactId: verified.contact.contactId,
      deviceId: verified.device.deviceId,
      audience: 'http://127.0.0.1:4802',
      method: 'GET',
      path: '/api/collaboration/shared-task-updates',
      bodySha256: createHash('sha256').update('').digest('hex'),
      timestamp: '2026-05-21T00:00:00.000Z',
      nonce: 'auth-nonce-1',
    };
    const signature = signDeviceRequest({ privateKey: recipient.privateKey, ...auth });

    await expect(store.verifyDeviceRequest({ ...auth, signature })).resolves.toEqual({
      contactId: verified.contact.contactId,
      deviceId: verified.device.deviceId,
    });
    await expect(store.verifyDeviceRequest({ ...auth, signature }))
      .rejects.toMatchObject({ code: 'replayed-device-signature' });

    const reloaded = new ContactIdentityStore({ kookrDir, now: () => current });
    await reloaded.load();
    await expect(reloaded.verifyDeviceRequest({ ...auth, signature }))
      .rejects.toMatchObject({ code: 'replayed-device-signature' });

    current = new Date('2026-05-21T00:01:00.000Z');
    await store.revokeDevice(verified.contact.contactId, verified.device.deviceId);
    const revokedAuth = {
      ...auth,
      timestamp: '2026-05-21T00:01:00.000Z',
      nonce: 'auth-nonce-2',
    };
    const revokedSignature = signDeviceRequest({ privateKey: recipient.privateKey, ...revokedAuth });
    await expect(store.verifyDeviceRequest({ ...revokedAuth, signature: revokedSignature }))
      .rejects.toMatchObject({ code: 'unverified-device' });

    const newOffer = await store.createPairingOffer({
      publicKey: keyPair().publicKey,
      nonce: 'repair-offer',
      commitment: 'repair-commitment',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Jean desktop',
    });
    const repaired = await store.acceptPairingOffer({
      pairingId: newOffer.pairingId,
      publicKey: recipient.publicKey,
      nonce: 'repair-accept',
      commitment: 'repair-accept-commitment',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Alice laptop',
    });
    await expect(store.verifyAcceptedPairing({
      pairingId: repaired.pairingId,
      verifiedFingerprint: repaired.verifiedFingerprint,
      verificationCode: repaired.verificationCode,
    })).rejects.toMatchObject({ code: 'device-revoked' });

    const rows = await auditRows(kookrDir);
    expect(rows.find((row) => row.kind === 'pairing.revoked')).toEqual(expect.objectContaining({
      kind: 'pairing.revoked',
      detail: expect.objectContaining({
        contactId: verified.contact.contactId,
        deviceId: verified.device.deviceId,
      }),
    }));
  });

  it('persists future-dated request nonces until the signed timestamp expires', async () => {
    const kookrDir = await tempKookrDir();
    let current = new Date('2026-05-21T00:00:00.000Z');
    const { store, recipient, verified } = await createVerifiedPairing({
      kookrDir,
      now: () => current,
    });
    const auth = {
      contactId: verified.contact.contactId,
      deviceId: verified.device.deviceId,
      audience: 'http://127.0.0.1:4802',
      method: 'GET',
      path: '/api/collaboration/shared-task-updates',
      bodySha256: createHash('sha256').update('').digest('hex'),
      timestamp: '2026-05-21T00:04:00.000Z',
      nonce: 'future-nonce',
    };
    const signature = signDeviceRequest({ privateKey: recipient.privateKey, ...auth });

    await expect(store.verifyDeviceRequest({ ...auth, signature })).resolves.toEqual({
      contactId: verified.contact.contactId,
      deviceId: verified.device.deviceId,
    });

    current = new Date('2026-05-21T00:06:00.000Z');
    const reloaded = new ContactIdentityStore({ kookrDir, now: () => current });
    await reloaded.load();
    await expect(reloaded.verifyDeviceRequest({ ...auth, signature }))
      .rejects.toMatchObject({ code: 'replayed-device-signature' });
  });

  it('rejects malformed public keys and expired accepted pairing verification', async () => {
    const initiator = keyPair();
    const recipient = keyPair();
    let current = new Date('2026-05-21T00:00:00.000Z');
    const store = new ContactIdentityStore({ now: () => current });

    await expect(store.createPairingOffer({
      publicKey: 'not-a-public-key',
      nonce: 'nonce',
      commitment: 'commitment',
      expiresAt: '2026-05-21T00:10:00.000Z',
      label: 'Bad key',
    })).rejects.toMatchObject({ code: 'invalid-pairing-offer' });

    const offer = await store.createPairingOffer({
      publicKey: initiator.publicKey,
      nonce: 'offer-nonce',
      commitment: 'offer-commitment',
      expiresAt: '2026-05-21T00:20:00.000Z',
      label: 'Jean desktop',
    });
    await expect(store.acceptPairingOffer({
      pairingId: offer.pairingId,
      publicKey: 'not-a-public-key',
      nonce: 'accept-nonce',
      commitment: 'accept-commitment',
      expiresAt: '2026-05-21T00:01:00.000Z',
      label: 'Alice laptop',
    })).rejects.toMatchObject({ code: 'invalid-pairing-accept' });

    const pending = await store.acceptPairingOffer({
      pairingId: offer.pairingId,
      publicKey: recipient.publicKey,
      nonce: 'accept-nonce',
      commitment: 'accept-commitment',
      expiresAt: '2026-05-21T00:01:00.000Z',
      label: 'Alice laptop',
    });
    current = new Date('2026-05-21T00:02:00.000Z');
    await expect(store.verifyAcceptedPairing({
      pairingId: pending.pairingId,
      verifiedFingerprint: pending.verifiedFingerprint,
      verificationCode: pending.verificationCode,
    })).rejects.toMatchObject({ code: 'pairing-expired' });
  });
});
