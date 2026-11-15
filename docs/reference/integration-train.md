# Integration Train

The integration train keeps `main` trustworthy while pull requests merge fast.
Pull requests merge into an integration branch instead of `main`. The train is
a plain script (not an AI agent) that runs the full `pnpm verify` on the
integration head, moves `main` to that exact commit when it is green, and when
it is red finds the commit that broke it and reverts it. `main` only ever
receives a commit the train itself verified.

## Turning it on and off

The feature is configured by one tracked file on `origin/main`,
`.kookr/delivery-gate.json`, for example
`{"integrationBranch":"staging","prePushGate":"fast"}` (see
`scripts/lib/delivery-gate.sh`). With no file, or no such branch on the remote,
a cycle does nothing (`not-configured`). To turn the train off, revert that file
on `main` and run `pnpm train:stop`.

To force the full pre-push gate in every worktree at once, create a file named
`kookr-full-gate` in the git common directory:
`touch "$(git rev-parse --git-common-dir)/kookr-full-gate"`. It changes neither the
integration branch nor the running train; delete the file to go back to the
configured gate.

## What one cycle does

1. Fetch `main` and the integration branch.
2. If the train is halted and neither branch moved, stop (`halted`).
3. If both point at the same commit, stop (`idle`).
4. If `main` has commits the integration branch lacks, merge `main` into the
   integration branch and push it (`reconciled`). The next cycle verifies it.
5. Verify the integration head. Green: fast-forward `main` to it (`promoted`).
   If that push is rejected because `main` moved, nothing else happens and the
   next cycle starts over (`retry`).
6. Red: verify the same head once more. Green now means a flake: promote it and
   record it in `flakyHeads`.
7. Still red: verify `main` itself, every time, even if the train verified that
   commit earlier. A red `main` means the environment is broken (disk, network,
   host load), so the train halts (`base-red`) and reverts nothing.
8. Otherwise find the first bad commit by bisecting the commits between `main`
   and the head, then run that commit once more. If it passes, a flaky test
   steered the bisect: nothing is reverted and the next cycle starts over
   (`retry`). If it fails again, the last good commit is promoted.
9. Revert the bad commit on the integration branch, in the train's own worktree
   and not yet pushed. The bisect assumes the suite went from green to red once;
   that is false when, say, a later commit fixed the culprit and a different
   change broke the head. So the revert commit is verified first. Red: the revert
   would not fix the head, so it is thrown away, nothing is pushed, no issue is
   touched, and the train halts (`revert-not-sufficient`). Green: the revert is
   pushed to the integration branch and the same commit is promoted to `main`
   in the same cycle (it is verified and contains `main`). If that promotion push
   is rejected the outcome is still `reverted` and the next cycle promotes it.
   The train's revert commits carry the trailer `Kookr-Integration-Train: revert`,
   which is how a later cycle tells them from a revert a person made.
10. After a pushed revert, the linked issues of the reverted PR are reopened with
   the failure output and one fix task is spawned. The budget is one automatic
   re-land per linked issue (key `train-fix-issue-<n>-1`). With no linked issue
   the key follows the first `(#N)` in the commit subject (`train-fix-ref-<n>-1`),
   which a cherry-picked re-land keeps. A re-land is a new PR, which is why the
   count follows the issue. The budget is used up only by a task that was really
   spawned: if the spawn fails, the train notifies `fix-spawn-failed` and tries
   again the next time that PR fails. A second failure after a spawned task
   spawns nothing; it notifies `fix-budget-exhausted`.

### When the train halts instead of reverting

A halt stops promotion until `main` or the integration branch moves, or until
you run `pnpm train:resume`. Each one is notified. The train halts rather than
guess in these cases:

| Reason | What happened |
|---|---|
| `base-red` | `main` itself fails verify. The environment is suspect. |
| `verify-infra` | The suite could not run: the checkout or `pnpm install` failed. No commit is blamed. A lockfile that does not match `package.json` (`ERR_PNPM_OUTDATED_LOCKFILE`) is not this case: it is a defect of the commit and is treated as a red test, so the commit can be reverted. |
| `culprit-is-merge` | The first bad commit is the merge that folded `main` into the integration branch. Only commits that contain `main` are bisected, because an older commit can fail for a reason `main` already fixed. |
| `history-shape` | The head is red and the integration branch is not a first-parent line from `main`, which happens after a non-squash merge. The commits cannot be bisected. |
| `revert-not-sufficient` | The suspected culprit was reverted locally but the result still fails verify: another change is failing too, or the culprit was already fixed. The revert is discarded and nothing is pushed. The detail names the suspected culprit. |
| `multiple-failures` | Rare. A revert the train pushed earlier was not promoted yet (its promotion push was rejected) and now fails verify itself, or is the red head. |
| `revert-conflict` | Reverting the culprit conflicts with later commits. |
| `reconcile-conflict` | Merging `main` into the integration branch conflicts. |
| `train-error` | Something unexpected failed inside a cycle, such as `git commit` with no committer identity. The message is in the detail. Halting stops the train from re-running every verify each interval with nobody told. |

