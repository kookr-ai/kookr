---
name: kookr-oss-repo-recon
description: Analyze an open-source repository's contribution requirements — CONTRIBUTING.md, PR template, CI config, CLA, build system, key reviewers — before attempting any contribution
keywords: recon, contributing, guidelines, CI, CLA, build, open source, oss, reconnaissance, setup, fork, upstream, PR template
related: [oss-fork-manager, oss-issue-scout, oss-pr-critic]
---

# OSS Repository Reconnaissance

> **First-run note:** This skill writes its output to `~/.claude/{org}-{repo}-recon/`. Per-user by design — each contributor's recon for the same repo may emphasize different conventions, fork URLs, or testing accounts. The directory is created on first run; absence is the normal initial state, not a missing dependency.

Analyze a repository's contribution culture and requirements before attempting any contribution. Produces a structured recon report that other skills and playbooks consume.

## When to Use

- Before your first contribution to any open-source repository
- When the recon report is missing or >7 days old
- When contribution guidelines may have changed (new major release, governance change)

## Non-Negotiable Rules

| # | Rule | Violation Example | Correct Pattern |
|---|------|-------------------|-----------------|
| 1 | Always check CONTRIBUTING.md first | Guessing PR format | `gh api repos/{owner}/{repo}/contents/CONTRIBUTING.md` |
| 2 | Detect CLA requirements before submitting PRs | PR blocked by CLA bot | Check for cla-bot, easycla, DCO in repo |
| 3 | Identify build/test/lint commands from CI | Running wrong test command | Parse `.github/workflows/*.yml` |
| 4 | Find the actual PR template | Missing required sections | Check `.github/PULL_REQUEST_TEMPLATE.md` and `.github/PULL_REQUEST_TEMPLATE/` |
| 5 | Identify key maintainers | Pinging random people | Analyze top reviewers from recent merged PRs |
| 6 | Write recon report to state directory | Keeping findings in conversation only | Write to `~/.claude/{repoSlug}-recon/recon-report.md` |

## Parameters

This skill expects these values from the calling playbook or context:

- **repoFullName**: `owner/repo` (e.g., `kubernetes/kubernetes`)
- **repoSlug**: URL-safe slug (e.g., `kubernetes-kubernetes`) — used for state directory

## Workflow

### Step 0: Initialize state directory

```bash
REPO_FULL="{{repoFullName}}"
SLUG="{{repoSlug}}"
mkdir -p ~/.claude/${SLUG}-recon
```

### Step 1: Fetch contribution guidelines

```bash
# CONTRIBUTING.md (or CONTRIBUTING.rst, contributing.md)
gh api "repos/${REPO_FULL}/contents/CONTRIBUTING.md" --jq '.content' 2>/dev/null | base64 -d || \
gh api "repos/${REPO_FULL}/contents/contributing.md" --jq '.content' 2>/dev/null | base64 -d || \
echo "(no CONTRIBUTING.md found)"

# CODE_OF_CONDUCT.md
gh api "repos/${REPO_FULL}/contents/CODE_OF_CONDUCT.md" --jq '.content' 2>/dev/null | base64 -d | head -20 || echo "(none)"

# CLAUDE.md (if the repo has one)
gh api "repos/${REPO_FULL}/contents/CLAUDE.md" --jq '.content' 2>/dev/null | base64 -d || echo "(none)"
```

### Step 2: Detect PR template

```bash
# Single template
gh api "repos/${REPO_FULL}/contents/.github/PULL_REQUEST_TEMPLATE.md" --jq '.content' 2>/dev/null | base64 -d || \
gh api "repos/${REPO_FULL}/contents/.github/pull_request_template.md" --jq '.content' 2>/dev/null | base64 -d || \
echo "(no PR template found)"

# Multiple templates directory
gh api "repos/${REPO_FULL}/contents/.github/PULL_REQUEST_TEMPLATE" --jq '.[].name' 2>/dev/null || echo "(no template directory)"
```

### Step 3: Detect build system and commands

