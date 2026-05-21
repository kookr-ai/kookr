import { createHash, createSign, randomUUID } from 'node:crypto';

import type { ContactShareReadModel } from '../core/contact-share.js';
import type { RemoteTaskProjectionV1 } from '../remote/share-contract.js';
import {
  COLLABORATION_SHARED_TASK_UPDATES_SCHEMA_VERSION,
  type CollaborationSharedTaskRemoval,
  type CollaborationSharedTaskUpdate,
  type ListCollaborationSharedTaskUpdatesResponse,
} from '../shared/contracts/collaboration-share.js';
import type {
  CollaborationConfigEnv,
  CollaborationListenerConfig,
} from './collaboration-config.js';
import { envFlag, optionalString } from './collaboration-config.js';
import { collaborationDeviceRequestPayload } from './contact-identity-store.js';
import { sanitizeRemoteTaskLabel } from './share-projection.js';

interface PollerCredentials {
  contactId: string;
  deviceId: string;
  privateKey: string;
}

export interface CollaborationUpdatePollerHandle {
  status: 'disabled' | 'polling';
  pollOnce(): Promise<number>;
  stop(): void;
}

function readPrivateKey(env: CollaborationConfigEnv): string | undefined {
  const pem = optionalString(env.KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_PEM);
  if (pem) return pem.replaceAll('\\n', '\n');
  const base64 = optionalString(env.KOOKR_COLLABORATION_LOCAL_PRIVATE_KEY_BASE64);
  if (!base64) return undefined;
  try {
    return Buffer.from(base64, 'base64').toString('utf-8');
  } catch {
    return undefined;
  }
}

function readCredentials(env: CollaborationConfigEnv): PollerCredentials | null {
  const contactId = optionalString(env.KOOKR_COLLABORATION_LOCAL_CONTACT_ID);
  const deviceId = optionalString(env.KOOKR_COLLABORATION_LOCAL_DEVICE_ID);
  const privateKey = readPrivateKey(env);
  return contactId && deviceId && privateKey ? { contactId, deviceId, privateKey } : null;
}

function readPollIntervalMs(env: CollaborationConfigEnv): number {
  const parsed = Number(env.KOOKR_COLLABORATION_UPDATE_POLL_INTERVAL_MS);
  return Number.isInteger(parsed) && parsed >= 500 ? parsed : 2_000;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function authHeaders(input: {
  credentials: PollerCredentials;
  audience: string;
  path: string;
  timestamp: string;
  nonce: string;
}): Record<string, string> {
  const bodySha256 = createHash('sha256').update('').digest('hex');
  const signer = createSign('sha256');
  signer.update(collaborationDeviceRequestPayload({
    contactId: input.credentials.contactId,
    deviceId: input.credentials.deviceId,
    audience: input.audience,
    method: 'GET',
    path: input.path,
    query: '',
    bodySha256,
    timestamp: input.timestamp,
    nonce: input.nonce,
  }));
  signer.end();
  return {
    'x-kookr-contact-id': input.credentials.contactId,
    'x-kookr-device-id': input.credentials.deviceId,
    'x-kookr-request-timestamp': input.timestamp,
    'x-kookr-request-nonce': input.nonce,
    'x-kookr-request-signature': signer.sign(input.credentials.privateKey, 'base64url'),
  };
}

function isUpdatesResponse(value: unknown): value is ListCollaborationSharedTaskUpdatesResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Partial<ListCollaborationSharedTaskUpdatesResponse>;
  return body.schemaVersion === COLLABORATION_SHARED_TASK_UPDATES_SCHEMA_VERSION
    && Array.isArray(body.updates)
    && Array.isArray(body.removals);
}

function parseProjection(value: unknown): RemoteTaskProjectionV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const projection = value as Partial<RemoteTaskProjectionV1>;
  if (
    projection.schemaVersion !== 'remote-task-projection.v1'
    || typeof projection.nodeId !== 'string'
    || typeof projection.taskId !== 'string'
    || typeof projection.taskLabel !== 'string'
    || (
      projection.status !== 'pending'
      && projection.status !== 'open'
      && projection.status !== 'inProgress'
      && projection.status !== 'needsInput'
      && projection.status !== 'completed'
      && projection.status !== 'failed'
      && projection.status !== 'cancelled'
    )
    || typeof projection.hasFinding !== 'boolean'
    || typeof projection.needsInput !== 'boolean'
    || typeof projection.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(projection.updatedAt))
  ) {
    return null;
  }
  return {
    schemaVersion: 'remote-task-projection.v1',
    nodeId: projection.nodeId,
    taskId: projection.taskId,
    taskLabel: sanitizeRemoteTaskLabel(projection.taskLabel, projection.taskId),
    status: projection.status,
    hasFinding: projection.hasFinding,
    needsInput: projection.needsInput,
    updatedAt: projection.updatedAt,
  };
}

