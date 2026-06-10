---
name: OSS Bug Triage
description: Browse upstream bug reports from any repository, score by confidence and reproducibility, maintain ranked triage issues in fork
repo-tags: [github]
parameters:
  - name: repoFullName
    description: "Upstream repo (owner/repo, e.g., microsoft/vscode)"
    required: true
    type: select
    source: tracked-projects
checklist:
  - Fetched current triage issues from fork
  - Fetched recent upstream bug reports (open + recently closed)
  - Closed triage issues for bugs fixed upstream
  - Re-scored existing triage issues with new upstream information
  - Scored and created triage issues for new upstream bugs
  - Verified no duplicate triage issues exist
  - Verified all triage issues have correct confidence and repro labels
  - Verified priority scores in titles match confidence * reproducibility
  - Final ranked list reported (sorted by priority score descending)
---

## Derived values

Compute these from `{{repoFullName}}`:
- **repoSlug**: replace `/` with `-` (e.g., `microsoft/vscode` → `microsoft-vscode`)
- **forkName**: `<your-login>/<repo>` where `<your-login>` is the authenticated `gh` user (`gh api user --jq .login`) and `<repo>` is the part after `/` (e.g., `microsoft/vscode` → `<your-login>/vscode`)

Use these derived values wherever they appear below.

## Objective

Maintain a ranked set of upstream bug triage issues in `<forkName>`. Each issue represents a bug from `{{repoFullName}}` scored for reproducibility and confidence.

## Context

- **Upstream**: `{{repoFullName}}`
- **Fork**: `<forkName>`
- **Labels**: `bug-triage`, `confidence-high`, `confidence-medium`, `confidence-low`, `repro-easy`, `repro-medium`, `repro-hard`

## Phase 1: Survey current state

```bash
# Existing triage issues in fork
gh issue list -R <forkName> --label "bug-triage" --state open --limit 200 --json number,title,body,labels,updatedAt

# Most-reacted upstream bugs
gh api "repos/{{repoFullName}}/issues?labels=bug&state=open&sort=reactions-+1&direction=desc&per_page=50"

# Recently opened bugs
gh issue list -R {{repoFullName}} --label "bug" --state open --limit 50 --json number,title,body,createdAt,comments

# Recently closed bugs (to close our triage issues)
gh issue list -R {{repoFullName}} --label "bug" --state closed --limit 100 --json number,title,closedAt
```

## Phase 2: Score and act

### Confidence Score (1-5): Is this a real bug?

| Score | Meaning |
|-------|---------|
| **5** | Maintainer confirmed, multiple reporters, clear stack trace |
| **4** | Detailed repro, consistent with codebase, common workflow |
| **3** | Single credible reporter, plausible root cause |
| **2** | Vague, could be config issue or expected behavior |
| **1** | Probably user error or documented limitation |

### Reproducibility Score (1-5): How easy to reproduce?

| Score | Meaning |
|-------|---------|
| **5** | Clear steps, common setup, deterministic |
| **4** | Clear steps but needs specific setup |
| **3** | Multi-step setup, timing-dependent, or platform-specific |
| **2** | Intermittent, rare conditions, complex environment |
| **1** | No repro steps, race condition, specific hardware |

### Priority = confidence * reproducibility (max 25)

### Issue title format

```
[P{priority}] {upstream_issue_title} ({{repoFullName}}#{upstream_number})
```

### Creating a triage issue

```bash
gh issue create -R <forkName> \
  --title "[P{score}] {title} ({{repoFullName}}#{number})" \
  --label "bug-triage,confidence-{level},repro-{level}" \
  --assignee "$(gh api user --jq .login)" \
  --body "{body from template}"
```

## Phase 3: Verify and report

Verify:
- No duplicate triage issues
- All have correct labels
- Priority scores match formula
- All assigned to you (the authenticated `gh` user)
- Report: total count, breakdown by priority tier

## Idempotency Rules

1. Don't create duplicate triage issues — search body for `{{repoFullName}}#{number}`
2. Don't re-score without new information
3. Converge, don't diverge — each run refines, doesn't grow unboundedly
4. Respect manual overrides
5. Date-stamp all updates
