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
pnpm build:server # must be clean
pnpm check:e2e   # must be clean
pnpm test         # must be green
git diff --stat   # review — no accidental files, no secrets
```

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

Target `staging` for feature/fix PRs. Target `main` only for hotfixes or docs-only changes.

```bash
# Guard first — never open a duplicate PR (see §1):
pr_create_guard "$(git rev-parse --abbrev-ref HEAD)" "$N" || exit 1

gh pr create --base staging --title "feat: short description" --body "$(cat <<'EOF'
## Summary
- What was done

## Test plan
- [ ] `pnpm test` passes
- [ ] `pnpm build:server` clean
- [ ] `pnpm check:e2e` clean
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
| Tests pass | Run `pnpm test` and check off |
| Server type-check | Run `pnpm build:server` and check off |
| E2E type-check | Run `pnpm check:e2e` and check off |
| Manual UI verification | Use Playwright to verify, then check off |
| Requires human judgment | Flag explicitly to the user |

Do not declare the task done while unchecked items remain.

## 5. CI Monitoring

After pushing, check CI status:

```bash
gh pr checks {number}
```

If checks fail, investigate and fix before moving on.

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

## 7. Staging → Main Merge

After a staging PR is merged and validated, create a merge PR to main:

```bash
git checkout staging && git pull
# A staging→main merge PR is not issue-scoped, so the §1 duplicate-guard does
# not apply (its merged-<24h rule would false-abort routine merges). Guard only
# against a second *open* staging→main PR for the same head:
[ -z "$(gh pr list --head staging --base main --state open --json number -q '.[].number' 2>/dev/null)" ] \
  || { echo "An open staging→main PR already exists — not creating a duplicate." >&2; exit 1; }
gh pr create --base main --title "Staging" --body "$(cat <<'EOF'
## Summary
- Merge staging changes into main

## Changes included
- List the PRs/features included

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

## Common Mistakes to Avoid

- **Never use `gh pr edit --body` or `gh pr edit --title`** — it fails with a GraphQL Projects Classic deprecation error
- **Never leave checklist items unchecked** after they've been validated
- **Never skip thread resolution** after pushing a review fix
- **Never create a PR without running the repo checks first**
- **Never run `gh pr create` without passing the pre-create duplicate-guard** (§1) — a CLOSED issue or an already-open/recently-merged head branch means the work already shipped

## See Also

- [[github-issue-workflow]] — Issue creation and branch setup (upstream of this skill)
- [[kookr-post-push]] — Repo follow-through after push / PR creation
- [[pr-review-triage]] — Detailed review comment triage workflow
- [[pre-pr-review]] — Self-review checklist before PR creation
- [[git-commit-discipline]] — Commit message and hygiene patterns
