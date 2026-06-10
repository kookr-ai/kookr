---
name: websocket-dashboard
description: WebSocket patterns for Node `ws` dashboard connections - upgrade dispatch, connection registry, per-client state, browser lifecycle, back-pressure, rate limiting, message versioning
keywords: WebSocket, ws library, WebSocketServer, noServer, handleUpgrade, connection registry, per-client state, reconnection, BroadcastChannel, Page Visibility, leader election, ping pong, subscription filtering, back-pressure, bufferedAmount, rate limiting, slow consumer, message envelope, versioning, error budget
related: realtime-state-sync, error-handling-patterns
---

# WebSocket Dashboard Patterns

WebSocket patterns for the canonical real-time command center transport, using the Node `ws` library (how Kookr actually serves `/ws`: Hono handles HTTP via `@hono/node-server`, and WebSocket upgrades are dispatched manually on the Node HTTP server).

**Research:** `docs/deepresearch/reports/WebSocket Production Patterns Bun Redis.md`

## Non-Negotiable Rules

| # | Rule | Violation | Correct |
|---|------|-----------|---------|
| 1 | **Server-side ping <=30s** | No heartbeats, zombie connections pile up | `setInterval(() => ws.ping(), 30000)`, close after 2 missed pongs |
| 2 | **Client reconnects with backoff+jitter** | `ws.onclose = () => connect()` (immediate) | Exponential backoff, random jitter, 30s cap |
| 3 | **Versioned message envelope** | `{ type: "chat", text: "hi" }` (no version) | `{ version: 1, action: "chat.send", requestId, payload, timestamp }` |
| 4 | **Client sends lastSeq on reconnect** | Reconnect loses all state | `{ action: "sync", lastEventId }` -> server replays missed events |
| 5 | **Never send when bufferedAmount > 1MB** | Unbounded send queue, OOM | Check `ws.bufferedAmount`, switch slow clients to snapshot mode |
| 6 | **Per-connection rate limit** | One misbehaving client DoS-es server | Enforce max msg/s (e.g., 50); close on sustained violation |
| 7 | **Validate all inbound messages** | Bad JSON crashes connection | Parse + Zod validate, send typed error envelope, close after N errors |
| 8 | **Multi-instance: publish to a shared bus, not local-only** | Messages reach only one instance's users | `redis.publish(channel, msg)`, fan out to local clients per instance. *Single-instance deployments (Kookr today) fan out locally via the registry — no bus needed* |
| 9 | **Sequence numbers for ordered streams** | Assume TCP = FIFO across reconnects | Per-resource seq numbers; client requests replay on gap |
| 10 | **Test reconnection, back-pressure, malformed messages** | Only manual browser testing | Unit + integration tests for every handler, mock Redis |

## Quick Reference

| Issue | Cause | Fix |
|-------|-------|-----|
| WS connects then drops | Missing ping/pong | Application-level ping or `ws` protocol-level `ws.ping()` |
| Client state drift | No snapshot on connect | Full snapshot as first message after `init` |
| Memory leak | Clients not cleaned up | Track in Map, remove in `onClose` |
| Browser tab frozen | Background throttling | Page Visibility API to pause rendering |
| Multiple tabs = N connections | Each tab opens WS | BroadcastChannel + leader election |
| Server OOM from slow client | Unbounded ws.send() queue | Monitor `bufferedAmount`, snapshot slow consumers |
| Malformed message crash | No try/catch on parse | Validate, error envelope, close after N errors |

## Server: `ws` Upgrade Dispatch (the pattern Kookr runs)

Hono serves HTTP through `@hono/node-server`'s `getRequestListener`; WebSocket
upgrades never touch Hono. They are dispatched by pathname on the raw Node HTTP
server into per-pool `WebSocketServer({ noServer: true })` instances. Auth and
scope checks run **before** the handshake, so a rejected client never gets a
socket. Real source: `src/server/bootstrap/start-http-and-websockets.ts`.

```typescript
import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer } from 'ws';

const httpServer = createServer(getRequestListener(app.fetch));
const wss = new WebSocketServer({ noServer: true });          // dashboard pool
const terminalWss = new WebSocketServer({ noServer: true });  // terminal pool

httpServer.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?', 1)[0]; // strip query before routing

  // Reject unauthenticated upgrades BEFORE any handshake.
  if (authRequired && !resolveUpgradeIdentity(apiAuth, req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  if (path === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else if (path.startsWith('/ws/terminal/')) {
    // scope-gate the session here (403 before handshake), then:
    terminalWss.handleUpgrade(req, socket, head, (ws) => terminalWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => onDashboardConnection(ws));
```

Context resolved at the upgrade (actor, session name) is handed to the
`connection` handler via a `WeakMap<IncomingMessage, …>` — resolve once, reuse,
so the gate and the handler can never act on different values.

## Connection Registry (sole owner of the socket pool)

One module owns the authoritative `Map<WebSocket, Actor>` for **both** pools.
Handlers receive only the narrow `SocketRegistrar` interface — they
`register`/`unregister`, never touch the map. This exists because the
dashboard client set was previously mutated by three parties (handler,
broadcaster, shutdown path); single ownership removed the shared-mutable smell.
Real source: `src/server/viewer-connection-registry.ts`.

