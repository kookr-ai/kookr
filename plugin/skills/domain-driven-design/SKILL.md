---
name: domain-driven-design
description: DDD strategic and tactical patterns - bounded contexts, aggregates, value objects, domain events, ubiquitous language, context mapping, subdomain classification. Use when modeling domain logic, designing aggregates, or deciding where to invest in rich models vs simple CRUD.
keywords: DDD, domain-driven design, bounded context, aggregate, value object, domain event, ubiquitous language, context mapping, anti-corruption layer, subdomain, core domain, entity, consistency boundary, aggregate root, event storming
related: monorepo-architecture, error-handling-patterns, typescript-type-safety, dependency-injection-patterns, state-machine-workflow-patterns
---

# Domain-Driven Design Patterns

Pragmatic DDD for TypeScript monorepos. Invest in rich models where complexity justifies it; keep it simple everywhere else.

**Research:** `docs/deepresearch/reports/DDD Strategic and Tactical Patterns for TypeScript Monorepos.md`

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | **Bounded contexts expose only IDs/DTOs** | `import { Task } from '@pkg/tasks/internal'` | `import { TaskId } from '@pkg/tasks'` via public index |
| 2 | **Same word, different meaning = new context** | Single `Task` class used by workflow engine AND user todo list | Separate `WorkflowTask` and `UserTask` in their own packages |
| 3 | **Aggregate = consistency boundary** | 2000-line `Workflow` with tasks, comments, attachments | Small aggregate: only objects sharing same-transaction invariants |
| 4 | **Domain events raised inside aggregate** | `service.completeTask(); eventDispatcher.dispatch(...)` outside | `task.complete()` calls `this.addDomainEvent(new TaskCompleted(...))` |
| 5 | **Events dispatched after TX commit** | Publish event mid-transaction (rollback = phantom event) | Collect events in aggregate, dispatch after successful DB commit |
| 6 | **Classify subdomains before investing** | Full DDD for auth/notifications/file-upload | Core = rich model; Supporting = simple; Generic = buy/outsource |
| 7 | **Ubiquitous language in code** | Business says "completed", code says `status = 'DONE'` | `task.complete()`, `TaskCompleted` event -- exact domain terms |
| 8 | **Never import internal classes across contexts** | `import { TaskAggregate } from '@pkg/tasks/aggregate'` | ACL, Published Language, or ID-only references |
| 9 | **Value Objects for validated concepts** | `dueDate: string`, `email: string` (primitives everywhere) | `DueDate.create(date)` with validation and behavior |
| 10 | **Only tactical DDD in Core subdomains** | Rich aggregate model for user registration CRUD | Core = heavy investment; everything else = transaction script OK |

## Subdomain Classification

Before writing any domain model, classify the subdomain:

| Question | If Yes | Approach |
|----------|--------|----------|
| Would the business be worthless without this? | Core | Full tactical DDD: aggregates, VOs, events |
| Necessary but not differentiating? | Supporting | Simple entities, transaction script OK |
| Could we replace with off-the-shelf? | Generic | Buy/outsource, thin adapter layer |

```typescript
// Core -- packages/workflows/ (rich model, heavy investment)
// Supporting -- packages/users/ (simple entities, transaction script OK)
// Generic -- use Supabase Auth, Resend, etc. (no custom code)
```

**Rule:** Only invest tactical DDD in Core + select Supporting subdomains. Full DDD on a CRUD admin panel is over-engineering.

## Bounded Contexts

### WRONG - Everything in one domain folder, free imports

```typescript
// src/domain/task.ts
export class Task { ... }

// src/domain/workflow.ts
import { Task } from '../task'; // leaks internal model everywhere
```

### CORRECT - Explicit contexts with public APIs

```typescript
// packages/tasks/src/task.aggregate.ts
export class Task { ... } // internal only

// packages/tasks/src/index.ts
export { TaskService } from './task.service'; // public API
export type { TaskId } from './task-id';       // only ID exposed

// packages/workflows/src/workflow.aggregate.ts
import type { TaskId } from '@myapp/tasks'; // ID reference only
```

**Split when:** Same word has different meanings, invariants, or lifecycles across contexts. "Task" in the workflow engine vs "Task" in the user-facing todo list = two bounded contexts.

## Aggregates

An aggregate is a **consistency boundary** -- the set of objects that must be consistent within one transaction.

### WRONG - Huge aggregate with everything

```typescript
class Workflow {
  tasks: Task[];        // maybe hundreds
  comments: Comment[];  // different lifecycle
  attachments: Attachment[]; // separate concern
  // 2000-line class
}
```

### CORRECT - Small, invariant-focused aggregate

```typescript
export class Workflow extends AggregateRoot {
  private steps: WorkflowStep[] = [];

  addStep(step: WorkflowStep) {
    this.steps.push(step);
    this.addDomainEvent(new StepAddedToWorkflow(this.id, step.id));
  }

  completeStep(stepId: StepId) {
    const step = this.steps.find(s => s.id.equals(stepId));
    if (!step) throw new StepNotFoundError(stepId);
    step.complete();
    if (this.steps.every(s => s.isComplete())) {
      this.addDomainEvent(new WorkflowCompleted(this.id));
    }
  }
}
```

