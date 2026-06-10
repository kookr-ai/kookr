---
name: oss-fork-manager
description: Fork lifecycle management for open-source contributions — fork creation, clone, upstream sync, feature branches, PR creation targeting upstream
keywords: fork, clone, upstream, sync, rebase, feature branch, open source, oss, remote, push, PR, pull request, contribution
related: [oss-repo-recon]
---

# OSS Fork Manager

Handle the fork-based contribution workflow that external open-source repos require.

## When to Use

- Setting up a fork for the first time
- Syncing fork with upstream before starting work
- Creating feature branches for contributions
- Pushing to fork and creating PRs targeting upstream

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Check if fork exists before creating | `gh repo fork` failing because fork exists | Check first, then create only if needed |
| 2 | Always set upstream remote | Pushing to wrong remote | `git remote add upstream https://github.com/{owner}/{repo}.git` |
| 3 | Rebase on upstream before branching | Branching from stale main | `git fetch upstream && git rebase upstream/{default}` |
| 4 | Push to origin (fork), PR to upstream | `git push upstream` | `git push origin {branch}` then `gh pr create -R {upstream}` |
| 5 | Track state in fork-state.json | Losing track of branches and PRs | Update `~/.claude/{repoSlug}-recon/fork-state.json` |
| 6 | Initialize contributions.json for new repos | Re-investigating already-attempted issues | Create from template `~/.claude/oss-contribution-tracking-template.json` if missing |

## Parameters

- **repoFullName**: `owner/repo` (upstream)
- **repoSlug**: URL-safe slug for state directory
- **forkName**: `<your-login>/repo` (your fork; login via `gh api user --jq .login`)
- **localPath**: `$HOME/git/repo` (local clone)
- **defaultBranch**: `main` (or `master`, `develop`)

## Fork State Schema

File: `~/.claude/{repoSlug}-recon/fork-state.json`

```json
{
  "version": 1,
  "upstream": "owner/repo",
  "fork": "<your-login>/repo",
  "local_path": "$HOME/git/repo",
  "default_branch": "main",
  "last_upstream_sync": "2026-03-28T00:00:00Z",
  "active_branches": []
}
```

Note: PR tracking and issue selection are in `contributions.json` (see Contribution Tracking below), not fork-state.json.

## Contribution Tracking Schema

File: `~/.claude/{repoSlug}-recon/contributions.json`
Template: `~/.claude/oss-contribution-tracking-template.json`

