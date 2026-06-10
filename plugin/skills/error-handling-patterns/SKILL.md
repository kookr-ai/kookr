---
name: error-handling-patterns
description: Error handling best practices - cause chaining, boundary validation, structured errors, fire-and-forget safety, retry discipline
keywords: error handling, catch, throw, cause chaining, Zod validation, fire-and-forget, Promise.all, circuit breaker, retry, backoff, jitter, structured logging, silent failure, empty catch, SQL injection, parameterized query, discriminated union, Result type
related: testing-patterns, monorepo-architecture, typescript-type-safety, domain-driven-design, websocket-dashboard, safe-refactoring, logging-design-patterns, dependency-injection-patterns, event-driven-messaging-patterns, async-flow-control, process-lifecycle-patterns, state-machine-workflow-patterns
---

# Error Handling Patterns

Rules for writing code that fails safely, predictably, and visibly.

**Research:** `docs/deepresearch/reports/AI Coding Agent Error Handling Guidelines.md`, `docs/deepresearch/reports/Git Commit Discipline for AI Coding Agents.md`

## Non-Negotiable Rules

These rules are ALWAYS enforced when writing or reviewing code:

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | **No empty catch blocks** | `catch { }` | `catch (err) { logger.debug({ err }, 'context'); }` |
| 2 | **Always chain cause** | `throw new Error(msg)` in catch | `throw new Error(msg, { cause: err })` |
| 3 | **No fire-and-forget** | `void asyncFn()` | `asyncFn().catch(err => logger.error({ err }))` |
| 4 | **Validate at boundary** | `body as MyType` | `MySchema.safeParse(body)` |
| 5 | **Parameterized SQL** | `` `WHERE x = '${val}'` `` | `` sql`WHERE x = ${val}` `` |
| 6 | **Structured logging** | `console.log(error)` | `logger.error({ err }, 'context')` |
| 7 | **Bound concurrency** | `Promise.all(big.map(fn))` | `Promise.all(big.map(x => limit(() => fn(x))))` |
| 8 | **Never throw strings** | `throw "failed"` | `throw new Error("failed")` |
| 9 | **Idempotency keys for retried mutations** | Retry `POST /pay` without key | Add `Idempotency-Key` header |
| 10 | **Top-level error boundary** | Unhandled error crashes server | Global error middleware catches all |

## Error Classification

| Type | Examples | Response | Retry? |
|------|----------|----------|--------|
| **Operational** | Network timeout, 503, disk full, rate limit | Handle gracefully, log, alert | Yes (with backoff) |
| **Programmer** | null deref, type error, assertion fail | Crash/restart, fix the bug | No |
| **Validation** | Bad user input, malformed JSON, missing field | Return 400, log at info level | No |
| **Domain** | Email taken, insufficient funds, permission denied | Return typed result, no exception | No |

**Rule:** Only retry operational errors. Never retry 4xx responses (except 429 with Retry-After).

## Cause Chaining

```typescript
// WRONG: Original stack trace DESTROYED
catch (err) {
  throw new Error(`Payment failed: ${err.message}`);
}

// CORRECT: Full error chain PRESERVED
catch (err) {
  throw new Error('Payment failed', { cause: err });
}
```

**Why it matters:** Without `{ cause }`, debugging requires guessing where the original error occurred. With cause chaining, `error.cause.cause.stack` gives the complete trace through every layer.

## Boundary Validation (Parse, Don't Validate)

```typescript
// WRONG: Type assertion trusts untrusted data
const body = await c.req.json();
const { name, email } = body as CreateUserDto; // No validation!

// CORRECT: Zod schema parses and types simultaneously
const CreateUserSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
});
const result = CreateUserSchema.safeParse(await c.req.json());
if (!result.success) return c.json({ error: result.error.format() }, 400);
const { name, email } = result.data; // Typed AND validated
```

**Where to validate:**
- API route handlers: `req.body`, `req.params`, `req.query`
- External API responses: parse before using
- Environment variables: validate at startup
- Database results: trust (DB enforces schema)
- Internal function calls: don't re-validate (trusted boundary)

