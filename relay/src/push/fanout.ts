import webpush from 'web-push';
import type { LookupFunction } from 'node:net';

import type { NodeId } from '../../../src/remote/ids.js';
import type { RedactedPushPayload } from '../../../src/remote/push.js';
import type { PushSubscriptionStore } from './subscriptions.js';
import { createPushEndpointValidationAgent, validatePushEndpoint } from './validate-endpoint.js';
import type { VapidKeyStore } from './vapid.js';

export type PushDeliveryResult = 'sent' | 'skipped-disabled' | 'gone' | 'failed';

export interface PushDeliveryOutcome {
  deviceId: string;
  result: PushDeliveryResult;
  statusCode?: number;
  error?: string;
}

export type PushSender = (
  subscription: webpush.PushSubscription,
  payload: string,
  options: webpush.RequestOptions,
) => Promise<unknown>;

export type PushRetrySleep = (ms: number) => Promise<void>;

export interface PushFanout {
  sendToNode(nodeId: NodeId, payload: RedactedPushPayload): Promise<PushDeliveryOutcome[]>;
  sendToDevice(deviceId: string, payload: RedactedPushPayload): Promise<PushDeliveryOutcome>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;

export function createPushFanout(opts: {
  subscriptions: PushSubscriptionStore;
  vapidKeys: VapidKeyStore;
  subject?: string;
  disabled?: boolean;
  sender?: PushSender;
  endpointResolver?: LookupFunction;
  maxAttempts?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  sleep?: PushRetrySleep;
}): PushFanout {
  const sender = opts.sender ?? ((subscription, payload, options) => webpush.sendNotification(subscription, payload, options));
  const endpointValidationAgent = createPushEndpointValidationAgent(opts.endpointResolver);
  const subject = opts.subject ?? 'mailto:ops@kookr.local';
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const initialRetryDelayMs = Math.max(0, Math.floor(opts.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS));
  const maxRetryDelayMs = Math.max(0, Math.floor(opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS));
  const sleep = opts.sleep ?? delay;

  async function deliver(deviceId: string, payload: RedactedPushPayload): Promise<PushDeliveryOutcome> {
    if (opts.disabled) return { deviceId, result: 'skipped-disabled' };
    const stored = opts.subscriptions.byDevice(deviceId);
    if (!stored) return { deviceId, result: 'gone', statusCode: 404 };
    const vapid = opts.vapidKeys.current();
    if (stored.vapidKeyVersion !== vapid.version) {
      opts.subscriptions.remove(deviceId);
      return { deviceId, result: 'gone', statusCode: 410 };
    }
    const endpointValidation = validatePushEndpoint(stored.subscription.endpoint);
    if (!endpointValidation.ok) {
      opts.subscriptions.remove(deviceId);
      return {
        deviceId,
        result: 'failed',
        statusCode: 400,
        error: endpointValidation.reason,
      };
    }

    const body = JSON.stringify(payload);
    let lastFailure: PushDeliveryOutcome | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await sender(stored.subscription, body, {
          vapidDetails: {
            subject,
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
          TTL: 300,
          agent: endpointValidationAgent,
        });
        return { deviceId, result: 'sent' };
      } catch (err) {
        const statusCode = statusCodeFromError(err);
        if (statusCode === 404 || statusCode === 410) {
          opts.subscriptions.remove(deviceId);
          return { deviceId, result: 'gone', statusCode };
        }

        lastFailure = {
          deviceId,
          result: 'failed',
          ...(statusCode ? { statusCode } : {}),
          error: err instanceof Error ? err.message : String(err),
        };

        if (attempt >= maxAttempts || !isRetryablePushFailure(statusCode)) {
          return lastFailure;
        }

        await sleep(retryDelayMs({
          attempt,
          initialRetryDelayMs,
          maxRetryDelayMs,
          retryAfter: retryAfterFromError(err),
        }));
      }
    }

    // Defensive fallback for future option changes that could make the retry loop skip all attempts.
    return lastFailure ?? { deviceId, result: 'failed', error: 'unknown push delivery failure' };
  }

  return {
    async sendToNode(nodeId, payload) {
      return await Promise.all(opts.subscriptions.byNode(nodeId).map((sub) => deliver(sub.deviceId, payload)));
    },
    sendToDevice: deliver,
  };
}

function statusCodeFromError(err: unknown): number | undefined {
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function isRetryablePushFailure(statusCode: number | undefined): boolean {
  if (statusCode === undefined) return true;
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}

function retryDelayMs(opts: {
  attempt: number;
  initialRetryDelayMs: number;
  maxRetryDelayMs: number;
  retryAfter?: string;
}): number {
  const retryAfterDelay = parseRetryAfterMs(opts.retryAfter);
  const backoffDelay = opts.initialRetryDelayMs * 2 ** (opts.attempt - 1);
  return Math.min(retryAfterDelay ?? backoffDelay, opts.maxRetryDelayMs);
}

function retryAfterFromError(err: unknown): string | undefined {
  const headers = (err as { headers?: unknown }).headers;
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get('retry-after');
    return value ?? undefined;
  }
  const value = (headers as Record<string, unknown>)['retry-after'] ?? (headers as Record<string, unknown>)['Retry-After'];
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function parseRetryAfterMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1_000);
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - Date.now());
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
