import { describe, expect, it } from 'vitest';

import { asGrantId, asNodeEpoch, asNodeId, asPolicyVersion } from '../../src/remote/ids.js';
import type { InvitationRecord } from './invitations/store.js';
import { buildMemberShareState } from './member-state.js';

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
  it('redacts owner-only fields and reports missing terminal trust', () => {
    const state = buildMemberShareState({
      invitation: invitation({ grants: ['view', 'terminalInput'] }),
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
        policySyncStatus: 'synced',
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
          requestedGrants: ['terminalInput'],
          status: 'pending',
          requestedAt: '2026-05-17T00:03:00.000Z',
          requestedBy: 'alice-local-user',
          comment: 'Need terminal input',
        }],
      }),
      node: { connected: false, policySyncStatus: 'synced' },
      now: new Date('2026-05-17T00:04:00.000Z'),
    });

    expect(state.grantRequests).toEqual([{
      requestId: 'grant-req-1',
      invitationId: 'inv-1',
      requestedGrants: ['terminalInput'],
      status: 'pending',
      requestedAt: '2026-05-17T00:03:00.000Z',
      comment: 'Need terminal input',
    }]);
    expect(JSON.stringify(state)).not.toContain('alice-local-user');
  });

  it('renders policy sync pending distinctly from node offline', () => {
    const pending = buildMemberShareState({
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
        policySyncStatus: 'syncing',
      },
      now: new Date('2026-05-17T00:02:00.000Z'),
    });
    const offline = buildMemberShareState({
      invitation: invitation({ grants: ['view', 'terminalInput'] }),
      node: { connected: false, policySyncStatus: 'synced' },
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

  it('honors current terminal grants over historical denied requests', () => {
    const state = buildMemberShareState({
      invitation: invitation({
        grants: ['view', 'terminalInput'],
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
        policySyncStatus: 'synced',
      },
      now: new Date('2026-05-17T00:07:00.000Z'),
    });

    expect(state.terminal).toEqual({ state: 'available' });
  });
});