```bash
# Check which build files exist
for f in Cargo.toml package.json go.mod Makefile CMakeLists.txt pyproject.toml setup.py BUILD.bazel meson.build; do
  gh api "repos/${REPO_FULL}/contents/$f" --jq '.name' 2>/dev/null && echo " -> $f exists"
done

# For monorepos, check root workspace config
gh api "repos/${REPO_FULL}/contents/package.json" --jq '.content' 2>/dev/null | base64 -d | jq '.scripts' 2>/dev/null || true
gh api "repos/${REPO_FULL}/contents/Makefile" --jq '.content' 2>/dev/null | base64 -d | head -50 || true
```

### Step 4: Analyze CI configuration

```bash
# List GitHub Actions workflows
gh api "repos/${REPO_FULL}/contents/.github/workflows" --jq '.[].name' 2>/dev/null

# Read the main CI workflow (usually ci.yml, test.yml, or build.yml)
for wf in ci.yml test.yml build.yml tests.yml CI.yml main.yml; do
  CONTENT=$(gh api "repos/${REPO_FULL}/contents/.github/workflows/$wf" --jq '.content' 2>/dev/null | base64 -d)
  if [ -n "$CONTENT" ]; then
    echo "=== $wf ==="
    echo "$CONTENT" | head -80
    break
  fi
done
```

Extract from CI config:
- Required checks (what must pass before merge)
- Test commands (`cargo test`, `npm test`, `make test`, `go test ./...`, `pytest`)
- Lint commands (`cargo clippy`, `eslint`, `golangci-lint`, `flake8`, `mypy`)
- Format commands (`cargo fmt`, `prettier`, `gofmt`, `black`)

### Step 5: Detect CLA requirements

```bash
# Check for CLA bot configurations
for f in .clabot .cla-bot .github/cla.yml .github/workflows/cla.yml; do
  gh api "repos/${REPO_FULL}/contents/$f" --jq '.name' 2>/dev/null && echo " -> CLA config found: $f"
done

# Check for DCO (Developer Certificate of Origin)
gh api "repos/${REPO_FULL}/contents/.github/workflows" --jq '.[].name' 2>/dev/null | grep -i dco

# Check recent PRs for CLA bot comments
gh api "repos/${REPO_FULL}/pulls?state=closed&sort=updated&direction=desc&per_page=5" --jq '.[0].number' | \
  xargs -I{} gh api "repos/${REPO_FULL}/issues/{}/comments" --jq '.[] | select(.user.login | test("cla|easycla|dco"; "i")) | .user.login' 2>/dev/null | head -3
```

### Step 6: Identify repo metadata

```bash
gh api "repos/${REPO_FULL}" --jq '{
  default_branch: .default_branch,
  language: .language,
  license: .license.spdx_id,
  has_issues: .has_issues,
  has_wiki: .has_wiki,
  archived: .archived,
  topics: .topics,
  open_issues: .open_issues_count,
  forks: .forks_count
}'
```

### Step 7: Detect merge strategy

```bash
# Check repo settings (requires admin access — may fail for external repos)
gh api "repos/${REPO_FULL}" --jq '{
  allow_squash: .allow_squash_merge,
  allow_merge: .allow_merge_commit,
  allow_rebase: .allow_rebase_merge,
  delete_branch_on_merge: .delete_branch_on_merge
}' 2>/dev/null

# Fallback: check recent merged PRs for merge commit pattern
gh api "repos/${REPO_FULL}/pulls?state=closed&sort=updated&direction=desc&per_page=10" \
  --jq '[.[] | select(.merged_at != null) | .merge_commit_sha] | length' 2>/dev/null
```

### Step 8: Identify key maintainers

```bash
# Top reviewers from last 20 merged PRs
SINCE=$(date -d '90 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -v-90d +%Y-%m-%dT%H:%M:%SZ)
gh api "search/issues?q=repo:${REPO_FULL}+is:pr+is:merged+merged:>=${SINCE}&per_page=20&sort=updated" \
  --jq '.items[].number' | while read -r pr; do
    gh api "repos/${REPO_FULL}/pulls/$pr/reviews" --jq '.[].user.login' 2>/dev/null
  done | sort | uniq -c | sort -rn | head -5
```

### Step 9: Check label conventions

