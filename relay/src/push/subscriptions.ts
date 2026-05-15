import type webpush from 'web-push';
import type { NodeId } from '../../../src/remote/ids.js';

export interface StoredPushSubscription {
  deviceId: string;
  nodeId: NodeId;
  subscription: webpush.PushSubscription;
  vapidKeyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PushSubscriptionStore {
  upsert(opts: {
    nodeId: NodeId;
    deviceId: string;
    subscription: webpush.PushSubscription;
    vapidKeyVersion: number;
    now?: Date;
  }): StoredPushSubscription;
  remove(deviceId: string): boolean;
  byDevice(deviceId: string): StoredPushSubscription | undefined;
  byNode(nodeId: NodeId): StoredPushSubscription[];
  invalidateVersion(version: number): number;
  list(): StoredPushSubscription[];
}

export function createPushSubscriptionStore(): PushSubscriptionStore {
  const subscriptions = new Map<string, StoredPushSubscription>();

  return {
    upsert({ nodeId, deviceId, subscription, vapidKeyVersion, now = new Date() }) {
      const existing = subscriptions.get(deviceId);
      const stored: StoredPushSubscription = {
        deviceId,
        nodeId,
        subscription,
        vapidKeyVersion,
        createdAt: existing?.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
      };
      subscriptions.set(deviceId, stored);
      return stored;
    },
    remove(deviceId) {
      return subscriptions.delete(deviceId);
    },
    byDevice(deviceId) {
      return subscriptions.get(deviceId);
    },
    byNode(nodeId) {
      return [...subscriptions.values()].filter((sub) => sub.nodeId === nodeId);
    },
    invalidateVersion(version) {
      let removed = 0;
      for (const sub of subscriptions.values()) {
        if (sub.vapidKeyVersion !== version) {
          subscriptions.delete(sub.deviceId);
          removed += 1;
        }
      }
      return removed;
    },
    list() {
      return [...subscriptions.values()];
    },
  };
}

export function isPushSubscription(value: unknown): value is webpush.PushSubscription {
  const sub = value as Partial<webpush.PushSubscription>;
  const keys = sub.keys as Partial<webpush.PushSubscription['keys']> | undefined;
  return typeof value === 'object'
    && value !== null
    && typeof sub.endpoint === 'string'
    && typeof keys?.p256dh === 'string'
    && typeof keys.auth === 'string';
}
