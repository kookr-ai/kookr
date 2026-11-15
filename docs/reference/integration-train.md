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
   (`retry`). If it fails again, the last good commit is promoted and the bad
   commit is reverted on the integration branch.
9. After a revert, the linked issues of the reverted PR are reopened with the
   failure output and one fix task is spawned. The budget is one automatic
   re-land per linked issue (key `train-fix-issue-<n>-1`), or per PR when it has
   no issue. A re-land is a new PR, which is why the count follows the issue. A
   second failure spawns nothing; it notifies `fix-budget-exhausted`.

### When the train halts instead of reverting

A halt stops promotion until `main` or the integration branch moves, or until
you run `pnpm train:resume`. Each one is notified. The train halts rather than
guess in these cases:

| Reason | What happened |
|---|---|
| `base-red` | `main` itself fails verify. The environment is suspect. |
| `verify-infra` | The suite could not run: the checkout or `pnpm install` failed. No commit is blamed. |
| `culprit-is-merge` | The first bad commit is the merge that folded `main` into the integration branch. Only commits that contain `main` are bisected, because an older commit can fail for a reason `main` already fixed. |
| `multiple-failures` | The head is still red at a commit that already reverts an earlier culprit, so a second change in the same batch is failing and commit bisection cannot separate them. |
| `revert-conflict` | Reverting the culprit conflicts with later commits. |
| `reconcile-conflict` | Merging `main` into the integration branch conflicts. |

After each promotion the train closes the still-open issues linked to the PRs
that reached `main` (GitHub does not do it for merges into a non-default
branch). A PR the train reverted reaches `main` together with its revert; its
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
(notifications), `verify-<sha>.log` (20 newest kept), `last-install-hash` (the
lockfile hash of the last `pnpm install` in the train worktree) and
`<idempotency key>.prompt.md` (the prompt handed to a spawned fix task).

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

A halt also clears when `main` or the integration branch moves. To force the
next cycle without moving anything, run `pnpm train:resume`.
