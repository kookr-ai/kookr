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

## What one cycle does

1. Fetch `main` and the integration branch.
2. If the train is halted and neither branch moved, stop (`halted`).
3. If both point at the same commit, stop (`idle`).
4. If `main` has commits the integration branch lacks, merge `main` into the
   integration branch and push it (`reconciled`). The next cycle verifies it.
5. Verify the integration head. Green: fast-forward `main` to it (`promoted`).
6. Red: verify the same head once more. Green now means a flake: promote it and
   record it in `flakyHeads`.
7. Still red: verify `main` itself, every time, even if the train verified that
   commit earlier. A red `main` means the environment is broken (disk, network,
   host load), so the train halts (`base-red`) and reverts nothing.
8. Otherwise bisect the commits between `main` and the head, then run the first
   bad commit once more. If it passes, a flaky test steered the bisect: nothing
   is reverted and the next cycle starts over (`retry`). If it fails again, the
   last good commit is promoted, the first bad commit is reverted on the integration
   branch, its linked issues are reopened with the failure output, and one fix
   task per PR is spawned (key `train-fix-<pr>-1`). A second failure of the same
   PR does not spawn another task; it notifies `fix-budget-exhausted`.

After each promotion the train closes the still-open issues linked to the PRs
that reached `main` (GitHub does not do it for merges into a non-default
branch). A PR the train reverted reaches `main` together with its revert; its
issue stays open. All train pushes use `--no-verify`, because the repo's pre-push hook
needs a reviewer marker and runs tests; the train's own verify replaces it.

## Commands

Run from inside a Kookr checkout. Each has a pnpm alias: `pnpm train:cycle`, `pnpm train:start`, `pnpm train:stop`, `pnpm train:status`, `pnpm train:logs` and `pnpm train:resume`.

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
(notifications) and `verify-<sha>.log` (20 newest kept).

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
