import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { TaskStore } from '../../core/tasks.js';
import { ContactShareReadModel } from '../../core/contact-share.js';
import type { ContactShareEnvelope } from '../../shared/contracts/contact-share.js';
import { registerContactShareRoutes } from './contact-share-routes.js';
import { registerTaskRoutes } from './task-routes.js';
import type { RouteDeps } from './shared.js';

function deps(): RouteDeps & { sentContactShareEnvelopes: ContactShareEnvelope[] } {
  const taskStore = new TaskStore();
  const sentContactShareEnvelopes: ContactShareEnvelope[] = [];
  return {
    taskStore,
    contactShare: new ContactShareReadModel(),
    remoteShare: {
      csrfToken: 'csrf-share',
      client: {
        createTaskShare: vi.fn(),
        revokeTaskShare: vi.fn(),
        listTaskShares: vi.fn(),
        approveGrantRequest: vi.fn(),
        denyGrantRequest: vi.fn(),
        sendContactShareEnvelope: vi.fn(async (envelope: ContactShareEnvelope) => {
          sentContactShareEnvelopes.push(envelope);
          return envelope;
        }),
      },
    },
    monitor: { getSnapshot: () => [], unregisterAgent: vi.fn(), getAgentEvents: () => [] },
    queue: { peek: () => null, purgeTask: vi.fn() },
    adapter: {},
    hookWatcher: {},
    watchdog: {},
    interactionLog: { append: vi.fn() },
    githubScanner: {},
    githubStateStore: {},
    buildInfo: {},
    serverStartedAt: '2026-05-18T10:00:00.000Z',
    serverCwd: '/tmp/kookr',
    serverPort: 4801,
    kookrDir: '/tmp/kookr-state',
    frontendDir: '/tmp/kookr-frontend',
    broadcastToAll: vi.fn(),
    launchServiceDeps: {},
    ralphLoopService: {},
    sentContactShareEnvelopes,
  } as unknown as RouteDeps & { sentContactShareEnvelopes: ContactShareEnvelope[] };
}

async function post(app: Hono, path: string, body: unknown) {
  return app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Origin: 'http://localhost',
      'x-kookr-csrf': 'csrf-share',
    },
    body: JSON.stringify(body),
  });
}

describe('contact share routes', () => {
  it('pairs verified contacts and sends ciphertext invite envelopes only', async () => {
    const routeDeps = deps();
    const task = routeDeps.taskStore.createTask({ prompt: 'secret prompt', cwd: '/secret/path' });
    routeDeps.taskStore.renameTask(task.id, 'Fix auth regression');
    const app = new Hono();
    registerContactShareRoutes(app, routeDeps);

    const contactRes = await post(app, '/api/contact-share/contacts', {
      contactId: 'contact-alice',
      displayName: 'Alice',
      verifiedFingerprint: 'fp-alice',
      devices: [{ deviceId: 'alice-laptop', publicKey: 'pub-alice' }],
      trustState: 'verified',
    });
    expect(contactRes.status).toBe(201);

    const shareRes = await post(app, '/api/contact-share/shares', {
      taskId: task.id,
      contactId: 'contact-alice',
      recipientDeviceId: 'alice-laptop',
    });
    expect(shareRes.status).toBe(201);
    const body = await shareRes.json() as {
      envelope: Record<string, unknown>;
      notification: Record<string, unknown>;
    };
    expect(body.envelope).toEqual(expect.objectContaining({
      schemaVersion: 'contact-share-envelope.v1',
      kind: 'share.invite',
      recipientDeviceId: 'alice-laptop',
      ciphertext: expect.stringMatching(/^sealed:[A-Za-z0-9_-]+$/),
      senderSignature: expect.stringMatching(/^sig:[A-Za-z0-9_-]+$/),
    }));
    expect(JSON.stringify(body.envelope)).not.toContain('Fix auth regression');
    expect(JSON.stringify(body.envelope)).not.toContain('/secret/path');
    expect(JSON.stringify(body.envelope)).not.toContain(task.id);
    expect(body.notification).toEqual(expect.objectContaining({ redacted: true }));
    expect(routeDeps.sentContactShareEnvelopes).toHaveLength(1);
    expect(routeDeps.sentContactShareEnvelopes[0]).toEqual(expect.objectContaining({
      envelopeId: body.envelope.envelopeId,
      recipientDeviceId: 'alice-laptop',
      ciphertext: body.envelope.ciphertext,
    }));
  });

  it('rejects SharedTask IDs before publishing a Contact Share envelope', async () => {
    const routeDeps = deps();
    const app = new Hono();
    registerContactShareRoutes(app, routeDeps);

    const shareRes = await post(app, '/api/contact-share/shares', {
      taskId: 'shared:share-1',
      contactId: 'contact-alice',
      recipientDeviceId: 'alice-laptop',
    });

    expect(shareRes.status).toBe(400);
    await expect(shareRes.json()).resolves.toEqual({ error: 'local taskId is required' });
    expect(routeDeps.sentContactShareEnvelopes).toEqual([]);
    expect(routeDeps.remoteShare?.client?.sendContactShareEnvelope).not.toHaveBeenCalled();
  });

  it('accepts decrypted inbox items into SharedTask projections and refuses without one', async () => {
    const routeDeps = deps();
    const app = new Hono();
    registerContactShareRoutes(app, routeDeps);

    const decrypted = await post(app, '/api/contact-share/inbox/share-1/decrypted-invite', {
      ownerContactId: 'contact-jean',
      ownerDisplayName: 'Jean',
      ownerNodeLabel: 'desktop',
      originNodeId: 'kookr-node-owner',
      remoteTaskId: 'task-origin',
      taskLabel: 'Fix auth regression',
      grants: ['view', 'terminalView'],
      remoteStatus: 'needsInput',
    });
    expect(decrypted.status).toBe(201);

    const accepted = await post(app, '/api/contact-share/inbox/share-1/accept', {
      recipientDeviceId: 'local-device',
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      sharedTask: expect.objectContaining({
        kind: 'shared-task',
        sharedTaskId: 'shared:share-1',
        ownerDisplayName: 'Jean',
        ownerNodeLabel: 'desktop',
        originNodeId: 'kookr-node-owner',
        remoteTaskId: 'task-origin',
        shareId: 'share-1',
        grants: ['view', 'terminalView'],
      }),
    });

    const refusedInvite = await post(app, '/api/contact-share/inbox/share-2/decrypted-invite', {
      ownerContactId: 'contact-jean',
      ownerDisplayName: 'Jean',
      remoteTaskId: 'task-origin-2',
      taskLabel: 'Do not create local task',
      grants: ['view'],
      remoteStatus: 'pending',
    });
    expect(refusedInvite.status).toBe(201);
    const refused = await post(app, '/api/contact-share/inbox/share-2/refuse', {
      recipientDeviceId: 'local-device',
    });
    expect(refused.status).toBe(200);
    const listed = await app.request('/api/contact-share/shared-tasks');
    await expect(listed.json()).resolves.toEqual({
      sharedTasks: [expect.objectContaining({ sharedTaskId: 'shared:share-1' })],
    });
  });

  it('rejects SharedTask IDs on local task mutation routes', async () => {
    const routeDeps = deps();
    const app = new Hono();
    registerTaskRoutes(app, routeDeps);

    const rename = await app.request('/api/tasks/shared%3Ashare-1/name', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'local rename' }),
    });
    expect(rename.status).toBe(403);

    const deleted = await app.request('/api/tasks/shared%3Ashare-1', { method: 'DELETE' });
    expect(deleted.status).toBe(403);
  });
});
