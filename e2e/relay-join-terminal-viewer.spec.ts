import { once } from 'node:events';

import { test, expect, type Page } from '@playwright/test';
import WebSocket from 'ws';

import { createRelayServer, type RelayServerHandle } from '../relay/server.js';
import { makeNodeHello, type RelayHello, type RemoteFeature } from '../src/remote/handshake.js';
import { asNodeEpoch } from '../src/remote/ids.js';

async function listen(relay: RelayServerHandle): Promise<void> {
  await new Promise<void>((resolve) => relay.httpServer.listen(0, '127.0.0.1', () => resolve()));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      void Promise.resolve(predicate()).then((matched) => {
        if (matched) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('timed out waiting for condition'));
        }
      }).catch((err: unknown) => {
        clearInterval(timer);
        reject(err);
      });
    }, 10);
  });
}

async function connectNode(
  relay: RelayServerHandle,
  nodeId: string,
  token: string,
  nodeEpoch = '1',
): Promise<{ ws: WebSocket; messages: unknown[] }> {
  const wsUrl = new URL('/relay/node', relay.url());
  wsUrl.protocol = 'ws:';
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  const messages: unknown[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as { type?: string; policyVersion?: number; upserts?: Array<{ grantId: string }>; grants?: Array<{ grantId: string }>; revokes?: string[]; revokedGrantIds?: string[] };
    messages.push(msg);
    if (msg.type !== 'policy.delta' && msg.type !== 'policy.sync' && msg.type !== 'policy.revoke') return;
    ws.send(JSON.stringify({
      type: 'policy.delta.ack',
      nodeId,
      policyVersion: msg.policyVersion,
      appliedGrantIds: (msg.upserts ?? msg.grants ?? []).map((grant) => grant.grantId),
      revokedGrantIds: msg.revokes ?? msg.revokedGrantIds ?? [],
    }));
  });
  await once(ws, 'open');
  ws.send(JSON.stringify(makeNodeHello({
    nodeId: nodeId as ReturnType<typeof makeNodeHello>['nodeId'],
    nodeEpoch: asNodeEpoch(nodeEpoch),
    softwareVersion: 'test',
    supportedFeatures: [
      'control.snapshot',
      'control.state-delta',
      'policy-sync',
      'terminal-stream',
      'terminal-input',
    ] satisfies RemoteFeature[],
  })));
  await waitFor(() => messages.some((msg) => (msg as RelayHello).type === 'relay.hello'));
  return { ws, messages };
}

function publishTaskProjection(ws: WebSocket, opts: { nodeId: string; invitationId: string }): void {
  ws.send(JSON.stringify({
    nodeId: opts.nodeId,
    nodeEpoch: '1',
    serverRevision: 1,
    ts: new Date().toISOString(),
    kind: 'snapshot',
    payload: {
      type: 'remote.taskProjection.v1',
      invitationId: opts.invitationId,
      projection: {
        schemaVersion: 'remote-task-projection.v1',
        nodeId: opts.nodeId,
        taskId: 'task-a',
        taskLabel: 'Shared terminal task',
        status: 'inProgress',
        hasFinding: false,
        needsInput: false,
        updatedAt: new Date().toISOString(),
      },
    },
  }));
}

function publishSessionProjection(ws: WebSocket, opts: { nodeId: string; invitationId: string; policyVersion: number; version?: number }): void {
  ws.send(JSON.stringify({
    nodeId: opts.nodeId,
    nodeEpoch: '1',
    serverRevision: 1,
    ts: new Date().toISOString(),
    kind: 'snapshot',
    payload: {
      type: 'remote.shareSessionProjection.v1',
      invitationId: opts.invitationId,
      projection: {
        schemaVersion: 'share-session-projection.v1',
        nodeId: opts.nodeId,
        nodeInstanceId: '1',
        projectionId: 'proj-primary',
        projectionVersion: opts.version ?? 1,
        policyVersion: opts.policyVersion,
        generatedAt: new Date().toISOString(),
        primarySharedSession: {
          sessionAlias: 'primary',
          sessionId: 'session-1',
          sessionEpoch: '1',
        },
      },
    },
  }));
}

