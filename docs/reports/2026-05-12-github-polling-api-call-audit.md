# GitHub Polling API Call Audit

**Date:** 2026-05-12
**Scope:** GitHub PR/issue awareness pipeline: reference detection, state polling, diffing, alert broadcast, and dashboard display.

## Verdict

The prior implementation was correct but not API-minimal. At each polling interval it made three `gh` calls per tracked PR plus one `gh` call per tracked issue:

```
calls_per_poll = (3 * tracked_prs) + tracked_issues
```

It also refetched every known reference immediately after detecting a new PR or issue reference.

The implementation now reduces periodic polling to the strict minimum available under the current polling constraint without adding webhooks:

```
calls_per_poll = distinct_repositories_with_tracked_refs
```

Each repository is fetched with one GraphQL request containing aliased PR and issue selections. Immediate fetches after new reference detection only fetch the newly detected references.

## Pipeline

1. `src/server/event-pipeline.ts` forwards hook events to `GitHubScannerService.processEventsImmediate()`.
2. `src/server/agent-lifecycle.ts` asks `GitHubScannerService.processTaskPrompt()` to scan the launch prompt.
3. `src/core/github-reference-scanner.ts` extracts deterministic PR/issue references.
4. `src/core/github-scanner-service.ts` stores new references, fetches state, diffs snapshots, and emits changes.
5. `src/adapters/github-fetcher.ts` fetches GitHub state through `gh api graphql`.
6. `src/server/index.ts` broadcasts `githubUpdate` messages and alert messages.
7. `src/frontend/hooks/useWebSocket.ts` and `src/frontend/components/GitHubPanel.tsx` render live PR/issue state.

## Related Polling Surface

Kookr also has an OSS attempts refresh path in `src/server/oss-refresh.ts`. That path powers the OSS productivity dashboard, not the live per-task GitHub tab. It already uses `gh pr list` once per configured external repository and parses PR bodies from that list response to avoid a per-PR `gh pr view` call. It only performs extra `gh api repos/{owner}/{repo}/issues/{N}` calls for newly closed PRs whose linked issue state needs verification, under a bounded `GH_CALL_BUDGET`.

This audit therefore changes the live PR/issue awareness poller, where the repeated per-PR calls were still present.

## Findings

### 1. Periodic polling used per-reference subprocesses

Previous PR polling executed:

- `gh pr view`
- `gh pr checks`
- `gh api graphql` for review threads/reviews

Issues executed `gh issue view`. With 10 PRs in one repository, a single poll used 30 `gh` calls. At the default 60 second interval, that is 1,800 calls/hour before issues.

Now one repository-level GraphQL query fetches all PR and issue fields needed by the dashboard and diff engine. With 10 PRs and any number of tracked issues in one repository, a single poll uses 1 `gh` call.

### 2. New reference detection caused unrelated refetches

Previous behavior called the full polling path when a new reference was detected. If a task already had many tracked refs, detecting one new PR immediately refreshed all of them.

Now the immediate path passes only the newly added references into the fetch path. Periodic polling remains responsible for refreshing the full known set.

### 3. Existing UI and alert contracts were reusable

No frontend protocol change was needed. The server still emits `githubUpdate` with full task-level PR/issue arrays and still emits alert messages for actionable changes. The optimization is inside the fetch path.

### 4. Per-task display must not fight API minimization

The previous in-memory store keyed references by `owner/repo#number`, which avoided duplicate polling but also meant a second task referencing the same PR would not get its own GitHub panel state. It also allowed PR #N and issue #N in the same repo to collide.

References are now keyed by task, type, owner, repo, and number. The batch query builder still deduplicates the actual GitHub object selection, so multiple tasks can display the same PR without adding API calls.

### 5. Remaining non-API costs

`gh auth status` still runs once when GitHub polling starts. Owner/repo inference still shells out to `git remote get-url origin`, cached per cwd. Both are local subprocess costs rather than GitHub API polling costs.

## Call Budget

For a polling interval `T`, `P` tracked PRs, `I` tracked issues, and `R` distinct repositories:

| Scenario | Before | After |
| --- | ---: | ---: |
| Periodic poll | `3P + I` | `R` |
| One new PR detected | `3P + I` | `1` for that PR's repo |
| One repo, 10 PRs, 0 issues, 60s | 1,800 calls/hour | 60 calls/hour |
| Three repos, 10 PRs total, 60s | 1,800 calls/hour | 180 calls/hour |

The only lower-call design would be GitHub webhooks, but ADR-012 rejected that for local-only V1 operation because it requires public ingress/tunnel setup.

## Verification

Added focused tests for:

- Batched scanner use of `fetchStates()` instead of per-ref `fetchPRState()`/`fetchIssueState()`
- Immediate fetching of only newly detected refs
- GraphQL query shape with aliased PR/issue selections
- Parsing batched PR checks, review threads, review decision, comments, and issue labels/comment counts