```typescript
interface RegisteredSocket {
  ws: WebSocket; actor: Actor;
  kind: 'dashboard' | 'terminal';
  sessionName?: string;   // terminal sockets, for the scope re-check
  connectedAtMs: number;
}
// register on connection, unregister on close.
// The registry also runs the revocation sweep: a periodic, error-isolated
// tick dropping any socket whose viewer grant was revoked, expired, or
// deleted, plus terminal sockets that fell out of scope.
// Inbound gate: viewers get a positive allow-list of message types
// (default-deny by construction) — see isAllowedViewerInbound in
// src/server/ws-connection-handler.ts.
```

## Message Protocol

**Client -> Server:** `init` (lastSeq, subscriptions), `ack` (seq), `subscribe` (add/remove), `pong`
**Server -> Client:** `snapshot` (seq, data), `delta` (seq, resource, id, action, state), `ping`, `error` (message, code)

**Default subscriptions:** `task, worker, workflow, process, health, cost, suggestion, deployment, maintenance`

## Back-Pressure & Slow Consumer Detection

```typescript
// WRONG: Unbounded send — one slow mobile client causes OOM
client.ws.send(JSON.stringify(delta));

// CORRECT: Check buffer before sending
if (client.ws.bufferedAmount > 1_000_000) {
  client.needsCatchUp = true; // Mark for snapshot catch-up on drain
  return; // Skip this delta
}
client.ws.send(JSON.stringify(delta));
```

**Per-connection rate limits:** Max inbound msg/s (e.g., 50). Close with code 1008 on sustained violation.

## Inbound Error Budget

```typescript
// Validate every message, close after N consecutive errors
const MAX_CONSECUTIVE_ERRORS = 5;
let consecutiveErrors = 0;
ws.on('message', (raw) => {
  try {
    const msg = JSON.parse(raw);
    const result = MessageSchema.safeParse(msg);
    if (!result.success) {
      consecutiveErrors++;
      ws.send(JSON.stringify({ type: 'error', code: 'INVALID_FORMAT', message: '...' }));
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) ws.close(1008, 'Too many errors');
      return;
    }
    consecutiveErrors = 0;
    handleMessage(result.data, ws);
  } catch {
    consecutiveErrors++;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) ws.close(1008, 'Too many parse errors');
  }
});
```

**Rule:** Never crash the WS connection on bad data. Validate all inbound, send typed error envelopes, close gracefully after N consecutive errors.

## Message Envelope Versioning

```typescript
type Envelope = {
  version: number;       // Bump on breaking changes
  action: string;        // "chat.send" | "room.join"
  requestId?: string;    // Request/response correlation
  payload: unknown;
  timestamp: number;
};
```

**Rule:** Every WS message MUST include `version`. Reject unknown versions with typed error response. Enables safe protocol evolution without breaking connected clients.

## Keepalive / Dead Client Detection

Server pings every 30s, kills clients that don't pong within 10s (`lastPong > 40000ms ago`). Use application-level ping (more debuggable than protocol-level).

## Client Reconnection

```
Attempt 1: 1000ms + jitter → Attempt 2: 1500ms + jitter → ... → Max: 30000ms
```

On reconnect: client sends `init` with `lastSeq` -> server sends snapshot + missed deltas. WS reconnects indefinitely with backoff, so recovery does not depend on short-lived browser fallback limits.

## Page Visibility API

Pause rendering when tab hidden, keep WS alive. On return after >30s, request catch-up (browsers throttle WS in background tabs). See [[realtime-state-sync]] for gap recovery details.

## BroadcastChannel Multi-Tab Sync

Leader election via `navigator.locks` (`ifAvailable: true`). Leader holds WS, posts to BroadcastChannel. Followers receive from channel without WS. N tabs = 1 connection.

## Redis Pub/Sub Scaling (multi-instance only)

Kookr runs a single instance and fans out locally through the registry — none of this section applies until there is more than one server process. For multi-instance: every message published to Redis; every server subscribes and fans out only to its local clients. Use `redis.duplicate()` for subscriber connection (blocking commands monopolize TCP). Room-specific channels for efficiency.

## Diagnostic Endpoints

`GET /ws/stats` is not implemented as a route. For diagnostics use the connection registry (`src/server/viewer-connection-registry.ts`) — viewer sockets are surfaced to the owner via `GET /api/share/viewers`.

## Common Anti-Patterns Checklist

- [ ] Server sends ping every <=30s, closes after 2 missed pongs
- [ ] Client reconnects with exponential backoff + jitter (cap 30s)
- [ ] No `ws.send()` without checking `bufferedAmount`
- [ ] All inbound messages validated (Zod), typed error on failure
- [ ] Connection closed after N consecutive invalid messages
- [ ] Multi-instance only: all broadcasts go through a shared bus (Redis), not local-only fan-out
- [ ] Sequence numbers used for ordered streams
- [ ] Client sends `lastSeq` on reconnect, server replays missed
- [ ] Reconnection, back-pressure, and malformed messages have tests
- [ ] Page Visibility API pauses rendering when tab hidden

## See Also

[[realtime-state-sync]], dashboard-development, api-route-patterns, [[error-handling-patterns]]
