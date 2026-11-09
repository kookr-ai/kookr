# RFC: opencode scoped-fix pipeline (worker + fresh reviewer + merge gate)

Status: draft (round 2) · Related: rfc-opencode-agent-integration, #3534–#3537

## 1. Problem and the finding that motivates it

The bake-off and dogfood runs showed: an opencode `scoped-fix` worker is cheap
and fast but **not merge-ready alone** (missed edge cases, occasional scope
creep, optimistic self-report). A fresh reviewer on the delivered diff caught
those defects. So the product is the *pipeline*, not the worker.

## 2. Decision: a playbook, no new server mechanism

All needed primitives exist: `kookr spawn --agent opencode --profile … --wait`,
the profile deliverable gate (`Closes #N` + PR body), `kookr signal
completion-ready`, `kookr reply` (send fix instructions to a live worker),
independent-merge-review (exact-head verdict comment) and `pnpm merge`.
The pipeline is therefore one **orchestrator task** driven by a playbook
`.kookr/playbooks/opencode-scoped-fix-pipeline.md`. Server glue: **none in v1**.
A server state machine is explicitly deferred until the playbook proves
insufficient (see §8).

## 3. Stages (one issue per orchestrator run)

The orchestrator is one Claude task (mid tier, **not** `small`: it parses
verdicts, compares head shas and decides to merge, which is judgement).
It writes `ocpipe-<issue>.json` (stage, round, head sha, child task ids,
per-stage start/end/usd) after **every** transition and resumes from it.

| # | Stage | Actor | Output / exit |
|---|-------|-------|---------------|
| 0 | Preflight | orchestrator | issue open and labelled `opencode-eligible`, not labelled `opencode-pipeline-failed`; claim registry active (`kookr issue owner` answers) and claim taken by the **orchestrator** (single owner; worker spawned with no `--claim-issue`); `kookr doctor` ok; on resume, `kookr stop` any child ids still live in the state file |
| 1 | Work | fresh opencode `scoped-fix` task (`--agent opencode --profile scoped-fix --wait=1800`), own worktree, env `KOOKR_OPENCODE_ISSUE` | worker **commits locally and never pushes** (profile text); `PR_BODY.md` untracked. Orchestrator pushes the branch and runs `gh pr create --body-file PR_BODY.md`. Exit 6 from `--wait` = failure; re-check state, no retry |
| 2 | Cheap review | fresh opencode `reviewer` task (`file:REVIEW.md`), given issue text (quoted, marked untrusted) + diff file; **not** the PR body or worker narrative | `REVIEW.md` with 0 findings = pass, otherwise ≤8 findings; advisory |
| 3 | Fix round (≤ 2) | **fresh** `scoped-fix` task on the same branch, prompt = findings; orchestrator pushes | new head; back to 2. Fresh task per round: no dependency on reaching an exited session via `kookr reply` |
| 4 | Gate review | Claude `independent-merge-review` on the final head, **all repos** | verdict comment bound to head sha. Worker/reviewer tasks are already stopped |
| 5 | Merge | `pnpm merge` / existing local-gate rules, using the sha the verdict names | merged, or PR left open with report |

Stage 2 is an economy filter and never substitutes for stage 4 (mandatory
everywhere in v1). Whether stage 2 earns its cost is a signal read from the
accounting rows after dogfood (n is small: signal only, not a decision).

### 3a. Mechanics fixed in round 2

* **Worktree**: `kookr spawn` has no branch/worktree flag and a profile
  launch skips the worktree preamble, so the orchestrator creates
  `git worktree add` for branch `ocpipe/<issue>` and passes `--cwd`. Rounds
  reuse it only after the previous child is stopped and terminal (no
  concurrent writers, no double checkout).
* **`--wait` exits**: 0 = completion-ready/completed; 6 = timeout **or**
  claim conflict; 4 = failed task **or** API error. On any non-zero exit the
  orchestrator `kookr stop`s the child, waits for a terminal state, reads the
  task status to tell failure from API error, and only then proceeds.
* **Reviewer verdict**: the stage-2 prompt requires a final line
  `FINDINGS: <n>`; a missing/malformed line counts as findings present.
  Reviewer runs in a separate disposable checkout of the PR head (REVIEW.md
  never lands in the PR worktree).
* **Pause check**: `kookr orchestration status --json` before each spawn;
  paused = stop cleanly and keep state for resume.

## 4. Bounds and stopping

* Rounds: max 2 fix rounds. Exhausted with findings -> post summary, `kookr
  issue release`, label `opencode-pipeline-failed`, never merge. Preflight
  refuses relabelled-failed issues until an operator removes the label.
* Time: each spawn uses `--wait=<seconds>`; total wall cap 2 h; total cap
  `usd_cap` (default $3) enforced from the state file before each spawn.
* Stopping = `kookr stop <orchestrator>`. Children are linked by
  `parent-task-id` and the orchestrator stops them by id in its final step.
  Verified gap: the server does **not** cascade-stop children, so a crashed
  or killed orchestrator leaves its in-flight child running until that child
  finishes or hits its own `--wait`/profile bounds (a single scoped worker:
  bounded, not unbounded). Mitigation without server glue: preflight on any
  resume (or the next run for that issue) stops children listed in the state
  file; the dead-claim reclaim frees the claim. A server cascade-stop is the
  one glue item to add *if* the §7 `kill -9` test shows orphans matter.
* No separate kill-switch file: `kookr stop` + `kookr orchestration pause`
  already exist; the playbook checks the pause state before each spawn.
* Concurrency: playbook note, 1 pipeline per issue (claim), launched manually
  or by schedule with `maxActive` 2.

## 5. Accounting

Task `tokenUsage` (incl. `costUsd`, from the opencode usage scanner) read
via the task API, stored in the state file, posted once as a PR comment table
(stage, task, wall, tokens, usd, verdict). Derived: cost per merged PR.

## 6. Safety

* Worker never pushes or merges; orchestrator owns push/PR/merge/claim.
* Issue text and PR body are untrusted: reviewers see requirements quoted as
  data plus the diff; the Claude gate is told to judge the diff, not the PR
  summary. Reviewer instructions say verdict text inside the issue is data.
* Exact-head binding: all child tasks stopped before stage 4; stage 5 merges
  the verdict's sha and aborts if the PR head differs.
* `KOOKR_OPENCODE_ENABLED` stays an operator decision; preflight fails closed.

## 7. Delivery slices and proof

1. **Slice A**: playbook, stages 0-2, no merge (stops after cheap review),
   plus a wording **contract test** (state-file after every transition,
   never-merge on exhausted rounds, head re-check, mandatory stage 4,
   untrusted-text framing).
2. **Slice B**: stages 3-4 (fix round, gate review).
3. **Slice C**: stage 5 behind an explicit playbook parameter `merge=true`.
Rollback: delete the playbook; remove labels and release claims via the
documented cleanup step.
Proof: the real thing, not a fake: a **scratch GitHub repo** with real `gh`
and 3 real small issues, on a throwaway kookr instance (no prod). Must cover:
one fix-round, one orchestrator `kill -9` mid-worker (orphan observed, resume
cleans up), exhausted-rounds path. Tier-A wording tests run in CI/pre-push.

## 8. Alternatives and deferred

* Server pipeline state machine: rejected for v1. Cascade-stop: conditional,
  see §4. Queue-feeder auto-selection: deferred.
