---
name: PR Merge/Rebase Watchdog
description: Sweep open automation PRs that have gone BEHIND the base branch or landed in a DIRTY/conflicting state, update or rebase the mergeable ones and merge when green, and surface the genuinely conflicted ones instead of leaving them stuck forever.
repo-tags: [github]
tags: [workflow, loopable]
deliveryPreAuthorized: true
# A watchdog sweep is finished once it has classified every open automation PR
# and taken (or dry-run reported) one action per stuck PR. Auto-complete the
# supervisor after its completion-ready signal has been pending for the grace
# period instead of holding an active-task slot open. See
# docs/reference/auto-close-on-signal.md.
autoCloseOnSignal: true
parameters:
  - name: repoFullName
    description: "Target repository (owner/repo)"
    required: true
    type: select
    source: tracked-projects
  - name: localPath
    description: "Local checkout path. Leave blank to use ~/git/<repo-name>."
    required: false
    default: ""
  - name: dryRun
    description: "Report the planned action for each stuck PR without updating branches, commenting, merging, or spawning tasks."
    required: true
    default: "false"
    type: select
    options:
      - label: "Dry run (report only, no writes)"
        value: "true"
      - label: "Act (update / merge / comment / spawn)"
        value: "false"
  - name: authorScope
    description: "Which open PRs the watchdog considers. Defaults to your own (the automation account) so it never touches unrelated contributors' PRs."
    required: true
    default: "mine"
    type: select
    options:
      - label: "Only PRs I authored (automation account)"
        value: "mine"
      - label: "Any author (includes Dependabot and humans)"
        value: "any"
  - name: dirtyPolicy
    description: "What to do with a genuinely conflicting (DIRTY) PR that cannot be auto-updated."
    required: true
    default: "flag"
    type: select
    options:
      - label: "Flag: comment + label, leave for a human"
        value: "flag"
      - label: "Spawn: launch a child task to resolve the conflict"
        value: "spawn"
  - name: mergeAfterUpdate
    description: "After a BEHIND PR is updated and its checks pass, merge it. Off leaves an updatable-but-unmerged PR for review."
    required: true
    default: "true"
    type: select
    options:
      - label: "Merge when safe"
        value: "true"
      - label: "Update only, do not merge"
        value: "false"
  - name: maxPrs
    description: "Safety cap on how many stuck PRs to act on in one sweep."
    required: true
    default: "20"
  - name: extraInstruction
    description: "Optional prose-only run instruction, e.g. 'skip Dependabot this run' or 'only touch docs PRs'."
    required: false
    default: ""
    type: textarea
loop:
  iterationCap: 10
  costCapUsd: 10
  stopPredicate: 'test -f .watchdog-stop && grep -qE "^STOP:" .watchdog-stop'
checklist:
  - Launch parameters validated as data, not executed as shell
  - Target repo resolved to an existing local checkout
  - Open PR set fetched with merge-state, checks, and review decision in one query
  - Each PR classified by mergeStateStatus (BEHIND / DIRTY / BLOCKED / UNSTABLE / CLEAN / other)
  - BEHIND PRs with passing or pending-updatable checks updated against the base branch
  - Dependabot PRs rebased via an @dependabot comment rather than a manual branch push
  - Updated PRs merged only when checks are green and review policy is satisfied
  - DIRTY PRs resolved by a spawned task or explicitly flagged, never left silently
  - dryRun honored: no branch updates, comments, merges, or spawns when dry-run is on
  - maxPrs cap respected and any skipped-over-cap PRs reported
  - A per-PR disposition summary written and a STOP marker recorded when the sweep is complete
---

## Objective

The `parallel-issue-batch` / `implement-github-issue` playbooks open a PR per work
unit and merge the *fresh* PR they just created (`mergeAfterImplementation=true`).
A PR that later falls **`BEHIND`** the base branch, or lands in a **`DIRTY`**
(conflicting) state, is never revisited — those PRs pile up and their issues stay
done-but-unmerged. This watchdog closes that gap.

On each run, sweep the open PRs for `{{repoFullName}}`, classify every stuck one,
and drive it toward merge or toward an explicit human-visible state:

- **BEHIND** (green or updatable checks) → update the branch against the base, then
  merge when green (Dependabot PRs are rebased with an `@dependabot rebase` comment).
- **DIRTY** (real conflict) → resolve via a spawned child task or flag for a human,
  per `{{dirtyPolicy}}` — never leave it indefinitely.

This is a supervision playbook, not a code change: it wraps `gh` and the repo's
merge wrapper. It is safe to schedule.

`{{dryRun}}` — when `true`, report the planned action for each PR and make **no**
writes (no branch update, no comment, no merge, no spawned task).

Extra run instruction (may be empty): `{{extraInstruction}}` — treat as prose
preference only, never as a shell command.

