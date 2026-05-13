# RFC: Project Drawer — Active-Task Overlay on Authored Issues/PRs

**Status:** Implemented (v3.1 — implementation diverged from v3 after discovering existing repo-wide surface)
**Date:** 2026-05-13
**Author:** Jean Ibarz (with Claude Opus 4.7)

---

## Implementation note (v3.1)

Between v3 (converged design) and implementation, the working tree was found to already ship `ProjectRepoHealth` (introduced in #286, merged just before this branch). That model renders **repo-wide** `Open issues` and `Open PRs` on the drawer — the very surface the user was pointing at.

The RFC's "authored-only" choice (per the v0 clarifier) was made before that surface was visible. Re-confirmed with the user during implementation: the overlay should attach to the existing repo-wide denominators, not introduce a new authored-only count.

Concrete divergence from v3:

- **No `gh issue list --author @me`** added to `OssRefresher`. The denominator is `repoHealth.openIssues` / `repoHealth.openPullRequests` (existing).
- **No `AuthoredOpenIssueMap`** or `getAuthoredOpenIssueMap()` accessor on the refresher.
- **No `GitHubStateStore` shape migration.** The store is already keyed by `(taskId, type, owner, repo, number)` (full key); multi-task is handled, and the same-task dedup test (round-2 FM-A) already exists.
- **No fetcher dedup change** in `GitHubScannerService`. Multi-task on the same target double-fetches (wasteful but correct); optimization deferred.
- **No `parseGithubProjectId` helper** added; `projectIdToOwnerRepo` + `isSafeGithubProjectId` from `project-identity.ts` already exist and are reused.

What v3 produced that was still implemented:

- `buildGithubTaskOverlay(input)` at `src/server/use-cases/github-task-overlay.ts` — pure function, plain-data input, no service imports. Inputs are `agents: AgentState[]` and `getReferences: (taskId) => GitHubReference[]`.
- Three new optional fields on `ProjectSummary`: `openIssuesTiedToActiveTasks`, `openPrsTiedToActiveTasks`, `activeTaskGithubLinks`.
- `getProjectSummaries` (in `use-cases/get-snapshot.ts`) accepts an optional `getTaskGithubReferences` accessor; when supplied, the overlay is computed and stamped.
- `ProjectDetailDrawer` renders `tied/total` on the existing `Open issues` / `Open PRs` rows when at least one tied item exists; falls back to plain total otherwise. Tooltip lists `#N ← <taskName>` rows.

Files added / changed: see git diff on this branch.

---

## Problem

The Project Detail Drawer (`src/frontend/components/ProjectDetailDrawer.tsx`) currently shows isolated per-project counters:

- **Today's PRs** — `todayPrCount / dailyLimit`
- **This week** — `weekPrCount`
- **Open PRs** — count of `ContributionAttempt` records where `state === 'pr_open'`
- **Active agents** — count of inProgress agents on this project

These two clusters — "what's on GitHub" and "what's running in Kookr" — are visually adjacent but semantically disconnected. The user has to do the join in their head:

> "Are my 4 open PRs being driven by the 3 active agents, or are 4 PRs sitting unattended while the agents work on something else? Are my 2 authored open issues being processed right now?"

There is currently no per-project "your open issues" count anywhere in the UI. The user's intuition is correct — these counts acquire meaning only when cross-referenced against current Kookr task state.

User's framing:

> "If there are 10 issues and 3 agents are running on 3 separate issues + 1 agent running on 2 issues, this means amongst the 10 issues there are 5 that are currently being processed in Kookr. Or if the number of PRs is 10 but there are 3 completed tasks that just created/opened PRs, we could say there are 3 amongst the 10 PRs that are related to current tasks."

Scope, after a clarifier question to the user:

| Question | Answer |
|---|---|
| What population are the totals drawn from? | Items **authored by `@me`** on this repo (matches `gh issue list --author @me --state open` and the existing `gh pr list --author @me`). |
| Which tasks count as "related"? | Tasks with `status === 'inProgress'` and `projectId === <this repo>`. |
| Where is the v1 surface? | The Project Detail Drawer stats strip (compact and full). |

## Empirical checkpoint

Round-1 critics raised four load-bearing claims that change the design. Each was verified by code/playbook inspection before round 2:

- **`GitHubStateStore.references` is keyed by `owner/repo#number` and `addReference` returns `false` on duplicate.** Confirmed at `src/core/github-state-store.ts:14` and `:24`. The first observing task's `taskId` is recorded; subsequent observers are silently lost. As a consequence, `getReferences(taskB.id)` does **not** return refs that task A observed first — even when task B genuinely touches the same issue. The original v1 design assumed this worked correctly; it does not.
- **`task.playbookParameterValues` uses camelCase keys (`issueSelector`, `repo`, `mergeAfterImplementation`, `assignee`, `allowOtherAuthors`).** Confirmed at `.kookr/playbooks/implement-github-issue.md` frontmatter. No `TARGET` parameter exists. The v1 RFC's lookup of `playbookParameterValues?.TARGET` would never match.
- **`TARGET` is a shell variable computed inside the agent at Phase 0**, derived from `issueSelector` against a manifest of eligible candidates. It is never written back to the `Task` record. Confirmed at the same playbook, Step 0d (`Capture as TARGET`). The chosen issue number is observable only when the agent emits a `gh issue view "$TARGET"` tool call, which `GitHubScannerService.processEventsImmediate` already captures.
- **`gh issue list --author @me` field availability matches `gh pr list`.** The `number,title,url,createdAt,updatedAt` selector works on gh ≥ 2.4.0 (the same floor `oss-refresh.ts` already documents). V3 stores only `number` so the version-floor surface is even smaller.

Round-2 added four more verified facts:

- **`src/server/use-cases/get-snapshot.ts::getProjectSummaries`** is the existing seam that calls `computeProjectSummaries` (line 91). The overlay helper lives as a peer file in `use-cases/`, not as a flat server helper.
- **`TaskStore.getProjectIds()`** (not `listProjectIds`) is the real method at `src/core/tasks.ts:651`. Tasks expose `listTasksByProject(projectId)` at line 660.
- **`GitHubStateStore.removeTask` is defined but never called.** No existing call site in `src/server/` or `src/core/`. The store accumulates references for the process lifetime. V3 explicitly notes this — the overlay is unaffected because the join filters by `task.status === 'inProgress'` before consulting the store.
- **GitHub polling interval defaults to 60 s** (`src/core/github-types.ts:101`). The OSS refresher's tick is operator-configured but defaults to the same family. This bounds the numerator/denominator drift window.

These findings drive the structural changes in v3: a small fix to `GitHubStateStore`'s storage model, removal of the playbook-parameter shortcut, reliance on the runtime hook path as the sole task-to-issue/PR mapping signal, and parking the helper inside `use-cases/`.

## Non-Goals

- Do not display upstream-repo totals (PRs/issues authored by other users).
- Do not include completed/pending/cancelled/terminated tasks in the "related" set. (The user explicitly chose `Active tasks only` when asked.)
- Do not overlay this on the OSS Productivity per-repo table in v1.
- Do not implement auto-launch from this overlay.
- Do not introduce a new persistent store. In-memory only; refresher repopulates on each tick.
- Do not change the per-project icon's badge (sidebar). A single boolean is added to `ProjectSummary` to enable a future sidebar hint, but v1 does not render it.

## Requirements

- The drawer SHALL show two counters per project: **Open issues (yours)** and **Open PRs (yours)**, alongside the existing stats.
- Each counter SHALL render as `tied / total` when `total > 0` and at least one active task exists for the project; as plain `total` when `tied === 0`; and as `—` when the denominator has not yet been observed.
- `tied` SHALL count each distinct (repo, number) tuple at most once, even when multiple active tasks reference it.
- `tied` SHALL be drawn from tasks whose `status === 'inProgress'` and `projectId` equals this project's id.
- The mapping from a task to issue/PR numbers SHALL reuse exactly two existing detection paths:
  - `GitHubStateStore.getReferences(taskId)` for runtime-detected references (hooks + prompt scan).
  - `OssAttemptStore` reverse-lookup by `taskId` for PRs the task owns (`state === 'pr_open'`).
- The mapping SHALL only count references whose `(owner, repo)` matches the project's repo. References to other repos do not count.
- A tied (repo, number) SHALL be the intersection of the active-task reference set with the authored-denominator set. References to closed/transferred items are excluded from the fraction by construction.
- The drawer SHALL render a tooltip (`title=`) listing every tied item and the driving task name, on hover of the counter.
- The denominator data SHALL refresh on the same cadence as `OssRefresher` and surface the existing `ossLastRefreshAt` freshness signal — no new timestamp.
- The feature SHALL degrade silently to plain numbers when `gh` is unavailable, when the project is not in the OSS registry, or when no denominator has yet been observed.
- The server SHALL detect the multi-task-per-reference case and count each task → all of its observed refs (fix to `GitHubStateStore`).
- No new WebSocket message, no new durable store, no new telemetry.

## Design

### 1. Where the join lives (boundary fix)

Round 1's boundary critic flagged that v1 placed the join inside `src/core/project-summary.ts`, dragging `TaskStore`, `GitHubStateStore`, and `OssAttemptStore` into the core. Round 2 followed up: the join belongs in the existing `use-cases/` seam, not in a flat server file, and `OssRefresher` should not become both fetcher and queryable state holder.

V3 places the helper inside `src/server/use-cases/github-task-overlay.ts`, as a peer of `get-snapshot.ts`. The call chain:

```
ws-connection-handler.ts
  └─ use-cases/get-snapshot.ts::getProjectSummaries
       ├─ use-cases/github-task-overlay.ts::buildGithubTaskOverlay(...)
       └─ core/project-summary.ts::computeProjectSummaries({ ...existing, overlays })
```

`buildGithubTaskOverlay` receives **data**, not service instances. Its signature is:

```ts
function buildGithubTaskOverlay(input: {
  tasks: Task[];                                         // taskStore.listTasks() or all in-progress filtered upstream
  getReferences: (taskId: string) => GitHubReference[];  // bound to githubStateStore.getReferences
  attemptsByTask: Map<string, ContributionAttempt[]>;    // pre-indexed by caller
  authoredOpenIssueNumbers: Map<string, Set<number>>;    // plain data, keyed by "owner/repo"
}): GithubTaskOverlay;

type GithubTaskOverlay = Map<string /* projectId */, {
  tiedOpenIssueNumbers: Set<number>;
  tiedOpenPrNumbers: Set<number>;
}>;
```

The store/refresher classes are not in the function's type signature — only their products are. `get-snapshot.ts` does the wiring (calls `taskStore.listTasks()`, binds `githubStateStore.getReferences`, builds the attempt index, reads the authored-issue map). This means the helper is fully testable with plain inputs and no mocks.

`ProjectSummaryDeps` gains exactly one new field: `overlays: GithubTaskOverlay`. No store imports leak into core. `computeProjectSummaries` reads `overlays.get(projectId)` and stamps two primitive fields on each `ProjectSummary`.

The unused `hasActiveGithubTie` boolean is **dropped from v3** (round 2 design-minimalist + boundary-critic agreed). A future sidebar RFC re-derives it at the call site from the two count fields — costs zero.

### 2. Issue denominator: plain data, written by the refresher (minimalism + boundary fix)

V3 makes the denominator a plain `Map<string /* "owner/repo" */, Set<number>>`. The refresher writes to it after each `gh issue list` call; consumers read it directly. No new class.

Round-2 boundary-critic objected to v2's pattern of typing the join's dep as `OssRefresher` (mixing fetch with state-holding). V3 fixes that: the **map is the dep**, not the refresher. Where it lives in memory is an implementation detail — likely a private field on `OssRefresher` for now, with a single `getAuthoredOpenIssueMap(): ReadonlyMap<string, Set<number>>` accessor. If a future test or split runtime wants to populate the map by other means, it just passes a different map.

```ts
// In src/server/oss-refresh.ts (existing class)
class OssRefresher {
  // ...existing
  private authoredOpenIssueNumbers = new Map<string, Set<number>>();

  getAuthoredOpenIssueMap(): ReadonlyMap<string, Set<number>> {
    return this.authoredOpenIssueNumbers;
  }
}
```

`get-snapshot.ts` calls `refresher.getAuthoredOpenIssueMap()` and forwards the result into `buildGithubTaskOverlay`. The overlay helper never imports `OssRefresher`.

No new class, no new file, no new test fixture. The refresher's existing `lastRefreshAt` covers both denominators. Concurrent-process risk goes to zero because nothing hits disk.

The map stores only `number` — the tooltip uses task names (already on the frontend), not issue titles. Storing titles would be YAGNI and increase the privacy surface flagged in round 1.

### 3. Refresher extension

In the existing per-repo loop of `OssRefresher.runOnce()`, add one call after `gh pr list`:

```ts
const issueResult = await this.runGh([
  'issue', 'list',
  '--repo', repo,
  '--author', '@me',
  '--state', 'open',
  '--limit', String(DEFAULT_PR_LIST_LIMIT),
  '--json', 'number',
]);
ghCalls++;

const numbers = new Set<number>();
try {
  for (const item of JSON.parse(issueResult.stdout) as Array<{ number: number }>) {
    if (Number.isFinite(item.number)) numbers.add(item.number);
  }
  this.authoredOpenIssueNumbers.set(repo, numbers);
} catch (e) {
  errors.push({ repo, message: `invalid JSON from gh issue list: ${(e as Error).message}` });
}
```

Failure handling mirrors the PR path: a parse/exec error appends to `errors[]`, and the previous-tick map for that repo stays in place (rather than reverting to empty). This matches today's partial-refresh semantics.

Budget impact: +1 gh call per repo per refresh. At today's ~11 active repos, ~11 extra calls per refresh against a `GH_CALL_BUDGET` of 60. Headroom remains; if it tightens, raise the budget — independent of this RFC.

Truncation: a result of exactly 100 items is appended to the existing `truncated[]` list. The drawer doesn't surface that signal in v1 (mirrors current behavior); the OSS Productivity view does.

### 4. Multi-task fix to `GitHubStateStore`

The current `references: Map<string, GitHubReference>` collapses every observer of `(owner, repo, number)` to the first one. This breaks the tied count whenever two active tasks reference the same issue — a common occurrence in `implement-github-issue` batch mode and in retries.

V2 changes the map shape:

```ts
// Before
private references = new Map<string, GitHubReference>();

// After
private references = new Map<string, GitHubReference[]>();
```

- `addReference(ref)` — looks up the array; pushes only when no existing entry has matching `taskId`; returns true on push, false on duplicate `(refKey, taskId)`. The same-task case (prompt-scan path *and* hook path both call `addReference` for the same `(refKey, taskId)`) is handled by this rule and **must be covered by a regression test** (FMA round-2 FM-A).
- `getReferences(taskId)` — flattens arrays, filters by `taskId === taskId`. Same external API.
- `getAllReferences()` — flattens arrays.
- `getPRReferences()` / `getIssueReferences()` — return all entries (flattened). The **fetcher** in `GitHubScannerService` deduplicates by `refKey` inside its dispatch loop before calling `fetchPRState`. Round-2 boundary-critic flagged that v2's "first canonical entry" rule leaked fetcher concerns into the store; v3 keeps the store ignorant of how downstream consumers want to dispatch.
- `removeTask(taskId)` — for each refKey, filter out entries with that taskId; if the array becomes empty, also delete `prStates`/`issueStates` for that key. Otherwise leave the PR/issue state intact (other tasks still own it). **Note:** `removeTask` is currently never called from anywhere in the codebase (verified by grep). The overlay does not rely on it because the join filters by `task.status === 'inProgress'`. Wiring `removeTask` to task-completion events is a separate cleanup, tracked in Open Questions.

This is a surgical change. Existing tests for `GitHubStateStore` continue to pass; new tests cover the multi-task case and the same-task duplicate-call case.

**Accepted v1 limit (FMA round-2 FM-B):** when two tasks observe the same `(owner, repo, number)`, `GitHubScannerService.fetchAllStates` emits state-change events under a single observer's `taskId` (whichever ref the dedup loop picked). Per-task change notifications for the *other* observer are dropped. This is unchanged from today's behavior — the overlay does not depend on per-task change notifications, only on the union of references. Fixing this requires iterating all observers in `addChange`; out of scope for this RFC.

### 5. The join

Pseudocode for `src/server/use-cases/github-task-overlay.ts`:

```ts
interface ParsedProjectId {
  host: string;
  owner: string;
  repo: string;
}

function parseGithubProjectId(projectId: string): ParsedProjectId | null {
  const parts = projectId.split('/');
  if (parts.length !== 3) return null;
  const [host, owner, repo] = parts;
  if (host !== 'github.com' || !owner || !repo) return null;
  return { host, owner, repo };
}

export interface OverlayInput {
  tasks: Task[];
  getReferences: (taskId: string) => GitHubReference[];
  attemptsByTask: ReadonlyMap<string, ContributionAttempt[]>;
  authoredOpenIssueNumbers: ReadonlyMap<string, Set<number>>; // keyed by "owner/repo"
  openPrNumbersByRepo: ReadonlyMap<string, Set<number>>;       // keyed by "owner/repo"
}

export function buildGithubTaskOverlay(input: OverlayInput): GithubTaskOverlay {
  const out: GithubTaskOverlay = new Map();

  // Group tasks by projectId, filtering to inProgress only.
  const tasksByProject = new Map<string, Task[]>();
  for (const t of input.tasks) {
    if (t.status !== 'inProgress' || !t.projectId) continue;
    const list = tasksByProject.get(t.projectId) ?? [];
    list.push(t);
    tasksByProject.set(t.projectId, list);
  }

  for (const [projectId, tasks] of tasksByProject) {
    const parsed = parseGithubProjectId(projectId);
    if (!parsed) continue; // non-GitHub project; overlay does not apply
    const repoSlug = `${parsed.owner}/${parsed.repo}`;

    const openIssueDenom = input.authoredOpenIssueNumbers.get(repoSlug) ?? new Set<number>();
    const openPrDenom    = input.openPrNumbersByRepo.get(repoSlug)        ?? new Set<number>();

    const tiedIssues = new Set<number>();
    const tiedPrs    = new Set<number>();

    for (const task of tasks) {
      // (a) Runtime-detected refs
      for (const ref of input.getReferences(task.id)) {
        if (ref.owner !== parsed.owner || ref.repo !== parsed.repo) continue;
        if (ref.type === 'issue' && openIssueDenom.has(ref.number)) tiedIssues.add(ref.number);
        if (ref.type === 'pr'    && openPrDenom.has(ref.number))    tiedPrs.add(ref.number);
      }
      // (b) PRs the task owns via OssAttemptStore
      for (const a of input.attemptsByTask.get(task.id) ?? []) {
        if (a.repo !== repoSlug || a.prNumber == null) continue;
        if (openPrDenom.has(a.prNumber)) tiedPrs.add(a.prNumber);
      }
    }

    out.set(projectId, {
      tiedOpenIssueNumbers: tiedIssues,
      tiedOpenPrNumbers: tiedPrs,
    });
  }

  return out;
}
```

The caller (`get-snapshot.ts`) handles the wiring:

```ts
// Inside getProjectSummaries (existing function), before calling computeProjectSummaries
const attemptsByTask = indexAttemptsByTask(deps.attemptStore.getAllAttempts());
const openPrNumbersByRepo = indexOpenPrNumbersByRepo(deps.attemptStore.getAllAttempts());
const overlays = buildGithubTaskOverlay({
  tasks: deps.taskStore.listTasks(),
  getReferences: (id) => deps.githubStateStore.getReferences(id),
  attemptsByTask,
  authoredOpenIssueNumbers: deps.ossRefresher.getAuthoredOpenIssueMap(),
  openPrNumbersByRepo,
});
```

Notes:

- **No playbook-TARGET branch.** Empirical checkpoint showed it never works. The runtime-hook path catches the issue number on the first `gh issue view` call inside the agent shell.
- **Intersect with the denominator inside the loop.** A task referring to a closed/transferred issue produces no contribution to `tied`. The fraction's job is "of items still on the user's board, how many are being touched". When a task continues working on a closed item, that situation is signaled via a small auxiliary line in the tooltip (see §7) rather than by inflating the fraction.
- **Per-task PR ownership** flows through `OssAttemptStore.taskId`. That field is set by `oss-refresh.ts` from the ledger; once a PR is recorded for a task, the link is durable.
- **Attempts indexed once.** Both `attemptsByTask` and `openPrNumbersByRepo` are built once per snapshot — no inner-loop scans.
- **`projectId` parsing is strict.** `parseGithubProjectId` rejects anything that isn't exactly `github.com/owner/repo`. GHE-with-port or trailing-slash variants return null, the overlay falls through, and the drawer renders plain counts. The same parser should be reused if future code touches projectIds.

### 6. `ProjectSummary` shape

Three new primitive fields, no payload arrays, no convenience booleans:

```ts
export interface ProjectSummary {
  // ...existing fields
  openPrs: number;                        // existing
  openIssues: number;                     // NEW — total authored open
  openPrsTiedToActiveTasks: number;       // NEW
  openIssuesTiedToActiveTasks: number;    // NEW
}
```

The unused `hasActiveGithubTie` boolean proposed in v2 is dropped. A future sidebar RFC re-derives it at the call site from the two count fields — costs nothing.

The frontend reconstructs the tooltip from data it already receives: agents list (for task names + `projectId`), per-task GitHub state (`TaskGitHubState.prs`/`issues`, currently sent as separate `githubUpdate` messages — see `ws-connection-handler.ts:141`), and OSS attempts. The pre-joined `GithubLinkSummary[]` payload proposed in v1 is dropped.

### 7. Frontend rendering

`ProjectDetailDrawer.tsx`. The stat strip gains two cells:

Full mode:

```
Today's PRs  This week  Open issues  Open PRs  Active agents
   2/2         5          1/2          3/4         3
```

Compact mode:

```
3 agents · 3 findings · 3/4 open PRs · 1/2 open issues
```

Display rules — inlined, no helper component:

```tsx
const issuesDisplay = openIssues === undefined
  ? '—'
  : (openIssuesTiedToActiveTasks > 0 && activeAgents > 0)
    ? `${openIssuesTiedToActiveTasks}/${openIssues}`
    : `${openIssues}`;
```

(Same shape for PRs.) Tooltip via `title=` lists the (kind, number, taskName) rows the frontend reconstructs from existing data.

**Closed-but-active hint (FMA round-2 FM-C).** When the frontend can observe that an active task references an issue/PR *not* in the authored-open denominator (e.g., the agent is in cleanup mode on a freshly-closed item), it adds a single trailing line to the tooltip: `+ N task(s) on items no longer in your open list`. Zero new wire data — the frontend already has both sets locally. The fraction stays honest (intersection-only) while the tooltip surfaces the contradiction the user would otherwise see between "0 tied" and "1 active agent".

**Cold-start race (FMA round-2 FM-E).** The fraction renders from `ProjectSummary` (in the first snapshot message). The tooltip data is reconstructed from per-task `githubUpdate` messages that arrive after the snapshot (`ws-connection-handler.ts:141` streams them after the snapshot). The tooltip is **hover-time read**: the user must hover after both messages have landed, which in practice means hundreds of milliseconds after the dashboard mounts. The fraction is correct from the first paint; the tooltip degrades to "numbers only, no task names" if the user hovers within that race window. This is an accepted v1 tolerance.

The tooltip's UX cap was contested by round 1's ambition-amplifier; v1 sticks with `title=` (lowest cost), and Open Questions records the upgrade path.

### 8. Wire

No new message. The three new fields ride the existing `ProjectSummary` payload in the snapshot. Backwards-compatible additive change.

## Reliability boundaries

| Concern | Handling |
|---|---|
| `gh` not authenticated | `OssRefresher` already skips silently; map stays empty; UI shows `—` with the existing OSS "disabled" tooltip. |
| Project not in OSS registry | Denominator absent. UI renders plain count or `—`; fraction is suppressed. |
| Task references issue in another repo | `(owner, repo)` filter in the join drops it. |
| Multiple active tasks reference same issue | Fixed by the multi-task change to `GitHubStateStore` (§4). Tied set still dedups by number. |
| Issue denominator staler than PR denominator | Both refresh in the same loop iteration; one `lastRefreshAt`. |
| Newly-created issue not yet in denominator | UI omits it from the denominator until next refresh tick. The intersection rule (tied = active-refs ∩ denom) means a task referencing it shows `tied = 0` during that window. Worst-case lag: **the OSS refresh interval (operator-configured; same family as `githubPollingIntervalSec`, default 60 s in `github-types.ts:101`) plus the serial position of the repo in the refresh loop**. At 11 repos and ~1 s per repo, worst-case ~70 s. The lag is bounded and predictable; users who notice it can force a refresh from the OSS view. |
| Issue closed while a task still touches it | Intersection drops it from `tied`. Drawer shows the count it expects; the "1 task on a closed item" signal is absent in v1. Acceptable for v1; revisit if it becomes a recurring user-reported confusion. |
| Truncation (`--limit 100`) | Appended to existing `truncated[]`. OSS view surfaces; drawer does not. Same as PR path today. |
| Wrong `gh` account (`@me` resolves to a sock-puppet) | Same risk as today's `gh pr list --author @me` path. Out of scope for this RFC; tracked as an Open Question for a separate hardening pass. |
| `task.projectId` set lazily | Filtered out of `listTasksByProject` until stamped. Tied count is 0 for the few seconds before the first tool call. |
| Multi-source ref dedup | Sets handle (a) and (b) automatically. No tooltip-line duplication because the tooltip is rebuilt frontend-side. |
| `tied > total` impossible | Guaranteed by intersection. Asserted in a unit test. |
| Idle project (no active tasks) | Fraction suppressed; renders plain `total`. No visual noise. |

## Files to change

- `src/core/github-state-store.ts` — change `references` shape to `Map<string, GitHubReference[]>`; rewrite `addReference` (same-`taskId` dedup), `getReferences`, `getAllReferences`, `getPRReferences` / `getIssueReferences` (flattened — no canonical-entry rule), `removeTask` (array-aware).
- `src/core/github-state-store.test.ts` — add cases: (a) two tasks observe same `(owner, repo, number)` independently → both visible via their own `getReferences`, dedup by `(refKey, taskId)`; (b) same task calls `addReference` twice for the same key (prompt-scan + hook) → `getReferences(taskA).length === 1`; (c) `removeTask` preserves shared state when other tasks still own the ref.
- `src/core/github-scanner-service.ts` — in `fetchAllStates`, dedup the array returned by `getPRReferences` / `getIssueReferences` by `refKey` before dispatching `fetchPRState` / `fetchIssueState`. (One-line `Set` filter.)
- `src/server/oss-refresh.ts` — add `gh issue list --json number` per repo; add `authoredOpenIssueNumbers: Map<string, Set<number>>` field; expose `getAuthoredOpenIssueMap(): ReadonlyMap<string, Set<number>>`.
- `src/server/oss-refresh.test.ts` — add: issues list parsed and stored; per-repo partial failure leaves prior tick intact; truncation appends to `truncated[]`.
- **New** `src/server/use-cases/github-task-overlay.ts` — pure function `buildGithubTaskOverlay(input: OverlayInput)`; helper `parseGithubProjectId(projectId)`; no I/O; no store imports.
- **New** `src/server/use-cases/github-task-overlay.test.ts` — table cases: zero overlap, partial overlap, cross-repo ref ignored, dup ref counted once, closed item filtered, two tasks on same issue counted once, denominator missing, non-GitHub projectId returns no overlay, malformed projectId rejected by parser.
- `src/server/use-cases/get-snapshot.ts` — inside `getProjectSummaries`, build `attemptsByTask` and `openPrNumbersByRepo` indices, call `buildGithubTaskOverlay`, pass `overlays` into `computeProjectSummaries`.
- `src/core/project-summary.ts` — extend `ProjectSummary`; accept `overlays: GithubTaskOverlay` in `ProjectSummaryDeps`; stamp the three new fields. **No store imports added.**
- `src/core/project-summary.test.ts` — verify the three new fields propagate (missing overlay → fields are `undefined`/`0`; present overlay → correct values).
- `src/shared/contracts/messages.ts` (or `shared/protocol.ts`) — three new optional fields on `ProjectSummary`.
- `src/frontend/components/ProjectDetailDrawer.tsx` — render two new stats (full + compact); reconstruct tooltip from existing payloads; render the closed-but-active hint line when applicable.
- `src/frontend/components/ProjectDetailDrawer.compact.test.ts` — assert compact mode reflects the fraction; assert idle-project case suppresses the fraction.

## Edge cases

1. **No active tasks for the project.** `tied = 0`, fraction suppressed, plain denominators only. No tooltip.
2. **Active tasks but none reference any authored issue/PR in this repo.** Same as case 1.
3. **Issue authored in browser between refresh ticks.** Denominator missing during the window; fraction omits the item even if a task references it. Acceptable lag — same staleness model as today's PR view.
4. **Task references `#42` that was closed yesterday.** `gh issue list --state open` omits it; intersection drops it. The task is still visible under Active agents — the user can drill in there. The drawer does not surface "1 active task on a closed item" in v1.
5. **`issueSelector` parameter contains "42" (single-issue launch).** No special handling needed. The agent's first `gh issue view` tool call emits a hook event; `processEventsImmediate` records the ref. Slight launch-window delay before the tied number appears — typically a few seconds.
6. **Batch-mode `implement-github-issue` running.** Multiple iterations on the same task may touch many issues over time. `GitHubStateStore.references` accumulates each (after the multi-task fix in §4). Tied count for the project reflects the union across all currently-`inProgress` tasks.
7. **Two active tasks pick the same issue number** (e.g., a relaunch chain). After §4, both tasks' references resolve to that issue; tied still dedupes by number → `1` in the count, both task names in the tooltip.
8. **Task with no resolvable `(owner, repo)` from cwd.** `GitHubScannerService` already drops these. Tied count unaffected.
9. **Frontend tooltip reconstruction.** The tooltip wants `(kind, number, taskName)`. The frontend already has agents (with `taskName` and `projectId`) and `TaskGitHubState` per task. If the snapshot does not currently include `TaskGitHubState` for every active task, two options: (a) include it for tasks whose `projectId` is in the visible project list, (b) downgrade the tooltip to a number-only list. **Action**: confirm by reading `snapshot-builder.ts` at implementation time. The fallback (b) is acceptable for v1.
10. **Project deleted from OSS registry while tasks active.** Denominator goes to 0 next refresh; tied is computed but the fraction display rule omits it (denom = 0). Tooltip is also empty because the intersection is empty. Acceptable.
11. **`gh issue list` errors for one repo mid-refresh.** Prior-tick map for that repo persists. Fraction may render stale until the next successful tick. Errors visible in the existing OSS error banner.
12. **More than 100 authored open issues on one repo.** Repo appended to `truncated[]`. Drawer renders the truncated count without warning (consistent with today's PR behavior); OSS view shows the warning.

## Alternatives considered

1. **Compute the join inside `src/core/project-summary.ts`.** Round 1 boundary critic showed this drags `TaskStore`/`OssAttemptStore`/`GitHubStateStore` into core, contaminating its dependency direction. Rejected; moved to server layer.

2. **Add a new persistent `AuthoredIssueStore` class.** Round 1 design-minimalist showed it adds disk I/O for data that is fully replaced per refresh. Rejected; in-memory map only.

3. **Send `GithubLinkSummary[]` on `ProjectSummary` for the tooltip.** Round 1 design-minimalist showed the frontend can reconstruct from existing payloads. Rejected; backend ships counts only.

4. **Use `playbookParameterValues` to short-circuit issue ref discovery.** Empirical checkpoint showed the key the v1 RFC used (`TARGET`) does not exist; the actual params are camelCase, and the chosen issue number in batch mode is shell-internal. Rejected; runtime-hook path is the canonical source.

5. **Show a flat count "2 tasks on issues, 1 on PRs" instead of a fraction.** Raised by round 1 socratic challenger. Has merit — but the user's clarifier explicitly picked `Your authored only` denominator, which implies a fraction. The flat count is rejected as v1 default; the fraction collapses to a plain count when `tied === 0`, which gives the dumbest-case the same shape the socratic challenger preferred.

6. **Include recently-completed tasks (e.g., 1h window) in the tied set.** Round 1 ambition-amplifier argued the user's verbatim included "just completed". The user's clarifier answer was `Active tasks only`. Rejected per explicit user choice; revisit if the user finds the link too narrow.

7. **Add a `tied/total` badge to the project sidebar icon.** Sidebar badge slot is crowded. The compromise: `hasActiveGithubTie` boolean ships on `ProjectSummary` so the sidebar can render a one-bit hint in a future RFC without re-deriving the data.

8. **Add upstream-repo total alongside the authored fraction.** Round 1 ambition-amplifier suggested rendering `2 of 47 open issues` for context. The user explicitly chose authored-only. Rejected for v1.

9. **Auto-launch "implement oldest unworked issue" when `tied === 0` and `total > 0`.** Round 1 ambition-amplifier flagged this as the natural next step. Out of scope for this RFC — it's a different feature.

10. **Render the tooltip as an interactive popover.** Round 1 ambition-amplifier argued `title=` is too weak. Accepted as a future upgrade; v1 ships `title=` because it works for the keyboard/desktop case and adds zero implementation cost. Open Questions records this.

11. **Use `OssRefresher` as the typed dep for the join (v2).** Round-2 boundary-critic flagged this as mixing fetch with state-holding. V3 types the dep as the plain `Map<string, Set<number>>` so the refresher's identity doesn't bleed into the join. The refresher still happens to write the map.

12. **Embed the join inside `src/core/project-summary.ts` (v1)** — flagged by round 1, moved to a server helper in v2. Round 2 noted the v2 location (a flat server file) bypassed the `use-cases/` seam. V3 settles in `src/server/use-cases/github-task-overlay.ts`.

## Critic feedback incorporated

**Round 1 (boundary-critic):**
- Moved the join from `src/core/project-summary.ts` into a new server helper `src/server/github-task-overlay.ts`. `ProjectSummaryDeps` gains a single primitive `overlays` map; no store imports leak into core.
- Hoisted the `attemptStore.getByRepo()` scan out of the per-task loop into a pre-indexed `attemptsByTask` map.
- Dropped the `lastRefreshAt` duplication that v1 placed on `AuthoredIssueStore`. The refresher's existing timestamp is reused.

**Round 1 (design-minimalist):**
- Dropped file persistence and the `AuthoredIssueStore` class. In-memory `Map<string, Set<number>>` held by `OssRefresher`.
- Dropped `GithubLinkSummary[]` from the wire. Frontend reconstructs the tooltip from existing payloads.
- Dropped `FractionStat` component; inlined the conditional in two call sites.
- Dropped `ownerRepoResolver` dep; inlined the `projectId.split('/')` parse.
- Dropped the playbook-TARGET branch (empirical checkpoint also independently invalidated it).
- Dropped `title`, `url`, `createdAt`, `updatedAt` from the stored issue shape — only `number` is needed.

**Round 1 (failure-mode-analyst):**
- Added §4 to fix `GitHubStateStore.references` so two tasks observing the same `(owner, repo, number)` both appear in their respective `getReferences(taskId)` results. The v1 design silently undercounted in exactly this case.
- Empirical checkpoint confirmed F2/F3: the playbook-TARGET shortcut never worked. Removed entirely.
- Documented numerator/denominator drift (Edge case 3) and the closed-issue-with-active-task case (Edge case 4).
- Pinned `gh issue list --json number` (minimal field set; no `title`/`url`/`createdAt`/`updatedAt` stored) — also dodges any version-floor risk on those fields.
- Privacy concern about `@me` resolving to a stale token: tracked as Open Question; same risk applies to today's PR refresh path, so not blocking this RFC.

**Round 1 (socratic-challenger):**
- Idle-case clutter: fraction is suppressed when no active task exists for the project; renders plain `total`. The "0/N when nothing's running" loudness is gone.
- Sparse-denominator concern (`1/1`, `0/1`): accepted as a real signal. When `tied === 0`, the cell collapses to `total` only — no fraction noise.
- Trust budget concern: the fix is honesty about coverage. The RFC now states explicitly that runtime hooks are the sole task-to-ref signal; documented launch-window delay (a few seconds) before tied increments. Combined with the multi-task fix in §4, the known undercount vectors are eliminated.
- "Why not flat count" addressed under Alternative 5: the flat count is what users see when `tied === 0`, so the design subsumes the simpler shape rather than competing with it.

**Round 1 (ambition-amplifier):**
- `hasActiveGithubTie` boolean added to `ProjectSummary` so a future sidebar hint is one CSS class away — no re-derivation needed. *Note: this addition was **reverted in v3** after round 2 design-minimalist + boundary-critic both flagged it as unused YAGNI. Future sidebar consumers re-derive from the count fields.*
- Recently-completed-tasks window: declined per explicit user clarifier choice. Documented in Alternative 6 so the trade-off is visible.
- Upstream-repo totals: declined per explicit user clarifier choice. Documented in Alternative 8.
- Auto-launch: out of scope; documented in Alternative 9 as a follow-up.
- Tooltip popover vs `title=`: accepted as a future upgrade path; v1 ships the cheap version. Documented in Open Questions.

**Round 2 (boundary-critic):**
- Helper file moved from a flat `src/server/github-task-overlay.ts` to the existing seam `src/server/use-cases/github-task-overlay.ts`. The `get-snapshot.ts` use case calls it; no horizontal coupling.
- `OssRefresher` no longer types as a queryable state holder for the join. The map is passed as a `ReadonlyMap<string, Set<number>>`. Refresher exposes a single read accessor (`getAuthoredOpenIssueMap()`); write surface stays internal.
- "First canonical entry per refKey" rule pulled out of `GitHubStateStore` and into the `GitHubScannerService` dispatch loop. Store stays ignorant of fetcher dispatch concerns.
- `hasActiveGithubTie` boolean dropped (confirms design-minimalist's parallel finding).

**Round 2 (design-minimalist):**
- `hasActiveGithubTie` dropped per the agreed reasoning (no concrete consumer; re-derivable at zero cost).
- All other v2 simplifications (helper file justification, two new count fields, intersection rule, "`tied > total` impossible" test) confirmed and kept.

**Round 2 (failure-mode-analyst):**
- **FM-A (same-task duplicate `addReference`):** explicit dedup-by-`(refKey, taskId)` rule in §4; regression test added to the §"Files to change" list.
- **FM-B (multi-task change broadcasting):** documented as an accepted v1 limit in §4. The overlay does not depend on per-task change notifications; fixing the broadcasting is a separate cleanup.
- **FM-C (closed-but-active reference):** §7 now describes a tooltip auxiliary line "+ N task(s) on items no longer in your open list". Zero new wire data; the contradiction the user would otherwise see is acknowledged in-product.
- **FM-D (numerator/denominator drift):** worst-case lag now stated in the reliability table — ~70 s at current scale, bounded by `githubPollingIntervalSec` default of 60 s + per-repo serial position.
- **FM-E (cold-start tooltip race):** §7 now states explicitly that the tooltip is hover-time read and tolerates a blank-task-name window during the snapshot → `githubUpdate` arrival gap.
- **FM-F (`removeTask` lifecycle):** documented in §4 as a separate cleanup. Overlay is unaffected because it filters by `inProgress` before consulting the store.
- **FM-G (`TaskStore` API):** verified — `getProjectIds()` (line 651) and `listTasksByProject()` (line 660). V3 pseudocode in §5 uses these names.
- **FM-H (`projectId` parsing):** §5 now includes a strict `parseGithubProjectId` helper that rejects malformed/enterprise/port-bearing ids.

## Open questions

- **Tooltip upgrade.** When the per-tied-item count grows past ~5 or non-hover input matters (mobile, accessibility), upgrade `title=` to a real `<Popover>`. Trigger: first user-reported "I want to click through to the task".
- **`@me` identity sanity check.** Should `OssRefresher` call `gh api user` at startup and refuse to populate the maps if the cached identity disagrees? This is broader than this RFC — applies to today's PR refresh too. Tracked as a separate hardening pass.
- **Sidebar one-bit indicator.** A follow-up RFC can re-derive `hasActiveGithubTie` from the two count fields and render a sidebar dot. No data plumbing needed.
- **OSS Productivity per-repo table column.** The same overlay would be useful in the per-repo breakdown ("Tied" column). Defer to a follow-up — the table's denominator semantics differ (window-filtered, not "open now"), so a separate design pass is warranted.
- **`GitHubStateStore.removeTask` is never called.** Independent of this RFC, the store accumulates references for the process lifetime. Worth wiring to task-completion in a separate cleanup pass; the overlay does not depend on it because the join filters by `inProgress` first.
- **Per-task change notifications for multi-task refs.** `GitHubScannerService.fetchAllStates` emits `addChange` against a single observer's `taskId` when multiple tasks share a ref. The overlay does not depend on this, but it remains a latent UX gap (one task gets the closed/merged banner, the other doesn't).
