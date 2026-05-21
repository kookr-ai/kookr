import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

import { ContactShareReadModel } from '../core/contact-share.js';
import { asNodeId } from '../remote/ids.js';
import { readPrivateNetworkCollaborationConfig } from './collaboration-config.js';
import { startPrivateNetworkSharedTaskUpdatePoller } from './collaboration-update-poller.js';

function enabledConfig(peerBaseUrl = 'http://127.0.0.1:4902') {
  return readPrivateNetworkCollaborationConfig({
    env: {
      KOOKR_COLLABORATION_PROFILES: 'true',
      KOOKR_COLLABORATION_LISTENER: 'true',
      KOOKR_COLLABORATION_PRIVATE_NETWORK: 'true',
      ...(peerBaseUrl ? { KOOKR_COLLABORATION_PEER_BASE_URL: peerBaseUrl } : {}),
    },
    dashboardHost: '127.0.0.1',
    dashboardPort: 4801,
    now: () => new Date('2026-05-21T00:00:00.000Z'),
  });
}

function privateKey(): string {
  return generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
}

describe('private-network shared task update poller', () => {
  it('stays disabled without the update-polling feature flag', async () => {
    const setIntervalImpl = vi.fn() as unknown as typeof setInterval;
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: 'private-key',
      },
      contactShare: new ContactShareReadModel(),
      setIntervalImpl,
    });

    expect(poller.status).toBe('disabled');
    await expect(poller.pollOnce()).resolves.toBe(0);
    expect(setIntervalImpl).not.toHaveBeenCalled();
  });

  it('stays disabled without a configured peer listener URL', async () => {
    const setIntervalImpl = vi.fn() as unknown as typeof setInterval;
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(''),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: 'private-key',
      },
      contactShare: new ContactShareReadModel(),
      setIntervalImpl,
    });

    expect(poller.status).toBe('disabled');
    await expect(poller.pollOnce()).resolves.toBe(0);
    expect(setIntervalImpl).not.toHaveBeenCalled();
  });

  it('stays disabled without local device signing credentials', async () => {
    const setIntervalImpl = vi.fn() as unknown as typeof setInterval;
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
      },
      contactShare: new ContactShareReadModel(),
      setIntervalImpl,
    });

    expect(poller.status).toBe('disabled');
    await expect(poller.pollOnce()).resolves.toBe(0);
    expect(setIntervalImpl).not.toHaveBeenCalled();
  });

  it('ignores malformed update entries from a peer response', async () => {
    const contactShare = new ContactShareReadModel();
    const applyRemoteTaskProjection = vi.spyOn(contactShare, 'applyRemoteTaskProjection');
    const setIntervalImpl = vi.fn() as unknown as typeof setInterval;
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
      },
      contactShare,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        schemaVersion: 'collaboration-shared-task-updates.v1',
        updates: [
          {
            inviteId: 'invite-1',
            grantId: 'grant-1',
            policyVersion: 1,
            projection: {
              schemaVersion: 'remote-task-projection.v1',
              nodeId: asNodeId('node-1'),
              taskId: 'task-1',
              taskLabel: 'Valid label',
              status: 'inProgress',
              hasFinding: false,
              needsInput: false,
              updatedAt: '2026-05-21T00:00:00.000Z',
            },
          },
          {
            inviteId: 'invite-2',
            grantId: 'grant-2',
            policyVersion: 1,
            projection: {
              schemaVersion: 'remote-task-projection.v1',
              nodeId: asNodeId('node-1'),
              taskId: 'task-2',
              taskLabel: 'Bad status',
              status: 'unknown',
              hasFinding: false,
              needsInput: false,
              updatedAt: '2026-05-21T00:00:00.000Z',
            },
          },
          {
            inviteId: 'invite-3',
            grantId: 'grant-3',
            policyVersion: 0,
            projection: {
              schemaVersion: 'remote-task-projection.v1',
              nodeId: asNodeId('node-1'),
              taskId: 'task-3',
              taskLabel: 'Bad policy',
              status: 'open',
              hasFinding: false,
              needsInput: false,
              updatedAt: '2026-05-21T00:00:00.000Z',
            },
          },
        ],
        removals: [],
      }), { status: 200 })) as typeof fetch,
      setIntervalImpl,
    });

    expect(poller.status).toBe('polling');
    await expect(poller.pollOnce()).resolves.toBe(0);
    expect(applyRemoteTaskProjection).toHaveBeenCalledTimes(1);
    expect(applyRemoteTaskProjection).toHaveBeenCalledWith('invite-1', expect.objectContaining({
      status: 'inProgress',
      taskLabel: 'Valid label',
    }), expect.any(Date));
  });

  it('applies explicit peer removals to accepted shared tasks', async () => {
    const contactShare = new ContactShareReadModel();
    contactShare.ingestEncryptedEnvelope({
      schemaVersion: 'contact-share-envelope.v1',
      envelopeId: 'env-1',
      shareId: 'invite-1',
      decisionVersion: 1,
      senderContactId: 'owner-contact',
      recipientContactId: 'contact-1',
      recipientDeviceId: 'device-1',
      kind: 'share.invite',
      createdAt: '2026-05-21T00:00:00.000Z',
      ciphertext: 'sealed:invite',
      senderSignature: 'sig:owner',
    });
    contactShare.recordDecryptedInvite({
      shareId: 'invite-1',
      ownerContactId: 'owner-contact',
      ownerDisplayName: 'Jean',
      originNodeId: asNodeId('node-1'),
      remoteTaskId: 'task-1',
      taskLabel: 'Shared task',
      grants: ['view'],
      remoteStatus: 'open',
    });
    expect(contactShare.acceptShare('invite-1', 'device-1')).toBeTruthy();
    const setIntervalImpl = vi.fn() as unknown as typeof setInterval;
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
      },
      contactShare,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        schemaVersion: 'collaboration-shared-task-updates.v1',
        updates: [],
        removals: [{
          inviteId: 'invite-1',
          reason: 'revoked',
          policyVersion: 2,
          removedAt: '2026-05-21T00:01:00.000Z',
        }],
      }), { status: 200 })) as typeof fetch,
      setIntervalImpl,
    });

    await expect(poller.pollOnce()).resolves.toBe(1);
    expect(contactShare.listSharedTasks()).toEqual([]);
  });
});