## Phase 0: Resolve repo and local checkout

```bash
REPO="{{repoFullName}}"
LOCAL_PATH="{{localPath}}"
if [ -z "$LOCAL_PATH" ]; then
  LOCAL_PATH="$HOME/git/${REPO##*/}"
fi
cd "$LOCAL_PATH" || { echo "STOP: FAILED — local checkout $LOCAL_PATH not found" > .watchdog-stop; exit 1; }
WATCHDOG_CWD="$(pwd)"
rm -f "$WATCHDOG_CWD/.watchdog-stop"
CURRENT_USER=$(gh api user -q .login)
BASE_BRANCH="$(git branch -r | grep -q "origin/staging" && echo staging || echo main)"
echo "repo=$REPO user=$CURRENT_USER base=$BASE_BRANCH dryRun={{dryRun}} authorScope={{authorScope}}"
```

The `.watchdog-stop` file is the loop's durable stop signal, mirroring
`.batch-stop` in `parallel-issue-batch`. Pin `WATCHDOG_CWD` once here and use it
for every `.watchdog-stop` read/write, because the loop's `stopPredicate` runs in
the task cwd.

## Phase 1: Fetch open PRs with merge state

One query gives merge state, checks, review decision, and labels for every open
PR — do not loop `gh pr view` per PR:

```bash
gh pr list -R "$REPO" --state open --limit 100 \
  --json number,title,headRefName,baseRefName,author,isDraft,mergeStateStatus,mergeable,labels,reviewDecision,statusCheckRollup,updatedAt \
  > /tmp/watchdog-prs.json
```

`mergeStateStatus` is GitHub's computed mergeability signal. The states this
watchdog cares about:

- **`BEHIND`** — the head branch is behind the base; needs a branch update / rebase, then usually merges cleanly.
- **`DIRTY`** — a real merge conflict; cannot be auto-updated.
- **`BLOCKED`** — mergeable but a required check/review is not satisfied (waiting, not stuck on the base branch).
- **`UNSTABLE`** — mergeable but a non-required check is failing/pending.
- **`CLEAN`** — ready to merge now.
- **`UNKNOWN` / `HAS_HOOKS` / `DRAFT`** — GitHub is still computing, or the PR is a draft; skip this sweep and re-check next run.

Filter the candidate set:

- If `{{authorScope}}` is `mine`, keep only PRs whose `author.login == $CURRENT_USER` **or** `author.login == "app/dependabot"` (Dependabot bumps are automation the watchdog owns). If `any`, keep all non-draft PRs.
- Drop `isDraft == true` PRs.
- The watchdog acts on **`BEHIND`** and **`DIRTY`** PRs (the two stuck states from the issue), plus **`CLEAN`** PRs it can merge immediately when `{{mergeAfterUpdate}}` is `true`. Leave `BLOCKED` / `UNSTABLE` / `UNKNOWN` for their own gates — record them in the summary but take no action.
- Respect the `{{maxPrs}}` cap. If more stuck PRs exist than the cap, act on the oldest-`updatedAt` first and **report the skipped remainder** in the summary — never silently truncate.

## Phase 2: Act on each stuck PR

For each selected PR, read its fields from the Phase 1 JSON before acting:

