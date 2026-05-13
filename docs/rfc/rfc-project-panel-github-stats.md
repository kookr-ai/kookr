# RFC: Surface repo-wide GitHub stats on the project panel

**Status:** Draft (v3 — post round-2 critic review)
**Date:** 2026-05-13
**Author:** Jean Ibarz (with Claude)

---

## Problem

The project panel shows per-project agent activity (`activeAgents`, `findingCount`, `todayPrCount`, `weekPrCount`, `openPrs`) but does not show **repo-wide** GitHub health: how many issues are open upstream, how many PRs are pending review, or a quick way to open the repository in a browser.

Users today have to recall the GitHub URL for a project, tab to a browser, and look up the issue/PR backlog out of band.

Kookr already polls GitHub regularly for **task-referenced** PRs and issues (`src/core/github-scanner-service.ts:53-78`, default 60 s cadence). That infrastructure can be extended with one new periodic GraphQL query inside the existing scanner to power the UI additions on the project drawer.

## Goals

- Show repo-wide **open-issue count** per project in the project drawer.
- Show repo-wide **open-PR count** per project in the project drawer (distinct from the existing agent-authored `openPrs`).
- Show a short list of up to 5 **pending-review PRs** per project (title + number + url).
- Provide a one-click **"Open on GitHub"** link in the drawer header.
- Reuse the existing `GitHubScannerService` lifecycle and circuit-breaker discipline — no new service class, no new state store.
- Keep the surface minimal and consistent with existing drawer-stat styling (`src/frontend/styles.css:4804-4826`).

## Non-Goals

- Do **not** add a sidebar badge in V1. Drawer-only.
- Do **not** enumerate every open PR or issue. Pending-review list is capped at 5 per repo.
- Do **not** track issue/PR detail (assignees, labels, age) at the project level — `GitHubScannerService` already covers detail for items an agent has touched.
- Do **not** add GitHub auth UI; reuse `gh` CLI auth.
- Do **not** support non-GitHub remotes (GitLab, Bitbucket, GHE). Project ID prefix `github.com/` gates the feature.
- Do **not** introduce a new settings key. Reuse `githubPollingEnabled`; the new fetch runs at a hardcoded 600 s interval.
- Do **not** support more than `MAX_TRACKED_REPOS = 100` repos in V1. Above the cap, the most-recently-active 100 are polled and the rest silently omit `repoHealth`.

## What the codebase actually offers (verified)

The existing `GitHubScannerService` polls **only PRs/issues referenced by active agents** — never repo-wide aggregates. There is no current path that calls `gh api repos/<owner>/<repo>` or queries the open-PR list for a repo. This RFC adds a new periodic fetch inside the existing scanner.

The existing fetcher already uses `gh api graphql` for review-thread queries (`src/adapters/github-fetcher.ts:148-222`), so the GraphQL pattern is familiar to the codebase.

## Empirical checkpoint (2026-05-13, `design-experimenter`)

