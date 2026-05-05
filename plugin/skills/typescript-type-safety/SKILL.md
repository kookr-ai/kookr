---
name: typescript-type-safety
description: TypeScript type safety patterns - unknown vs any, generics golden rule, null narrowing, inference discipline, import type, discriminated unions, error typing. Use when writing or reviewing TypeScript code for type correctness.
keywords: type safety, unknown, any, type guard, satisfies, generics, constraint, null handling, strictNullChecks, optional chaining, type inference, annotation, import type, export type, named export, barrel file, discriminated union, exhaustive switch, never, Result type, error typing, instanceof, catch unknown
related: error-handling-patterns, monorepo-architecture, testing-patterns, api-route-patterns, schema-contract-patterns
---

# TypeScript Type Safety Patterns

Rules for writing type-safe TypeScript that catches bugs at compile time, not production.

**Research:** `docs/deepresearch/reports/TypeScript Type Safety Patterns.md`

## Non-Negotiable Rules

| # | Rule | Violation | Correct Pattern |
|---|------|-----------|-----------------|
| 1 | **Never `any`** | `let data: any = fetch()` | `let data: unknown = fetch()` + type guard |
| 2 | **`satisfies` over `as`** | `obj as Config` | `obj satisfies Config` (preserves literals) |
| 3 | **Generics Golden Rule** | Generic param appears once in signature | Generic param appears >= 2 times (relates values) |
| 4 | **`strictNullChecks` always on** | `user!.name` (non-null assertion) | `if (!user) return; user.name` (early return) |
| 5 | **Annotate contracts, infer locals** | `const x: number = 42` | `const x = 42` (inferred) |
| 6 | **`import type` for types** | `import { User } from './types'` | `import type { User } from './types'` |
| 7 | **Named exports only** | `export default MyClass` | `export function myFn()` / `export class MyClass` |
| 8 | **Discriminated unions over optionals** | `{ name?: string; role?: string }` | `{ kind: 'admin'; name: string } \| { kind: 'user' }` |
| 9 | **Exhaustive switch with `never`** | Switch without default handler | `default: const _: never = x` (compiler error on missing case) |
| 10 | **`catch` is `unknown`, not `any`** | `catch (e: any) { e.message }` | `catch (e) { if (e instanceof Error) ... }` |

## Pattern 1: Type Safety (unknown + Narrowing)

### WRONG - `any` defeats the type system

```typescript
let data: any = fetchData();
data.name;  // no error, crashes at runtime if wrong shape

const id = someValue as string;  // silences compiler, no runtime check
// @ts-ignore
dangerousCall();  // hides real error
```

### CORRECT - `unknown` forces narrowing

```typescript
function isString(x: unknown): x is string {
  return typeof x === 'string';
}

let data: unknown = fetchData();
if (isString(data)) {
  data.toUpperCase();  // safe, narrowed to string
}

const config = {
  apiUrl: 'https://...',
  timeout: 5000,
} satisfies Config;  // validates shape + preserves literal types
```

**When `as` is acceptable (exhaustive list):**
- DOM APIs: `document.getElementById('x') as HTMLInputElement`
- Untyped third-party JS (temporary bridge, add TODO)
- After Zod/schema validation that TS cannot model
- `as const` for literal tuples/objects
- Test mocks with explanatory comment (`// biome-ignore` + reason)
- Nothing else. All other `as` usage is an anti-pattern.

## Pattern 2: Generics (The Golden Rule)

### WRONG - Generic appears only once (no relationship expressed)

```typescript
function identity(arg: any): any { ... }  // no inference at all
function getFirst<T>(arr: T[]): T { ... }  // no constraint
```

### CORRECT - Generic relates multiple values

```typescript
function identity<T>(arg: T): T { ... }  // input type = output type
function merge<T extends object, U extends object>(a: T, b: U): T & U { ... }

// Constraint + default
function createArray<T = string>(len: number, value: T): T[] { ... }
```

**Golden Rule:** A generic type parameter must appear at least twice in the signature. It exists to relate the type of one value to another. If it appears once, you don't need a generic.

**Use constraints (`extends`)** to restrict what callers can pass. Use defaults for convenience.

## Pattern 3: Null Handling

### WRONG - Non-null assertion or excessive optional chaining

```typescript
const name = user!.name;  // runtime bomb if user is null
const value = obj?.prop?.deep?.thing;  // hides structural bugs
```

### CORRECT - Early returns + ?? coalescing

```typescript
function process(user: User | null) {
  if (!user) return;          // early return narrows
  const name = user.name;    // guaranteed string

  return user.profile?.bio ?? 'No bio';  // optional chain + fallback
}
```

