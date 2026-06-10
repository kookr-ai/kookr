---
name: kookr-oss-dashboard-verify
description: Verify the OSS contribution dashboard is accurate by comparing the store (GET /api/oss-attempts) against GitHub reality via gh CLI. Reports missing, phantom, and state-drifted PRs.
keywords: oss, dashboard, verify, audit, drift, reconciliation, gh, pr, tracking, accuracy
related: [kookr-oss-contribution-gate, kookr-oss-repo-recon]
---

# OSS Dashboard Verification

Check whether the OSS contribution dashboard panel shows the same PRs GitHub does. Run this periodically to confirm the refresher is working and the store has not drifted.

## When to Use

- User asks "is the OSS dashboard accurate?" or "check my OSS tracking"
- After deploying changes to `src/server/oss-refresh.ts` or `src/core/oss-attempt-store.ts`
- Before relying on the dashboard for reporting or analysis
- Suspected refresh failure (stale `lastRefreshAt`, missing entries, wrong state)

## What It Checks

1. The prod API is reachable and `lastRefreshAt` is recent.
2. Every PR in the store exists on GitHub with the same state (open/merged/closed).
3. Every `@me`-authored PR on GitHub in a tracked external repo is in the store.
4. Counts per repo match (opened / merged / closed / open).
5. Registry repos with `status != active` are correctly excluded from processing.
6. Own-namespace PRs (owner in `DEFAULT_OWN_NAMESPACES`) are correctly excluded.

## How the Dashboard Gets Its Data (quick mental model)

- Registry: `~/.kookr/oss-repos.json` lists repos + status (`active` | `blocked` | `anti-ai` | ...)
- Refresher (`src/server/oss-refresh.ts`): for each active external repo, runs
  `gh pr list --repo R --author @me --state all --limit 100 --json ...`,
  normalizes state (`MERGED`→`merged`, `CLOSED`→`closed`, else `pr_open`),
  and upserts into the store keyed by `(repo, prNumber)`.
- Store (`src/core/oss-attempt-store.ts`): file-backed JSON at `~/.kookr/oss-attempts.json`.
- Frontend (`OssProductivityView.tsx`): reads `GET /api/oss-attempts`.

GitHub is the source of truth; this skill re-runs the same underlying `gh` queries the refresher runs, then diffs.

## Parameters

- **apiBase** (optional): Kookr API base URL. Default: `http://localhost:4800` (prod). Use `http://localhost:4801` for dev.
- **registryPath** (optional): Path to the registry. Default: `~/.kookr/oss-repos.json`.

## Workflow

### Step 1: Snapshot the store

```bash
curl -s "${apiBase:-http://localhost:4800}/api/oss-attempts" > /tmp/oss-attempts.json
jq '.lastRefreshAt' /tmp/oss-attempts.json
jq '.attempts | length' /tmp/oss-attempts.json
jq '.attempts | group_by(.state) | map({state: .[0].state, count: length})' /tmp/oss-attempts.json
```

If `lastRefreshAt` is older than ~24h or the snapshot is empty, trigger a refresh before continuing:

```bash
curl -s -X POST "${apiBase:-http://localhost:4800}/api/oss-attempts/refresh" | jq .
```

### Step 2: Identify active external repos

```bash
jq -r '.repos | to_entries[] | select((.value.status // "active") == "active") | .key' ~/.kookr/oss-repos.json
```

Then exclude own-namespace repos. Own namespaces are defined in `src/core/oss-attempt-store.ts` as `DEFAULT_OWN_NAMESPACES` — currently `['jeanibarz']`. Re-read that file in case it has changed.

### Step 3: Fetch GitHub PRs per repo in parallel

Use a parallel loop with `&` + `wait`. Never serial — 14 repos × 1s each adds up.

```bash
for repo in $REPOS; do
  slug=$(echo "$repo" | tr '/' '-')
  gh pr list --repo "$repo" --author @me --state all --limit 100 \
    --json number,title,url,state,createdAt,mergedAt,closedAt,updatedAt \
    > "/tmp/gh-${slug}.json" &
done
wait
```

Batch ≤ 7 at a time to avoid overwhelming `gh` and hitting GitHub secondary rate limits.

### Step 4: Diff store vs GitHub

For each repo, compare the set of `(prNumber, state)` pairs.

- **Missing from store**: exists on GitHub but not in store → refresh may be broken or the repo was added to the registry after the last refresh.
- **Phantom in store**: exists in store but not on GitHub → PR was deleted, or repo was renamed.
- **State drift**: same `prNumber` but different state → refresh hasn't picked up a state transition; try POST `/api/oss-attempts/refresh` and re-check.
- **Count mismatch per repo**: if per-repo opened/merged/closed totals differ, investigate the specific PRs.

### Step 5: Spot-check cross-repo completeness

Run a broad search to catch PRs in external repos that aren't in the registry at all:

```bash
gh api "search/issues?q=author:jeanibarz+is:pr+created:>=$(date -I -d '30 days ago')&per_page=100" \
  --jq '.items[] | "\(.state)\t\(.repository_url | split("/") | .[-2:] | join("/"))#\(.number)\t\(.title)"'
```

Any external repo showing up here that is not in the registry is a **tracking gap** — the user probably wants it added.

### Step 6: Report findings

Output a concise summary:

- Totals: store vs GitHub (PR-only; exclude `scouted` from GitHub comparison).
- Per-repo table: ✓ or mismatch.
- `lastRefreshAt` freshness.
- Any missing / phantom / drifted PRs listed explicitly with `owner/repo#number`.
- "Nothing to correct" if all clean — say it plainly.

## Non-Negotiable Rules

| # | Rule | Why |
|---|------|-----|
| 1 | Always read the store via the HTTP API, never from the JSON file directly | The server is the authority; the file on disk may be mid-save |
| 2 | Never modify `~/.kookr/oss-attempts.json` by hand to "fix" drift | The next refresh would clobber your edit; fix the root cause instead |
| 3 | Parallelize `gh pr list` calls | Serial is 10x slower for no reason |
| 4 | Re-check `DEFAULT_OWN_NAMESPACES` from source, don't hardcode `jeanibarz` | It may change |
| 5 | Filter registry entries to `status == "active"` (or missing) | `blocked` and `anti-ai` repos are intentionally not refreshed |
| 6 | Do not trigger a refresh unless the store is stale or empty | Refresh burns gh API quota; reuse existing data when fresh |
| 7 | Exclude `scouted` state from GitHub-comparison counts | Scouted entries are issues, not PRs — GitHub has no notion of them |

## Exit Criteria

- All PR records in the store match GitHub by `(repo, prNumber, state)`.
- All GitHub `@me` PRs in active external repos appear in the store.
- `lastRefreshAt` is fresh.
- Per-repo totals match.

If any check fails, report precisely which records mismatch. Do not attempt auto-repair — let the user decide whether to rerun the refresher, edit the registry, or investigate the refresher code.

## Related Files

- `src/server/oss-refresh.ts` — the refresher logic
- `src/core/oss-attempt-store.ts` — store schema and own-namespace definition
- `src/server/routes/oss-attempts-routes.ts` — the HTTP API
- `src/frontend/components/OssProductivityView.tsx` — what the user sees
- `~/.kookr/oss-repos.json` — registry
- `~/.kookr/oss-attempts.json` — store on disk (read-only for this skill)