| Claim | Result |
|-------|--------|
| One GraphQL query returns `issues(states:OPEN).totalCount`, `pullRequests(states:OPEN).totalCount`, `url` per repo | ✅ Verified on `cli/cli` |
| GraphQL bucket is separate from `core` and `search`; 5000 req/hr ceiling | ✅ Verified via `gh api rate_limit` |
| All repos batched into one request via aliases; **cost = 1 GraphQL point regardless of repo count** | ✅ Verified at N=5 (extrapolation to N=100 is by GitHub's documented per-HTTP cost model; **node-complexity** at N=100 is bounded — see Open question O-A) |
| GitHub transparently resolves renames; response body's `full_name` is canonical | ✅ Verified — no 301 header, `full_name` is the rename signal |
| `--jq` on missing field outputs bare newline → `parseInt` returns `NaN` | ✅ Must use `// 0` fallbacks |
| GitHub returns HTTP 404 (not 403) for inaccessible private repos | ✅ 404 ≠ "doesn't exist"; treat all errors as "unavailable" |
| API path is case-insensitive; `full_name` is canonical | ✅ Verified |

The design pivots from per-repo REST × N requests (v1) to a single batched GraphQL request. This is strictly simpler and cheaper.

## Requirements

- Kookr SHALL expose `repoHealth: ProjectRepoHealth | null | undefined` on `ProjectSummary` for any project whose `project` id starts with `github.com/`. The field SHALL be a neutral view-model projection — `ProjectSummary` SHALL NOT import GitHub adapter types.
- `repoUrl` SHALL be computed from `https://github.com/<owner>/<repo>` (the project id) and SHALL pass a **segment-aware** validator before being written to the wire. The raw `url` returned by GitHub SHALL be used **only** for rename detection (`full_name` divergence triggers a debug log).
- The list of pending-review PR URLs SHALL each be validated to match `https://github.com/<owner>/<repo>/pull/<number>` (lowercase owner/repo, integer number) before being written to the wire. A PR url that does not match is omitted from the list and logged.
- Kookr SHALL run **one** batched GraphQL request every 600 s containing aliased fields for every `github.com/...` project in the **active set**, capped at `MAX_TRACKED_REPOS = 100`.
- The active set SHALL be derived via a single helper `deriveActiveProjectIds(deps)` in `project-summary.ts` that both `computeProjectSummaries` (used today) and the scanner-membership push (new) call. This is the single source of truth.
- The active set SHALL be pushed into the scanner via `setTrackedGithubRepos(ids: string[])`. The scanner SHALL NOT query presentation state.
- The scanner SHALL pre-validate each project id with the segment-aware validator before including it in the batch. Invalid ids SHALL be omitted from the batch with a warn log; they SHALL NOT cause the batch to fail.
- On batch completion the scanner SHALL **intersect** the result map with the **current** tracked set (re-read at write time, not at tick-start) and write only the intersection. This avoids the eviction race where a user unpins a repo mid-tick and the cache repopulates it.
- On any error response: per-repo `data.rN === null` with `errors[].type === 'NOT_FOUND'` SHALL drop only that repo's cache entry. Any whole-batch failure (network, timeout, top-level GraphQL error like `MAX_NODE_LIMIT_EXCEEDED` or `RATE_LIMITED`) SHALL leave the previous cache untouched.
- All jq number extractions SHALL include `// 0` fallbacks. Frontend SHALL additionally guard with `Number.isFinite()` before rendering.
- The new fetch SHALL be guarded by `repoHealthInflight` set inside a `try/finally`. A watchdog timer of 60 s SHALL force-reset `repoHealthInflight = false` if the boolean is still true past the watchdog window (defense against a pathological hang inside `gh` that the 30 s `execFile` timeout failed to terminate).
- The new fetch SHALL pass the GraphQL query to `gh api graphql --input -` via stdin, not as a command-line argument, to avoid `ARG_MAX` issues on macOS at the 100-repo cap.
- The new fetch SHALL have a 30 s `execFile` timeout. On timeout: whole-batch failure path.
- The scanner's `stop()` and `reconfigure()` SHALL manage all three intervals symmetrically (`scanInterval`, `fetchInterval`, `repoHealthInterval`).
- The feature SHALL be off when `githubPollingEnabled` is false.
- The `repoHealth` field SHALL be optional on `ProjectSummary` — older clients ignore it.

## Critic feedback incorporated

**Adversarial pair resolution (design-minimalist ↔ ambition-amplifier):**

Round-1: design-minimalist won on infrastructure (no new service, no new store, no new settings keys, drawer-only); ambition-amplifier won on user intent (add `pendingReviewPrs` list). Round-2: both critics aligned. **The mechanical fixes in v3 are minimalist-led; the user-value question (`@me` filter vs `review-required`) is surfaced for the human reviewer below rather than decided unilaterally.**

**Round-2 findings, by critic:**

- **boundary-critic (Needs Revision):** v3 fixes the `RepoHealthRaw` type-leak by performing the raw → view-model mapping inside the scanner's accessor (returns `ProjectRepoHealth | undefined`); `RepoHealthRaw` moves to `github-fetcher.ts` (unexported); active-set composition is centralized in `deriveActiveProjectIds()`; `stop()`/`reconfigure()` are spec'd to manage all three intervals; the wire field `openPrs` gets a JSDoc note that the UI label is "Agent PRs"; `PendingReviewPr.url` is validated.
- **failure-mode-analyst (High risk):** segment-aware URL validator replaces the broken regex; batch input via stdin (`--input -`) eliminates ARG_MAX; pre-validation skips bad project ids without poisoning the batch; explicit error-type × cache-action table specified (see Design §6); eviction race fixed by intersecting with current tracked set at write time; try/finally + 60 s watchdog for `repoHealthInflight`; tracked-repo cap; PR-url validation; pending-review filter limitation acknowledged.
- **design-minimalist:** `getRepoHealth?` callback dropped in favor of a `ReadonlyMap<string, ProjectRepoHealth>` passed directly (matches the `prLessonsHolder` pattern); `REPO_HEALTH_INTERVAL_MS` moved out of `github-types.ts` into `github-scanner-service.ts`; `fetchBatchRepoHealth` is **not** added to the `GitHubFetcher` interface (concrete class only, called directly by the scanner — circuit-breaker delegation is dropped); O-A and O-B retired as inline notes; O-C kept.
- **socratic-challenger:** Q4 (lazy fetch on drawer open) — explicitly considered and rejected in Alternatives A5 with updated reasoning; Q7 (kill criterion) — added §"Success criterion and kill switch"; Q2 (`@me` filter) — surfaced as a **user decision** in the "Notes for reviewer" section rather than decided unilaterally; Q6 (PR-url validation) — incorporated as a requirement.

**Empirical-checkpoint (`design-experimenter` 2026-05-13):** all load-bearing GraphQL claims verified; recommended `// 0` fallbacks, stdin input, and single-batch strategy — all adopted.

**Agent invocation log:**
- `ambition-amplifier` 2026-05-13: novel finding (`pendingReviewPrs` short list, `@me` filter probe)
- `design-experimenter` 2026-05-13: verified 7/7 GraphQL claims; recommended stdin input

## Design

### 1. Neutral view-model type on `ProjectSummary`

`src/core/project-summary.ts`:

```ts
export interface PendingReviewPr {
  number: number;
  title: string;
  /** Validated to match https://github.com/<owner>/<repo>/pull/<n>. */
  url: string;
}

export interface ProjectRepoHealth {
  openIssues: number;
  openPullRequests: number;
  /** Up to 5 PRs that are open, not draft, and not approved. */
  pendingReviewPrs: PendingReviewPr[];
  /** Validated to start with https://github.com/<owner>/<repo> of this project. */
  repoUrl: string;
  /** ISO string of when this snapshot was fetched. */
  lastFetchedAt: string;
}

export interface ProjectSummary {
  // ... existing fields ...
  /**
   * Repo-wide GitHub health for `github.com/...` projects.
   * Omitted (`undefined`) for non-GitHub or unavailable; set to `null` is unused.
   */
  repoHealth?: ProjectRepoHealth;

  /**
   * Open PRs *authored by Kookr agents* for this project — from the contribution ledger.
   * Distinct from `repoHealth.openPullRequests` which is repo-wide.
   * Rendered in the drawer with the label "Agent PRs".
   */
  openPrs: number; // existing field; JSDoc added in v3
}
```

`project-summary.ts` imports no GitHub adapter types. The scanner publishes a `ReadonlyMap<string, ProjectRepoHealth>` (already mapped to the view-model type).

### 2. Active-set derivation (single source of truth)

`src/core/project-summary.ts` exports:

```ts
export function deriveActiveProjectIds(deps: ProjectSummaryDeps): string[] {
  // Same union currently used inside computeProjectSummaries (lines 70-127):
  // agents.projectId ∪ ledger.contributedProjects ∪ tracked configs
  //   ∪ skillTrackedProjects ∪ registryActiveProjects ∪ sidebarProjects
  // Filtered to `github.com/...` ids, capped at MAX_TRACKED_REPOS by recency.
}
```

`computeProjectSummaries` calls this. `src/server/index.ts` also calls this on a debounce, and calls `scanner.setTrackedGithubRepos(deriveActiveProjectIds(deps))`. Both call sites stay in sync by construction.

### 3. Segment-aware project-id validator

`src/core/project-identity.ts`:

```ts
const SEGMENT_RE = /^[a-z0-9_-][a-z0-9._-]{0,98}$/;

export function isSafeGithubProjectId(projectId: string): boolean {
  if (!projectId.startsWith('github.com/')) return false;
  const tail = projectId.slice('github.com/'.length);
  const parts = tail.split('/');
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  // GitHub limits: owner ≤ 39 chars, repo ≤ 100 chars
  if (owner.length > 39 || repo.length > 100) return false;
  // Reject "." / ".." segments, leading ".", ".git" suffix
  if (owner === '.' || owner === '..' || owner.startsWith('.') || owner.endsWith('.git')) return false;
  if (repo === '.' || repo === '..' || repo.startsWith('.') || repo.endsWith('.git')) return false;
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(repo)) return false;
  return true;
}

export function projectRepoUrl(projectId: string): string | null {
  if (!isSafeGithubProjectId(projectId)) return null;
  return `https://${projectId}`;
}

