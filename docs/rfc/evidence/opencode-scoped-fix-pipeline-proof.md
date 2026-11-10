# opencode scoped-fix pipeline: real-world proof (RFC section 7)

Date: 2026-11-10. Subject: `docs/rfc/rfc-opencode-scoped-fix-pipeline.md` and the playbook
`.kookr/playbooks/opencode-scoped-fix-pipeline.md` (merged in #3554). Raw artefacts:
[`opencode-scoped-fix-pipeline-proof-data/`](opencode-scoped-fix-pipeline-proof-data/) (state files, reviewer
output, verdict and accounting comments, kill logs, per-task token and cost rows).

## Verdict in one paragraph

The playbook works as designed on real runs: the pipeline went worker -> cheap review -> fix round -> gate review,
a killed orchestrator was resumed and cleaned up its live orphan, the exhausted path never merged, and a re-run on a
failed issue was refused at preflight. It also showed that the **orchestrator, not the workers, is the cost**
(about $13.30 against $0.11 for all ten opencode children) and exposed four playbook problems, two fixed here
and three filed (#3580, #3581, #3582). Merge (slice C) was **not** exercised and stays off. n is three issues on
a tiny repo: this is proof that the mechanism functions, not a measurement of its quality rate.

## Setup (all hermetic)

* Throwaway Kookr server from this worktree: port 48731 (data dir `~/.kookr-48731`), rebuilt environment
  (`env -i`), `KOOKR_ISSUE_CLAIMS=true`, `KOOKR_OPENCODE_ENABLED=1`, pinned opencode 1.19.5, `NB_DIR` and the
  opencode seed in a temp directory, `KOOKR_HOST_STALE_DTACH_REAP=0`. Port 4800, `~/.kookr` and `kookr-prod` were not
  touched. The real `HOME` was kept because the Claude orchestrator and the `gh` login need it. The server was
  stopped by its recorded PID at the end.
* Scratch repo `jeanibarz/kookr-pipeline-proof-scratch` (private, real `gh`): a dependency-free Node library with a
  PR template, `npm test` and both pipeline labels. Three real issues, written for this proof, each labelled
  `opencode-eligible`:
  1. `slugify(input, { maxLength })`: edge-case-rich criteria (accents, truncation, error types).
  2. `parseDuration(text)`: ordering, repetition and decimal rules, error types.
  3. `median(values)` with four hard requirements that cannot all hold (no mutation, no copy, O(1) extra memory,
     worst-case O(n)). This was written to make the budget-exhausted path reachable honestly, **without editing the
     playbook or any reviewer prompt**.
* Workers and reviewers: opencode `scoped-fix` / `reviewer` profiles on `deepinfra/deepseek-ai/DeepSeek-V4.1-Flash-1017`.
  Orchestrator: Claude. `mergeEnabled=false` and `usdCap=3` in every run.
* Launch: a `launchPlaybook` WebSocket message (playbook from this worktree, task cwd in the scratch clone). Run 1
  used the operator default model (`fable`); runs 2-4 pinned `claude-sonnet-5-5` through
  `POST /api/tasks` with the playbook-rendered prompt (see defect 4).

## Results against the RFC proof list

| RFC requirement | Result | Where |
|---|---|---|
| (a) one full run worker -> independent review -> fix round -> gate review | **Done, ended in BLOCK.** Run 1 used 2 fix rounds and the gate ran once (BLOCK on a bug the cheap reviewer had passed). Run 2 reached a gate **PASS** bound to the PR head but needed no fix round. No single run did both fix round and gate PASS. | runs 1, 2 |
| (b) orchestrator `kill -9` mid-worker, resume cleans up the orphan | **Done twice.** Run 3 shows a live orphan stopped by the resumed orchestrator; run 2 shows the orphan finishing on its own before resume. | kill tests below |
| (c) exhausted-rounds path never merges | **Done (run 1)**, plus a stage-1 timeout failure (run 3) and the preflight refusal of a failed issue (run 4). | runs 1, 3, 4 |
| Merge | **Not run.** `mergeEnabled` stayed false. | see "Merge" |

### Run 1: issue 1 (`slugify`), PR #4, fable orchestrator, ended exhausted

| Stage | Task | Wall (s) | USD | Result |
|---|---|---|---|---|
| work | `41c1d436` | 75 | 0.0063 | 1 commit, 9 tests pass |
| cheap review | `4d88418a` | 46 | 0.0054 | **3 findings**: HIGH `ß æ œ ł đ ﬁ` deleted instead of folded (`Straße` -> `stra-e`), plus a test gap and a LOW |
| fix round 1 | `335e7848` | 87 | 0.0094 | 1 commit |
| cheap review | `46745659` | 77 | 0.0091 | 0 findings |
| gate review (Claude subagent) | n/a | 160 | not metered | **BLOCK** on `3f51387`: truncation drops a whole word that fits (`slugify("abc def ghi", {maxLength: 7})` gave `"abc"`, expected `"abc-def"`), a bug **introduced by fix round 1** |
| fix round 2 | `4c5f9913` | 57 | 0.0076 | 1 commit (`63849d1`) |
| cheap review | `db704684` | 132 | 0.0143 | 1 finding, LOW: a test title promises whole-word truncation the code does not do |

Round budget exhausted with one LOW finding left, so the playbook took the failure exit. Verified afterwards: issue
labelled `opencode-pipeline-failed`, summary comment on the issue, accounting table on the PR, claim released
(`no active claim`), PR #4 left open and unmerged, no merge. Children total $0.052; the orchestrator was at about
$9.5 at the failure exit.

What the reviewers caught: the cheap reviewer found a real HIGH defect in the first draft for half a cent. It then
**passed a head the gate blocked**, which is the RFC's stated reason for a mandatory stage 4. The gate found a
defect that a fix round had created. The pipeline also ended on a LOW finding without ever gate-reviewing the final
head (defect 3, #3581).

### Run 2: issue 2 (`parseDuration`), PR #5, sonnet orchestrator, killed once, resumed, ready-for-merge

Worker `f73adca4` (72 s, $0.0070, 1 commit with `Closes #2`, 9/9 tests), cheap review `817e5edb` ($0.0062,
`FINDINGS: 0`), gate: fresh-context Claude reviewer, 43 s, 64,672 tokens, **PASS** with `review-head-sha` equal to
the PR head `0ee54ada`. `mergeEnabled=false`, so the orchestrator left the PR open and reported `ready-for-merge`,
posted one accounting comment and released the claim. The gate's non-blocking notes (`"1.1h"` gives
`3960000.0000000005`; a very long digit string gives `Infinity`) are on the PR and were not acted on. Orchestrator
cost: $0.22 (the killed one) + $0.86 (the resumed one).

### Run 3: issue 3 (`median`), no PR, sonnet orchestrator, killed once, resumed, stage-1 timeout

Worker 1 was still running when its orchestrator was killed and was cancelled by the resumed orchestrator (see below). Worker 2 `1a5511f9` ran the full 30-minute `--wait=1800`
(1851 s, $0.0414, 32k output tokens), produced no commit, and `--wait` timed out. The orchestrator stopped it and
took the failure exit: no push, no PR, issue labelled `opencode-pipeline-failed`, claim released. Its issue comment
correctly named the likely cause (the four constraints are close to unsatisfiable together). This is the honest
outcome for an infeasible issue: bounded cost, no bad PR.

### Run 4: preflight refusal

A re-run of the playbook on issue 1 (already labelled `opencode-pipeline-failed`) stopped at stage 0: no claim, no
worktree, no spawn, no label or comment change, $0.13 of orchestrator cost.

## Kill -9 tests (b)

| | Run 2 | Run 3 |
|---|---|---|
| Killed process | `claude` pid 2074488 (orchestrator `d3ee66f9`) | `claude` pid 2164139 (orchestrator `71e25363`) |
| Kill time (UTC) | 18:08:34 | 18:21:49 |
| Worker at kill | `f73adca4` running; its id already in the state file (written 18:07:50) | `b2697493` running; id in state file |
| Worker afterwards | `completed` by itself within about 10 s | still `inProgress` 24 s after the kill, `cancelled` by 18:22:18 |
| Who ended it | the worker finished | the **resumed orchestrator's preflight** (`kookr stop` on the live child), which also saved the orphan's partial edit as `aborted-child-b2697493.diff` and started a fresh worker |
| Dead orchestrator in Kookr | `inProgress` for about a minute, then `terminated` | `terminated` (time not recorded) |
| Claim | held by the dead task until it was reaped; the resume orchestrator then took it without conflict | taken by the resume orchestrator without conflict (timing not recorded) |
| Resume | `4dba9dd9` marked the finished child terminal (18:10:10), pushed and opened PR #5, finished the pipeline | `84139651` launched 4 s after the kill |

Conclusions: the state file does hold the child id before the kill (so "record at once" is satisfiable);
`kookr stop` on resume cleans a live orphan; the orphan is bounded by its own wait and profile limits and cost about
a cent here; the server reaped the dead orchestrator and freed the claim without help. The RFC's conditional item,
**server cascade-stop, is not justified by this evidence**: nothing was observed that resume did not already fix.
Caveat: only one live-orphan observation (run 3, a 24-second window).

## Merge (slice C)

Not exercised. Slice C is "stage 5 behind `mergeEnabled=true`"; a merge into a throwaway scratch repo would say
nothing about the real merge path (`pnpm merge` and the exact-head check on kookr-ai/kookr), and run 2 already shows
the stage-4-to-5 head binding (verdict sha equals PR head). The flag stays `false` by default; turning it on needs a
real-repo supervised run first.

## Cost and time

| | USD | Notes |
|---|---|---|
| 10 opencode children (6 workers, 4 reviewers; Kookr `costUsd`) | 0.114 | $0.005 to $0.041 each; the 30-minute failed worker is the largest |
| Claude orchestrators, fable (run 1) | 11.22 | about $9.5 at the failure exit; the rest was report polishing before it was stopped |
| Claude orchestrators, sonnet (runs 2-4 incl. one blocked start) | 2.07 | $0.19 blocked start, $0.22 + $0.86 run 2, $0.22 + $0.46 run 3, $0.13 run 4 |
| Gate reviews (Claude subagents) | not metered | token counts only; see defect 4 |

Wall time: run 1 from launch to failure exit about 28 minutes (about 10.5 minutes of child stages; the rest is
orchestrator thinking and the first cold launch); run 2 from launch to ready-for-merge about 12 minutes including
the kill and the resume. A normal opencode worker or reviewer stage took 46-175 s.
Cost per merged PR (RFC section 5) is not computable: nothing was merged and the gate is unmetered.

## Playbook defects found

| # | Defect | Action |
|---|---|---|
| 1 | State file path used `$KOOKR_TASK_DATA_DIR`, which Kookr never sets; the fallback `~/.kookr/ocpipe` is the **production** data dir even when the server is a throwaway. | Fixed here: documented fallback derived from the server port; harness sets the variable. |
| 2 | Preflight `kookr doctor ok` is not a usable gate. It exits 1 on this host from the kookr checkout (an unrelated required Grok-auth check) and its dtach lookup is cwd-relative, so it also fails (EACCES/ENOENT) from the scratch repo. The fable orchestrator waved the failure through and the sonnet orchestrator failed closed (run 2 first start, $0.19). Behaviour therefore depended on the model. | Fixed here: gate on `kookr status --require-ready`; wording pinned by a new contract test. |
| 3 | Helper files written by the orchestrator landed loose in the shared state directory, so a later issue would read an earlier one's leftovers (observed after run 1). | Fixed here: namespace helpers per issue; pinned by test. |
| 4 | `kookr spawn --wait` returns exit 0 after about 10 s on a cold first opencode launch (reconcile-probe path ignores `--wait`), breaking the "0 = done" contract. Seen in run 1 on the first spawn. | #3580 |
| 5 | A single LOW cheap-review finding after the last round fails the pipeline without gating the final head; the stage-2 prompt is orchestrator-authored and added a category the playbook does not define. | #3581 |
| 6 | The orchestrator costs two orders of magnitude more than the workers; "mid tier" has no mechanism (`MODEL_TIERS` is `['small']`); playbook launches cannot pin a model; the gate review is unmetered; the fable orchestrator kept spending after its work was done. | #3582 |

The first three came from the merged playbook as written; runs 2-4 used the patched playbook, run 1 the original.
Run 1's cold-start behaviour and `kookr doctor` outcome are therefore from the unpatched text.

## Honest limits

n=3 small, well-specified issues on a dependency-free scratch repo; one cheap model; one gate model; no merge. The
opencode reviewer and the gate disagree on one head out of three, which is a signal about stage 2's reach, not a rate.
Run 1 and runs 2-4 used different orchestrator models and different playbook texts, so their orchestrator costs and
behaviour are not like-for-like. The scratch repo's account-level Codex review app also commented on the PRs; that
is outside the pipeline and was not counted.

## Scratch repo

`jeanibarz/kookr-pipeline-proof-scratch` (private) is **left in place**: the `gh` token on this host lacks the
`delete_repo` scope, so it could not be deleted here. The evidence it holds (issues 1-3 with the pipeline's comments,
PRs #4 and #5, branches `ocpipe/1` and `ocpipe/2`) is copied into the data directory above. To delete it:
`gh auth refresh -s delete_repo && gh repo delete jeanibarz/kookr-pipeline-proof-scratch --yes`.
