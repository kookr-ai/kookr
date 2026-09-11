import { TerminalHostAdmission } from './terminal-host-admission.js';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { LocalDtachBackend } from '../adapters/local-dtach-backend.js';
import { SessionGoneError, WriteTimeoutError } from '../adapters/terminal-backend.js';
import { TERMINAL_V2_PROTOCOL } from '../shared/terminal-protocol.js';
import { SessionBridge } from './session-bridge.js';
import { TerminalInputCoordinator } from './terminal-input-coordinator.js';
import { TerminalReconstructionWorker } from './terminal-reconstruction-worker.js';
import { setAbsoluteTuiReconstructionExecutor } from './absolute-position-tui-screen.js';
import { TerminalHostChannel } from './terminal-host-channel.js';
import { getTerminalOutputBytes } from './terminal-output-queue.js';
import { TerminalInputRttMetrics } from './terminal-input-rtt-metrics.js';
import { isTerminalHostRequest, terminalHostPayloadSize, TerminalHostUnavailableError,
  type TerminalHostChildMessage, type TerminalHostParentMessage, type TerminalHostRequest,
  type TerminalHostResponse, type TerminalHostUpgrade } from './terminal-host-contract.js';

// This process has no listener. Main authenticates and passes paused sockets;
// from that point xterm bytes and input never traverse the supervisor loop.
let generation = '';
let backend: LocalDtachBackend | undefined;
let input: TerminalInputCoordinator | undefined;
let stopping = false;
const admission = new TerminalHostAdmission();
let inputVersion = 0;
let lastRequestId = 0;
const inputSessions = new Set<string>();
const inputRtt = new TerminalInputRttMetrics();
const reconstruction = new TerminalReconstructionWorker();
setAbsoluteTuiReconstructionExecutor(reconstruction);
const channel = new TerminalHostChannel((value, _handle, done) => {
  if (!process.send || !process.connected) { done(new Error('Parent disconnected')); return; }
  process.send(value as TerminalHostChildMessage, done);
});
function send(value: TerminalHostChildMessage, bulk = false): boolean {
  return channel.send(value, { bulk });
}
const wss = new WebSocketServer({ noServer: true, maxPayload: 8_000_000, perMessageDeflate: false,
  handleProtocols: (protocols) => protocols.has(TERMINAL_V2_PROTOCOL) ? TERMINAL_V2_PROTOCOL : false });
interface Connection { ws: WebSocket; bridge: SessionBridge; role: 'owner' | 'viewer';
  expiry: number | null; lease: number; alive: boolean; lastPing: number }
const connections = new Map<string, Connection>();
const liveNotices = new Set<string>();
const streams = new Map<string, { unsubscribe(): void; position: number; acked: number }>();
let streamBytes = 0;

function activity(sessionId: string, kind: Extract<TerminalHostChildMessage, { kind: 'activity' }>['activity']) {
  if (kind === 'live') { liveNotices.add(sessionId); return; }
  if (!send({ kind: 'activity', generation, sessionId, activity: kind })) void stop();
}
function removeStream(id: string) {
  const stream = streams.get(id);
  if (!stream) return;
  stream.unsubscribe(); streams.delete(id);
  streamBytes -= stream.position - stream.acked;
}
function gap(id: string) {
  removeStream(id);
  if (!send({ kind: 'stream-gap', generation, id })) void stop();
}

function closeConnection(id: string): boolean {
  const connection = connections.get(id);
  if (!connection) return true;
  connection.bridge.dispose();
  connection.ws.terminate(); // destroys TCP synchronously; not a queued close frame
  connections.delete(id);
  return true;
}

