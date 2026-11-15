---
name: kookr-pr-lifecycle
description: Full PR lifecycle — creation, checklist tracking, CI monitoring, review resolution, body updates, and post-merge cleanup. Use together with post-push to finish PR follow-through.
keywords: PR, pull request, create PR, checklist, CI, review, merge, resolve thread, pr body, pr description, test plan, github
related: github-issue-workflow, kookr-post-push, pr-review-triage, git-commit-discipline
---

# PR Lifecycle

End-to-end workflow for managing a pull request from creation through merge. Consolidates all known patterns and workarounds.

## 1. Pre-Creation Checks

Before creating a PR, run these checks (see also [[pre-pr-review]] and [[kookr-pre-push]]):

```bash
pnpm exec vitest run <the test files for what you changed>   # must be green
git diff --stat   # review — no accidental files, no secrets
```

Do not run the full `pnpm test` or `pnpm verify` for a pull request. `git push`
runs the fast gate (static checks plus the tests related to the diff), and the
integration train runs the full `pnpm verify` on `staging` after the merge.

### Pre-`gh pr create` duplicate-guard (mandatory)

Run this **immediately before every `gh pr create`** below. It aborts with a
non-zero exit (no PR is created) if the issue was already auto-closed by an
earlier merge, or the head branch already has an open PR or one merged in the
last 24h — the exact 2026-07-26 race that produced duplicate PRs
(task dd1fbcec, a downstream repo — PRs #1672/#1673/#1674). This gives agents and
rehearsals a mechanical stop, not just prose.

```bash
# --- Pre-`gh pr create` duplicate-guard (issue #1569) ----------------------
# Fails CLOSED: if a gh probe errors (auth / network / rate-limit) the guard
# aborts rather than green-lighting an unverified PR — a rate-limited parallel
# batch is exactly when the duplicate race bites.
pr_create_guard() {
  local branch abort n state dupes
  branch="$1"; shift                 # head branch of the PR about to be created
  abort=0
  for n in "$@"; do                  # issue number(s) this PR would close
    if ! state=$(gh issue view "$n" --json state -q .state 2>/dev/null); then
      echo "PR-CREATE ABORTED: could not verify issue #$n (gh error / auth / rate-limit) — refusing to open a PR unverified." >&2
      abort=1; continue
    fi
    if [ "$state" = "CLOSED" ]; then
      echo "PR-CREATE ABORTED: issue #$n is CLOSED (likely auto-closed by an earlier merge) — refusing to open a duplicate PR." >&2
      abort=1
    fi
  done
  if ! dupes=$(gh pr list --head "$branch" --state all --json number,state,mergedAt \
    -q '.[] | select(.state=="OPEN" or (.mergedAt != null and (now - (.mergedAt|fromdateiso8601) < 86400))) | "#\(.number)/\(.state)"' 2>/dev/null); then
    echo "PR-CREATE ABORTED: could not verify PRs for '$branch' (gh error / auth / rate-limit) — refusing to open a PR unverified." >&2
    abort=1
  elif [ -n "$dupes" ]; then
    echo "PR-CREATE ABORTED: head branch '$branch' already has PR(s) $dupes (open or merged <24h ago) — refusing to open a duplicate PR." >&2
    abort=1
  fi
  [ "$abort" -eq 0 ] || return 1
  echo "pr-create guard OK: issue(s) [$*] open, no live/recent PR on '$branch'."
}

# The guard MUST pass before the PR is created. For cross-fork PRs, edit the two
# gh calls to add `-R <owner>/<repo>` and use `--head <owner>:<branch>`:
#   pr_create_guard "$(git rev-parse --abbrev-ref HEAD)" <ISSUE_N> [<ISSUE_N2> ...] || exit 1
#   gh pr create ...
```

## 2. Create the PR

Open every PR against `main`, the default base (your worktree was cut from
`origin/main`). Do not pass `--base staging`: `kookr merge` retargets the PR to
`staging` itself (§8).

```bash
# Guard first — never open a duplicate PR (see §1):
pr_create_guard "$(git rev-parse --abbrev-ref HEAD)" "$N" || exit 1

gh pr create --title "feat: short description" --body "$(cat <<'EOF'
## Summary
- What was done

## Test plan
- [ ] Fast pre-push gate passed (static checks + <N> related test files)
- [ ] Targeted tests: `<command>` — <counts>
- [ ] Manual verification (describe what to check)

Closes #N

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## 3. Checklist Management

**Check off items immediately after completing them.** Do not wait to be asked.

After each validation step (tests pass, typecheck clean, manual verification done), update the PR body right away:

```bash
# IMPORTANT: gh pr edit is BROKEN (Projects Classic deprecation error).
# Always use the REST API:
gh api repos/{owner}/{repo}/pulls/{number} -X PATCH -f body="updated body with [x] items"
```

For title changes:
```bash
gh api repos/{owner}/{repo}/pulls/{number} -X PATCH -f title="new title"
```

## 4. Post-Creation Verification

After `gh pr create`, scan the body for unchecked `[ ]` items. For each:

| Item type | Action |
|-----------|--------|
| Fast pre-push gate | Check off once `git push` passed; note how many related test files it ran |
| Targeted tests | Run the test files for what you changed and record the counts |
| Manual UI verification | Use Playwright to verify, then check off |
| Requires human judgment | Flag explicitly to the user |

Do not declare the task done while unchecked items remain.

## 5. CI Monitoring

After pushing, check CI status:

```bash
gh pr checks {number}
```

If checks fail, investigate and fix before moving on.

### CI-rerun bound — max 2 attempts, then report and stop

Do **not** loop on CI reruns waiting for a flaky check to go green. The bound:

- **max 2 CI rerun attempts** per PR. Re-run a failing check at most twice.
- After the **second** failed rerun, **report the CI state** — the failing check names and their run links (`gh pr checks {number}`, `gh run view <run-id>`) — and stop. **Never loop.** Do not sit at "waiting for CI" indefinitely; hand the failing state back rather than re-running a third time.
- Before you spend a rerun, **classify the failure first**. Infra-red CI — a check that failed only because CI budget/quota/runner capacity was unavailable and the run never executed your code — is non-blocking and should be classified non-blocking rather than rerun (see #1198). Infra-red failures do **not** consume one of the 2 rerun attempts; reserve reruns for genuinely flaky runs that actually executed.

Rationale: an unbounded rerun/merge loop once left a delivery task stuck at "waiting for response" for ~3h until it was reaped (PR #1542 / task faf7902b). The bound caps attempts; #1198 removes the false blockers.

## 6. Review Thread Resolution

When fixing issues raised in PR review comments, **resolve the thread immediately after pushing the fix**:

```bash
# Step 1: Find the thread ID
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: NUMBER) {
      reviewThreads(first: 50) {
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes { body }
          }
        }
      }
    }
  }
}'

