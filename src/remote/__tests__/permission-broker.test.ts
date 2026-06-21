import { describe, expect, it, vi } from 'vitest';

import { buildPermissionRequestBinding } from '../permission-request-binding.js';
import { RemotePermissionBroker } from '../permission-broker.js';

const detectedAt = new Date('2026-05-15T19:00:00.000Z');
const permissionEvent = {
  type: 'permission_request' as const,
  sessionId: 'session-1',
  toolName: 'Bash',
  toolInput: { command: 'git push origin feature' },
  eventSeq: 7,
};

function permissionRequestBinding() {
  return buildPermissionRequestBinding({
    sessionId: 'session-1',
    event: permissionEvent,
    detectedAt,
  });
}

describe('RemotePermissionBroker', () => {
  it('is a sidecar approval path and sends a keystroke only for permission-blocked sessions', async () => {
    const sendKeystroke = vi.fn(async () => {});
    const markInputReceived = vi.fn(() => true);
    const recordInputReceived = vi.fn();
    const respondAndAdvance = vi.fn();
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => true,
        markInputReceived,
        getAgentEvents: () => [permissionEvent],
      },
      watchdog: { recordInputReceived },
      queue: {
        getAnomaly: () => ({
          agentId: 'session-1',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'permission',
          detectedAt,
        }),
        respondAndAdvance,
      },
      now: () => new Date('2026-05-15T19:01:00.000Z'),
    });

    await expect(broker.approve('session-1', '1', undefined, {
      permissionRequest: permissionRequestBinding(),
    })).resolves.toEqual({ keystroke: '1', permissionRequest: permissionRequestBinding() });
    expect(sendKeystroke).toHaveBeenCalledWith('session-1', '1');
    expect(markInputReceived).toHaveBeenCalledWith('session-1');
    expect(recordInputReceived).toHaveBeenCalledWith('session-1');
    expect(respondAndAdvance).toHaveBeenCalledWith('session-1');
  });

  it('rejects missing request binding before sending a keystroke', async () => {
    const sendKeystroke = vi.fn(async () => {});
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => true,
        markInputReceived: vi.fn(() => true),
        getAgentEvents: () => [permissionEvent],
      },
      queue: {
        getAnomaly: () => ({
          agentId: 'session-1',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'permission',
          detectedAt,
        }),
        respondAndAdvance: vi.fn(),
      },
    });

    await expect(broker.approve('session-1', '1')).rejects.toThrow('missing permission request binding');
    expect(sendKeystroke).not.toHaveBeenCalled();
  });

  it('binds permission requests that omit toolInput', async () => {
    const sendKeystroke = vi.fn(async () => {});
    const eventWithoutInput = {
      type: 'permission_request' as const,
      sessionId: 'session-1',
      toolName: 'Bash',
      eventSeq: 9,
    };
    const binding = buildPermissionRequestBinding({
      sessionId: 'session-1',
      event: eventWithoutInput,
      detectedAt,
    });
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => true,
        markInputReceived: vi.fn(() => true),
        getAgentEvents: () => [eventWithoutInput],
      },
      queue: {
        getAnomaly: () => ({
          agentId: 'session-1',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'permission',
          detectedAt,
        }),
        respondAndAdvance: vi.fn(),
      },
      now: () => new Date('2026-05-15T19:01:00.000Z'),
    });

    await expect(broker.approve('session-1', '1', undefined, {
      permissionRequest: binding,
    })).resolves.toEqual({ keystroke: '1', permissionRequest: binding });
    expect(sendKeystroke).toHaveBeenCalledWith('session-1', '1');
  });

  it('rejects stale request binding before sending a keystroke', async () => {
    const sendKeystroke = vi.fn(async () => {});
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => true,
        markInputReceived: vi.fn(() => true),
        getAgentEvents: () => [permissionEvent],
      },
      queue: {
        getAnomaly: () => ({
          agentId: 'session-1',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'permission',
          detectedAt,
        }),
        respondAndAdvance: vi.fn(),
      },
      now: () => new Date('2026-05-15T19:06:00.001Z'),
    });

    await expect(broker.approve('session-1', '1', undefined, {
      permissionRequest: permissionRequestBinding(),
    })).rejects.toThrow('stale permission request approval');
    expect(sendKeystroke).not.toHaveBeenCalled();
  });

  it('rejects bindings for an older permission request when a new prompt is active', async () => {
    const sendKeystroke = vi.fn(async () => {});
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => true,
        markInputReceived: vi.fn(() => true),
        getAgentEvents: () => [
          permissionEvent,
          {
            ...permissionEvent,
            toolInput: { command: 'rm -rf /tmp/not-the-original-request' },
            eventSeq: 8,
          },
        ],
      },
      queue: {
        getAnomaly: () => ({
          agentId: 'session-1',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'permission',
          detectedAt,
        }),
        respondAndAdvance: vi.fn(),
      },
      now: () => new Date('2026-05-15T19:01:00.000Z'),
    });

    await expect(broker.approve('session-1', '1', undefined, {
      permissionRequest: permissionRequestBinding(),
    })).rejects.toThrow('permission request mismatch');
    expect(sendKeystroke).not.toHaveBeenCalled();
  });

  it('consumes a matching binding before awaiting the terminal write', async () => {
    let releaseWrite: (() => void) | undefined;
    const sendKeystroke = vi.fn(() => new Promise<void>((resolve) => {
      releaseWrite = resolve;
    }));
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => true,
        markInputReceived: vi.fn(() => true),
        getAgentEvents: () => [permissionEvent],
      },
      queue: {
        getAnomaly: () => ({
          agentId: 'session-1',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'permission',
          detectedAt,
        }),
        respondAndAdvance: vi.fn(),
      },
      now: () => new Date('2026-05-15T19:01:00.000Z'),
    });

    const first = broker.approve('session-1', '1', undefined, {
      permissionRequest: permissionRequestBinding(),
    });
    const second = broker.approve('session-1', '1', undefined, {
      permissionRequest: permissionRequestBinding(),
    });

    await expect(second).rejects.toThrow('permission request approval already consumed');
    expect(sendKeystroke).toHaveBeenCalledTimes(1);
    releaseWrite?.();
    await expect(first).resolves.toEqual({ keystroke: '1', permissionRequest: permissionRequestBinding() });
  });

  it('rejects non-blocked sessions without sending a keystroke', async () => {
    const sendKeystroke = vi.fn(async () => {});
    const broker = new RemotePermissionBroker({
      adapter: { sendKeystroke },
      monitor: {
        isPermissionBlocked: () => false,
        markInputReceived: vi.fn(() => true),
        getAgentEvents: () => [],
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
        getAgentEvents: () => [],
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