**Design question:** "Which invariants must hold in the same transaction?" Only those objects belong inside. Everything else = separate aggregate referenced by ID.

**Smells:** Lock contention in Postgres; aggregate >500 LOC; loading the aggregate is slow (too many child entities).

## Value Objects

Use when a concept has validation, equality-by-value, or domain behavior.

### WRONG - Primitives everywhere

```typescript
task.dueDate = '2025-12-31'; // string -- no validation
task.assignee = 'user-123';  // string -- no type safety
```

### CORRECT - Immutable, behavior-rich Value Objects

```typescript
export class DueDate {
  private constructor(private readonly date: Date) {}

  static create(date: Date): DueDate {
    if (date < new Date()) throw new InvalidDueDateError('Due date cannot be in the past');
    return new DueDate(date);
  }

  isOverdue(): boolean { return this.date < new Date(); }
  equals(other: DueDate): boolean { return this.date.getTime() === other.date.getTime(); }
}
```

**When to use VOs:** Validation rules exist (email format, date range), equality is by value not identity, or domain behavior attaches to the concept (isOverdue, Money.add).

**When NOT to use:** Simple IDs with no validation or behavior -- a branded type or opaque string is enough.

## Domain Events

### WRONG - Service publishes events directly

```typescript
class TaskService {
  completeTask(taskId: string) {
    const task = this.repo.findById(taskId);
    task.status = 'completed';
    this.repo.save(task);
    this.eventDispatcher.dispatch(new TaskCompleted(taskId)); // outside aggregate
  }
}
```

### CORRECT - Events raised inside aggregate, dispatched after TX

```typescript
class Task extends AggregateRoot {
  complete(by: UserId) {
    if (this.status !== TaskStatus.InProgress) {
      throw new InvalidStateTransitionError(this.status, TaskStatus.Completed);
    }
    this.status = TaskStatus.Completed;
    this.addDomainEvent(new TaskCompleted(this.id, by));
  }
}

// Application service -- dispatch after DB commit
async completeTask(taskId: TaskId, userId: UserId): Promise<void> {
  const task = await this.repo.findById(taskId);
  task.complete(userId);
  await this.repo.save(task);
  await this.eventDispatcher.dispatchEventsFor(task); // after TX success
}
```

**Rule:** Domain events = significant business facts. Raised inside aggregates. Published after successful DB transaction. Never publish mid-transaction (rollback = phantom events).

## Context Mapping (Cross-Context Integration)

### Anti-Corruption Layer (ACL) - Most common

```typescript
// packages/workflows/src/acl/task-translator.ts
export class TaskTranslator {
  toWorkflowTask(externalTask: ExternalTaskDto): WorkflowTask {
    return new WorkflowTask(
      TaskId.from(externalTask.id),
      new TaskTitle(externalTask.title),
    );
  }
}
```

### Integration Strategy Decision

| Strategy | When to Use |
|----------|------------|
| **Anti-Corruption Layer** | External/legacy systems; models don't align |
| **Published Language** | Stable API contracts; shared types package |
| **Shared Kernel** | Two teams co-located; coordinated releases |
| **ID-only references** | Default for internal context boundaries |

**Rule:** Never let one bounded context depend on the internal model of another. Always translate via ACL, Published Language, or ID-only references.

## DDD Applicability Decision Matrix

| Complexity / Change Frequency | Use Full Tactical DDD? | Approach |
|-------------------------------|----------------------|----------|
| Simple CRUD, stable | No | Transaction Script / Active Record |
| Rich invariants, frequent change | Yes | Aggregates + VOs + Events |
| Core subdomain | Yes | Heavy investment |
| Generic/Support | No | Off-the-shelf or thin layer |

**Before generating any DDD code, ask:** "Is this part of the Core subdomain and does it have non-trivial business rules or invariants?" If not, keep it procedural/simple.

## Common Anti-Patterns Checklist

Before submitting domain modeling code, verify:

- [ ] No internal class imports across bounded contexts (only IDs/DTOs)
- [ ] No aggregate >500 LOC or spanning unrelated invariants
- [ ] No domain events published outside aggregates or mid-transaction
- [ ] No full tactical DDD on Generic/Supporting CRUD subdomains
- [ ] No primitives for concepts with validation/behavior (use Value Objects)
- [ ] No code terms that differ from business ubiquitous language
- [ ] No direct dependency between bounded context internals (use ACL)
- [ ] Subdomain classified (Core/Supporting/Generic) before modeling

## See Also

- [[monorepo-architecture]] - Module boundaries, dependency direction, god objects, abstraction discipline
- [[error-handling-patterns]] - Domain error handling with discriminated unions
- [[typescript-type-safety]] - Type safety for domain models (branded types, satisfies)
