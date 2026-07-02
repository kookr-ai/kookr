---
name: OSS Bug PR
description: Find ready-labeled triage issues and create upstream PRs for any repository
repo-tags: [github]
deliveryPreAuthorized: true
parameters:
  - name: repoFullName
    description: "Upstream repo (owner/repo)"
    required: true
    type: select
    source: tracked-projects
checklist:
  - Listed all triage issues with ready label
  - Filtered out issues that already have a linked PR
  - Verified fix branches exist and are clean
  - Rebased fix branches on latest upstream
  - Verified tests pass after rebase
  - Created upstream PRs following repo conventions
  - Commented on triage issues with PR links
  - Replaced ready label with pr-submitted
  - Final summary reported
---

## Derived values

Compute these from `{{repoFullName}}`:
- **repoSlug**: replace `/` with `-` (e.g., `microsoft/vscode` → `microsoft-vscode`)
- **forkName**: `<your-login>/<repo>` where `<your-login>` is the authenticated `gh` user (`gh api user --jq .login`) and `<repo>` is the part after `/`
- **defaultBranch**: look up from recon report at `~/.claude/<repoSlug>-recon/recon-report.md`, or default to `main`
- **testCommand**: look up from recon report (build/test section), or infer from repo language

Use these derived values wherever they appear below.

## Objective

Find triage issues marked `ready` in `<forkName>` and create upstream PRs on `{{repoFullName}}`.

If you face a design choice the issue does not settle, pick the smallest implementation that satisfies the issue, note the choice and alternatives in the PR description, and continue. Do not stop to ask.

## Context

- **Upstream**: `{{repoFullName}}`
- **Fork**: `<forkName>`
- **Labels consumed**: `ready` -> **produced**: `pr-submitted`

## Phase 1: Find eligible issues

```bash
gh issue list -R <forkName> --label "bug-triage,ready" --state open --json number,title,body,comments
```

Check no PR already exists:
```bash
gh pr list -R {{repoFullName}} --author "@me" --state open --json number,title,headRefName
```

## Phase 2: Prepare each fix

```bash
git checkout fix/{upstream_number}-{slug}
git fetch upstream
git rebase upstream/<defaultBranch>
<testCommand>
git push origin fix/{upstream_number}-{slug} --force-with-lease
```

## Phase 3: Create upstream PR

Load recon report for PR template:
```bash
cat ~/.claude/<repoSlug>-recon/recon-report.md 2>/dev/null
```

Load patterns for description best practices:
```bash
cat ~/.claude/<repoSlug>-pr-lessons/patterns.md 2>/dev/null
```

Create PR:
```bash
if [ -f .github/PULL_REQUEST_TEMPLATE.md ]; then
  mkdir -p .tmp
  cp .github/PULL_REQUEST_TEMPLATE.md .tmp/pr-body.md
elif [ -f .github/pull_request_template.md ]; then
  mkdir -p .tmp
  cp .github/pull_request_template.md .tmp/pr-body.md
else
  mkdir -p .tmp
  cat > .tmp/pr-body.md <<'EOF'
## Summary
{Bug description and fix}

Fixes #{upstream_number}

## Root Cause
{What was wrong}

## Fix
{What was changed}

## Testing
{Tests added/modified}
EOF
fi
```

Edit `.tmp/pr-body.md` to follow the upstream template and include final verification. Tick or strike every marked checklist row if present. Run `gh pr create` in a separate shell command after the file already exists:

```bash
gh pr create -R {{repoFullName}} \
  --head "$(gh api user --jq .login):fix/{upstream_number}-{slug}" \
  --base <defaultBranch> \
  --title "fix: {description}" \
  --body-file .tmp/pr-body.md
rm -f .tmp/pr-body.md
```

Update triage issue:
```bash
gh api repos/<forkName>/issues/{triage_number}/labels -X PUT --input - <<'EOF'
{"labels":["bug-triage","pr-submitted"]}
EOF
```

## Idempotency Rules

1. Don't create duplicate PRs
2. Don't re-submit rejected PRs — flag for human attention
3. Process all eligible issues in one run
4. Rebase, don't merge
5. Date-stamp all comments