function parseUpdate(value: unknown): CollaborationSharedTaskUpdate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const update = value as Partial<CollaborationSharedTaskUpdate>;
  const projection = parseProjection(update.projection);
  if (
    typeof update.inviteId !== 'string'
    || typeof update.grantId !== 'string'
    || typeof update.policyVersion !== 'number'
    || !Number.isInteger(update.policyVersion)
    || update.policyVersion < 1
    || (update.expiresAt !== undefined && (typeof update.expiresAt !== 'string' || !Number.isFinite(Date.parse(update.expiresAt))))
    || !projection
  ) {
    return null;
  }
  return {
    inviteId: update.inviteId,
    grantId: update.grantId,
    policyVersion: update.policyVersion,
    ...(update.expiresAt ? { expiresAt: update.expiresAt } : {}),
    projection,
  };
}

function parseRemoval(value: unknown): CollaborationSharedTaskRemoval | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const removal = value as Partial<CollaborationSharedTaskRemoval>;
  if (
    typeof removal.inviteId !== 'string'
    || (removal.reason !== 'revoked' && removal.reason !== 'expired')
    || (
      removal.policyVersion !== undefined
      && (!Number.isInteger(removal.policyVersion) || removal.policyVersion < 1)
    )
    || (
      removal.removedAt !== undefined
      && (typeof removal.removedAt !== 'string' || !Number.isFinite(Date.parse(removal.removedAt)))
    )
  ) {
    return null;
  }
  return {
    inviteId: removal.inviteId,
    reason: removal.reason,
    ...(removal.policyVersion ? { policyVersion: removal.policyVersion } : {}),
    ...(removal.removedAt ? { removedAt: removal.removedAt } : {}),
  };
}

export function startPrivateNetworkSharedTaskUpdatePoller(opts: {
  config: CollaborationListenerConfig;
  env: CollaborationConfigEnv;
  contactShare: ContactShareReadModel;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
}): CollaborationUpdatePollerHandle {
  const credentials = readCredentials(opts.env);
  const peerBaseUrl = opts.config.profile?.peerBaseUrl ? normalizeBaseUrl(opts.config.profile.peerBaseUrl) : null;
  if (!envFlag(opts.env, 'KOOKR_COLLABORATION_UPDATE_POLLING') || !peerBaseUrl || !credentials) {
    return {
      status: 'disabled',
      pollOnce: async () => 0,
      stop: () => {},
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const path = '/api/collaboration/shared-task-updates';
  const pollOnce = async (): Promise<number> => {
    const response = await fetchImpl(`${peerBaseUrl}${path}`, {
      headers: authHeaders({
        credentials,
        audience: peerBaseUrl,
        path,
        timestamp: now().toISOString(),
        nonce: randomUUID(),
      }),
    });
    if (!response.ok) return 0;
    const body = await response.json().catch(() => null) as unknown;
    if (!isUpdatesResponse(body)) return 0;
    let applied = 0;
    for (const rawUpdate of body.updates) {
      const update = parseUpdate(rawUpdate);
      if (!update) continue;
      if (opts.contactShare.applyRemoteTaskProjection(update.inviteId, update.projection, now())) applied += 1;
    }
    for (const rawRemoval of body.removals) {
      const removal = parseRemoval(rawRemoval);
      if (!removal) continue;
      if (opts.contactShare.revokeRemoteSharedTask(removal.inviteId, now())) applied += 1;
    }
    return applied;
  };

  const setIntervalImpl = opts.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl ?? clearInterval;
  const interval = setIntervalImpl(() => {
    pollOnce().catch((err) => {
      console.warn('[collaboration] shared-task update poll failed:', err instanceof Error ? err.message : String(err));
    });
  }, readPollIntervalMs(opts.env));

  return {
    status: 'polling',
    pollOnce,
    stop: () => clearIntervalImpl(interval),
  };
}
