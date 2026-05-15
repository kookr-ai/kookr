import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { WebSocket, WebSocketServer } from 'ws';

import { isNodeHello, makeRelayHello, REMOTE_PROTOCOL_VERSION, type NodeHello } from '../src/remote/handshake.js';
import { isRemoteControlEvent, type RemoteControlEvent } from '../src/remote/control-events.js';
import { asNodeId, type NodeId } from '../src/remote/ids.js';
import { isPushAlertDeltaPayload, makeRedactedPushPayload } from '../src/remote/push.js';
import { createPushFanout, type PushDeliveryOutcome, type PushFanout, type PushSender } from './src/push/fanout.js';
import { createPushSubscriptionStore, isPushSubscription, type PushSubscriptionStore, type StoredPushSubscription } from './src/push/subscriptions.js';
import { createVapidKeyStore, type VapidKeyStore } from './src/push/vapid.js';

interface NodeRegistration {
  nodeId: NodeId;
  ownerId: string;
  displayName: string;
  tokenHash: string;
  createdAt: string;
  lastSeen?: string;
}

export interface RelayNodeStatus {
  nodeId: NodeId;
  ownerId: string;
  displayName: string;
  connected: boolean;
  lastSeen?: string;
  protocolVersion?: number;
  policySyncVersion: number;
  policySyncStatus: 'synced' | 'syncing' | 'lagging';
  activeLeases: number;
  pendingPermissions: number;
}

export interface RelayServerOptions {
  adminToken?: string;
  clientToken?: string;
  ownerId?: string;
  allowInsecureAdmin?: boolean;
  allowInsecureClients?: boolean;
  pushDisabled?: boolean;
  pushSender?: PushSender;
  pushSubject?: string;
}

