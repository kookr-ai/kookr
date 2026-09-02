import { createHash, createSign, randomUUID } from 'node:crypto';

import type { ContactShareReadModel } from '../core/contact-share.js';
import type { RemoteTaskProjectionV1 } from '../shared/contracts/remote-share.js';
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

export type CollaborationUpdatePollerHealth =
  | 'disabled'
  | 'healthy'
  | 'timed-out'
  | 'failing';

export interface CollaborationUpdatePollerStatus {
  /**
   * Coarse health for diagnostics:
   * - `disabled`: the poller is not running.
   * - `healthy`: polling is active and nothing has failed since the last
   *   success (also the startup state, before the first poll completes).
   * - `timed-out`: the recent poll(s) hit the request deadline but not yet
   *   often enough to treat the poller as broken (a transient half-open peer).
   * - `failing`: the poller is failing — either a hard (non-timeout) error, or
   *   timeouts that have persisted past the tolerance threshold.
   */
  state: CollaborationUpdatePollerHealth;
  /** ISO timestamp of the last poll that completed without error, or null. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the last poll that timed out or errored, or null. */
  lastFailureAt: string | null;
  /** Short reason for the most recent failure (e.g. "timeout after 10000ms", "http 503"), or null. */
  lastFailureReason: string | null;
  /** Consecutive failing polls since the last success; reset to 0 on success. */
  consecutiveFailures: number;
  /** Milliseconds since the most recent poll attempt started, or null before the first attempt. */
  sinceLastAttemptMs: number | null;
}

export interface CollaborationUpdatePollerHandle {
  status: 'disabled' | 'polling';
  pollOnce(): Promise<number>;
  /** Point-in-time health record so operators can tell disabled/healthy/timed-out/failing apart. */
  getStatus(): CollaborationUpdatePollerStatus;
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

function readPollTimeoutMs(env: CollaborationConfigEnv): number {
  const parsed = Number(env.KOOKR_COLLABORATION_UPDATE_POLL_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed >= 500 ? parsed : 10_000;
}

function isTimeoutError(err: unknown): boolean {
  // AbortSignal.timeout() aborts with a DOMException named "TimeoutError";
  // some runtimes surface a plain "AbortError". Treat both as a deadline hit.
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
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
      getStatus: () => ({
        state: 'disabled',
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureReason: null,
        consecutiveFailures: 0,
        sinceLastAttemptMs: null,
      }),
      stop: () => {},
    };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const timeoutMs = readPollTimeoutMs(opts.env);
  const path = '/api/collaboration/shared-task-updates';

  // How many consecutive timeouts we tolerate as "timed-out" (a transient
  // half-open peer) before escalating to the sticky "failing" state. Hard
  // non-timeout errors skip this tolerance and read as "failing" immediately.
  const FAILING_THRESHOLD = 3;

  let lastAttemptAt: Date | null = null;
  let lastSuccessAt: Date | null = null;
  let lastFailureAt: Date | null = null;
  let lastFailureReason: string | null = null;
  let lastFailureKind: 'timeout' | 'error' | null = null;
  let consecutiveFailures = 0;

  const computeHealth = (): CollaborationUpdatePollerHealth => {
    if (consecutiveFailures === 0) return 'healthy';
    // A run of timeouts stays "timed-out" until it persists past the tolerance
    // threshold; a hard non-timeout error is "failing" from the first hit.
    if (lastFailureKind === 'timeout' && consecutiveFailures < FAILING_THRESHOLD) {
      return 'timed-out';
    }
    return 'failing';
  };

  const recordSuccess = (at: Date): void => {
    lastSuccessAt = at;
    lastFailureKind = null;
    consecutiveFailures = 0;
  };

  const recordFailure = (at: Date, kind: 'timeout' | 'error', reason: string): void => {
    lastFailureAt = at;
    lastFailureKind = kind;
    lastFailureReason = reason;
    consecutiveFailures += 1;
    // Soft-fail: a failed poll (including a deadline hit) never revokes an
    // already-accepted remote projection; it only updates the health record.
    console.warn(
      `[collaboration] shared-task update poll ${kind === 'timeout' ? 'timed out' : 'failed'} `
      + `(${reason}); consecutiveFailures=${consecutiveFailures}, health=${computeHealth()}`,
    );
  };

  const pollOnce = async (): Promise<number> => {
    const attemptAt = now();
    lastAttemptAt = attemptAt;
    let response: Response;
    try {
      response = await fetchImpl(`${peerBaseUrl}${path}`, {
        headers: authHeaders({
          credentials,
          audience: peerBaseUrl,
          path,
          timestamp: attemptAt.toISOString(),
          nonce: randomUUID(),
        }),
        // Abortable request deadline so a half-open peer cannot hold a poll
        // open forever; the next interval tick stays schedulable.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const timedOut = isTimeoutError(err);
      recordFailure(
        now(),
        timedOut ? 'timeout' : 'error',
        timedOut ? `timeout after ${timeoutMs}ms` : (err instanceof Error ? err.message : String(err)),
      );
      return 0;
    }
    if (!response.ok) {
      recordFailure(now(), 'error', `http ${response.status}`);
      return 0;
    }
    const body = await response.json().catch(() => null) as unknown;
    if (!isUpdatesResponse(body)) {
      recordFailure(now(), 'error', 'malformed response body');
      return 0;
    }
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
    recordSuccess(now());
    return applied;
  };

  const setIntervalImpl = opts.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl ?? clearInterval;
  let inFlight = false;
  const interval = setIntervalImpl(() => {
    // In-flight guard: a slow or hung peer must not accumulate overlapping
    // polls. Skip this tick while the previous poll is still settling; the
    // request deadline above guarantees the in-flight poll eventually clears.
    if (inFlight) return;
    inFlight = true;
    void pollOnce()
      .catch(() => {
        // pollOnce records and logs its own failures; this catch only guards
        // against an unexpected throw so the interval never emits an
        // unhandled rejection.
      })
      .finally(() => {
        inFlight = false;
      });
  }, readPollIntervalMs(opts.env));

  return {
    status: 'polling',
    pollOnce,
    getStatus: () => ({
      state: computeHealth(),
      lastSuccessAt: lastSuccessAt ? lastSuccessAt.toISOString() : null,
      lastFailureAt: lastFailureAt ? lastFailureAt.toISOString() : null,
      lastFailureReason,
      consecutiveFailures,
      sinceLastAttemptMs: lastAttemptAt ? now().getTime() - lastAttemptAt.getTime() : null,
    }),
    stop: () => clearIntervalImpl(interval),
  };
}