## Fire-and-Forget Safety

```typescript
// WRONG: Silent unhandled rejection → potential process crash
void this.sendNotification(userId);

// CORRECT: Explicit error handling for background work
this.sendNotification(userId).catch((err) => {
  logger.error({ err, userId }, 'Background notification failed');
});

// BETTER: Reusable utility
function fireAndForget(fn: () => Promise<void>, context: string): void {
  fn().catch((err) => {
    logger.error({ err, context }, 'Background task failed');
  });
}
fireAndForget(() => this.sendNotification(userId), 'send-notification');
```

**Rule:** Every `void asyncFn()` or unawaited async call is a bug until proven otherwise.

## Retry Discipline

```typescript
// WRONG: Immediate retry, no backoff, retries everything
for (let i = 0; i < 3; i++) {
  try { return await fetch(url); }
  catch { /* retry immediately */ }
}

// CORRECT: Exponential backoff + jitter + error classification
async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err; // Don't retry 400s or programmer errors
      const delay = opts.baseDelay * Math.pow(2, attempt);
      const jitter = delay * Math.random(); // Prevent thundering herd
      await sleep(delay + jitter);
    }
  }
  throw new Error(`Failed after ${opts.maxRetries} retries`);
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status >= 500 || err.status === 429; // Server errors + rate limit
  }
  if (err instanceof Error && err.message.includes('ECONNREFUSED')) return true;
  if (err instanceof Error && err.message.includes('ETIMEDOUT')) return true;
  return false; // Default: don't retry
}
```

**Idempotency keys:** Any retried mutation (POST, PUT, DELETE) MUST include an idempotency key to prevent double-execution. Stripe-style: `Idempotency-Key: <uuid>` header. Without this, retries on flaky networks cause double charges, duplicate records, etc.