export function isSafePullRequestUrl(url: string, projectId: string): boolean {
  const expectedPrefix = projectRepoUrl(projectId);
  if (!expectedPrefix) return false;
  // Must match: <prefix>/pull/<positive integer>
  const re = new RegExp(`^${expectedPrefix.replace(/[.\-]/g, m => '\\' + m)}/pull/[1-9][0-9]{0,7}$`);
  return re.test(url);
}
```

### 4. GraphQL query (batched, via stdin)

The scanner builds the query string and pipes it to `gh api graphql --input -`. Sample shape (one alias per repo):

```graphql
{
  r0: repository(owner: "OWNER0", name: "REPO0") {
    nameWithOwner
    url
    openIssues: issues(states: OPEN) { totalCount }
    openPRs:    pullRequests(states: OPEN) { totalCount }
    pendingPRs: pullRequests(
      states: OPEN
      first: 10
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes { number title url reviewDecision isDraft }
    }
  }
  r1: repository(owner: "OWNER1", name: "REPO1") { ...same fields... }
}
```

Aliases are deterministic (`r${i}`); the scanner maintains an `i ↔ projectId` map for response decoding.

Pending-review filter (client-side):

```ts
const filtered = pendingPRs.nodes
  .filter(n => !n.isDraft && n.reviewDecision !== 'APPROVED')
  .slice(0, 5);
