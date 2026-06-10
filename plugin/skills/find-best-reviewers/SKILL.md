---
name: find-best-reviewers
description: Find the best code reviewers in a GitHub repository or for specific file paths — uses GraphQL to analyze PR review history, filters bots, weights review states, surfaces domain specialists
keywords: reviewer, review, code review, who reviews, CODEOWNERS, PR, pull request, maintainer, contributor, domain expert, github
related: [oss-repo-recon, github-trending-repos]
---

# Find Best Reviewers

Discover who actually reviews code in a GitHub repository. Answers two questions:
1. "Who should review my PR?" (path-aware)
2. "Who are the top reviewers in this repo?" (repo-wide)

## When to Use

- Before submitting a PR to an unfamiliar repo — find who to expect reviews from
- During oss-repo-recon — identify key maintainers
- When CODEOWNERS is missing or incomplete
- When scoping a contribution — find who owns a subsystem

## Parameters

- **repoFullName**: `owner/repo` (required)
- **paths**: list of file paths to filter by (optional — omit for repo-wide ranking)
- **topic**: topic keyword for global discovery mode (optional — omit for single-repo)

## Step 0: Check CODEOWNERS

Before doing any analysis, check if the repo already answers the question:

```bash
# Check both standard locations
gh api repos/{owner}/{repo}/contents/CODEOWNERS --jq '.content' 2>/dev/null | base64 -d
gh api repos/{owner}/{repo}/contents/.github/CODEOWNERS --jq '.content' 2>/dev/null | base64 -d
```

If CODEOWNERS exists and covers the target paths, report those owners. Still run the analysis below to supplement — CODEOWNERS can be stale or incomplete.

## Step 1: Fetch PR + Review Data via GraphQL

Use a single GraphQL query to fetch merged PRs with nested reviews and file paths. This is ~100x more efficient than REST (1 call vs 200+).

```bash
gh api graphql -f query='
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      states: MERGED
      first: 100
      after: $cursor
      orderBy: {field: UPDATED_AT, direction: DESC}
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        mergedAt
        files(first: 100) {
          nodes { path }
        }
        reviews(first: 50) {
          nodes {
            author { login }
            state
            submittedAt
          }
        }
      }
    }
  }
}' -f owner=OWNER -f repo=REPO > /tmp/reviewer_data.json
```

**Pagination:** If `hasNextPage` is true and the oldest PR's `mergedAt` is within 6 months, fetch the next page using `endCursor`. Stop when you exceed the 6-month window.

**Why time-window, not count-window:** "Last 200 PRs" means 10 days for rust-lang/rust but 8 years for a small project. A 6-month window produces comparable results regardless of repo velocity.

**Omit `files` field** if you only need repo-wide ranking (Tool 2) — it halves the response size.

## Step 2: Analyze with Python

Save the JSON from Step 1, then run this analysis:

```python
import json
from collections import defaultdict

with open("/tmp/reviewer_data.json") as f:
    data = json.load(f)

prs = data["data"]["repository"]["pullRequests"]["nodes"]

# 6-month cutoff (adjust date to current)
cutoff = "YYYY-MM-DD"  # 6 months ago from today
recent_prs = [pr for pr in prs if pr["mergedAt"] and pr["mergedAt"] >= cutoff]

# --- Path filtering (Tool 1 only) ---
# Uncomment and set target_paths for path-aware mode
# target_paths = ["src/server/", "src/core/types"]
# recent_prs = [pr for pr in recent_prs
#     if any(any(p.startswith(tp) for tp in target_paths)
#            for p in [f["path"] for f in pr["files"]["nodes"]])]

# Bot detection
BOTS = {
    "dependabot", "renovate", "renovate-bot", "github-actions",
    "codecov", "netlify", "vercel", "graphite-app",
    "copilot-pull-request-reviewer", "bors", "triagebot",
    "mergify", "stale", "allcontributors", "greenkeeper",
}

def is_bot(login):
    return login.lower() in BOTS or "[bot]" in login.lower()

# Score reviewers
scores = defaultdict(lambda: {
    "weighted": 0, "approved": 0, "changes_requested": 0,
    "commented": 0, "total": 0, "last_review": ""
})

for pr in recent_prs:
    for review in pr["reviews"]["nodes"]:
        if not review["author"]:
            continue
        login = review["author"]["login"]
        if is_bot(login):
            continue
        state = review["state"]
        s = scores[login]
        s["total"] += 1
        # Weight: decision-making reviews count double
        if state == "APPROVED":
            s["approved"] += 1
            s["weighted"] += 2
        elif state == "CHANGES_REQUESTED":
            s["changes_requested"] += 1
            s["weighted"] += 2
        elif state == "COMMENTED":
            s["commented"] += 1
            s["weighted"] += 1
        if review["submittedAt"] and review["submittedAt"] > s["last_review"]:
            s["last_review"] = review["submittedAt"]

# Rank and display
ranked = sorted(scores.items(), key=lambda x: (-x[1]["weighted"], -x[1]["total"]))
for i, (login, s) in enumerate(ranked[:20], 1):
    last = s["last_review"][:10] if s["last_review"] else "n/a"
    print("%-4d %-25s score=%-6d approved=%-4d changes=%-4d comments=%-4d total=%-4d last=%s" % (
        i, login, s["weighted"], s["approved"], s["changes_requested"],
        s["commented"], s["total"], last))
```

