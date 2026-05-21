import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { getRequestListener } from '@hono/node-server';
import { Hono, type Context } from 'hono';

import {
  COLLABORATION_HEALTH_SCHEMA_VERSION,
  type CollaborationHealthResponse,
} from '../shared/contracts/collaboration-profile.js';
import {
  COLLABORATION_SHARED_TASK_UPDATES_SCHEMA_VERSION,
  type CollaborationSharedTaskUpdate,
  type ListCollaborationSharedTaskUpdatesResponse,
} from '../shared/contracts/collaboration-share.js';
import type { RemoteTaskProjectionV1 } from '../remote/share-contract.js';
import {
  readPrivateNetworkCollaborationConfig,
  type CollaborationConfigEnv,
  type CollaborationListenerConfig,
} from './collaboration-config.js';
import {
  CollaborationPairingError,
  ContactIdentityStore,
} from './contact-identity-store.js';
import {
  CollaborationShareError,
  CollaborationShareStore,
} from './collaboration-share-store.js';

export interface CollaborationListenerHandle {
  status: 'disabled' | 'listening';
  config: CollaborationListenerConfig;
  httpServer?: Server;
  close(): Promise<void>;
}

export interface CollaborationListenerDeps {
  identityStore?: ContactIdentityStore;
  shareStore?: CollaborationShareStore;
  taskExists?: (taskId: string) => boolean;
  projectTaskForShare?: (taskId: string) => RemoteTaskProjectionV1 | null | undefined;
}

export function buildCollaborationHealthResponse(config: CollaborationListenerConfig): CollaborationHealthResponse {
  return {
    schemaVersion: COLLABORATION_HEALTH_SCHEMA_VERSION,
    profileKind: 'privateNetwork',
    featureFlags: config.featureFlags,
    listener: {
      enabled: config.shouldStartListener,
      host: config.host,
      port: config.port,
      url: config.url,
    },
    profile: config.profile,
    health: config.health,
    rollback: {
      disableFlags: ['privateNetwork', 'listener'],
      behavior: 'reject-new-collaboration-requests-preserve-state',
    },
  };
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

async function requestBodySha256(c: Context): Promise<string> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') {
    return createHash('sha256').update('').digest('hex');
  }
  const body = Buffer.from(await c.req.raw.clone().arrayBuffer());
  return createHash('sha256').update(body).digest('hex');
}

function pairingErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof CollaborationPairingError) {
    return c.json({ error: err.code }, err.status as never);
  }
  throw err;
}

function shareErrorResponse(c: Context, err: unknown): Response {
  if (err instanceof CollaborationShareError) {
    return c.json({ error: err.code }, err.status as never);
  }
  if (err instanceof CollaborationPairingError) return c.json({ error: err.code }, err.status as never);
  throw err;
}