```

**Acknowledged limitation:** on a very busy repo (e.g., `kubernetes/kubernetes`), the top-10 most-recently-updated PRs may be dominated by bot bumps and force-pushes; the filtered top-5 may not surface the PRs the user actually needs to act on. This is a known weakness and is the motivation for Open question O-C (filter to `@me`).

### 5. New (concrete-class) fetcher method

`src/adapters/github-fetcher.ts` adds (concrete class only — **not** on `GitHubFetcher` interface, so `circuit-breaker-github-fetcher.ts` is unchanged):

```ts
// Adapter-internal; not exported from this module.
interface RepoHealthRaw {
  fullName: string;
  url: string;
  openIssues: number;
  openPullRequests: number;
  pendingReviewPrs: Array<{ number: number; title: string; url: string }>;
  lastFetchedAt: Date;
}

class GhCliFetcher /* extends ... */ {
  async fetchBatchRepoHealth(
    repos: ReadonlyArray<{ owner: string; repo: string; projectId: string }>
  ): Promise<Map<string, RepoHealthRaw> | null> {
    // - Build batched query
    // - execFile('gh', ['api', 'graphql', '--input', '-'], { input: query, timeout: 30_000 })
    // - On exit ≠ 0 or timeout: return null (whole-batch failure)
    // - Parse JSON; if top-level errors[] only with no data.r*: return null (whole-batch failure)
    // - Build result map; per-repo NOT_FOUND → omit from map; per-repo data → include
    // - For each repo, drop pending PRs whose URL fails isSafePullRequestUrl
    // - Log debug on full_name divergence
  }
}
```

### 6. Error-type × cache-action table

| Scenario | GraphQL response shape | Adapter result | Scanner action |
|----------|------------------------|----------------|----------------|
| All repos succeed | `data: { r0: {...}, r1: {...} }`, no `errors` | Map with all entries | Intersect with current tracked set; replace cache subset |
| One repo not found / inaccessible | `data: { r0: {...}, r3: null }`, `errors: [{type:NOT_FOUND, path:[r3]}]` | Map with succeeded entries only | Replace cache subset; drop `r3`'s cached entry |
| All repos null + only `errors` | `data: { r0: null, r1: null, ... }` with full errors | Return Map with no entries | No write; preserve previous cache for one tick |
| Top-level GraphQL error (`MAX_NODE_LIMIT_EXCEEDED`, `RATE_LIMITED`, syntax) | `data: null`, `errors: [...]` | Return `null` | No write; preserve previous cache |
| Transport / timeout / `gh` non-zero exit | n/a | Return `null` | No write; preserve previous cache |
| One repo's name fails pre-validation | not sent in batch | n/a | Skip; log warning |

### 7. Integration into `GitHubScannerService`

The scanner gains:

- A private `repoHealth: Map<string, ProjectRepoHealth>` — already mapped to the view-model type.
- A private `trackedRepos: Set<string>` populated via `setTrackedGithubRepos(ids)`.
- A private `repoHealthInflight = false` guard.
- A `REPO_HEALTH_INTERVAL_MS = 600_000` constant at module top.
- A `repoHealthInterval: NodeJS.Timeout | null = null`.
- A `getRepoHealthSnapshot(): ReadonlyMap<string, ProjectRepoHealth>` accessor.
- `start()`, `stop()`, `reconfigure()` updated to manage all three intervals symmetrically.

Tick body (simplified):

```ts
private async repoHealthTick(): Promise<void> {
  if (this.repoHealthInflight) return;
  this.repoHealthInflight = true;
  const watchdog = setTimeout(() => { this.repoHealthInflight = false; }, 60_000);
  try {
    const tickSet = new Set(this.trackedRepos); // snapshot at tick start
    const valid = [...tickSet]
      .filter(isSafeGithubProjectId)
      .map(projectIdToOwnerRepo);          // valid: [{owner, repo, projectId}, ...]
    if (valid.length === 0) return;
    const raw = await this.fetcher.fetchBatchRepoHealth(valid);
    if (raw === null) return;              // whole-batch failure: preserve cache
    // Re-read current tracked set at write time (eviction-race fix):
    const currentSet = this.trackedRepos;
    const next = new Map<string, ProjectRepoHealth>();
    for (const [projectId, prev] of this.repoHealth) {
      if (currentSet.has(projectId)) next.set(projectId, prev); // preserve existing for repos not in this batch
    }
    for (const [projectId, rawEntry] of raw) {
      if (!currentSet.has(projectId)) continue; // dropped from set during the tick
      next.set(projectId, mapRawToView(projectId, rawEntry));
    }
    this.repoHealth = next;
    this.onRepoHealthChanged?.();
  } finally {
    clearTimeout(watchdog);
    this.repoHealthInflight = false;
  }
}
```

### 8. Wiring `repoHealth` into `ProjectSummary`

`ProjectSummaryDeps` gains:

```ts
repoHealthCache?: ReadonlyMap<string, ProjectRepoHealth>;
```

`computeProjectSummaries` reads `deps.repoHealthCache?.get(projectId)` and sets `summary.repoHealth = ...` directly. No callback, no `RepoHealthRaw` import in this file.

`src/server/index.ts` passes `scanner.getRepoHealthSnapshot()` as `repoHealthCache`.

### 9. UI

`src/frontend/components/ProjectDetailDrawer.tsx`:

- **Drawer header**: icon-only "Open on GitHub" link (`<a target="_blank" rel="noopener noreferrer">`) rendered when `repoHealth?.repoUrl` is present.
- **Stats grid**: relabel existing "Open PRs" tile to **"Agent PRs"** (UI text only — wire field unchanged). Add two new tiles, gated on `repoHealth != null && Number.isFinite(repoHealth.openIssues)` etc.:
  - **Open issues** → `repoHealth.openIssues`.
  - **Open PRs** → `repoHealth.openPullRequests`.
  - Tooltip on each tile: `Updated <relative-time>(lastFetchedAt)`.
- **Pending review section**: rendered when `repoHealth?.pendingReviewPrs?.length > 0`. Each row: `#NUMBER · TITLE` anchored to `pr.url` with `target="_blank" rel="noopener noreferrer"`. Cap 5. Hidden when array empty.

