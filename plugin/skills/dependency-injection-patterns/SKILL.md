---
name: dependency-injection-patterns
description: Dependency injection best practices - constructor injection, composition root, lifetime management, testability, circular dependency prevention, framework independence
keywords: dependency injection, DI, constructor injection, composition root, service locator, singleton, scoped, transient, lifetime, circular dependency, mock injection, vi.mock, testability, IoC container, tsyringe, NestJS, InversifyJS, framework independence
related: monorepo-architecture, testing-patterns, error-handling-patterns, safe-refactoring, domain-driven-design
---

# Dependency Injection Patterns

Rules for wiring dependencies that are testable, visible, and proportional to codebase size.

**Research:** `docs/deepresearch/reports/Dependency Injection Patterns for TypeScript.md`

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | **Constructor injection only** | `private db = new Database()` inside class | `constructor(private readonly db: Database)` |
| 2 | **No service locators** | `ServiceLocator.get<Database>('database')` | Explicit constructor parameter |
| 3 | **Single composition root** | `new X(new Y(new Z()))` in controllers | All wiring in `main.ts` or `container.ts` |
| 4 | **Explicit lifetimes** | New DB pool per request | Singleton for pools; scoped for request context |
| 5 | **No circular dependencies** | `A -> B -> A` | Extract interface; use layered architecture (domain <- app <- infra) |
| 6 | **DI only at I/O boundaries** | `@Injectable()` on pure utility function | Pure functions stay plain functions |
| 7 | **No framework decorators in domain** | `@Injectable()` in `domain/user.service.ts` | Domain depends on interfaces only; decorators in infra layer |
| 8 | **Mock via constructor, not vi.mock** | `vi.mock('../database')` for unit tests | `new UserService(mockDb, mockEmail)` |
| 9 | **Scale container to codebase** | InversifyJS + reflection for 5 classes | Manual wiring for <15 classes; lightweight container for medium |
| 10 | **Rule of Three for abstractions** | Interface with 1 implementation | Duplicate first; abstract on 3rd occurrence |

## Pattern 1: Constructor Injection

```typescript
// WRONG: Hidden dependency - invisible, untestable
class UserService {
  private db = new Database();
  private email = new EmailService();
}

// WRONG: Service Locator - hides dependencies, no static analysis
class UserService {
  register(user: User) {
    const db = ServiceLocator.get<Database>('database');
  }
}

// CORRECT: Dependencies visible in type signature, trivially mockable
class UserService {
  constructor(
    private readonly db: Database,
    private readonly email: EmailService,
  ) {}

  async register(user: User) { /* ... */ }
}
```

**Why it matters:** Constructor injection makes every dependency visible in the type signature. Callers know exactly what is needed. Tests pass mocks directly without module-level patching.

## Pattern 2: Composition Root

```typescript
// WRONG: Scattered construction in controllers, routes, workers
// routes/users.ts
const svc = new UserService(new UserRepo(new PostgresPool()), new SendGridEmail());

// CORRECT: Single place for all object-graph construction
// composition-root.ts (or main.ts / server.ts)
const pool = createPool(config.database);
const userRepo = new UserRepoImpl(pool);
const emailService = new SendGridEmailService(config.email);
const userService = new UserService(userRepo, emailService);

// Routes receive pre-built services
app.route('/users', createUserRoutes(userService));
```

**Rule:** `new` appears only in the composition root (or inside factories called from it). No `new ServiceX()` in controllers, route handlers, or workers.

## Pattern 3: Scaling the DI Tool

| Codebase Size | Strategy | Example |
|---------------|----------|---------|
| Small (<15 classes) | Manual factories in composition root | Direct `new` wiring in `main.ts` |
| Medium (15-50 classes) | Lightweight container (`tsyringe`, `typed-inject`) | `container.resolve(UserService)` |
| Large (50+ classes) | Full IoC (`NestJS` modules, `InversifyJS`) | `@Module({ providers: [...] })` |

**Rule:** Never introduce reflection-heavy decorators unless the project already has >30 injectable classes and needs request scoping or module boundaries.

## Pattern 4: Lifetime Management

| Lifetime | Use For | Example |
|----------|---------|---------|
| **Singleton** | Shared stateless/pooled resources | DB pool, config, stateless services |
| **Scoped/Request** | Per-request state | Auth context, trace ID, transaction |
| **Transient** | Lightweight stateless helpers | Formatters, validators |

```typescript
// WRONG: New pool per request (connection exhaustion)
app.get('/users', async (c) => {
  const pool = new Pool(config); // LEAK
  const users = await pool.query('SELECT ...');
});

// WRONG: Singleton holding request state (data race)
const requestContext = { userId: '' }; // Shared across all requests!

// CORRECT: Singleton pool, scoped context
const pool = createPool(config); // Created once in composition root

app.get('/users', async (c) => {
  const ctx = { userId: c.get('userId'), traceId: c.get('traceId') }; // Per-request
  const users = await userService.list(pool, ctx);
});
```

