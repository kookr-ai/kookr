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

### Other automation that reads the integration branch

These read the same file through `src/core/delivery-gate-config.ts` (or a
copy pinned to it by a test) and behave as before when it is absent:

- The behind-PR sweep (`.kookr/playbooks/behind-pr-sweep.md`) merges only pull
  requests aimed at the integration branch. One aimed at `main` is skipped,
  because merging it there would bypass the train.
- The merged-PR-by-branch probe and the `delivery-step-stop` hook treat the
  integration branch like `main`: a session on it does not own a delivery.
- `kookr merge` never deletes the integration branch.
- The umbrella-chain advancer still waits until a phase's merge is on
  `origin/main`, because the next phase is cut from there.

## What one cycle does

1. Fetch `main` and the integration branch.
2. If the train is halted and neither branch moved, stop (`halted`).
3. If both point at the same commit, stop (`idle`), unless the train never
   verified that commit: then verify it first (see "Commits that skip the
   train" below).
4. If `main` has commits the integration branch lacks, merge `main` into the
   integration branch and push it (`reconciled`), and send a `main-bypassed`
   notice listing those commits. The next cycle verifies it.
   Otherwise, when the head changes plugin content without a version above
   `main`'s, commit and push a plugin version bump (`version-bumped`, see "The
   plugin version bump" below). The next cycle verifies it.
5. Verify the integration head. Green: fast-forward `main` to it (`promoted`).
   If that push is rejected because `main` moved, nothing else happens and the
   next cycle starts over (`retry`). A push (to `main` or to the integration
   branch) that is rejected three cycles in a row halts the train
   (`push-rejected`): retrying will not get past branch protection or lost
   credentials.
6. Red: verify the same head once more. Green now means a flake: promote it and
   record it in `flakyHeads`.
7. Still red: verify `main` itself, every time, even if the train verified that
   commit earlier. A red `main` means the environment is broken (disk, network,
   host load), so the train halts (`base-red`) and reverts nothing. If the train
   never verified that `main`, it halts `main-unverified-red` instead.
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
   A revert that changes nothing (the culprit was already undone) is never
   verified or pushed: the train halts (`revert-not-sufficient`).
   A pull request that merges into the integration branch while the revert is
   being verified makes the revert push fail (issue #4014). The train does not
   throw the verified revert away: it fetches, re-applies the same revert on the
   new head and pushes it at once, without a second full run, up to three times
   in the same cycle. That re-applied revert is not promoted; the next cycle
   verifies the new head like any other before anything reaches `main`. If the
   re-applied revert conflicts (a later commit touched the same lines) the train
   halts `revert-conflict`. If the culprit was meanwhile reverted, or the revert
   now changes nothing, the train drops it and the next cycle starts afresh
   (`retry`). When the integration head did not move, the refusal is not a race
   (branch protection, credentials), so the train does not re-apply. The cycle
   then ends `retry` and counts towards `push-rejected` as usual, as it does when
   the fetch fails or the three re-applies are used up.
   When revert pushes for the same culprit are rejected twice in a row, the
   train alerts once (`revert-push-rejected`) and keeps going.
   The confirmed culprit is saved in `state.json` (`pendingRevert`) as soon as
   it is confirmed, before the revert is built. A cycle that ends before the
   revert is pushed (a rejected push, a restart, a crash) does not bisect again:
   the next cycle checks that the culprit is still on the integration branch,
   not on `main` and not reverted, and goes straight to the revert. It verifies
   the revert only if no revert of that culprit passed yet. A halt forgets it,
   so the cycle after a person cleared the halt starts from the head again,
   except the halts that say nothing about the culprit: `verify-infra`,
   `push-rejected`, `train-error` and `reconcile-conflict`.
   The train's revert commits carry the trailer `Kookr-Integration-Train: revert`,
   which is how a later cycle tells them from a revert a person made.
10. After a pushed revert, the linked issues of the reverted PR are reopened with
   the failure output and one fix task is spawned. The budget is three automatic
   re-lands per linked issue (keys `train-fix-issue-<n>-1` to `-3`). With no
   linked issue the key follows the first `(#N)` in the commit subject
   (`train-fix-ref-<n>-<attempt>`), which a cherry-picked re-land keeps. A re-land
   is a new PR, which is why the count follows the issue. From the second
   attempt on, the fix task is told how many earlier fix tasks were started,
   to check whether their pull requests were reverted, and to read their
   failing output first. The budget is used up only by a task that
   was really spawned: if the spawn fails, the train notifies `fix-spawn-failed`
   and tries again the next time that PR fails. When a change fails after its
   third fix task, the train still reverts it but spawns nothing; it notifies
   `fix-budget-exhausted` and a human takes over.

### The plugin version bump

Installed kookr-toolkit plugins update only when
`plugin/.claude-plugin/plugin.json#version` changes. Pull requests no longer
bump it (issue #3793): when every plugin pull request edited that one line, two
that bumped to the same value merged without a conflict and shipped one change
unbumped, two that bumped differently conflicted, and each rebase moved the
shared file and voided the review.

The train bumps instead, once per promotion. After the reconcile check (step 4)
and before verify, it compares the integration head with `main`. When files
under `plugin/` other than `plugin.json` differ, and the head's version is not
numerically greater than `main`'s, it commits `main`'s version with the patch
number plus one (`chore(plugin): bump kookr-toolkit to <version>`, trailer
`Kookr-Integration-Train: plugin-version-bump`) on top of the head, pushes it to
the integration branch, and ends the cycle (`version-bumped`). The next cycle
verifies and promotes it like any other head, so `main` still receives only
verified commits. A rejected push counts towards `push-rejected` like the
others. Plugin changes that merge before that promotion ride on the same bump. A
pull request that already ships a higher version gets no extra bump, and a
version that is not `MAJOR.MINOR.PATCH` is left for a person (the train logs
it).

Why not at merge time: a bump pushed to the pull request moves the reviewed
head and adds `plugin.json` to the reviewed files, and the next pull request's
own bump would conflict with it on `staging`. The train's commit changes only
`plugin.json`, which no pull request touches any more, so a pull request rebased
over it keeps its `review-patch-id`.

During a red cycle the bisect can promote a last good commit that sits below
the bump. `main` then carries plugin changes at the old version until the
revert (or a later head) is promoted; it already holds the bump, so nothing is
bumped twice. If the cycle halts instead, the gap lasts until the halt is
resolved.

A pull request may still bump the version by hand (the hook does not reject
it), but it then edits the line the train edits and can conflict with a bump
already on the integration branch, so leave it to the train.

Without an integration branch the train does nothing, and the pre-push hook
asks each pull request to bump the version as before.

The running train loads its code once, at start. A change to this step takes
effect after the train is restarted from an updated checkout.

### Commits that skip the train

`main` should only move when the train promotes it, but a merge can still land
there directly: `pnpm merge` run in an old checkout whose merge script predates
the retarget step did exactly that with PR #3802 (issue #3803). The train
notices such commits in two ways. When a reconcile finds commits on `main` that
the integration branch lacks, it sends a `main-bypassed` notice listing their
subjects; the train does not stop. And whenever `main` points at a commit that
is not in `verifiedGreen`, the train verifies it, even when the integration
branch equals `main`. Green: the commit is recorded and the cycle is `idle`.
Red: the train halts with `main-unverified-red`, naming the commits on `main`
since the newest one it verified. A train with no history (empty
`verifiedGreen`) therefore verifies `main` once on its first cycle. The
plugin's `merge-retarget-guard` hook blocks the old-checkout merge before it
happens; the train's check is the backstop for any merge the hook cannot see.

### When the train halts instead of reverting

A halt stops promotion until `main` or the integration branch moves, or until
you run `pnpm train:resume`. Each one is notified. The train halts rather than
guess in these cases:

| Reason | What happened |
|---|---|
| `base-red` | `main` itself fails verify. The environment is suspect. |
| `main-unverified-red` | `main` fails verify and the train never verified it: it reached `main` without the train. The detail names those commits. |
| `verify-infra` | The suite could not run: the checkout or `pnpm install` failed. No commit is blamed. A lockfile that does not match `package.json` (`ERR_PNPM_OUTDATED_LOCKFILE`) is not this case: it is a defect of the commit and is treated as a red test, so the commit can be reverted. |
| `culprit-is-merge` | The first bad commit is the merge that folded `main` into the integration branch. Only commits that contain `main` are bisected, because an older commit can fail for a reason `main` already fixed. |
| `history-shape` | The head is red and the integration branch is not a first-parent line from `main`, which happens after a non-squash merge. The commits cannot be bisected. |
| `revert-not-sufficient` | The suspected culprit was reverted locally but the result still fails verify: another change is failing too, or the culprit was already fixed. The revert is discarded and nothing is pushed. The detail names the suspected culprit. |
| `multiple-failures` | Rare. A revert the train pushed earlier was not promoted yet (its promotion push was rejected) and now fails verify itself, or is the red head. |
| `revert-conflict` | Reverting the culprit conflicts with later commits. |
| `reconcile-conflict` | Merging `main` into the integration branch conflicts (the merge left unmerged paths). |
| `push-rejected` | A push to `main` or to the integration branch was rejected three cycles in a row (branch protection, credentials). The detail has git's message. |
| `train-error` | Something unexpected failed inside a cycle, such as `git commit` or the reconcile merge with no committer identity, or `git rev-parse`, `git rev-list` or the reconcile checkout failing. The message is in the detail. Halting stops the train from re-running every verify each interval with nobody told. When the refs themselves cannot be resolved, the halt is announced once and later failing cycles stay quiet; it clears by itself once git works again. |

## Notifications

Each event the train raises (`halted`, `reverted`, `fix-budget-exhausted`,
`fix-spawn-failed`, `revert-push-rejected`, `main-bypassed`) is appended to `events.jsonl` and written
to the operator signal outbox (`KOOKR_OPERATOR_SIGNAL_DIR`, default
`~/.kookr/playbook-state/operator-signals`) with source `integration-train`,
title `integration train: <event>` and the event's detail. `main-bypassed` is an
`info` signal, because nothing needs recovering; every other event is an
`alert`.
Every event gets its own file (key `integration-train:<time>-<pid>-<n>:<event>`,
the time zero-padded first), so two events of the same cycle, for example
`fix-spawn-failed` and `reverted`, are both delivered, and a batch the delivery
service sends in file-name order lists them in the order they happened.

After an alert, the first cycle that is `idle`, `promoted` or `reconciled`
writes one `clear` signal, "integration train recovered". It is written once per
problem (`state.json` keeps an `alerting` flag), never while a halt stands, and
not on an ordinary idle cycle. A halt that is still standing does not notify
again.

After each promotion the train closes the still-open issues linked to the PRs
that reached `main` (GitHub does not do it for merges into a non-default
branch). Linked issues are found from two places, because GitHub reports no
closing references for a PR that targets a non-default branch: the PR's own
closing references, and the closing keywords in the PR body (`close`, `fix`,
`resolve` and their `-s`/`-d` forms, case-insensitive, then `#<number>`). Only
the body's prose counts: fenced code blocks at any indentation, indented code
blocks (four spaces after a blank line, outside a list), inline code (also when
it wraps onto the next line), HTML comments, `<pre>` blocks, and quoted lines
(`>`) with the lines that continue them are ignored, so a quoted commit list such as
`fix: resolve #77 crash` closes nothing. Numbers longer than 9 digits are
ignored. Only issues of the same repository count; `owner/repo#n` references
and URLs are ignored. Each number is looked up with the REST issue endpoint
(`gh api repos/{owner}/{repo}/issues/<n>`), and a number that is a pull request
(the answer has a `pull_request` field) is never closed, reopened or given an
issue comment. `pnpm merge` reads the body with the same rules (`body_closing_numbers` in
`scripts/kookr-merge.sh`). A PR the train reverted reaches `main` together with its revert; its
issue stays open. All train pushes use `--no-verify`, because the repo's pre-push hook
needs a reviewer marker and runs tests; the train's own verify replaces it.

## Where to read what happened to a pull request

Each delivery step says what happened, why, and what comes next (issue #3913):

1. **Opening it.** After `gh pr create` in a repository with an integration
   branch, the plugin hook `pr-create-delivery-note` adds a note to the agent's
   context: a base of `main` is expected, `kookr merge <PR>` retargets the pull
   request to the integration branch and merges it there, and the train then
   verifies it and moves `main`. Do not change the base, and do not merge with
   `gh`.
2. **Merging it.** `kookr merge` ends with a `kookr-merge: summary:` block. On
   success (stdout) it gives the merge commit, the branch it went into, why the
   full suite runs on the integration branch, and what the train does next. On a
   refusal (stderr) it names the gate that refused, the evidence it used, and
   the exact command to run next. A task that merged into the integration branch
   is done; it does not wait for `main`.
3. **Afterwards.** The train comments on the pull request whose commit it
   handled: **promoted** (the commit is on `main`, with the head the full suite
   passed on and the time) or **reverted** (the revert commit, the last 20
   lines of the failing output, and what happens next: the fix task and its
   attempt number out of `MAX_AUTOMATIC_RELANDS`, or "needs a human"). Each
   comment carries a hidden marker
   (`<!-- kookr-integration-train:<promoted|reverted>:<sha> -->`). Before
   posting, the train reads the pull request's comments and skips the post when
   the marker is already there, so a retry or a restart never repeats it. A
   comment that fails to post is logged and never stops the cycle. A reverted
   pull request also gets the longer failing output on its reopened issue.

## Supervision

`scripts/prod-restart.sh` (so `pnpm prod:restart` and `pnpm prod:update`)
restarts the train after every deploy when `.kookr/delivery-gate.json` on
`origin/main` names an integration branch. The train then runs the deployed
code, and a host that rebooted gets its train back with the next deploy. The
restart keeps the options of the last start (for example `--worktree` and
`--workers`). A failed restart prints a warning and does not fail the deploy.
`KOOKR_INTEGRATION_TRAIN_SUPERVISE=0` skips the step.

A deploy never kills a verify in flight (issue #3841). Each promotion moves
`main`, and the deploy schedule deploys `main` every 15 minutes, so killing the
verify would restart almost every run from zero. Instead:

- `restart` writes `restart-request.json` in the state directory and returns at
  once. The train finishes its current cycle (verify, then promote or revert),
  then starts a new process from the checkout `restart` ran in, with the same
  options, and exits. `train.pid` then names the new process.
- An idle or halted train has nothing in flight. It checks for a request every
  second between cycles, so the request applies at once.
- With no train running, `restart` starts one, as `start` does.
- The train also re-executes between cycles, without a request, when the
  `HEAD` of the checkout it was launched from is no longer the one it started
  on. A lost request therefore leaves old code running for at most one cycle.
- The old process exits only once the new one's run loop has started (it
  writes `run-info.json`, within 60 seconds). A new process that fails to start
  (bad options, or a deploy that is still installing dependencies) is killed,
  and the old one keeps running. When the checkout's `HEAD` moved, it tries
  again after its next cycle.
- While a request waits, `pnpm train:status` and `/api/health` show
  `restartPending` (with `requestedAt`), and `kookr status` adds
  `restart pending` to its `Integration train:` line.
- `restart --now` keeps the old behaviour: stop the train at once (killing a
  verify in flight) and start a new one. `stop` still stops at once.

Only a train that honours requests gets one. Its run loop writes
`run-info.json` (pid, checkout `HEAD`) when it starts. A train started by
code from before #3841 has no such file; `restart` stops it and starts a new one,
as before. The first deploy of this change therefore still kills one verify.

The production server (port 4800, or `KOOKR_INTEGRATION_TRAIN_MONITOR=1`)
checks every 5 minutes, with `git ls-remote`, whether the integration branch
differs from `main`. When it has differed for 30 minutes
(`KOOKR_INTEGRATION_TRAIN_STALL_MINUTES`) without `main` moving, and the train
is not running or is halted, it sends one operator alert (source
`integration-train-monitor`), and one `clear` when that ends. A train that keeps
promoting resets the clock, so a long verify never alerts. The monitor only
alerts; it never starts or resumes the train. Its state is in
`${KOOKR_DIR}/integration-train-monitor.json`.

`/api/health` shows the train under `integrationTrain` (running, pid, halt,
last cycle, `restartPending`, `pendingSince`, `alerting`), and `kookr status` prints it as one
`Integration train:` line.

## Commands

Run from inside a Kookr checkout. Each has a pnpm alias except `run` and `restart`: `pnpm train:cycle`, `pnpm train:start`, `pnpm train:stop`, `pnpm train:status`, `pnpm train:logs` and `pnpm train:resume`.

- `cycle`: run one cycle and exit 0.
- `run [--interval <sec>]`: loop forever (default 60 seconds).
- `start`: launch `run` detached, write `train.pid` and remember the options.
- `restart [--now]`: make the train run this checkout's code, with the options
  given, else those of the last start, else those of the running process. A
  running train restarts itself once its current cycle ends; `--now` stops it at
  once instead (see Supervision).
- `stop`: signal the train and wait up to 30 seconds for it to exit. Only a
  process whose command line is the train's `run` loop is signalled, so a stale
  `train.pid` naming a reused pid is left alone.
- `status` (JSON), `logs` (last 120 lines).
- `resume`: clear a halt.

Options: `--worktree <path>` (default: a sibling of the launching checkout, `<repo>-train`),
`--verify-cmd "<cmd>"` (default `pnpm verify`), `--workers <n>` (sets
`KOOKR_VITEST_MAX_WORKERS`).

The verify also runs with `KOOKR_VERIFY_FLAKY_RERUN=1`, so `scripts/verify.sh` applies the pre-push hook's flaky policy to the unit lane: when at most five test files fail they are re-run once, a pass continues and is logged to `<git common dir>/kookr-flaky-tests.log`, and a second failure is a red result.

The train also sets `KOOKR_VERIFY_REPORT_FILE`, so `scripts/verify.sh` writes a small JSON file next to the log, `verify-<sha>.report.json`, naming the lanes and steps that failed and, for the unit lane, the failing test files (see `scripts/verify-report.mjs` for the format). A red run's report is kept with its log as `verify-<sha>.run<n>.report.json`. The train does not read it yet: issue #3995 plans to bisect a red head with only the lane or test files that failed.

In that mode `scripts/verify.sh` also gives each test a 60 s timeout instead of 15 s (`KOOKR_VITEST_TEST_TIMEOUT_MS`), and, once `build:server` has written `dist/`, runs the unit suite at the same time as the other static checks, the hook tests and the STT tests; the integration, FAA and smoke lanes follow. A developer's plain `pnpm verify` keeps the sequential order. In every mode, the unit suite runs the files in `scripts/lib/vitest-serial-files.mjs` (they spawn real processes or race timers) after the rest, one at a time, with two retries (issue #3794).

## State files

Under `${KOOKR_DIR:-~/.kookr}/integration-train/<owner>-<repo>/` (the `origin`
remote's name, so every checkout of one repository shares it and two
repositories never do): `state.json` (halt, green
SHAs, flaky heads, fix-task counts, whether an alert awaits its recovery signal,
consecutive rejected pushes, a confirmed culprit whose revert is not pushed yet),
`train.log`, `train.pid`, `train.lock`
(one instance only; a second `cycle` or `run` exits quietly), `events.jsonl`
(notifications), `verify-<sha>.log` (20 newest kept) with its
`verify-<sha>.report.json`, and
`<idempotency key>.prompt.md` (the prompt handed to a spawned fix task),
`last-cycle.json` (outcome of the newest cycle), `start-args.json` (options of
the last `start`), `run-info.json` (pid and checkout `HEAD` of the running loop)
and `restart-request.json` (a restart waiting for the cycle to end).

Before #3796 the state sat directly in `integration-train/`. A train started by
that older code keeps using it until it is restarted. While it runs, the new
code's cycles wait. Once it has exited, the first cycle moves its state (halt,
fix-task budget, alert flag, logs) into the keyed directory.

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
- `main-unverified-red`: a commit that skipped the train broke `main`. Merge a
  fix through the integration branch as usual; the train verifies the new head
  and promotes it. `pnpm train:resume` alone only re-runs the same red verify.
- `reconcile-conflict`: `main` and the integration branch conflict. Merge
  `main` into the integration branch by hand and push.
- `revert-conflict`, `culprit-is-merge`: revert the culprit by hand on the
  integration branch.
- `revert-not-sufficient`, `multiple-failures`: more than one change is failing;
  fix the integration branch by hand (the detail names the suspected culprit).
- `push-rejected`: read git's message in the detail, fix the cause (branch
  protection for the train's pushes, credentials), then `pnpm train:resume`.
- `train-error`: read the detail and `train.log`, fix the cause (for example the
  git committer identity), then `pnpm train:resume`.

A halt also clears when `main` or the integration branch moves. To force the
next cycle without moving anything, run `pnpm train:resume`.
