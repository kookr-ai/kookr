---
name: OSS Bug Fix
description: Pick the highest-priority triaged bug from any repository, reproduce, fix, test, and mark ready for review
repo-tags: [github]
parameters:
  - name: repoFullName
    description: "Upstream repo (owner/repo)"
    required: true
    type: select
    source: tracked-projects
checklist:
  - Selected highest-priority open triage issue without ready/in-progress label
  - Read upstream issue and triage issue thoroughly
  - Created or switched to fix branch from latest upstream
  - Reproduced the bug locally and documented reproduction
  - Implemented the fix
  - Added or updated tests covering the bug
  - Verified all existing tests still pass
  - Commented on triage issue with fix summary and reproduction result
  - Added ready label to triage issue
---

## Derived values

Compute these from `{{repoFullName}}`:
- **repoSlug**: replace `/` with `-` (e.g., `microsoft/vscode` → `microsoft-vscode`)
- **forkName**: `<your-login>/<repo>` where `<your-login>` is the authenticated `gh` user (`gh api user --jq .login`) and `<repo>` is the part after `/`
- **defaultBranch**: look up from recon report at `~/.claude/<repoSlug>-recon/recon-report.md`, or default to `main`
- **testCommand**: look up from recon report (build/test section), or infer from repo language
- **lintCommand**: look up from recon report, or leave empty
- **formatCommand**: look up from recon report, or leave empty

Use these derived values wherever they appear below.

## Objective

Take the top-ranked bug from the triage backlog in `<forkName>`, reproduce it, fix it, verify with tests, and mark it ready for PR creation.

## Context

- **Upstream**: `{{repoFullName}}`
- **Fork**: `<forkName>`
- **Branch naming**: `fix/{upstream-issue-number}-{short-slug}`

## Phase 1: Select a bug

```bash
gh issue list -R <forkName> --label "bug-triage" --state open --json number,title,labels \
  --jq '[.[] | select(.labels | map(.name) | (contains(["ready"]) or contains(["in-progress"])) | not)] | sort_by(.title) | reverse | .[0]'
```

## Phase 1.5: Claim the Issue

**Kookr ownership claim first** (RFC issue-ownership-lock PR 1b). Auto-populate `--repo` from the playbook parameter so forks key on the upstream home:

```bash
REPO="{{repoFullName}}"
TARGET=<selected_issue_number>
kookr issue claim "$TARGET" --repo "$REPO"
# exit 0 → you own it (or claims API off / 404 → proceed as pre-lock, R26)
# exit 6 → held by another live task → pick a different candidate, then one
#          retry after ≥1 reconcile tick; if still stuck emit exhausted:
#   curl -fsS -X POST "${KOOKR_API_BASE_URL:-http://127.0.0.1:4800}/api/issue-claims/exhausted" \
#     -H 'Content-Type: application/json' \
#     -d "{\"repo\":\"$REPO\",\"number\":$TARGET,\"taskId\":\"$KOOKR_TASK_ID\",\"reason\":\"reselection_exhausted\"}" || true
# exit 3 → server unreachable → bounded park (R25); do not start work
```

**Before any implementation work**, also comment on the upstream issue to announce intent:
```bash
gh api repos/{{repoFullName}}/issues/{upstream_number}/comments -f body="I'd like to work on this."
```
If the upstream issue is assigned to someone else, **STOP** — pick a different issue. Do not work on someone else's assigned issue, not even partially.

## Phase 2: Reproduce

```bash
git fetch upstream
git checkout -b fix/{upstream_number}-{slug} upstream/<defaultBranch>
```

Follow reproduction plan from triage issue. If reproduction fails, comment and stop.

## Phase 3: Fix

1. Implement the minimal fix
2. Match existing code style
3. No unrelated changes
4. Add regression test

```bash
<testCommand>
<lintCommand>
<formatCommand>
```

## Phase 4: Mark ready

1. Commit: `fix: {description} — Fixes {{repoFullName}}#{upstream_number}`
2. Push: `git push origin fix/{upstream_number}-{slug}`
3. Comment on triage issue with fix summary
4. Add `ready` label, remove `in-progress`

## Idempotency Rules

1. One bug per run
2. Don't re-fix ready issues
3. Don't re-fix issues with existing fix branches (unless stale >7 days)
4. Clean up on failure — remove in-progress, comment explaining why