# Step 2: Resolve the thread
gh api graphql -f query='
mutation {
  resolveReviewThread(input: { threadId: "THREAD_ID" }) {
    thread { isResolved }
  }
}'
```

Do not wait to be asked — resolving threads is part of completing the fix.

## 7. After the Merge: the Integration Train

There is no manual `staging` → `main` pull request; never open one. The
integration train (`docs/reference/integration-train.md`) runs the full
`pnpm verify` on `staging` and fast-forwards `main` to the exact commit it
verified.

- **"Merged" means merged into `staging`.** The task is done at that point.
- **The linked issue closes when the change reaches `main`**, not at the merge.
  The train closes it after promotion. `Closes #N` in the PR body is what links
  it, so keep it there.
- **If the train reverted your change**, it did three things: pushed a revert
  commit to `staging` carrying the trailer `Kookr-Integration-Train: revert`,
  reopened the linked issue with the failing output, and spawned one task to fix
  and re-land it. Look at the reopened issue first, then `pnpm train:status` and
  `pnpm train:logs`.

## 8. Merge & Head-Branch Cleanup

**Every merge of an issue/feature head branch must delete that branch.** Squash
merges leave the branch tip a non-ancestor of `main`; if the branch survives it
still shows a full stale diff and is PR-able a second time, producing net-no-op
duplicate PRs — the 2026-07-26 duplicate-PR incident (issue #1572). Branch
survival, not the merge method, is the root cause, so deletion is part of the
merge step, never an optional follow-up. (This does **not** apply to the
long-lived `staging` integration branch — never delete `staging`.)

On this repo (no auto-merge — issue #29) use the wrapper. It retargets a PR
aimed at `main` to `staging`, squash-merges it into `staging`, **and deletes the
head branch**. Never merge into `main` or push to `main` or `staging` yourself.

**Merge with `kookr merge`, run from the PR's own worktree**, which was cut
from `origin/main`. Never change directory to the primary checkout or another
older worktree to merge. `kookr merge` always runs the merge wrapper of the
deployed production checkout, which follows `main`. `pnpm merge` instead runs
the `scripts/kookr-merge.sh` of the checkout you are in; a checkout whose branch
predates the integration-branch support skips the retarget and merges straight
into `main`, bypassing the train (that is how #3802 landed on `main`
unverified). The plugin's `merge-retarget-guard` hook denies that case (#3803).
Afterwards confirm the PR's base is `staging` (the output only prints
`retargeted PR #<n> from main to staging` when it retargeted, so check the base
itself). If the PR landed on `main` anyway, report it on the PR and its issue.

```bash
kookr merge <PR_NUMBER> --repo kookr-ai/kookr   # from the PR's own worktree:
                                 # retarget to staging, squash-merge, delete branch
gh pr view <PR_NUMBER> --repo kookr-ai/kookr --json baseRefName --jq .baseRefName   # expect: staging
```

The wrapper deletes the remote head branch through the REST API after GitHub
confirms the merge, so merging from the worktree that holds the branch is fine.

For any other repo, delete the branch as part of the merge:

```bash
gh pr merge <PR_NUMBER> --squash --delete-branch
```

### Linked-worktree edge case (other repositories)

With a bare `gh pr merge --delete-branch` (repositories without the wrapper),
the local-branch delete fails when that branch is checked out in a linked
worktree. The remote merge has already happened, so finish the cleanup
explicitly; each step is idempotent:

```bash
git push origin --delete <head-branch> 2>/dev/null || true    # ensure the REMOTE branch is gone
git worktree remove <worktree-path> 2>/dev/null || true       # drop the linked worktree holding it
git branch -D <head-branch> 2>/dev/null || true               # then the local branch
```

Verify the remote head branch is gone before calling the merge done:

```bash
gh api "repos/<owner>/<repo>/branches/<head-branch>"   # expect: HTTP 404
```

## Common Mistakes to Avoid

- **Never use `gh pr edit --body` or `gh pr edit --title`** — it fails with a GraphQL Projects Classic deprecation error
- **Never leave checklist items unchecked** after they've been validated
- **Never skip thread resolution** after pushing a review fix
- **Never create a PR without running the targeted tests first**; never run the full suite or `pnpm verify` per PR either (§1)
- **Never run `gh pr create` without passing the pre-create duplicate-guard** (§1) — a CLOSED issue or an already-open/recently-merged head branch means the work already shipped
- **Never leave a merged issue/feature head branch alive** (§8) — a surviving squash-merged branch is re-PR-able and produces net-no-op duplicate PRs (issue #1572); the long-lived `staging` branch is the sole exception

## See Also

- [[github-issue-workflow]] — Issue creation and branch setup (upstream of this skill)
- [[kookr-post-push]] — Repo follow-through after push / PR creation
- [[pr-review-triage]] — Detailed review comment triage workflow
- [[pre-pr-review]] — Self-review checklist before PR creation
- [[git-commit-discipline]] — Commit message and hygiene patterns
