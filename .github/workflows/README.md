# CI is intentionally DISABLED for this repository — do not re-enable

**Standing operator decision.** See `CLAUDE.md` → "CI policy" for the full
rationale. This note is the in-tree pointer so anyone (human or agent) editing
these workflows sees the decision before touching them.

## What is disabled, and how

- **GitHub Actions is turned OFF at the repository level** (Settings → Actions,
  or `gh api -X PUT repos/kookr-ai/kookr/actions/permissions -F enabled=false`).
  With Actions disabled, **no** workflow in this directory runs, regardless of
  its triggers.
- **The automated CI workflows were neutered.** `ci.yml`, `e2e.yml`,
  `staging.yml`, `pr-checklist.yml`, and `dependency-review.yml` had their
  automatic triggers (`push` / `pull_request` / `issue_comment`) replaced with
  `workflow_dispatch` (manual only) as defense-in-depth: if Actions is ever
  re-enabled, they will **not** silently resurrect red PR checks.
  `onboarding-smoke.yml` was already `workflow_dispatch`-only.
- **`cla.yml` is intentionally left functional.** Its triggers were NOT neutered
  — it is a legal CLA collector for outside contributors, not a test/CI gate. If
  Actions is ever re-enabled for legal reasons, CLA must work as-is.

## Why

CI here went red on **real** failures (E2E, macOS, hook-regression) and coding
agents wasted whole iterations waiting for a green that never arrived, then
merged red anyway. The operator is the **sole merger** on this repo and relies on
local verification instead, so CI was disabled outright to make iterations fast.
(This repo is public with free Actions minutes — the reason is iteration speed,
not billing.)

## What replaces CI

Local verification is the **only** authoritative merge gate: typecheck, the full
test suite (Vitest + Playwright), and touched-surface gates run on the dev
machine and are enforced by the **pre-push review hooks** before any push. Record
the evidence (commands + summary counts) in the PR body, then merge once local
gates are green.

## Rules for future work

- Do **not** re-enable GitHub Actions, restore automatic triggers, or add
  required status checks.
- Do **not** add workflows that consume paid minutes on the operator's repos.
- Do **not** file issues to "fix CI" or propose paying for/re-enabling CI.
- Do **not** neuter `cla.yml` — it is a legal instrument, not a CI gate.
- The workflow files are kept (not deleted) only as a historical reference for
  what the gates used to check — reproduce those checks locally instead.
