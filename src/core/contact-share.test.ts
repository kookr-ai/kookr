import { describe, expect, it } from 'vitest';

import { asNodeId, asSessionEpoch, asSessionId } from '../remote/ids.js';
import type { ContactShareEnvelope, DecryptedContactShareInvite } from '../shared/contracts/contact-share.js';
import { isSharedTaskId } from '../shared/contracts/contact-share.js';
import { ContactShareReadModel } from './contact-share.js';

function envelope(overrides: Partial<ContactShareEnvelope> = {}): ContactShareEnvelope {
  return {
    schemaVersion: 'contact-share-envelope.v1',
    envelopeId: 'env-1',
    shareId: 'share-1',
    decisionVersion: 1,
    senderContactId: 'contact-owner',
    recipientContactId: 'contact-recipient',
    recipientDeviceId: 'device-recipient-a',
    kind: 'share.invite',
    createdAt: '2026-05-18T10:00:00.000Z',
    ciphertext: 'sealed:invite:opaque',
    senderSignature: 'sig-owner',
    ...overrides,
  };
}

function invite(overrides: Partial<DecryptedContactShareInvite> = {}): DecryptedContactShareInvite {
  return {
    shareId: 'share-1',
    ownerContactId: 'contact-owner',
    ownerDisplayName: 'Jean',
    ownerNodeLabel: 'desktop',
    originNodeId: asNodeId('kookr-node-owner'),
    remoteTaskId: 'task-origin',
    taskLabel: 'Fix auth regression',
    grants: ['view'],
    remoteStatus: 'inProgress',
    terminalSubject: {
      sessionId: asSessionId('session-1'),
      sessionEpoch: asSessionEpoch('1'),
      projectionId: 'proj-primary',
      sessionAlias: 'primary',
    },
    ...overrides,
  };
}

describe('ContactShareReadModel', () => {
  it('requires verified contacts to carry device keys', () => {
    const model = new ContactShareReadModel();

    expect(() => model.upsertContact({
      contactId: 'contact-alice',
      displayName: 'Alice',
      verifiedFingerprint: 'fp-alice',
      devices: [],
      trustState: 'verified',
    })).toThrow(/device key/);

    model.upsertContact({
      contactId: 'contact-alice',
      displayName: 'Alice',
      verifiedFingerprint: 'fp-alice',
      devices: [{ deviceId: 'alice-laptop', publicKey: 'pub-alice' }],
      trustState: 'verified',
    });

    expect(model.verifiedContacts()).toEqual([expect.objectContaining({
      contactId: 'contact-alice',
      devices: [expect.objectContaining({ publicKey: 'pub-alice' })],
    })]);
  });

  it('derives redacted inbox notifications without exposing decrypted task labels', () => {
    const model = new ContactShareReadModel();
    model.ingestEncryptedEnvelope(envelope());
    const item = model.recordDecryptedInvite(invite());

    expect(item).toEqual(expect.objectContaining({
      lifecycle: 'pending',
      notificationTitle: 'Kookr task shared',
      notificationBody: 'Jean shared a task with you',
      redacted: true,
    }));
    expect(JSON.stringify(item)).not.toContain('Fix auth regression');
    expect(JSON.stringify(item)).not.toContain('task-origin');
  });

  it('creates a native SharedTask on accept and removes it on refuse', () => {
    const model = new ContactShareReadModel();
    model.ingestEncryptedEnvelope(envelope());
    model.recordDecryptedInvite(invite());

    const accepted = model.acceptShare('share-1', 'device-recipient-a', new Date('2026-05-18T10:01:00.000Z'));
    expect(accepted).toEqual(expect.objectContaining({
      kind: 'shared-task',
      sharedTaskId: 'shared:share-1',
      ownerDisplayName: 'Jean',
      ownerNodeLabel: 'desktop',
      originNodeId: 'kookr-node-owner',
      remoteTaskId: 'task-origin',
      shareId: 'share-1',
      localDisplayLabel: 'Fix auth regression',
      grants: ['view'],
      source: 'contact-share',
      remoteStatus: 'inProgress',
      terminalSubject: expect.objectContaining({ projectionId: 'proj-primary' }),
    }));
    expect(isSharedTaskId(accepted!.sharedTaskId)).toBe(true);

    model.refuseShare('share-1', 'device-recipient-a', new Date('2026-05-18T10:02:00.000Z'));
    expect(model.listSharedTasks()).toEqual([]);
  });

  it('uses causal decision versions so delayed accepts cannot resurrect refused or revoked shares', () => {
    const model = new ContactShareReadModel();
    model.ingestEncryptedEnvelope(envelope());
    model.recordDecryptedInvite(invite());
    expect(model.acceptShare('share-1', 'device-recipient-a')).toBeTruthy();

    model.ingestEncryptedEnvelope(envelope({
      envelopeId: 'env-refuse-v2',
      kind: 'share.refuse',
      decisionVersion: 2,
      createdAt: '2026-05-18T10:03:00.000Z',
      ciphertext: 'sealed:refuse:opaque',
    }));
    expect(model.listSharedTasks()).toEqual([]);

    model.ingestEncryptedEnvelope(envelope({
      envelopeId: 'env-accept-v1-delayed',
      kind: 'share.accept',
      decisionVersion: 1,
      createdAt: '2026-05-18T10:04:00.000Z',
      ciphertext: 'sealed:accept:delayed',
    }));
    expect(model.listSharedTasks()).toEqual([]);

    model.ingestEncryptedEnvelope(envelope({
      envelopeId: 'env-revoke-device-b',
      kind: 'share.revoke',
      decisionVersion: 1,
      recipientDeviceId: 'device-recipient-b',
      createdAt: '2026-05-18T10:05:00.000Z',
      ciphertext: 'sealed:revoke:device-b',
    }));
    model.ingestEncryptedEnvelope(envelope({
      envelopeId: 'env-accept-device-b-delayed',
      kind: 'share.accept',
      decisionVersion: 1,
      recipientDeviceId: 'device-recipient-b',
      createdAt: '2026-05-18T10:06:00.000Z',
      ciphertext: 'sealed:accept:device-b',
    }));
    expect(model.listSharedTasks()).toEqual([]);

    expect(model.acceptShare('share-1', 'device-recipient-a', new Date('2026-05-18T10:07:00.000Z'))).toBeNull();
    expect(model.listSharedTasks()).toEqual([]);
  });

  it('does not accept refused or expired invites', () => {
    const model = new ContactShareReadModel();
    model.ingestEncryptedEnvelope(envelope({
      expiresAt: '2026-05-18T10:02:00.000Z',
    }));
    model.recordDecryptedInvite(invite());

    model.refuseShare('share-1', 'device-recipient-a', new Date('2026-05-18T10:01:00.000Z'));
    expect(model.acceptShare('share-1', 'device-recipient-a', new Date('2026-05-18T10:01:30.000Z'))).toBeNull();

    const expired = new ContactShareReadModel();
    expired.ingestEncryptedEnvelope(envelope({
      envelopeId: 'env-expired',
      expiresAt: '2026-05-18T10:02:00.000Z',
    }));
    expired.recordDecryptedInvite(invite());
    expect(expired.acceptShare('share-1', 'device-recipient-a', new Date('2026-05-18T10:03:00.000Z'))).toBeNull();
    expect(expired.listSharedTasks()).toEqual([]);
  });
});
