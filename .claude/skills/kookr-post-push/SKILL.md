---
name: kookr-post-push
description: Repo delivery-cycle follow-through after push or PR creation — verify mergeability, checklist state, CI, and early feedback by composing pr-lifecycle and pr-review-triage.
keywords: post-push, after push, after PR, PR follow-up, CI, merge conflict, review comments, delivery cycle
related: kookr-pre-push, kookr-pr-lifecycle, pr-review-triage, pre-pr-review
---

# Post-Push

Use this immediately after pushing a branch that has a PR, and again after any follow-up push. This skill does not create a parallel workflow. It is the repo-local reminder to keep driving the existing PR workflow until the branch is actually in a good state.

## What This Skill Composes

- `[[kookr-pr-lifecycle]]` for PR creation, checklist updates, and CI monitoring
- `[[pr-review-triage]]` for comment triage, fixes, and thread resolution

This skill fills the gap between "push succeeded" and "the PR is actually ready."

## Workflow

### 1. Find the current PR

If the branch already has a PR:

```bash
gh pr view --json number,url,mergeable,mergeStateStatus,reviewDecision
```

If the PR does not exist yet, create or update it via [[kookr-pr-lifecycle]] after `[[kookr-pre-push]]` has completed.

**Listing PRs for the post-merge rebase scan:** use `gh prs` (alias: `pr list --limit 200`) or pass `--limit 200` explicitly — the bare `gh pr list` default of 30 silently truncates and misses PRs in busy repos. Set the alias once with `gh alias set prs 'pr list --limit 200'` (older gh versions without `--clobber`: `gh alias delete prs 2>/dev/null; gh alias set prs 'pr list --limit 200'`).

### 2. Check mergeability first

Read `mergeable` / `mergeStateStatus` right away.

- If GitHub reports merge conflicts or the branch is behind the base branch in a way that needs action, fix that branch state before calling the task done.
- After resolving conflicts locally, push again and restart this skill.

### 3. Verify the PR checklist

Read the PR body and clear any checklist items that are already complete.

Typical Kookr checklist items:
- Server type-check clean: `pnpm build:server`
- E2E type-check clean: `pnpm check:e2e`
- Tests pass: `pnpm test`
- Manual verification: describe what was actually checked

Use the `[[kookr-pr-lifecycle]]` REST-update flow to keep the PR body current. Do not leave stale unchecked items behind.

Also re-read the PR title and summary against the **current** branch diff after every follow-up push:

- If the diff scope changed, update the title/body immediately
- If verification changed (new tests, different commands, CI-specific reruns), update the test plan immediately
- Do not leave a stale description that reflects an earlier version of the branch

### 4. Check CI and early feedback

Run:

```bash
gh pr checks
gh pr view --json comments,reviews
```

Also inspect inline review comments when needed:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments
```

If checks are still pending, poll for a short window rather than walking away. A practical default is up to about 5 minutes after PR creation or after a review-fix push.

If the push changed tests, test helpers, mocks, or build/test harness code, re-run verification in the same runtime/version CI uses before considering the branch healthy. For example:

- match the CI tool version when local and CI differ
- treat platform-specific test setup as higher risk, especially for Windows
- prefer one matrix-aligned rerun over assuming a targeted local pass is enough

### 5. Hand off to the right existing flow

- If CI fails, fix the problem, push again, and repeat this skill
- If bots or reviewers left actionable comments, switch to [[pr-review-triage]]
- If checklist items or PR metadata are stale, switch to [[kookr-pr-lifecycle]]

### 6. Wait-then-merge (substitute for `gh pr merge --auto`)

GitHub auto-merge is unavailable on this repo (private + Free plan, no branch
protection — see issue #29). `gh pr merge <PR> --auto --squash --delete-branch`
fails with `Auto merge is not allowed for this repository`.

Use the repo wrapper instead:

```bash
pnpm merge <PR_NUMBER>            # equivalent to:
bash scripts/kookr-merge.sh <PR_NUMBER>
```

The wrapper performs `gh pr checks --watch` and then squash-merges with
`--delete-branch` once checks pass. It refuses to merge a closed, draft, or
changes-requested PR. Use it instead of writing one-off `sleep` polling loops
or scheduling wakeups. Do not invoke `gh pr merge --auto` on this repo.

**Independent merge-review gate (issue #1717).** For an autonomous self-merge,
the wrapper additionally refuses (exit 4) unless the PR carries a fresh-context
reviewer verdict of `pass` for the current head, or the `review-skipped-timeout`
label. Before calling `pnpm merge`, run the [[independent-merge-review]] skill:
it spawns a reviewer blind to your implementation reasoning (Codex lane, Claude
fallback when Codex is rate-limited), posts the verdict comment, and applies the
timeout label if no verdict lands within the 10-minute budget. Only a
human-driven manual merge may bypass it with `KOOKR_MERGE_REQUIRE_REVIEW=0`.

### 7. Report PR health explicitly

Before you say the branch is in good shape, report:

- PR: number + URL (or "no PR yet")
- mergeability: clean / conflicted / unknown
- checklist/body: current / stale
- CI: passing / failing / pending
- feedback: none / bot comments pending / review comments pending
- independent review (before an autonomous merge): verdict `pass`/`block` (lane) / timeout-labeled / not yet run
- next action: wait / fix / triage / merge-ready

Do not leave the user to ask whether CI, mergeability, or the post-push workflow was checked.

## Done Criteria

Do not declare the task complete while any of these remain true:
- The PR has merge conflicts
- The PR body still has checklist items that should already be checked off
- CI is failing on known issues you can address now
- Early bot or reviewer comments are waiting without triage
