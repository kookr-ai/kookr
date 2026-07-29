---
name: Issue Triage
description: Triage open GitHub issues — assess relevance, close resolved issues with explanation, comment on valid issues with status update
repo-tags: [github]
parameters:
  - name: repoFullName
    description: "Repository (owner/repo, e.g., kookr-ai/kookr)"
    required: true
  - name: staleThresholdDays
    description: "Days without activity before considering an issue stale"
    required: false
    default: "30"
checklist:
  - Fetched all open issues from repository
  - Assessed each issue against current codebase state
  - Commented on still-valid issues with current status
  - Closed issues that have been resolved or are no longer relevant
  - Summary report of actions taken
---

## Objective

Triage all open issues on `{{repoFullName}}` — close resolved ones, comment on active ones with a status assessment.

## Phase 1: Fetch issues

```bash
gh issue list -R {{repoFullName}} --state open --limit 100 --json number,title,body,labels,createdAt,updatedAt,comments
```

## Phase 2: Assess each issue

For each open issue:

1. **Read the issue** carefully — understand what problem it describes
2. **Check the codebase** — search for the relevant code, check git log for recent changes that may have fixed it
3. **Check for merged PRs** — look for PRs that reference the issue number
4. **Determine status**:
   - **Resolved**: The described problem no longer exists (code was fixed, feature was implemented)
   - **Still valid**: The issue still describes a real problem or unimplemented feature
   - **Stale**: No activity for {{staleThresholdDays}}+ days and the issue is vague or unclear

## Phase 2.5: Kookr issue claim before mutating an issue (RFC PR 1b)

When you will close, label, or otherwise mutate a specific issue, claim it first so two triage agents cannot act on the same issue concurrently:

```bash
REPO="{{repoFullName}}"
TARGET=<issue_number>
kookr issue claim "$TARGET" --repo "$REPO" || {
  rc=$?
  if [ "$rc" -eq 6 ]; then echo "skip #$TARGET (held)"; continue; fi
  if [ "$rc" -eq 3 ]; then echo "park — server unreachable"; exit 1; fi
  # 0 or other: proceed (incl. pre-lock on 404)
}
```

Release when done with that issue (or leave to terminal-task auto-release):

```bash
kookr issue release "$TARGET" --repo "$REPO" || true
```

## Phase 3: Act on each issue

### For resolved issues
Close with a comment explaining why:
```bash
gh issue close -R {{repoFullName}} <number> --comment "Closing — [specific reason: e.g., 'this was addressed in commit abc123' or 'the feature described here was implemented in PR #45']"
```

### For still-valid issues
Comment with a status assessment:
```bash
gh issue comment -R {{repoFullName}} <number> --body "**Triage ($(date +%Y-%m-%d)):** Still valid. [Brief explanation of current state and what remains to be done]"
```

### For stale issues
Comment asking for clarification, or close if clearly obsolete:
```bash
gh issue comment -R {{repoFullName}} <number> --body "**Triage ($(date +%Y-%m-%d)):** This issue has had no activity for {{staleThresholdDays}}+ days. [Assessment of whether it's still relevant]"
```

## Phase 4: Report summary

Report a summary of actions taken:
- Total issues triaged
- Issues closed (with reasons)
- Issues commented on (still valid)
- Issues left unchanged

## Idempotency Rules

1. Before commenting, check if a triage comment was already posted today — don't duplicate
2. Don't close an issue that was already commented on in this run as "still valid"
3. Converge, don't diverge — each run refines the issue state, doesn't create noise
4. Be conservative about closing — only close when you have clear evidence the issue is resolved
