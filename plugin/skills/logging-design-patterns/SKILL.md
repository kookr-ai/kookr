---
name: logging-design-patterns
description: Structured logging best practices - Pino JSON output, log levels, correlation IDs, PII redaction, sampling, async context, canonical log lines
keywords: logging, pino, structured logging, log levels, correlation ID, trace context, redaction, PII, sampling, canonical log lines, AsyncLocalStorage, metrics, observability
related: error-handling-patterns
---

# Logging Design Patterns

Rules for structured, secure, and cost-effective logging in production Node.js/TypeScript services.

**Research:** `docs/deepresearch/reports/Logging Design Best Practices.md`

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | **Structured JSON, never printf** | `` console.log(`User ${id} failed`) `` | `logger.info({ user_id: id, event: 'login_failed' })` |
| 2 | **snake_case log fields** | `{ userId, requestId }` | `{ user_id, request_id }` (OTel/Datadog convention) |
| 3 | **Strict log level semantics** | `logger.info('DB pool exhausted')` | `logger.warn({ pool_usage: 95 }, 'High DB pool usage')` |
| 4 | **Correlation ID on every log** | Log lines with no trace context | Include `trace_id` and `span_id` from OTel span |
| 5 | **Never log PII or secrets** | `logger.info({ body: req.body })` | Use `pino-redact` with explicit allowlist paths |
| 6 | **No console.log in production** | `console.log(data)` | `logger.info({ ... }, 'message')` |
| 7 | **Logs for events, metrics for aggregates** | `` logger.info(`took ${ms}ms`) `` | Emit histogram metric + log the discrete event |
| 8 | **AsyncLocalStorage for context** | Manually passing request_id through call chain | `als.run({ request_id }, () => next())` |
| 9 | **Never log 100% at high QPS** | Logging every request at INFO in hot paths | Tail-based sampling (errors + slow requests always) |
| 10 | **Canonical log line per request** | Multiple fragmented log lines per request | One dense structured line with all telemetry |

## Log Level Semantics

| Level | Meaning | Example | Alert? |
|-------|---------|---------|--------|
| **FATAL** | Process cannot continue | Unhandled rejection, OOM | Page on-call immediately |
| **ERROR** | Human must act NOW | DB connection failed, payment error | Page on-call |
| **WARN** | Degraded but functional | Pool at 95%, retry succeeded after 2 attempts | Alert (no page) |
| **INFO** | Notable business event | Order created, user logged in, workflow started | No alert |
| **DEBUG** | Diagnostic (dev/staging only) | SQL queries, cache hits, internal state | Never in prod |
| **TRACE** | Verbose debugging | Function entry/exit, variable values | Never in prod |

```typescript
// WRONG: Business errors at wrong level
logger.info('Login failed');           // Should be ERROR
logger.warn('DB connection exhausted'); // Should be ERROR
logger.debug(sql);                     // Never in production

// CORRECT: Strict level semantics
logger.error({ err, user_id }, 'Login failed');           // ERROR = page on-call
logger.warn({ pool_usage: 95 }, 'High DB pool usage');    // WARN = alert, no page
logger.info({ user_id, order_id }, 'Order created');      // INFO = business event
```

**Dynamic level adjustment:** Set level from env (`NODE_ENV === 'production' ? 'info' : 'debug'`). Consider feature flags or a LogLevel header for per-request debug in production.

## Structured Logging with Pino

```typescript
// WRONG: Free-text, unparseable
console.log(`User ${userId} failed login at ${new Date().toISOString()}`);

// CORRECT: Structured JSON with consistent schema
import pino from 'pino';
const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: { paths: ['password', 'token', '*.cardNumber'], censor: '[REDACTED]' }
});

logger.info({
  event: 'login_failed',
  user_id: userId,
  ip: req.ip,
  duration_ms: Date.now() - start,
  error_code: 'INVALID_PASSWORD'
});
```

**Canonical log line pattern:** Emit one dense structured line per request containing all key telemetry (duration, status, DB calls, error info). This makes grep/aggregation straightforward.

```typescript
// One canonical line per request (inspired by Stripe)
logger.info({
  event: 'request_completed',
  request_id: req.id,
  duration_ms: Date.now() - start,
  http_method: req.method,
  http_path: req.path,
  http_status: res.statusCode,
  db_calls: metrics.dbCalls,
  db_duration_ms: metrics.dbDuration,
  user_id: req.user?.id
});
```

## Correlation IDs and Tracing

```typescript
// WRONG: No trace context, logs are isolated
logger.info('Processing payment');

// CORRECT: W3C Trace Context propagated, attached to every log
import { trace } from '@opentelemetry/api';

function getTraceContext() {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

logger.info({
  ...getTraceContext(),
  event: 'payment_processing',
  order_id: orderId
});
```

