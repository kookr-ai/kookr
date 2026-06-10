---
name: monorepo-architecture
description: TypeScript module-boundary and layering discipline - dependency direction, god objects, abstraction discipline, configuration management, interface design - for single-package codebases and monorepos alike. Use when refactoring module boundaries, reviewing architecture, or creating packages.
keywords: monorepo, module boundaries, circular dependency, barrel file, god object, feature envy, abstraction, Rule of Three, composition over inheritance, configuration, dependency management, workspace protocol, interface design, options object, Clean Architecture, SOLID
related: error-handling-patterns, typescript-type-safety, domain-driven-design, safe-refactoring, dependency-injection-patterns
---

# Module Boundary & Monorepo Architecture Patterns

Production-grade rules for TypeScript module boundaries, class design, abstraction discipline, config management, dependency hygiene, and interface design.

**Scope note:** most rules below are layering discipline that applies to any TypeScript codebase — Kookr itself is a **single package** whose layers are directories — `src/adapters` and `src/server` depend on `src/core`, never the reverse — and rules 1, 3–9 apply to it directly with `src/<layer>` standing in for `packages/<name>`. Rules 2 and 10 (package public APIs, `workspace:*`) are **monorepo-only**; apply them when the codebase actually has multiple workspace packages.

Reference: `docs/deepresearch/reports/TypeScript Monorepo Architecture Patterns.md`

## Non-Negotiable Rules

| # | Rule | Rationale |
|---|------|-----------|
| 1 | Dependencies point inward only (infra -> application -> domain) | Prevents circular deps; enables independent deployment |
| 2 | *(monorepo-only)* Public API = package `index.ts` only; no deep imports (`@pkg/foo/internal/bar`) | Encapsulation; safe refactoring |
| 3 | No circular dependencies between packages | Use `madge --circular` or `depcruise` to detect |
| 4 | No barrel files with `export *` (the "barrel of death") | Defeats tree-shaking; hides coupling |
| 5 | Classes <= 500 LOC, <= 20 public methods | God object = split by SRP |
| 6 | Rule of Three: abstract on 3rd identical occurrence, not before | Wrong abstraction is 5-10x costlier than duplication |
| 7 | One validated config object per app; parse at startup, never at import time | Fail fast; typed; single source of truth |
| 8 | `process.env` in <= 1 file per package (config module) | Scattered env reads = untraceable config |
| 9 | Functions with >4 params -> options object | Readable callsites; easy extension |
| 10 | *(monorepo-only)* Internal packages use `workspace:*`; external deps only if >200 LOC to implement | Controls dependency surface |

## Pattern 1: Module Boundaries

### WRONG - UI depends on core, circular imports, barrel of death

```typescript
// packages/ui/Button.tsx
import { apiClient } from '@myapp/core';   // UI -> core (wrong direction)
import { User } from '@myapp/domain';      // leaks domain into UI

// packages/core/api.ts
import { Button } from '@myapp/ui';        // circular!

// packages/shared/index.ts
export * from './utils';   // barrel of death - re-exports everything
export * from './types';
export * from './constants';
```

### CORRECT - Layered architecture with dependency inversion

```typescript
// packages/domain/user.ts (public interface - innermost layer)
export interface UserRepository {
  findById(id: string): Promise<User>;
}

// packages/infra/user-repo-impl.ts (concrete, depends only on domain)
import type { UserRepository } from '@myapp/domain';
export class PostgresUserRepo implements UserRepository { ... }

// packages/ui/Button.tsx (depends only on application layer abstractions)
import { useUser } from '@myapp/application';
```

**Ownership rule**: A package belongs where its abstraction lives. Concrete implementations go in the outer layer.

**Smells**: >5 cross-package imports in one file; any `export *` barrel.

## Pattern 2: God Objects & Feature Envy

### WRONG - One class doing everything

```typescript
class UserService {  // ~800 LOC, 6 different concerns
  getUser(id: string) { ... }
  saveUser(user: User) { ... }
  sendWelcomeEmail(user: User) { ... }        // EmailService's job
  calculateLifetimeValue(user: User) { ... }  // Billing's job
  formatUserForUI(user: User) { ... }         // UI layer's job
}
```

### CORRECT - Single Responsibility, Tell-Don't-Ask

```typescript
// application/user-service.ts (only registration concern)
export class UserService {
  constructor(
    private repo: UserRepository,
    private email: EmailService,
  ) {}
  async register(userData: CreateUserDto) { ... }
}

// Separate services own separate concerns
await emailService.sendWelcome(newUser);
await billingService.recordLifetimeValue(newUser);
```

**Feature Envy test**: Does the method use >50% of data/methods from another object? Move it there.

**Refactoring sequence**: (1) Identify envied methods -> Move Method, (2) Extract Class for clusters, (3) Introduce facade for callers during migration.

## Pattern 3: Abstraction Discipline (Rule of Three)

