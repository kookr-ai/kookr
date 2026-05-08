---
name: Test Quality Improvement
description: Audit test suite for quality problems, prioritize, and fix the worst offenders
checklist:
  - Scanned all test files and classified by quality
  - Identified tautological tests (tests that can't fail)
  - Identified tests with weak assertions
  - Identified implementation-coupled tests
  - Produced prioritized improvement report
  - Fixed top-priority test quality issues
  - Verified all tests still pass after improvements
---

## Objective

Audit the entire test suite for quality problems — tests that give false confidence by passing regardless of implementation correctness. Then fix the highest-impact issues.

## Context

- **Test framework**: Vitest
- **Test files**: `src/**/*.test.ts`
- **Run tests**: `npx vitest run` (all) or `npx vitest run <file>` (single)

## Phase 1 — Inventory and Quick Scan

1. Glob all `*.test.ts` files in `src/`
2. For each test file, do a quick structural scan:
   - Count tests (describe/it blocks)
   - Check mocking strategy (vi.mock, vi.fn, manual mocks)
   - Check assertion patterns (look for `toBeTruthy`, `toBeDefined`, `toMatchObject` with sparse partials)
   - Flag files with heavy mocking (>5 vi.mock calls) — these are highest risk for tautologies
3. Classify each file: `high-risk` (heavy mocking, weak assertions visible), `medium-risk` (moderate mocking), `low-risk` (mostly pure function tests with specific assertions)

## Phase 2 — Deep Review of High-Risk Files

For each `high-risk` file (and time permitting, `medium-risk`):

1. Read the test file thoroughly
2. Read the implementation it tests
3. Evaluate each test for:

**Tautological tests** (CRITICAL):
- Asserting on the mock's own return value
- Asserting that a spy was called when the spy IS the implementation
- Tests that would pass even if the implementation were deleted

**Weak assertions** (HIGH):
- `toBeTruthy()` / `toBeDefined()` where a specific value matters
- `toContain()` when full output matters
- Checking `.length > 0` instead of expected count
- `toMatchObject()` with nearly empty partial

**Implementation coupling** (HIGH):
- Asserting exact internal call order when order doesn't matter
- Snapshot tests on internal data structures
- Testing private behavior through elaborate mock setups

**Missing error paths** (MEDIUM):
- Try/catch in implementation with no test for the catch path
- Guard clauses / early returns with no test per branch
- Promise rejection paths untested

**Flaky patterns** (MEDIUM):
- Real timers without fake timers
- Assertions on Date.now() without frozen time
- Shared mutable state between tests

## Phase 3 — Produce Report

Write findings to `/tmp/kookr-test-quality-report.md`:

```
## Test Quality Report — [date]

### Summary
- Files scanned: N
- High-risk: N | Medium-risk: N | Low-risk: N
- Total findings: N (X critical, Y high, Z medium)

### Critical — Tautological Tests
[file, test name, why it can't fail, fix direction]

### High Priority — Weak Assertions
[file, test name, what wrong result would still pass, fix direction]

### High Priority — Implementation Coupling
[file, test name, what safe refactor would break it, fix direction]

### Medium Priority — Missing Coverage
[file, untested error/branch path, why it matters]

### Files with Clean Tests (no issues)
[list — acknowledge good work]
```

## Phase 4 — Fix Top Offenders

Fix the **top 5-10 findings** by severity:
1. Delete or rewrite tautological tests (they provide negative value — false confidence)
2. Strengthen weak assertions to assert specific expected values
3. Decouple implementation-coupled tests to test behavior, not internals
4. Add missing error path tests where the gap is dangerous

For each fix:
- Run `npx vitest run <file>` after modifying to verify all tests still pass
- If a strengthened assertion reveals a real bug in the implementation, note it but do NOT change the implementation — flag it for separate fixing

## Phase 5 — Verify

Run the full test suite:
```bash
npx vitest run 2>&1
```

All tests must pass. If any test you modified now fails, that's GOOD — it means you found a real issue. Note it in the report.

## Idempotency

- Safe to run repeatedly. Each run produces a fresh report.
- Previously fixed tests won't be re-flagged (they'll pass the quality review).
- If `/tmp/kookr-test-quality-report.md` exists, archive with timestamp.

## Anti-Patterns

- Don't weaken assertions to make tests pass — that's the opposite of this playbook's goal
- Don't add `test.skip()` — fix or delete
- Don't rewrite working tests just because they use a different style than you prefer
- Don't add coverage for trivial code (type guards, simple getters) — focus on logic with real failure modes
