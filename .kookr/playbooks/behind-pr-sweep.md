---
name: Sweep green-but-BEHIND PRs
description: Find MERGEABLE + BEHIND PRs with all checks green, update their branch, and merge when they return to CLEAN. Drains strict-branch-protection delivery debt (#1574).
cwd: $HOME/git/kookr
deliveryPreAuthorized: true
checklist:
  - Fetched the open-PR list once via a single gh pr list call
  - Every open PR was classified update-branch / merge / skip with a reason
  - Draft, CONFLICTING/DIRTY, unknown-mergeability, and failing/pending-check PRs were skipped, never touched
  - Each green BEHIND PR had its branch updated with gh pr update-branch
  - A green PR that returned to CLEAN was squash-merged
  - An audit log listing every PR touched and the action/skip reason was emitted
  - No PR on main branch protection was force-merged or had checks bypassed
---

## Objective

Drain the "green but BEHIND" delivery-debt backlog. Under strict branch
protection (`strict=true` + required `Anti-drift checklist`), a PR that is
`MERGEABLE` with every check green cannot merge once `main` advances — it sits
`mergeStateStatus=BEHIND` until its branch is updated. GitHub's native
auto-merge does not push that update, so these PRs accumulate (evidence: #1515
sat BEHIND for 4+ days). See
`docs/reports/2026-07-28-behind-pr-sweep-native-automerge-evaluation.md` for the
full native-vs-custom evaluation.

**No functional change is made to any PR.** This task only advances PRs their
authors already finished, through auditable `update-branch` + `merge` steps.

## Policy (implemented deterministically in `src/core/behind-pr-sweep.ts`)

The eligibility policy is the single source of truth in code; this playbook
runs it, it does not re-decide. For every open PR:

- **skip** — draft, `CONFLICTING`/`DIRTY`, `mergeable=UNKNOWN`, failing checks,
  pending checks, no completed checks, or any merge state other than BEHIND/CLEAN
  (e.g. `BLOCKED` = review still required).
- **update-branch** — `MERGEABLE` + `BEHIND` + checks green. Run
  `gh pr update-branch`; the merge defers to a later run once CI re-settles,
  unless the branch returns to CLEAN with checks still green on this pass.
- **merge** — `MERGEABLE` + `CLEAN` + checks green. Squash-merge.

## Steps

1. Confirm `gh auth status` is authenticated for `kookr-ai/kookr`.
2. Drive the deterministic core. Preferred: call
   `listOpenPrsForSweep('kookr-ai/kookr')` → `runBehindPrSweep(prs, createGhSweepExecutor('kookr-ai/kookr'))`
   → `renderSweepAuditLog(result, <ISO now>)` from a small tsx runner.
   Equivalent manual flow if running by hand:
   - `gh pr list -R kookr-ai/kookr --state open --limit 100 --json number,title,isDraft,mergeable,mergeStateStatus,statusCheckRollup`
   - For each `update-branch` PR: `gh api -X PUT repos/kookr-ai/kookr/pulls/<n>/update-branch` (or `gh pr update-branch <n>`).
   - Re-check state; for each PR now CLEAN + green: `gh pr merge <n> -R kookr-ai/kookr --squash`.
3. Emit the audit log listing every PR touched and the action taken or skip
   reason. This is the run's required output.

## Schedule

Register on the cron surface (`src/core/cron.ts`) at a modest cadence
(e.g. every 30 minutes: `*/30 * * * *`) so BEHIND PRs are drained shortly after
`main` advances without hammering the GitHub API.

## Safety

- Never bypass branch protection, never `--admin`-merge, never force-merge.
- Never touch a PR the policy classified as `skip`.
- One `gh pr list` per run; do not poll individual PRs in a tight loop.
