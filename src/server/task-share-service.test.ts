import { describe, expect, it } from 'vitest';

import { AttentionQueue } from '../core/attention-queue.js';
import { TaskStore } from '../core/tasks.js';
import type { Anomaly } from '../core/types.js';
import { buildPermissionRequestBinding } from '../shared/contracts/permission-request-binding.js';
import type { RemoteControlEvent } from '../remote/control-events.js';
import { asGrantId, asNodeEpoch, asNodeId, asPolicyVersion, asSeq, asServerRevision, asSessionEpoch, asSessionId } from '../remote/ids.js';
import { RemotePolicyCache } from '../remote/policy-cache.js';
import type { RemoteTaskProjectionEnvelopeV1, TaskShareSummary } from '../shared/contracts/remote-share.js';
import type { RelayShareClient } from './relay-share-client.js';
import { TaskShareService, type TaskShareServiceOptions } from './task-share-service.js';

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
  requestedBy: 'member-1',
  requestedAt: new Date().toISOString(),
  resolvedAt: new Date().toISOString(),
  resolution: 'approved' as const,
};

function clientFor(createdShare: TaskShareSummary): RelayShareClient {
  return {
    createTaskShare: async () => ({ share: createdShare, joinUrl: 'http://relay/join#inviteToken=tok' }),
    revokeTaskShare: async () => ({ share: { ...createdShare, state: 'revoked', revokedAt: new Date().toISOString() }, alreadyRevoked: false }),
    listTaskShares: async () => [createdShare],
    approveGrantRequest: async () => ({ share: { ...createdShare, grants: ['view', 'terminalInput'] }, request: grantRequest }),
    denyGrantRequest: async () => ({ share: createdShare, request: { ...grantRequest, status: 'denied', resolution: 'denied' } }),
  };
}

