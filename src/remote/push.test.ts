import { describe, expect, it, vi } from 'vitest';

import {
  createPushAlertOutbox,
  makeRedactedPushPayload,
  publishPushAlertDelta,
  redactTaskShortLabel,
  taskLabelFallback,
  type PushAlertDeltaPayload,
  type RedactedPushPayload,
} from './push.js';
import type { RemoteNodeClient } from './node-client.js';
import { asNodeEpoch, asNodeId } from './ids.js';

const secretFixture = (...parts: string[]): string => parts.join('');

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
    ['ordinary text', 'Fix stuck CI for web push notifications'],
    ['long task id', 'Investigate task 123e4567-e89b-12d3-a456-426614174000'],
    ['commit SHA', 'Review commit bcf04361abc1234567890abcdef1234567890abc'],
    ['hex-like diagnostic id', 'Trace 0123456789abcdef0123456789abcdef'],
    ['base64-like note', 'Decode dGhpcyBpcyBub3Qgc2VjcmV0 safely'],
  ])('preserves safe %s labels', (_kind, label) => {
    expect(redactTaskShortLabel(label, 'abcdef0123456789')).toBe(label);
  });

  it.each([
    ['JWT', secretFixture('deploy eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c')],
    ['OpenAI-style key', secretFixture('sk', '-abcdefghijklmnop1234')],
    ['AWS access key', secretFixture('use AKIA', 'IOSFODNN7EXAMPLE for staging')],
    ['GitHub fine-grained PAT', secretFixture('github', '_pat_11AABBCC0_secretSecretSecretSecretSecret')],
    ['GitHub classic PAT', secretFixture('ghp', '_1234567890abcdefABCDEF1234567890abcdef')],
    ['Slack bot token', secretFixture('xoxb', '-0123456789-abcdefghijklmnop')],
    ['GitLab PAT', secretFixture('glpat', '-0123456789abcdefghij')],
    ['HuggingFace token', secretFixture('hf', '_0123456789abcdefghij')],
    ['npm token', secretFixture('npm', '_0123456789abcdefghij')],
    ['PyPI token', secretFixture('pypi', '-0123456789abcdefghij')],
    ['Docker PAT', secretFixture('dckr', '_pat_0123456789abcdefghij')],
    ['Google OAuth token', secretFixture('ya29', '.abcdEFGH_ijklMNOP')],
    ['base64 credential', secretFixture('Basic ', 'dXNlcjpwYXNzd29yZHNob3VsZG5vdGxlYWs=')],
    ['spaced API key context', 'api key: 0123456789abcdef0123456789abcdef'],
    ['contextual hex token', 'token: 0123456789abcdef0123456789abcdef01234567'],
    ['contextual base64 secret', 'secret=dGhpcy1pcy1hLXNlY3JldC12YWx1ZQ=='],
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

  const payloadWithId = (alertId: string): RedactedPushPayload => ({
    ...payload,
    alertId,
    taskShortLabel: `Task ${alertId}`,
  });

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

  it('buffers failed push alerts and replays them in insertion order', () => {
    const outbox = createPushAlertOutbox({ capacity: 4 });
    outbox.enqueue(payloadWithId('alert-1'));
    outbox.enqueue(payloadWithId('alert-2'));

    const client = makeClient();
    expect(outbox.flush(client, {
      now: () => new Date('2026-05-15T00:00:00.000Z'),
      env: {},
    })).toEqual({ attempted: 2, sent: 2, pending: 0 });

    expect(vi.mocked(client.publish).mock.calls.map(([event]) => {
      return event.kind === 'state.delta'
        ? (event.payload as PushAlertDeltaPayload).payload.alertId
        : null;
    })).toEqual(['alert-1', 'alert-2']);
  });

  it('keeps buffering bounded by dropping the oldest alert on overflow', () => {
    const outbox = createPushAlertOutbox({ capacity: 2 });

    expect(outbox.enqueue(payloadWithId('alert-1'))).toEqual({ pending: 1, droppedAlertId: null });
    expect(outbox.enqueue(payloadWithId('alert-2'))).toEqual({ pending: 2, droppedAlertId: null });
    expect(outbox.enqueue(payloadWithId('alert-3'))).toEqual({ pending: 2, droppedAlertId: 'alert-1' });

    expect(outbox.snapshot().map((entry) => entry.alertId)).toEqual(['alert-2', 'alert-3']);
  });

  it('dedupes pending alerts by alertId without reordering the outbox', () => {
    const outbox = createPushAlertOutbox({ capacity: 3 });
    outbox.enqueue(payloadWithId('alert-1'));
    outbox.enqueue(payloadWithId('alert-2'));
    outbox.enqueue({
      ...payloadWithId('alert-1'),
      taskShortLabel: 'Updated label',
    });

    expect(outbox.snapshot().map((entry) => [entry.alertId, entry.taskShortLabel])).toEqual([
      ['alert-1', 'Updated label'],
      ['alert-2', 'Task alert-2'],
    ]);
  });

  it('does not resend an alert after a successful replay', () => {
    const outbox = createPushAlertOutbox({ capacity: 4 });
    outbox.enqueue(payloadWithId('alert-1'));
    const client = makeClient();

    expect(outbox.flush(client, { env: {} })).toEqual({ attempted: 1, sent: 1, pending: 0 });
    expect(outbox.flush(client, { env: {} })).toEqual({ attempted: 0, sent: 0, pending: 0 });

    expect(client.publish).toHaveBeenCalledTimes(1);
  });

  it('keeps the first failed replay and does not send later alerts ahead of it', () => {
    const outbox = createPushAlertOutbox({ capacity: 4 });
    outbox.enqueue(payloadWithId('alert-1'));
    outbox.enqueue(payloadWithId('alert-2'));

    const client = makeClient({ relayConnected: false, connectionState: 'backing-off' });
    expect(outbox.flush(client, { env: {} })).toEqual({ attempted: 1, sent: 0, pending: 2 });
    expect(client.publish).not.toHaveBeenCalled();
    expect(outbox.snapshot().map((entry) => entry.alertId)).toEqual(['alert-1', 'alert-2']);
  });

  it('keeps a connected-but-failed replay queued until a later flush succeeds', () => {
    const outbox = createPushAlertOutbox({ capacity: 4 });
    outbox.enqueue(payloadWithId('alert-1'));
    outbox.enqueue(payloadWithId('alert-2'));

    const client = makeClient();
    vi.mocked(client.publish).mockReturnValueOnce(false);

    expect(outbox.flush(client, { env: {} })).toEqual({ attempted: 1, sent: 0, pending: 2 });
    expect(outbox.snapshot().map((entry) => entry.alertId)).toEqual(['alert-1', 'alert-2']);

    expect(outbox.flush(client, { env: {} })).toEqual({ attempted: 2, sent: 2, pending: 0 });
    expect(vi.mocked(client.publish).mock.calls.map(([event]) => {
      return event.kind === 'state.delta'
        ? (event.payload as PushAlertDeltaPayload).payload.alertId
        : null;
    })).toEqual(['alert-1', 'alert-1', 'alert-2']);
  });
});
