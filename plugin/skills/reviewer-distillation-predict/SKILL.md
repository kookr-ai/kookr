---
name: reviewer-distillation-predict
description: Spawn an isolated reviewer subagent to blindly predict PR review comments
keywords: [reviewer, distillation, predict, blind, review]
related: [reviewer-distillation-prepare, reviewer-distillation-judge]
---

# PREDICT Phase — Blind Review Subagent

## When to Use

Called by the orchestrator for each PR after PREPARE. Spawns a fresh agent process that reviews the PR blind — without access to real review comments.

## Subagent Prompt Template

The orchestrator spawns this as a **separate Agent subagent** (fresh conversation):

```
You are a code review prediction agent. Read ONLY these two files, then write your review:

1. Review prompt: {stateDir}/mutations/v{K}.md
   (Skip the changelog section if present. Use instructions starting from "You are an expert code reviewer")
2. PR context: {stateDir}/context/pr-{N}.md

Write your review to: {stateDir}/predictions/pr-{N}.md

Do NOT access GitHub, do NOT read files in reviews/, scores/, or any directory
other than context/ and mutations/. Read the context once, produce the review,
write the file.
```

## v0 Base Reviewer Skill

This is the default reviewer skill used for iteration 0. It lives at `{stateDir}/mutations/v0-base.md`:

```markdown
You are an expert code reviewer for {repo}. Review the following PR diff
as if you were a maintainer seeing it for the first time.

For each issue you find, write:

### Finding N
- **File**: path/to/file.ext:line-range
- **Severity**: blocking | suggestion | nit
- **Category**: correctness | performance | style | testing | security | design | docs
- **Comment**: Concise explanation of the issue and suggested fix

After all findings, write:

### Overall
- **Decision**: APPROVE | REQUEST_CHANGES | COMMENT
- **Summary**: 1-2 sentence summary

Guidelines:
- Focus on what a human reviewer would actually flag
- Don't restate what the code does
- Don't flag things linters catch automatically
- Be specific: cite lines, explain why it matters
- Err on the side of fewer, higher-quality findings over many nits
```

## Warm Start

If `~/.claude/skills/pr-contribution-excellence/repo/{repoSlug}.md` exists, append its contents to v0 under a "Repository-specific patterns" section.

## Output Format

The reviewer writes findings to `predictions/pr-{N}.md` in the format above. The judge will parse `### Finding N` blocks and the `### Overall` block.

## Concurrency Limits

- **Single-agent reviewers** (v0–v5): max 6 in parallel per batch
- **Multi-agent reviewers** (v6+, each spawns 3 specialists): max 2 in parallel (2×3=6 total agents)
- Process batches in waves: launch ≤6 agents, wait for completion, launch next wave
- If any agent returns API 529, stop launching and wait before retrying

## Critical Isolation Rules

1. The subagent is spawned as a FRESH process — no shared conversation with orchestrator or judge
2. The subagent prompt references ONLY `context/pr-{N}.md` and `mutations/vK.md`
3. The subagent has NO access to `reviews/`, `scores/`, `aggregates/`, or other predictions
4. All data exchange is via files on disk — no in-memory passing
