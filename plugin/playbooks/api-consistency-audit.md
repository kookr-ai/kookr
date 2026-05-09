---
name: API Consistency Audit
description: Audit HTTP and WebSocket API surfaces for consistency, type safety, and coverage gaps
checklist:
  - Inventoried all HTTP routes with method, path, types, and error handling
  - Inventoried all WebSocket message types with direction and payload shapes
  - Checked naming consistency across all endpoints and messages
  - Checked error response format consistency
  - Identified type safety gaps (any types, unvalidated payloads)
  - Cross-referenced routes/messages with test coverage
  - Fixed naming and error format inconsistencies
  - Added type annotations to untyped API boundaries
  - Verified all tests still pass after changes
---

## Objective

Audit every HTTP route and WebSocket message type for consistency, type safety, and test coverage. Then fix the most impactful inconsistencies.

## Context

- **HTTP framework**: Hono (routes registered with `app.get()`, `app.post()`, etc.)
- **WebSocket**: Custom handler in `src/server/ws.ts`
- **Server entry**: `src/server/index.ts`
- **Shared types**: `src/core/types.ts` and related type files
- **Tests**: `src/server/*.test.ts`

## Phase 1 — Build API Inventory

### 1A. HTTP Routes
Grep for all Hono route registrations. For each route, record:
- HTTP method + path
- Handler file and line
- Request type (typed `c.req.json<T>()` or untyped?)
- Response type (typed or inferred?)
- Error handling (explicit try/catch or unguarded?)
- Query/path parameters and their types

### 1B. WebSocket Messages
Read the WebSocket handler(s). For each message type:
- Direction: client→server or server→client
- Type discriminant field (e.g., `type: "taskUpdate"`)
- Payload shape (typed interface or inline object?)
- Handler location

### 1C. Build inventory table
Create a complete table of the API surface. This is the reference for all subsequent checks.

## Phase 2 — Consistency Analysis

### 2A. Naming
Find the dominant convention for:
- HTTP paths (kebab-case? camelCase? plural nouns for collections?)
- Query parameters (camelCase? snake_case?)
- WebSocket message type strings (camelCase? UPPER_SNAKE?)
Flag any outliers that deviate from the dominant pattern.

### 2B. Error Responses
Check all error paths:
- Do routes return errors in a consistent shape? (e.g., always `{ error: string }`)
- Are HTTP status codes used correctly? (400 for bad input, 404 for not found, 500 for unexpected)
- Do WebSocket errors use the same format as HTTP errors?
Flag inconsistencies.

### 2C. Type Safety
Check each API boundary:
- Request bodies: typed or `any`?
- Response bodies: typed or ad-hoc inline objects?
- WebSocket payloads: validated (zod, manual checks) or just cast?
- Discriminated unions for WebSocket messages (does a `type` field narrow the payload)?
Flag `any` types and unvalidated inputs at API boundaries.

### 2D. Test Coverage
For each route and message type:
- Is there at least one test that exercises it?
- Is there an error-path test?
Flag completely untested endpoints.

## Phase 3 — Produce Report

Write to `/tmp/kookr-api-audit-report.md`:
- Full API inventory table
- Naming inconsistencies with suggested fixes
- Error format inconsistencies with suggested standard
- Type safety gaps ranked by risk
- Test coverage gaps

## Phase 4 — Fix Inconsistencies

Apply fixes in order of impact:

1. **Naming**: Rename inconsistent routes/messages to match dominant convention. Update all references (handlers, tests, frontend callers).
2. **Error format**: Standardize error responses to a single shape. Create a helper if one doesn't exist.
3. **Type safety**: Add type annotations to untyped request/response boundaries. Replace `any` with specific types.
4. **Do NOT add missing tests** in this playbook — just flag the gaps. Test writing is a separate task.

After each fix:
```bash
npx vitest run 2>&1
```
All tests must pass.

## Phase 5 — Verify

1. Run full test suite
2. Start the project's dev server (use the script defined in `package.json`, e.g. `npm run dev` / `pnpm run dev` / `make dev`) and verify a few routes manually with `curl`
3. If the project has a frontend, sanity-check that it still connects and receives any websocket messages it depends on

## Idempotency

- Safe to run repeatedly. Each run produces a fresh inventory and report.
- Previously fixed inconsistencies won't be re-flagged.
- Archive previous report with timestamp if it exists.

## Anti-Patterns

- Don't redesign the API. Fix inconsistencies within the existing design.
- Don't add validation middleware or a new error handling framework. Keep fixes minimal.
- Don't rename things that are referenced by the frontend without updating the frontend too.
- Don't break backward compatibility with any running Kookr instances. If a rename affects the WebSocket protocol, flag it as requiring a coordinated change.
