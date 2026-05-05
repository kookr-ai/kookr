---
name: Reviewer Distillation
description: Measure and improve AI code review prediction accuracy for a repository by running blind reviews, judging against human feedback, and mutating the reviewer skill
cwd: /home/jean/git/kookr
parameters:
  - name: repo
    description: "GitHub owner/repo (e.g., grafana/grafana)"
    required: true
    type: select
    source: tracked-projects
  - name: batchSize
    description: "PRs per iteration (default 3)"
    required: false
    default: "3"
  - name: maxIterations
    description: "Maximum mutation iterations (default 5)"
    required: false
    default: "5"
checklist:
  - State directory initialized with mutator-skill.md and judge-skill.md saved
  - v0 base reviewer skill written
  - At least 1 full iteration completed (select → prepare → predict → judge → score → mutate)
  - At least 2 iterations completed for trajectory comparison
  - Meta-mutation triggered if stalled (mutator first, then judge)
  - Final report generated with best skill versions identified
---

# Reviewer Distillation Playbook

## Derived values

Compute from `{{repo}}`:
- **repoSlug**: replace `/` with `-` (e.g., `grafana/grafana` → `grafana-grafana`)

Use this derived value wherever `repoSlug` appears below.

## Objective

Run a blind review prediction experiment on `{{repo}}`. For each batch of PRs:
1. The REVIEWER agent predicts review comments from the diff alone (blind)
2. The JUDGE agent scores predictions against real human reviews
3. The MUTATOR agent improves the reviewer skill based on failure patterns
4. Repeat until convergence or max iterations

The goal is both human alignment (catching what humans catch) AND value-add (finding real issues humans miss).

## Context

- State directory: `~/.claude/<repoSlug>-reviewer-distillation/`
- Skills: `.claude/skills/reviewer-distillation-{select,prepare,predict,judge,mutate}/SKILL.md`
- RFC: `docs/rfc/rfc-reviewer-distillator.md`

## Workflow Per Iteration

### Phase 1: SELECT
Use the `reviewer-distillation-select` skill. Fetch merged PRs from `{{repo}}` with ≥3 human inline review comments. Filter bots. Select `{{batchSize}}` PRs not yet processed.

If fewer than `{{batchSize}}` qualifying PRs remain, report "insufficient data" and stop.

### Phase 2: PREPARE
Use the `reviewer-distillation-prepare` skill. For each selected PR:
1. Fetch the merged diff via `gh api ... -H "Accept: application/vnd.github.v3.diff"`
2. Fetch title, body, file list via `gh api`
3. Write `context/pr-{N}.md` — the REVIEWER's isolated input
4. Fetch real review comments via `gh api repos/.../pulls/{N}/comments`
5. Write `reviews/pr-{N}.md` — the JUDGE's ground truth (hidden from reviewer)

Skip PRs with diffs > 120K characters.

### Phase 3: PREDICT (all PRs in batch, can be parallel)
For each PR, spawn a **fresh Agent subagent** using the `reviewer-distillation-predict` skill:
- Input: `context/pr-{N}.md` + `mutations/v{K}.md`
- Output: `predictions/pr-{N}.md`
- The subagent CANNOT see `reviews/`, `scores/`, or other predictions

### Phase 4: JUDGE (all PRs in batch, after all predictions done)
For each PR, spawn a **fresh Agent subagent** using the `reviewer-distillation-judge` skill:
- Input: `context/pr-{N}.md` + `predictions/pr-{N}.md` + `reviews/pr-{N}.md`
- Output: `scores/pr-{N}-judge.md` (with JSON score block)
- The subagent CANNOT see `mutations/` or `aggregates/`

### Phase 5: SCORE + AGGREGATE (orchestrator does this directly)
For each PR, parse the JSON block from the judge output. Compute:
```
precision = matched / max(1, matched + plausible + wrong)
recall = matched / max(1, addressable)
f1 = 2 * precision * recall / max(0.001, precision + recall)
value_rate = (matched + justified) / max(1, total_findings)
```

Write per-PR scores to `scores/pr-{N}.json`.
Aggregate batch stats to `aggregates/iteration-{K}.json`:
```json
{
  "iteration": K,
  "prompt_version": "vK",
  "pr_count": N,
  "mean_f1": 0.30,
  "stddev_f1": 0.20,
  "mean_precision": 0.33,
  "mean_recall": 0.28,
  "mean_value_rate": 0.40
}
```

Update `state.json`: add processed PRs, increment iteration, advance cursor.

