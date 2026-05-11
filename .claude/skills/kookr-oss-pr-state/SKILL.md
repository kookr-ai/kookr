---
name: kookr-oss-pr-state
description: State management for oss-pr-lessons playbook — persist learnings and update tracking state for any repository
keywords: oss, pr, state, learnings, persist, json, open source
related: [oss-pr-plan, oss-pr-critic, oss-pr-threshold, oss-pr-distill]
---

# OSS PR State

Persist observations and update tracking state after each batch. Generalized version of `codex-pr-state`.

## When to Use

Invoked after the critic phase completes for a batch.

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Append to learnings-raw.md, never overwrite | Writing fresh file that drops prior learnings | Append batch section to end of file |
| 2 | Update state.json atomically | Writing partial state on error | Read -> modify -> write complete JSON |
| 3 | Add ALL batch PR IDs to processed_prs | Only adding merged PRs | Add every analyzed PR, merged or not |
| 4 | Add skipped PR IDs to skipped_prs | Forgetting skipped PRs | Track skips separately from processed |
| 5 | Never commit state files | `git add state.json` | All state files live in `~/.claude/{repoSlug}-pr-lessons/` |
| 6 | Timestamp each batch entry | Undated learnings | Include ISO date in batch header |

## Parameters

- **repoFullName**: `owner/repo`
- **repoSlug**: URL-safe slug

## State File Schema (state.json)

```json
{
  "repo": "owner/repo",
  "version": 1,
  "processed_prs": [101, 102, 103],
  "skipped_prs": [50, 51],
  "total_processed": 3,
  "total_skipped": 2,
  "distillation_count": 0,
  "last_batch_at": "2026-03-26T10:00:00Z",
  "last_distillation_at": null,
  "cursor": 2,
  "notes": "State file for {repoFullName} PR lessons."
}
```

> **`repo` is required.** Kookr's dashboard reads this field to match PR lessons state to projects. Without it, the project's PR lessons count will not display.

## Workflow

### Step 1: Read current state

```bash
SLUG="{{repoSlug}}"
cat ~/.claude/${SLUG}-pr-lessons/state.json
```

### Step 2: Append batch learnings to raw file

Append a batch section to `learnings-raw.md`:

```markdown
## Batch {YYYY-MM-DD} (PRs: #{n1}, #{n2}, #{n3}, #{n4}, #{n5})

{Critic output for each PR — the structured observation blocks}

### Batch-Level Observations

- {Cross-PR pattern noticed in this batch}
- {Contrast between merged vs rejected PRs in this batch}

---
```

### Step 3: Update state.json

```bash
SLUG="{{repoSlug}}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat ~/.claude/${SLUG}-pr-lessons/state.json | jq \
  ".processed_prs += [NEW_IDS] | .total_processed = (.processed_prs | length) | .last_batch_at = \"${NOW}\"" \
  > /tmp/state-tmp.json && mv /tmp/state-tmp.json ~/.claude/${SLUG}-pr-lessons/state.json
```

For skipped PRs:
```bash
cat ~/.claude/${SLUG}-pr-lessons/state.json | jq \
  '.skipped_prs += [SKIP_IDS] | .total_skipped = (.skipped_prs | length)' \
  > /tmp/state-tmp.json && mv /tmp/state-tmp.json ~/.claude/${SLUG}-pr-lessons/state.json
```

### Step 4: Verify integrity

1. Confirm valid JSON: `jq . ~/.claude/${SLUG}-pr-lessons/state.json > /dev/null`
2. Confirm no duplicates: `jq '.processed_prs | unique | length == (.processed_prs | length)' ~/.claude/${SLUG}-pr-lessons/state.json`
3. Confirm learnings-raw.md was appended (prior batch headers still exist)

## Recovery

If state.json becomes corrupted:
1. Reconstruct `processed_prs` from learnings-raw.md batch headers
2. Reset cursor to 1 (will re-scan pages but skip known PRs)