```bash
# Good first issue and help wanted labels
gh api "repos/${REPO_FULL}/labels?per_page=100" --jq '.[].name' | grep -iE 'good.first|help.wanted|beginner|starter|easy|newcomer|contribution'
```

## Output: Recon Report

Write to `~/.claude/{repoSlug}-recon/recon-report.md`:

```markdown
# Recon Report: {owner}/{repo}

Date: {YYYY-MM-DD}

## Quick Reference

| Field | Value |
|-------|-------|
| **Language** | {primary language} |
| **Build** | `{build command}` |
| **Test** | `{test command}` |
| **Lint** | `{lint command}` |
| **Format** | `{format command}` |
| **Default branch** | {main/master/develop} |
| **Merge strategy** | {squash/rebase/merge} |
| **CLA required** | {yes — type / no} |
| **PR template** | {yes — location / no} |
| **License** | {SPDX ID} |

## Policies

<!-- Machine-consumed by pre-pr-review's base-branch check. Add one line per
     declared policy rule. Omit the line entirely if the repo has no such
     rule — an absent line is not the same as "unknown" or "main". -->

- external_pr_base: {branch-name}

Grammar is strict: exactly one space after the dash, exactly one space after the
colon, no quotes, one rule per line. Example: `- external_pr_base: litellm_oss_branch`.
When the policy changes upstream, update this section — it is the source of truth
that `pre-pr-review` compares `gh pr create --base` against.

## Contribution Process

{Parsed and summarized rules from CONTRIBUTING.md}

## CI Requirements

{Extracted from GitHub Actions — what checks must pass, what commands are run}

## Key Maintainers (last 90 days)

| Reviewer | Reviews |
|----------|---------|
| @{user1} | {count} |
| @{user2} | {count} |
| ... | ... |

## PR Template Fields

{Required sections from PR template, with notes on what each expects}

## Build System Details

{Build tool, workspace structure, monorepo info, dependencies}

## Label Conventions

- Good first issue: `{label name}`
- Help wanted: `{label name}`
- Other contribution labels: ...

## Notes

{Any unusual requirements, gotchas, or observations}
```

## AI Contribution Friendliness Assessment

As a final step after writing the recon report, assess the repo's AI-friendliness and write the result to the OSS repo registry. This enables other skills and playbooks to skip ineligible repos early.

### Assessment Signals

Evaluate these signals from the recon findings above:

| Signal | Score impact |
|--------|-------------|
| CONTRIBUTING.md has explicit AI/LLM welcome (Claude bot, `🤖` conventions, CLAUDE.md) | +3 to +5 |
| No AI policy mentioned, standard contribution process | 0 (neutral baseline: 5-6) |
| CLA required | -1 |
| Complex CI, slow review cycles, high bar | -1 to -2 |
| "Explain your changes" culture, manual review emphasis | -1 |
| Reviewer pushback on AI-generated content, LLM detection | -3 to -4 |
| Explicit anti-AI clause in CONTRIBUTING.md, automated LLM detection with auto-close | -5 (score 0-1) |

### Score Rubric

| Score | Signal |
|-------|--------|
| 10 | Actively welcomes AI: has Claude bot, CLAUDE.md, or explicit AI-agent PR conventions |
| 8-9 | AI-neutral with good signals: no anti-AI policy, fast review cycles, clear contribution docs |
| 6-7 | AI-neutral but some friction: CLA required, complex CI, slow review cycles |
| 4-5 | Ambiguous: no policy stated, but signs of skepticism |
| 2-3 | Hostile signals: reviewer pushback on AI-generated content, LLM detection |
| 0-1 | Explicit ban: CONTRIBUTING.md clause, automated LLM detection with auto-close, permanent ban policy |

### Determine Status

| Score | Status |
|-------|--------|
| 4-10 | `active` |
| 2-3 | `anti-ai` |
| 0-1 | `blocked` |

### Add Section to Recon Report

Include this section at the end of the recon report:

```markdown
## AI Contribution Friendliness

| Field | Value |
|-------|-------|
| **AI Score** | {score}/10 |
| **Status** | {active/anti-ai/blocked} |
| **Signals** | {comma-separated list of signals observed} |
| **Risks** | {any risks identified, or "None identified"} |
```

