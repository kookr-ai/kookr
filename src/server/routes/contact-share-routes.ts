import type { Context, Hono } from 'hono';
import { randomBytes, randomUUID } from 'node:crypto';

import { ContactShareReadModel } from '../../core/contact-share.js';
import { asNodeId } from '../../remote/ids.js';
import type {
  AcceptContactShareApiResponse,
  ContactShareEnvelope,
  CreateContactShareApiResponse,
  DecryptedContactShareInvite,
  KookrContact,
  ListContactShareContactsApiResponse,
  ListContactShareInboxApiResponse,
  ListSharedTasksApiResponse,
} from '../../shared/contracts/contact-share.js';
import { isSharedTaskId } from '../../shared/contracts/contact-share.js';
import { sanitizeRemoteTaskLabel } from '../share-projection.js';
import { evaluateShareMutationGuard, SHARE_CSRF_HEADER } from './share-routes.js';
import type { RouteDeps } from './shared.js';

function parseContact(value: unknown): KookrContact | null {
  const contact = value as Partial<KookrContact>;
  if (
    typeof value !== 'object'
    || value === null
    || typeof contact.contactId !== 'string'
    || typeof contact.displayName !== 'string'
    || typeof contact.verifiedFingerprint !== 'string'
    || !Array.isArray(contact.devices)
    || !contact.devices.every((device) => (
      typeof device === 'object'
      && device !== null
      && typeof device.deviceId === 'string'
      && typeof device.publicKey === 'string'
      && ((device as { label?: unknown }).label === undefined || typeof (device as { label?: unknown }).label === 'string')
      && ((device as { lastSeenAt?: unknown }).lastSeenAt === undefined || typeof (device as { lastSeenAt?: unknown }).lastSeenAt === 'string')
    ))
    || (
      contact.trustState !== 'verified'
      && contact.trustState !== 'rotated-unverified'
      && contact.trustState !== 'blocked'
    )
  ) {
    return null;
  }
  return {
    contactId: contact.contactId,
    displayName: contact.displayName,
    verifiedFingerprint: contact.verifiedFingerprint,
    devices: contact.devices.map((device) => ({ ...device })),
    trustState: contact.trustState,
  };
}

function opaqueContactShareSecret(prefix: 'sealed' | 'sig'): string {
  return `${prefix}:${randomBytes(48).toString('base64url')}`;
}