function createCollaborationApp(config: CollaborationListenerConfig, deps: Required<CollaborationListenerDeps>): Hono {
  const app = new Hono();

  app.get('/api/collaboration/health', (c) => c.json(buildCollaborationHealthResponse(config)));

  app.post('/api/collaboration/pairing/offers', async (c) => {
    try {
      return c.json(await deps.identityStore.createPairingOffer(await readJsonBody(c)), 201);
    } catch (err) {
      return pairingErrorResponse(c, err);
    }
  });

  app.post('/api/collaboration/pairing/accept', async (c) => {
    try {
      return c.json(await deps.identityStore.acceptPairingOffer(await readJsonBody(c)), 201);
    } catch (err) {
      return pairingErrorResponse(c, err);
    }
  });

  const verifyDevice = async (c: Context) => {
    const url = new URL(c.req.url);
    return deps.identityStore.verifyDeviceRequest({
      contactId: c.req.header('x-kookr-contact-id'),
      deviceId: c.req.header('x-kookr-device-id'),
      audience: config.url,
      method: c.req.method,
      path: c.req.path,
      query: url.search,
      bodySha256: await requestBodySha256(c),
      timestamp: c.req.header('x-kookr-request-timestamp'),
      nonce: c.req.header('x-kookr-request-nonce'),
      signature: c.req.header('x-kookr-request-signature'),
    });
  };

  app.post('/api/collaboration/contact-share/invites', async (c) => {
    try {
      const principal = await verifyDevice(c);
      if (!config.featureFlags.contactShareViewOnly) return c.json({ error: 'contact-share-view-only-disabled' }, 404);
      const invite = await deps.shareStore.receiveInvite(principal, await readJsonBody(c));
      return c.json({ invite }, 201);
    } catch (err) {
      return shareErrorResponse(c, err);
    }
  });

  app.post('/api/collaboration/contact-share/decisions', async (c) => {
    try {
      const principal = await verifyDevice(c);
      if (!config.featureFlags.contactShareViewOnly) return c.json({ error: 'contact-share-view-only-disabled' }, 404);
      return c.json(await deps.shareStore.decide(principal, await readJsonBody(c)));
    } catch (err) {
      return shareErrorResponse(c, err);
    }
  });

  app.get('/api/collaboration/shared-task-updates', async (c) => {
    try {
      const principal = await verifyDevice(c);
      if (!config.featureFlags.contactShareViewOnly) return c.json({ error: 'contact-share-view-only-disabled' }, 404);
      const updates: CollaborationSharedTaskUpdate[] = deps.shareStore
        .listActiveTaskSharesForPrincipal(principal)
        .flatMap(({ invite, grant }) => {
          const projection = deps.projectTaskForShare(grant.subject.taskId);
          if (!projection) return [];
          return [{
            inviteId: invite.inviteId,
            grantId: grant.grantId,
            policyVersion: grant.policyVersion,
            ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
            projection,
          }];
        });
      const response: ListCollaborationSharedTaskUpdatesResponse = {
        schemaVersion: COLLABORATION_SHARED_TASK_UPDATES_SCHEMA_VERSION,
        updates,
        removals: deps.shareStore.listRemovedTaskSharesForPrincipal(principal),
      };
      return c.json(response);
    } catch (err) {
      if (err instanceof CollaborationPairingError) return c.json({ error: err.code }, err.status as never);
      throw err;
    }
  });

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not Found' }, 404);
    return c.text('Not Found', 404);
  });

  return app;
}

export async function startPrivateNetworkCollaborationListener(
  config: CollaborationListenerConfig,
  deps: CollaborationListenerDeps = {},
): Promise<CollaborationListenerHandle> {
  if (!config.shouldStartListener) {
    return {
      status: 'disabled',
      config,
      close: async () => {},
    };
  }

  const identityStore = deps.identityStore ?? new ContactIdentityStore();
  const shareStore = deps.shareStore ?? new CollaborationShareStore({ taskExists: deps.taskExists });
  await identityStore.load();
  await shareStore.load();
  const app = createCollaborationApp(config, {
    identityStore,
    shareStore,
    taskExists: deps.taskExists ?? (() => true),
    projectTaskForShare: deps.projectTaskForShare ?? (() => null),
  });
  const httpServer = createServer(getRequestListener(app.fetch));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      httpServer.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(config.port, config.host);
  });

  console.log(`Kookr collaboration listener listening on ${config.url}`);

  return {
    status: 'listening',
    config,
    httpServer,
    close: () => new Promise((resolve, reject) => {
      httpServer.close((err) => err ? reject(err) : resolve());
    }),
  };
}

export async function startConfiguredPrivateNetworkCollaborationListener(opts: {
  env: CollaborationConfigEnv;
  dashboardHost: string;
  dashboardPort: number;
  kookrDir?: string;
  taskExists?: (taskId: string) => boolean;
  projectTaskForShare?: (taskId: string) => RemoteTaskProjectionV1 | null | undefined;
}): Promise<CollaborationListenerHandle> {
  const config = readPrivateNetworkCollaborationConfig({
    env: opts.env,
    dashboardHost: opts.dashboardHost,
    dashboardPort: opts.dashboardPort,
  });

  try {
    return await startPrivateNetworkCollaborationListener(config, {
      identityStore: new ContactIdentityStore({ kookrDir: opts.kookrDir }),
      shareStore: new CollaborationShareStore({ kookrDir: opts.kookrDir, taskExists: opts.taskExists }),
      taskExists: opts.taskExists,
      projectTaskForShare: opts.projectTaskForShare,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[collaboration] listener unavailable: ${detail}`);
    return {
      status: 'disabled',
      config: {
        ...config,
        health: { state: 'unreachable', checkedAt: new Date().toISOString(), detail },
        shouldStartListener: false,
      },
      close: async () => {},
    };
  }
}