function upgrade(packet: TerminalHostUpgrade, socket: Socket) {
  const now = Date.now();
  if (!backend || !input || stopping || connections.size >= 256 || connections.has(packet.id)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(packet.sessionId)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(packet.id)
    || !(packet.head instanceof Uint8Array) || packet.head.length > 64 * 1024
    || terminalHostPayloadSize(packet.headers) > 32 * 1024
    || (packet.role !== 'owner' && packet.role !== 'viewer')
    || (packet.role === 'viewer' && (typeof packet.grantId !== 'string'
      || !Number.isFinite(packet.leaseUntilMs) || packet.leaseUntilMs <= now || packet.leaseUntilMs > now + 10_100
      || (packet.grantExpiresAtMs !== null && (!Number.isFinite(packet.grantExpiresAtMs)
        || packet.grantExpiresAtMs <= now || packet.leaseUntilMs > packet.grantExpiresAtMs))))) {
    socket.destroy(); send({ kind: 'connection-closed', generation, id: packet.id }); return;
  }
  // A rejected handshake closes the raw socket without invoking the upgrade
  // callback. Release the parent's reservation for both failed and accepted
  // upgrades, once actual transport closure confirms ownership has ended.
  socket.once('close', () => {
    if (!send({ kind: 'connection-closed', generation, id: packet.id })) void stop();
  });
  socket.on('error', () => {});
  const request = new IncomingMessage(socket);
  request.method = packet.method; request.url = packet.url; request.headers = packet.headers;
  try {
    wss.handleUpgrade(request, socket, Buffer.from(packet.head), (ws) => {
      ws.on('error', () => {});
      if (packet.role === 'owner') { input!.registerSession(packet.sessionId); inputSessions.add(packet.sessionId); }
      const bridge = new SessionBridge(packet.sessionId, ws, backend!, input!,
        (id) => activity(id, 'input'), (id) => activity(id, 'keystroke'), {
          readOnly: packet.role === 'viewer',
          onBridgeOpened: (id) => activity(id, 'opened'), onBridgeReplay: (id) => activity(id, 'replay'),
          onBridgeLiveBytes: (id) => activity(id, 'live'), onBridgeClosed: (id) => activity(id, 'closed'),
        });
      const connection: Connection = { ws, bridge, role: packet.role, expiry: packet.grantExpiresAtMs,
        lease: packet.leaseUntilMs, alive: true, lastPing: Date.now() };
      connections.set(packet.id, connection);
      ws.on('pong', () => { connection.alive = true; });
      ws.on('close', () => {
        bridge.dispose(); connections.delete(packet.id);
      });
      void bridge.start().catch(() => closeConnection(packet.id));
    });
    socket.resume();
  } catch { socket.destroy(); }
}

