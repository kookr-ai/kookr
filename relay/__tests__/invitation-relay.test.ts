import { once } from 'node:events';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { createRelayServer, type RelayServerHandle } from '../server.js';
import { makeNodeHello, type RelayHello, type RemoteFeature } from '../../src/remote/handshake.js';
import { asNodeEpoch } from '../../src/remote/ids.js';

async function listen(relay: RelayServerHandle): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      void Promise.resolve(predicate()).then((matched) => {
        if (!matched) {
          if (Date.now() - started > 1_500) {
            clearInterval(timer);
            reject(new Error('timed out waiting for condition'));
          }
          return;
        }
        clearInterval(timer);
        resolve();
      }).catch((err: unknown) => {
        clearInterval(timer);
        reject(err);
      });
    }, 10);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectNode(
  relay: RelayServerHandle,
  nodeId: string,
  token: string,
  supportedFeatures?: readonly RemoteFeature[],
): Promise<{ ws: WebSocket; messages: unknown[] }> {
  const wsUrl = new URL('/relay/node', relay.url());
  wsUrl.protocol = 'ws:';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  const messages: unknown[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
  await once(ws, 'open');
  ws.send(JSON.stringify(makeNodeHello({
    nodeId: nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
    nodeEpoch: asNodeEpoch('1'),
    softwareVersion: 'test',
    ...(supportedFeatures ? { supportedFeatures } : {}),
  })));
  await waitFor(() => messages.some((msg) => (msg as RelayHello).type === 'relay.hello'));
  return { ws, messages };
}

async function connectMember(relay: RelayServerHandle, nodeId: string, memberToken: string): Promise<{ ws: WebSocket; messages: unknown[]; closed: Promise<unknown[]> }> {
  const wsUrl = new URL('/relay/client', relay.url());
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  const ws = new WebSocket(wsUrl, { headers: { cookie: `kookr_relay_member_token=${memberToken}` } });
  const messages: unknown[] = [];
  const closed = new Promise<unknown[]>((resolve) => {
    ws.once('close', (code, reason) => resolve([code, reason.toString()]));
  });
  ws.on('message', (data) => messages.push(JSON.parse(data.toString()) as unknown));
  await once(ws, 'open');
  return { ws, messages, closed };
}

async function expectMemberConnectionRejected(relay: RelayServerHandle, nodeId: string, memberToken: string): Promise<void> {
  const wsUrl = new URL('/relay/client', relay.url());
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  const ws = new WebSocket(wsUrl, { headers: { cookie: `kookr_relay_member_token=${memberToken}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.close();
      reject(new Error('member unexpectedly connected'));
    });
    ws.once('unexpected-response', (_req, res) => {
      expect(res.statusCode).toBe(401);
      resolve();
    });
    ws.once('error', reject);
  });
}

async function expectMemberQueryConnectionRejected(relay: RelayServerHandle, nodeId: string, memberToken: string): Promise<void> {
  const wsUrl = new URL('/relay/client', relay.url());
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  wsUrl.searchParams.set('memberToken', memberToken);
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.close();
      reject(new Error('member unexpectedly connected with query token'));
    });
    ws.once('unexpected-response', (_req, res) => {
      expect(res.statusCode).toBe(401);
      resolve();
    });
    ws.once('error', reject);
  });
}

async function expectTerminalConnectionRejected(relay: RelayServerHandle, nodeId: string, memberToken: string): Promise<void> {
  const wsUrl = new URL('/relay/client', relay.url());
  wsUrl.protocol = 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  wsUrl.searchParams.set('terminalSessionId', 'session-1');
  wsUrl.searchParams.set('terminalSessionEpoch', '1');
  wsUrl.searchParams.set('afterSeq', '0');
  const ws = new WebSocket(wsUrl, { headers: { cookie: `kookr_relay_member_token=${memberToken}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      ws.close();
      reject(new Error('member unexpectedly connected to terminal stream'));
    });
    ws.once('unexpected-response', (_req, res) => {
      expect(res.statusCode).toBe(403);
      resolve();
    });
    ws.once('error', reject);
  });
}

