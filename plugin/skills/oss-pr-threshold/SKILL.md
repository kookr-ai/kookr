---
name: oss-pr-threshold
description: Threshold verification for oss-pr-lessons playbook — determine if distillation should trigger for any repository
keywords: oss, pr, threshold, distillation, trigger, line count, open source
related: [oss-pr-state, oss-pr-distill]
---

# OSS PR Threshold

Determine whether accumulated raw learnings are sufficient for distillation.

## When to Use

Invoked after each batch's state update.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Threshold is exactly 200 lines | Using subjective criteria | `wc -l < learnings-raw.md` > 200 |
| 2 | Count ALL lines including headers | Only counting observation lines | `wc -l` on the entire file |
| 3 | Report exact count and decision | Silently triggering or skipping | Always output: "{N} lines - {DISTILL/SKIP}" |
| 4 | Never trigger on first batch | Distilling from 5 PRs | Minimum `total_processed >= 10` |

## Parameters

- **repoSlug**: URL-safe slug

## Threshold Definition

```
DISTILL if:
  (line_count > 200) AND (state.total_processed >= 10)

SKIP otherwise
```

## Verification Command

```bash
SLUG="{{repoSlug}}"
LINE_COUNT=$(wc -l < ~/.claude/${SLUG}-pr-lessons/learnings-raw.md)
TOTAL_PROCESSED=$(jq '.total_processed' ~/.claude/${SLUG}-pr-lessons/state.json)
echo "Lines: $LINE_COUNT | Processed: $TOTAL_PROCESSED"

if [ "$LINE_COUNT" -gt 200 ] && [ "$TOTAL_PROCESSED" -ge 10 ]; then
  echo "DECISION: DISTILL"
else
  echo "DECISION: SKIP (need >200 lines and >=10 PRs)"
fi
```

## Output

- `DISTILL` — proceed to `oss-pr-distill`
- `SKIP — {N} lines, {M} PRs processed (need >200 lines and >=10 PRs)` — stop iteration

## Failure Handling

Consistent three-case shape — never guess past a broken state file:

- **Missing `state.json`** — first run: initialize it from the documented schema, then proceed.
- **Malformed `state.json`** — validate before use: `jq empty state.json || { echo "state.json is corrupt — stopping (a default-to-fresh run would re-process every PR)"; exit 1; }`. Stop and report; never default to a fresh state.
- **Empty batch / repo exhausted** — zero new observations since the last distillation: report "nothing to evaluate" and stop; do not trigger distillation on an empty delta.
