---
name: state-machine-workflow-patterns
description: State machine discipline, saga compensation, event-sourced persistence, workflow orchestration. Use when state transitions, workflow steps, saga, compensation, event sourcing, or state machine testing.
keywords: state machine, FSM, XState, state transition, saga, compensation, event sourcing, workflow orchestration, choreography, transition guard, append-only, replay, discriminated union, optimistic locking, heartbeat, timeout, model-based testing
related: error-handling-patterns, race-conditions-atomicity, resilience-patterns, async-flow-control, process-lifecycle-patterns, event-driven-messaging-patterns, domain-driven-design
---

# State Machine & Workflow Patterns

Rules for building state machines and multi-step workflows that survive crashes, prevent invalid transitions, and compensate on failure.

**Research:** `docs/deepresearch/reports/State Machine and Workflow Patterns.md`

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | **Explicit machine definition** | Ad-hoc `if (status === 'x')` scattered in controllers | Single machine definition (XState, map, or guard table) |
| 2 | **Reject invalid transitions at state layer** | `pending` -> `completed` bypass (missing intermediate) | Machine only accepts defined transitions |
| 3 | **Discriminated unions for state types** | `{ status?: string; startedAt?: Date; completedAt?: Date }` | `{ status: 'completed'; startedAt: Date; completedAt: Date }` |
| 4 | **Persist transition history** | Single `status` column, no history | `state_transitions` table or event log |
| 5 | **Saga compensation on multi-step** | `chargePayment(); createOrder()` with no rollback | Explicit compensation list, reverse-order execution |
| 6 | **Timeout + heartbeat on every activity** | Workflow step with no timeout -> zombie | `startToCloseTimeout` + `heartbeatTimeout` on activities |
| 7 | **Optimistic lock or single-writer** | Read-modify-write on state without version guard | `WHERE version = $v` or per-entity queue |
| 8 | **Test every transition + every invalid transition** | Only test happy path | Generate tests from machine definition |
| 9 | **Declarative workflows for >5 steps** | Imperative glue code across services | Temporal, Step Functions, or declarative definition |
| 10 | **State metrics per status** | No visibility into stuck workflows | `gauge:workflows_in_state{state="x"}` for monitoring |

## State Transition Validation

```typescript
// WRONG: Ad-hoc status checks scattered across controllers
async function shipOrder(orderId: string) {
  const order = await db.orders.findUnique({ where: { id: orderId } });
  if (order.status === 'completed') throw new Error('Already shipped');
  // No check: pending -> completed bypasses 'processing'
  await db.orders.update({ data: { status: 'completed' } });
}

// CORRECT: Single machine definition, transitions validated centrally
const ORDER_TRANSITIONS: Record<string, Record<string, string>> = {
  pending:    { PROCESS: 'processing' },
  processing: { SHIP: 'completed', CANCEL: 'cancelled' },
  completed:  {},                       // final state
  cancelled:  {},                       // final state
};

function transition(current: string, event: string): string {
  const next = ORDER_TRANSITIONS[current]?.[event];
  if (!next) throw new Error(`Invalid transition: ${current} + ${event}`);
  return next;
}

// Usage: validate BEFORE any DB write
const nextStatus = transition(order.status, 'SHIP');
await db.orders.update({ data: { status: nextStatus, shippedAt: new Date() } });
```

**Rule:** Never scatter `if (status === ...)` checks across multiple files. Define the machine once. All status changes go through it.

## Invalid State Prevention Through Types

```typescript
// WRONG: Bag of optionals - compiles, crashes at runtime
type Order = {
  status?: 'pending' | 'processing' | 'completed';
  startedAt?: Date;
  completedAt?: Date;
};
// order.completedAt accessed when status is 'pending' -> undefined

// CORRECT: Discriminated unions make impossible states unrepresentable
type PendingOrder = { status: 'pending' };
type ProcessingOrder = { status: 'processing'; startedAt: Date };
type CompletedOrder = { status: 'completed'; startedAt: Date; completedAt: Date };
type CancelledOrder = { status: 'cancelled'; cancelledAt: Date; reason: string };

type OrderState = PendingOrder | ProcessingOrder | CompletedOrder | CancelledOrder;

// Compiler enforces: completedAt only accessible when status is 'completed'
function getCompletionTime(order: OrderState): Date | null {
  if (order.status === 'completed') return order.completedAt; // type-safe
  return null;
}
```

