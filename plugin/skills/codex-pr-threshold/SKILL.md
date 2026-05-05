---
name: codex-pr-threshold
description: Threshold verification for codex-pr-lessons playbook — determine if distillation should trigger
keywords: codex, pr, threshold, distillation, trigger, line count
related: [codex-pr-state, codex-pr-distill]
---

## When to Use

This skill is invoked after each batch's state update to determine whether the accumulated raw learnings are sufficient for distillation.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Threshold is **exactly 200 lines** in learnings-raw.md | Using subjective criteria like "enough learnings" | `wc -l < ~/.claude/codex-pr-lessons/learnings-raw.md` > 200 |
| 2 | Count ALL lines including headers and separators | Only counting observation lines | `wc -l` on the entire file |
| 3 | Report the exact count and decision | Silently triggering or skipping | Always output: "{N} lines — {DISTILL/SKIP}" |
| 4 | Never trigger distillation on first batch | Distilling from a single batch of 5 PRs | Minimum 2 batches must exist (check state.total_processed >= 10) |

## Threshold Definition

```
DISTILL if:
  (line_count > 200) AND (state.total_processed >= 10)

SKIP otherwise
```

**Why 200 lines?** At ~25-30 lines per PR observation block plus batch summaries, 200 lines represents roughly 6-8 analyzed PRs with cross-batch observations — enough data to generalize but not so much that raw learnings become unwieldy.

**Why minimum 10 PRs?** Patterns from fewer than 10 PRs risk being anecdotal. Two full batches provide enough contrast between merged/rejected, large/small, and well-described/poorly-described PRs.

## Verification Command

```bash
LINE_COUNT=$(wc -l < ~/.claude/codex-pr-lessons/learnings-raw.md)
TOTAL_PROCESSED=$(jq '.total_processed' ~/.claude/codex-pr-lessons/state.json)
echo "Lines: $LINE_COUNT | Processed: $TOTAL_PROCESSED"

if [ "$LINE_COUNT" -gt 200 ] && [ "$TOTAL_PROCESSED" -ge 10 ]; then
  echo "DECISION: DISTILL"
else
  echo "DECISION: SKIP (need >200 lines and >=10 PRs)"
fi
```

## Output

Return one of:
- `DISTILL` — proceed to codex-pr-distill skill
- `SKIP — {N} lines, {M} PRs processed (need >200 lines and >=10 PRs)` — stop iteration here
