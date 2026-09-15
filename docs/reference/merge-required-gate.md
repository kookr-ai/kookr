# Merge-required gate (issue #1836)

Hard boundary on `completion_ready` for tasks that hold **merge authority**: a
child that was told to merge its PR cannot be retired as completed after only
opening the PR.

Complements the prompt-side TERMINAL-STATE CONTRACT and the
pr-merge-rebase-watchdog janitor. Same enforcement pattern as the
[lesson-decision gate](./lesson-decision-gate.md) (#1538).

## Surfaces

| Surface | Behavior |
|---------|----------|
| `POST /api/tasks/:id/signal` (`kind=completion_ready`) | `409` with `code: "merge_required"` when the gate refuses; signal is **not** recorded |
| Signal outbox drain | Same check; rejection → `permanent_fail` (entry dropped) |
| Human `POST /api/tasks/:id/complete` | **Not** gated |

## Opt-in (merge authority)

The gate is off unless the task declares merge authority via any of:

1. Explicit stamps: `mergeRequired: true`, `terminalState: "merged-pr"`, or the
   same keys under `metadata`
2. Playbook param: `playbookParameterValues.mergeAfterImplementation` is
   `"true"` or `"1"`
3. Prompt text: `TERMINAL-STATE CONTRACT (mergeAfterImplementation=true)` (or
   the same policy language near “merge authority” / `mergedAt`)

Tasks without one of those stamps are unaffected. The pre-authorized launch
preamble may still instruct the agent to merge the operator's own PRs; this
gate only enforces playbook/contract opt-in so OSS playbooks are not forced
to merge upstream.

## Evidence

Scanned from PreToolUse shell commands in `~/.kookr/hooks/<tmuxSession>.jsonl`
(Claude `Bash` + Grok `run_terminal_command` shapes):

| Signal | Detection |
|--------|-----------|
| PR opened | `gh pr create` |
| Merge (trail fallback) | `gh pr merge`, `pnpm merge`, `kookr-merge.sh` |
| Blocker (waives merge) | literal `PR-BLOCKER:` (e.g. `printf 'PR-BLOCKER: …'`) |
| Live verification | `gh pr view <n> --json mergedAt` — non-null `mergedAt` preferred over trail merge intent |

When live check is available for the PR numbers in the trail, it **wins** over a
PreToolUse merge command (a failed merge attempt must not green-light
completion). When `gh` is unavailable, trail merge commands are the hermetic
fallback.

## Fail-open table

| Condition | Result |
|-----------|--------|
| Gate disabled (`KOOKR_MERGE_REQUIRED_GATE=0\|false\|off\|no`) | Allow |
| No merge authority | Allow |
| No hooks directory configured | Allow |
| Merge authority, no `gh pr create` in trail | Allow (gate only covers open-but-unmerged) |
| Merge authority + create + merge verified or `PR-BLOCKER:` | Allow |
| Merge authority + create + unmerged + no blocker | **409 `merge_required`** |

## Env

See `KOOKR_MERGE_REQUIRED_GATE` in [environment-variables](./environment-variables.md).

## Recovery for agents

1. Merge the PR (`pnpm merge <n>` / `gh pr merge <n>`), confirm
   `gh pr view <n> --json mergedAt` is non-null, **or**
2. Record a blocker: `printf 'PR-BLOCKER: %s\n' '<reason>'`
3. Re-run `kookr signal completion-ready`

## Preserving branches for paired delivery

Paired delivery coordinates a change reviewed in two repositories. When either
source branch is still needed for audit, replay, or the second repository's
merge, request preservation on each affected PR:

```bash
bash scripts/kookr-merge.sh <PR_NUMBER> --repo OWNER/REPO --preserve-branch
```

The wrapper omits `--delete-branch` from `gh pr merge` and skips the source-ref
DELETE request in its REST fallback, including when the source is in a fork.
This controls deletion by the wrapper; it does not override GitHub repository
settings or other automation that may delete branches after merge.

Without a branch option, the wrapper requests deletion after merging. The
explicit `--delete-branch` option selects the same default. Passing both branch
options is an error, in either order. Unknown options and conflicting branch
options are rejected before any GitHub request.

Preservation changes only branch cleanup. It grants no exemption from independent
review, merging the exact reviewed commit, required checks, or mergeability.
Both merge paths require GitHub to confirm the PR has merged (`.merged == true`),
so a queued merge is not reported as complete. The caller remains responsible
for deleting each preserved branch once paired delivery and its audit or replay
needs are complete. Preservation does not waive the completion gate: verify the
PR's non-null `mergedAt` as usual.
