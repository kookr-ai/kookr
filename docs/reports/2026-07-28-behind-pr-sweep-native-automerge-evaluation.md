# Green-but-BEHIND PR sweep — native auto-merge / merge-queue evaluation

_Issue #1574 · umbrella #1548 · 2026-07-28_

## Problem

Branch protection on `main` is `strict=true` ("Require branches to be up to
date before merging") plus a required `Anti-drift checklist` status context
(`.github/workflows/pr-checklist.yml`). Under that policy a PR that is
`mergeable=MERGEABLE` with every check green **still cannot merge once `main`
advances**: its `mergeStateStatus` flips to `BEHIND` and stays there until the
branch is updated. Evidence (#1548): PR #1515 sat `MERGEABLE` / `BEHIND` with
all 7 checks green for 4+ days while `main` advanced 16 commits. Nothing drains
this class of delivery debt automatically.

## Verdict

**Custom scheduled sweep — native mechanisms are insufficient.**

The reasons native GitHub features do not solve this on their own:

### GitHub auto-merge (`gh pr merge --auto`)

Auto-merge waits until a PR satisfies all merge requirements, then merges it.
It does **not** push the branch update a strict-protected branch needs: when
`main` advances, an auto-merge-enabled PR goes `BEHIND` and auto-merge simply
keeps waiting — it never runs the equivalent of `gh pr update-branch`. The
separate repo setting **"Always suggest updating pull request branches"** only
surfaces a manual "Update branch" button in the UI; it does not update branches
automatically. So auto-merge alone leaves exactly the #1515 failure mode in
place. (This is why #29's original evaluation still holds on the merge-update
axis, independent of the branch-protection availability that closed it.)

### Merge queue

A merge queue _does_ update/rebase entries against the latest base before
merging, which would technically address the BEHIND problem. It was rejected
for this repo because adopting it is a disproportionate, higher-risk change for
a single-maintainer delivery pipeline:

- Required status checks must be re-pointed at the queue's temporary
  `gh-readonly-queue/*` branches, or PRs never leave the queue — a foot-gun that
  silently stalls delivery if misconfigured.
- The merge queue changes the merge model (batched speculative merges) and
  interacts subtly with the base-SHA-pinned `Anti-drift checklist` verifier,
  which checks the PR against its base — extra validation surface for a problem
  a targeted sweep solves directly.
- It offers no per-run audit trail of _why_ a given PR was or wasn't advanced;
  #1574 explicitly requires that log.

A lightweight scheduled sweep that runs `gh pr update-branch` on green BEHIND
PRs and merges them when they return to CLEAN gives us the drain with a full
audit trail and none of the merge-queue reconfiguration risk.

## What was built

- `src/core/behind-pr-sweep.ts` — the deterministic core:
  - `planBehindPrSweep` / `decidePrAction`: pure eligibility policy mapping each
    open PR to `update-branch` / `merge` / `skip(reason)`.
  - `runBehindPrSweep`: executes a plan through an injected `SweepExecutor`
    (real impl `createGhSweepExecutor` shells out to `gh` with `execFile`).
    A green BEHIND PR is updated, re-fetched, and merged on the same pass if it
    returns CLEAN with green checks; otherwise the merge defers to a later run.
  - `renderSweepAuditLog`: renders one audit row per PR the sweep saw, with the
    outcome and reason.
- `.kookr/playbooks/behind-pr-sweep.md` — the scheduled Kookr playbook that
  runs the sweep on a cron (the `src/core/cron.ts` schedule surface).
- `src/core/behind-pr-sweep.test.ts` — covers the eligibility policy, the
  update-then-merge path, and the safety invariant that draft / CONFLICTING /
  failing-check PRs are never touched.

## Safety invariant

Draft, `CONFLICTING`/`DIRTY`, unknown-mergeability, and failing- or
pending-check PRs resolve to `skip` **before** any executor call, so the sweep
can never update or merge an ineligible PR. This is enforced by the guard order
in `decidePrAction` and asserted directly in the test suite.
