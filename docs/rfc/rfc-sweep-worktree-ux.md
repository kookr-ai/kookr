# RFC: Sweep Worktree UX — progress feedback, disk-aware diagnosis, and safe stale reclaim

## Status

**Accepted (v4 — post round-3 consistency pass; empirical claim confirmed; converged)**
**Date:** 2026-07-03
**Author:** Jean Ibarz (with Claude)

---

## Problem

The cross-project worktree **sweep** (`{ type: 'workspace:sweep' }` → `SweepHandler` → `runCrossProjectSweep`, `src/server/use-cases/cross-project-cleanup-sweep.ts`) is the one global action that walks every known project and reclaims merge-safe worktrees. It works, but its UX has three concrete gaps that make it unusable for its actual purpose — reclaiming disk from hundreds of accumulated worktrees.

### 1. No progress feedback while it runs

The command palette entry "Sweep merged worktrees" opens a `ConfirmDialog` (`App.tsx:1316-1328`). On confirm, the client sends one message, sets `sweepRunning=true`, and then **waits for a single terminal response** — `workspaceSweepComplete` or `workspaceSweepBusy` (`useWebSocket.ts:226-235`). Between those two points the user sees nothing: no spinner, no "sweeping project 3 of 12", no per-project status. The server loop is strictly sequential (`for (const projectId of projectIds) { … await sweepOneProject(…) }`, `cross-project-cleanup-sweep.ts:103-105`) and each project can take up to `PER_PROJECT_TIMEOUT_MS = 10 min` (line 27) plus a 30 s `git fetch` (line 29). A user with dozens of projects can stare at a frozen, dismissed dialog for many minutes with no way to know whether the sweep is alive, stuck, or done.

### 2. Completion is a single collapsed count, not a diagnosis

On completion the client shows one aggregated toast via `handleSweepComplete` → `handleAlert` (`workspace-slice.ts:116-139`): e.g. `"Swept 5 project(s) · removed 3 worktree(s) · skipped 1 · failed 1."` All the per-worktree detail the server computed — the full `ProjectSweepResult[]` (`cross-project-cleanup-sweep.ts:43-53`) — is thrown away on the way to the UI. The user cannot see **which** worktrees were removed, **which** were left and **why**, or how much disk any of it reclaimed. A toast is transient; there is no persistent report to scroll or act on.

### 3. Sweep removes only merge-safe branches — and it never measures disk

Sweep removes only `merged` + `patch_equivalent` (`SWEEP_SAFE_CLASSIFICATIONS`, `canSweepRemove`, `workspace-cleanup-policy.ts:105-113`). Two consequences:

- **It never surfaces the actual disk hog.** A worktree untouched for six months but carrying one un-pushed commit classifies as `unique_commits` and is silently left forever. Worse, the biggest disk consumer in a stale worktree is usually **untracked build output** (`node_modules`, `dist/`, `target/`) that git classification barely looks at. The user's problem is framed entirely in disk ("hundreds of stale worktrees eating disk"), yet nothing in sweep measures or reports a single byte (verified: `grep -rn 'diskUsage\|sizeBytes\|bytesOnDisk' src/` returns nothing).
- **It offers no path for the ambiguous middle.** "Staled >2 weeks is usually safe, but sometimes I want to be asked" is a judgment call, not a git predicate. Sweep has no bucket for it.

### The core insight that reshaped v1 → v2

