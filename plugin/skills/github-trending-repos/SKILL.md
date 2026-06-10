---
name: github-trending-repos
description: Find and rank trending GitHub repositories by real activity signals (commit velocity, PR throughput, contributor growth) — filters out non-code repos and scores for contribution opportunity
keywords: github, trending, stars, repos, popular, contribute, open source, ranking, activity, performance optimization, contribution
related: [pre-pr-review]
---

# GitHub Trending Repos — Contribution Opportunity Finder

Discover which public GitHub repositories are genuinely active and welcoming to contributors, ranked by real activity signals rather than raw star count.

## When to Use

- Looking for open-source projects to contribute to
- Evaluating which repos are "hot" vs stagnant
- Finding performance optimization opportunities in popular projects
- Periodic scan of the OSS landscape

## Step 1: Discover Candidate Repos

Gather a broad list of popular repositories from multiple sources.

### 1a. GitHub Ranking Lists

Fetch the top-100-stars list for a comprehensive baseline:

```bash
# Fetch the curated top-100 list (auto-updated daily)
gh api repos/EvanLi/Github-Ranking/contents/Top100/Top-100-stars.md \
  --jq '.content' | base64 -d
```

### 1b. GitHub Trending Page

Use WebSearch to find currently trending repos:

```
WebSearch: "github trending repositories this week 2026"
WebSearch: "github trending {language} repositories" (e.g., TypeScript, Rust, Python)
```

### 1c. Language-Specific Rankings

For targeted searches by language:

```bash
# Top repos by language (replace LANG)
gh api repos/EvanLi/Github-Ranking/contents/Top100/LANG.md \
  --jq '.content' | base64 -d
```

Available: `TypeScript.md`, `Rust.md`, `Python.md`, `Go.md`, `CPP.md`, `Java.md`, `JavaScript.md`, etc.

## Step 2: Filter Non-Code Repositories

Remove repos that are not actual software projects. Exclude:

| Category | Examples | Why Exclude |
|----------|----------|-------------|
| Curated lists | awesome-*, public-apis | Markdown only, no code to optimize |
| Learning resources | freeCodeCamp curriculum, coding-interview-university | Educational content, not software |
| Books / guides | You-Dont-Know-JS, free-programming-books | Text, not code |
| Prompt collections | prompts.chat, system-prompts | No code |
| Style guides | airbnb/javascript | Reference, not runnable |
| Template collections | gitignore | Configuration files, not software |
| Non-software | HowToCook, 996.ICU | Not code projects |

**Keep:** Frameworks, runtimes, libraries, tools, applications, compilers, engines — anything where code contributions (features, bugs, performance) are the primary activity.

## Step 3: Collect Activity Signals

For each candidate repo, collect these metrics via GitHub API. Batch in groups of 5-10 to stay within rate limits.

### 3a. Basic Metadata

```bash
# Single repo metadata
gh api repos/{owner}/{repo} --jq '{
  stars: .stargazers_count,
  forks: .forks_count,
  open_issues: .open_issues_count,
  pushed_at: .pushed_at,
  language: .language,
  license: .license.spdx_id,
  archived: .archived
}'
```

### 3b. Commit Activity (last 52 weeks)

```bash
# Weekly commit counts — sum last 4 weeks for "recent" signal
gh api repos/{owner}/{repo}/stats/commit_activity \
  --jq '[.[-4:][] | .total] | {last_4_weeks: add, weekly_avg: (add/4)}'
```

### 3c. Community vs Owner Commits

```bash
# participation: .all = everyone, .owner = maintainers only
# High (all - owner) ratio = healthy community
gh api repos/{owner}/{repo}/stats/participation \
  --jq '{
    community_last_4w: ([.all[-4:][]] | add) - ([.owner[-4:][]] | add),
    owner_last_4w: [.owner[-4:][]] | add,
    total_last_4w: [.all[-4:][]] | add
  }'
```

### 3d. PR Throughput (last 30 days)

```bash
SINCE=$(date -d '30 days ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -v-30d +%Y-%m-%dT%H:%M:%SZ)

# PRs merged in last 30 days
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    pullRequests(states: MERGED, last: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      nodes {
        mergedAt
      }
    }
  }
}' --jq '[.data.repository.pullRequests.nodes[] | select(.mergedAt > "'"$SINCE"'")] | length'
```

