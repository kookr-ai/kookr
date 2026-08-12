<!--
Fill the summary and test plan, then work every marked checklist row below.

The `<!-- kookr:check:id -->` markers are verified by the PR checklist CI
against the actual diff. A CHECKED box is an assertion that the mapped evidence
is present in this PR; a STRUCK box with a one-line reason is an explicit waiver;
a blank marked box fails the check. When using `gh pr create`, build the body
from this template and pass it with `--body-file`; inline `--body` skips the
template.
-->

## Summary

<!-- Intent first (2–4 plain sentences): what problem, what changed in human terms, why it matters.
     Define project jargon on first use. Put function names / constants / paths in Changes, not here.
     Skill: clear-technical-writing (plugin). Reviewer: kookr-toolkit:clear-writing-reviewer. -->

## Test plan


## Pre-merge checklist

- [ ] Unit tests pass (`pnpm test`)
- [ ] E2E tests pass (`pnpm exec playwright test`)
- [ ] Canary test pass locally (`CANARY=1 npx playwright test e2e/canary.spec.ts`) — validates mock event fixtures against real Claude Code (Haiku). See `e2e/canary.spec.ts`.
- [ ] Reviewed the CI coverage summary on this PR (Checks → `test` job → Summary) — see [docs/testing.md](../docs/testing.md)
- [ ] <!-- kookr:check:tests --> Added or updated tests for the changed behavior, or explained why this change is docs/config-only
- [ ] <!-- kookr:check:mbse --> System design documents are up to date with codebase changes (ADRs, `docs/architecture.md`, `docs/features.md`, skills — verify no drift)
- [ ] <!-- kookr:check:prose --> Summary is cold-reader clear: plain-language intent first, jargon glossed, symbols only in technical details (`clear-technical-writing` skill). Strike with a one-line reason only for pure typo / formatting / mechanical renames.
