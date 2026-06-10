---
name: safe-refactoring
description: Safe refactoring patterns - code smell detection thresholds, baby-step refactoring, characterization tests, Expand-Migrate-Contract, Strangler Fig, primitive obsession, value objects
keywords: refactoring, code smell, extract method, extract class, long method, god class, primitive obsession, value object, branded type, parallel change, expand contract, strangler fig, characterization test, feature flag, safe migration
related: monorepo-architecture, tdd-workflow, error-handling-patterns, typescript-type-safety, domain-driven-design
---

# Safe Refactoring Patterns

Rules for detecting code smells and refactoring safely without breaking production. Every refactoring must preserve behavior, be covered by tests, and proceed in small verified steps.

**Research:** `docs/deepresearch/reports/TypeScript Code Smells and Safe Refactoring Patterns.md`

## Non-Negotiable Rules

| # | Rule | Rationale |
|---|------|-----------|
| 1 | **Never refactor >20 LOC without a test covering the behavior** | Untested refactors cause silent regressions |
| 2 | **Baby steps: extract, compile, test, commit** | Each step is independently revertable |
| 3 | **Characterization test first** | Capture existing behavior before changing structure |
| 4 | **Public API changes use Expand-Migrate-Contract** | Prevents downstream breakage |
| 5 | **Feature flags for risky refactors** | Enables instant rollback without deploy |
| 6 | **Method >50 LOC or >3 logical sections -> extract** | God methods attract bugs and prevent reuse |
| 7 | **Class >500 LOC or >10 public methods -> split** | God classes violate SRP; see [[monorepo-architecture]] |
| 8 | **Primitives with domain meaning -> Value Object** | Prevents invalid state and scattered validation |
| 9 | **>3 switch cases on same discriminant in >2 places -> polymorphism** | Eliminates shotgun surgery |
| 10 | **Strangler Fig over Big-Bang rewrite** | Incremental replacement preserves working system |

## Pattern 1: Safe Refactoring Process

### WRONG - Big-bang rewrite

```typescript
// Rewrite 500-line function in one commit, no tests
// -> Weekend outage, impossible to bisect
```

### CORRECT - Baby steps with characterization tests

```typescript
// Step 1: Add characterization test capturing CURRENT behavior
test('processOrder handles coupon + tax + shipping', () => {
  const result = processOrder(sampleDto);
  expect(result.total).toBe(42.99); // snapshot current behavior
  expect(result.items).toHaveLength(3);
});

// Step 2: Extract ONE small pure function
function calculateSubtotal(items: OrderItem[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

// Step 3: Compile + run test suite -> passes? Commit.
// Step 4: Repeat for next extraction
```

**Sequence:** (1) Write characterization test -> (2) Extract small function -> (3) Compile + test -> (4) Commit -> repeat. If >3 extraction steps needed, wrap in feature flag.

### Feature flag for risky refactors

```typescript
const useNewProcessor = config.get('feature.newOrderProcessor');
const processor = useNewProcessor ? newOrderProcessor : legacyProcessor;
```

## Pattern 2: Expand-Migrate-Contract (Parallel Change)

For any change to a public API, DB schema, or shared interface.

### WRONG - Direct breaking change

```typescript
// Before: all callers use this
function sendEmail(to: string, body: string): void { ... }

// After: signature changed, 47 callers break
function sendEmail(params: EmailParams): void { ... }
```

### CORRECT - Three-phase migration

```typescript
// Phase 1: EXPAND - add new alongside old
function sendEmail(to: string, body: string): void { ... }  // @deprecated
function sendEmailV2(params: EmailParams): void { ... }

// Phase 2: MIGRATE - update callers one at a time, each its own commit
// file1.ts: sendEmail(to, body) -> sendEmailV2({ to, body, format: 'html' })
// file2.ts: same...

// Phase 3: CONTRACT - remove old after all callers migrated
// Delete sendEmail, rename sendEmailV2 -> sendEmail
```

**DB schema variant:**
1. EXPAND: Add new column (nullable), dual-write both old and new
2. MIGRATE: Backfill old rows, switch reads to new column
3. CONTRACT: Drop old column after verification period

**Rule:** Never combine expand + contract in one commit. Each phase is a separate PR/commit.

## Pattern 3: Primitive Obsession -> Value Objects

### WRONG - Raw primitives for domain concepts

```typescript
function charge(amount: number, currency: string, userId: string) { ... }
// No validation, easy to swap amount/currency args, no type safety
charge(100, 'user-123', 'USD'); // args swapped silently
```

### CORRECT - Branded types + Value Objects

```typescript
// Branded type for IDs (zero runtime cost)
type UserId = string & { readonly __brand: 'UserId' };
function userId(raw: string): UserId {
  if (!raw.startsWith('usr_')) throw new Error(`Invalid UserId: ${raw}`);
  return raw as UserId;
}

// Value Object for Money (rich behavior)
type Currency = 'USD' | 'EUR' | 'GBP';
class Money {
  constructor(
    public readonly amount: number,
    public readonly currency: Currency,
  ) {
    if (amount < 0) throw new Error('Amount must be non-negative');
  }
  add(other: Money): Money {
    if (this.currency !== other.currency) throw new Error('Currency mismatch');
    return new Money(this.amount + other.amount, this.currency);
  }
}

function charge(money: Money, user: UserId) { ... }
// charge(new Money(100, 'USD'), userId('usr_123')); // type-safe, validated
```

