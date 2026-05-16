import { describe, expect, it, vi } from 'vitest';

import { RemotePermissionBroker } from '../permission-broker.js';

describe('RemotePermissionBroker', () => {
  it('is a sidecar approval path and sends a keystroke only for permission-blocked sessions', async () => {
    const sendKeystroke = vi.fn(async () => {});
    const markInputReceived = vi.fn(() => true);
    const respondAndAdvance = vi.fn();
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => true,
        markInputReceived,
      },
      queue: {
        getAnomaly: () => ({
          agentId: 'session-1',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'permission',
          detectedAt: new Date('2026-05-15T19:00:00.000Z'),
        }),
        respondAndAdvance,
      },
    });

    await expect(broker.approve('session-1', '1')).resolves.toEqual({ keystroke: '1' });
    expect(sendKeystroke).toHaveBeenCalledWith('session-1', '1');
    expect(markInputReceived).toHaveBeenCalledWith('session-1');
    expect(respondAndAdvance).toHaveBeenCalledWith('session-1');
  });

  it('rejects non-blocked sessions without sending a keystroke', async () => {
    const sendKeystroke = vi.fn(async () => {});
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => false,
        markInputReceived: vi.fn(() => true),
      },
      queue: {
        getAnomaly: () => null,
        respondAndAdvance: vi.fn(),
      },
    });

    await expect(broker.approve('session-1', '1')).rejects.toThrow('session is not permission-blocked');
    expect(sendKeystroke).not.toHaveBeenCalled();
  });

  it('rejects non-owner identities before sending a keystroke', async () => {
    const sendKeystroke = vi.fn(async () => {});
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => false,
        markInputReceived: vi.fn(() => true),
      },
      queue: {
        getAnomaly: () => null,
        respondAndAdvance: vi.fn(),
      },
      isOwnerLocal: () => false,
    });

    await expect(broker.approve('session-1', '1', 'other')).rejects.toThrow('owner identity required');
    expect(sendKeystroke).not.toHaveBeenCalled();
  });
});
