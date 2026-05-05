---
name: kookr-codex-pr-state
description: State management for codex-pr-lessons playbook — persist learnings and update tracking state
keywords: codex, pr, state, learnings, persist, json
related: [[codex-pr-plan]], [[codex-pr-critic]], [[codex-pr-threshold]], [[codex-pr-distill]]
---

## When to Use

This skill is invoked after the critic phase completes for a batch. It persists the observations and updates tracking state.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Append to learnings-raw.md, never overwrite | Writing fresh file that drops prior learnings | Append batch section to end of file |
| 2 | Update state.json atomically | Writing partial state on error | Read → modify → write complete JSON |
| 3 | Add ALL batch PR IDs to processed_prs | Only adding merged PRs | Add every analyzed PR, merged or not |
| 4 | Add skipped PR IDs to skipped_prs | Forgetting skipped PRs, re-evaluating them | Track skips separately from processed |
| 5 | Never commit state files | `git add state.json` | All state files live in ~/.claude/codex-pr-lessons/ |
| 6 | Timestamp each batch entry | Undated learnings | Include ISO date in batch header |

## State File Schema (state.json)

```json
{
  "repo": "openai/codex",
  "version": 1,
  "processed_prs": [101, 102, 103],
  "skipped_prs": [50, 51],
  "total_processed": 3,
  "total_skipped": 2,
  "distillation_count": 0,
  "last_batch_at": "2026-03-26T10:00:00Z",
  "last_distillation_at": null,
  "cursor": 2,
  "notes": "State file for codex-pr-lessons playbook."
}
```

> **`repo` is required.** Kookr's dashboard reads this field to match PR lessons state to projects. Without it, the project's PR lessons count will not display.

### Field Semantics

| Field | Type | Description |
|-------|------|-------------|
| `repo` | string | `owner/repo` slug — must match the GitHub repository |
| `version` | number | Schema version (always 1) |
| `processed_prs` | number[] | PR numbers that have been fully analyzed |
| `skipped_prs` | number[] | PR numbers skipped (bots, empty, accidental) |
| `total_processed` | number | Count of processed_prs (redundant but convenient) |
| `total_skipped` | number | Count of skipped_prs |
| `distillation_count` | number | How many distillation cycles have completed |
| `last_batch_at` | string\|null | ISO timestamp of last batch completion |
| `last_distillation_at` | string\|null | ISO timestamp of last distillation |
| `cursor` | number\|null | GitHub API page number for pagination |

## Workflow

### Step 1: Read current state

```bash
cat ~/.claude/codex-pr-lessons/state.json
```

### Step 2: Append batch learnings to raw file

Append a batch section to `learnings-raw.md` with this format:

```markdown
## Batch {YYYY-MM-DD} (PRs: #{n1}, #{n2}, #{n3}, #{n4}, #{n5})

{Critic output for each PR — the structured observation blocks}

### Batch-Level Observations

- {Cross-PR pattern noticed in this batch}
- {Contrast between merged vs rejected PRs in this batch}
- ...

---
```

### Step 3: Update state.json

```bash
# Read, modify, write back
# Add new PR numbers to processed_prs
# Add skipped PR numbers to skipped_prs
# Update total_processed and total_skipped
# Update last_batch_at to current ISO timestamp
# Update cursor if needed
```

Use `jq` or write the full JSON to ensure valid output:

```bash
cat ~/.claude/codex-pr-lessons/state.json | jq \
  '.processed_prs += [NEW_IDS] | .total_processed = (.processed_prs | length) | .last_batch_at = "TIMESTAMP"' \
  > /tmp/state-tmp.json && mv /tmp/state-tmp.json ~/.claude/codex-pr-lessons/state.json
```

### Step 4: Verify integrity

After writing:
1. Confirm state.json is valid JSON: `jq . ~/.claude/codex-pr-lessons/state.json > /dev/null`
2. Confirm no duplicate PR IDs: `jq '.processed_prs | unique | length == (.processed_prs | length)' ~/.claude/codex-pr-lessons/state.json`
3. Confirm learnings-raw.md was appended (not overwritten): check that prior batch headers still exist

## Recovery

If state.json becomes corrupted:
1. The processed_prs list is the most important field — it prevents re-processing
2. Reconstruct from learnings-raw.md batch headers which contain PR numbers
3. Reset cursor to 1 (will re-scan pages but skip known PRs)