function sendTerminalBytes(ws: WebSocket, nodeId: string, seq: number, text: string): void {
  ws.send(JSON.stringify({
    nodeId,
    nodeEpoch: '1',
    sessionId: 'session-1',
    sessionEpoch: '1',
    seq,
    ts: new Date().toISOString(),
    kind: 'terminal.bytes',
    payload: {
      encoding: 'base64',
      data: Buffer.from(text).toString('base64'),
      byteLength: Buffer.byteLength(text),
    },
  }));
}

async function joinShare(page: Page, joinUrl: string): Promise<void> {
  await page.goto(joinUrl);
  await expect(page.getByLabel('Share ID')).toHaveValue(/^\d{3}-\d{3}$/);
  await expect(page.getByLabel('Password')).not.toHaveValue('');
  await page.getByLabel('Display name').fill('Browser viewer');
  await page.getByRole('button', { name: 'Join' }).click();
}

test.describe('relay join terminal viewer', () => {
  let relay: RelayServerHandle | null = null;
  const sockets: WebSocket[] = [];

  test.afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    }
    await relay?.close();
    relay = null;
  });

  test('streams projected terminal output on desktop and mobile layouts', async ({ page }) => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);

    const created = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view', 'terminalView'],
      shareTicket: true,
    });
    if (!created.shareTicket) throw new Error('expected share ticket');
    const joinUrl = `${relay.url()}/relay/join/${encodeURIComponent(created.shareTicket.shareId)}#password=${encodeURIComponent(created.shareTicket.password)}`;

    await joinShare(page, joinUrl);
    await waitFor(() => Boolean(relay!.invitations()[0]?.acceptedAt));
    const accepted = relay.invitations()[0]!;
    await waitFor(() => relay!.nodeStatuses()[0]?.policySyncStatus === 'acked');
    publishTaskProjection(nodeConn.ws, { nodeId: node.nodeId, invitationId: accepted.invitationId });
    publishSessionProjection(nodeConn.ws, { nodeId: node.nodeId, invitationId: accepted.invitationId, policyVersion: accepted.policyVersion });
    sendTerminalBytes(nodeConn.ws, node.nodeId, 1, 'DESKTOP_TERMINAL_STREAM');

    await expect(page.getByLabel('Shared terminal')).toBeVisible();
    await expect(page.locator('#terminal')).toContainText('DESKTOP_TERMINAL_STREAM', { timeout: 10_000 });
    await expect(page.getByLabel('Terminal input message')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();

    await page.setViewportSize({ width: 390, height: 420 });
    await expect(page.getByLabel('Shared terminal')).toBeVisible();
    const noOverlap = await page.evaluate(() => {
      const terminal = document.getElementById('terminal-shell')!.getBoundingClientRect();
      const composer = document.getElementById('terminal-composer')!.getBoundingClientRect();
      return terminal.bottom <= composer.top || composer.bottom <= terminal.top;
    });
    expect(noOverlap).toBe(true);
  });

  test('shows replay-gap and stale-projection states with input disabled', async ({ page }) => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin', terminalReplayMaxEvents: 1 });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);

    const created = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view', 'terminalView'],
      shareTicket: true,
    });
    if (!created.shareTicket) throw new Error('expected share ticket');
    const joinUrl = `${relay.url()}/relay/join/${encodeURIComponent(created.shareTicket.shareId)}#password=${encodeURIComponent(created.shareTicket.password)}`;
    sendTerminalBytes(nodeConn.ws, node.nodeId, 1, 'old');
    sendTerminalBytes(nodeConn.ws, node.nodeId, 2, 'tail');

    await joinShare(page, joinUrl);
    await waitFor(() => Boolean(relay!.invitations()[0]?.acceptedAt));
    const accepted = relay.invitations()[0]!;
    await waitFor(() => relay!.nodeStatuses()[0]?.policySyncStatus === 'acked');
    publishSessionProjection(nodeConn.ws, { nodeId: node.nodeId, invitationId: accepted.invitationId, policyVersion: accepted.policyVersion });

    await expect(page.locator('#terminal-banner')).toContainText('Terminal replay gap detected', { timeout: 10_000 });
    await expect(page.getByLabel('Terminal input message')).toBeDisabled();

    publishSessionProjection(nodeConn.ws, {
      nodeId: node.nodeId,
      invitationId: accepted.invitationId,
      policyVersion: accepted.policyVersion,
      version: 2,
    });
    await expect(page.locator('#terminal-banner')).toContainText('Terminal projection changed', { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  });
});