## Step 3: Interpret Results

### Reading the output

- **Score** = `(approved * 2) + (changes_requested * 2) + (commented * 1)`. Decision-makers rank higher than drive-by commenters.
- **Approved vs Changes Requested** — high changes_requested ratio suggests a thorough gatekeeper.
- **Last Review date** — check recency. A top reviewer from 5 months ago may have moved on.
- **Path-filtered vs repo-wide** — the most valuable insight comes from comparing the two. Domain specialists invisible in repo-wide rankings often surface in path-filtered results.

### What this does NOT measure

- **Review quality** — review count doesn't tell you if reviews catch bugs. There's no reliable API signal for this (revert correlation is too noisy).
- **Review depth** — a 1-line "LGTM" approval counts the same as a 50-comment deep dive. Optional enrichment (Step 4) partially addresses this.
- **Availability** — the top reviewer by history may be on vacation or burned out.

## Step 4: Optional Enrichment

Only run this if the baseline ranking needs more detail. For the top N reviewers from Step 2, fetch review comments to measure depth:

```graphql
query($owner: String!, $repo: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNumber) {
      reviews(first: 50) {
        nodes {
          author { login }
          comments(first: 100) {
            totalCount
          }
        }
      }
    }
  }
}
```

Enrichment signals:
- **Comment density** — avg inline comments per review (thoroughness)
- **File breadth** — distinct directories reviewed (generalist vs specialist)
- **Recency curve** — are they ramping up or winding down?

## Tool 3: Global Discovery (by topic)

Find top reviewers across multiple repos in a domain:

```bash
# Find top 3 repos for a topic
gh api 'search/repositories?q=topic:TOPIC+language:LANG&sort=stars&per_page=3' \
  --jq '.items[].full_name'
```

Then run Steps 1-2 on each repo. **Present results per-repo** — never blend scores across repos (a #1 reviewer in a 50-person repo isn't comparable to #1 in a 5000-person repo).

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| GraphQL over REST | 1 call fetches 100 PRs + reviews. REST needs 200+ calls for the same data |
| Time-window (6mo) over count-window (200 PRs) | Comparable results across repos of different velocities |
| State weighting (APPROVED/CHANGES_REQUESTED = 2x) | Distinguish decision-makers from drive-by commenters |
| Client-side path filtering | GitHub search API doesn't support `path:` for PR queries |
| No defect catch rate | Reverts happen for many reasons (priority, refactors) — too noisy |
| No turnaround time | Measures availability, not quality. Penalizes different timezones |
| No NLP on comment bodies | Keyword heuristics ("nit") have terrible precision on real data |
| No cross-repo blended scores | Apples-to-oranges comparison |
| CODEOWNERS checked first | Don't re-solve problems that are already solved |

## Known Limitations

1. **Bot-heavy repos** (rust-lang/rust with bors) may have sparse review data — reviews happen via PR comments, not GitHub's review system.
2. **Files field truncation** — PRs with 100+ changed files get truncated. These are usually mechanical changes so the impact on reviewer discovery is low.
3. **Private repos** require a token with appropriate scopes.
4. **Review count favors availability** — someone who rubber-stamps 100 trivial PRs outranks someone who deeply reviews 10 critical ones. State-weighting partially mitigates this.
5. **GraphQL rate limit** — 5000 points/hour. Each paginated query costs ~1 point per 100 nodes. Fine for single-repo; budget carefully for multi-repo scans.