The v1 draft proposed a "fully pushed to a remote" check to decide whether a stale `unique_commits` branch was safe to *delete*. Round-1 review found this both **unsafe** (a swallowed `git fetch` failure yields stale remote-tracking refs → a branch reads "pushed" when it isn't → `update-ref -d` makes the only copy of real work unreachable) and **nonexistent** in the codebase. v2+ removes the pushed-check entirely by changing what "reclaim a stale worktree" *means*:

> **Reclaiming a stale worktree = remove the working-tree path, KEEP the branch ref, never `update-ref -d`.**

This reclaims the disk (the working directory, including untracked `node_modules`/build output) while every commit and the branch ref stay in the repository. **Empirically confirmed** (see Empirical validation): `git worktree remove` on a clean worktree deletes the working dir — including gitignored content — while the branch and its unique commit remain reachable. The staleness signal stops being a safety gate and becomes what the user actually meant: a "you're probably not using this anymore" ranking/pre-selection signal.

**The one residual data-loss surface, named honestly (round-2 finding).** `git worktree remove` also deletes *gitignored* files. "Gitignored" is not the same as "regenerable": a clean worktree can hold a gitignored `.env` (secrets), a local dev SQLite DB, or scratch notes, none of which appear in `git status --porcelain` and none of which are recoverable after removal. v3 therefore does **not** claim "no data loss" — it claims "no *committed* work is lost" and makes the gitignored-file risk visible and human-confirmed (see Requirements). This is the human-in-the-loop the user asked for.

### What good looks like

A user runs sweep, watches it progress project-by-project, and afterward reads a **disk-aware diagnosis** that sorts every worktree into buckets, sorted by on-disk footprint:

- **Removed** — what deterministic sweep *actually* reclaimed (merged / patch-equivalent whose path removal succeeded), with a manifest. Removals that *failed* appear in a distinct "still on disk" row.
- **Probably safe to remove** — clean `unique_commits` worktrees (no uncommitted tracked work) that are stale (untouched >14 days). One-click "remove path, keep branch" after a glance, with a plain-language warning if the worktree holds gitignored files. Ranked by footprint.
- **Needs your call** — dirty worktrees, `generated_only`, recently-used clean ones, and ambiguous stale registry entries. Never auto-proposed; per-row advisory diagnostic available.
- **Blocked** — busy/protected/checked-out-elsewhere, collapsed to a count, non-actionable.

## Non-Goals

- **Not deleting any branch or commit in the "probably safe" path.** v3's reclaim is path-removal + branch-retention only. No `update-ref -d`, no pushed-check, no *committed*-work-loss surface. Branch deletion stays exactly where it is today — the per-project reviewed-discard flow (`workspace-cleanup-service.ts`), never a bulk sweep action.
- **Not changing what deterministic sweep removes.** `SWEEP_SAFE_CLASSIFICATIONS` stays `merged` + `patch_equivalent`. The R4c.1 invariant ("the global sweep action removes the same safe classifications as the per-project cleanup action", `docs/requirements.md:590`) is preserved for the *deterministic* removal. New buckets are *proposals* the user confirms separately.
- **Not changing `workspace-cleanup-policy.ts` capabilities in the v1 scope.** In particular `generated_only` stays `blockedCapabilities` (round-2: loosening it to allow keep-branch removal would also change the already-shipped per-project panel that reads the same policy — `CleanupCandidateTable.tsx:401/414/508`). `generated_only` therefore stays in **Needs your call**, not "Probably safe."
- **Not a CLI.** Sweep stays WebSocket-only.
- **Not touching task-lifecycle worktree cleanup** (`git-worktree.ts` → `cleanupTaskWorktrees`). Out of scope.
- **Not a general filesystem crawl.** Scope is worktrees enumerated via git in projects Kookr already knows (`enumerateSweepProjects`).
- **Not automated agent-driven removal.** Any agent involvement (deferred) is advisory only.

## Requirements

### Progress feedback (PR 1)

- The server SHALL emit an incremental progress message as each project starts and finishes, so the client renders live status instead of waiting for one terminal message.
- Each `workspaceSweepProgress` message SHALL carry: `runId`, `startedAt`, project identifier, 1-based `index`, `total`, `status ∈ {running, done, failed, skipped}`, aggregate `counts`, and — on completion — the per-project result. **No intra-project sub-phase enum** (round-1 minimalist).
- The client SHALL render a persistent, non-modal progress surface (not a toast) that survives command-palette dismissal and shows the current unit, running counts, elapsed time, and a determinate bar keyed on `index/total` (guard `total===0`).
- Progress messages SHALL be **additive** to the existing `workspaceSweepComplete` / `workspaceSweepBusy` contract — terminal messages remain, so an old client that ignores the new type silently no-ops (verified: the client receive path is an untyped switch with no exhaustiveness gate — `useWebSocket.ts`; `ServerMessageSchema` is test-only). New-client/old-server skew: the progress surface SHALL degrade to an indeterminate spinner when `index/total` never arrive, never hang on `undefined`.
- Progress **and the completion message (including its `report` payload)** SHALL be delivered to **all subscribed clients**, not only the initiating connection. This requires wiring the broadcast dependency (`broadcastToAll` in `ws.ts`) into `SweepHandlerDeps`, which currently receives only the per-connection `send` (round-1/round-2 finding — v1 claimed broadcast but the wiring is unicast, and the report rides the completion message).
- A **process-wide in-memory progress singleton** in the sweep use-case/handler SHALL be the single source of "is a sweep running and where" (`{runId, index, total}`, updated at each project boundary, cleared on completion). The reconnect snapshot reads it: if it is populated, the client re-attaches to the progress surface; if the lock's `sweepRunning` is true but the singleton is empty (only possible after a crash — the live process always has its own progress in memory), the client shows "no active sweep — re-run", never a phantom bar. **The lock file stays a pure `{pid, startedAt}` mutex** — progress is NOT persisted to it (round-3 minimalist: the crash path discards `index`/`total` anyway, and only a same-live-server reconnect reads them, which the live process already holds in memory; persisting to the mutex file would add a non-atomic per-boundary disk write and couple PR 1 to the lock-fix PR's `startedAt` contract for no benefit — round-3 delivery). This keeps PR 1 and the lock-fix PR fully decoupled: they touch different state (in-memory singleton vs. lock-file mutex).

### Sweep robustness — lock-recycle fix (separate PR, not bundled into PR 1)

The lock-reclaim path has a pre-existing latent bug: after a server crash the OS may reassign the dead holder's PID to the new server, so `process.kill(pid, 0)` succeeds and the sweep wedges as permanently "busy" (`tryReclaimStaleLock`, `cross-project-cleanup-sweep.ts:252-287` — the mtime-TTL fallback only runs for `pid<=0`). Round-2 review (minimalist/delivery/failure-mode/operability, all converging) established that:

- The naive "compare the recorded `startedAt`" fix is a **no-op** — a crash doesn't change the field — and applying the mtime-TTL on top of a live PID would **force-reclaim a legitimately slow multi-project sweep** (dozens of projects × up to 10 min each easily exceeds the 20-min TTL), turning an annoying-but-safe wedge into an unsafe concurrent double-sweep.
- The correct fix compares the lock's `startedAt` against the **OS process start-time** of the live PID (`/proc/<pid>/stat` field 22 on Linux; `ps -o lstart= -p <pid>` on macOS). If the process started *after* the lock was written, it is a recycled PID → reclaim; otherwise the lock is genuinely held. Fall through to TTL only when start-time is unreadable. **Precision requirements (round-3 failure-mode):** the start-time read truncates to jiffy/second resolution, biasing the measured value *down* (a legitimate holder always starts strictly before it writes the lock, so truthfully `procStart < lockStartedAt`); therefore the comparison SHALL map equality / within-resolution to **"held"** (the fail-safe side — worst case is the pre-existing benign wedge, never a double-sweep). The parsing SHOULD reuse the existing `/proc/<pid>/stat` field-parsing in `src/adapters/process-tree.ts` (`readProcParentMap`) rather than a from-scratch parser (round-3 minimalist).
- **Both** `tryReclaimStaleLock` **and** `isSweepInProgress` (which feeds the UI `sweepRunning` snapshot, `ws.ts:268`) SHALL get this guard — patching only the former (as v2 proposed) leaves the UI reporting a phantom running sweep forever (round-2 operability, critical).

Because this is a concurrency-safety change with an asymmetric-worse failure mode (bad fix = double sweep), it SHIPS AS ITS OWN PR with its own OS-start-time fixture tests ("genuinely running past a long per-project timeout, PID recycled" and "dead PID recycled to unrelated live process"), independently revertible from the progress UI (round-2 delivery — do not bundle a concurrency fix and a cosmetic UI feature into one revert unit).

### Disk-aware diagnosis report — read-only (PR 2)

