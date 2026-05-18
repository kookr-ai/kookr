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
      'terminal-publication-gate.v1',
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
    publication: {
      publicationScopeId: 'test-terminal-publication',
      principal: {
        kind: 'contact-device',
        contactId: 'contact-test',
        deviceId: 'device-test',
      },
      policyVersion: 1,
    },
  }));
}

function sendGuestTerminalBytes(ws: WebSocket, opts: {
  nodeId: string;
  invitationId: string;
  memberSessionId: string;
  deviceId: string;
  policyVersion: number;
  seq: number;
  text: string;
}): void {
  ws.send(JSON.stringify({
    nodeId: opts.nodeId,
    nodeEpoch: '1',
    sessionId: 'session-1',
    sessionEpoch: '1',
    seq: opts.seq,
    ts: new Date().toISOString(),
    kind: 'terminal.bytes',
    payload: {
      encoding: 'base64',
      data: Buffer.from(opts.text).toString('base64'),
      byteLength: Buffer.byteLength(opts.text),
    },
    publication: {
      publicationScopeId: 'test-guest-terminal-publication',
      principal: {
        kind: 'guest-member',
        invitationId: opts.invitationId,
        memberSessionId: opts.memberSessionId,
        deviceId: opts.deviceId,
      },
      policyVersion: opts.policyVersion,
      streamEncryption: { kind: 'guest-transport', memberSessionId: opts.memberSessionId },
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

  test('keeps Guest Link terminal output blocked until owner approval on desktop and mobile layouts', async ({ page }) => {
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

    await expect(page.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await expect(page.getByLabel('Shared terminal')).toBeHidden();
    await expect(page.locator('#terminal')).not.toContainText('DESKTOP_TERMINAL_STREAM');
    await expect(page.getByLabel('Terminal input message')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send Enter' })).toBeDisabled();

    await page.setViewportSize({ width: 390, height: 420 });
    await expect(page.getByLabel('Shared task projection')).toBeVisible();
    await expect(page.getByLabel('Shared terminal')).toBeHidden();
    const noOverlap = await page.evaluate(() => {
      const terminal = document.getElementById('terminal-shell')!.getBoundingClientRect();
      const composer = document.getElementById('terminal-composer')!.getBoundingClientRect();
      return terminal.bottom <= composer.top || composer.bottom <= terminal.top;
    });
    expect(noOverlap).toBe(true);
  });

  test('keeps replay-gap and stale-projection terminal states hidden before Guest Link approval', async ({ page }) => {
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
    sendTerminalBytes(nodeConn.ws, node.nodeId, 1, 'old');
    sendTerminalBytes(nodeConn.ws, node.nodeId, 2, 'tail');

    await joinShare(page, joinUrl);
    await waitFor(() => Boolean(relay!.invitations()[0]?.acceptedAt));
    const accepted = relay.invitations()[0]!;
    await waitFor(() => relay!.nodeStatuses()[0]?.policySyncStatus === 'acked');
    publishTaskProjection(nodeConn.ws, { nodeId: node.nodeId, invitationId: accepted.invitationId });
    publishSessionProjection(nodeConn.ws, { nodeId: node.nodeId, invitationId: accepted.invitationId, policyVersion: accepted.policyVersion });

    await expect(page.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await expect(page.locator('#terminal')).not.toContainText('tail');
    await expect(page.getByLabel('Terminal input message')).toBeDisabled();
    sendTerminalBytes(nodeConn.ws, node.nodeId, 3, 'fresh');
    await expect(page.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await expect(page.locator('#terminal')).not.toContainText('fresh');

    publishSessionProjection(nodeConn.ws, {
      nodeId: node.nodeId,
      invitationId: accepted.invitationId,
      policyVersion: accepted.policyVersion,
      version: 2,
    });
    await expect(page.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await expect(page.getByLabel('Shared terminal')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Send Enter' })).toBeDisabled();
  });

  test('keeps Guest Link terminal input disabled with view-only approval', async ({ page }) => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    nodeConn.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; commandId?: string; action?: string };
      if (msg.type !== 'remote.command' || !msg.commandId || !msg.action) return;
      nodeConn.ws.send(JSON.stringify({
        type: 'remote.command.result',
        commandId: msg.commandId,
        action: msg.action,
        outcome: 'accepted',
        result: msg.action === 'leaseAcquire' ? { leaseId: (msg as { leaseId?: string }).leaseId } : {},
      }));
    });
    sockets.push(nodeConn.ws);

    const created = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view', 'terminalInput'],
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
    sendTerminalBytes(nodeConn.ws, node.nodeId, 1, 'INPUT_READY');

    await expect(page.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await expect(page.getByLabel('Shared terminal')).toBeHidden();
    await expect(page.locator('#terminal')).not.toContainText('INPUT_READY');
    await expect(page.getByLabel('Terminal input message')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Send Enter' })).toBeDisabled();
    expect(nodeConn.messages.some((msg) => (
      (msg as { type?: string; action?: string; payload?: { text?: string } }).type === 'remote.command'
      && (msg as { action?: string }).action === 'submitMessage'
    ))).toBe(false);
  });

  test('shows approved Guest Link terminal viewing without replaying pre-approval bytes', async ({ page }) => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    sockets.push(nodeConn.ws);

    const created = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view'],
      shareTicket: true,
    });
    if (!created.shareTicket) throw new Error('expected share ticket');
    const joinUrl = `${relay.url()}/relay/join/${encodeURIComponent(created.shareTicket.shareId)}#password=${encodeURIComponent(created.shareTicket.password)}`;

    await joinShare(page, joinUrl);
    await waitFor(() => Boolean(relay!.invitations()[0]?.acceptedAt));
    let accepted = relay.invitations()[0]!;
    await waitFor(() => relay!.nodeStatuses()[0]?.policySyncStatus === 'acked');
    publishTaskProjection(nodeConn.ws, { nodeId: node.nodeId, invitationId: accepted.invitationId });
    publishSessionProjection(nodeConn.ws, { nodeId: node.nodeId, invitationId: accepted.invitationId, policyVersion: accepted.policyVersion });
    sendGuestTerminalBytes(nodeConn.ws, {
      nodeId: node.nodeId,
      invitationId: accepted.invitationId,
      memberSessionId: accepted.memberId ?? 'member-unknown',
      deviceId: accepted.memberDeviceId ?? 'device-unknown',
      policyVersion: accepted.policyVersion,
      seq: 1,
      text: 'PRE_APPROVAL_SECRET',
    });

    await expect(page.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#terminal-banner')).toContainText('Terminal viewing requires owner approval.');
    await expect(page.locator('#terminal')).not.toContainText('PRE_APPROVAL_SECRET');
    await page.getByRole('button', { name: 'Request terminal viewing' }).click();
    await expect(page.locator('#terminal-status-title')).toContainText('Terminal request pending');
    await waitFor(() => (relay!.invitations()[0]?.grantRequests ?? []).some((request) => request.status === 'pending'));

    const pendingRequest = relay.invitations()[0]!.grantRequests![0]!;
    const approve = await fetch(
      `${relay.url()}/relay/node/invitations/${encodeURIComponent(accepted.invitationId)}/grant-requests/${encodeURIComponent(pendingRequest.requestId)}/approve`,
      { method: 'POST', headers: { authorization: `Bearer ${node.nodeToken}` } },
    );
    expect(approve.status).toBe(200);
    await waitFor(() => relay!.nodeStatuses()[0]?.policySyncStatus === 'acked');
    accepted = relay.invitations()[0]!;
    expect(accepted.memberId).toBeTruthy();
    expect(accepted.memberDeviceId).toBeTruthy();
    const memberSessionId = accepted.memberId!;
    const deviceId = accepted.memberDeviceId!;
    publishSessionProjection(nodeConn.ws, {
      nodeId: node.nodeId,
      invitationId: accepted.invitationId,
      policyVersion: accepted.policyVersion,
      version: 2,
    });

    await expect(page.locator('#terminal-status-title')).toContainText('Terminal viewing approved', { timeout: 10_000 });
    await expect(page.getByLabel('Shared terminal')).toBeVisible();
    await expect(page.getByLabel('Terminal input message')).toBeDisabled();
    await waitFor(() => nodeConn.messages.some((msg) => (
      (msg as { type?: string; sessionId?: string; sessionEpoch?: string; principal?: { memberSessionId?: string; deviceId?: string } }).type === 'terminal.publicationDemand.v1'
      && (msg as { sessionId?: string }).sessionId === 'session-1'
      && (msg as { sessionEpoch?: string }).sessionEpoch === '1'
      && (msg as { principal?: { memberSessionId?: string; deviceId?: string } }).principal?.memberSessionId === memberSessionId
      && (msg as { principal?: { memberSessionId?: string; deviceId?: string } }).principal?.deviceId === deviceId
    )), 10_000);
    sendGuestTerminalBytes(nodeConn.ws, {
      nodeId: node.nodeId,
      invitationId: accepted.invitationId,
      memberSessionId,
      deviceId,
      policyVersion: accepted.policyVersion,
      seq: 2,
      text: '\r\nAPPROVED_LIVE_BYTES\r\n',
    });

    await expect(page.locator('#terminal')).toContainText('APPROVED_LIVE_BYTES', { timeout: 10_000 });
    await expect(page.locator('#terminal')).not.toContainText('PRE_APPROVAL_SECRET');
  });

  test('keeps Guest Link terminal viewing blocked across refresh before approval', async ({ page }) => {
    relay = createRelayServer({ allowInsecureClients: false, adminToken: 'admin' });
    await listen(relay);
    const node = relay.registerNode({ displayName: 'desktop' });
    const nodeConn = await connectNode(relay, node.nodeId, node.nodeToken);
    nodeConn.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; commandId?: string; action?: string };
      if (msg.type !== 'remote.command' || !msg.commandId || !msg.action) return;
      nodeConn.ws.send(JSON.stringify({
        type: 'remote.command.result',
        commandId: msg.commandId,
        action: msg.action,
        outcome: 'accepted',
        result: msg.action === 'leaseAcquire' ? { leaseId: (msg as { leaseId?: string }).leaseId } : {},
      }));
    });
    sockets.push(nodeConn.ws);

    const created = relay.createInvitation({
      nodeId: node.nodeId,
      subject: { kind: 'task', nodeId: node.nodeId, taskId: 'task-a' },
      grants: ['view'],
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
    sendTerminalBytes(nodeConn.ws, node.nodeId, 1, 'MOBILE_RESUME_READY');

    await expect(page.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Request terminal viewing' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Notify me when approved' })).toHaveCount(0);
    await expect(page.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await expect(page.locator('#terminal')).not.toContainText('MOBILE_RESUME_READY');
    expect(relay.invitations()[0]?.grantRequests ?? []).toHaveLength(0);

    await page.reload();
    await expect(page.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Request terminal viewing' })).toHaveCount(1);
    await expect(page.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await expect(page.locator('#terminal')).not.toContainText('MOBILE_RESUME_READY');

    const restartedPage = await page.context().newPage();
    await restartedPage.setViewportSize({ width: 390, height: 520 });
    await restartedPage.goto(`${relay.url()}/relay/join`);
    await expect(restartedPage.getByLabel('Shared task projection')).toBeVisible({ timeout: 10_000 });
    await expect(restartedPage.getByRole('button', { name: 'Request terminal viewing' })).toHaveCount(1);
    await expect(restartedPage.locator('#terminal-banner')).toContainText(
      'Terminal viewing requires owner approval.',
      { timeout: 10_000 },
    );
    await expect(restartedPage.locator('#terminal')).not.toContainText('MOBILE_RESUME_READY');
    const noOverlap = await restartedPage.evaluate(() => {
      const terminal = document.getElementById('terminal-shell')!.getBoundingClientRect();
      const composer = document.getElementById('terminal-composer')!.getBoundingClientRect();
      return terminal.bottom <= composer.top || composer.bottom <= terminal.top;
    });
    expect(noOverlap).toBe(true);
    await restartedPage.close();
  });
});