Tracks all issues attempted and PRs created. Enables dedup (don't re-investigate issues) and rate limiting (max PRs per day). Initialized from the template during fork setup.

```json
{
  "schema_version": 1,
  "repo": "owner/repo",
  "config": {
    "max_prs_per_day": 2,
    "cooldown_after_close_hours": 48
  },
  "issues": {},
  "prs": {},
  "daily_log": {}
}
```

Issue statuses: `selected` → `in-progress` → `submitted` | `skipped` | `abandoned`
PR statuses: `open` → `merged` | `closed`

## Operations

### Create Fork (idempotent)

```bash
UPSTREAM="{{repoFullName}}"
FORK="{{forkName}}"

# Check if fork exists
if gh api "repos/${FORK}" --jq '.full_name' 2>/dev/null; then
  echo "Fork ${FORK} already exists"
else
  gh repo fork "${UPSTREAM}" --clone=false
  echo "Fork created"
fi
```

### Clone Locally (idempotent)

```bash
LOCAL="{{localPath}}"

if [ -d "${LOCAL}/.git" ]; then
  echo "Clone already exists at ${LOCAL}"
else
  gh repo clone "${FORK}" "${LOCAL}"
  cd "${LOCAL}"
  git remote add upstream "https://github.com/${UPSTREAM}.git"
  echo "Cloned and upstream remote added"
fi
```

### Sync With Upstream

```bash
cd "{{localPath}}"
DEFAULT="{{defaultBranch}}"

git fetch upstream
git checkout "${DEFAULT}"
git rebase "upstream/${DEFAULT}"
git push origin "${DEFAULT}"

# Update state
SLUG="{{repoSlug}}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
cat ~/.claude/${SLUG}-recon/fork-state.json | jq \
  ".last_upstream_sync = \"${NOW}\"" \
  > /tmp/fork-state-tmp.json && mv /tmp/fork-state-tmp.json ~/.claude/${SLUG}-recon/fork-state.json
```

### Create Feature Branch

```bash
cd "{{localPath}}"
UPSTREAM="{{repoFullName}}"
DEFAULT="{{defaultBranch}}"
BRANCH_NAME="{type}/{issue-number}-{slug}"

# Ensure up to date
git fetch upstream
git checkout -b "${BRANCH_NAME}" "upstream/${DEFAULT}"
```

Branch naming conventions:
- `fix/{issue}-{slug}` for bug fixes
- `feat/{issue}-{slug}` for features
- `perf/{issue}-{slug}` for performance improvements
- `docs/{issue}-{slug}` for documentation
- `test/{issue}-{slug}` for test additions

### Push to Fork

```bash
cd "{{localPath}}"
git push origin "${BRANCH_NAME}"
```

### Create PR Targeting Upstream

```bash
UPSTREAM="{{repoFullName}}"
FORK_OWNER="$(gh api user --jq .login)"
BRANCH_NAME="{branch}"
DEFAULT="{{defaultBranch}}"

gh pr create -R "${UPSTREAM}" \
  --head "${FORK_OWNER}:${BRANCH_NAME}" \
  --base "${DEFAULT}" \
  --title "{title}" \
  --body "$(cat <<'EOF'
{PR body following repo's template from recon report}
EOF
)"
```

### Record PR in Contributions

`BASE` is the branch this PR targets upstream — the exact value passed to
`gh pr create --base`. Record it as `original_base` so future rebases (e.g.
after an upstream base-branch policy change) can use the correct 3-ref
`git rebase --onto <new_base> <original_base> <branch>` form without
guessing from the current PR state.

```bash
SLUG="{{repoSlug}}"
PR_NUM={pr_number}
BRANCH="{branch}"
BASE="{base}"            # the --base argument to gh pr create
ISSUE_NUM={issue_number}
PR_TITLE="{title}"
PR_URL="{url}"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TODAY=$(date -u +%Y-%m-%d)

cat ~/.claude/${SLUG}-recon/contributions.json | jq \
  --arg inum "${ISSUE_NUM}" \
  --arg pnum "${PR_NUM}" \
  --arg now "${NOW}" \
  --arg today "${TODAY}" \
  --arg branch "${BRANCH}" \
  --arg base "${BASE}" \
  --arg title "${PR_TITLE}" \
  --arg url "${PR_URL}" \
  '.issues[$inum].status = "submitted" |
   .issues[$inum].pr_number = ($pnum | tonumber) |
   .issues[$inum].updated_at = $now |
   .prs[$pnum] = {
     "number": ($pnum | tonumber),
     "issue_number": ($inum | tonumber),
     "branch": $branch,
     "original_base": $base,
     "title": $title,
     "status": "open",
     "created_at": $now,
     "updated_at": $now,
     "merged_at": null,
     "closed_at": null,
     "url": $url
   } |
   .daily_log[$today].prs_created += [($pnum | tonumber)]' \
  > /tmp/contrib-tmp.json && mv /tmp/contrib-tmp.json ~/.claude/${SLUG}-recon/contributions.json
```

## Initialization

Create fork-state.json and contributions.json if they don't exist:

```bash
SLUG="{{repoSlug}}"
REPO="{{repoFullName}}"
mkdir -p ~/.claude/${SLUG}-recon

if [ ! -f ~/.claude/${SLUG}-recon/fork-state.json ]; then
cat > ~/.claude/${SLUG}-recon/fork-state.json << EOF
{
  "version": 1,
  "upstream": "${REPO}",
  "fork": "{{forkName}}",
  "local_path": "{{localPath}}",
  "default_branch": "{{defaultBranch}}",
  "last_upstream_sync": null,
  "active_branches": []
}
EOF
fi

if [ ! -f ~/.claude/${SLUG}-recon/contributions.json ]; then
  sed "s|OWNER/REPO|${REPO}|" ~/.claude/oss-contribution-tracking-template.json \
    > ~/.claude/${SLUG}-recon/contributions.json
fi
```

## Anti-Patterns

- [ ] Don't push directly to upstream — always push to your fork
- [ ] Don't merge upstream into your branch — rebase instead (clean history)
- [ ] Don't force-push shared branches — use `--force-with-lease` on personal branches only
- [ ] Don't create multiple PRs from the same branch — one branch per PR
- [ ] Don't forget to sync before branching — stale bases cause merge conflicts

## See Also

- [[oss-repo-recon]] — Run before fork setup to know the default branch and conventions
- `oss-issue-scout` — Find issues before creating feature branches
- `pr-lifecycle` — PR management after creation