**Propagation:** Use W3C Trace Context (`traceparent` + `tracestate` headers) for interoperability with Datadog, Jaeger, Zipkin, and other ecosystem tools.

## Sensitive Data Redaction

```typescript
// WRONG: Logs raw request bodies, SQL with params, tokens
logger.info({ body: req.body, sql: queryWithParams });

// CORRECT: Pino redact with explicit paths
const logger = pino({
  redact: {
    paths: [
      'req.body.password',
      'req.body.cardNumber',
      '*.token',
      '*.secret',
      'db.query'
    ],
    censor: '[REDACTED]'
  }
});
```

**Rules:**
- Use allowlist approach (log only known-safe fields) over denylist
- Never log raw `req.body` -- extract and log specific safe fields
- Never log SQL statements with interpolated parameters
- Never log authorization headers or bearer tokens
- Test redaction: write unit tests that verify sensitive fields are censored

## Async Context Preservation

```typescript
// WRONG: Manually threading request_id through every function call
function processOrder(orderId: string, requestId: string) { ... }

// CORRECT: AsyncLocalStorage automatically propagates context
import { AsyncLocalStorage } from 'async_hooks';

interface RequestContext {
  request_id: string;
  user_id?: string;
}

const als = new AsyncLocalStorage<RequestContext>();

// Middleware: set context at ingress
function contextMiddleware(req: Request, res: Response, next: () => void) {
  als.run({ request_id: req.id, user_id: req.user?.id }, () => next());
}

// Logger helper: auto-attach context to every log
function log(level: string, data: Record<string, unknown>, msg: string) {
  const ctx = als.getStore();
  logger[level]({ ...ctx, ...data }, msg);
}
```

**Performance:** ~5-10% throughput overhead in heavy async workloads (Node v20+). Acceptable trade-off for universal context propagation.

**Framework wrappers:** NestJS uses `nestjs-cls`, Fastify uses `@fastify/request-context`. Prefer the framework wrapper over raw ALS.

## Log Sampling at Scale

```typescript
// WRONG: Log every request at INFO in a 10K QPS service
app.use((req, res, next) => {
  logger.info({ method: req.method, path: req.path }, 'Request received');
  next();
});

// CORRECT: Tail-based sampling -- always log errors and slow requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration_ms = Date.now() - start;
    const isError = res.statusCode >= 500;
    const isSlow = duration_ms > 1000;

    // Always log errors and slow requests; sample success paths
    if (isError || isSlow || Math.random() < 0.01) {
      logger.info({
        http_method: req.method,
        http_path: req.path,
        http_status: res.statusCode,
        duration_ms,
        sampled: !(isError || isSlow)
      });
    }
  });
  next();
});
```

**Sampling strategies:**
- **Head-based (probabilistic):** Sample N% of all requests randomly
- **Tail-based:** Always capture errors + latency outliers, sample success paths
- **Adaptive:** Adjust sample rate based on traffic volume (Uber/Jaeger approach)

**Rule:** Errors and slow requests (tail) are ALWAYS logged at full fidelity. Only sample success paths.

## Logging vs Metrics vs Traces

| Signal | Use For | Tool | Example |
|--------|---------|------|---------|
| **Logs** | Discrete events, debugging | Pino/Loki | "Order created", "Payment failed" |
| **Metrics** | Aggregates, SLOs, alerting | Prometheus | p95 latency, error rate, QPS |
| **Traces** | Distributed request flow | OTel/Jaeger | Request path across 5 services |

```typescript
// WRONG: Trying to compute p95 from log text
logger.info(`Request took ${duration}ms`);

// CORRECT: Log the event, emit the metric separately
logger.info({ order_id, duration_ms }, 'Order created');
httpRequestDuration.observe({ method, path, status }, duration_ms / 1000);
```

**Rule:** Never duplicate data across signals. Log the event once, emit the histogram metric separately, let the trace connect them via trace_id.

## Common Anti-Patterns Checklist

Before submitting code, verify:

- [ ] No `console.log` / `console.error` in production code paths
- [ ] No camelCase log field names (use snake_case)
- [ ] No business errors logged at INFO (should be ERROR)
- [ ] No log lines missing trace_id/request_id context
- [ ] No raw `req.body` or tokens in log output
- [ ] No `logger.debug()` calls without environment-gated level
- [ ] No latency/rate data only in logs (emit Prometheus metrics)
- [ ] No manual request_id threading (use AsyncLocalStorage)
- [ ] No logging 100% of traffic in hot paths without sampling
- [ ] No multiple fragmented lines per request (use canonical log line)

## See Also

[[error-handling-patterns]] - Structured error logging rules (Rule #6), PII avoidance
observability-platform - Internal ObservabilityHub, CorrelationEngine, health scoring
systematic-debugging - Using logs and traces for debugging distributed systems
resilience-patterns - Circuit breakers, retry patterns that generate log events
api-route-patterns - Request/response logging middleware patterns
