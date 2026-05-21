import { createServer, type Server } from 'node:http';

import { getRequestListener } from '@hono/node-server';
import { Hono, type Context } from 'hono';

import {
  COLLABORATION_HEALTH_SCHEMA_VERSION,
  type CollaborationHealthResponse,
} from '../shared/contracts/collaboration-profile.js';
import {
  readPrivateNetworkCollaborationConfig,
  type CollaborationConfigEnv,
  type CollaborationListenerConfig,
} from './collaboration-config.js';

export interface CollaborationListenerHandle {
  status: 'disabled' | 'listening';
  config: CollaborationListenerConfig;
  httpServer?: Server;
  close(): Promise<void>;
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

function createCollaborationApp(config: CollaborationListenerConfig): Hono {
  const app = new Hono();

  app.get('/api/collaboration/health', (c) => c.json(buildCollaborationHealthResponse(config)));

  app.post('/api/collaboration/pairing/offers', (c) => c.json({
    error: 'pairing-bootstrap-not-implemented',
    allowedFields: ['publicKey', 'nonce', 'commitment', 'expiresAt', 'label'],
  }, 501));

  app.post('/api/collaboration/pairing/accept', (c) => c.json({
    error: 'pairing-bootstrap-not-implemented',
    allowedFields: ['pairingId', 'publicKey', 'nonce', 'commitment', 'expiresAt', 'label'],
  }, 501));

  const requireVerifiedDevice = (c: Context) => c.json({
    error: 'verified-device-required',
  }, 401);

  app.post('/api/collaboration/contact-share/invites', requireVerifiedDevice);
  app.post('/api/collaboration/contact-share/decisions', requireVerifiedDevice);
  app.get('/api/collaboration/shared-task-updates', requireVerifiedDevice);

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Not Found' }, 404);
    return c.text('Not Found', 404);
  });

  return app;
}

export async function startPrivateNetworkCollaborationListener(
  config: CollaborationListenerConfig,
): Promise<CollaborationListenerHandle> {
  if (!config.shouldStartListener) {
    return {
      status: 'disabled',
      config,
      close: async () => {},
    };
  }

  const app = createCollaborationApp(config);
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
}): Promise<CollaborationListenerHandle> {
  const config = readPrivateNetworkCollaborationConfig({
    env: opts.env,
    dashboardHost: opts.dashboardHost,
    dashboardPort: opts.dashboardPort,
  });

  try {
    return await startPrivateNetworkCollaborationListener(config);
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