**When to use:**
- IDs: Branded types (zero runtime cost, prevents mixing `UserId` with `OrderId`)
- Money, dates, coordinates: Value Objects (validation + behavior)
- Status/enums: Discriminated unions (compiler-enforced exhaustiveness)

**Smell:** Same validation logic for a primitive repeated in >2 places -> extract Value Object.

## Pattern 4: Switch Statement Explosion -> Strategy

### WRONG - Switch duplicated across codebase

```typescript
// In pricing.ts
switch (user.type) {
  case 'ADMIN': return price * 0.5;
  case 'PREMIUM': return price * 0.7;
  case 'GUEST': return price;
}

// In permissions.ts - SAME switch on user.type
switch (user.type) {
  case 'ADMIN': return ALL_PERMISSIONS;
  case 'PREMIUM': return PREMIUM_PERMISSIONS;
  case 'GUEST': return GUEST_PERMISSIONS;
}
// Adding new user type -> touch EVERY switch (shotgun surgery)
```

### CORRECT - Discriminated union + strategy map

```typescript
type User = { kind: 'admin'; /* ... */ } | { kind: 'premium' } | { kind: 'guest' };

const discountStrategy: Record<User['kind'], (price: number) => number> = {
  admin: (p) => p * 0.5,
  premium: (p) => p * 0.7,
  guest: (p) => p,
};
// Adding new kind -> TS error on incomplete Record -> find all strategies at once
```

**Threshold:** >3 cases OR same switch in >2 places -> extract to strategy map or polymorphism. Single-location switch with <=3 cases is fine.

## Pattern 5: When to Refactor vs Rewrite

### Decision Framework

| Signal | Action |
|--------|--------|
| Clear seams/bounded contexts exist | Strangler Fig (incremental) |
| No tests, no ownership, single god class | Rewrite candidate, but still prefer strangler |
| >6 months to rewrite, <2 years life left | Heavy refactor + strangler |
| Well-tested, team understands code | Refactor in place |

### Strangler Fig Pattern

```typescript
// Step 1: New module handles new requests
app.post('/orders', stranglerMiddleware(legacyHandler, newHandler));

// Step 2: Route increasing traffic to new handler
function stranglerMiddleware(legacy: Handler, next: Handler): Handler {
  return (req, res) => {
    if (shouldUseNew(req)) return next(req, res);
    return legacy(req, res);
  };
}

// Step 3: When 100% traffic on new -> remove legacy
```

**Rule:** Never big-bang rewrite unless the codebase has zero users and zero tests. Even then, prefer incremental. Rewrites fail because nobody understands all edge cases.

## Code Smell Detection Heuristics (for AI agents)

| Smell | Detection Threshold | Action |
|-------|---------------------|--------|
| Long Method | >50 LOC or >3 blank-line-separated sections | Extract Method |
| God Class | >500 LOC or >10 public methods or mixed concerns | Extract Class by concern |
| Duplicated Code | >6 LOC at >80% similarity in 2+ locations | Extract to shared utility |
| Feature Envy | Method uses >2 fields from foreign object, <2 from own | Move Method to envied class |
| Primitive Obsession | Same primitive validated in >2 places | Value Object / branded type |
| Switch Explosion | Same discriminant switched in >2 locations | Strategy map / polymorphism |
| Deep Nesting | >3 levels of if/for/try nesting | Early return / extract helper |
| Long Parameter List | >4 positional params | Options object (see [[monorepo-architecture]]) |

**Important:** These heuristics are triggers for *proposing* a refactor, not auto-applying. Always: (1) confirm with tests, (2) baby-step extraction, (3) compile + verify, (4) commit atomically.

## Common Anti-Patterns Checklist

Before proposing or executing a refactor:

- [ ] Characterization test exists for the behavior being changed
- [ ] Each step is small enough to revert independently
- [ ] Public API changes follow Expand-Migrate-Contract
- [ ] Feature flag wraps risky structural changes
- [ ] No big-bang rewrite without Strangler Fig consideration
- [ ] Primitives with domain meaning replaced with Value Objects (not raw strings/numbers)
- [ ] Switch statements checked for duplication across codebase
- [ ] Extracted functions are pure where possible (easier to test)
- [ ] Commit after each successful extraction step
- [ ] No premature abstraction (Rule of Three from [[monorepo-architecture]])

## See Also

- [[monorepo-architecture]] - God objects, Rule of Three, module boundaries, interface design
- [[tdd-workflow]] - Test-first development that enables safe refactoring
- [[error-handling-patterns]] - Error handling patterns to preserve during refactoring
- [[typescript-type-safety]] - Type safety patterns (branded types, satisfies, unknown)
- [[domain-driven-design]] - Value Objects, aggregates, bounded contexts
