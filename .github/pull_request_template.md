## Summary


## Test plan


## Pre-merge checklist

- [ ] Unit tests pass (`pnpm test`)
- [ ] E2E tests pass (`pnpm exec playwright test`)
- [ ] Canary test pass locally (`CANARY=1 npx playwright test e2e/canary.spec.ts`) — validates mock event fixtures against real Claude Code (Haiku). See `e2e/canary.spec.ts`.
- [ ] Changes and additions are covered by appropriate tests (unit, integration, and/or E2E as relevant)
- [ ] System design documents are up to date with codebase changes (ADRs, `docs/architecture.md`, `docs/features.md`, skills — verify no drift)
