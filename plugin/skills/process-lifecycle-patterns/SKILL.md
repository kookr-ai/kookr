---
name: process-lifecycle-patterns
description: Process lifecycle and graceful shutdown - signal handling, connection draining, health probes, resource cleanup ordering, worker management, zero-downtime deploys
keywords: SIGTERM, SIGINT, graceful shutdown, connection draining, health check, liveness, readiness, startup probe, resource cleanup, PID 1, dumb-init, tini, zero-downtime, rolling update, process manager, worker process, uncaught exception, unhandled rejection, shutdown timeout
related: error-handling-patterns, async-flow-control
---

# Process Lifecycle Patterns

Rules for writing Node.js/TypeScript services that start cleanly, shut down gracefully, and survive deploys with zero dropped requests.

**Research:** `docs/deepresearch/reports/Process Lifecycle and Graceful Shutdown Patterns.md`

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | **Handle SIGTERM + SIGINT** | `process.on('SIGTERM', () => process.exit(0))` | Full drain + cleanup + timeout guard |
| 2 | **Readiness 503 on shutdown** | Readiness probe stays 200 during drain | Set readiness to 503 immediately on signal |
| 3 | **Drain before close** | `server.close()` then `dbPool.end()` in parallel | Stop accepting, drain in-flight, THEN close clients |
| 4 | **Reverse cleanup order** | `Promise.all([db.end(), redis.quit(), server.close()])` | Close in reverse dependency order with per-step timeouts |
| 5 | **Force-kill timeout** | Shutdown hangs indefinitely | `setTimeout(() => process.exit(1), 30_000)` as safety net |
| 6 | **Never PID 1 without init** | `CMD ["node", "dist/index.js"]` in Dockerfile | Use `dumb-init`, `tini`, or `--init` flag |
| 7 | **Forward signals to children** | `child_process.exec()` for long-running workers | `spawn` + explicit signal forwarding |
| 8 | **Distinct health probes** | Single `/health` always returns 200 | Separate `/live`, `/ready`, `/startup` endpoints |
| 9 | **No blocking work in probes** | Synchronous DB query in health check | Cached health state, background refresh |
| 10 | **Crash on uncaught exceptions** | `process.on('uncaughtException', () => {})` | Log + trigger graceful shutdown + exit |

## Signal Handling

```typescript
// WRONG: No cleanup, in-flight requests get ECONNRESET
process.on('SIGTERM', () => process.exit(0));

// CORRECT: Full graceful shutdown sequence
let isShuttingDown = false;
const SHUTDOWN_TIMEOUT = 30_000; // Match K8s terminationGracePeriodSeconds

async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return; // Prevent double-shutdown
  isShuttingDown = true;
  logger.info({ signal }, 'Graceful shutdown initiated');

  // Safety net: force exit if drain hangs
  const forceTimer = setTimeout(() => {
    logger.error('Shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);
  forceTimer.unref(); // Don't keep process alive just for this timer

  try {
    // 1. Mark readiness as 503 (isShuttingDown flag)
    // 2. Stop accepting new connections
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    // 3. Drain in-flight work (see Connection Draining)
    // 4. Close resources in reverse dependency order
    await redis.quit();
    await dbPool.end();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
```

**Key details:**
- `isShuttingDown` flag prevents double-shutdown from rapid signals
- `forceTimer.unref()` prevents the timer itself from keeping the process alive
- Match `SHUTDOWN_TIMEOUT` to your orchestrator's grace period (K8s default: 30s)

## Connection Draining

```typescript
// WRONG: server.close() but no drain - in-flight requests get killed
httpServer.close();

// CORRECT: Track active requests, drain with timeout
let activeRequests = 0;
const DRAIN_TIMEOUT = 25_000; // Leave 5s buffer before force-kill

httpServer.on('request', (_req, res) => {
  activeRequests++;
  res.on('finish', () => activeRequests--);
});

async function drainConnections(): Promise<void> {
  // Node >= 18.2: force-close idle keep-alive connections
  httpServer.closeAllConnections?.();

  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
    // If active requests don't finish in time, force it
    setTimeout(() => resolve(), DRAIN_TIMEOUT);
  });
}
```

**Drain order matters:**
1. Set readiness probe to 503 (load balancer stops routing new traffic)
2. Call `server.close()` (stops accepting new TCP connections)
3. Wait for in-flight requests to complete (or timeout)
4. Close database pools, Redis, queues in reverse dependency order

## Health Probe Design

```typescript
// WRONG: Single probe, always 200, does blocking DB query
app.get('/health', async (c) => {
  await sql`SELECT 1`; // Blocks event loop on every probe
  return c.json({ status: 'ok' });
});

// CORRECT: Three distinct probes with proper shutdown behavior
app.get('/live', (c) => {
  // Liveness: is the process alive and not deadlocked?
  return c.text(isShuttingDown ? 'shutting down' : 'ok', isShuttingDown ? 500 : 200);
});

app.get('/ready', (c) => {
  // Readiness: can this instance handle traffic?
  if (isShuttingDown || !isInitialized) {
    return c.text('not ready', 503);
  }
  return c.text('ok', 200);
});

app.get('/startup', (c) => {
  // Startup: has the app finished initializing?
  return c.text(isInitialized ? 'ok' : 'starting', isInitialized ? 200 : 503);
});

// Background health state refresh (never block probes)
let cachedHealthState = { db: false, redis: false };
setInterval(async () => {
  cachedHealthState = {
    db: await quickDbPing().catch(() => false),
    redis: await redis.ping().then(() => true).catch(() => false),
  };
}, 10_000);
```

