---
name: reviewer-distillation-judge
description: Spawn an isolated judge subagent to evaluate reviewer predictions against real human reviews
keywords: [reviewer, distillation, judge, evaluate, score]
related: [reviewer-distillation-predict, reviewer-distillation-mutate]
---

# JUDGE Phase — Evaluation Subagent

## When to Use

Called by the orchestrator for each PR after PREDICT and after real reviews have been fetched. Spawns a fresh agent process that compares predictions against ground truth.

## Subagent Prompt Template

```
You are a review evaluation judge. Compare an AI reviewer's predictions against
real human reviews.

Read these 3 files:
1. {stateDir}/context/pr-{N}.md
2. {stateDir}/predictions/pr-{N}.md
3. {stateDir}/reviews/pr-{N}.md

### Step 1: Classify each human review comment

For each human comment, classify as:
- **addressable**: References an issue visible in the current diff
- **resolved**: References an issue that appears to have been fixed
  (the diff doesn't show the problem described)
- **contextual**: A question, praise, process comment, or discussion
  — not an actionable code issue

### Step 2: Match agent findings to addressable human comments

For each addressable human comment, find the agent finding that addresses
the same concern (if any).
Rules:
- One-to-one matching: each finding and comment in at most one pair
- If two agent findings compete for one comment, pick the closer semantic match
- If no agent finding addresses the concern, mark the comment as "missed"

### Step 3: Assess unmatched agent findings

For each agent finding not matched to a human comment:
- **justified**: Identifies a concrete, verifiable issue visible in the diff.
  You can point to exact lines that demonstrate the problem.
- **plausible**: Describes a reasonable concern but can't be definitively
  verified from the diff alone.
- **wrong**: Factually incorrect, references wrong lines/code, or describes
  a non-existent problem.

When in doubt between justified and plausible, choose plausible.
When in doubt between plausible and wrong, choose plausible.

### Step 4: Ground Evidence Citations

For every specific human review comment or agent finding that affects your
classification, match, or rating, cite the exact source lines you used.

Use this machine-verifiable Markdown shape:

```markdown
Evidence: **reviews/pr-{N}.md#L12-L14**
> exact quoted text copied from that file
```

Allowed citation paths are only the three input files under `{stateDir}`:
`context/pr-{N}.md`, `predictions/pr-{N}.md`, and `reviews/pr-{N}.md`.
Use repo-relative paths from `{stateDir}`, not absolute paths. Before writing
the evaluation, inspect files with line numbers (for example, `nl -ba`) so the
`#L` anchors are accurate. The blockquote must be copied exactly enough for the
deterministic citation verifier to find it after whitespace normalization.

### Output

Write your full evaluation with reasoning, then end with EXACTLY this
machine-readable JSON block (fill in real numbers):

```json
{
  "human_comments": { "addressable": 0, "resolved": 0, "contextual": 0 },
  "matches": [
    { "agent_finding": 1, "human_comment": 1, "category": "correctness" }
  ],
  "unmatched_agent": [
    { "finding": 2, "rating": "plausible", "category": "style" }
  ],
  "unmatched_human": [
    { "comment": 3, "category": "testing" }
  ]
}
```

Write your evaluation to: {stateDir}/scores/pr-{N}-judge.md

After writing the evaluation, run the citation gate before finishing:

```bash
if [ "${SKIP_CITATION_GATE:-}" = "true" ]; then
  echo "SKIP_CITATION_GATE=true; citation gate skipped for pr-{N}."
else
  GATE_OUTPUT=$(node "${CLAUDE_SKILL_DIR}/scripts/verify-citations.mjs" \
    --input "{stateDir}/scores/pr-{N}-judge.md" \
    --source-root "{stateDir}" \
    --format markdown \
    --allow-prefix "context/pr-{N}.md" \
    --allow-prefix "predictions/pr-{N}.md" \
    --allow-prefix "reviews/pr-{N}.md" 2>&1)
  GATE_STATUS=$?
  printf '%s\n' "$GATE_OUTPUT"
  if [ "$GATE_STATUS" -ne 0 ]; then
    mkdir -p "{stateDir}/scores/rejected"
    mv "{stateDir}/scores/pr-{N}-judge.md" \
      "{stateDir}/scores/rejected/pr-{N}-judge-unverifiable.md"
    echo "Citation gate rejected pr-{N}; moved output to scores/rejected so it is excluded from ranking."
    exit 1
  fi
fi
```

Non-zero verifier exit means the judge output is unverifiable. Print the JSON
verifier result in-session, move the output out of the normal score path, and
exit non-zero so the orchestrator cannot rank it silently.

Do NOT access GitHub or any external resources. Work only with provided files.
```

## Score Computation (done by orchestrator, NOT the judge)

The orchestrator parses the JSON block and computes:

```python
matched = len(matches)
justified = count(unmatched_agent where rating == "justified")
plausible = count(unmatched_agent where rating == "plausible")
wrong = count(unmatched_agent where rating == "wrong")
addressable = human_comments["addressable"]
total_findings = matched + justified + plausible + wrong

precision = matched / max(1, matched + plausible + wrong)
recall = matched / max(1, addressable)
f1 = 2 * precision * recall / max(0.001, precision + recall)
value_rate = (matched + justified) / max(1, total_findings)
```

Save to `{stateDir}/scores/pr-{N}.json`.

## Concurrency Limits

- Max 6 judge agents in parallel per batch
- If any agent returns API 529, stop launching and wait before retrying
- Process in waves: launch ≤6, wait for completion, launch next wave

## Critical Isolation Rules

1. Fresh process — no shared conversation with reviewer or orchestrator
2. Reads context + prediction + reviews — but NOT mutations/ or aggregates/
3. The judge must NOT know which prompt version produced the prediction
4. Scoring arithmetic is done by the orchestrator, not the judge
