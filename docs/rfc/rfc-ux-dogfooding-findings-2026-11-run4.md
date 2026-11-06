# RFC: UX Dogfooding Findings — November 2026 (run 4)

- **Status**: Draft (living document, written during the dogfooding session)
- **Author**: Claude (Opus 4.8), dogfooding session driven as a "classical user" / scripter
- **Date**: 2026-11-06
- **Base**: `origin/main` @ `8508ccac` (worktree `kookr-dogfood-202611-run4`)
- **Prior art this month**: run 1 (`rfc-ux-dogfooding-findings-2026-11.md`, F1–F8, merged
  #3485), run 2 (`-run2.md`, +3 findings), run 3 (`-run3.md`, R3-F1/R3-F2). This is the
  **fourth** 202611 pass — per the notebook, net-new findings are scarce, so run 4 is
  deliberately a **status-reconciliation + latent-hazard** pass: re-measure every prior
  finding against today's `origin/main`, promote resolved ones to the keep-list, and only
  record genuinely net-new friction.
- **Method**: Drive the live dashboard at `localhost:4800` as a scripter (cross-check
  `/api/snapshot`, `/api/projects`, `/api/tasks`; numbers shown side by side that
  contradict are findings) and as a UI user; attempt a code root-cause (`file:line`) for
  every medium/high finding. No new tasks were launched into any project (avoids seeding
  the junk `local/*` rows that prior runs flagged); evidence is read-only.

## Summary

Four runs in, the data layer is in good shape: snapshot↔tasks counts agree, task
referential integrity is clean, the new terminal-state model (`terminalReceipt` /
`completionDigest`) is internally consistent, and the `openIssuesTiedToActiveTasks`
over-count that opened the June RFC (tied > open) is gone. Two prior findings closed since
run 3 — the spend header now carries an `all-time` scope label (**R1-F4, #3488**) and a
lean `?view=compact` opt-in exists for `/api/tasks` (R2-F1 partial). The remaining
carried-over friction is a small, stable set: the `/api/tasks` **default** is still ~3×
heavy, project-list hygiene still leaks gone-`localPath` `github.com/*` rows and a
raw-space id, and two frontend `??` fallbacks mislabel partial/older data.

Run 4's net-new contribution is **three code-rooted latent hazards** of one family —
*a partial or absent number rendered as an authoritative value*: a per-project spend sum
that coerces un-priced agent cost to $0 (**R4-F1, medium**), a stuck-flag tracking entry
that leaks when a `needs_input` agent jumps straight to terminal (**R4-F2, low**), and a
`activeFindingCount ?? 0` that shows a phantom zero under version skew (**R4-F3, low**).
None mis-renders on today's dataset, which is why the live cross-checks read clean — they
bite under token-cost gaps, partial summaries, or frontend/server version skew.

## Findings

All three run-4 net-new findings are **code-rooted latent hazards** of the same family the
earlier runs cared about (a number displayed as authoritative when it is actually partial
or absent). None is currently mis-rendering on screen for *this* dataset, which is why the
API-surface cross-checks came back clean — they bite under token-cost gaps, version skew,
or partial summaries.

### R4-F1. Per-project "Spend" silently coerces un-priced agent cost to $0 and shows the sum as authoritative (data trust / budget) — severity: medium

`src/core/project-summary.ts:370`:

```ts
const costUsd = agentList.reduce((sum, a) => sum + (a.tokenUsage?.costUsd ?? 0), 0);
```

Any agent whose `tokenUsage.costUsd` is `undefined` — cost not yet scanned, or a
provider/model Kookr has no pricing for — contributes **$0** to the project total. That sum
is then rendered as the project's authoritative accumulated spend directly against the
budget threshold (`ProjectSidebar.tsx:195-196`, `Spend: $X/$Y`), with **no "partial" or
"unknown" indicator**. A user watching a project approach its `dailyLimit` can see an
**under-stated** spend presented as a real, complete number, and under-throttle as a
result. This is the per-project sibling of the (now-fixed) R1-F4 header-spend trust issue:
the header got a scope label; the per-project figure still coerces silently.

**Evidence**: today every agent *does* have a `costUsd` (project sum reconciles to
$664.55), so the UI looks correct — the hazard is latent until an un-priced model or an
unscanned agent appears. **Suggested fix**: track an `unpricedAgentCount` (or a boolean
`costPartial`) alongside the sum and render a `~$X` / "partial" affordance when any
addend was coerced, so a missing price is distinguishable from a genuine $0.

### R4-F2. A `needs_input` agent that jumps straight to terminal never clears its stuck-flag tracking entry (observability / correctness) — severity: low

`src/server/routes/task-routes.ts:1659`, `attachStuckReason`:

```ts
if (task.status !== 'inProgress') return task;   // early return…
// …skips, further down (:1688):
clearWaitingOnInputTracking(agentId);
```

An agent flagged `needs_input` that transitions directly to a terminal status short-circuits
before `clearWaitingOnInputTracking`, so its entry in the module-level `lastOutcomeByAgent`
map is never cleared. A later episode reusing the same agent id can then be dedup-suppressed
at `stuck-flag-precision.ts:68`. It is bounded by the wholesale overflow clear
(`stuck-flag-precision.ts:69-72`), so the blast radius is **stuck-flag precision telemetry
drift**, not user-facing numbers or unbounded memory. **Suggested fix**: clear the tracking
entry on the terminal-status path too (clear before the early return, or in the terminal
transition handler).

### R4-F3. `activeFindingCount ?? 0` renders a phantom "0 findings" when the field is absent (data trust / wording) — severity: low

`src/frontend/components/LiveFrictionCalibrationPanel.tsx:119`:

```ts
const activeFindingCount = snapshot?.activeFindingCount ?? 0;
```

When an otherwise-present snapshot omits `activeFindingCount` (version skew between a newer
frontend and an older server payload), the panel renders a concrete **`0`** —
indistinguishable from a genuine zero. The sibling `signalCount ?? signals.length`
(`:118`) at least falls back to a derived count; the finding count falls back to a
fabricated zero. **Suggested fix**: treat an absent field as unknown (render `—` / hide the
metric) rather than `0`.

## Prior-finding reconciliation (202611 runs 1–3 vs origin/main @ 8508ccac)

| ID | Finding | Run-4 status | Evidence |
|----|---------|--------------|----------|
| R1-F1 | Junk/empty-path `local/*` projects persist as first-class rows | **Not reproduced today** | 0 of 6 `local/*` projects have a gone `localPath` (all paths exist) |
| R1-F2 | `openIssuesTiedToActiveTasks`/`openPrsTiedToActiveTasks` `null` on inactive projects | **Resolved** | both fields are `int` on all 53 projects (no nulls); value `0` where no active task is tied to an issue — verified legitimate (the 3 in-progress tasks are all `manual`, none issue-tied) |
| R1-F3 | Project id may contain a raw space (`local/ferox capital`) | **Still open** | `local/ferox capital` present, `localPath='/home/jean/git/ferox capital'` (dir exists), `tracked=false` |
| R1-F4 | Spend header carries no visible scope; no API field exposes the all-time total | **FIXED (#3488)** | `TopBar.tsx:585` renders an `all-time` scope label + tooltip ("All-time agent spend recorded by this Kookr server — includes cleared and deleted tasks", `:308-310`); total now exposed as `totalSpendUsd` (server `getLifetimeSpendUsd()`) |
| R1-F6 | Launch dialog does not validate cwd existence client-side | **Still open** | `LaunchTaskDialog.tsx:356` `canSubmitLaunch` checks only `cwd.trim()` non-empty; existence enforced only server-side at launch (`launch-service.ts:929`, `CwdValidationError`) |
| R1-F7 | Merged task lingers in review queue as "SIGNALED COMPLETE / WORKTREE MISSING" | **Not reproduced today** | no terminal task is currently worktree-missing; the 8 terminal non-completed tasks are cleanly `timeout`/`abandoned`/`watchdog` with coherent receipts |
| R2-F1 | `/api/tasks` default ships the prompt ~3× per task | **Partially fixed** | default still heavy — `normalizeTaskForApi` (`task-routes.ts:1937-1951`) spreads the whole task (live endpoint = **8.5 MB / 60 tasks, ~142 KB each**); but a documented lean opt-in now exists: `?view=compact` / `?compact=true` → `toCompactApiTask` (`:1772`) drops `prompt`/`userPrompt` and trims `launchIntent` to metadata (`:1801-1808`). Default remains full "for backward compatibility" (`:222`). |
| R2-F2 | Optimistic "Launching task…" toast never retracted on rejection | _not re-driven (no launch this run)_ | — |
| R2-F3 | Healthy, progressing task flagged red "WORKTREE MISSING" | **Not reproduced today** | all 3 in-progress tasks fresh, none worktree-missing-flagged |
| R3-F1 | `findingCount` stalled-agent fallback (`ProjectSidebar.tsx:178`) | **Still open** | `getTaskLoad(summary.activeAgents, summary.stalledAgents ?? summary.findingCount)` at `:178` and `:466`; `??` substitutes finding count as "stalled" on partial/older summaries (server populates both at `project-summary.ts:400-401`, so latent not live). `findingCount` is `0` on all 53 today. |
| R3-F2 | Gone-`localPath` exclusion scoped to `local/*` only (file moved to `src/core/project-summary.ts:340-347`) | **Still open** | predicate still guards `projectId.startsWith('local/')` at `:341` before the missing-path check; 2 `github.com/*` projects have gone `localPath`s and remain first-class rows: `jeanibarz/binaural-headtracker` (→ `/home/jean/git/binaural-headtracker`), `jeanibarz/dotclaude` (→ `/home/jean/.claude/kb-scout-eval`) |

## Things that worked well (keep-list)

- **Snapshot ↔ tasks agreement.** `/api/snapshot` = 60 agent streams, `/api/tasks` = 60
  tasks; status breakdown {completed 49, terminated 8, inProgress 3}. No drift.
- **Task referential integrity.** 0 orphan `childTaskIds` (13 parents, all children
  present); `id == taskId` everywhere; every terminal task has `finishedAt`; no
  in-progress task carries a `finishedAt`.
- **Terminal-state model is coherent.** Every terminal task has a `terminalReceipt`; no
  in-progress task does. `receipt.status == task.status` for all 60. Clean taxonomy:
  `reason` {completed_normal 49, timeout 8}, `workDisposition` {completed 49,
  abandoned 8}, `source` {task_self 29, user 20, watchdog 8}. Every `completed` task has a
  `completionDigest`; no `terminated` task does.
- **Tied-count over-count is gone.** No project shows `tiedIssues > openIssues` or
  `tiedPRs > openPRs` (the June RFC's opening finding). Counts are well-typed ints.
- **Launch is well-instrumented.** `launchPhaseTimings` present on 48 tasks with a clean
  per-phase breakdown (`preflight` / `reserve` / `session-create` / `agent-boot` / `ack`).
  Total launch latency is ~9–10.5 s, dominated by `preflight` (~5 s) and `agent-boot`
  (~4–5 s) — expected process-spawn cost, not friction (though it is the window during
  which R2-F2's un-retracted "Launching…" toast would be visible).
- **No stalled in-progress tasks.** All 3 in-progress tasks have fresh `updatedAt`
  (within ~1 min of capture); none is silently hung.
- **Spend header trust landed (R1-F4 fixed, #3488).** The all-time figure now carries a
  visible `all-time` scope label + explanatory tooltip and a real `totalSpendUsd` API
  field — the exact fix the run-1/run-3 priority order asked for.
- **A lean task-list path now exists (R2-F1 partial).** `GET /api/tasks?view=compact`
  drops the prompt bodies — a scripter no longer has to download 8.5 MB to list tasks,
  even though the default is still heavy.

## Suggested priority order (shippable clusters)

1. **Spend-trust completeness (R4-F1, medium).** Finish what #3488 started: the header is
   now honest, but the per-project `Spend: $X/$Y` still coerces un-priced cost to $0 with
   no "partial" cue. Add an `unpriced`/`costPartial` signal and a `~$X` affordance.
   Highest *data-trust* leverage; one aggregation site + one label.
2. **Lean `/api/tasks` by default (R2-F1).** The compact projection already exists — flip
   the default (or at least stop shipping `prompt`+`userPrompt`+`launchIntent` together)
   so the list endpoint isn't 8.5 MB. Biggest *DX/efficiency* win, lowest new code.
3. **Project-list hygiene (R3-F2 + R1-F3), one pass.** Widen the gone-`localPath`
   exclusion at `project-summary.ts:341` beyond `local/*` so dead `github.com/*` rows drop
   out, and sanitise raw-space ids. Two live gone-path rows + `local/ferox capital` as
   evidence.
4. **Frontend "phantom value" fallbacks (R3-F1 + R4-F3 + R4-F2).** Replace
   `stalledAgents ?? findingCount` (`ProjectSidebar.tsx:178/466`) and
   `activeFindingCount ?? 0` (`LiveFrictionCalibrationPanel.tsx:119`) with explicit
   unknown states, and clear stuck-flag tracking on the terminal path
   (`task-routes.ts:1659`). Small, same family (don't render partial/absent as real).
5. **Client-side cwd check (R1-F6).** Warn (don't block) on a nonexistent cwd in the
   Launch dialog; still the cheapest way to stop bad-cwd launches from seeding junk rows.

## Session log

- 2026-11-06 — **Phase 1 setup.** Dashboard live (`/api/snapshot` = 60 streams). Fetched
  origin; found 202611 already had runs 1–3; created run-4 worktree on `origin/main@8508ccac`
  and seeded this living RFC.
- 2026-11-06 — **Phase 2 API cross-checks.** snapshot↔tasks counts agree (60/60);
  referential integrity + status/timestamp consistency clean; terminal-state model
  internally consistent (→ keep-list). `/api/tasks` measured at 8.5 MB/60 tasks (R2-F1
  still open). No cost/stats endpoint exists (404); `/api/queue` exists (undocumented) and
  returns `[]`. Project hygiene: 0 gone `local/*`, 2 gone `github.com/*` localPaths (R3-F2),
  `local/ferox capital` raw space (R1-F3), tied-counts null→int 0 (R1-F2 resolved).
  Dispatched an Explore agent to verify R1-F4/R1-F6/R2-F1/R3-F1/R3-F2 in code and hunt
  net-new latent hazards.
- 2026-11-06 — **Phase 2 scope decision.** Per the `ux-dogfood-loop` notebook's mature-rerun
  lesson ("net-new findings scarce; confirm which prior findings are still open on current
  origin/main, plus code-rooted latent hazards"), run 4 did **not** re-drive the full UI
  (runs 1–3 drove the launch/terminal/triage paths within the last ~2 days and found them
  polished; launching no tasks also avoids seeding junk `local/*` rows). Evidence is
  read-only API + code.
- 2026-11-06 — **Phase 2 code reconciliation (Explore agent, verified at `file:line`).**
  Closed: R1-F4 (TopBar scope label, #3488). Partial: R2-F1 (`?view=compact` opt-in added,
  default still heavy). Still open: R1-F6 (`LaunchTaskDialog.tsx:356`), R3-F1
  (`ProjectSidebar.tsx:178/466`), R3-F2 (`src/core/project-summary.ts:340-347`). Not
  reproduced on today's data: R1-F1, R1-F7, R2-F3. Net-new: R4-F1 (`project-summary.ts:370`
  spend $0 coercion, medium), R4-F2 (`task-routes.ts:1659` stuck-flag tracking leak, low),
  R4-F3 (`LiveFrictionCalibrationPanel.tsx:119` phantom-0, low). Wrote findings, keep-list,
  reconciliation table, and priority order.
