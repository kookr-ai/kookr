---
name: async-flow-control
description: Async flow control patterns - AbortController cancellation, async iterators for large datasets, worker thread selection, Promise combinator choice, stream backpressure in async pipelines
keywords: AbortController, AbortSignal, cancellation, async iterator, async generator, cursor pagination, stream processing, worker_threads, child_process, cluster, Promise.allSettled, Promise.all, concurrency, backpressure, p-limit, p-queue, drain, pipeline
related: error-handling-patterns, process-lifecycle-patterns, state-machine-workflow-patterns
---

<!-- lint-allow-library: pg-query-stream --> <!-- illustrative streaming example -->

# Async Flow Control Patterns

Rules for writing async code that cancels cleanly, streams large datasets without OOM, and selects the right concurrency primitive.

**Research:** `docs/deepresearch/reports/Async Patterns and Flow Control in Node.js.md`

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | **AbortSignal on long-running ops** | `await fetch(url)` with no timeout | `await fetch(url, { signal })` |
| 2 | **Cursor-stream large queries** | `await db.findMany()` on 10K+ rows | Async generator with cursor pagination |
| 3 | **`allSettled` for independent ops** | `Promise.all([fetchA(), fetchB()])` where partial OK | `Promise.allSettled([fetchA(), fetchB()])` |
| 4 | **Bound concurrency** | `Promise.all(items.map(fn))` unbounded | `Promise.all(items.map(x => limit(() => fn(x))))` |
| 5 | **`pipeline()` for streams** | `readable.pipe(writable)` (no error propagation) | `await pipeline(readable, transform, writable)` |
| 6 | **CPU work in worker threads** | Heavy computation on main event loop | `worker_threads` pool for CPU, `child_process` for isolation |
| 7 | **`try/finally` on async iterators** | Async generator without cleanup | `try { yield* } finally { cursor.close() }` |
| 8 | **Respect `drain` on writes** | Ignore `write()` return value | Pause readable on `false`, resume on `drain` |
| 9 | **Graceful shutdown on SIGTERM** | Process exits mid-request | Drain in-flight, stop accepting, then exit |
| 10 | **No `.on()` in request handlers** | `emitter.on('x', fn)` per request | `emitter.once('x', fn)` or explicit `.off()` cleanup |

## Promise Combinator Selection

```typescript
// WRONG: One flaky analytics call kills entire dashboard load
const [user, posts, analytics] = await Promise.all([
  fetchUser(id),
  fetchPosts(id),
  fetchAnalytics(id), // 404 or timeout -> everything fails
]);

// CORRECT: Independent operations degrade gracefully
const results = await Promise.allSettled([
  fetchUser(id),
  fetchPosts(id),
  fetchAnalytics(id),
]);

const [user, posts, analytics] = results.map((r, i) =>
  r.status === 'fulfilled'
    ? r.value
    : (() => { logger.warn({ source: sources[i], err: r.reason }, 'Partial fetch failed'); return null; })()
);
```

| Method | Use When | Failure Behavior |
|--------|----------|------------------|
| `Promise.all` | All MUST succeed (transaction parts, required data) | First rejection cancels all |
| `Promise.allSettled` | Independent tasks, partial success OK (dashboard, batch) | Collects all results |
| `Promise.any` | First success wins (redundant services, failover) | Rejects only if ALL fail |
| `Promise.race` | First to settle wins (timeout race) | Losers keep running (use AbortController to cancel) |
| `for...of` sequential | Order matters, or need backpressure | Process one at a time |

**Rule:** Default to `allSettled` for multi-source fetches. Use `all` only when every result is required for correctness.

## AbortController & Cancellation

