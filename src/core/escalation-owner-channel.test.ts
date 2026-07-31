import { describe, test, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  formatEscalationMessage,
  controlRoomLogChannel,
  createOwnerEscalationNotifier,
  type OwnerReadChannel,
  type OwnerEscalationMessage,
} from './escalation-owner-channel.js';
import {
  EnvironmentBlockerRegistry,
  type EnvironmentBlockerEscalation,
} from './environment-blocker-registry.js';

function escalation(
  overrides: Partial<EnvironmentBlockerEscalation> = {},
): EnvironmentBlockerEscalation {
  return {
    blocker: {
      key: 'ci-billing:github-actions',
      type: 'ci-billing',
      scope: 'github-actions',
      detectedAt: '2026-07-27T00:00:00.000Z',
      requiresHuman: true,
      blockedCapability: 'ci',
      reason: 'every run dies in 3s (account billing limit)',
      probe: 'gh run list',
      ...overrides.blocker,
    },
    kind: 'initial',
    escalationCount: 1,
    cost: {
      // Distinct values so a field swap/conflation in the formatter is caught.
      ciBlindMergeCount: 5,
      retroVerifyQueueDepth: 3,
      blockedCapabilities: ['ci', 'web-search'],
      ...overrides.cost,
    },
    at: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('formatEscalationMessage', () => {
  test('includes the quantified running cost (AC2 fields)', () => {
    const message = formatEscalationMessage(escalation());
    expect(message.body).toContain('CI-blind merges (unverified on main): 5');
    expect(message.body).toContain('Retro-verify queue depth:             3');
    expect(message.body).toContain('Blocked capabilities:                 ci, web-search');
    expect(message.fields.ciBlindMergeCount).toBe(5);
    expect(message.fields.retroVerifyQueueDepth).toBe(3);
    expect(message.fields.blockedCapabilities).toEqual(['ci', 'web-search']);
  });

  test('re-escalation of a requires_human blocker is urgent and shows the stale age', () => {
    const message = formatEscalationMessage(
      escalation({ kind: 're-escalation', escalationCount: 3 }),
    );
    expect(message.urgent).toBe(true);
    expect(message.subject).toContain('RE-ESCALATION');
    expect(message.subject).toContain('[requires human]');
    expect(message.subject).toContain('escalation #3');
    // detected 07-27, escalated 07-29 → 2 days open.
    expect(message.subject).toContain('2d');
  });

  test('an ordinary (non-human) escalation is not urgent', () => {
    const message = formatEscalationMessage(
      escalation({ blocker: { ...escalation().blocker, requiresHuman: false }, kind: 'initial' }),
    );
    expect(message.urgent).toBe(false);
    expect(message.subject).not.toContain('[requires human]');
  });
});

describe('createOwnerEscalationNotifier', () => {
  test('routes the escalation to the owner-read channel with cost intact', async () => {
    const received: OwnerEscalationMessage[] = [];
    const ownerChannel: OwnerReadChannel = {
      id: 'fake-owner-dm',
      deliver: (m) => {
        received.push(m);
      },
    };
    const notify = createOwnerEscalationNotifier([ownerChannel]);

    await notify(escalation({ kind: 're-escalation', escalationCount: 2 }));

    expect(received).toHaveLength(1);
    expect(received[0]!.fields.blockerKey).toBe('ci-billing:github-actions');
    expect(received[0]!.fields.kind).toBe('re-escalation');
    expect(received[0]!.fields.ciBlindMergeCount).toBe(5);
    expect(received[0]!.fields.retroVerifyQueueDepth).toBe(3);
    expect(received[0]!.fields.blockedCapabilities).toEqual(['ci', 'web-search']);
  });

  test('fans out to every channel; one failing channel does not block the others', async () => {
    const good: OwnerReadChannel = { id: 'good', deliver: vi.fn() };
    const bad: OwnerReadChannel = {
      id: 'bad',
      deliver: vi.fn().mockRejectedValue(new Error('transport down')),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const notify = createOwnerEscalationNotifier([bad, good]);

    // At least one channel delivered ⇒ resolves (registry will stamp).
    await expect(notify(escalation())).resolves.toBeUndefined();
    expect(good.deliver).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test('rejects when every channel fails so the registry retries', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad: OwnerReadChannel = {
      id: 'bad',
      deliver: () => {
        throw new Error('down');
      },
    };
    const notify = createOwnerEscalationNotifier([bad]);
    await expect(notify(escalation())).rejects.toThrow(/all 1 owner channel/);
    errorSpy.mockRestore();
  });

  test('requires at least one channel', () => {
    expect(() => createOwnerEscalationNotifier([])).toThrow(/at least one/);
  });
});

describe('controlRoomLogChannel', () => {
  test('urgent escalations log at error, ordinary at warn', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const channel = controlRoomLogChannel(logger);

    channel.deliver(formatEscalationMessage(escalation({ kind: 're-escalation' })));
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(String(logger.error.mock.calls[0][0])).toContain('[control-room][escalation]');

    channel.deliver(
      formatEscalationMessage(
        escalation({ blocker: { ...escalation().blocker, requiresHuman: false } }),
      ),
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('end-to-end: registry escalation reaches the owner channel (AC3)', () => {
  test('a requires_human re-escalation is delivered to the owner-read channel', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'escalation-owner-e2e-'));
    try {
      const received: OwnerEscalationMessage[] = [];
      const ownerChannel: OwnerReadChannel = {
        id: 'fake-owner-dm',
        deliver: (m) => {
          received.push(m);
        },
      };
      let now = Date.parse('2026-07-27T00:00:00.000Z');
      const registry = new EnvironmentBlockerRegistry(tempDir, {
        now: () => now,
        staleTtlMs: 24 * 60 * 60 * 1000,
        costProvider: () => ({ ciBlindMergeCount: 4, retroVerifyQueueDepth: 2 }),
        notify: createOwnerEscalationNotifier([ownerChannel]),
      });

      await registry.register({
        type: 'ci-billing',
        scope: 'github-actions',
        requiresHuman: true,
        blockedCapability: 'ci',
        reason: 'account billing limit',
      });
      expect(received).toHaveLength(1);
      expect(received[0]!.fields.kind).toBe('initial');

      // Two days later, the heartbeat re-escalates to the owner channel.
      now += 2 * 24 * 60 * 60 * 1000;
      await registry.heartbeat();
      expect(received).toHaveLength(2);
      expect(received[1]!.fields.kind).toBe('re-escalation');
      expect(received[1]!.fields.ciBlindMergeCount).toBe(4);
      expect(received[1]!.fields.retroVerifyQueueDepth).toBe(2);
      expect(received[1]!.urgent).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