**Never retry:**
- 400 Bad Request (client error, won't change on retry)
- 401/403 (auth error, won't change)
- 404 (resource doesn't exist)
- 409 Conflict (state conflict, need different approach)
- Non-idempotent operations without idempotency key

**Always retry:**
- 503 Service Unavailable (with backoff)
- 504 Gateway Timeout (with backoff)
- 429 Too Many Requests (with Retry-After header)
- ECONNREFUSED, ETIMEDOUT, ECONNRESET

## Promise.all Discipline

```typescript
// WRONG: 10,000 concurrent DB queries
await Promise.all(users.map(u => db.save(u)));

// CORRECT: Bounded concurrency
import pLimit from 'p-limit';
const limit = pLimit(10);
await Promise.all(users.map(u => limit(() => db.save(u))));

// CORRECT: Use allSettled for independent operations
const results = await Promise.allSettled(tasks.map(t => limit(() => process(t))));
const failures = results.filter(r => r.status === 'rejected');
if (failures.length > 0) {
  logger.warn({ failCount: failures.length }, 'Batch processing partial failure');
}
```

| Method | Use When |
|--------|----------|
| `Promise.all` | All must succeed (transaction parts) |
| `Promise.allSettled` | Independent tasks (batch, dashboard data) |
| `Promise.any` | First success wins (redundant services) |
| `for...of` sequential | Order matters, or need backpressure |

## SQL Parameterization

```typescript
// CRITICAL VULNERABILITY: String concatenation
const results = await sql.unsafe(`SELECT * FROM tasks WHERE status = '${status}'`);

// CORRECT: Tagged template literal (postgres.js auto-parameterizes)
const results = await sql`SELECT * FROM tasks WHERE status = ${status}`;

// CORRECT: Dynamic WHERE clauses
const results = await sql`
  SELECT * FROM tasks
  WHERE 1=1
  ${status ? sql`AND status = ${status}` : sql``}
  ${type ? sql`AND type = ${type}` : sql``}
  ORDER BY created_at DESC
`;
```

**Rule:** Never use `sql.unsafe()` with user input. Never use string interpolation (`` `${var}` ``) in SQL. Always use the tagged template which auto-parameterizes.

## Structured Error Logging

```typescript
// WRONG: Loses structure, no context, might log PII
console.log(`User ${user.email} failed: ${error}`);

// CORRECT: Structured, contextual, redacted
logger.error({
  err,                    // Serialized with stack trace
  userId: user.id,        // Context (NOT email/PII)
  operation: 'createUser', // What was attempted
  input: { name: dto.name }, // Safe subset of input
}, 'User creation failed');
```

**Every error log must include:**
- `err` object (serialized with stack)
- Operation context (what was being attempted)
- Entity identifiers (IDs, not PII)
- Never: passwords, tokens, emails, credit cards

## Discriminated Union Results (Domain Errors)

```typescript
// For expected business failures, DON'T throw — return typed results:
type CreateTaskResult =
  | { type: 'success'; task: Task }
  | { type: 'error'; reason: 'WORKFLOW_NOT_FOUND'; message: string }
  | { type: 'error'; reason: 'BUDGET_EXCEEDED'; limit: number; current: number }
  | { type: 'error'; reason: 'DUPLICATE_TASK'; existingId: string };

// Consumer MUST handle all cases (compiler enforces):
// NOTE: Current codebase uses { error } shape. New endpoints should migrate to
// RFC 7807 Problem Details per rest-api-design skill (see api-route-patterns for bridge pattern).
const result = await createTask(dto);
switch (result.type) {
  case 'success': return c.json(result.task, 201);
  case 'error':
    switch (result.reason) {
      case 'BUDGET_EXCEEDED': return c.json({ error: result.reason }, 402);
      case 'DUPLICATE_TASK': return c.json({ error: result.reason, id: result.existingId }, 409);
      default: return c.json({ error: result.reason }, 400);
    }
}
```

**When to use discriminated unions vs exceptions:**
- **Discriminated unions:** Expected domain failures (user not found, validation, business rules)
- **Exceptions:** Unexpected infrastructure failures (DB down, network error, disk full)

## Error Boundaries (Blast Radius Containment)

```typescript
// WRONG: One bad request crashes entire server
app.get('/api/data', async (c) => {
  const result = await riskyOperation(); // Unhandled throw kills process
  return c.json(result);
});

// CORRECT: Top-level error middleware isolates failures per-request
app.onError((err, c) => {
  logger.error({ err, url: c.req.url, method: c.req.method }, 'Unhandled error');
  return c.json({ error: 'Internal Server Error' }, err.status ?? 500);
});
```

**Rule:** Every HTTP server must have a top-level error handler. One malformed request must never crash the whole process. Use worker threads or separate processes for CPU-intensive subsystems.

## Process-Level Error Handling

```typescript
// Install ONCE at process startup — catches truly unhandled rejections
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled rejection — crashing');
  process.exit(1);
});
```

**Rule:** Always install `unhandledRejection` handler in entry points. Crash loud rather than running in corrupted state. Modern Node.js does this by default (--unhandled-rejections=throw), but be explicit.

## Common Anti-Patterns Checklist

Before submitting code, verify:

- [ ] No empty `catch` blocks (even "best-effort" must log at debug)
- [ ] No `throw new Error(msg)` in catch without `{ cause }`
- [ ] No `void asyncFn()` without error handling
- [ ] No `body as Type` — use Zod `.safeParse()`
- [ ] No string concatenation in SQL
- [ ] No `console.log` in production code
- [ ] No unbounded `Promise.all` over arrays of unknown size
- [ ] No retrying 4xx errors
- [ ] No retrying mutations without idempotency key
- [ ] No missing top-level error handler in HTTP servers
- [ ] No logging PII (emails, passwords, tokens)

## See Also

resilience-patterns, api-route-patterns, database-schema-patterns, race-conditions-atomicity
rest-api-design - REST API contract layer (RFC 7807 error format, pagination, versioning, rate limiting)
[[typescript-type-safety]] - Type safety fundamentals (unknown vs any, catch typing, Result types)
frontend-error-boundaries - Client-side error boundaries, global handlers, error reporting pipeline, graceful degradation
