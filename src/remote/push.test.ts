import { describe, expect, it, vi } from 'vitest';

import {
  makeRedactedPushPayload,
  publishPushAlertDelta,
  redactTaskShortLabel,
  taskLabelFallback,
  type RedactedPushPayload,
} from './push.js';
import type { RemoteNodeClient } from './node-client.js';
import { asNodeEpoch, asNodeId } from './ids.js';

describe('push payload redactor', () => {
  it('keeps only the allowlisted payload fields', () => {
    const payload = makeRedactedPushPayload({
      nodeDisplayName: 'Jean laptop',
      taskId: '12345678-aaaa-bbbb-cccc-1234567890ab',
      taskLabel: 'Fix CI, please!',
      alertKind: 'permission-requested',
      alertId: 'alert-1',
    });

    expect(Object.keys(payload).sort()).toEqual([
      'alertId',
      'alertKind',
      'nodeDisplayName',
      'redactor',
      'taskShortLabel',
    ]);
    expect(payload).toEqual({
      redactor: 'redactor.v1',
      nodeDisplayName: 'Jean laptop',
      taskShortLabel: 'Fix CI, please!',
      alertKind: 'permission-requested',
      alertId: 'alert-1',
    });
  });

  it('rejects redacted payload objects with extra fields', async () => {
    const { isRedactedPushPayload } = await import('./push.js');
    expect(isRedactedPushPayload({
      redactor: 'redactor.v1',
      nodeDisplayName: 'Kookr',
      taskShortLabel: 'Task abcdef01',
      alertKind: 'permission-requested',
      alertId: 'alert-1',
      fullBlockReason: 'never include this',
    })).toBe(false);
  });

  it('falls back when the allowlisted label is too short', () => {
    expect(redactTaskShortLabel('***', 'abcdef0123456789')).toBe('Task abcdef01');
    expect(redactTaskShortLabel('abc', 'abcdef0123456789')).toBe('Task abcdef01');
  });

  it('truncates labels to 64 safe characters', () => {
    const redacted = redactTaskShortLabel('Fix task '.repeat(20), 'abcdef0123456789');
    expect(redacted).toHaveLength(64);
    expect(redacted).toMatch(/^[A-Za-z0-9 .,!?-]+$/);
  });

  it.each([
    ['JWT', 'deploy eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'],
    ['AWS access key', 'use AKIAIOSFODNN7EXAMPLE for staging'],
    ['GitHub fine-grained PAT', 'github_pat_11AABBCC0_secretSecretSecretSecretSecret'],
    ['GitHub classic PAT', 'ghp_1234567890abcdefABCDEF1234567890abcdef'],
    ['base64 credential', 'Basic dXNlcjpwYXNzd29yZHNob3VsZG5vdGxlYWs='],
    ['hex token', '0123456789abcdef0123456789abcdef01234567'],
  ])('does not leak secret-shaped %s labels', (_kind, secretLike) => {
    const taskId = '1234567890abcdef';
    const redacted = redactTaskShortLabel(secretLike, taskId);

    expect(redacted).toBe(taskLabelFallback(taskId));
    expect(redacted).not.toContain(secretLike);
    for (const token of secretLike.split(/[ .:_-]+/).filter((part) => part.length >= 12)) {
      expect(redacted).not.toContain(token);
    }
  });
});

describe('push alert publishing', () => {
  function makeClient(overrides: Partial<RemoteNodeClient['status']> = {}): RemoteNodeClient {
    return {
      status: {
        relayConnected: true,
        protocolVersion: 1,
        nodeId: asNodeId('node-a'),
        nodeEpoch: asNodeEpoch('7'),
        nodeMode: 'active',
        connectionState: 'connected',
        features: { enabled: [], disabled: [] },
        ...overrides,
      },
      start: vi.fn(),
      stop: vi.fn(),
      publish: vi.fn(() => true),
    };
  }

  const payload: RedactedPushPayload = {
    redactor: 'redactor.v1',
    nodeDisplayName: 'Kookr',
    taskShortLabel: 'Task abcdef01',
    alertKind: 'permission-requested',
    alertId: 'alert-1',
  };

  it('is inert without a relay client', () => {
    expect(publishPushAlertDelta(null, payload)).toBe(false);
  });

  it('is inert when KOOKR_PUSH_DISABLED=true', () => {
    const client = makeClient();
    expect(publishPushAlertDelta(client, payload, { env: { KOOKR_PUSH_DISABLED: 'true' } })).toBe(false);
    expect(client.publish).not.toHaveBeenCalled();
  });

  it('is inert while disconnected from the relay', () => {
    const client = makeClient({ relayConnected: false, connectionState: 'backing-off' });
    expect(publishPushAlertDelta(client, payload)).toBe(false);
    expect(client.publish).not.toHaveBeenCalled();
  });

  it('publishes a push alert state delta through the existing node channel', () => {
    const client = makeClient();
    expect(publishPushAlertDelta(client, payload, {
      now: () => new Date('2026-05-15T00:00:00.000Z'),
      env: {},
    })).toBe(true);

    expect(client.publish).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: 'node-a',
      nodeEpoch: '7',
      ts: '2026-05-15T00:00:00.000Z',
      kind: 'state.delta',
      payload: {
        type: 'push.alert',
        payload,
      },
    }));
  });
});