**Rules:**
- Enable `strictNullChecks` (part of `strict` in tsconfig)
- Treat `null` and `undefined` as distinct types
- Prefer early returns over nested `if` blocks
- Use `??` (nullish coalescing) not `||` (falsy coalescing) for defaults
- `!` only with a comment explaining why it's safe (extremely rare)

## Pattern 4: Type Inference vs Annotation

### WRONG - Over-annotating or under-annotating

```typescript
const user: User = { ... };  // noisy, inference would get this right
let x = 42;  // fine for locals, but not for public APIs
```

### CORRECT - Annotate contracts, infer internals

```typescript
// PUBLIC API: always annotate return type (contract)
export function fetchUser(id: string): Promise<User> { ... }

// INTERNAL: let inference handle it
const user = await fetchUser(id);  // inferred as User
const config = { timeout: 5000 } satisfies Config;
```

**Where to annotate explicitly:**
- Function signatures (params + return) on exported functions
- Exported constants and variables
- Interface/type definitions (obviously)
- Where inference would widen too much (`satisfies` to preserve)

**Where inference is sufficient:**
- Local variables, loop counters, conditionals
- Callback parameters (contextually typed)
- Internal function return types (compiler already checks)

## Pattern 5: Module & Export Patterns

### WRONG - Barrel files and default exports

```typescript
// index.ts (barrel of death)
export * from './a';
export * from './b';  // circular imports, no tree-shaking

export default MyClass;  // rename confusion across codebase
```

### CORRECT - Named exports + import type

```typescript
// utils.ts
export function helper() { ... }     // named export
export type { HelperOptions };        // type-only (erased at runtime)

// consumer.ts
import type { HelperOptions } from './utils';  // zero bundle impact
import { helper } from './utils';
```

**`export type` vs `export`:** `export type` emits nothing to JS. Zero bundle impact, perfect tree-shaking. Regular `export` on a type may still emit if not distinguished. Always use `import type` / `export type` for type-only imports.

**See also:** [[monorepo-architecture]] rule #4 (no barrel files).

## Pattern 6: Discriminated Unions

### WRONG - Bag of optionals or enum

```typescript
type User = { name?: string; role?: 'admin' | 'user'; };  // every prop optional
enum Status { Success, Error }  // runtime object, string enums misused
```

### CORRECT - Literal discriminant + never exhaustion

```typescript
type Success = { kind: 'success'; data: string };
type Failure = { kind: 'error'; message: string };
type Result = Success | Failure;

function handle(r: Result) {
  switch (r.kind) {
    case 'success': return r.data;
    case 'error': return r.message;
    default: const _exhaustive: never = r;  // compiler error if missing case
  }
}
```

**Decision:** Use discriminated unions for data modeling (API responses, state machines, variants). Use classes/inheritance only when you need shared behavior + methods + polymorphism. Unions win for most modern TS.

**Prefer string literal unions** (`'success' | 'error'`) over enums. No runtime footprint, better tree-shaking.

## Pattern 7: Error Typing in Catch Blocks

### WRONG - `catch (e: any)` or broken prototype chain

```typescript
try { ... } catch (e: any) { e.message; }  // no safety

class MyError extends Error {}  // instanceof broken in some transpilation
```

### CORRECT - `unknown` catch + prototype fix

```typescript
class DomainError extends Error {
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, DomainError.prototype);  // fix prototype chain
  }
}

type Result<T, E extends Error = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

try {
  const result = await riskyOperation();
  if (!result.ok) throw result.error;
} catch (err) {
  if (err instanceof DomainError) { /* typed narrowing */ }
}
```

**See also:** [[error-handling-patterns]] for retry discipline, cause chaining, and Result patterns.

## Common Anti-Patterns Checklist

Before submitting code, verify:

- [ ] No `any` usage (use `unknown` + narrowing)
- [ ] No `as` type assertions except the 5 permitted cases (DOM, untyped lib, post-schema, as const, test mock)
- [ ] No `// @ts-ignore` or `// @ts-expect-error` without a paired issue/TODO
- [ ] No `!` non-null assertion without explanatory comment
- [ ] No generic params that appear only once in the signature
- [ ] No `||` where `??` should be used for null/undefined defaults
- [ ] No `import { Type }` where `import type { Type }` suffices
- [ ] No `export default` (use named exports)
- [ ] No `export *` barrels
- [ ] No bag-of-optionals where a discriminated union is appropriate
- [ ] No `catch (e: any)` (use `unknown` + instanceof narrowing)
- [ ] No `enum` where string literal unions suffice

## See Also

- [[error-handling-patterns]] - Error handling, cause chaining, Result types, retry discipline
- [[monorepo-architecture]] - Module boundaries, barrel files, dependency direction
- [[api-route-patterns]] - Route-level type safety and Zod schema patterns
- [[testing-patterns]] - Type-safe mocking and assertion patterns
