---
name: reviewer-distillation-mutate
description: Spawn a mutator subagent to improve the reviewer skill based on judge feedback
keywords: [reviewer, distillation, mutate, improve, skill]
related: [reviewer-distillation-judge, reviewer-distillation-predict]
---

# MUTATE Phase — Skill Improvement Subagent

## When to Use

Called by the orchestrator after AGGREGATE. Spawns a fresh agent to rewrite the reviewer skill based on batch performance data.

## Critical Mutation Rules (learned from POC)

| Rule | Why |
|------|-----|
| **DO NOT add pattern checklists** | v1 added "check for JSX bugs, enum exhaustiveness" → agent scanned for patterns instead of reading code → F1 dropped from 0.30 to 0.05 |
| **DO NOT add repo-specific patterns** | Makes the agent a pattern matcher, not a code reader |
| **DO keep the prompt under 400 words** | Longer prompts dilute the core instruction |
| **DO refine reasoning procedures** | "What could this break?" framing improved value rate from 20% to 40% |
| **DO add self-check steps** | "Would a busy maintainer flag this?" halved plausible noise |
| **DO preserve natural code reading** | The generic v0 prompt outperformed all checklist variants |

## Subagent Prompt Template

```
You are a prompt mutation agent. Your job is to improve a code review skill
based on performance data. You must learn from PREVIOUS MUTATION FAILURES.

## Current reviewer skill
Read: {stateDir}/mutations/v{K}.md

## Performance data
{paste aggregate JSON from aggregates/iteration-{K}.json}

## Previous prompt versions (to avoid repeating failed approaches)
{list of prior mutation files: mutations/v0-base.md, v1.md, ... v{K}.md}
Read all of them to understand what was tried and what failed.

## Worst-performing judge outputs (concrete failure examples)
{3 lowest-F1 judge output paths from this batch}

## Constraints

DO NOT:
- Add a pattern checklist (proven to kill natural code reading)
- Add repo-specific patterns (causes pattern-hunting, not understanding)
- Make the prompt longer than 400 words of review instructions
- Tell the agent WHAT to find — tell it HOW TO THINK

DO:
- Keep the core strength of natural code reading
- Add or refine reasoning steps (e.g., "trace what this change breaks")
- Add or refine self-check steps (e.g., "would a maintainer flag this?")
- Reduce noise by tightening the "what to skip" guidance
- If a prior version's change made things worse, explicitly revert it

Write the improved skill to: {stateDir}/mutations/v{K+1}.md

Start with a changelog:
## Changelog v{K} → v{K+1}
- Change 1: reason
- Change 2: reason

Then the full rewritten prompt text.

Do NOT include review comments, human reviewer names, or PR-specific content.
The skill must be generic — it will be used on new PRs.
```

## What the Mutator Can See

- Current and all prior skill versions (`mutations/`)
- Batch aggregate stats (`aggregates/`)
- Judge evaluation outputs (`scores/pr-{N}-judge.md`) for worst performers

## What the Mutator CANNOT See

- Raw review comments (`reviews/`) — learns from judge evaluations, not memorizing answers
- PR context files (`context/`) — no access to the actual code
- Raw predictions (`predictions/`) — sees the judge's assessment, not the predictions themselves

This ensures the mutator learns from **patterns of failure**, not from **specific answers**.