### 3e. Issue Velocity (last 30 days)

```bash
# Issues opened in last 30 days
gh api "repos/{owner}/{repo}/issues?state=all&since=$SINCE&per_page=100" \
  --jq '[.[] | select(.pull_request == null)] | length'
```

### 3f. Recent Releases

```bash
# Days since last release (0 = very active, 365+ = stale)
gh api repos/{owner}/{repo}/releases?per_page=1 \
  --jq '.[0].published_at // "none"'
```

### 3g. Contributor Count (active recently)

```bash
# Contributors with commits in last 90 days
gh api repos/{owner}/{repo}/stats/contributors \
  --jq '[.[] | select(.weeks[-13:][] | .c > 0)] | length'
```

## Step 4: Score and Rank

### Normalize Each Metric

For each metric, normalize to 0-1 across the candidate set:

```
normalized(x) = (x - min) / (max - min)
```

If `max == min`, set all values to 0.5.

### Composite Trending Score

```
trending_score =
    0.25 x normalized(commits_last_4_weeks)
  + 0.25 x normalized(prs_merged_last_30d)
  + 0.15 x normalized(issues_opened_last_30d)
  + 0.15 x normalized(community_commit_ratio)
  + 0.10 x normalized(active_contributors_90d)
  + 0.10 x recency_bonus(last_release)
```

**recency_bonus:**
- Released in last 7 days: 1.0
- Released in last 30 days: 0.8
- Released in last 90 days: 0.5
- Released in last 180 days: 0.2
- Older or no release: 0.0

### Optional: Performance Optimization Affinity

Add a bonus column for repos where perf work is especially valued:

| Signal | Bonus |
|--------|-------|
| Language is C, C++, Rust, Go | +0.2 |
| Has `performance` or `optimization` label in issues | +0.15 |
| Repo description mentions "fast", "efficient", "runtime", "engine" | +0.1 |
| Has benchmarks directory or CI benchmark job | +0.1 |

Check for perf labels:

```bash
gh api "repos/{owner}/{repo}/labels" --jq '.[].name' | grep -iE 'perf|optim|speed|benchmark'
```

## Step 5: Output Report

Present results as a ranked table:

```markdown
## Trending GitHub Repos — {date}

| # | Repository | Stars | Language | Trending Score | Perf Affinity | Highlights |
|---|-----------|------:|----------|:--------------:|:-------------:|------------|
| 1 | owner/repo | 100k | Rust     | 0.92           | High          | 85 PRs/month, daily releases |
| ...
```

### Highlight Column — What to Call Out

- Exceptional PR merge rate
- Very high community-to-owner commit ratio (welcoming to outsiders)
- Recent surge in stars or forks
- Active "good first issue" or "help wanted" labels
- Performance-related issues open

### Good First Issue Check

For repos the user is interested in:

```bash
gh api "repos/{owner}/{repo}/issues?labels=good+first+issue&state=open&per_page=5" \
  --jq '.[] | {number, title, labels: [.labels[].name]}'
```

## Rate Limit Awareness

The GitHub API has rate limits (5000 requests/hour for authenticated users). For a set of 50 repos, this workflow uses ~7 API calls per repo = ~350 calls. Safe for a single run.

Check remaining quota:

```bash
gh api rate_limit --jq '.rate | "Remaining: \(.remaining)/\(.limit) — resets \(.reset | todate)"'
```

If running low, prioritize Step 3b (commit activity) and 3d (PR throughput) — these are the highest-signal metrics.

## Anti-Patterns

- [ ] Don't rank by raw star count alone — stars measure historical popularity, not current activity
- [ ] Don't include archived repos (check `.archived` field)
- [ ] Don't include repos with no commits in the last 90 days
- [ ] Don't assume high stars = welcoming to contributors (check community commit ratio)
- [ ] Don't skip the filter step — curated lists pollute the ranking
- [ ] Don't exceed API rate limits — batch calls and check quota

## See Also

- `pr-lifecycle` — once you've picked a repo, follow the PR lifecycle for contributing
- [[pre-pr-review]] — self-review checklist before submitting to external projects
- [[git-commit-discipline]] — commit conventions expected by most large OSS projects