**Rule:** Every multi-state entity must use discriminated unions. The compiler must reject access to state-specific fields in wrong states.

## State Persistence & Recovery

```typescript
// WRONG: Single status column, crash loses in-flight work
await db.orders.update({ data: { status: 'processing' } });
// Pod crashes here -> no record of what happened

// CORRECT: Append-only transition log + derived current state
await db.execute(sql`
  INSERT INTO state_transitions (entity_id, entity_type, from_state, to_state, event, metadata, created_at)
  VALUES (${orderId}, 'order', ${currentState}, ${nextState}, ${event}, ${sql.json(meta)}, NOW())
`);
await db.execute(sql`
  UPDATE orders SET status = ${nextState}, updated_at = NOW(), version = version + 1
  WHERE id = ${orderId} AND version = ${currentVersion}
`);

// Recovery: replay transitions to rebuild current state
const transitions = await db.execute(sql`
  SELECT * FROM state_transitions
  WHERE entity_id = ${orderId} AND entity_type = 'order'
  ORDER BY created_at ASC
`);
```

**Schema:**
```sql
CREATE TABLE state_transitions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_id   UUID NOT NULL,
  entity_type TEXT NOT NULL,
  from_state  TEXT NOT NULL,
  to_state    TEXT NOT NULL,
  event       TEXT NOT NULL,
  metadata    JSONB DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_transitions_entity ON state_transitions (entity_id, entity_type, created_at);
```

**Rule:** For any entity that lives longer than a single request, persist every state transition. Current state = derived from transition history. This enables replay, audit, and crash recovery.

## Saga Pattern (Distributed Compensation)

```typescript
// WRONG: Sequential calls with no compensation -> partial failure leaves inconsistent state
await chargePayment(paymentId);
await createOrder(orderId);       // Fails -> money taken, no order
await reserveInventory(itemId);   // Never reached

// CORRECT: Explicit compensations, reverse-order execution on failure
class Saga {
  private compensations: Array<() => Promise<void>> = [];

  addCompensation(fn: () => Promise<void>): void {
    this.compensations.push(fn);
  }

  async compensate(): Promise<void> {
    // Execute compensations in reverse order (LIFO)
    for (const comp of [...this.compensations].reverse()) {
      try {
        await comp();
      } catch (err) {
        logger.error({ err }, 'Compensation failed - manual intervention needed');
        // Log but continue: best-effort compensation
      }
    }
  }
}

// Usage
const saga = new Saga();

const payment = await chargePayment(paymentId);
saga.addCompensation(() => refundPayment(payment.transactionId));

try {
  const order = await createOrder(orderId);
  saga.addCompensation(() => cancelOrder(order.id));

  await reserveInventory(itemId);
  saga.addCompensation(() => releaseInventory(itemId));
} catch (err) {
  await saga.compensate(); // Undo everything in reverse
  throw new Error('Order workflow failed', { cause: err });
}
```

**Rule:** Every multi-service operation must register a compensation for each completed step. On failure, compensations run in reverse order. Log compensation failures but continue (best-effort cleanup).

## Timeouts & Heartbeats

```typescript
// WRONG: No timeout -> zombie workflow step runs forever
await processLargeDataset(datasetId);

// CORRECT: Every activity has timeout + heartbeat
async function processWithTimeout(
  datasetId: string,
  signal?: AbortSignal,
): Promise<void> {
  const timeout = AbortSignal.timeout(5 * 60 * 1000); // 5 min max
  const combined = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);

  for await (const batch of getBatches(datasetId)) {
    combined.throwIfAborted(); // Heartbeat check between batches
    await processBatch(batch);
  }
}

// In workflow orchestrator: track last heartbeat
async function monitorActivity(activityId: string, heartbeatInterval: number) {
  const activity = await getActivity(activityId);
  const elapsed = Date.now() - activity.lastHeartbeat.getTime();
  if (elapsed > heartbeatInterval * 3) {
    logger.warn({ activityId, elapsed }, 'Activity missed heartbeat');
    await timeoutActivity(activityId);
  }
}
```

**Rule:** Every workflow activity must have `startToCloseTimeout` and `heartbeatTimeout`. Activities that process data in loops must check abort/heartbeat between iterations.

## Workflow Orchestration vs Choreography