async function execute(request: TerminalHostRequest): Promise<unknown> {
  const b = backend!; const i = input!;
  // A closed switch is intentional: the private IPC cannot invoke arbitrary
  // object properties, and tuple types stay paired with their operations.
  switch (request.method) {
    case 'createSession': await b.createSession(...request.args); i.registerSession(request.args[0].id); inputSessions.add(request.args[0].id); return;
    case 'killSession': i.cleanupSession(request.args[0]); inputSessions.delete(request.args[0]); await b.killSession(...request.args); return;
    case 'listSessions': return b.listSessions(...request.args);
    case 'isAlive': return b.isAlive(...request.args);
    case 'write': await i.writeInput(...request.args); return;
    case 'writeSequence': await i.writeInputSequence(...request.args); return;
    case 'captureBytes': return b.captureBytes(...request.args);
    case 'captureStreamSnapshot': return b.captureStreamSnapshot(...request.args);
    case 'captureCurrentFrame': return b.captureCurrentFrame(...request.args);
    case 'resize': return b.resize(...request.args);
    case 'getStats': return b.getStats(...request.args);
    case 'getSessionStartedAt': return b.getSessionStartedAt(...request.args);
    case 'getSessionDiagnostics': return b.getSessionDiagnostics(...request.args);
    case 'getPersistenceStats': return b.getPersistenceStats(...request.args);
    case 'reconnectTransport': return b.reconnectTransport(...request.args);
    case 'verifyRecoveredSession': return b.verifyRecoveredSession(...request.args);
    case 'recoverLaunchAbandonedSessions': return b.recoverLaunchAbandonedSessions(...request.args);
    case 'input.registerSession': i.registerSession(...request.args); inputSessions.add(request.args[0]); return;
    case 'input.cleanupSession': i.cleanupSession(...request.args); inputSessions.delete(request.args[0]); return;
    case 'input.dispose': i.dispose(); inputSessions.clear(); return;
    case 'input.getSnapshot': return i.getSnapshot(...request.args);
    case 'input.getWriteMetrics': return i.getWriteMetrics(...request.args);
    case 'input.writeInput': return i.writeInput(...request.args);
    case 'input.writeInputSequence': return i.writeInputSequence(...request.args);
    case 'input.markUserPromptSubmitted': return i.markUserPromptSubmitted(...request.args);
    case 'input.markToolStarted': return i.markToolStarted(...request.args);
    case 'input.markPermissionBlocked': return i.markPermissionBlocked(...request.args);
    case 'input.markStopFailure': return i.markStopFailure(...request.args);
    case 'input.markTurnStopped': return i.markTurnStopped(...request.args);
    case 'input.markSessionEnded': return i.markSessionEnded(...request.args);
    case 'input.markPromptReady': return i.markPromptReady(...request.args);
    case 'input.handleEmptyEnterIntent': return i.handleEmptyEnterIntent(...request.args);
    case 'connection.close': return closeConnection(request.args[0]);
    case 'connection.renew': {
      const connection = connections.get(request.args[0]); const lease = request.args[1]; const now = Date.now();
      if (!connection || connection.role !== 'viewer') return false;
      if (!Number.isFinite(lease) || lease <= now || lease > now + 10_100
        || now >= connection.lease || (connection.expiry !== null && lease > connection.expiry)) {
        closeConnection(request.args[0]); return false;
      }
      connection.lease = lease; return true;
    }
    case 'stream.unsubscribe': removeStream(request.args[0]); return;
    case 'stream.ack': {
      const stream = streams.get(request.args[0]); const position = request.args[1];
      if (!stream) return;
      if (!Number.isSafeInteger(position) || position < stream.acked || position > stream.position) { gap(request.args[0]); return; }
      streamBytes -= position - stream.acked; stream.acked = position; return;
    }
    case 'stream.subscribe': {
      const [id, sessionId] = request.args;
      if (streams.size >= 256 || streams.has(id)) throw new TerminalHostUnavailableError('Stream subscription capacity');
      const stream = { unsubscribe: () => {}, position: 0, acked: 0 };
      streams.set(id, stream);
      stream.unsubscribe = b.onData(sessionId, (data, source, range) => {
        if (!streams.has(id)) return;
        if (stream.position - stream.acked + data.length > 128 * 1024 || streamBytes + data.length > 4 * 1024 * 1024) { gap(id); return; }
        stream.position += data.length; streamBytes += data.length;
        if (!send({ kind: 'stream-data', generation, id, position: stream.position,
          bytes: Uint8Array.from(data), source, range }, true)) gap(id);
      });
      return;
    }
  }
}

