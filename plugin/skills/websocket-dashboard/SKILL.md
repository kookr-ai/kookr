---
name: websocket-dashboard
description: WebSocket patterns for Hono/Bun dashboard connections, connection manager, per-client state, browser lifecycle, back-pressure, rate limiting, message versioning
keywords: WebSocket, upgradeWebSocket, Hono, Bun, connection manager, per-client state, reconnection, BroadcastChannel, Page Visibility, leader election, ping pong, subscription filtering, back-pressure, bufferedAmount, rate limiting, slow consumer, message envelope, versioning, error budget
related: realtime-state-sync, dashboard-development, api-route-patterns, error-handling-patterns, resilience-patterns, fouc-rendering-stability, browser-memory-management, incremental-migration-patterns, frontend-error-boundaries
---

# WebSocket Dashboard Patterns

Hono/Bun WebSocket patterns for the canonical real-time command center transport.

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
| 8 | **Always publish to Redis, not local-only** | Multi-instance: messages reach subset of users | `redis.publish(channel, msg)`, fan out only to local clients per instance |
| 9 | **Sequence numbers for ordered streams** | Assume TCP = FIFO across reconnects | Per-resource seq numbers; client requests replay on gap |
| 10 | **Test reconnection, back-pressure, malformed messages** | Only manual browser testing | Unit + integration tests for every handler, mock Redis |

## Quick Reference

| Issue | Cause | Fix |
|-------|-------|-----|
| WS connects then drops | Missing ping/pong | Application-level ping or Bun built-in |
| Client state drift | No snapshot on connect | Full snapshot as first message after `init` |
| Memory leak | Clients not cleaned up | Track in Map, remove in `onClose` |
| Browser tab frozen | Background throttling | Page Visibility API to pause rendering |
| Multiple tabs = N connections | Each tab opens WS | BroadcastChannel + leader election |
| Server OOM from slow client | Unbounded ws.send() queue | Monitor `bufferedAmount`, snapshot slow consumers |
| Malformed message crash | No try/catch on parse | Validate, error envelope, close after N errors |

## Server: Hono/Bun WebSocket Endpoint

```typescript
import { upgradeWebSocket } from 'hono/bun'; // NOT hono/cloudflare-workers
app.get('/ws', upgradeWebSocket((c) => {
  let client: ClientState;
  return {
    onOpen: (_evt, ws) => { client = connectionManager.register(ws); },
    onMessage: (evt, ws) => {
      const msg = JSON.parse(evt.data.toString());
      switch (msg.type) {
        case 'init': handleInit(client, msg, ws); break;
        case 'ack': client.lastSeq = msg.seq; break;
        case 'subscribe': handleSubscriptionChange(client, msg); break;
        case 'pong': client.lastPong = Date.now(); break;
      }
    },
    onClose: () => { connectionManager.unregister(client); }
  };
}));
```

## Connection Manager (Key Interface)

```typescript
interface ClientState {
  id: string; ws: ServerWebSocket; lastSeq: number;
  subscriptions: Set<string>; active: boolean;
  connectedAt: number; lastPong: number; needsCatchUp: boolean;
}
// Register in onOpen, unregister in onClose, activate after init+snapshot
// broadcast() checks: active → subscribed → bufferedAmount < 1MB → send
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
ws.message = (ws, raw) => {
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
};
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

## Redis Pub/Sub Scaling

Every message published to Redis; every server subscribes and fans out only to its local clients. Use `redis.duplicate()` for subscriber connection (blocking commands monopolize TCP). Room-specific channels for efficiency.

## Diagnostic Endpoints

[VERIFY] `GET /ws/stats` not yet implemented as a route. Use `ConnectionManager` internal state or Redis CLI for diagnostics.

## Common Anti-Patterns Checklist

- [ ] Server sends ping every <=30s, closes after 2 missed pongs
- [ ] Client reconnects with exponential backoff + jitter (cap 30s)
- [ ] No `ws.send()` without checking `bufferedAmount`
- [ ] All inbound messages validated (Zod), typed error on failure
- [ ] Connection closed after N consecutive invalid messages
- [ ] All broadcasts go through Redis (not local-only fan-out)
- [ ] Sequence numbers used for ordered streams
- [ ] Client sends `lastSeq` on reconnect, server replays missed
- [ ] Reconnection, back-pressure, and malformed messages have tests
- [ ] Page Visibility API pauses rendering when tab hidden

## See Also

[[realtime-state-sync]], [[dashboard-development]], [[api-route-patterns]], [[error-handling-patterns]]