- On completion the client SHALL open a persistent **Sweep Report** panel rather than only a collapsed toast. The toast MAY remain as the entry point.
- Every worktree row SHALL show project, worktree path, branch, classification, **on-disk footprint** (`du -sx` of the worktree dir), last-touched age, and a one-line reason. Rows SHALL be sortable by footprint.
- The footprint metric SHALL be labeled **"on-disk footprint (upper bound)"**, not "reclaimable." `du -sx` counts hardlinked/CAS package-store content (pnpm, Cargo, Yarn PnP) at full size, so actual freed disk can be far less and per-worktree sizes sharing a store must not be summed as additive freed space (round-2 failure-mode). The bucket aggregate SHALL be presented as an upper bound and SHALL indicate when rows have unknown (`du`-failed) size so the headline isn't silently understated.
- Disk/mtime measurement SHALL run **inside the per-project sweep loop** (right after that project's classification), bounded to **non-Blocked** candidates only, so it is covered by the existing per-project progress and does not create a second unmonitored silent window after the loop (round-2 operability/minimalist). `du` failure → size `null` ("size unknown"); the row stays actionable.
- The report SHALL group worktrees into four buckets covering **all** `CleanupClassification` values (round-1 boundary):
  - **Removed** — bucket on *actual removal*, not classification (round-2 failure-mode). There SHALL be **one canonical `disposition → pathRemoved` map** used by both the live report and the reconnect reconstruction (round-3 failure-mode found v3's inline mapping self-contradictory against the code). Per `workspace-cleanup-service.ts`, the removed set (`pathRemoved:true`, disk reclaimed) is `{completed, path_removed_branch_retained, prune_failed, branch_delete_failed}` — note **`prune_failed` and `branch_delete_failed` DID remove the path** (only the prune or branch-delete failed, `workspace-cleanup-service.ts:227,312`), so they belong in **Removed**, not "failed." The one genuinely-failed case is `manual_intervention_required` (the `git worktree remove` itself failing, `:203-212`), which **throws and pushes no summary** (caught at `:91`); it therefore SHALL be sourced as `safeCandidates − summaries` (or from the ledger), not from `summaries`, and rendered in a distinct **"removal failed — still on disk"** row. A crashed attempt carries the `createAttempt` default disposition `blocked` (`workspace-attempt-repository.ts:65`), outside the removed set, so it is correctly excluded from Removed in both the live and reconstructed views.
  - **Probably safe to remove** — clean `unique_commits` (no uncommitted tracked work) that are stale (last-touched >14 days). Removing the path keeps the branch and all commits.
  - **Needs your call** — `dirty`, `generated_only`, clean-but-recent (last-touched ≤14 days), and non-prunable `stale_worktree` residue.
  - **Blocked** (collapsed to a count, non-actionable) — `busy`, `protected`, `checked_out_elsewhere`, `unknown`/`detached_head`.
- The staleness signal SHALL be the mtime of the linked worktree's **git index** (`.git/worktrees/<id>/index`), which updates on checkout/status/commit — NOT the worktree root-directory mtime (which only changes on direct add/remove/rename, not nested file edits) and NOT `lastCommitAt` (the committer date of the tip commit) (round-2 failure-mode/minimalist). The chosen signal SHALL be spot-checked empirically ("edit an existing nested file → does the index mtime move?") before PR 2 builds bucketing on it. A missing or future-dated signal SHALL force the row to **Needs your call** (fail safe).
- On any project where classification times out, the report SHALL show a **loud** "not analyzed — N worktrees" banner. The cheap `git worktree list` count SHALL be captured *before* the timeout-guarded classify+measure call so a real `N` is available (round-2 operability: today the timeout result carries no count).
- The report SHALL be re-openable for the run's lifetime. On reconnect-after-completion, the client SHALL reconstruct the **Removed** manifest by reading the existing attempt ledger rows for that `runId` (`WorkspaceAttemptRecord`, `sweepRunId`, `workspace-types.ts:101-127`) — already-persisted state, not new server-side report retention (round-2 failure-mode: telling the user to re-run a destructive sweep to see what the last one destroyed is lossy; the record already exists). The reconstruction SHALL apply the **same canonical `disposition → pathRemoved` map** as the live report, so the two views agree for a given `runId` (round-3 failure-mode).

### Probably-safe bulk remove (PR 3, gated on PR 2)

- The report's **Probably safe** bucket SHALL offer a bulk action that removes selected rows' **paths, keeping branches**.
- This SHALL be a **new, dedicated bulk use-case function that does not accept a `deleteBranch` parameter** — it hardcodes keep-branch internally, so the landmine in `cleanupWorkspaceCandidate`'s `deleteBranch = input.deleteBranch ?? true` default (`workspace-cleanup-service.ts:103`) cannot be reintroduced by a later edit (round-2 delivery: the existing `cleanupSafeWorkspaceCandidates` hardcodes `deleteBranch:true` — the opposite of what bulk-remove needs). A regression test SHALL assert the bulk path never produces a `branchRemoved: true` summary. Each row still routes through the per-candidate `cleanupWorkspaceCandidate` for its revalidation, capability gating, and dirty-recovery guard (`workspace-cleanup-service.ts:99-337`) — no new *deletion* primitive, just a keep-branch caller.
- **Fingerprint handling (round-2 failure-mode, load-bearing; round-3 confirmed sound).** `cleanupWorkspaceCandidate` blocks a `unique_commits` removal unless a `reviewFingerprint` is present AND matches freshly-hydrated detail (`workspace-cleanup-service.ts:161-176`). The report hydrates cleanup detail for Probably-safe candidates **at report-generation time (in PR 2)** via `hydrateCleanupCandidateDetail` (`workspace-cleanup-detail-query.ts:48-107`), capturing each candidate's `fingerprint` (a snapshot of `{headOid, branchRefOid, baselineOid, statusDigest}`). That value is carried to the client (PR 2) and back into the bulk call (PR 3), where `cleanupWorkspaceCandidate` re-hydrates **fresh** and compares — because the carried value was frozen at report time and is compared against a freshly-derived current value, a genuine mid-window ref/status change yields a real skip (round-3 failure-mode verified this is **not** a tautology: the tautology would require re-deriving the compared value at bulk time, which does not happen). The hydration cost lands in PR 2 and is bounded to the Probably-safe bucket.
- Before executing, the bulk action SHALL show a confirmation distinct from the initial sweep confirm, and SHALL **name the gitignored-file risk in plain language** for rows carrying gitignored content: e.g. "Removing these deletes their working directories, including gitignored files (`.env`, local databases, build output). Commits and branches are kept." Rows whose gitignored footprint is present SHALL be flagged in the report so the confirm is informed, not blind (round-2 failure-mode: the honest mitigation for the residual data-loss surface).
- **Per-row gitignored detection needs a real data source** (round-3 failure-mode: `du -sx` is one total byte count and cannot tell `.env` from `node_modules`). The report SHALL, for Probably-safe candidates only (the bounded set the bulk touches), run `git -C <worktree> status --ignored --porcelain` (or `git clean -ndX`) to detect the presence of gitignored files **not** matched by a known-regenerable allowlist (`node_modules/`, `dist/`, `build/`, `target/`, `.next/`, `graphify-out/`). The result — `hasSensitiveIgnored: boolean` plus a short sample of paths — SHALL be an explicit input to the pure `buildSweepReport`, which sets the per-row flag. Rows with `hasSensitiveIgnored` get the strongest confirm wording and are **not** pre-selected in the bulk checkbox.
- The bulk action SHALL emit `workspaceSweepProgress` with `scope:'bulkRemove'` over the **selected rows** (its own `index`/`total`, `projectId` per row's project), not over the project list, so a 40-row bulk remove shows a real determinate bar instead of "project 1 of 1" (round-2 operability).
- The bulk button SHALL be independently disable-able (a distinct UI surface / confirm gate) so a regression can be pulled without taking down the read-only report (round-2 delivery: kill-switch granularity).

### Deferred (tracked as issues, not built in this RFC)

- **Batch agent-assisted review** of the Needs-your-call bucket. v1 wires the **existing** per-row advisory diagnostic button (`launchWorkspaceCleanupDiagnostic`, `CleanupCandidateTable.tsx:496-507`) into ambiguous rows — no batch orchestration, no structured verdict, no confidence field (round-1 minimalist won the adversarial pair; the agent is only *prompt*-enforced non-destructive, not sandboxed — round-1 failure-mode — another reason not to fan it out broadly). Batch review is deferred until PR 2/3 usage shows demand.
- **Snooze/ack disposition memory** across sweeps (round-1 ambition's convergence concern) — natural home is the `WorkspaceAttemptRecord` ledger keyed by worktree identity. Deferred pending evidence that repeated sweeps are a real workflow.
- **Orphaned worktrees of de-registered projects** (invisible to `enumerateSweepProjects`) — future work.
- **`generated_only` in-place clean** (a scoped `git clean` to reclaim regenerable artifacts while keeping the worktree) — a genuinely useful lever but a new primitive and a policy change; deferred.

## Design

### The safety model, precisely

| Action | Removes working dir | Deletes branch ref | What could be lost |
|--------|--------------------|--------------------|--------------------|
| Deterministic sweep (unchanged) | yes | yes (`update-ref -d`, OID-match guarded, reflog-recoverable) | merged/patch-equivalent only — nothing unique |
| **v3 "Probably safe" bulk** | **yes** | **no** | **no committed work; no branch.** Only *gitignored uncommitted* files in the working dir (`.env`, local DBs, build output) — named in the confirm, human-approved |
| Per-project reviewed-discard (unchanged) | yes | optionally | user explicitly accepts risk per candidate |

### Message contract additions

`src/shared/contracts/messages.ts` + Zod schemas:

Two distinct message types (round-3 minimalist: a `scope`-discriminated envelope with a union `result` cuts against the house one-type-per-operation convention and couples PR 3's payload to PR 1's message; separate types keep the PRs independent):

```ts
// server → client, BROADCAST per project boundary during the sweep loop
type WorkspaceSweepProgress = {
  type: 'workspaceSweepProgress';
  runId: string;
  index: number;   // 1-based, over projects
  total: number;
  projectId: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  result?: ProjectSweepResult;
};

// server → client, BROADCAST per selected-row boundary during bulk-remove (PR 3)
type WorkspaceBulkRemoveProgress = {
  type: 'workspaceBulkRemoveProgress';
  runId: string;
  index: number;   // 1-based, over selected rows
  total: number;
  projectId: string;
  worktreePath: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  result?: CleanupResultSummary;
};
```

`workspaceSweepComplete` gains an optional `report: SweepReport` and is **broadcast**. `workspaceSweepBusy` unchanged. A new client→server `workspace:bulkRemoveProbablySafe` message carries the selected candidates (each needs `projectId` + `worktreePath` + `branch` + carried `fingerprint`; note `CleanupCandidateAssessment` lacks `repoPath`, so the handler re-resolves repo paths per row via the same `resolveRepoPath` the sweep uses — round-2 delivery).

### Backend: where the logic lives

| Path | Responsibility | PR |
|------|----------------|-----|
| `cross-project-cleanup-sweep.ts` | Add `onProgress?` to `CrossProjectSweepDeps`, invoked at each project boundary; update the in-memory progress singleton; capture the pre-classification worktree count for the timeout banner; structured `logger` lines for lock acquire/busy/reclaim and per-project timeout/error. | 1 |
| `src/adapters/process-tree.ts` (extend) | Add a process-start-time read reusing the existing `/proc/<pid>/stat` field-parsing (`readProcParentMap`); macOS `ps -o lstart=` fallback. Consumed by the lock-recycle guard in both `tryReclaimStaleLock` and `isSweepInProgress` (round-3 minimalist: reuse, don't reimplement). | lock-fix PR |
| `workspace-cleanup-service.ts` | Widen `cleanupSafeWorkspaceCandidates` return from `{ summaries }` to `{ summaries, nonRemoved }` — **free**, `inspectCleanupCandidates` already classifies every worktree and discards non-safe at the `.filter` (`workspace-cleanup-service.ts:63-73`, empirically confirmed). Add the new keep-branch bulk fn (no `deleteBranch` param). | 2 / 3 |
| `workspace-cleanup-detail-query.ts` (reuse) | `hydrateCleanupCandidateDetail` called at **report-generation time (PR 2)** for Probably-safe candidates to capture each one's `fingerprint` (round-3 delivery: assign hydration ownership explicitly to PR 2). This is **read-only** git work — PR 2 stays non-destructive — but it is real per-candidate cost, bounded to the Probably-safe bucket, not free. The fingerprint is an **optional** field on `SweepReport`, so reverting PR 3 needs no PR 2 shape change. | 2 |
| `src/adapters/worktree-footprint.ts` (new) | Combined per-worktree read: `du -sx <path>` footprint (execFile, `-x`, timeout, leading-`-` guard, null-on-failure) **and** `.git/worktrees/<id>/index` mtime — read together in the same loop iteration for the same consumer (round-3 minimalist: don't split a 3-line stat wrapper into its own file). | 2 |
| `src/adapters/ignored-scan.ts` (new) | `git -C <worktree> status --ignored --porcelain`, filtered against the known-regenerable allowlist, returning `{ hasSensitiveIgnored, sample }`. Run for Probably-safe candidates only. | 2 |
| `src/core/sweep-report.ts` (new) | **Pure** `buildSweepReport(summaries, safeCandidates, nonRemoved, footprints, indexMtimes, ignoredScans, fingerprints, now, thresholdDays): SweepReport`. All bucketing here; disk/mtime/ignored/fingerprint enter as pure inputs. Imports `SWEEP_SAFE_CLASSIFICATIONS` from `workspace-cleanup-policy.ts` (single source of truth). Owns the canonical `disposition → pathRemoved` map; Removed = removed-disposition set; "removal failed — still on disk" = `safeCandidates − summaries`. | 2 |
| `src/core/sweep-report.test.ts` (new) | Bucketing matrix over all 10 classifications; clean+stale→probably-safe, generated_only→needs-call, dirty→needs-call, clean+recent→needs-call, missing/future mtime→needs-call; disposition map: `completed`/`path_removed_branch_retained`/`prune_failed`/`branch_delete_failed`→Removed, `manual_intervention_required` (absent from summaries)→removal-failed, `blocked`→excluded; `hasSensitiveIgnored`→not-pre-selected; threshold boundary. | 2 |
| `sweep-handler.ts` | Wire `onProgress` and the completion `report` to `broadcastToAll`; handle `workspace:bulkRemoveProbablySafe`. | 1 / 3 |

**Boundary discipline:** the sweep use-case stays orchestration + progress plumbing; all *bucketing policy* is the pure `sweep-report.ts` (mirroring `workspace-cleanup-policy.ts`). Disk/mtime/proc-start I/O are thin adapters feeding pure inputs or the lock guard. Removals continue to route through `cleanupWorkspaceCandidate`.

### Frontend

| Path | Responsibility | PR |
|------|----------------|-----|
| `src/frontend/components/SweepProgress.tsx` (new) | Non-modal surface: determinate bar, current unit, counts, elapsed. Subscribes to `workspaceSweepProgress` (PR 1) and `workspaceBulkRemoveProgress` (PR 3). | 1 |
| `src/frontend/components/SweepReport.tsx` (new) | **A new multi-project component** (not a column-add to `CleanupCandidateTable`, which is a single-project master-detail list with no column system — round-2 correction). It borrows small subcomponents (`ClassificationBadge`, row-cell formatting) but owns an independent cross-project data model. Four buckets; Blocked collapsed to a count; footprint sort; per-row "Run diagnostic" on Needs-your-call. Bulk "remove path (keep branch)" with its own confirm (naming the gitignored risk) + progress + independent disable — PR 3. | 2 / 3 |
| `workspace-slice.ts` | `sweepProgress` + `sweepReport` state; `handleSweepProgress`; keep the completion toast as the report entry point. | 1 / 2 |
| `useWebSocket.ts` | Dispatch `workspaceSweepProgress`; carry `report`; degrade gracefully on missing `index/total`. | 1 |

### Phasing / shipping plan

- **PR 1 — progress UI only.** Server broadcasts `workspaceSweepProgress` + broadcasts completion; in-memory progress cursor exposed through reconnect snapshots; client renders `SweepProgress`; graceful old/new skew. Pure additive; no policy change, no new removals, no lock-logic change. Trivially revertible.
- **Lock-recycle fix PR — independent.** OS-start-time guard in both lock code paths, with fixtures. Its own revert unit (round-2 delivery). Can land before or after PR 1; not bundled.
- **PR 2 — read-only disk-aware report.** Widen the cleanup-service return; `worktree-footprint.ts` + `ignored-scan.ts` + pure `sweep-report.ts`; per-project measurement + Probably-safe fingerprint/ignored hydration inside the loop; render `SweepReport` read-only (buckets + footprints + per-row diagnostic; no bulk action). **Read-only but not zero-cost** — the fingerprint/ignored hydration for Probably-safe rows is real (read-only) git work bounded to that bucket; it does not mutate anything, so PR 2 has no destructive surface (round-3 delivery).
- **PR 3 — Probably-safe bulk remove.** New keep-branch bulk fn (no `deleteBranch` param, regression-tested); fingerprint hydration + re-validation; gitignored-risk confirm; bulk progress; independent kill-switch. The only destructive-adjacent surface, isolated in its own PR so it can be disabled without losing the report.
- **Deferred issues** — batch agent, snooze/ack memory, orphaned-worktree crawl, generated_only in-place clean.

## Edge cases

- **Zero projects.** `total=0`; report opens empty; progress bar guards `total===0`.
- **Project fails mid-loop.** `status:'failed'` progress carries the `ProjectSweepResult`; the loop already continues past failures (`cross-project-cleanup-sweep.ts:173-197`).
- **Reconnect mid-sweep.** Snapshot reads the in-memory progress singleton (`runId`/`index`/`total`); client re-attaches. Lock `sweepRunning` true but empty singleton → "no active sweep — re-run" (crash case), never a phantom bar.
- **Reconnect after completion.** Removed manifest reconstructed from ledger rows for the `runId`; no server-side report retention.
- **Two clients.** Progress *and* completion+report broadcast to all. Bulk-remove guarded per-candidate by revalidation; the fingerprint is a **staleness gate, not a mutex** — a double-click from two clients degrades to a benign `git worktree remove` failure / `ref_changed` skip on the second actor; a test SHALL exercise it.
- **Clean worktree with gitignored `node_modules` only.** Flagship case, empirically confirmed: `git worktree remove` succeeds without `--force`, reclaims the gitignored disk, branch survives.
- **Clean worktree with gitignored `.env`/dev-DB.** Classified clean → Probably safe. The residual data-loss surface: named in the confirm dialog, human-approved. NOT claimed lossless.
- **`generated_only`.** Stays Needs-your-call — the existing policy blocks keep-branch removal for it and loosening that would change the shipped per-project panel (round-2 delivery/failure-mode). Its footprint is still shown so the user sees the disk it holds; reclaiming it is a deferred `git clean` lever.
- **`du` slow / fails / hardlinked store.** `du` has its **own short timeout** and is **best-effort** — a `du` timeout marks the row "size unknown" and does NOT abort the project (round-3 delivery: measurement shares the per-project loop but must not consume the removal budget or trigger a mid-flight abort that didn't happen pre-PR 2). Footprint labeled upper-bound; hardlinked/CAS stores not summed as additive freed space.
- **Classification times out on a big project.** Loud "not analyzed — N worktrees" banner, with `N` captured before the timeout guard.
- **git-index mtime signal.** Spot-checked at implementation ("edit nested file → index mtime moves?"). Missing/future → Needs your call.
- **`stale_worktree` residue.** `git worktree prune` runs *before* classification (`cross-project-cleanup-sweep.ts:150`), so prunable entries are already gone; the locked/non-prunable residue → **Needs your call** (round-1 failure-mode LW-3).
- **Bulk-remove races an active lease.** A worktree that became `busy` between report and bulk-remove is re-validated and skipped by `cleanupWorkspaceCandidate`.
- **Removal partly failed (`prune_failed` / `branch_delete_failed`).** The path WAS removed (disk reclaimed) — these belong in **Removed** with a footnote that prune/branch-delete needs manual follow-up, NOT in "removal failed — still on disk" (round-3 failure-mode: v3's mapping was inverted).
- **Removal fully failed (`manual_intervention_required`).** `git worktree remove` itself failed; the candidate throws and pushes no summary, so it is derived as `safeCandidates − summaries` and shown in "removal failed — still on disk."
- **Removed-bucket recovery hint.** `recoveryRef` is dirty-stash-only and blank for merged rows (round-1 failure-mode); the report SHALL NOT show a misleading empty column — it links to reflog guidance for the OID-match-guarded deterministic deletion instead.
- **Ledger rows stuck `running` after a crash.** Pre-existing (`createAttempt` defaults `status:'running'`, disposition `blocked` — round-2 operability). A crashed row's `blocked` disposition is outside the removed-disposition set, so the manifest reconstruction excludes it automatically; a startup reconciliation pass is related future work, not core to this RFC.

## Alternatives considered

### "Fully pushed to a remote" check to delete stale unique-commit branches (v1)

Rejected in v2. Unsafe and nonexistent in the codebase. Replaced by remove-path/keep-branch (round-1 failure-mode LW-1, socratic Q4, ambition).

### `generated_only` in "Probably safe" via the existing cleanup path (v2)

Rejected in v3 (round-2 failure-mode/delivery, both verified in code). `deriveCleanupCapabilities('generated_only')` returns `canRemovePathKeepBranch:false` and `cleanupWorkspaceCandidate` throws for it; the only way to include it is a policy change that also alters the shipped per-project panel. Kept in Needs-your-call; footprint still shown; in-place `git clean` deferred.

### Claiming "no data-loss surface" for the bulk (v2)

Corrected in v3 (round-2 failure-mode). Gitignored ≠ regenerable; `.env`/dev-DBs are lost. v3 claims "no *committed* work lost" and makes the gitignored risk visible and human-confirmed.

### Worktree root-directory mtime as the staleness signal (v2)

Rejected in v3 (round-2 failure-mode/minimalist). Root mtime doesn't move on nested-file edits. Switched to git-index mtime, spot-checked at implementation.

### Bundling the lock-recycle fix into the progress PR (v2)

Rejected in v3 (round-2 minimalist/delivery). Different failure mode; asymmetric-worse bad-fix (double sweep); the naive `startedAt` compare is a no-op. Split into its own PR with the OS-start-time algorithm and fixtures, patching both lock code paths.

### `du -sx` as "reclaimable bytes"

Relabeled "on-disk footprint (upper bound)" (round-2 failure-mode) — hardlinked/CAS stores mean actual freed disk can be far less; not summed as additive.

### Second git classification pass for non-removed worktrees (v1)

Rejected (round-1). `inspectCleanupCandidates` already classifies every worktree; widen the return. (The Probably-safe *fingerprint hydration* in PR 3 is a separate, genuinely-new per-candidate cost, acknowledged.)

### Batch agent review + structured verdict + confidence (v1 Layer 3) / server-side report retention (v2) / instrumentation-for-threshold (v2)

Cut/deferred (round-1 and round-2 minimalist): reuse the existing per-row diagnostic; reconstruct the manifest from the ledger; the report UI already surfaces size/age so no separate distribution logging is built.

### Persist per-worktree snooze/ack dispositions across sweeps

Deferred (round-1 ambition's convergence concern) — real scope; `WorkspaceAttemptRecord` ledger is its home; follow evidence.

## Open questions

- **`du -sx` cost at scale.** Empirically ms-scale for thousands of small files locally (design-experimenter). Residual risk is file-count scaling on 50k+-file `node_modules` and slow/networked filesystems (`-x` guards mounts). Spot-check one real large project at implementation; the "size unknown" fallback bounds failure. Not a design blocker.
- **git-index mtime fidelity.** Does `.git/worktrees/<id>/index` mtime move on the workflows the user cares about (edit nested file, run a build, `git status`)? Spot-check before PR 2 builds bucketing on it; fall back to `max(index mtime, HEAD reflog mtime, root mtime)` if index alone is insufficient.
- **Report retention across sweeps.** Client-side + ledger reconstruction in v1. If sweep becomes a scheduled routine, a short durable history and the snooze/ack convergence mechanism become worth building.

## Critic feedback incorporated

### Round 1 (v1 → v2) — summary

Decisive change: removed the unsafe/nonexistent "fully pushed" check and redesigned "Probably safe" as remove-path/keep-branch (failure-mode LW-1, socratic Q4, ambition). Switched staleness off `lastCommitAt`; added disk measurement and `generated_only`-as-reclaimable framing (ambition); collapsed intra-project phases and cut the Layer-3 batch agent, `confidence`, and server-side retention (minimalist); fixed unicast-vs-broadcast, re-encoded policy, incomplete buckets, and the discarded-classification reuse (boundary). Adversarial pair: sided with minimalist on cutting batch automation, adopted ambition's distinct convergence concern as deferred snooze/ack. Empirical checkpoint: design-experimenter **confirmed** the remove-path/keep-branch reclaim claim with ground-truth git output before round 2.

### Round 2 (v2 → v3)

**failure-mode-analyst (the decisive round-2 pass):**
- `generated_only` throws through the existing removal path → dropped from Probably safe to Needs your call; policy change explicitly out of scope.
- "No data-loss" is false for gitignored `.env`/dev-DBs → safety claim corrected to "no *committed* work lost"; gitignored risk named in the confirm and flagged per-row.
- Clean `unique_commits` needs a fresh matching `reviewFingerprint` → report hydrates detail at report time, carries + re-validates the fingerprint; acknowledged as real (non-free) cost, bounded to Probably-safe.
- Removed bucket keyed on classification, not removal → built from `pathRemoved`; failed removals get a distinct "still on disk" row.
- Root-dir mtime doesn't move on nested edits → switched to git-index mtime, spot-checked at impl.
- PID-recycle `startedAt` compare is a no-op; TTL-on-live-PID = double-sweep → OS process-start-time guard, both lock paths.
- `du` overstates under hardlink/CAS stores → relabeled "on-disk footprint (upper bound)", not summed additively.
- Reconnect promised state with no source → lock-file progress cursor; ledger reconstruction for the post-completion manifest.

**operability-reviewer:**
- `isSweepInProgress` (feeds the UI liveness flag) left unpatched by v2's lock fix → both paths patched.
- Reconnect progress state had no home → single authoritative lock-file cursor.
- `du` scan was a second unmonitored silent window → measurement moved inside the per-project loop, bounded to non-Blocked.
- Timeout banner had no `N` → worktree count captured before the timeout guard.
- No structured logging → logger lines for lock/timeout/du events.
- Swallowed per-row bulk failures + ledger `running`-after-crash ambiguity → manifest filters on terminal dispositions; reconciliation named as related future work.

**delivery-pragmatist:**
- Split PR 1 into progress-UI vs. lock-fix (independent revert units, asymmetric failure modes).
- Split the old PR 2 into read-only report (PR 2) vs. bulk-remove (PR 3) so the destructive surface has its own kill-switch.
- Bulk `deleteBranch:false` structurally enforced (new fn without the param) + regression test asserting no `branchRemoved:true`.
- Completion+report must broadcast (rides the completion message) so a second client gets it.
- Named the extra wire surface (new `workspace:bulkRemoveProbablySafe` client message; per-row repo-path re-resolution).
- Confirmed safe by inspection: the additive `workspaceSweepProgress` no-ops on old clients; widening `cleanupSafeWorkspaceCandidates` is safe.

**design-minimalist:**
- Lock fix removed from PR 1 (wrong PR; under-specified).
- Instrumentation-for-threshold cut (no consumer; the report UI is the closing mechanism).
- du/mtime bounded to non-Blocked candidates; Blocked bucket collapsed to a count.
- `CleanupCandidateTable` "column reuse" framing corrected — `SweepReport` is a new multi-project component borrowing small subcomponents.
- git-index mtime flagged for empirical validation before bucketing is built on it.

### Adversarial pair (round 2)

design-minimalist and delivery-pragmatist **agreed** this round (both wanted the lock fix and the bulk action split into their own revert units); no conflict to resolve. ambition-amplifier was **not re-run** in round 2 — v2 added no new capped/deferred scope that undercut the user goal (its round-1 disk-measurement finding was fully incorporated and is now core to PR 2); round-2 additions were all safety/correctness tightening, the minimalist's counterweight. Per the skill's round-3 rule, ambition stays retired unless a later revision adds new deferred items.

### Round 3 (v3 → v4) — consistency pass

**failure-mode-analyst (verified the two hardest fixes SOUND, found two consistency defects):**
- Confirmed the PR 3 fingerprint hydrate-then-revalidate is **not** a tautology (carried value frozen at report time vs. freshly-derived at bulk time) and keep-branch authorization clears the policy gate. No change.
- Confirmed the OS-start-time lock guard is directionally sound and the boundary resolves to the safe side. Added precision: truncate/floor start-time, map equality→"held."
- **High — disposition→`pathRemoved` map was inverted:** `prune_failed`/`branch_delete_failed` are `pathRemoved:true` (belong in Removed); the only true failure `manual_intervention_required` produces no summary → "removal failed" row sourced from `safeCandidates − summaries`. Introduced one canonical map shared by live report and ledger reconstruction.
- **Medium — per-row gitignored flag had no data source** (`du` is one byte count) → added `ignored-scan.ts` (`git status --ignored`) + a builder input; sensitive-ignored rows aren't pre-selected.

**design-minimalist (convergence — all mechanical):**
- Dropped the lock-file progress cursor for an in-memory singleton (crash path discards it anyway; removes a non-atomic per-boundary write and the PR 1 ↔ lock-fix coupling).
- Merged `worktree-mtime.ts` into `worktree-footprint.ts`; reused `process-tree.ts` stat-parsing instead of a new `proc-start-time.ts`.
- Split the `scope`-discriminated message into two typed messages (`workspaceSweepProgress`, `workspaceBulkRemoveProgress`), matching house style and decoupling PR 3 from PR 1. Confirmed the four-PR split is correctly scoped, not over-sliced.

**delivery-pragmatist (shippable with revisions — both addressed):**
- Assigned fingerprint-hydration ownership explicitly to PR 2 (read-only but not zero-cost), added `workspace-cleanup-detail-query.ts` to PR 2's table, made the fingerprint field optional on `SweepReport` so a PR 3 revert needs no PR 2 shape change.
- Dissolved the PR 1 ↔ lock-fix shared-lock-file write contract by keeping progress in memory and the lock file a pure mutex.
- Made `du` best-effort with its own timeout so per-project measurement can't trigger an abort that didn't happen pre-PR 2.

### Invocation log

- ambition-amplifier 2026-07-03 (round 1): novel finding (disk footprint + generated_only reclaim). Rounds 2–3: not re-run — no new goal-undercutting scope caps (all later changes were safety/correctness tightening).
- design-experimenter 2026-07-03 (post round 1): flagship remove-path/keep-branch claim CONFIRMED with ground-truth git output; classifier-semantics and "no second pass" sub-claims confirmed. See Empirical validation.

## Empirical validation

Load-bearing claim for the v2/v3 pivot: **`git worktree remove` on a clean worktree reclaims its on-disk footprint (including gitignored `node_modules`/build output) while leaving the branch ref and its commits intact and reachable.**

**Verdict (design-experimenter, 2026-07-03): CONFIRMED with ground-truth output.**

- Throwaway repo + linked worktree on `feature-x` with a unique **committed** change plus a 48 MB gitignored `node_modules/`. `git worktree remove` (no `--force`) succeeded first try; the 48 MB working dir (incl. gitignored content) was gone (`ENOENT`), while `git branch --list feature-x` still showed the branch and the unique commit remained a reachable object (`git cat-file -t <sha>` → `commit`).
- **Crux confirmed:** `git worktree remove` treats gitignored paths as invisible (same rule as `git status`), so a status-clean-except-ignored worktree removes without `--force`; a genuine non-ignored untracked file causes a refusal (exit 128) — but such a worktree classifies `dirty`/`generated_only` and never enters Probably safe. The git-level refusal boundary aligns with the classification boundary.
- **This is also the origin of the round-2 gitignored-data-loss finding:** the same behavior that reclaims gitignored `node_modules` also deletes gitignored `.env`/dev-DBs. v3 names this honestly rather than claiming "no data loss."
- **Classifier semantics closed:** `cleanup-inspector.ts` computes dirtiness via `git status --porcelain` (`cleanup-inspector.ts:388`) — identical ignored-vs-untracked semantics as `git worktree remove`. No mismatch.
- **"No second git pass" confirmed:** `cleanupSafeWorkspaceCandidates` calls `inspectCleanupCandidates` once and discards non-safe at the `.filter` (`workspace-cleanup-service.ts:63-73`); widening the return is free. (The PR 3 Probably-safe *fingerprint* hydration is a separate, acknowledged new cost.)
- **`du -sx` cost:** ms-scale for thousands of small files locally; residual risk is file-count scaling on very large real `node_modules` and slow/networked filesystems (`-x` guards mounts). Spot-check at implementation.

The pivot's premise is solid; round-2 review therefore tightened the design's correctness and delivery rather than restructuring it.

## Convergence note

Round 1 removed an unsafe design premise (the pushed-check) and reoriented the design around the empirically-confirmed remove-path/keep-branch model. Round 2 produced substantive, code-verified findings (the `generated_only` throw, the fingerprint gate, the gitignored data-loss surface, the mtime signal) that materially changed the design and phasing. Round 3 verified the two hardest fixes (fingerprint flow, lock-recycle guard) are **sound**, and its remaining findings were localized consistency defects (the disposition→`pathRemoved` map, the gitignored data source) and mechanical simplifications (in-memory cursor, adapter merges, two message types) — all incorporated into v4 without new direction or a new PR. Both round-3 quality critics explicitly recommended treating the remainder as implementation guidance rather than triggering a round 4. **v4 is converged and Accepted.** No further critic round is planned unless implementation surfaces new design questions.

## Addendum: scheduled (unattended) reclaim — issue #1578 (epic #1293)

This RFC's reclaim is WebSocket-triggered ("Not a CLI" / interactive). Issue #1578 adds an **unattended, cron-triggered** variant of the same probably-safe reclaim so worktree sprawl drains without a human at the keyboard. It reuses the RFC's mechanism verbatim rather than inventing a new policy:

- **Classification is the single source of truth.** A worktree is a removal candidate only when `canSweepRemove` says so (classification ∈ `SWEEP_SAFE_CLASSIFICATIONS` = `merged` + `patch_equivalent`). The candidate list is regenerated FRESH every run via `inspectCleanupCandidates` (`git worktree list --porcelain` + per-worktree `git status` / merge-base classification) — never a stale audit snapshot.
- **Remove-path / keep-branch.** Every live removal routes through `cleanupWorkspaceCandidate` with `deleteBranch: false`, honoring the Non-Goal above — the scheduled path can never delete a branch.
- **Hard excludes run before classification** as belt-and-suspenders: `kookr-prod` (legacy basename), any `.kookr-protected` worktree (the marker operators use to pin prod- or PR-hosting worktrees), and worktrees on a protected branch.
- **Dry-run mode** classifies and reports candidates (`would_remove`) without removing anything.
- **Audit trail.** Every run appends one row per worktree considered (classification + action) plus a run-summary row to the shared `~/.kookr/audit.jsonl`.
- **Trigger.** A minimal cron-driven runner (`src/server/scheduled-worktree-reclaim-runner.ts`) built on the existing `src/core/cron.ts` surface — deliberately NOT routed through the playbook-launching `ScheduleRunner`, because the reclaim is an internal server job, not a task launch. Disabled by default; enabled only when `KOOKR_WORKTREE_RECLAIM_CRON` holds a valid cron expression (`KOOKR_WORKTREE_RECLAIM_DRY_RUN` forces preview mode). Core logic lives in `src/server/use-cases/scheduled-worktree-reclaim.ts`.
