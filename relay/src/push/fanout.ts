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

export interface PushFanout {
  sendToNode(nodeId: NodeId, payload: RedactedPushPayload): Promise<PushDeliveryOutcome[]>;
  sendToDevice(deviceId: string, payload: RedactedPushPayload): Promise<PushDeliveryOutcome>;
}

export function createPushFanout(opts: {
  subscriptions: PushSubscriptionStore;
  vapidKeys: VapidKeyStore;
  subject?: string;
  disabled?: boolean;
  sender?: PushSender;
  endpointResolver?: LookupFunction;
}): PushFanout {
  const sender = opts.sender ?? ((subscription, payload, options) => webpush.sendNotification(subscription, payload, options));
  const endpointValidationAgent = createPushEndpointValidationAgent(opts.endpointResolver);
  const subject = opts.subject ?? 'mailto:ops@kookr.local';

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

    try {
      await sender(stored.subscription, JSON.stringify(payload), {
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
      const statusCode = typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : undefined;
      if (statusCode === 404 || statusCode === 410) {
        opts.subscriptions.remove(deviceId);
        return { deviceId, result: 'gone', statusCode };
      }
      return {
        deviceId,
        result: 'failed',
        ...(statusCode ? { statusCode } : {}),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    async sendToNode(nodeId, payload) {
      return await Promise.all(opts.subscriptions.byNode(nodeId).map((sub) => deliver(sub.deviceId, payload)));
    },
    sendToDevice: deliver,
  };
}