### Write to Registry (write-only-if-absent, case-insensitive dedup)

Only write to the registry if this repo does not already have an entry. To update an existing entry, edit `~/.kookr/oss-repos.json` directly.

**Canonical-casing normalization.** GitHub repo slugs are case-insensitive (GitHub will accept `berriai/litellm` and redirect to `BerriAI/litellm`), but the registry is a JSON object whose keys are case-sensitive. A naive `.repos[$repo]` lookup with a differently-cased input will return "missing" and write a second entry for the same repo. Always resolve to the canonical casing via `gh api repos/<slug> --jq .full_name` before doing any lookup or write.

```bash
REGISTRY="${HOME}/.kookr/oss-repos.json"
INPUT_REPO="${REPO_FULL}"
SCORE="{computed_score}"
STATUS="{computed_status}"
NOTE="{one-line summary of signals}"

# Create registry if it doesn't exist
if [ ! -f "$REGISTRY" ]; then
  echo '{"version":1,"repos":{}}' > "$REGISTRY"
fi

# Resolve to canonical GitHub casing. If the repo doesn't exist on GitHub,
# or gh is offline, fall back to the user's input (best-effort).
REPO=$(gh api "repos/${INPUT_REPO}" --jq .full_name 2>/dev/null || echo "$INPUT_REPO")

# Case-insensitive existence check: iterate all existing keys and compare
# lowercased. If ANY existing key matches, that's the one we update/skip —
# even if it has different casing from our canonical resolution.
EXISTING_KEY=$(jq -r --arg r "$(echo "$REPO" | tr '[:upper:]' '[:lower:]')" \
  '.repos | keys[] | select(ascii_downcase == $r)' "$REGISTRY" | head -1)

if [ -n "$EXISTING_KEY" ]; then
  EXISTING_STATUS=$(jq -r --arg k "$EXISTING_KEY" '.repos[$k].status // "unknown"' "$REGISTRY")
  echo "Registry: ${EXISTING_KEY} already exists (status: ${EXISTING_STATUS}). Skipping write. Edit ~/.kookr/oss-repos.json directly to update."
else
  TMP=$(mktemp "${REGISTRY}.XXXXXX")
  jq --arg repo "$REPO" --argjson score "$SCORE" --arg status "$STATUS" \
     --arg note "$NOTE" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
     '.repos[$repo] = {ai_score: $score, status: $status, note: $note, updated_at: $now}' \
     "$REGISTRY" > "$TMP" && mv "$TMP" "$REGISTRY"
  echo "Registry: added ${REPO} (score: ${SCORE}/10, status: ${STATUS})"
fi
```

The `gh api` call also validates that the repo exists — if a user mistypes the slug, the canonical resolution fails gracefully and the original input is used (so the skill still writes *something* and the user sees the typo in the log).

## Conventions Distillation

After writing the recon report, distill a `conventions.md` file for the AI reviewer:

```bash
CONVENTIONS_FILE="${RECON_DIR}/conventions.md"
```

Extract from the recon report and CONTRIBUTING.md:
- Language-specific style rules (naming, imports, exports, formatting)
- Test conventions (frameworks, naming, mock patterns, coverage expectations)
- PR requirements (title format, commit message format, required sections)
- CI expectations (what must pass before merge)
- Known patterns from `~/.claude/skills/pr-contribution-excellence/repo/${SLUG}.md` (if exists)

Structure with `##` section headers by language or concern area. Keep under 100 lines — this is injected into the reviewer's context window.

Write to `${CONVENTIONS_FILE}`.

## Anti-Patterns

- [ ] Don't skip the CLA check — a CLA block after PR submission wastes everyone's time
- [ ] Don't assume `main` is the default branch — check explicitly
- [ ] Don't assume CI commands from language alone — always parse the actual workflow files
- [ ] Don't ignore the PR template — filling it out correctly is table stakes
- [ ] Don't run recon if a fresh report exists (<7 days old) — read it instead

## See Also

- [[oss-fork-manager]] — Set up fork after recon
- [[oss-issue-scout]] — Find issues to contribute to, using recon context
- [[oss-pr-critic]] — Analyze PRs using recon findings for repo conventions