export function registerContactShareRoutes(app: Hono, deps: RouteDeps): void {
  const contactShare = deps.contactShare ?? new ContactShareReadModel();

  function guardMutation(c: Context) {
    const remoteShare = deps.remoteShare;
    if (!remoteShare?.client) return { ok: false as const, status: 409 as const, error: 'relay-not-configured' };
    return evaluateShareMutationGuard({
      requestUrl: c.req.url,
      origin: c.req.header('Origin'),
      csrfHeader: c.req.header(SHARE_CSRF_HEADER),
      expectedCsrfToken: remoteShare.csrfToken,
    });
  }

  app.get('/api/contact-share/contacts', (c) => {
    const response: ListContactShareContactsApiResponse = { contacts: contactShare.listContacts() };
    return c.json(response);
  });

  app.post('/api/contact-share/contacts', async (c) => {
    const guard = guardMutation(c);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    const parsed = parseContact(await c.req.json().catch(() => null));
    if (!parsed) return c.json({ error: 'valid contact is required' }, 400);
    try {
      return c.json({ contact: contactShare.upsertContact(parsed) }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get('/api/contact-share/inbox', (c) => {
    const response: ListContactShareInboxApiResponse = { inbox: contactShare.listInbox() };
    return c.json(response);
  });

  app.get('/api/contact-share/shared-tasks', (c) => {
    const response: ListSharedTasksApiResponse = { sharedTasks: contactShare.listSharedTasks() };
    return c.json(response);
  });

  app.post('/api/contact-share/shares', async (c) => {
    const guard = guardMutation(c);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);
    const remoteClient = deps.remoteShare?.client;
    if (!remoteClient) return c.json({ error: 'relay-not-configured' }, 409);

    const body = await c.req.json().catch(() => ({})) as {
      taskId?: unknown;
      contactId?: unknown;
      recipientDeviceId?: unknown;
    };
    if (typeof body.taskId !== 'string' || body.taskId.length === 0 || isSharedTaskId(body.taskId)) {
      return c.json({ error: 'local taskId is required' }, 400);
    }
    const task = deps.taskStore.getTask(body.taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    if (typeof body.contactId !== 'string' || typeof body.recipientDeviceId !== 'string') {
      return c.json({ error: 'contactId and recipientDeviceId are required' }, 400);
    }
    const recipient = contactShare.verifiedContacts().find((contact) => contact.contactId === body.contactId);
    const device = recipient?.devices.find((candidate) => candidate.deviceId === body.recipientDeviceId);
    if (!recipient || !device) return c.json({ error: 'verified contact device required' }, 409);

    const now = new Date().toISOString();
    const shareId = `contact-share-${randomUUID()}`;
    const envelope: ContactShareEnvelope = {
      schemaVersion: 'contact-share-envelope.v1',
      envelopeId: `env-${randomUUID()}`,
      shareId,
      decisionVersion: 1,
      senderContactId: 'local-owner',
      recipientContactId: recipient.contactId,
      recipientDeviceId: device.deviceId,
      kind: 'share.invite',
      createdAt: now,
      ciphertext: opaqueContactShareSecret('sealed'),
      senderSignature: opaqueContactShareSecret('sig'),
    };
    const stored = await remoteClient.sendContactShareEnvelope(envelope);
    contactShare.ingestEncryptedEnvelope(stored);

    const response: CreateContactShareApiResponse = {
      envelope: stored,
      notification: {
        title: 'Kookr task shared',
        body: `${recipient.displayName} will receive a redacted Contact Share notification.`,
        redacted: true,
      },
    };
    return c.json(response, 201);
  });

  app.post('/api/contact-share/inbox/:shareId/decrypted-invite', async (c) => {
    const guard = guardMutation(c);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    const body = await c.req.json().catch(() => ({})) as Partial<DecryptedContactShareInvite>;
    const shareId = c.req.param('shareId');
    if (
      typeof body.ownerContactId !== 'string'
      || typeof body.ownerDisplayName !== 'string'
      || typeof body.remoteTaskId !== 'string'
      || typeof body.taskLabel !== 'string'
      || !Array.isArray(body.grants)
      || !body.grants.every((grant) => grant === 'view' || grant === 'terminalView')
      || typeof body.remoteStatus !== 'string'
    ) {
      return c.json({ error: 'valid decrypted invite is required' }, 400);
    }
    const invite: DecryptedContactShareInvite = {
      shareId,
      ownerContactId: body.ownerContactId,
      ownerDisplayName: body.ownerDisplayName,
      ...(typeof body.ownerNodeLabel === 'string' ? { ownerNodeLabel: body.ownerNodeLabel } : {}),
      originNodeId: typeof body.originNodeId === 'string' ? asNodeId(body.originNodeId) : asNodeId('remote-node'),
      remoteTaskId: body.remoteTaskId,
      taskLabel: sanitizeRemoteTaskLabel(body.taskLabel, body.remoteTaskId),
      grants: body.grants,
      remoteStatus: body.remoteStatus as DecryptedContactShareInvite['remoteStatus'],
      ...(body.terminalSubject ? { terminalSubject: body.terminalSubject } : {}),
    };
    return c.json({ inboxItem: contactShare.recordDecryptedInvite(invite) }, 201);
  });

  app.post('/api/contact-share/inbox/:shareId/accept', async (c) => {
    const guard = guardMutation(c);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    const body = await c.req.json().catch(() => ({})) as { recipientDeviceId?: unknown };
    const deviceId = typeof body.recipientDeviceId === 'string' ? body.recipientDeviceId : 'local-device';
    const sharedTask = contactShare.acceptShare(c.req.param('shareId'), deviceId);
    if (!sharedTask) return c.json({ error: 'share not acceptable' }, 409);
    const response: AcceptContactShareApiResponse = { sharedTask };
    return c.json(response);
  });

  app.post('/api/contact-share/inbox/:shareId/refuse', async (c) => {
    const guard = guardMutation(c);
    if (!guard.ok) return c.json({ error: guard.error }, guard.status);

    const body = await c.req.json().catch(() => ({})) as { recipientDeviceId?: unknown };
    const deviceId = typeof body.recipientDeviceId === 'string' ? body.recipientDeviceId : 'local-device';
    contactShare.refuseShare(c.req.param('shareId'), deviceId);
    return c.json({ ok: true });
  });
}