```typescript
// WRONG: No cancellation, fake timeout leaves work running
const result = await Promise.race([
  fetch(url),                              // Keeps running even after timeout!
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
]);

// CORRECT: Thread AbortSignal for true cancellation
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// CORRECT: Propagate signal through layers
async function processTask(taskId: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted(); // Bail early if already cancelled

  const data = await fetch(`/api/tasks/${taskId}`, { signal });
  signal?.throwIfAborted(); // Check at safe points between steps

  await db.query(sql`UPDATE tasks SET status = 'processing' WHERE id = ${taskId}`);
  signal?.throwIfAborted();

  await sendNotification(taskId, { signal });
}

// CORRECT: Cleanup on abort
const controller = new AbortController();
controller.signal.addEventListener('abort', () => {
  tempFile.cleanup();
  dbConnection.release();
});
```

**Where to accept `AbortSignal`:**
- HTTP requests (`fetch`, `axios`, `got`)
- Database queries (via query timeout or connection pool)
- File system operations (`fs.readFile` in Node 20+)
- Any function that does I/O or takes >100ms

**Rule:** Every long-running operation must accept an optional `AbortSignal`. Call `signal.throwIfAborted()` at safe points between steps. Clean up resources (temp files, connections) on abort.

## Async Iterators for Large Datasets

```typescript
// WRONG: Load entire table into memory -> OOM on large datasets
const users = await prisma.user.findMany(); // 500K rows = crash
for (const user of users) {
  await processUser(user);
}

// CORRECT: Cursor-based async generator with cleanup
async function* getUsersByCursor(batchSize = 100): AsyncGenerator<User> {
  let cursor: string | undefined;
  try {
    while (true) {
      const page = await prisma.user.findMany({
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
      });
      if (page.length === 0) break;
      for (const user of page) yield user;
      cursor = page[page.length - 1].id;
    }
  } finally {
    // Cleanup runs even if consumer breaks early
    logger.debug('User cursor iteration complete');
  }
}

// Consumer: memory stays flat regardless of dataset size
for await (const user of getUsersByCursor()) {
  await processUser(user);
}

// CORRECT: Node postgres QueryStream for raw SQL
import QueryStream from 'pg-query-stream';
const stream = client.query(new QueryStream('SELECT * FROM users ORDER BY id'));
for await (const row of stream) {
  await processRow(row);
}
```

**When to use async iterators:**
- Any query that may return >10K rows
- Processing files line by line
- Consuming paginated external APIs
- Redis SCAN operations

**Rule:** For any dataset of unknown or large size, use cursor pagination with an async generator or Node streams. Always wrap in `try/finally` for cleanup. Never call `.findMany()` or equivalent without a `LIMIT` on unbounded tables.

## Worker Thread vs Child Process Selection

```typescript
// CPU-heavy work: worker_threads (shared memory, fast)
import { Worker } from 'worker_threads';

const worker = new Worker('./hash-worker.js', {
  workerData: { items: largeArray },
});
worker.on('message', (result) => { /* processed */ });
worker.on('error', (err) => { logger.error({ err }, 'Worker failed'); });

// Isolation/untrusted code: child_process (separate V8 heap)
import { fork } from 'child_process';
const child = fork('./plugin-runner.js', [], {
  execArgv: ['--max-old-space-size=256'], // Constrained memory
});
```

| Mechanism | Use Case | Memory Model | Overhead |
|-----------|----------|-------------|----------|
| `worker_threads` | CPU-heavy (hashing, parsing, image) | Shared `ArrayBuffer` possible | Low (same process) |
| `child_process` | Isolation, non-Node, untrusted plugins | Separate V8 heap | Medium (fork) |
| `cluster` / PM2 | Horizontal I/O scaling | Separate processes | High (full copy) |
| Main thread | I/O-bound work (HTTP, DB, Redis) | Single V8 heap | None |

**Rule:** CPU-intensive work (>50ms of computation) must run in a `worker_threads` pool, not on the main event loop. Use `child_process` only when memory isolation is required. Keep the main thread for I/O coordination.

## Graceful Shutdown