| Aspect | Orchestration | Choreography |
|--------|--------------|--------------|
| Control flow | Central coordinator | Events between services |
| Visibility | Full workflow state in one place | Scattered across services |
| Debugging | Easy: query orchestrator state | Hard: correlate events across services |
| Coupling | Services depend on orchestrator | Services depend on event contracts |
| Compensation | Natural: orchestrator runs compensations | Hard: who owns rollback? |
| Best for | Workflows >5 steps, need audit/visibility | Loosely coupled, simple fanout |

**Rule:** For workflows that need visibility, audit, or compensation, use orchestration (Temporal, Step Functions, or custom orchestrator). Use choreography only for simple event fanout where partial failure is acceptable.

## State Machine Testing

```typescript
// WRONG: Only test happy path
test('order completes', () => {
  expect(transition('processing', 'SHIP')).toBe('completed');
});

// CORRECT: Test every valid transition AND every invalid transition
describe('order state machine', () => {
  const VALID_TRANSITIONS = [
    ['pending', 'PROCESS', 'processing'],
    ['processing', 'SHIP', 'completed'],
    ['processing', 'CANCEL', 'cancelled'],
  ] as const;

  const INVALID_TRANSITIONS = [
    ['pending', 'SHIP'],       // Can't ship without processing
    ['pending', 'CANCEL'],     // Must process before cancel (if that's the rule)
    ['completed', 'PROCESS'],  // Final states accept nothing
    ['completed', 'SHIP'],
    ['cancelled', 'PROCESS'],
  ] as const;

  test.each(VALID_TRANSITIONS)('%s + %s -> %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  test.each(INVALID_TRANSITIONS)('%s + %s -> throws', (from, event) => {
    expect(() => transition(from, event)).toThrow('Invalid transition');
  });
});
```

**Rule:** When defining a state machine, immediately generate tests covering every valid transition and every invalid transition. Use `test.each` with the transition table. If you add a state, add its valid/invalid transition tests in the same commit.

## Concurrent State Mutation Guard

```typescript
// WRONG: Read-modify-write with no guard -> lost updates
const order = await db.orders.findUnique({ where: { id: orderId } });
order.status = 'completed';
await db.orders.update({ data: { status: order.status } });

// CORRECT: Optimistic locking with version column
const result = await db.execute(sql`
  UPDATE orders
  SET status = ${nextStatus}, version = version + 1, updated_at = NOW()
  WHERE id = ${orderId} AND version = ${expectedVersion}
  RETURNING *
`);
if (result.length === 0) {
  throw new Error('Concurrent modification detected - retry');
}

// CORRECT: Single-writer per entity (queue + dedicated processor)
await redis.xadd(`order:${orderId}:events`, '*', 'event', JSON.stringify({
  type: 'SHIP',
  timestamp: Date.now(),
}));
// Single consumer per stream key ensures serial processing
```

**Rule:** Never do read-modify-write on state without either optimistic locking (`WHERE version = $v`), pessimistic locking (`FOR UPDATE`), or single-writer guarantee (per-entity queue). See [[race-conditions-atomicity]] for DB-level patterns.

## Common Anti-Patterns Checklist

Before submitting workflow/state-machine code, verify:

- [ ] No raw string/enum status without a machine definition
- [ ] No bag-of-optional-properties for multi-state entities (use discriminated unions)
- [ ] No single `status` column without transition history for long-lived entities
- [ ] No multi-service calls without compensation (saga pattern)
- [ ] No workflow activity without timeout + heartbeat
- [ ] No read-modify-write on state without concurrency guard
- [ ] No state machine without tests for every valid AND invalid transition
- [ ] No imperative glue code for workflows >5 steps (use declarative orchestration)
- [ ] No workflow without state metrics/observability

## See Also

[[error-handling-patterns]] - Error classification, discriminated union results, cause chaining
[[race-conditions-atomicity]] - Optimistic locking, SKIP LOCKED, distributed locks, idempotency
[[resilience-patterns]] - Circuit breakers, TaskReaper, auto-healing, multi-layer recovery
[[async-flow-control]] - AbortController cancellation, Promise combinators, graceful shutdown
[[event-driven-messaging-patterns]] - Outbox pattern, consumer idempotency, DLQ
[[domain-driven-design]] - Aggregate boundaries, value objects, domain events
