---
name: testing-patterns
description: Choose and implement unit/integration/E2E tests that catch real regressions in this monorepo.
keywords: testing, integration tests, route registration test, sql template assertion, reproduction first, env parity, flaky test, vitest bun
related: tdd-workflow
---
# Testing Patterns
## When to Use
- A bug is reported and root cause is unclear.
- Mock-heavy tests pass while production fails.
- Route exists in code but returns 404 at runtime.
- SQL cast/type mismatch appears only in integration runs.

## Quick Reference
| Need | Best Test Type | Why |
|---|---|---|
| Business logic branch behavior | Unit | Fast, isolated feedback |
| Route wiring + middleware + DI | Integration | Catches registration/order/config failures |
| SQL cast/template correctness | Integration with real DB driver path | Mocks miss SQL string/type issues |
| Browser flow/regression | E2E | Validates full stack and UX behavior |

## Patterns
| Pattern | Rule | Verification |
|---|---|---|
| Reproduction-first | Encode minimal failing scenario before broad refactor | Test fails before fix |
| Route-registration test | Assert route is mounted and reachable in app bootstrap context | Prevent silent 404 from missed registration |
| SQL template assertions | Assert generated SQL contains expected casts/placeholders and binds | Catch `::text[]` vs `::uuid[]` class of bugs |
| Environment parity preflight | Align ports/env flags/service deps with target runtime | “Works locally only” incidents drop |
| Contract boundary tests | Validate request/response envelopes against shared schemas | Detect docs/impl drift early |
| Coverage task stopping rule | Stop after 2 iterations with <2% coverage delta or once task target is met | Final output reports coverage % and delta from start |

## Environment Parity Checklist
| Item | Expected |
|---|---|
| API/DB/Redis ports | Match documented dev/test mapping |
| Feature flags | Explicit values for branch under test |
| Mock gates | Disabled unless test explicitly targets mock path |
| Worker/autonomy mode | Set intentionally, not inherited stale state |

## Common Pitfalls
| Pitfall | Why It Fails | Safer Alternative |
|---|---|---|
| Starting with large integration suite for unknown bug | Slow and noisy | Reproduce minimal failure first |
| Pure unit coverage for route bugs | Misses registration/middleware | Add route-registration integration tests |
| SQL mocked as plain function return | Hides cast/placeholder defects | Assert SQL template + run integration query path |
| Flaky retries without root cause | Masks nondeterminism | Stabilize clock/network/state dependencies |

## See Also
- [[tdd-workflow]]