| Probe | Purpose | Shutdown Behavior | Failure Action |
|-------|---------|-------------------|----------------|
| `/live` | Process alive? | 500 when shutting down | K8s restarts pod |
| `/ready` | Can handle traffic? | 503 immediately on SIGTERM | K8s removes from service |
| `/startup` | Finished initializing? | N/A (only checked at start) | K8s waits |

**Rule:** During shutdown, readiness MUST return 503 immediately. This tells the load balancer to stop routing new requests while existing ones drain.

## Resource Cleanup Ordering

```typescript
// WRONG: Parallel cleanup ignores dependencies
await Promise.all([
  server.close(),
  dbPool.end(),   // Might close while requests still use connections
  redis.quit(),
]);

// CORRECT: Reverse dependency order with per-step timeouts
const STEP_TIMEOUT = 5_000;

async function withTimeout<T>(fn: () => Promise<T>, label: string): Promise<T | void> {
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out`)), STEP_TIMEOUT)
      ),
    ]);
  } catch (err) {
    logger.warn({ err, step: label }, 'Cleanup step failed or timed out');
  }
}

// Cleanup in reverse creation order:
// Created: DB -> Redis -> Queue -> HTTP server
// Cleanup: HTTP server -> Queue -> Redis -> DB
await withTimeout(() => drainConnections(), 'http-drain');
await withTimeout(() => queue.stop(), 'queue-stop');
await withTimeout(() => redis.quit(), 'redis-quit');
await withTimeout(() => dbPool.end(), 'db-close');
```

**Cleanup registry pattern** for complex applications:
```typescript
// Register resources at creation time
const cleanupStack: Array<{ label: string; fn: () => Promise<void> }> = [];

function registerCleanup(label: string, fn: () => Promise<void>): void {
  cleanupStack.push({ label, fn });
}

// At shutdown: pop from stack (reverse order)
async function runCleanup(): Promise<void> {
  while (cleanupStack.length > 0) {
    const { label, fn } = cleanupStack.pop()!;
    await withTimeout(fn, label);
  }
}
```

**Common leaks that survive restarts:** dangling `setInterval`, unremoved event listeners, unclosed streams. Register every timer and subscription in the cleanup stack.

## Worker Process Management (Docker PID 1)

```dockerfile
# WRONG: Node runs as PID 1, doesn't receive signals properly
CMD ["node", "dist/index.js"]

# CORRECT: Use init process to handle signals
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/index.js"]

# CORRECT: Or use Docker's --init flag
# docker run --init myapp
```

**Why this matters:** When Node runs as PID 1 in a container, it does NOT get default signal handling. SIGTERM may be silently ignored. An init process (`dumb-init`, `tini`, or Docker's `--init`) properly forwards signals to Node.

**Signal forwarding to child processes:**
```typescript
// WRONG: exec() for long-running workers, no signal forwarding
const child = exec('node worker.js');

// CORRECT: spawn + explicit signal forwarding
const child = spawn('node', ['worker.js'], { stdio: 'inherit' });

process.on('SIGTERM', () => {
  child.kill('SIGTERM'); // Forward signal to child
  // Child's own graceful shutdown handler runs
});
```

**Rule:** Always forward SIGTERM/SIGINT to child processes. Use `spawn` (not `exec`) for long-running workers. Use `dumb-init` or `--init` in Docker.

## Uncaught Exception Policy

```typescript
// WRONG: Swallow and continue in corrupted state
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception');
  // Process continues running in unknown state!
});

// CORRECT: Log, graceful shutdown, exit
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception - initiating shutdown');
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection - initiating shutdown');
  gracefulShutdown('unhandledRejection');
});
```

**Rule:** Never continue running after an uncaught exception. The process state is unknown and potentially corrupted. Log with `fatal` level, trigger graceful shutdown, and exit. Let the process manager restart a clean instance.

## Zero-Downtime Deploy Checklist

For rolling updates with zero dropped requests:

1. New pod starts, passes startup probe
2. New pod passes readiness probe, joins service
3. Old pod receives SIGTERM
4. Old pod sets readiness to 503 (load balancer removes it)
5. Old pod drains in-flight requests
6. Old pod closes resources in reverse order
7. Old pod exits cleanly

**Coordinate with DB migrations:** Use feature flags or dual-write patterns. Never run destructive migrations during a rolling update.

## Common Anti-Patterns Checklist

Before submitting process lifecycle code, verify:

- [ ] No `process.exit(0)` without drain + cleanup sequence
- [ ] No single `/health` endpoint serving both liveness and readiness
- [ ] No synchronous or blocking work inside health probes
- [ ] No `CMD ["node", "..."]` as PID 1 without init process
- [ ] No `exec()` for long-running child processes (use `spawn`)
- [ ] No missing signal forwarding to child processes
- [ ] No `process.on('uncaughtException')` that continues running
- [ ] No cleanup without per-step timeouts
- [ ] No parallel cleanup of interdependent resources
- [ ] No missing `isShuttingDown` guard for double-shutdown prevention

## See Also

[[error-handling-patterns]] - Process-level error handling, unhandledRejection
[[async-flow-control]] - SIGTERM drain, AbortController cancellation
resilience-patterns - Circuit breakers, auto-healing, task recovery
docker-compose-patterns - Container configuration, Docker best practices
service-manager - Service lifecycle daemon patterns