function terminalPublisher(opts: {
  cursor?: ReturnType<NonNullable<TaskShareServiceOptions['terminalPublisher']>['currentCursor']>;
  installOk?: boolean;
} = {}): {
  publisher: NonNullable<TaskShareServiceOptions['terminalPublisher']>;
  installed: Array<Parameters<NonNullable<TaskShareServiceOptions['terminalPublisher']>['installPublicationRule']>[0]>;
  demands: Array<Parameters<NonNullable<TaskShareServiceOptions['terminalPublisher']>['recordDemandProof']>[0]>;
  revoked: string[];
} {
  const installed: Array<Parameters<NonNullable<TaskShareServiceOptions['terminalPublisher']>['installPublicationRule']>[0]> = [];
  const demands: Array<Parameters<NonNullable<TaskShareServiceOptions['terminalPublisher']>['recordDemandProof']>[0]> = [];
  const revoked: string[] = [];
  const cursor = opts.cursor === undefined
    ? { sessionEpoch: asSessionEpoch('3'), lastSeq: 12 }
    : opts.cursor;
  return {
    installed,
    revoked,
    publisher: {
      currentCursor: () => cursor,
      installPublicationRule: (rule) => {
        installed.push(rule);
        return opts.installOk === false
          ? { ok: false, reason: 'session-changed' }
          : { ok: true, rule: { ...rule, minSeqExclusive: asSeq(cursor?.lastSeq ?? 0) } };
      },
      recordDemandProof: (proof) => {
        demands.push(proof);
        return opts.installOk !== false;
      },
      revokePublicationScope: (publicationScopeId) => {
        revoked.push(publicationScopeId);
      },
    },
    demands,
  };
}

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
      diagnoseTerminalSharing: () => ({
        state: 'blocked',
        reason: 'nodeUntrusted',
        message: 'Terminal sharing is disabled for this node.',
        checkedAt: '2026-05-17T00:00:00.000Z',
      }),
    });
    await service.createTaskShare({ taskId: task.id, ttlMs: 60_000 });

    const revoke = service.revokeTaskShare('inv-1');
    await Promise.resolve();

    expect(await service.listTaskShares()).toEqual([
      expect.objectContaining({ invitationId: 'inv-1', state: 'revokePending', revokePendingAt: expect.any(String) }),
    ]);

    releaseRevoke?.();
    await expect(revoke).resolves.toEqual(expect.objectContaining({
      share: expect.objectContaining({
        state: 'revoked',
        terminalSharing: expect.objectContaining({ reason: 'nodeUntrusted' }),
      }),
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

  it('re-publishes a task projection when a shared task projected state changes', async () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const task = taskStore.createTask('task', '/tmp');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      createdAt: new Date(),
      cwd: '/tmp',
      status: 'running',
    });
    const createdShare = share({ taskId: task.id });
    const events: Array<RemoteControlEvent<RemoteTaskProjectionEnvelopeV1>> = [];
    const service = new TaskShareService({
      client: clientFor(createdShare),
      taskStore,
      queue,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(events.length + 1),
      publish: (event) => {
        events.push(event);
        return true;
      },
    });
    await service.createTaskShare({ taskId: task.id, ttlMs: 60_000 });
    expect(events[0].payload.projection).toEqual(expect.objectContaining({
      status: 'inProgress',
      needsInput: false,
      hasFinding: false,
    }));

    const needsInput: Anomaly = {
      type: 'needs_input',
      agentId: 'agent-1',
      severity: 'warning',
      explanation: 'Waiting for input',
      detectedAt: new Date().toISOString(),
    };
    queue.enqueue('agent-1', needsInput);
    service.publishTaskProjectionForTask(task.id);

    expect(events).toHaveLength(2);
    expect(events[1].payload).toEqual(expect.objectContaining({
      type: 'remote.taskProjection.v1',
      invitationId: 'inv-1',
      projection: expect.objectContaining({
        taskId: task.id,
        status: 'needsInput',
        needsInput: true,
        hasFinding: true,
      }),
    }));

    service.publishTaskProjectionForTask(task.id);
    expect(events).toHaveLength(2);
  });

  it('publishes active permission binding only to shares with permission approval grant', async () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const task = taskStore.createTask('task', '/tmp');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      createdAt: new Date('2026-05-17T00:00:00.000Z'),
      cwd: '/tmp',
      status: 'running',
    });
    const detectedAt = new Date('2026-05-17T00:01:00.000Z');
    queue.enqueue('agent-1', {
      type: 'permission_blocked',
      agentId: 'agent-1',
      severity: 'warning',
      explanation: 'permission required',
      detectedAt,
    });
    const permissionEvent = {
      type: 'permission_request' as const,
      sessionId: 'agent-1',
      toolName: 'Bash',
      toolInput: { command: 'git status' },
      eventSeq: 9,
    };
    const createdShare = share({ taskId: task.id, grants: ['view', 'permissionApprove'] });
    const events: Array<RemoteControlEvent<RemoteTaskProjectionEnvelopeV1>> = [];
    const service = new TaskShareService({
      client: clientFor(createdShare),
      taskStore,
      queue,
      getAgentEvents: () => [permissionEvent],
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(events.length + 1),
      publish: (event) => {
        events.push(event);
        return true;
      },
    });

    await service.createTaskShare({ taskId: task.id, ttlMs: 60_000 });

    expect(events[0].payload.projection.activePermissionRequest).toEqual({
      sessionId: 'agent-1',
      defaultKeystroke: '1',
      permissionRequest: buildPermissionRequestBinding({
        sessionId: 'agent-1',
        event: permissionEvent,
        detectedAt,
      }),
    });
    expect(JSON.stringify(events[0].payload.projection)).not.toContain('git status');

    const viewOnlyEvents: Array<RemoteControlEvent<RemoteTaskProjectionEnvelopeV1>> = [];
    const viewOnlyService = new TaskShareService({
      client: clientFor(share({ taskId: task.id })),
      taskStore,
      queue,
      getAgentEvents: () => [permissionEvent],
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(viewOnlyEvents.length + 1),
      publish: (event) => {
        viewOnlyEvents.push(event);
        return true;
      },
    });

    await viewOnlyService.createTaskShare({ taskId: task.id, ttlMs: 60_000 });
    expect(viewOnlyEvents[0].payload.projection.activePermissionRequest).toBeUndefined();
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
      diagnoseTerminalSharing: () => ({
        state: 'blocked',
        reason: 'policySyncPending',
        message: 'Approval is syncing.',
        checkedAt: '2026-05-17T00:00:00.000Z',
      }),
    });

    const approved = await service.approveGrantRequest('inv-1', 'grant-req-1');

    expect(approved.share.terminalSharing).toEqual(expect.objectContaining({
      state: 'blocked',
      reason: 'policySyncPending',
    }));
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

  it('publishes a session projection when approval carries terminal input without explicit terminal view', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('task', '/tmp');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      createdAt: new Date('2026-05-17T00:00:00.000Z'),
      cwd: '/tmp',
      status: 'running',
    });
    const baseShare = share({ taskId: task.id });
    const approvedShare = share({
      taskId: task.id,
      grants: ['view', 'terminalInput'],
      grantRequests: [grantRequest],
      policyVersion: asPolicyVersion(2),
      memberSessions: [{
        memberId: 'member-1',
        deviceId: 'device-a',
        createdAt: '2026-05-17T00:00:00.000Z',
      }],
    });
    const events: unknown[] = [];
    const terminal = terminalPublisher();
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
      terminalPublisher: terminal.publisher,
    });

    await service.approveGrantRequest('inv-1', 'grant-req-1');

    expect(events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          type: 'remote.taskProjection.v1',
          invitationId: 'inv-1',
        }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({
          type: 'remote.shareSessionProjection.v1',
          invitationId: 'inv-1',
          projection: expect.objectContaining({
            policyVersion: asPolicyVersion(2),
            primarySharedSession: expect.objectContaining({
              sessionAlias: 'primary',
              sessionId: 'agent-1',
              sessionEpoch: asSessionEpoch('3'),
            }),
          }),
        }),
      }),
    ]);
    expect(terminal.installed).toHaveLength(0);

    expect(service.recordTerminalPublicationDemand({
      principal: {
        kind: 'guest-member',
        invitationId: 'inv-1',
        memberSessionId: 'member-1',
        deviceId: 'device-a',
      },
      sessionId: asSessionId('agent-1'),
      sessionEpoch: asSessionEpoch('3'),
      proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-17T00:00:05.000Z' },
    })).toBe(true);
    expect(terminal.installed).toEqual([
      expect.objectContaining({
        publicationScopeId: 'guest-member:inv-1:member-1:device-a:agent-1:3',
        principal: {
          kind: 'guest-member',
          invitationId: 'inv-1',
          memberSessionId: 'member-1',
          deviceId: 'device-a',
        },
        sessionId: 'agent-1',
        sessionEpoch: asSessionEpoch('3'),
        policyVersion: asPolicyVersion(2),
        streamEncryption: {
          kind: 'guest-transport',
          memberSessionId: 'member-1',
        },
      }),
    ]);
    expect(terminal.demands).toEqual([
      expect.objectContaining({
        principal: {
          kind: 'guest-member',
          invitationId: 'inv-1',
          memberSessionId: 'member-1',
          deviceId: 'device-a',
        },
      }),
    ]);
  });

  it('does not publish a session projection when publication rules cannot be installed', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('task', '/tmp');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      createdAt: new Date('2026-05-17T00:00:00.000Z'),
      cwd: '/tmp',
      status: 'running',
    });
    const approvedShare = share({
      taskId: task.id,
      grants: ['view', 'terminalInput'],
      grantRequests: [grantRequest],
      memberId: 'member-1',
      memberDeviceId: 'device-a',
    });
    const events: unknown[] = [];
    const terminal = terminalPublisher({ cursor: null });
    const service = new TaskShareService({
      client: {
        ...clientFor(approvedShare),
        approveGrantRequest: async () => ({ share: approvedShare, request: grantRequest }),
      },
      taskStore,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(events.length + 1),
      publish: (event) => {
        events.push(event);
        return true;
      },
      terminalPublisher: terminal.publisher,
    });

    await service.approveGrantRequest('inv-1', 'grant-req-1');

    expect(events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'remote.taskProjection.v1' }),
      }),
    ]);
    expect(terminal.installed).toHaveLength(0);
  });

  it('installs a publication rule only for the demanded approved member session', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('task', '/tmp');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      createdAt: new Date('2026-05-17T00:00:00.000Z'),
      cwd: '/tmp',
      status: 'running',
    });
    const approvedShare = share({
      taskId: task.id,
      grants: ['view', 'terminalView'],
      grantRequests: [{
        ...grantRequest,
        requestedGrants: ['terminalView'],
        requestedBy: 'member-1',
      }],
      memberSessions: [
        { memberId: 'member-1', deviceId: 'device-a', createdAt: '2026-05-17T00:00:00.000Z' },
        { memberId: 'member-2', deviceId: 'device-b', createdAt: '2026-05-17T00:00:01.000Z' },
      ],
    });
    const events: unknown[] = [];
    const terminal = terminalPublisher();
    const service = new TaskShareService({
      client: clientFor(approvedShare),
      taskStore,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(events.length + 1),
      publish: (event) => {
        events.push(event);
        return true;
      },
      terminalPublisher: terminal.publisher,
    });

    await service.createTaskShare({ taskId: task.id, ttlMs: 60_000 });

    expect(events).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'remote.taskProjection.v1' }),
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ type: 'remote.shareSessionProjection.v1' }),
      }),
    ]);
    expect(service.recordTerminalPublicationDemand({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId: asSessionId('agent-1'),
      sessionEpoch: asSessionEpoch('3'),
      proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-17T00:00:05.000Z' },
    })).toBe(true);
    expect(service.recordTerminalPublicationDemand({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-2', deviceId: 'device-b' },
      sessionId: asSessionId('agent-1'),
      sessionEpoch: asSessionEpoch('3'),
      proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-17T00:00:05.000Z' },
    })).toBe(false);
    expect(terminal.installed.map((rule) => rule.principal)).toEqual([
      { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
    ]);
  });

  it('revokes installed terminal publication scopes when a share is revoked', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('task', '/tmp');
    taskStore.addSession(task.id, {
      tmuxSession: 'agent-1',
      agentType: 'claude-code',
      createdAt: new Date('2026-05-17T00:00:00.000Z'),
      cwd: '/tmp',
      status: 'running',
    });
    const createdShare = share({
      taskId: task.id,
      grants: ['view', 'terminalView'],
      grantRequests: [
        { ...grantRequest, requestedGrants: ['terminalView'], requestedBy: 'member-1' },
        { ...grantRequest, requestId: 'grant-req-2', requestedGrants: ['terminalView'], requestedBy: 'member-2' },
      ],
      memberSessions: [
        { memberId: 'member-1', deviceId: 'device-a', createdAt: '2026-05-17T00:00:00.000Z' },
        { memberId: 'member-2', deviceId: 'device-b', createdAt: '2026-05-17T00:00:01.000Z' },
      ],
    });
    const terminal = terminalPublisher();
    const service = new TaskShareService({
      client: clientFor(createdShare),
      taskStore,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(1),
      publish: () => true,
      terminalPublisher: terminal.publisher,
    });

    await service.createTaskShare({ taskId: task.id, ttlMs: 60_000 });
    expect(service.recordTerminalPublicationDemand({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-1', deviceId: 'device-a' },
      sessionId: asSessionId('agent-1'),
      sessionEpoch: asSessionEpoch('3'),
      proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-17T00:00:05.000Z' },
    })).toBe(true);
    expect(service.recordTerminalPublicationDemand({
      principal: { kind: 'guest-member', invitationId: 'inv-1', memberSessionId: 'member-2', deviceId: 'device-b' },
      sessionId: asSessionId('agent-1'),
      sessionEpoch: asSessionEpoch('3'),
      proof: { kind: 'guest-relay-presence', expiresAt: '2026-05-17T00:00:05.000Z' },
    })).toBe(true);
    await service.revokeTaskShare('inv-1');

    expect(terminal.revoked).toEqual([
      'guest-member:inv-1:member-1:device-a:agent-1:3',
      'guest-member:inv-1:member-2:device-b:agent-1:3',
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
      diagnoseTerminalSharing: () => ({
        state: 'blocked',
        reason: 'nodeUntrusted',
        message: 'Terminal sharing is disabled for this node.',
        checkedAt: '2026-05-17T00:00:00.000Z',
      }),
    });

    const denied = await service.denyGrantRequest('inv-1', 'grant-req-1');

    expect(denied.share.terminalSharing).toEqual(expect.objectContaining({
      state: 'blocked',
      reason: 'nodeUntrusted',
    }));
    expect(await service.listTaskShares()).toEqual([
      expect.objectContaining({
        invitationId: 'inv-1',
        grants: ['view'],
        grantRequests: [deniedRequest],
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it('attaches terminal sharing diagnostics to listed shares', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('task', '/tmp');
    const createdShare = share({ taskId: task.id });
    const service = new TaskShareService({
      client: clientFor(createdShare),
      taskStore,
      getNodeIdentity: () => ({ nodeId: asNodeId('kookr-node-test'), nodeEpoch: asNodeEpoch('1') }),
      nextServerRevision: () => asServerRevision(1),
      publish: () => true,
      diagnoseTerminalSharing: () => ({
        state: 'blocked',
        reason: 'nodeUntrusted',
        message: 'Terminal sharing is disabled for this node.',
        checkedAt: '2026-05-17T00:00:00.000Z',
      }),
    });

    const created = await service.createTaskShare({ taskId: task.id, ttlMs: 60_000 });

    expect(created.share.terminalSharing).toEqual(expect.objectContaining({
      state: 'blocked',
      reason: 'nodeUntrusted',
    }));
    expect(await service.listTaskShares()).toEqual([
      expect.objectContaining({
        invitationId: 'inv-1',
        terminalSharing: expect.objectContaining({
          state: 'blocked',
          reason: 'nodeUntrusted',
        }),
      }),
    ]);
  });
});