```typescript
// WRONG: Process exits immediately, drops in-flight requests
process.on('SIGTERM', () => process.exit(0));

// CORRECT: Drain in-flight work, then exit
let shuttingDown = false;

process.on('SIGTERM', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Graceful shutdown initiated');

  // 1. Stop accepting new work
  server.close();

  // 2. Wait for in-flight requests (with timeout)
  const drainTimeout = setTimeout(() => {
    logger.warn('Drain timeout reached, forcing exit');
    process.exit(1);
  }, 30_000);
  drainTimeout.unref(); // Don't keep process alive just for this timer

  await Promise.allSettled(inFlightRequests);
  clearTimeout(drainTimeout);

  // 3. Close connections
  await db.end();
  await redis.quit();

  process.exit(0);
});
```

**Shutdown order:**
1. Stop accepting new connections/work
2. Drain in-flight requests (with timeout)
3. Close database connections, Redis, external clients
4. Exit cleanly

**Rule:** Every long-running process must handle `SIGTERM` with a graceful drain. Never call `process.exit()` without first draining in-flight work. Set a drain timeout (30s default) to prevent hanging. See [[process-lifecycle-patterns]] for production-grade shutdown with resource cleanup ordering and health probe integration.

## Event Emitter Lifecycle

```typescript
// WRONG: Listener count grows per request -> memory leak -> OOM
app.post('/events', (req, res) => {
  bus.on('update', (data) => { /* uses req context */ }); // Never removed!
});

// CORRECT: One-shot listeners auto-remove
app.post('/events', (req, res) => {
  bus.once('update', (data) => { /* ... */ });
});

// CORRECT: Explicit cleanup for persistent subscriptions
function subscribe(emitter: EventEmitter, event: string, handler: Function): () => void {
  emitter.on(event, handler);
  return () => emitter.off(event, handler);
}
const unsub = subscribe(bus, 'update', handler);
// In teardown:
unsub();
```

**Rule:** Every `.on()` in a request handler or loop must have a corresponding `.off()` or use `.once()`. If `MaxListenersExceededWarning` appears, there is a leak -- fix it, do not raise `setMaxListeners`.

## Stream Pipeline Discipline

```typescript
// WRONG: .pipe() has no error propagation or backpressure
readable.pipe(transform).pipe(writable); // Error in transform = hung stream

// CORRECT: pipeline() handles errors + backpressure + cleanup
import { pipeline } from 'stream/promises';
await pipeline(readable, transform, writable);

// CORRECT: Manual backpressure when pipeline doesn't fit
readable.on('data', (chunk) => {
  const canWrite = writable.write(chunk);
  if (!canWrite) {
    readable.pause();
    writable.once('drain', () => readable.resume());
  }
});
```

**Rule:** Never use `.pipe()` in production. Always use `pipeline()` from `stream/promises` which handles error propagation, backpressure, and cleanup automatically.

## Common Anti-Patterns Checklist

Before submitting async code, verify:

- [ ] No `Promise.all` for independent operations (use `allSettled`)
- [ ] No unbounded `Promise.all(items.map(fn))` (use `p-limit`)
- [ ] No `Promise.race` for timeouts without `AbortController` (losers keep running)
- [ ] No `findMany()` without `LIMIT` on potentially large tables (use cursor/async iterator)
- [ ] No CPU-heavy work on main event loop (use `worker_threads`)
- [ ] No `.pipe()` without `pipeline()` (no error propagation)
- [ ] No `write()` ignoring return value (check for `false`, listen for `drain`)
- [ ] No `.on()` in request handlers without `.off()` or `.once()`
- [ ] No `process.exit()` without graceful drain of in-flight work
- [ ] No long-running ops without `AbortSignal` parameter

## See Also

[[error-handling-patterns]] - Error classification, retry discipline, fire-and-forget safety
nodejs-memory-management - Closure retention, buffer pooling, WeakRef caches, V8 heap tuning
resilience-patterns - Circuit breakers, auto-healing, TaskReaper recovery
race-conditions-atomicity - Distributed locking, SKIP LOCKED, atomic state transitions
