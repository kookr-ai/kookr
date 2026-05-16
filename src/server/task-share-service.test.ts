import { describe, expect, it } from 'vitest';

import { TaskStore } from '../core/tasks.js';
import { asGrantId, asNodeEpoch, asNodeId, asPolicyVersion, asServerRevision } from '../remote/ids.js';
import { RemotePolicyCache } from '../remote/policy-cache.js';
import type { TaskShareSummary } from '../remote/share-contract.js';
import type { RelayShareClient } from './relay-share-client.js';
import { TaskShareService } from './task-share-service.js';

function share(overrides: Partial<TaskShareSummary> = {}): TaskShareSummary {
  return {
    invitationId: 'inv-1',
    taskId: 'task-id',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    state: 'waiting',
    connectedViewerCount: 0,
    grants: ['view'],
    grantRequests: [],
    ...overrides,
  };
}

const grantRequest = {
  requestId: 'grant-req-1',
  invitationId: 'inv-1',
  requestedGrants: ['terminalInput' as const],
  status: 'approved' as const,
  requestedAt: new Date().toISOString(),
  resolvedAt: new Date().toISOString(),
  resolution: 'approved' as const,
};

describe('TaskShareService', () => {
  it('publishes a safe task projection for a created share', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'Do secret thing in /tmp/private', cwd: '/tmp/private' });
    const createdShare = share({ taskId: task.id });
    const events: unknown[] = [];
    const client: RelayShareClient = {
      createTaskShare: async () => ({ share: createdShare, joinUrl: 'http://relay/join#inviteToken=tok' }),
      revokeTaskShare: async () => ({ share: { ...createdShare, state: 'revoked', revokedAt: new Date().toISOString() }, alreadyRevoked: false }),
      listTaskShares: async () => [createdShare],
      approveGrantRequest: async () => ({ share: { ...createdShare, grants: ['view', 'terminalInput'] }, request: grantRequest }),
      denyGrantRequest: async () => ({ share: createdShare, request: { ...grantRequest, status: 'denied', resolution: 'denied' } }),
    };
    const service = new TaskShareService({
      client,
      taskStore,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(1),
      publish: (event) => {
        events.push(event);
        return true;
      },
    });

    await service.createTaskShare({ taskId: task.id, ttlMs: 60_000 });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      kind: 'snapshot',
      payload: expect.objectContaining({
        type: 'remote.taskProjection.v1',
        invitationId: 'inv-1',
        projection: expect.objectContaining({
          schemaVersion: 'remote-task-projection.v1',
          taskId: task.id,
          taskLabel: `Task ${task.id.slice(0, 8)}`,
        }),
      }),
    }));
  });

  it('marks a share revokePending before relay acknowledgement', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('task', '/tmp');
    const existing = share({ taskId: task.id });
    let releaseRevoke: (() => void) | null = null;
    const client: RelayShareClient = {
      createTaskShare: async () => ({ share: existing, joinUrl: 'http://relay/join#inviteToken=tok' }),
      revokeTaskShare: async () => {
        await new Promise<void>((resolve) => {
          releaseRevoke = resolve;
        });
        return { share: { ...existing, state: 'revoked', revokedAt: new Date().toISOString() }, alreadyRevoked: false };
      },
      listTaskShares: async () => [existing],
      approveGrantRequest: async () => ({ share: { ...existing, grants: ['view', 'terminalInput'] }, request: grantRequest }),
      denyGrantRequest: async () => ({ share: existing, request: { ...grantRequest, status: 'denied', resolution: 'denied' } }),
    };
    const service = new TaskShareService({
      client,
      taskStore,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(1),
      publish: () => true,
    });
    await service.createTaskShare({ taskId: task.id, ttlMs: 60_000 });

    const revoke = service.revokeTaskShare('inv-1');
    await Promise.resolve();

    expect(await service.listTaskShares()).toEqual([
      expect.objectContaining({ invitationId: 'inv-1', state: 'revokePending', revokePendingAt: expect.any(String) }),
    ]);

    releaseRevoke?.();
    await expect(revoke).resolves.toEqual(expect.objectContaining({
      share: expect.objectContaining({ state: 'revoked' }),
    }));
  });

  it('checks policy grants before publishing projections', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('task', '/tmp');
    const createdShare = share({ taskId: task.id });
    const events: unknown[] = [];
    const remotePolicyCache = new RemotePolicyCache();
    const client: RelayShareClient = {
      createTaskShare: async () => ({ share: createdShare, joinUrl: 'http://relay/join#inviteToken=tok' }),
      revokeTaskShare: async () => ({ share: { ...createdShare, state: 'revoked', revokedAt: new Date().toISOString() }, alreadyRevoked: false }),
      listTaskShares: async () => [createdShare],
      approveGrantRequest: async () => ({ share: { ...createdShare, grants: ['view', 'terminalInput'] }, request: grantRequest }),
      denyGrantRequest: async () => ({ share: createdShare, request: { ...grantRequest, status: 'denied', resolution: 'denied' } }),
    };
    const service = new TaskShareService({
      client,
      taskStore,
      remotePolicyCache,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(events.length + 1),
      publish: (event) => {
        events.push(event);
        return true;
      },
    });

    await service.createTaskShare({ taskId: task.id, ttlMs: 60_000 });
    expect(events).toHaveLength(0);

    const grantId = asGrantId('grant-test');
    remotePolicyCache.upsert({
      grantId,
      subject: { kind: 'task', nodeId: asNodeId('kookr-node-test'), taskId: task.id },
      grants: ['view'],
      policyVersion: asPolicyVersion(1),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    service.publishActiveTaskProjections();
    expect(events).toHaveLength(1);

    remotePolicyCache.revoke(grantId, asPolicyVersion(2));
    service.publishActiveTaskProjections();
    expect(events).toHaveLength(1);

    remotePolicyCache.upsert({
      grantId: asGrantId('grant-expired'),
      subject: { kind: 'task', nodeId: asNodeId('kookr-node-test'), taskId: task.id },
      grants: ['view'],
      policyVersion: asPolicyVersion(3),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    service.publishActiveTaskProjections();
    expect(events).toHaveLength(1);
  });

  it('remembers approved grants and publishes the task projection', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('task', '/tmp');
    const baseShare = share({ taskId: task.id });
    const approvedShare = share({
      taskId: task.id,
      grants: ['view', 'terminalInput'],
      grantRequests: [grantRequest],
    });
    const events: unknown[] = [];
    const client: RelayShareClient = {
      createTaskShare: async () => ({ share: baseShare, joinUrl: 'http://relay/join#inviteToken=tok' }),
      revokeTaskShare: async () => ({ share: { ...baseShare, state: 'revoked', revokedAt: new Date().toISOString() }, alreadyRevoked: false }),
      listTaskShares: async () => [],
      approveGrantRequest: async () => ({ share: approvedShare, request: grantRequest }),
      denyGrantRequest: async () => ({ share: baseShare, request: { ...grantRequest, status: 'denied', resolution: 'denied' } }),
    };
    const service = new TaskShareService({
      client,
      taskStore,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(events.length + 1),
      publish: (event) => {
        events.push(event);
        return true;
      },
    });

    await service.approveGrantRequest('inv-1', 'grant-req-1');

    expect(await service.listTaskShares()).toEqual([
      expect.objectContaining({
        invitationId: 'inv-1',
        grants: ['view', 'terminalInput'],
        grantRequests: [grantRequest],
      }),
    ]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'snapshot',
        payload: expect.objectContaining({ invitationId: 'inv-1' }),
      }),
    ]);
  });

  it('remembers denied grants without publishing a new projection', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('task', '/tmp');
    const deniedRequest = { ...grantRequest, status: 'denied' as const, resolution: 'denied' as const };
    const deniedShare = share({ taskId: task.id, grantRequests: [deniedRequest] });
    const events: unknown[] = [];
    const client: RelayShareClient = {
      createTaskShare: async () => ({ share: deniedShare, joinUrl: 'http://relay/join#inviteToken=tok' }),
      revokeTaskShare: async () => ({ share: { ...deniedShare, state: 'revoked', revokedAt: new Date().toISOString() }, alreadyRevoked: false }),
      listTaskShares: async () => [],
      approveGrantRequest: async () => ({ share: { ...deniedShare, grants: ['view', 'terminalInput'] }, request: grantRequest }),
      denyGrantRequest: async () => ({ share: deniedShare, request: deniedRequest }),
    };
    const service = new TaskShareService({
      client,
      taskStore,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(events.length + 1),
      publish: (event) => {
        events.push(event);
        return true;
      },
    });

    await service.denyGrantRequest('inv-1', 'grant-req-1');

    expect(await service.listTaskShares()).toEqual([
      expect.objectContaining({
        invitationId: 'inv-1',
        grants: ['view'],
        grantRequests: [deniedRequest],
      }),
    ]);
    expect(events).toHaveLength(0);
  });
});
