import { describe, expect, it } from 'vitest';

import { asGrantId, asNodeEpoch, asNodeId, asPolicyVersion } from '../../src/remote/ids.js';
import type { InvitationRecord } from './invitations/store.js';
import { buildMemberShareState, memberBlockedMessage } from './member-state.js';

function invitation(overrides: Partial<InvitationRecord> = {}): InvitationRecord {
  return {
    invitationId: 'inv-1',
    nodeId: asNodeId('node-1'),
    subject: { kind: 'task', nodeId: asNodeId('node-1'), taskId: 'task-1' },
    grants: ['view'],
    grantId: asGrantId('grant-1'),
    tokenHash: 'token-hash-secret',
    createdAt: '2026-05-17T00:00:00.000Z',
    expiresAt: '2026-05-17T01:00:00.000Z',
    acceptedAt: '2026-05-17T00:01:00.000Z',
    acceptedBy: 'alice-local-user',
    memberTokenHash: 'member-token-secret',
    memberId: 'member-secret',
    policyVersion: asPolicyVersion(1),
    ...overrides,
  };
}

describe('buildMemberShareState', () => {
  it('describes insecure public terminal transport without owner internals', () => {
    expect(memberBlockedMessage('transport.insecure')).toBe('Terminal sharing requires HTTPS for public links.');
  });

  it('keeps anonymous guest links terminal-disabled without surfacing request state', () => {
    const state = buildMemberShareState({
      invitation: invitation({
        shareId: '123-456',
        passwordVerifier: 'scrypt:fixture',
        redactedShareLabel: '123-***',
        controllerLease: {
          leaseId: 'lease-secret',
          deviceId: 'device-other',
          holderLabel: 'Owner terminal',
          acquiredAt: '2026-05-17T00:03:00.000Z',
          expiresAt: '2026-05-17T00:10:00.000Z',
        },
        grantRequests: [{
          requestId: 'grant-req-1',
          invitationId: 'inv-1',
          requestedGrants: ['terminalView', 'terminalInput'],
          status: 'pending',
          requestedAt: '2026-05-17T00:03:00.000Z',
          requestedBy: 'guest-user',
          comment: 'Please enable terminal viewing',
        }],
      }),
      node: { connected: true, policySyncStatus: 'acked' },
      now: new Date('2026-05-17T00:04:00.000Z'),
    });

    expect(state.terminal).toEqual({
      state: 'blocked',
      reason: 'guest.terminalDisabled',
      message: 'Guest Links are view-only and do not support terminal viewing.',
    });
    expect(state.grantRequests).toEqual([]);
    expect(state.controllerLease).toEqual({ state: 'available' });
    expect(JSON.stringify(state)).not.toContain('Owner terminal');
  });

  it('redacts owner-only fields and reports missing terminal trust', () => {
    const state = buildMemberShareState({
      invitation: invitation({ grants: ['view', 'terminalView', 'terminalInput'] }),
      node: {
        connected: true,
        displayName: 'Owner desktop',
        hello: {
          type: 'node.hello',
          nodeId: asNodeId('node-1'),
          nodeEpoch: asNodeEpoch('1'),
          protocolVersion: 1,
          supportedFeatures: ['policy-sync'],
          softwareVersion: 'test',
        },
        policySyncStatus: 'acked',
      },
      now: new Date('2026-05-17T00:02:00.000Z'),
    });

    expect(state.terminal).toEqual({
      state: 'blocked',
      reason: 'node.untrusted',
      message: 'The owner has not enabled terminal sharing on this node.',
    });
    const json = JSON.stringify(state);
    expect(json).not.toContain('token-hash-secret');
    expect(json).not.toContain('member-token-secret');
    expect(json).not.toContain('alice-local-user');
    expect(json).not.toContain('member-secret');
  });

  it('redacts member identities from public grant request state', () => {
    const state = buildMemberShareState({
      invitation: invitation({
        grantRequests: [{
          requestId: 'grant-req-1',
          invitationId: 'inv-1',
          requestedGrants: ['terminalView', 'terminalInput'],
          status: 'pending',
          requestedAt: '2026-05-17T00:03:00.000Z',
          requestedBy: 'alice-local-user',
          comment: 'Need terminal input',
        }],
      }),
      node: { connected: false, policySyncStatus: 'acked' },
      now: new Date('2026-05-17T00:04:00.000Z'),
    });

    expect(state.grantRequests).toEqual([{
      requestId: 'grant-req-1',
      invitationId: 'inv-1',
      requestedGrants: ['terminalView', 'terminalInput'],
      status: 'pending',
      requestedAt: '2026-05-17T00:03:00.000Z',
      comment: 'Need terminal input',
    }]);
    expect(JSON.stringify(state)).not.toContain('alice-local-user');
  });

  it('renders policy sync pending distinctly from node offline', () => {
    const pending = buildMemberShareState({
      invitation: invitation({ grants: ['view', 'terminalView', 'terminalInput'] }),
      node: {
        connected: true,
        hello: {
          type: 'node.hello',
          nodeId: asNodeId('node-1'),
          nodeEpoch: asNodeEpoch('1'),
          protocolVersion: 1,
          supportedFeatures: ['policy-sync', 'terminal-stream', 'terminal-input'],
          softwareVersion: 'test',
        },
        policySyncStatus: 'sentAwaitingAck',
      },
      now: new Date('2026-05-17T00:02:00.000Z'),
    });
    const offline = buildMemberShareState({
      invitation: invitation({ grants: ['view', 'terminalView', 'terminalInput'] }),
      node: { connected: false, policySyncStatus: 'acked' },
      now: new Date('2026-05-17T00:02:00.000Z'),
    });

    expect(pending.terminal).toEqual(expect.objectContaining({
      state: 'blocked',
      reason: 'policy.syncPending',
    }));
    expect(offline.terminal).toEqual(expect.objectContaining({
      state: 'blocked',
      reason: 'node.offline',
    }));
  });

  it('renders policy timeout, stale, and failed states distinctly', () => {
    const baseNode = {
      connected: true,
      hello: {
        type: 'node.hello' as const,
        nodeId: asNodeId('node-1'),
        nodeEpoch: asNodeEpoch('1'),
        protocolVersion: 1,
        supportedFeatures: ['policy-sync', 'terminal-stream', 'terminal-input'] as const,
        softwareVersion: 'test',
      },
    };

    for (const [policySyncStatus, reason] of [
      ['timedOut', 'policy.syncTimedOut'],
      ['stale', 'policy.syncStale'],
      ['failed', 'policy.syncFailed'],
    ] as const) {
      const state = buildMemberShareState({
        invitation: invitation({ grants: ['view', 'terminalView', 'terminalInput'] }),
        node: { ...baseNode, policySyncStatus },
        now: new Date('2026-05-17T00:02:00.000Z'),
      });
      expect(state.terminal).toEqual(expect.objectContaining({
        state: 'blocked',
        reason,
      }));
    }
  });

  it('honors current terminal grants over historical denied requests', () => {
    const state = buildMemberShareState({
      invitation: invitation({
        grants: ['view', 'terminalView', 'terminalInput'],
        grantRequests: [
          {
            requestId: 'grant-req-old',
            invitationId: 'inv-1',
            requestedGrants: ['terminalInput'],
            status: 'denied',
            requestedAt: '2026-05-17T00:03:00.000Z',
            resolvedAt: '2026-05-17T00:04:00.000Z',
            resolution: 'denied',
          },
          {
            requestId: 'grant-req-new',
            invitationId: 'inv-1',
            requestedGrants: ['terminalInput'],
            status: 'approved',
            requestedAt: '2026-05-17T00:05:00.000Z',
            resolvedAt: '2026-05-17T00:06:00.000Z',
            resolution: 'approved',
          },
        ],
      }),
      node: {
        connected: true,
        hello: {
          type: 'node.hello',
          nodeId: asNodeId('node-1'),
          nodeEpoch: asNodeEpoch('1'),
          protocolVersion: 1,
          supportedFeatures: ['policy-sync', 'terminal-stream', 'terminal-input'],
          softwareVersion: 'test',
        },
        policySyncStatus: 'acked',
      },
      now: new Date('2026-05-17T00:07:00.000Z'),
    });

    expect(state.terminal).toEqual({ state: 'available' });
  });

  it('treats legacy terminal input grants as terminal viewing plus input', () => {
    const state = buildMemberShareState({
      invitation: invitation({ grants: ['view', 'terminalInput'] }),
      node: {
        connected: true,
        hello: {
          type: 'node.hello',
          nodeId: asNodeId('node-1'),
          nodeEpoch: asNodeEpoch('1'),
          protocolVersion: 1,
          supportedFeatures: ['policy-sync', 'terminal-stream', 'terminal-input'],
          softwareVersion: 'test',
        },
        policySyncStatus: 'acked',
      },
      now: new Date('2026-05-17T00:07:00.000Z'),
    });

    expect(state.terminal).toEqual({ state: 'available' });
  });
});
