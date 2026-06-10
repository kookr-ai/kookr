---
name: reviewer-distillation-meta
description: Meta-mutation — improve the mutator or judge skills when the reviewer improvement loop stalls
keywords: [reviewer, distillation, meta, mutator, judge, stall]
related: [reviewer-distillation-mutate, reviewer-distillation-judge]
---

# META Phase — Recursive Skill Improvement

## Purpose & Training Loop Context

The reviewer distillation system is a **blind prediction experiment**. Its purpose is to measure and improve an AI agent's code review accuracy by:

1. Having a REVIEWER predict review comments from a diff alone (blind — no access to real reviews)
2. Having a JUDGE compare predictions against real human reviews and score them
3. Having a MUTATOR rewrite the reviewer's skill to improve scores
4. Repeating until convergence

**The integrity of this loop depends on information isolation:**
- The REVIEWER must never see real review comments (otherwise it's memorizing, not learning)
- The JUDGE must not know which skill version produced the prediction (prevents bias)
- The MUTATOR must improve the reviewer's *reasoning*, not feed it answers

When the loop stalls (the reviewer stops improving), the META phase improves the MUTATOR or JUDGE skills themselves — but it must do so WITHOUT undermining the training purpose.

## Anti-Cheating Rules (NON-NEGOTIABLE)

| Rule | Why | Violation example |
|------|-----|-------------------|
| Meta-mutator CANNOT access `reviews/` | Would leak ground truth into skill instructions | "Tell the reviewer to check for X" where X is a specific pattern from real reviews |
| Meta-mutator CANNOT access `context/` or `predictions/` | Would allow crafting skills for specific PRs | "For PRs about feature toggles, focus on test cleanup" |
| Meta-mutator CANNOT embed specific PR content, reviewer names, or file paths in rewritten skills | Skills must generalize to unseen PRs | "In auth middleware, always check for redirect loops" |
| Meta-mutator CANNOT tell the reviewer to produce more findings to game metrics | Inflates total findings, tanks precision | "Always produce at least 5 findings" |
| Meta-mutator CANNOT tell the judge to be more lenient | Inflates scores without real improvement | "Classify more findings as justified" |
| Meta-mutator CANNOT change the scoring formula | Scoring is owned by the orchestrator | Redefining what "matched" means |
| Meta-mutated skills must remain GENERIC | Must work on any future PR, not just the training set | Any repo-specific or PR-specific guidance |

## What the Meta-Mutator CAN See

| Data | Purpose |
|------|---------|
| Current mutator/judge skill text | Understand what instructions produced the stall |
| Score trajectory (`iteration_scores` from state.json) | See the trend — is the problem precision, recall, or both? |
| Aggregate stats (`aggregates/iteration-{K}.json`) | Category breakdown, plausible ratio, value rate |
| Judge evaluation outputs (`scores/pr-{N}-judge.md`) | See HOW the judge classified and matched — reveals calibration issues |
| Prior reviewer skill versions (`mutations/v*.md`) | Understand what mutations were tried and whether they helped or hurt |

## When to Use

| Stall condition | Action |
|---|---|
| Reviewer F1 flat (<0.03 delta) for 2 consecutive iterations | Meta-mutate the **MUTATOR** skill |
| Still flat for 2 more iterations after mutator was meta-mutated | Meta-mutate the **JUDGE** skill |
| Still flat for 2 more after both were meta-mutated | All paths exhausted → stop |

*Provenance of 0.03: an initial estimate of meaningful-vs-noise F1 movement at the current corpus size (~tens of PRs), not a measured constant — recalibrate when the evaluated corpus grows past ~30 PRs.*

## Stall and Convergence Logic (owned by the playbook, not this skill)

The dual-threshold design — stall at 0.03 (triggers meta-mutation), convergence
at 0.05 (triggers stopping), stall checked FIRST, meta-mutation resetting BOTH
counters — is specified once, in `.kookr/playbooks/reviewer-distillation.md`
Phase 7. **Read it from there; do not re-derive or copy the pseudocode here.**
The invariant `stall (0.03) < convergence (0.05)` makes the 0.03–0.05 band the
meta-mutation window: a run must exhaust its improvement paths before it is
allowed to stop.

**Measurement validity:** until the evaluated corpus reaches ~30 PRs, treat F1
as directional, not authoritative — scores may be contaminated by PRs the
mutator was tuned against (the hold-out partition arrives in SELECT at ~30 PRs).

## Meta-Mutating the MUTATOR

Spawn a fresh agent with this prompt:

```
You are a meta-mutation agent for the reviewer distillation training loop.

## Context: What this system does

This is a blind prediction experiment. A REVIEWER agent predicts PR review
comments from diffs alone. A JUDGE scores predictions against real human reviews.
A MUTATOR rewrites the reviewer's skill each iteration to improve scores.

The loop has stalled — the MUTATOR keeps producing reviewer skills that don't
improve F1. Your job: diagnose why and rewrite the MUTATOR's instructions.

## Information isolation (CRITICAL)

You must NOT:
- Access or reference review/, context/, or predictions/ directories
- Embed specific PR content, file paths, or reviewer names in the rewritten skill
- Tell the mutator to add pattern checklists (POC proved this kills quality)
- Tell the mutator to game metrics (more findings ≠ better)
- Change what data the reviewer or judge can access

The mutator must continue to improve the reviewer's REASONING APPROACH,
not feed it specific patterns or answers.

## Read these files

Current mutator instructions: {stateDir}/mutator-skill.md
Score trajectory: {paste iteration_scores}
Last 2 reviewer skills produced: {stateDir}/mutations/v{K-1}.md, v{K}.md
Last 2 aggregates: {stateDir}/aggregates/iteration-{K-1}.json, iteration-{K}.json
3 worst judge outputs from last batch: {paths}

## Diagnose

Why isn't the mutator producing better reviewer skills?
- Is it making changes too small (timid) or too large (destructive)?
- Is it focusing on the wrong metric?
- Is it repeating failed approaches?
- Does it misunderstand what the reviewer should be optimizing for?

## Rewrite

Write improved mutator instructions to: {stateDir}/mutator-skill.md

The rewritten instructions must:
- Preserve the anti-checklist rules
- Improve how the mutator reasons about what changes to make
- Be generic (work for any repository, any future iteration)
```

## Meta-Mutating the JUDGE

Spawn a fresh agent with this prompt:

```
You are a meta-mutation agent for the reviewer distillation training loop.

## Context: What this system does

This is a blind prediction experiment. A REVIEWER predicts PR review comments.
A JUDGE scores predictions by: (1) classifying human comments as
addressable/resolved/contextual, (2) matching agent findings to addressable
comments, (3) rating unmatched findings as justified/plausible/wrong.

The orchestrator computes scores from the judge's structured output.
The MUTATOR uses these scores to improve the reviewer. But the loop has stalled
even after improving the mutator — the JUDGE might be miscalibrating scores.

## Information isolation (CRITICAL)

You must NOT:
- Make the judge more lenient (inflates scores without real improvement)
- Make the judge match more loosely to inflate recall
- Tell the judge to classify more comments as "resolved" to reduce the denominator
- Change the JSON output schema (the orchestrator depends on it)

The judge must remain an honest, calibrated evaluator. Improving the judge
means making it MORE ACCURATE, not more generous.

## Read these files

Current judge prompt: {stateDir}/judge-skill.md
Score trajectory: {paste iteration_scores}
3 recent judge outputs: {paths to scores/pr-{N}-judge.md}

## Diagnose

Look for calibration problems:
- Is the plausible/(plausible+wrong) ratio > 0.7? The judge may be avoiding
  commitment — pushing "plausible" as a safe default instead of making a call.
- Are "addressable" classifications correct? If the judge classifies too many
  comments as "resolved" or "contextual", the recall denominator is deflated.
- Is matching too loose or too strict? Loose matching inflates precision;
  strict matching deflates it.
- Are category labels consistent between matched and unmatched items?

## Rewrite

Write improved judge prompt to: {stateDir}/judge-skill.md

Keep the core structure: classify → match → rate → JSON output.
Focus on the specific calibration issue you diagnosed.
The rewritten prompt must produce the same JSON schema.
```

## State Tracking

The orchestrator adds to `state.json`:

```json
{
  "meta": {
    "stall_count": 0,
    "mutator_meta_mutated": false,
    "mutator_meta_mutated_at_iteration": null,
    "judge_meta_mutated": false,
    "judge_meta_mutated_at_iteration": null
  }
}
```

## File Lifecycle

| File | Created | Updated by |
|------|---------|-----------|
| `mutator-skill.md` | Orchestrator at startup (copies from mutate SKILL.md) | Meta-mutator on stall |
| `judge-skill.md` | Orchestrator at startup (copies from judge SKILL.md) | Meta-mutator on deeper stall |

Both files are versioned implicitly by the iteration they were changed at (tracked in `state.json.meta`).
