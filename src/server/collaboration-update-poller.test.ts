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

  it('never reaches fetch for a rejected cloud-metadata or link-local peer URL (issue #2182)', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const setIntervalImpl = vi.fn() as unknown as typeof setInterval;
    for (const peerBaseUrl of ['http://169.254.169.254/', 'http://metadata.google.internal/']) {
      const poller = startPrivateNetworkSharedTaskUpdatePoller({
        config: enabledConfig(peerBaseUrl),
        env: {
          KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
          KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
          KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
          KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
        },
        contactShare: new ContactShareReadModel(),
        fetchImpl,
        setIntervalImpl,
      });

      expect(poller.status).toBe('disabled');
      await expect(poller.pollOnce()).resolves.toBe(0);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
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

  it('reports a disabled health record when not polling', () => {
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: 'private-key',
      },
      contactShare: new ContactShareReadModel(),
      setIntervalImpl: vi.fn() as unknown as typeof setInterval,
    });

    expect(poller.status).toBe('disabled');
    expect(poller.getStatus()).toEqual({
      state: 'disabled',
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      consecutiveFailures: 0,
      sinceLastAttemptMs: null,
    });
  });

  it('drives the fetch abort signal from the configured request deadline', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
        schemaVersion: 'collaboration-shared-task-updates.v1',
        updates: [],
        removals: [],
      }), { status: 200 }));
      const poller = startPrivateNetworkSharedTaskUpdatePoller({
        config: enabledConfig(),
        env: {
          KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
          KOOKR_COLLABORATION_UPDATE_POLL_TIMEOUT_MS: '7500',
          KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
          KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
          KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
        },
        contactShare: new ContactShareReadModel(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        setIntervalImpl: vi.fn() as unknown as typeof setInterval,
      });

      await poller.pollOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      // The signal must be the configured deadline, not just any AbortSignal:
      // a never-firing signal would pass an instanceof check but leave a hung
      // peer unbounded.
      expect(timeoutSpy).toHaveBeenCalledWith(7500);
      const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.signal).toBe(timeoutSpy.mock.results[0]?.value);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('falls back to the default 10s deadline when none is configured', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const poller = startPrivateNetworkSharedTaskUpdatePoller({
        config: enabledConfig(),
        env: {
          KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
          KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
          KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
          KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
        },
        contactShare: new ContactShareReadModel(),
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({
          schemaVersion: 'collaboration-shared-task-updates.v1',
          updates: [],
          removals: [],
        }), { status: 200 })) as typeof fetch,
        setIntervalImpl: vi.fn() as unknown as typeof setInterval,
      });

      await poller.pollOnce();
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('records a healthy status after a successful poll', async () => {
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
      },
      contactShare: new ContactShareReadModel(),
      now: () => new Date('2026-05-21T00:00:00.000Z'),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        schemaVersion: 'collaboration-shared-task-updates.v1',
        updates: [],
        removals: [],
      }), { status: 200 })) as typeof fetch,
      setIntervalImpl: vi.fn() as unknown as typeof setInterval,
    });

    await poller.pollOnce();
    const status = poller.getStatus();
    expect(status.state).toBe('healthy');
    expect(status.lastSuccessAt).toBe('2026-05-21T00:00:00.000Z');
    expect(status.lastFailureAt).toBeNull();
    expect(status.consecutiveFailures).toBe(0);
    expect(status.sinceLastAttemptMs).toBe(0);
  });

  it('settles a timed-out peer request softly and reports timed-out health', async () => {
    const contactShare = new ContactShareReadModel();
    const applyRemoteTaskProjection = vi.spyOn(contactShare, 'applyRemoteTaskProjection');
    const revokeRemoteSharedTask = vi.spyOn(contactShare, 'revokeRemoteSharedTask');
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_UPDATE_POLL_TIMEOUT_MS: '5000',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
      },
      contactShare,
      fetchImpl: vi.fn(async () => {
        throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
      }) as unknown as typeof fetch,
      setIntervalImpl: vi.fn() as unknown as typeof setInterval,
    });

    // A hung peer must settle (resolve, not hang) and never revoke projections.
    await expect(poller.pollOnce()).resolves.toBe(0);
    expect(applyRemoteTaskProjection).not.toHaveBeenCalled();
    expect(revokeRemoteSharedTask).not.toHaveBeenCalled();
    const status = poller.getStatus();
    expect(status.state).toBe('timed-out');
    expect(status.lastFailureReason).toBe('timeout after 5000ms');
    expect(status.consecutiveFailures).toBe(1);
  });

  it('aborts a genuinely hung peer request at the deadline', async () => {
    // fetchImpl that never resolves on its own — it only rejects when the
    // request signal fires, so this proves AbortSignal.timeout actually cuts
    // off a hung peer rather than the poll hanging forever.
    const fetchImpl = ((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason));
    })) as unknown as typeof fetch;
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_UPDATE_POLL_TIMEOUT_MS: '500',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
      },
      contactShare: new ContactShareReadModel(),
      fetchImpl,
      setIntervalImpl: vi.fn() as unknown as typeof setInterval,
    });

    await expect(poller.pollOnce()).resolves.toBe(0);
    const status = poller.getStatus();
    expect(status.state).toBe('timed-out');
    expect(status.lastFailureReason).toBe('timeout after 500ms');
  });

  it('reports a hard (non-timeout) error as failing immediately and recovers on success', async () => {
    let ok = false;
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
      },
      contactShare: new ContactShareReadModel(),
      fetchImpl: vi.fn(async () => ok
        ? new Response(JSON.stringify({
          schemaVersion: 'collaboration-shared-task-updates.v1',
          updates: [],
          removals: [],
        }), { status: 200 })
        : new Response('', { status: 503 })) as typeof fetch,
      setIntervalImpl: vi.fn() as unknown as typeof setInterval,
    });

    // A hard error is not a transient timeout — it reads as failing on the
    // first hit, no tolerance window.
    await poller.pollOnce();
    expect(poller.getStatus().state).toBe('failing');
    expect(poller.getStatus().consecutiveFailures).toBe(1);
    expect(poller.getStatus().lastFailureReason).toBe('http 503');

    ok = true;
    await poller.pollOnce();
    expect(poller.getStatus().state).toBe('healthy');
    expect(poller.getStatus().consecutiveFailures).toBe(0);
  });

  it('tolerates a couple of timeouts as timed-out, then escalates to failing', async () => {
    const poller = startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
      },
      contactShare: new ContactShareReadModel(),
      fetchImpl: vi.fn(async () => {
        throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
      }) as unknown as typeof fetch,
      setIntervalImpl: vi.fn() as unknown as typeof setInterval,
    });

    await poller.pollOnce();
    expect(poller.getStatus().state).toBe('timed-out');
    await poller.pollOnce();
    expect(poller.getStatus().state).toBe('timed-out'); // still within the tolerance window
    await poller.pollOnce();
    // Third consecutive timeout crosses FAILING_THRESHOLD -> sticky failing.
    expect(poller.getStatus().consecutiveFailures).toBe(3);
    expect(poller.getStatus().state).toBe('failing');
  });

  it('skips an interval tick while a previous poll is still in flight', async () => {
    let capturedCallback: (() => void) | undefined;
    const setIntervalImpl = vi.fn((cb: () => void) => {
      capturedCallback = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));

    startPrivateNetworkSharedTaskUpdatePoller({
      config: enabledConfig(),
      env: {
        KOOKR_COLLABORATION_UPDATE_POLLING: 'true',
        KOOKR_COLLABORATION_LOCAL_CONTACT_ID: 'contact-1',
        KOOKR_COLLABORATION_LOCAL_DEVICE_ID: 'device-1',
        KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM: privateKey(),
      },
      contactShare: new ContactShareReadModel(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      setIntervalImpl,
    });

    expect(capturedCallback).toBeDefined();
    // First tick starts a poll; the fetch never resolves yet.
    capturedCallback?.();
    // Second and third ticks must be suppressed while the poll is in flight.
    capturedCallback?.();
    capturedCallback?.();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Let the in-flight poll settle, then a later tick may poll again.
    resolveFetch?.(new Response(JSON.stringify({
      schemaVersion: 'collaboration-shared-task-updates.v1',
      updates: [],
      removals: [],
    }), { status: 200 }));
    // Flush the poll's remaining awaits (response.json(), apply loop, finally).
    await new Promise((resolve) => setTimeout(resolve, 0));
    capturedCallback?.();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