### WRONG - Premature abstraction

```typescript
// Only 2 implementations -> forced hierarchy
abstract class BasePaymentProcessor {
  protected abstract validate(...): void;
  protected abstract charge(...): void;
}
class StripeProcessor extends BasePaymentProcessor { ... }
class PaypalProcessor extends BasePaymentProcessor { ... }
// New requirement breaks hierarchy -> boolean flags everywhere
```

### CORRECT - Duplicate first, abstract on third occurrence

```typescript
// 1st and 2nd use: just duplicate the function
const formatCurrency = (amount: number, locale: string) => ...;

// 3rd identical use: NOW extract a module with a domain name
export const money = {
  format: (amount: number, locale = 'en-US') => ...,
  parse: (raw: string) => ...,
};
```

**Decision framework**:
- Can't name the abstraction with a clear domain term? -> Duplicate.
- Business concept used in >=3 places with same variation points? -> Abstract.
- Uncertain? -> Duplicate. Wrong abstraction costs 5-10x more.

**Smells**: Boolean params that change behavior (`process(..., isRecurring: boolean)`); inheritance depth >2; abstract classes with <=2 concrete subclasses.

## Pattern 4: Configuration Management

### WRONG - Scattered process.env reads

```typescript
// 15 different files, each reading env directly
const apiUrl = process.env.API_URL ?? 'https://default.com';
const dbUrl = process.env.DATABASE_URL!;  // no validation, ! assertion
```

### CORRECT - Single validated config at startup

```typescript
// packages/config/src/schema.ts
import { z } from 'zod';

export const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_URL: z.string().url(),
  STRIPE_SECRET: z.string().min(1),
});

export type Config = z.infer<typeof configSchema>;

// packages/config/src/index.ts
const raw = { ...process.env, ...loadEnvFile() };
export const config = configSchema.parse(raw); // fails fast at startup
```

**Already enforced in AegisCore**: See `config.ts` pattern in CLAUDE.md rule #3. This pattern reinforces *why*: fail-fast at startup, not at runtime when a missing var is first accessed.

## Pattern 5: Dependency Management

### WRONG - Uncontrolled dependencies

```json
{
  "dependencies": {
    "lodash": "^4.17.21",     // 300KB for one function
    "moment": "^2.30.1",      // deprecated, use date-fns
    "left-pad": "^1.3.0"      // 5 lines to implement
  }
}
```

### CORRECT - Minimal, workspace-aware

```json
{
  "dependencies": {
    "@aegis/domain": "workspace:*",
    "@aegis/config": "workspace:*",
    "zod": "^3.23.8",
    "date-fns": "^3.6.0"
  }
}
```

**Add a dependency only if**: (1) battle-tested and solves real pain, OR (2) implementing yourself would exceed ~200 LOC + ongoing maintenance.

**Smells**: >30 direct deps per package; duplicate transitive deps (`bun pm ls` shows duplicates); version drift across packages for same library.

## Pattern 6: Interface Design

### WRONG - Long parameter lists

```typescript
function processPayment(
  amount: number,
  userId: string,
  currency: string,
  isRecurring: boolean,
  discountCode?: string,
  metadata?: Record<string, any>,
  onSuccess?: () => void,
) { ... }
```

### CORRECT - Options object for 4+ params

```typescript
interface ProcessPaymentOptions {
  amount: number;
  userId: string;
  currency?: string;          // sensible default
  isRecurring?: boolean;
  discountCode?: string;
  metadata?: Record<string, unknown>;  // unknown > any
  onSuccess?: () => void;
}

function processPayment(options: ProcessPaymentOptions) { ... }
```

**Threshold**: <=3-4 positional params is fine. >4 -> options object. Builder pattern only for step-wise validation with many optional fields (rare in TS).

**Smells**: >5 parameters; multiple boolean flags; inconsistent naming across codebase (`getUser` vs `fetchUserData`).

## Common Anti-Patterns Checklist

Before submitting code, verify:

- [ ] No circular dependencies between packages (run `madge --circular` mentally)
- [ ] No deep imports past a package's `index.ts`
- [ ] No `export *` barrels
- [ ] No class >500 LOC or >20 public methods
- [ ] No premature abstractions (Rule of Three satisfied?)
- [ ] No `process.env` reads outside config module
- [ ] No functions with >4 positional parameters
- [ ] Internal packages use `workspace:*`
- [ ] Dependencies point inward (infra -> app -> domain)
- [ ] New dependency justified (>200 LOC to implement?)

## See Also

- [[error-handling-patterns]] - Error handling within and across package boundaries
- [[typescript-type-safety]] - Type safety fundamentals (unknown vs any, import type, satisfies, generics)
- [[domain-driven-design]] - DDD strategic/tactical patterns (bounded contexts, aggregates, domain events)
- [[safe-refactoring]] - Safe refactoring process (characterization tests, baby steps, Expand-Migrate-Contract, Strangler Fig)
