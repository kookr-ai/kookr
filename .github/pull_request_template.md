## Summary


## Test plan


## Pre-merge checklist

- [ ] Unit tests pass (`pnpm test`)
- [ ] E2E tests pass (`pnpm exec playwright test`)
- [ ] Canary test pass locally (`CANARY=1 npx playwright test e2e/canary.spec.ts`) — validates mock event fixtures against real Claude Code (Haiku). See `e2e/canary.spec.ts`.
- [ ] Reviewed the CI coverage summary on this PR (Checks → `test` job → Summary) — see [docs/testing.md](../docs/testing.md)
- [ ] <!-- kookr:check:tests --> Added or updated tests for the changed behavior, or explained why this change is docs/config-only
- [ ] <!-- kookr:check:mbse --> System design documents are up to date with codebase changes (ADRs, `docs/architecture.md`, `docs/features.md`, skills — verify no drift)