### Phase 6: MUTATE (reviewer skill)
Spawn a **fresh Agent subagent** using the `reviewer-distillation-mutate` skill:
- Input: current skill (`mutations/v{K}.md`), aggregate stats, 3 worst judge outputs, prior skill versions
- Output: `mutations/v{K+1}.md`
- The subagent CANNOT see `reviews/`, `context/`, or `predictions/`

### Phase 7: CONVERGENCE + STALL DETECTION

Check convergence:
- If `current_iteration >= {{maxIterations}}` → stop, generate report
- If `stddev_f1 > 0.35` on first batch → futility stop
- If F1 delta < 0.05 for 2 consecutive iterations → converged, generate report

Check stall (separate from convergence — stall triggers meta-mutation, not stopping):
```
if abs(current_f1 - previous_f1) < 0.03:
  stall_count += 1
else:
  stall_count = 0

if stall_count == 2 and mutator not yet meta-mutated:
  → Phase 7a: META-MUTATE the MUTATOR
  reset stall_count

if stall_count == 2 and mutator already meta-mutated and judge not yet meta-mutated:
  → Phase 7b: META-MUTATE the JUDGE
  reset stall_count

if stall_count == 2 and both already meta-mutated:
  → all improvement paths exhausted, stop and generate report
```

### Phase 7a: META-MUTATE the MUTATOR (on stall)
Use the `reviewer-distillation-meta` skill. Spawn a fresh agent that:
- Reads the current mutator instructions (`mutator-skill.md`)
- Reads the score trajectory and last 2 reviewer skills + their results
- Diagnoses why the mutator isn't producing improvements
- Rewrites `mutator-skill.md`

The orchestrator saves the initial mutator instructions to `{stateDir}/mutator-skill.md` before iteration 0. Subsequent MUTATE phases read this file for their meta-instructions.

### Phase 7b: META-MUTATE the JUDGE (on deeper stall)
Use the `reviewer-distillation-meta` skill. Spawn a fresh agent that:
- Reads the current judge prompt (`judge-skill.md`)
- Reads the full score trajectory and 3 recent judge outputs
- Diagnoses calibration problems (over-classifying plausible, loose matching, etc.)
- Rewrites `judge-skill.md`

The orchestrator saves the initial judge prompt to `{stateDir}/judge-skill.md` before iteration 0. Subsequent JUDGE phases read this file.

Then loop back to Phase 1 with the updated skills.

### Phase 8: REPORT (on convergence, max iterations, or all paths exhausted)
Select the prompt version with the highest `mean_f1`. If `mean_value_rate` is significantly higher for another version, note both.

Generate `report.md` with:
- Score trajectory table (iter, prompt, F1, precision, recall, value_rate)
- Comment classification breakdown (addressable/resolved/contextual percentages)
- Category analysis (what the agent catches vs misses)
- Justified extras analysis (the agent's value-add)
- Best prompt (full text, ready for use)
- Recommendations

Also copy report to `~/.claude/reviewer-distillation-report-<repoSlug>.md` for discoverability.

## State Schema

```json
{
  "version": 1,
  "repo": "owner/repo",
  "processed_prs": [],
  "skipped_prs": [],
  "total_processed": 0,
  "current_iteration": 0,
  "current_prompt_version": "v0",
  "iteration_scores": [],
  "cursor": null,
  "last_batch_at": null,
  "converged": false,
  "convergence_reason": null,
  "meta": {
    "stall_count": 0,
    "mutator_meta_mutated": false,
    "mutator_meta_mutated_at_iteration": null,
    "judge_meta_mutated": false,
    "judge_meta_mutated_at_iteration": null
  }
}
```

## Idempotency Rules

1. Check `state.json.processed_prs` before selecting PRs — never process the same PR twice
2. Check for existing `scores/pr-{N}.json` before re-judging — skip already-scored PRs in partial batches
3. Append to `processed_prs` atomically after scoring, not before
4. Never overwrite mutation files — `v0-base.md`, `v1.md`, etc. are immutable once written

## Anti-Patterns

- **DO NOT** let the reviewer subagent read `reviews/` — this is the fundamental isolation constraint
- **DO NOT** let the mutator add pattern checklists — proven to degrade performance (v1 POC: F1 dropped 0.30→0.05)
- **DO NOT** score PRs with 0 addressable comments as F1=0 — they provide no signal, flag in aggregate but don't include in mean
- **DO NOT** run JUDGE before all PREDICT calls in the batch are done — batch-level, not per-PR
- **DO NOT** skip the MUTATE phase even if scores look good — the experiment's value is in the trajectory
