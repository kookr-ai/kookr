# RFC: opencode scoped-fix pipeline (worker + fresh reviewer + merge gate)

Status: draft (round 1) · Related: rfc-opencode-agent-integration, #3534–#3537

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

| # | Stage | Actor | Output / exit |
|---|-------|-------|---------------|
| 0 | Preflight | orchestrator | kill-switch file absent; issue open, unclaimed, labelled `opencode-eligible`; `kookr doctor` ok; claim via `--claim-issue` |
| 1 | Work | opencode `scoped-fix`, own worktree | branch + PR (draft) with gate-validated body; else stage fails |
| 2 | Cheap review | opencode `reviewer` (fresh task, sees diff+issue only) | verdict `PASS`/`BLOCK` + findings, advisory |
| 3 | Fix loop (≤ 2 rounds) | orchestrator `kookr reply`s findings to worker (same session), worker pushes | new head; back to 2 |
| 4 | Gate review | Claude `independent-merge-review`, exact head | `kookr-review-verdict` comment bound to head sha |
| 5 | Merge | existing `pnpm merge` rules (local gate, label, hard-gate verdict) | merged, or PR left open with report |

Stage 2 is an economy filter: it removes cheap-to-catch defects before the
expensive Claude gate. It is **never** a substitute for stage 4. On
`kookr-ai/kookr` stage 4 is mandatory; the opencode reviewer's PASS grants
nothing.

## 4. Bounds and kill-switch

* Max 2 fix rounds (stage 3). After round 2 with BLOCK → stop, post a
  summary on the issue, release claim, label `opencode-pipeline-failed`.
  Never merge on exhausted budget.
* Per-stage wall-clock timeouts (worker 30 min, reviewer 10 min, gate 10 min);
  timeout = stage failure, not skip.
* Kill-switch: file `~/.kookr/opencode-pipeline.disabled` (checked at stages
  0, 3 and 5) and `kookr stop` on the orchestrator; stopping it must also stop
  children (orchestrator stops its child tasks by id in a trap-like final
  step; children are linked via parent-task-id so the dashboard shows them).
* Concurrency: one orchestrator per issue (idempotency key
  `ocpipe-<repo>-<issue>`); scheduler caps parallel pipelines at 2 (hermetic
  runs: 1).

## 5. Accounting

Orchestrator writes `ocpipe-<issue>.json` in the task data dir: per stage
`{task_id, start, end, wall_s, tokens_in/out, usd}` from the existing usage
scanner (`kookr peek --json` / task usage), plus verdict and round count, and
posts a one-table summary comment on the PR. This gives cost per merged PR
and the pass-rate of stage 2 vs stage 4 (does the cheap reviewer predict the
gate? — the metric that decides whether stage 2 is worth keeping).

## 6. Safety

* Worker never merges and never edits outside its worktree (profile + gate).
* Orchestrator uses a small-tier model (`modelTier: small`) — it only runs
  commands; judgement lives in the reviewers.
* Issue content is untrusted: passed to the worker as data in the profile
  prompt; reviewer gets requirements + diff, not the worker's narrative.
* Exact-head binding: any worker push after a verdict invalidates it;
  orchestrator re-runs stage 4 on the final head only (stage 2 may re-run).
* Production flag `KOOKR_OPENCODE_ENABLED` is an operator decision; the
  playbook fails preflight when opencode is unavailable.

## 7. Proof plan (hermetic first)

Hermetic fixture repo (local bare remote, `gh` shim) with 3 real small issues
replayed from agent-notebook history. Success: each ends merged-or-reported with
the accounting file; at least one run exercises the fix loop; one run
exercises kill-switch mid-stage; no stray processes/worktrees afterwards.

## 8. Alternatives and deferred

* Server-side pipeline state machine: rejected for v1 — more code, more
  failure modes, no evidence yet that the playbook cannot hold state in a
  JSON file.
* Dropping stage 2 (opencode reviewer): decided by the §5 metric after the
  3 issues, not on priors.
* Auto-selecting eligible issues (queue feeder integration): deferred; v1 takes
  an explicit issue number.