**Rule:** Always declare lifetime explicitly. Default to singleton only for truly stateless/shared resources.

## Pattern 5: Testability via Injection

```typescript
// WRONG: Module-level mock couples test to file paths
vi.mock('../database'); // Breaks if path changes; pollutes module cache
const svc = new UserService(); // Still uses real deps unless mocked globally

// CORRECT: Inject mocks exactly as production code expects
const mockDb = { query: vi.fn().mockResolvedValue([]) };
const mockEmail = { send: vi.fn().mockResolvedValue(undefined) };
const svc = new UserService(mockDb, mockEmail);

// Tests are fast, isolated, path-independent
test('register sends welcome email', async () => {
  await svc.register({ name: 'Alice', email: 'a@b.com' });
  expect(mockEmail.send).toHaveBeenCalledWith(
    expect.objectContaining({ to: 'a@b.com' }),
  );
});
```

**When `vi.mock()` is acceptable:** Only for third-party libraries that cannot be injected (e.g., some AWS SDK v3 clients, native Node modules). Never for your own business logic.

## Pattern 6: Circular Dependency Prevention

```typescript
// WRONG: Bidirectional dependency
// user.service.ts
import { OrderService } from './order.service';
// order.service.ts
import { UserService } from './user.service'; // CIRCULAR

// CORRECT: Extract interface, depend on abstraction
// interfaces/user-queries.ts
export interface UserQueries {
  findById(id: string): Promise<User>;
}

// order.service.ts depends on interface (no circular import)
class OrderService {
  constructor(private readonly userQueries: UserQueries) {}
}

// CORRECT ALTERNATIVE: Event-driven decoupling
class UserService {
  constructor(private readonly events: EventEmitter) {}
  async register(user: User) {
    // ... create user ...
    this.events.emit('user:registered', { userId: user.id });
  }
}
```

**Detection:** Run `madge --circular src` in CI. Any cycle is a build-blocking error.

**Resolution strategies (in preference order):**
1. Extract shared interface to inner layer
2. Use event bus / mediator for cross-cutting communication
3. `forwardRef` / `ModuleRef` only as absolute last resort

## Pattern 7: DI Boundaries

```typescript
// WRONG: DI for pure functions (over-engineering)
@Injectable()
class MathUtils {
  add(a: number, b: number) { return a + b; }
}

// CORRECT: Pure functions stay plain - no DI needed
export function calculateTotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

// DI only at I/O boundaries
class OrderService {
  constructor(
    private readonly repo: OrderRepository,    // I/O: database
    private readonly payment: PaymentGateway,   // I/O: external API
    private readonly notifier: NotificationService, // I/O: email/SMS
  ) {}

  async checkout(cart: Cart): Promise<Order> {
    const total = calculateTotal(cart.items); // Pure function, no injection
    // ... use injected services for I/O ...
  }
}
```

**Heuristic:** If it has no I/O, no side effects, and no state, it is a plain function. Never wrap it in a class for DI.

## Pattern 8: Framework Independence

```typescript
// WRONG: Domain logic polluted with framework decorators
// domain/user.service.ts
import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  constructor(@Inject('USER_REPO') private repo: IUserRepo) {}
}

// CORRECT: Domain depends only on interfaces
// domain/user.service.ts
export class UserService {
  constructor(private readonly repo: IUserRepo) {} // Plain interface
}

// Framework wiring lives ONLY in infrastructure layer
// infra/modules/user.module.ts (NestJS-specific)
@Module({
  providers: [
    UserService,
    { provide: 'IUserRepo', useClass: PostgresUserRepo },
  ],
})
export class UserModule {}
```

**Rule:** Core domain code must never import framework DI decorators (`@Injectable`, `@Inject`, `@Singleton`). Business logic stays portable. Framework concerns belong exclusively in the composition root and infrastructure layer.

## Common Anti-Patterns Checklist

Before submitting code, verify:

- [ ] No `new ServiceX()` outside composition root
- [ ] No `ServiceLocator.get()` calls
- [ ] No `vi.mock()` for own business logic (use constructor injection)
- [ ] No `@Injectable()` or `@Inject()` in domain layer code
- [ ] No circular dependencies between services
- [ ] No new DB pool/HTTP client created per request
- [ ] No DI wrapper around pure functions or value objects
- [ ] No InversifyJS/reflection for <15 classes
- [ ] No interface with only 1 implementation (Rule of Three)
- [ ] Lifetime explicitly declared for every injectable service

## See Also

- [[monorepo-architecture]] - Module boundaries, dependency direction, layered architecture
- [[testing-patterns]] - Test isolation, mock patterns, `vi.mock()` vs constructor injection
- [[error-handling-patterns]] - Error handling across service boundaries
- [[domain-driven-design]] - Bounded contexts, aggregates (DI aligns with DDD layers)
- [[safe-refactoring]] - Extracting interfaces, Strangler Fig for migrating to DI