export interface RelayServerHandle {
  httpServer: Server;
  url(): string;
  registerNode(opts?: { displayName?: string; ownerId?: string }): { nodeId: NodeId; nodeToken: string };
  nodeStatuses(): RelayNodeStatus[];
  pushSubscriptions(): StoredPushSubscription[];
  rotateVapidKeys(): { publicKey: string; version: number; invalidated: number };
  sendTestPush(deviceId: string): Promise<PushDeliveryOutcome>;
  close(): Promise<void>;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function issueNodeToken(): string {
  return `kookr_tok_v1_${randomBytes(24).toString('base64url')}`;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

function isAuthorizedAdmin(req: IncomingMessage, adminToken: string | undefined): boolean {
  if (!adminToken) return false;
  return bearer(req) === adminToken;
}

function isAuthorizedClient(req: IncomingMessage, opts: RelayServerOptions, url?: URL): boolean {
  if (opts.allowInsecureClients) return true;
  if (opts.clientToken && url?.searchParams.get('clientToken') === opts.clientToken) return true;
  return isAuthorizedAdmin(req, opts.adminToken);
}

export function createRelayServer(opts: RelayServerOptions = {}): RelayServerHandle {
  const registrations = new Map<NodeId, NodeRegistration>();
  const tokenIndex = new Map<string, NodeRegistration>();
  const nodeSockets = new Map<NodeId, WebSocket>();
  const nodeHello = new Map<NodeId, NodeHello>();
  const subscribers = new Map<NodeId, Set<WebSocket>>();
  const replay = new Map<NodeId, RemoteControlEvent[]>();
  const vapidKeys: VapidKeyStore = createVapidKeyStore();
  const pushSubscriptions: PushSubscriptionStore = createPushSubscriptionStore();
  const pushFanout: PushFanout = createPushFanout({
    subscriptions: pushSubscriptions,
    vapidKeys,
    disabled: opts.pushDisabled ?? process.env.KOOKR_PUSH_DISABLED === 'true',
    sender: opts.pushSender,
    subject: opts.pushSubject,
  });
  const ownerId = opts.ownerId ?? 'local-owner';

  const registerNode = (regOpts: { displayName?: string; ownerId?: string } = {}) => {
    const nodeId = asNodeId(`kookr-node-${randomUUID()}`);
    const nodeToken = issueNodeToken();
    const registration: NodeRegistration = {
      nodeId,
      ownerId: regOpts.ownerId ?? ownerId,
      displayName: regOpts.displayName ?? nodeId,
      tokenHash: tokenHash(nodeToken),
      createdAt: new Date().toISOString(),
    };
    registrations.set(nodeId, registration);
    tokenIndex.set(registration.tokenHash, registration);
    return { nodeId, nodeToken };
  };

  const nodeStatuses = (): RelayNodeStatus[] => [...registrations.values()].map((registration) => {
    const hello = nodeHello.get(registration.nodeId);
    return {
      nodeId: registration.nodeId,
      ownerId: registration.ownerId,
      displayName: registration.displayName,
      connected: nodeSockets.has(registration.nodeId),
      ...(registration.lastSeen ? { lastSeen: registration.lastSeen } : {}),
      ...(hello ? { protocolVersion: hello.protocolVersion } : {}),
      policySyncVersion: 0,
      policySyncStatus: 'synced',
      activeLeases: 0,
      pendingPermissions: 0,
    };
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { status: 'ok', dbReachable: true, tlsExpiresAt: null, version: 'dev' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/dashboard') {
        sendHtml(res, 200, relayDashboardHtml());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/dashboard/state') {
        if (!isAuthorizedClient(req, opts, url)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const nodeId = url.searchParams.get('nodeId');
        if (!nodeId || !registrations.has(asNodeId(nodeId))) {
          sendJson(res, 404, { error: 'node not found' });
          return;
        }
        sendJson(res, 200, { nodeId, events: replay.get(asNodeId(nodeId)) ?? [] });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/push/vapid-public-key') {
        const current = vapidKeys.current();
        sendJson(res, 200, { publicKey: current.publicKey, version: current.version, rotatedAt: current.rotatedAt });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/push/subscriptions') {
        if (!isAuthorizedClient(req, opts, url)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readJson(req) as { deviceId?: unknown; nodeId?: unknown; subscription?: unknown; vapidKeyVersion?: unknown };
        if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
          sendJson(res, 400, { error: 'deviceId is required' });
          return;
        }
        if (typeof body.nodeId !== 'string' || !registrations.has(asNodeId(body.nodeId))) {
          sendJson(res, 400, { error: 'known nodeId is required' });
          return;
        }
        if (!isPushSubscription(body.subscription)) {
          sendJson(res, 400, { error: 'valid push subscription is required' });
          return;
        }
        const current = vapidKeys.current();
        if (body.vapidKeyVersion !== undefined && body.vapidKeyVersion !== current.version) {
          sendJson(res, 409, { error: 'vapid key version mismatch', currentVersion: current.version });
          return;
        }
        const stored = pushSubscriptions.upsert({
          deviceId: body.deviceId,
          nodeId: asNodeId(body.nodeId),
          subscription: body.subscription,
          vapidKeyVersion: current.version,
        });
        sendJson(res, 201, {
          deviceId: stored.deviceId,
          nodeId: stored.nodeId,
          vapidKeyVersion: stored.vapidKeyVersion,
        });
        return;
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/relay/push/subscriptions/')) {
        if (!isAuthorizedClient(req, opts, url)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const deviceId = decodeURIComponent(url.pathname.slice('/relay/push/subscriptions/'.length));
        sendJson(res, 200, { removed: pushSubscriptions.remove(deviceId) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/admin/push/vapid/rotate') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const rotated = vapidKeys.rotate();
        const invalidated = pushSubscriptions.invalidateVersion(rotated.version);
        sendJson(res, 200, { publicKey: rotated.publicKey, version: rotated.version, rotatedAt: rotated.rotatedAt, invalidated });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/admin/push/test') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readJson(req) as { deviceId?: unknown };
        if (typeof body.deviceId !== 'string' || body.deviceId.length === 0) {
          sendJson(res, 400, { error: 'deviceId is required' });
          return;
        }
        sendJson(res, 200, await sendTestPush(body.deviceId));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/relay/admin/nodes') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        sendJson(res, 200, { nodes: nodeStatuses() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/relay/admin/nodes') {
        if (!opts.allowInsecureAdmin && !isAuthorizedAdmin(req, opts.adminToken)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readJson(req) as { displayName?: unknown; ownerId?: unknown };
        const issued = registerNode({
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          ownerId: typeof body.ownerId === 'string' ? body.ownerId : undefined,
        });
        sendJson(res, 201, issued);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const nodeWss = new WebSocketServer({ noServer: true });
  const clientWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/relay/node') {
      const token = bearer(req);
      const registration = token ? tokenIndex.get(tokenHash(token)) : undefined;
      if (!registration) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      nodeWss.handleUpgrade(req, socket, head, (ws) => {
        nodeWss.emit('connection', ws, req, registration);
      });
      return;
    }
    if (url.pathname === '/relay/client') {
      if (!isAuthorizedClient(req, opts, url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const nodeId = url.searchParams.get('nodeId');
      if (!nodeId || !registrations.has(asNodeId(nodeId))) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      clientWss.handleUpgrade(req, socket, head, (ws) => {
        clientWss.emit('connection', ws, req, asNodeId(nodeId));
      });
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  nodeWss.on('connection', (ws: WebSocket, _req: IncomingMessage, registration: NodeRegistration) => {
    let accepted = false;
    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.close(1002, 'invalid json');
        return;
      }

      if (!accepted) {
        if (!isNodeHello(parsed) || parsed.nodeId !== registration.nodeId) {
          ws.send(JSON.stringify(makeRelayHello({
            outcome: 'refused',
            acceptedVersion: REMOTE_PROTOCOL_VERSION,
            refusalReason: 'credential-revoked',
          })));
          ws.close(1008, 'invalid node hello');
          return;
        }
        if (parsed.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
          ws.send(JSON.stringify(makeRelayHello({
            outcome: 'refused',
            acceptedVersion: REMOTE_PROTOCOL_VERSION,
            refusalReason: 'unsupported-version',
          })));
          ws.close(1008, 'unsupported protocol');
          return;
        }
        accepted = true;
        const existing = nodeSockets.get(registration.nodeId);
        if (existing && existing !== ws) {
          existing.close(4000, 'superseded node connection');
        }
        nodeSockets.set(registration.nodeId, ws);
        nodeHello.set(registration.nodeId, parsed);
        registration.lastSeen = new Date().toISOString();
        ws.send(JSON.stringify(makeRelayHello({
          outcome: 'accepted',
          acceptedVersion: REMOTE_PROTOCOL_VERSION,
          enabledFeatures: parsed.supportedFeatures,
        })));
        return;
      }

      if (
        isRemoteControlEvent(parsed)
        && parsed.nodeId === registration.nodeId
        && parsed.nodeEpoch === nodeHello.get(registration.nodeId)?.nodeEpoch
        && nodeSockets.get(registration.nodeId) === ws
      ) {
        registration.lastSeen = new Date().toISOString();
        routeControlEvent(parsed);
      }
    });
    ws.on('close', () => {
      if (nodeSockets.get(registration.nodeId) === ws) {
        nodeSockets.delete(registration.nodeId);
        registration.lastSeen = new Date().toISOString();
      }
    });
  });

  function routeControlEvent(event: RemoteControlEvent): void {
    const events = replay.get(event.nodeId) ?? [];
    events.push(event);
    replay.set(event.nodeId, events.slice(-100));

    if (isPushAlertDeltaPayload(event.payload)) {
      void pushFanout.sendToNode(event.nodeId, event.payload.payload);
    }

    const subscribed = subscribers.get(event.nodeId);
    if (!subscribed) return;
    const encoded = JSON.stringify(event);
    for (const ws of subscribed) {
      if (ws.readyState === ws.OPEN) ws.send(encoded);
    }
  }

  clientWss.on('connection', (ws: WebSocket, _req: IncomingMessage, subscribedNodeId: NodeId) => {
    let set = subscribers.get(subscribedNodeId);
    if (!set) {
      set = new Set();
      subscribers.set(subscribedNodeId, set);
    }
    set.add(ws);
    for (const event of replay.get(subscribedNodeId) ?? []) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    }
    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        ws.close(1002, 'invalid json');
        return;
      }
      const command = parsed as { type?: unknown; nodeId?: unknown; payload?: unknown };
      if (command.type !== 'remote.command') return;
      if (typeof command.nodeId === 'string' && command.nodeId !== subscribedNodeId) {
        ws.close(1008, 'command node mismatch');
        return;
      }
      const target = nodeSockets.get(subscribedNodeId);
      if (target?.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ ...command, nodeId: subscribedNodeId }));
      }
    });
    ws.on('close', () => {
      set.delete(ws);
      if (set.size === 0) subscribers.delete(subscribedNodeId);
    });
  });

  return {
    httpServer: server,
    url(): string {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('relay server is not listening');
      }
      return `http://127.0.0.1:${address.port}`;
    },
    registerNode,
    nodeStatuses,
    pushSubscriptions: () => pushSubscriptions.list(),
    rotateVapidKeys(): { publicKey: string; version: number; invalidated: number } {
      const rotated = vapidKeys.rotate();
      return {
        publicKey: rotated.publicKey,
        version: rotated.version,
        invalidated: pushSubscriptions.invalidateVersion(rotated.version),
      };
    },
    sendTestPush,
    async close(): Promise<void> {
      for (const ws of [...nodeSockets.values()]) ws.close(1001, 'relay closing');
      for (const set of subscribers.values()) {
        for (const ws of set) ws.close(1001, 'relay closing');
      }
      nodeWss.close();
      clientWss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  async function sendTestPush(deviceId: string): Promise<PushDeliveryOutcome> {
    return await pushFanout.sendToDevice(deviceId, makeRedactedPushPayload({
      nodeDisplayName: 'Kookr',
      taskId: 'test-alert',
      taskLabel: 'Test push',
      alertKind: 'blocked',
      alertId: `test-${Date.now()}`,
    }));
  }
}

function relayDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Kookr Relay</title>
  <style>
    body { margin: 0; font: 14px system-ui, sans-serif; background: #101416; color: #e7ecef; }
    main { max-width: 840px; margin: 0 auto; padding: 16px; }
    h1 { font-size: 20px; margin: 0 0 12px; }
    .task { border: 1px solid #2b373d; border-radius: 6px; padding: 12px; margin: 10px 0; background: #151c20; }
    .muted { color: #aeb9bf; }
    .alert { color: #ffd166; }
  </style>
</head>
<body>
<main>
  <h1>Kookr Relay</h1>
  <div id="status" class="muted">Connecting...</div>
  <section id="tasks"></section>
</main>
<script>
const params = new URLSearchParams(location.search);
const nodeId = params.get('nodeId') || '';
const clientToken = params.get('clientToken') || '';
const statusEl = document.getElementById('status');
const tasksEl = document.getElementById('tasks');
const tasks = new Map();
const alerts = new Map();
function render() {
  tasksEl.textContent = '';
  for (const task of tasks.values()) {
    const el = document.createElement('article');
    el.className = 'task';
    const title = task.taskShortLabel || task.taskId || 'Task';
    el.innerHTML = '<strong></strong><div class="muted"></div>';
    el.querySelector('strong').textContent = title;
    el.querySelector('.muted').textContent = [task.status || 'unknown', task.updatedAt || ''].filter(Boolean).join(' · ');
    tasksEl.appendChild(el);
  }
  for (const alert of alerts.values()) {
    const el = document.createElement('article');
    el.className = 'task alert';
    el.textContent = (alert.alertKind || 'alert') + ' · ' + (alert.taskShortLabel || alert.agentId || alert.alertId || 'Task');
    tasksEl.appendChild(el);
  }
}
function ingest(event) {
  const payload = event && event.payload;
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'push.alert' && payload.payload) {
    alerts.set(payload.payload.alertId || String(alerts.size), payload.payload);
  }
  const items = Array.isArray(payload.tasks) ? payload.tasks : Array.isArray(payload.taskProjections) ? payload.taskProjections : [];
  for (const task of items) {
    if (task && typeof task.taskId === 'string') tasks.set(task.taskId, task);
  }
  render();
}
async function boot() {
  if (!nodeId) {
    statusEl.textContent = 'Missing nodeId';
    return;
  }
  try {
    const stateUrl = new URL('/relay/dashboard/state', location.href);
    stateUrl.searchParams.set('nodeId', nodeId);
    if (clientToken) stateUrl.searchParams.set('clientToken', clientToken);
    const state = await fetch(stateUrl, { credentials: 'include' });
    if (state.ok) {
      const body = await state.json();
      for (const event of body.events || []) ingest(event);
    }
  } catch {}
  const wsUrl = new URL('/relay/client', location.href);
  wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('nodeId', nodeId);
  if (clientToken) wsUrl.searchParams.set('clientToken', clientToken);
  const ws = new WebSocket(wsUrl);
  ws.onopen = () => { statusEl.textContent = 'Live'; };
  ws.onclose = () => { statusEl.textContent = 'Disconnected'; };
  ws.onmessage = (msg) => { try { ingest(JSON.parse(msg.data)); } catch {} };
}
boot();
</script>
</body>
</html>`;
}

if (process.argv[1]?.endsWith('/relay/server.ts') || process.argv[1]?.endsWith('/relay/server.js')) {
  const port = Number.parseInt(process.env.PORT ?? '8080', 10);
  const adminToken = process.env.KOOKR_RELAY_ADMIN_TOKEN;
  const clientToken = process.env.KOOKR_RELAY_CLIENT_TOKEN;
  const allowInsecureAdmin = process.env.KOOKR_RELAY_INSECURE_DEV === '1';
  if (!adminToken && !allowInsecureAdmin) {
    console.error('[relay] KOOKR_RELAY_ADMIN_TOKEN is required. Set KOOKR_RELAY_INSECURE_DEV=1 only for local development.');
    process.exit(1);
  }
  const relay = createRelayServer({
    adminToken,
    clientToken,
    allowInsecureAdmin,
    allowInsecureClients: allowInsecureAdmin,
  });
  relay.httpServer.listen(port, '0.0.0.0', () => {
    console.log(`[relay] listening on http://0.0.0.0:${port}`);
  });
}