async function handleRequest(request: TerminalHostRequest) {
  // Request IDs may arrive out of order because unsent capture work yields to
  // input. A bounded active set, not a high-water ID check, detects duplicates.
  const size = terminalHostPayloadSize(request);
  const response: TerminalHostResponse = { kind: 'response', generation, id: request.id };
  const releaseAdmission = seenRequests.has(request.id) || request.id < lastRequestId - 1024
    ? null : admission.acquire(request.method, size + 256);
  if (!releaseAdmission) {
    response.error = { name: 'TerminalHostUnavailableError', message: 'Terminal host execution capacity unavailable' };
    send(response); return;
  }
  seenRequests.add(request.id);
  lastRequestId = Math.max(lastRequestId, request.id);
  // Keep a small replay fence after completion, without unbounded lifetime IDs.
  for (const id of seenRequests) if (id < lastRequestId - 1024) seenRequests.delete(id);
  try { response.result = await execute(request); }
  catch (error) {
    response.error = { name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof SessionGoneError ? { sessionId: error.id } : {}),
      ...(error instanceof WriteTimeoutError ? { sessionId: error.id, durationMs: error.durationMs } : {}) };
  } finally { releaseAdmission(); }
  const sessionId = request.method === 'input.handleEmptyEnterIntent' ? request.args[0].sessionId
    : typeof request.args[0] === 'string' ? request.args[0] : null;
  if (sessionId && !request.method.startsWith('stream.') && !request.method.startsWith('connection.')) {
    response.inputSessionId = sessionId;
    response.inputSnapshot = input!.getSnapshot(sessionId); response.inputSnapshotVersion = ++inputVersion;
    if (response.inputSnapshot) inputSessions.add(sessionId);
  }
  if (!send(response, request.method.startsWith('capture') || request.method === 'getSessionDiagnostics')) void stop();
}
const seenRequests = new Set<number>();
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, connection] of connections) {
    if (connection.role === 'viewer' && (now >= connection.lease || (connection.expiry !== null && now >= connection.expiry))) {
      closeConnection(id); continue;
    }
    if (now - connection.lastPing >= 10_000) {
      if (!connection.alive || connection.ws.readyState !== WebSocket.OPEN) { closeConnection(id); continue; }
      // Do not queue ping behind a backlogged output frame. Viewer leases still
      // expire independently; the stream's byte/ACK limits bound owner output.
      if (connection.ws.bufferedAmount === 0) { connection.alive = false; connection.lastPing = now; connection.ws.ping(); }
    }
  }
}, 100);
const statsTimer = setInterval(() => {
  if (!backend || !input || stopping) return;
  const snapshots = [...inputSessions].slice(0, 512).flatMap((id) => {
    const snapshot = input!.getSnapshot(id); return snapshot ? [snapshot] : [];
  });
  send({ kind: 'stats', generation, at: Date.now(), stats: backend.getStats(),
    persistence: backend.getPersistenceStats(), inputMetrics: input.getWriteMetrics(),
    inputRtt: inputRtt.snapshot(),
    inputSnapshots: snapshots, inputSnapshotVersion: ++inputVersion, connections: connections.size,
    legacyConnections: [...connections.values()].filter((c) => c.ws.protocol !== TERMINAL_V2_PROTOCOL).length,
    channelBytes: channel.pendingBytes, streamBytes, reconstructionBytes: reconstruction.pendingBytes,
    outputBytes: getTerminalOutputBytes(), rssBytes: process.memoryUsage().rss }, true);
  for (const sessionId of liveNotices) send({ kind: 'activity', generation, sessionId, activity: 'live' });
  liveNotices.clear();
}, 500);

async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(sweep); clearInterval(statsTimer);
  for (const id of connections.keys()) closeConnection(id);
  for (const id of streams.keys()) removeStream(id);
  // Retire readiness and queued/paced input before closing the backend. An
  // already-issued syscall remains uncertain; later payloads cannot run.
  input?.dispose(); inputSessions.clear();
  // A hard deadline lets main confirm exit before replacing this owner. The
  // dtach masters are detached and deliberately survive either shutdown path.
  const deadline = setTimeout(() => process.exit(1), 3000);
  await Promise.all([backend?.closeAndDrain(), reconstruction.close()]);
  clearTimeout(deadline); channel.close(); process.exit(0);
}
process.on('disconnect', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.on('message', (message: TerminalHostParentMessage, handle) => {
  if (!message || typeof message !== 'object') return;
  if (message.kind === 'init' && !generation && typeof message.generation === 'string') {
    generation = message.generation;
    try {
      backend = new LocalDtachBackend({ ...message.options, asyncRingPersistence: true });
      input = new TerminalInputCoordinator(backend, undefined, inputRtt);
      backend.onBackendError((error) => send({ kind: 'backend-error', generation, error }));
      send({ kind: 'ready', generation, instanceDir: backend.getInstanceDir(), stats: backend.getStats() });
    } catch { void stop(); }
    return;
  }
  if (message.generation !== generation || !backend || stopping) { if (handle instanceof Socket) handle.destroy(); return; }
  if (message.kind === 'shutdown') { void stop(); return; }
  if (message.kind === 'upgrade') { if (handle instanceof Socket) upgrade(message, handle); return; }
  if (isTerminalHostRequest(message, generation)) void handleRequest(message);
});