describe('relay invitations', () => {
  let relay: RelayServerHandle | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    }
    await relay?.close();
    relay = null;
  });

  it('accepts single-use invitations and revocation closes members and emits policy.revoke', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);

    const created = relay.createInvitation({
      nodeId: node.nodeId,
      grants: ['view', 'comment', 'terminalInput'],
    });
    const accepted = relay.acceptInvitation(created.token, 'alice');
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('expected accept');
    expect(relay.acceptInvitation(created.token, 'bob')).toEqual({ ok: false, reason: 'already-used' });

    await waitFor(() => nodeConn.messages.some((msg) => (msg as { type?: string }).type === 'policy.delta'));
    expect(nodeConn.messages).toContainEqual(expect.objectContaining({
      type: 'policy.delta',
      upserts: [expect.objectContaining({ grantId: created.invitation.grantId })],
    }));

    const member = await connectMember(relay, node.nodeId, accepted.accepted.memberToken);
    sockets.push(member.ws);
    await waitFor(() => member.messages.some((msg) => (msg as { type?: string }).type === 'relay.presence'));

    const revoked = relay.revokeInvitation(created.invitation.invitationId);
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) throw new Error('expected revoke');
    await member.closed;
    await waitFor(() => nodeConn.messages.some((msg) => (msg as { type?: string }).type === 'policy.revoke'));
    expect(nodeConn.messages).toContainEqual(expect.objectContaining({
      type: 'policy.revoke',
      grantId: created.invitation.grantId,
    }));
  });

  it('serves the invitation lifecycle through HTTP routes', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });

    const createRes = await fetch(`${relay.url()}/relay/admin/invitations`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
      body: JSON.stringify({ nodeId: node.nodeId, grants: ['view', 'comment'] }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { token: string; invitation: { invitationId: string }; acceptUrl: string };
    expect(created.acceptUrl).toContain('/relay/join#inviteToken=');
    expect(created.acceptUrl).not.toContain('?inviteToken');

    const acceptRes = await fetch(`${relay.url()}/relay/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: created.token, displayName: 'alice' }),
    });
    expect(acceptRes.status).toBe(200);
    const memberCookie = acceptRes.headers.get('set-cookie') ?? '';
    expect(memberCookie).toContain('kookr_relay_member_token=');
    expect(memberCookie).toContain('Path=/relay');
    expect(memberCookie).toContain('HttpOnly');
    expect(memberCookie).toContain('SameSite=Lax');
    const accepted = await acceptRes.json() as { nodeId: string; memberToken?: string; invitation?: unknown };
    expect(accepted.nodeId).toBe(node.nodeId);
    expect(accepted).not.toHaveProperty('memberToken');
    expect(accepted).not.toHaveProperty('invitation');
    const cookieToken = /kookr_relay_member_token=([^;]+)/.exec(memberCookie)?.[1];
    expect(cookieToken).toBeTruthy();
    const memberToken = decodeURIComponent(cookieToken ?? '');
    expect(memberToken).toMatch(/^kookr_member_v1_/);

    const queryStateUrl = new URL('/relay/dashboard/state', relay.url());
    queryStateUrl.searchParams.set('nodeId', node.nodeId);
    queryStateUrl.searchParams.set('memberToken', memberToken);
    const queryStateRes = await fetch(queryStateUrl);
    expect(queryStateRes.status).toBe(401);
    await expectMemberQueryConnectionRejected(relay, node.nodeId, memberToken);

    const secondAcceptRes = await fetch(`${relay.url()}/relay/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: created.token, displayName: 'bob' }),
    });
    expect(secondAcceptRes.status).toBe(409);

    const revokeRes = await fetch(`${relay.url()}/relay/admin/invitations/${encodeURIComponent(created.invitation.invitationId)}/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin' },
    });
    expect(revokeRes.status).toBe(200);
    const revoked = await revokeRes.json() as { alreadyRevoked: boolean };
    expect(revoked.alreadyRevoked).toBe(false);
  });

  it('syncs accepted grants when a node connects after offline invitation acceptance', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const created = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'session', nodeId: node.nodeId, sessionId: 'session-1' },
      grants: ['terminalInput'],
    });
    const accepted = relay.acceptInvitation(created.token, 'alice');
    expect(accepted.ok).toBe(true);

    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);
    await waitFor(() => nodeConn.messages.some((msg) => (msg as { type?: string }).type === 'policy.sync'));
    expect(nodeConn.messages).toContainEqual(expect.objectContaining({
      type: 'policy.sync',
      grants: [expect.objectContaining({ grantId: created.invitation.grantId })],
    }));
  });

  it('does not allow a member token issued for one node to connect to another node', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const nodeA = relay.registerNode({ displayName: 'desktop-a' });
    const nodeB = relay.registerNode({ displayName: 'desktop-b' });
    const created = relay.createInvitation({ nodeId: nodeA.nodeId, grants: ['view'] });
    const accepted = relay.acceptInvitation(created.token, 'alice');
    if (!accepted.ok) throw new Error('expected accept');

    await expectMemberConnectionRejected(relay, nodeB.nodeId, accepted.accepted.memberToken);
  });

  it('closes active member subscriptions after invitation expiry before streaming more data', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);
    const created = relay.createInvitation({ nodeId: node.nodeId, grants: ['view'], ttlMs: 20 });
    const accepted = relay.acceptInvitation(created.token, 'alice');
    if (!accepted.ok) throw new Error('expected accept');
    const member = await connectMember(relay, node.nodeId, accepted.accepted.memberToken);
    sockets.push(member.ws);

    await new Promise((resolve) => setTimeout(resolve, 30));
    nodeConn.ws.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: 1,
      ts: new Date().toISOString(),
      kind: 'snapshot',
      payload: { tasks: [{ taskId: 'after-expiry' }] },
    }));

    await expect(member.closed).resolves.toEqual([4002, 'grant expired']);
    expect(member.messages).not.toContainEqual(expect.objectContaining({
      payload: { tasks: [{ taskId: 'after-expiry' }] },
    }));
  });

  it('filters A0 task projection snapshots by the accepted view grant before sending', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);
    const inviteA = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view'],
    });
    const inviteB = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-b' },
      grants: ['view'],
    });
    const acceptedA = relay.acceptInvitation(inviteA.token, 'alice');
    const acceptedB = relay.acceptInvitation(inviteB.token, 'bob');
    if (!acceptedA.ok || !acceptedB.ok) throw new Error('expected accept');
    const memberA = await connectMember(relay, node.nodeId, acceptedA.accepted.memberToken);
    const memberB = await connectMember(relay, node.nodeId, acceptedB.accepted.memberToken);
    sockets.push(memberA.ws, memberB.ws);

    nodeConn.ws.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: 1,
      ts: new Date().toISOString(),
      kind: 'snapshot',
      payload: {
        type: 'remote.taskProjection.v1',
        invitationId: inviteA.invitation.invitationId,
        projection: {
          schemaVersion: 'remote-task-projection.v1',
          nodeId: node.nodeId,
          taskId: 'task-a',
          taskLabel: 'Task A',
          status: 'inProgress',
          hasFinding: false,
          needsInput: false,
          updatedAt: new Date().toISOString(),
        },
      },
    }));

    await waitFor(() => memberA.messages.some((msg) => (
      (msg as { payload?: { projection?: { taskId?: string } } }).payload?.projection?.taskId === 'task-a'
    )));
    await sleep(50);
    expect(memberB.messages).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        projection: expect.objectContaining({ taskId: 'task-a' }),
      }),
    }));

    nodeConn.ws.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: 3,
      ts: new Date().toISOString(),
      kind: 'snapshot',
      payload: {
        tasks: [{
          taskId: 'task-a',
          prompt: 'SECRET_RAW_PROMPT',
          cwd: '/private/customer-billing',
        }],
      },
    }));
    await sleep(50);
    expect(memberA.messages).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        tasks: expect.any(Array),
      }),
    }));
    expect(JSON.stringify(memberA.messages)).not.toContain('SECRET_RAW_PROMPT');
    expect(JSON.stringify(memberA.messages)).not.toContain('/private/customer-billing');

    nodeConn.ws.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: 2,
      ts: new Date().toISOString(),
      kind: 'snapshot',
      payload: {
        type: 'remote.taskProjection.v1',
        invitationId: inviteA.invitation.invitationId,
        projection: {
          schemaVersion: 'remote-task-projection.v1',
          nodeId: node.nodeId,
          taskId: 'malformed-task',
          taskLabel: 'Malformed Task',
          hasFinding: false,
          needsInput: false,
          updatedAt: new Date().toISOString(),
        },
      },
    }));
    await sleep(50);
    expect(memberA.messages).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        projection: expect.objectContaining({ taskId: 'malformed-task' }),
      }),
    }));
  });

  it('filters replayed dashboard state by the accepted view grant', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);
    const inviteA = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view'],
    });
    const inviteB = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-b' },
      grants: ['view'],
    });
    const acceptedA = relay.acceptInvitation(inviteA.token, 'alice');
    if (!acceptedA.ok) throw new Error('expected accept');

    nodeConn.ws.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      serverRevision: 1,
      ts: new Date().toISOString(),
      kind: 'snapshot',
      payload: {
        type: 'remote.taskProjection.v1',
        invitationId: inviteB.invitation.invitationId,
        projection: {
          schemaVersion: 'remote-task-projection.v1',
          nodeId: node.nodeId,
          taskId: 'task-b',
          taskLabel: 'Task B',
          status: 'inProgress',
          hasFinding: false,
          needsInput: false,
          updatedAt: new Date().toISOString(),
        },
      },
    }));

    const ownerStateUrl = new URL('/relay/dashboard/state', relay.url());
    ownerStateUrl.searchParams.set('nodeId', node.nodeId);
    await waitFor(async () => {
      const ownerState = await fetch(ownerStateUrl, { headers: { authorization: 'Bearer admin' } });
      const body = await ownerState.json() as { events: Array<{ payload?: { projection?: { taskId?: string } } }> };
      return body.events.some((event) => event.payload?.projection?.taskId === 'task-b');
    });
    const stateUrl = new URL('/relay/dashboard/state', relay.url());
    stateUrl.searchParams.set('nodeId', node.nodeId);
    const res = await fetch(stateUrl, { headers: { cookie: `kookr_relay_member_token=${acceptedA.accepted.memberToken}` } });
    expect(res.status).toBe(200);
    const state = await res.json() as { events: Array<{ payload?: { projection?: { taskId?: string } } }> };
    expect(state.events).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({
        projection: expect.objectContaining({ taskId: 'task-b' }),
      }),
    }));
  });

  it('does not expose terminal replay or streams to view-only task members', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken, [
      'control.snapshot',
      'control.state-delta',
      'policy-sync',
      'terminal-stream',
    ]);
    sockets.push(nodeConn.ws);
    const created = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view'],
    });
    const accepted = relay.acceptInvitation(created.token, 'alice');
    if (!accepted.ok) throw new Error('expected accept');

    nodeConn.ws.send(JSON.stringify({
      nodeId: node.nodeId,
      nodeEpoch: asNodeEpoch('1'),
      sessionId: 'session-1',
      sessionEpoch: '1',
      seq: 1,
      ts: new Date().toISOString(),
      kind: 'terminal.bytes',
      payload: {
        encoding: 'base64',
        data: Buffer.from('SECRET_TERMINAL_BYTES').toString('base64'),
        byteLength: Buffer.byteLength('SECRET_TERMINAL_BYTES'),
      },
    }));

    const stateUrl = new URL('/relay/dashboard/state', relay.url());
    stateUrl.searchParams.set('nodeId', node.nodeId);
    stateUrl.searchParams.set('terminalSessionId', 'session-1');
    stateUrl.searchParams.set('terminalSessionEpoch', '1');
    stateUrl.searchParams.set('afterSeq', '0');
    const res = await fetch(stateUrl, {
      headers: { cookie: `kookr_relay_member_token=${accepted.accepted.memberToken}` },
    });
    expect(res.status).toBe(403);
    await expectTerminalConnectionRejected(relay, node.nodeId, accepted.accepted.memberToken);

    const member = await connectMember(relay, node.nodeId, accepted.accepted.memberToken);
    sockets.push(member.ws);
    member.ws.send(JSON.stringify({
      type: 'terminal.replay.request',
      payload: { sessionId: 'session-1', sessionEpoch: '1', afterSeq: 0 },
    }));
    await expect(member.closed).resolves.toEqual([1008, 'terminal grant required']);
    expect(member.messages).not.toContainEqual(expect.objectContaining({ kind: 'terminal.bytes' }));
  });

  it('routes command results only to the member that originated the command', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);
    const viewInvite = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view'],
    });
    const terminalInvite = relay.createInvitation({ nodeId: node.nodeId, grants: ['terminalInput'] });
    const acceptedView = relay.acceptInvitation(viewInvite.token, 'viewer');
    const acceptedTerminal = relay.acceptInvitation(terminalInvite.token, 'operator');
    if (!acceptedView.ok || !acceptedTerminal.ok) throw new Error('expected accept');
    const viewMember = await connectMember(relay, node.nodeId, acceptedView.accepted.memberToken);
    const terminalMember = await connectMember(relay, node.nodeId, acceptedTerminal.accepted.memberToken);
    const ownerUrl = new URL('/relay/client', relay.url());
    ownerUrl.protocol = 'ws:';
    ownerUrl.searchParams.set('nodeId', node.nodeId);
    const ownerWs = new WebSocket(ownerUrl, { headers: { authorization: 'Bearer admin' } });
    const ownerMessages: unknown[] = [];
    ownerWs.on('message', (data) => ownerMessages.push(JSON.parse(data.toString()) as unknown));
    await once(ownerWs, 'open');
    sockets.push(viewMember.ws, terminalMember.ws, ownerWs);

    const nodeSawCommand = new Promise<void>((resolve) => {
      nodeConn.ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as { type?: string; commandId?: string; action?: string };
        if (msg.type !== 'remote.command' || msg.commandId !== 'cmd-secret-result') return;
        nodeConn.ws.send(JSON.stringify({
          type: 'remote.command.result',
          commandId: msg.commandId,
          action: msg.action,
          outcome: 'accepted',
          result: { output: 'SECRET_COMMAND_RESULT' },
        }));
        resolve();
      });
    });

    terminalMember.ws.send(JSON.stringify({
      type: 'remote.command',
      commandId: 'cmd-secret-result',
      action: 'presetReply',
      payload: { presetId: 'continue' },
    }));

    await nodeSawCommand;
    await waitFor(() => terminalMember.messages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-secret-result'));
    await sleep(50);
    expect(viewMember.messages).not.toContainEqual(expect.objectContaining({
      commandId: 'cmd-secret-result',
    }));
    expect(JSON.stringify(viewMember.messages)).not.toContain('SECRET_COMMAND_RESULT');

    nodeConn.ws.send(JSON.stringify({
      type: 'remote.command.result',
      commandId: 'cmd-unmatched-secret-result',
      action: 'presetReply',
      outcome: 'accepted',
      result: { output: 'UNMATCHED_SECRET_COMMAND_RESULT' },
    }));
    await waitFor(() => ownerMessages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-unmatched-secret-result'));
    await sleep(50);
    expect(ownerMessages).toContainEqual(expect.objectContaining({
      commandId: 'cmd-unmatched-secret-result',
      result: { output: 'UNMATCHED_SECRET_COMMAND_RESULT' },
    }));
    expect(viewMember.messages).not.toContainEqual(expect.objectContaining({
      commandId: 'cmd-unmatched-secret-result',
    }));
    expect(JSON.stringify(viewMember.messages)).not.toContain('UNMATCHED_SECRET_COMMAND_RESULT');
  });

  it('denies commands outside the accepted invitation grants without forwarding to the node', async () => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);
    const created = relay.createInvitation({ nodeId: node.nodeId, grants: ['view'] });
    const accepted = relay.acceptInvitation(created.token, 'alice');
    if (!accepted.ok) throw new Error('expected accept');

    const member = await connectMember(relay, node.nodeId, accepted.accepted.memberToken);
    sockets.push(member.ws);
    member.ws.send(JSON.stringify({
      type: 'remote.command',
      commandId: 'cmd-launch-denied',
      action: 'launch',
    }));

    await waitFor(() => member.messages.some((msg) => (msg as { commandId?: string }).commandId === 'cmd-launch-denied'));
    expect(member.messages).toContainEqual(expect.objectContaining({
      commandId: 'cmd-launch-denied',
      outcome: 'rejected-pre-audit',
      reason: 'missing launch grant',
    }));
    expect(nodeConn.messages).not.toContainEqual(expect.objectContaining({
      type: 'remote.command',
      commandId: 'cmd-launch-denied',
    }));
  });
});