## Notifications

Each event the train raises (`halted`, `reverted`, `fix-budget-exhausted`,
`fix-spawn-failed`) is appended to `events.jsonl` and sent to the operator signal
outbox with `kookr signal-emit transition --source integration-train`. That
command only delivers when the status changes between `ok` and `alert`, so the
train first reports `ok` and then `alert` with the event as detail: every event
becomes an alert, even the first one ever. A later cycle that is `idle`,
`promoted` or `reconciled` reports `ok` once more, which delivers the
"recovered" signal after a problem is cleared. A halt that is still standing does
not notify again.

After each promotion the train closes the still-open issues linked to the PRs
that reached `main` (GitHub does not do it for merges into a non-default
branch). Linked issues are found from two places, because GitHub reports no
closing references for a PR that targets a non-default branch: the PR's own
closing references, and the closing keywords in the PR body (`close`, `fix`,
`resolve` and their `-s`/`-d` forms, case-insensitive, then `#<number>`). Only
issues of the same repository count; `owner/repo#n` references and URLs are
ignored. A PR the train reverted reaches `main` together with its revert; its
issue stays open. All train pushes use `--no-verify`, because the repo's pre-push hook
needs a reviewer marker and runs tests; the train's own verify replaces it.

## Commands

Run from inside a Kookr checkout. Each has a pnpm alias except `run`: `pnpm train:cycle`, `pnpm train:start`, `pnpm train:stop`, `pnpm train:status`, `pnpm train:logs` and `pnpm train:resume`.

- `cycle`: run one cycle and exit 0.
- `run [--interval <sec>]`: loop forever (default 60 seconds).
- `start`: launch `run` detached and write `train.pid`.
- `stop`, `status` (JSON), `logs` (last 120 lines).
- `resume`: clear a halt.

Options: `--worktree <path>` (default: a sibling of the launching checkout, `<repo>-train`),
`--verify-cmd "<cmd>"` (default `pnpm verify`), `--workers <n>` (sets
`KOOKR_VITEST_MAX_WORKERS`).

## State files

Under `${KOOKR_DIR:-~/.kookr}/integration-train/`: `state.json` (halt, green
SHAs, flaky heads, fix-task counts), `train.log`, `train.pid`, `train.lock`
(one instance only; a second `cycle` or `run` exits quietly), `events.jsonl`
(notifications), `verify-<sha>.log` (20 newest kept), and
`<idempotency key>.prompt.md` (the prompt handed to a spawned fix task). The state
directory is shared by everything that uses the same `KOOKR_DIR`, so run one train
per host data directory.

The lockfile hash of the last `pnpm install` (`last-install-hash`) is not in that
directory: it sits in the train worktree's private git directory, next to its
ownership marker. It therefore lives and dies with the worktree, and a new or
recreated worktree always installs before its first verify.

The train works in its own linked worktree, by default a sibling of the checkout
it was started from (`<repo>-train`). All checkouts, verifies, reverts and pushes
happen there, never in your checkout. It is kept out of the Kookr data directory
on purpose, because pruning and disk-reclaim jobs operate there.

## Resuming a halt

`status` shows `state.halted.reason`:

- `base-red`: `main` fails verify. Fix `main`; the halt clears by itself once
  either branch moves.
- `reconcile-conflict`: `main` and the integration branch conflict. Merge
  `main` into the integration branch by hand and push.
- `revert-conflict`, `culprit-is-merge`: revert the culprit by hand on the
  integration branch.
- `revert-not-sufficient`, `multiple-failures`: more than one change is failing;
  fix the integration branch by hand (the detail names the suspected culprit).
- `train-error`: read the detail and `train.log`, fix the cause (for example the
  git committer identity), then `pnpm train:resume`.

A halt also clears when `main` or the integration branch moves. To force the
next cycle without moving anything, run `pnpm train:resume`.