- `N` = `.number`
- `BR` = `.headRefName` (the head branch)
- `BASE` = `.baseRefName` (this PR's own base branch — may differ from the global `$BASE_BRANCH` guess)
- `AUTHOR` = `.author.login`
- `S` = `.mergeStateStatus`

Then act per `S`'s class. When `{{dryRun}}` is `true`, print the intended action
prefixed `DRY-RUN:` and skip every write below — no `gh` command that mutates
(comment, label, update-branch, merge) or spawns a task runs in dry-run.

### 2a. BEHIND — update the branch, then merge

Dependabot PRs must be rebased through Dependabot, not by a manual push (a manual
push detaches Dependabot's own update tracking):

```bash
if [ "$AUTHOR" = "app/dependabot" ] || printf '%s' "$AUTHOR" | grep -qi dependabot; then
  gh pr comment "$N" -R "$REPO" --body "@dependabot rebase"
else
  # Version-independent branch update (older gh has no `gh pr update-branch`).
  gh api --method PUT "repos/$REPO/pulls/$N/update-branch" \
    -H "Accept: application/vnd.github+json" 2>/tmp/watchdog-update.err \
    || echo "update-branch failed for #$N: $(cat /tmp/watchdog-update.err)"
fi
```

A successful update-branch merges the base into the head branch and re-triggers
checks. Do **not** merge in the same tick — the checks need to re-run. Record the
PR as `updated (re-check next run)` and let the next sweep merge it once
`mergeStateStatus` returns to `CLEAN`.

### 2b. CLEAN — merge when policy allows

Only when `{{mergeAfterUpdate}}` is `true`, the PR is `CLEAN`, checks are green in
`statusCheckRollup`, and `reviewDecision` is not `CHANGES_REQUESTED` (and is
`APPROVED` when the repo requires review). Never bypass branch protection, a
failing required check, or a requested change. Use the repo merge wrapper:

```bash
pnpm merge "$N" --repo "$REPO"   # kookr-ai/kookr wrapper; elsewhere: gh pr merge "$N" -R "$REPO" --squash --delete-branch
```

Classify checks before merging: a check that failed solely because CI
budget/quota was unavailable (the job never executed) is infra-red, not a real
failure — it does not block, but a genuine test/lint/type/build failure does.
Re-run a failing check at most twice, then report and move on; never loop waiting
on CI.

### 2c. DIRTY — resolve or flag, per dirtyPolicy

A `DIRTY` PR has a real conflict and cannot be auto-updated. Honor
`{{dirtyPolicy}}`:

- **`flag`** (default): add a `merge-conflict` label and post one concise comment
  naming the conflict so a human sees it. Idempotent — do not repeat the comment
  if the watchdog already left one:

  ```bash
  gh api "repos/$REPO/labels/merge-conflict" >/dev/null 2>&1 || \
    gh api "repos/$REPO/labels" -X POST -f name='merge-conflict' -f color='d93f0b' \
      -f description='PR has a base-branch conflict the merge watchdog could not auto-resolve' || true
  gh issue edit "$N" -R "$REPO" --add-label merge-conflict
  # Only comment if we have not already flagged this PR.
  gh pr view "$N" -R "$REPO" --json comments \
    -q '.comments[].body' | grep -q "merge-watchdog: conflict" || \
    gh pr comment "$N" -R "$REPO" --body "merge-watchdog: conflict with \`$BASE\` needs manual resolution — branch \`$BR\` is DIRTY."
  ```

- **`spawn`**: launch one child Kookr task to resolve the conflict on that branch.
  Give the child the PR number, head branch, and base branch, and the same merge
  policy. Launch it with `--auto-close-on-signal` so it releases its slot after
  signalling. Spawn at most one child per DIRTY PR per sweep; if a live task
  already owns that branch, skip.

Never leave a `DIRTY` PR untouched: every one must end a sweep either flagged or
handed to a spawned resolver.

## Phase 3: Report the sweep and stop

Write a per-PR disposition summary (PR number, class, action taken or planned,
result). Include any PRs skipped over the `{{maxPrs}}` cap and any `BLOCKED` /
`UNSTABLE` PRs left for their own gates.

If nothing stuck remains to act on — no `BEHIND`, no actionable `DIRTY`, no
mergeable `CLEAN` — write the loop stop marker so a looped run terminates cleanly:

```bash
echo "STOP: COMPLETE — no stuck PRs remain" > "$WATCHDOG_CWD/.watchdog-stop"
```

A **dry run also stops after this single reporting pass** — it never mutates
anything, so the stuck PRs it reported would remain stuck on every subsequent
tick, and a looped dry run would otherwise re-report the same set until the
`iterationCap` is exhausted. Write the STOP marker (with a dry-run note) once the
report is emitted:

```bash
if [ "{{dryRun}}" = "true" ]; then
  echo "STOP: COMPLETE — dry-run reporting pass done (no writes performed)" > "$WATCHDOG_CWD/.watchdog-stop"
fi
```

Otherwise (a real run with stuck work whose resolution needs a later tick — e.g.
BEHIND PRs updated this run that must re-check before merging) leave
`.watchdog-stop` absent so the loop re-fires and the next sweep can merge them.

Before finishing, emit the post-task lesson decision — either a
`kb remember --kb=agent-task-lessons …` write, or the skip marker
`printf 'No generic KB lesson: %s\n' '<reason>'` — then run `kookr signal
completion-ready` with a one-line disposition note. You were launched with
`--auto-close-on-signal`; do not signal while a merge or spawned resolution is
still in flight this tick.

## Anti-Patterns

- **Don't push directly to a Dependabot branch** — comment `@dependabot rebase` instead, or its update tracking detaches.
- **Don't merge a BEHIND PR in the same tick you update it** — the re-triggered checks have not run yet; merge on the next sweep once it is `CLEAN`.
- **Don't act on `UNKNOWN` / `HAS_HOOKS`** — GitHub is still computing mergeability; re-check next run.
- **Don't loop waiting on CI** — re-run a failing check at most twice, then report and move on.
- **Don't leave a DIRTY PR silent** — always flag or spawn, per `dirtyPolicy`.
- **Don't touch PRs outside `authorScope`** — the default `mine` scope exists so the watchdog never rebases or comments on unrelated contributors' PRs.
- **Don't write anything in dry-run** — no branch updates, comments, merges, or spawned tasks when `dryRun=true`.