No sidebar changes.

### 10. Settings

No new settings. Gated by existing `githubPollingEnabled`. Interval and tracked-repo cap are module-level constants in `github-scanner-service.ts`.

## Files to change

- `src/core/project-summary.ts` — `ProjectRepoHealth`, `PendingReviewPr`, `repoHealth?` on `ProjectSummary`; JSDoc on `openPrs`; `deriveActiveProjectIds`; `repoHealthCache?` in `ProjectSummaryDeps`.
- `src/core/project-identity.ts` — `isSafeGithubProjectId`, `projectRepoUrl`, `isSafePullRequestUrl`, `projectIdToOwnerRepo`.
- `src/core/github-scanner-service.ts` — `REPO_HEALTH_INTERVAL_MS`, `MAX_TRACKED_REPOS`, `trackedRepos` set, `repoHealth` map (view-model), `repoHealthInflight` + watchdog, `setTrackedGithubRepos`, `getRepoHealthSnapshot`, third interval, updates to `start`/`stop`/`reconfigure`.
- `src/adapters/github-fetcher.ts` — concrete-class `fetchBatchRepoHealth` (stdin input, 30 s timeout, per-repo error handling, PR-url validation).
- `src/server/index.ts` — debounced push of `deriveActiveProjectIds` to `scanner.setTrackedGithubRepos`; pass `scanner.getRepoHealthSnapshot()` as `repoHealthCache`.
- `src/frontend/components/ProjectDetailDrawer.tsx` — relabel, link button, two tiles, Pending-review section.
- `src/frontend/styles.css` — `.project-drawer-repo-link`, `.project-drawer-pending-prs`.
- Tests:
  - `src/core/project-identity.test.ts` — `isSafeGithubProjectId` against `..`, `.git` suffix, leading `.`, length limits, valid cases; `isSafePullRequestUrl` against off-origin, off-repo, non-numeric.
  - `src/core/project-summary.test.ts` — `deriveActiveProjectIds` returns the same union as `computeProjectSummaries`; cap behavior at `MAX_TRACKED_REPOS`.
  - `src/core/github-scanner-service.test.ts` — re-entry guard; eviction race fix (mid-tick unpin doesn't repopulate cache); watchdog resets stuck inflight; `stop()`/`reconfigure()` manage all three intervals; whole-batch failure preserves cache; per-repo NOT_FOUND drops only that entry.
  - `src/adapters/github-fetcher.test.ts` — query construction; stdin invocation; `// 0` jq fallback (NaN avoidance); partial-failure parsing; PR-url validation drops bad urls.
  - `src/frontend/components/ProjectDetailDrawer.test.tsx` — link `rel="noopener noreferrer"`, tiles hidden when `repoHealth == null`, `Number.isFinite` guard, Pending-review rendering cap, "Agent PRs" relabel.

## Rate-limit and load analysis

- GitHub buckets: `core` (5000/hr REST), `search` (30/min REST), `graphql` (5000/hr).
- This RFC consumes only `graphql`. Existing review-thread polling uses `graphql` too.
- One batched request per tick = 1 `graphql` point regardless of repo count (verified at N=5; for N=100 the node-complexity bound is the relevant constraint — see O-A).
- 1 tick / 10 min = 6 `graphql` points/hr. Against 5000/hr = **0.12 %**, independent of tracked-repo count up to `MAX_TRACKED_REPOS`.

## Edge cases

- **Repo renamed**: server-side transparent resolution; `full_name` divergence logged at debug. Drawer link continues to work via GitHub redirect. User can re-pin under canonical name when noticed.
- **Repo deleted / made private / token lacks access**: GraphQL returns `data.rN: null` + `errors[].type: NOT_FOUND`. 404 ≠ 403 here (acknowledged limitation). Entry dropped; drawer slot empty; no toast.
- **Whole batch fails**: previous cache preserved for one tick (10 min). Circuit breaker on `gh api graphql` is not added; whole-batch failures are infrequent and idempotent.
- **Forks vs upstream**: project id is `origin`. Fork's counts are shown. Future "upstream mode" follow-up.
- **`gh` not installed/auth lapse mid-day**: interval keeps firing; every tick returns `null`; cache eventually goes stale. Re-auth requires no server restart — first successful tick repopulates. Same limitation as existing scanner; not new.
- **Malformed project id**: `isSafeGithubProjectId` rejects; omitted from batch with a warn log; UI hides `repoHealth` for that project.
- **macOS ARG_MAX**: avoided by stdin `--input -`.
- **Pending-review filter on busy repo**: documented limitation; O-C addresses it.
- **Watchdog fires while fetch is genuinely in flight**: `repoHealthInflight` resets to false; a concurrent fetch is theoretically possible. Mitigation: `fetchBatchRepoHealth` itself is idempotent (cache replacement is atomic), so a duplicate fetch wastes one GraphQL point but does not corrupt state.
- **Tracked-set cap (100) exceeded**: `deriveActiveProjectIds` truncates by recency. Truncated repos render no `repoHealth` in the drawer; no error.
- **Initial render before first tick**: `repoHealth` is `undefined`; drawer hides link button, both tiles, Pending-review section. No spinner.

## Success criterion and kill switch

**Success signal** (4 weeks after ship):
- Drawer-open frequency × pending-PR-link-click rate ≥ 5 % of drawer opens that have `repoHealth.pendingReviewPrs.length > 0`. (If users open the drawer but never click the pending PRs, the list is decorative.)
- "Open on GitHub" link clicks ≥ 1 / drawer-open on average for tracked projects. (Validates the URL surface.)

**Kill criterion** (revert):
- `gh api graphql` rate-limit hits in the `graphql` bucket attributable to this feature (look at `x-ratelimit-cost` traces) exceed 5 %/hr at p99 of typical usage.
- Or: the empty-pending-list rate on tracked busy repos (`kubernetes/kubernetes`-class) exceeds 80 % over a 7-day window — meaning the filter never surfaces actionable PRs and the list is dead UI.

Both signals are observable from logs without new telemetry infrastructure (existing logger captures `x-ratelimit-*` headers when emitting fetch logs; we add a counter for empty pending lists alongside the existing scanner counters).

## Alternatives considered

### A1. Aggregate per-task `GitHubStateStore` only
Rejected: undercounts repos with no agent activity.

### A2. REST per-repo (v1 plan)
Rejected: subtraction race, distinct search-API budget, N HTTP requests.

### A3. Webhook-driven updates (GitHub App)
Rejected for V1: requires hosted infrastructure and per-repo install. Kookr is local-first.

### A4. URL link only, no counts
Rejected: user asked for counts; GraphQL pivot makes counts essentially free.

### A5. Lazy fetch on drawer open (frontend)
Rejected for V1. A frontend-only `gh api graphql` invocation needs a server endpoint anyway (the frontend can't `execFile`), so the implementation savings vs a server-side poll are smaller than they appear. Push-based polling also gives us a path to future delta detection (new PRs, comment-bumps) without re-architecting. Worth revisiting if usage data shows the drawer is opened <5×/day.

### A6. Filter pending-review PRs to `@me` / `review-requested:@me` (resolves O-C)
A genuine alternative — and stronger user value. Requires: (a) one `gh api user --jq .login` call at scanner start to resolve `@me`; (b) graceful behavior when the user has not authenticated `gh` (degrade to current `review-required` filter or skip the list); (c) a single global `search(query: "is:pr is:open review-requested:LOGIN (repo:o1/r1 OR repo:o2/r2 OR ...)", first: 50)` top-level GraphQL field, bucketed per-repo for display. This is one extra top-level field in the same batched request — still 1 GraphQL point. **Surfaced to the human reviewer below — see Notes for reviewer.**

## Open questions

- **O-A**: Node-complexity at N=100. Estimated 6 nodes per repo × 100 = 600; ceiling 500 000 (well below). Confirm by sending a real 100-repo batch in implementation; if it fails, sub-batch by 50.
- **O-B**: How to surface the rename-detection log to a human? Today it lands in debug. Defer; a future telemetry RFC can route specific log lines into UI surfaces.
- **O-C**: Filter pending PRs to `@me` (Alternative A6 above)? — **needs your decision, see below**.

---

## Notes for reviewer (you, Jean)

The biggest soft spot in this RFC is the pending-PR filter. Two options are on the table:

| Option | Filter | Behavior on `kubernetes/kubernetes`-class repos | Cost | Recommendation |
|--------|--------|--------------------------------------------------|------|----------------|
| **Current V3** | `!isDraft && reviewDecision !== 'APPROVED'`, top-5 by `UPDATED_AT-DESC` | Top-5 may be bot-bumps; can show 0 actionable | 0 extra | Ship now, iterate |
| **A6 (`@me`)** | `is:pr is:open review-requested:LOGIN` (search) | Always actionable; empty if you have no pending reviews on that repo | One extra global field in the batched query + one-time `gh api user` call at startup | Ship V1 with this |

Also flag:
- "Agent PRs" relabel is UI-only — the wire field `openPrs` keeps its name. Acceptable, or do you want the wire renamed too?
- The "Pending review" drawer section is a separate UI region from the stat tiles. Alternative: fold the list into a popover on the "Open PRs" tile. Cleaner layout, slightly more JS. Your call.
- `MAX_TRACKED_REPOS = 100` is a hard cap. If you regularly track more, raise it (and sub-batch).
