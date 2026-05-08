# RFC: Cost Comparison Panel — Historical Coverage & Performance

## Status

**Draft (v1)**

**Date:** 2026-05-08
**Author:** Jean Ibarz (with Claude)
**Predecessor:** [`rfc-cost-comparison-panel.md`](./rfc-cost-comparison-panel.md) (merged via PRs #176 / #177 / #178)

---

## Problem

The Cost Comparison panel ships and renders, but on the author's live machine it is structurally empty. The predecessor RFC's Phase-0 "Finding A — Kookr task history is ephemeral" is no longer a footnote: it is the dominant reason the panel does not pay back its cost. Concretely, observed on `main` at e2c5ab3:

| Surface | Live observation |
|---|---|
| Live `~/.kookr/tasks.json` | 2 tasks total — both Claude, both currently-running. 0 Codex. |
| `/api/cost-comparison?window=all` `perPlaybook` | 1 row (`<no-playbook>`), Claude only. |
| `/api/cost-comparison?window=all&agent=codex-cli` | empty `perPlaybook` / `aggregate` / `perTask`. |
| `notes` envelope | `2218 Codex rollouts not bound to any Kookr task`, `235 abandoned`. |
| `scanDurationMs` (window=all) | 7.3 s warm, 94.2 s cold (R6 budget: 200 ms / 5 s). |
| `docs/reports/cost-comparison-decisions.md` | template only — no entries. |

The panel's success metric (one entry in `cost-comparison-decisions.md` per 30-day window) **cannot trip** in this state. The predecessor RFC explicitly deferred the task-archive mechanism: *"That mechanism is out of scope for this RFC."* This RFC builds it, plus three smaller fixes that compound the same emptiness symptom.

The five problems, ranked by impact on the success metric:

1. **No historical task coverage.** The cost route reads only `taskStore.listTasks()` — the live store. Daily and predelete snapshots (`tasks.json.daily.YYYYMMDD`, `tasks.json.predelete.YYYYMMDDTHHMMSS`) sit on disk but are never read. Every swept task disappears from the panel.
2. **Orphan Codex spend is invisible.** 2218 Codex rollouts on disk represent real money the user paid OpenAI; the panel attributes $0 to Codex because none of them bind. The cross-agent comparison is silently lying.
3. **Codex-only filter is always empty.** Compounding consequence of #1 — there is never a Codex task in the live store with a thumb to compare against.
4. **`window=all` cold scan is 19× over budget.** 94 s, vs the 5 s ceiling specified in R6 of the predecessor RFC.
5. **Decisions audit log is unwritten.** Even with the data sparsity, the predecessor RFC's "no rule trip — current routing reasonable" entry-cadence has not started.

(1) is load-bearing. The other four are honest small bugs that this RFC fixes in the same wave because the cost of reviewing them in isolation exceeds the work itself.

## Empirical grounding

All numbers below were observed on the author's machine on 2026-05-08, against `main` at e2c5ab3, with the dev server running on `localhost:4800`.

- `~/.kookr/tasks.json`: 2 entries (both Claude, both running).
- `~/.kookr/tasks.json.daily.YYYYMMDD`: 4 daily snapshots (`20260505`, `20260506`, `20260507`, `20260508`). Sizes 58 B → 49 KB → 12 KB → 4 KB. Together they hold the recoverable task history.
- `~/.kookr/tasks.json.predelete.YYYYMMDDTHHMMSS`: 3 predelete snapshots from sweep events (taken before clear-completed mutates the live store). These are the **only** record of swept tasks — the daily snapshot of the same day reflects the post-sweep state.
- `~/.codex/sessions/`: scanner reports 2218 orphan rollouts in `window=all` (interactive Codex use + Kookr-launched but swept tasks).
- `scanDurationMs`:
  - `window=24h`: 28 ms warm.
  - `window=7d`: 69 ms warm.
  - `window=all`: 7339 ms warm, ~94 s cold.

`collectPaths` (`src/adapters/codex-rollout-scanner.ts:348`) walks `[windowStartMs - 1d, windowEndMs + 1d]` UTC. For `window=all` the lower bound is `epoch − 1d`, so it iterates ~57 years × 365 directories. The author's `~/.codex/sessions` happens to be ~year-old, so most `safeReaddir` calls return early — but the directory iteration itself costs the 94 s.

`docs/reports/cost-comparison-decisions.md`: 40 lines, all template / format-spec; no entry below the `---` divider.

## Why now / what success looks like

The cost panel is the author's first "decision-driving telemetry" surface in Kookr. If 30 days from now there is still no entry in `cost-comparison-decisions.md`, the predecessor RFC's success metric has empirically failed and the panel becomes pure maintenance debt. Either we make it work, or we cut it. This RFC chooses to make it work.

**Success metric (this RFC):** within 30 days of merge, `cost-comparison-decisions.md` has at least one entry — either a rule-trip with concrete numbers, or a "no rule trip — routing reasonable" entry. Same metric as the predecessor; this RFC is about making that metric reachable.

**Non-goal:** redesigning the panel UI. The shape stays — three sections, agent chips, search, time window. This RFC only changes (a) what data feeds the shape, (b) how fast it computes, and (c) one new "Unbound Codex spend" affordance.

## Active-user reality check

Single-tenant local. Author runs ~30 tasks/week, a long tail of interactive `codex` outside Kookr, and sweeps completed tasks aggressively. ~0–10 daily snapshots and 0–10 predelete snapshots in retention at any time (depends on GC; see §Open questions).

## Design principles

1. **Snapshots are append-only forensic state, not authoritative state.** The live store wins on every (taskId) collision. Snapshots only fill in what live no longer holds.
2. **A swept task that bound to a Codex rollout once still binds.** The `(cwd, ±60 s)` heuristic is stable across time — once we recover the task's `cwd` and `createdAt` from a snapshot, the existing `bindTasks` produces the same outcome it would have produced live.
3. **Orphan spend is visible by default but flagged.** The author asked for a Claude-vs-Codex panel; hiding 2218 unbound Codex rollouts from the aggregate (current behavior) makes that comparison silently wrong. Surface it, but mark it visually distinct so the per-playbook and per-task tables remain trustworthy attribution surfaces.
4. **No new state files.** This RFC adds zero on-disk artifacts. All data sources already exist.

## Proposed changes

### Change 1 — Read snapshots in the cost route (load-bearing)

The cost route gains a snapshot-union step before calling the aggregator. Contract:

```typescript
// src/server/use-cases/load-historical-tasks.ts (new)
export async function loadHistoricalTasks(
  liveTasks: Task[],
  kookrHomeDir: string,         // typically ~/.kookr
): Promise<Task[]> {
  // 1. Glob tasks.json.daily.* + tasks.json.predelete.*
  // 2. loadTasks() each file (existing API in src/core/task-persistence.ts:239)
  // 3. Build a Map<taskId, Task> seeded with liveTasks (live wins)
  // 4. For each snapshot file, in mtime order, fill in any taskId not already present
  // 5. Return Map.values() as Task[]
}
```

Used by `task-routes.ts:860`:

```typescript
const liveTasks = taskStore.listTasks();
const tasks = await loadHistoricalTasks(liveTasks, kookrHomeDir);
```

Three structural decisions:

- **Live wins on collision.** A live task may have been mutated since its snapshot (status flipped, feedback rating set, etc.). The snapshot copy is strictly older. This avoids regressing the user's just-set thumbs-up by overwriting with the snapshot version.
- **Mtime order, oldest first, "first seen wins."** Newer snapshots reflect the same state-at-time-of-snapshot for already-seen taskIds; the first snapshot to surface a taskId is the one closest to that task being live, so its data is the cleanest. This is the inverse of the live-wins rule and only applies among snapshots themselves.
- **`predelete` snapshots are eligible.** They are the *only* record of swept tasks. Excluding them defeats the entire point of this RFC. The trade-off — predelete snapshots can pile up — is bounded by the existing GC (see §Open questions).

The aggregator does not change. Window filtering (`createdAt ∈ [windowStartMs, windowEndMs]`) handles the case where a snapshot resurfaces a task older than the requested window — it is dropped on filter, no special handling needed.

### Change 2 — Surface orphan Codex spend as a labeled aggregate

The scanner already returns `orphanRollouts: CodexRolloutMeta[]`. Currently they appear only in the notes envelope. New shape:

```typescript
interface CostComparisonResponse {
  // ...existing fields...
  unboundCodex?: {
    rolloutCount: number;
    totalCostUsd: number | null;       // null if any rollout has unknown-pricing
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCachedInputTokens: number;
    /** A subset of the per-row dataQuality discriminant — counts only. */
    dataQualityCounts: {
      complete: number;
      'unknown-pricing': number;
      'codex-no-tokens': number;
      'codex-parse-error': number;
    };
  };
}
```

Frontend renders this as a fourth aggregate card *next to* (not blended into) the Codex card, labeled "Unbound Codex (interactive / swept)". The visual separation honors design-principle #3: per-playbook and per-task tables remain Kookr-attributed; the "what did I actually pay OpenAI this window" question is answered by adding the two cards in the user's head.

Why not blend into the Codex aggregate? Because once you blend, you have to also blend into per-playbook (which is impossible — orphans have no playbookId), which makes per-playbook ratios silently wrong. Keeping them separate preserves the per-playbook trust surface.

### Change 3 — Bound the directory walk

`collectPaths` clamps `windowStartMs` to the earliest known task's `createdAt`, minus a small margin:

```typescript
const earliestTaskMs = tasks.length === 0
  ? windowEndMs - 30 * ONE_DAY_MS                  // empty store fallback
  : Math.min(...tasks.map(t => +new Date(t.createdAt)));
const effectiveStart = Math.max(windowStartMs, earliestTaskMs - 7 * ONE_DAY_MS);
```

Applied at the route, passed to `scanner.scan(effectiveStart, windowEndMs)`. The 7-day margin absorbs clock skew, sub-agent rollouts whose `session_meta.timestamp` precedes the parent's `createdAt`, and any "started Codex slightly before launching the Kookr task" edge cases.

The `window=all` semantic stays intact: "all known Kookr tasks" is what the user actually wants, not "all UTC time since epoch." The orphan card (Change 2) preserves the user's ability to see Codex usage that *predates* any surviving Kookr task, but at the explicit cost of a wider scan when the user views unbound spend.

For the unbound view (Change 2), the directory walk is bounded by the requested window (`windowStartMs` directly), no clamping. Cold scans at `window=all` for the unbound view will still be slow on first hit, but the warm cache makes subsequent views sub-second. Acceptable: orphan spend is an opt-in surface.

### Change 4 — Auto-write a "no rule trip" entry on a 30-day cadence

Lightweight: a daily lifecycle-timer check in `lifecycle-timers.ts` that:

1. Reads `docs/reports/cost-comparison-decisions.md`.
2. Parses the most recent `### YYYY-MM-DD —` entry's date.
3. If `(today − lastEntryDate) > 30 days`, runs the aggregate over the last 30-day window, writes a stock entry:

   ```
   ### 2026-06-07 — auto — no rule trip
   - Window: 2026-05-08 → 2026-06-07
   - Claude: n=12, median $0.45, 👍 67% (3 of 9 rated tasks)
   - Codex:  n=4,  median $0.18, 👍 50% (1 of 2 rated tasks)
   - Rule trip: no, no playbook had ≥ 5 runs per agent
   - Action: do nothing — autowrite
   ```

4. Logs to server stdout with `[cost-comparison-decisions]` prefix.

This is a *prompt to think*, not a substitute for thinking. The entry being auto-written reminds the author the panel exists; if the entry is consistently identical month-over-month, the panel is failing its goal and the RFC's success metric is the trigger to retire the surface.

The autowrite is **not** added in PR 1 — see §Implementation phases.

## Counter-design considered

### Counter-design A — Build a dedicated task archive

A separate JSON file (`tasks-archive.json`) appended to on every task completion. Cleaner contract, no snapshot-glob, no live-wins rule.

**Rejected** because it doubles the on-disk write path and creates a new failure mode (archive write fails, live succeeds, task is lost from history). The existing snapshot mechanism already produces the data we need; reading it is purely additive. Additionally, the user's installation already has 30+ days of snapshots — a fresh archive starts from zero, which delays the success metric by another 30 days.

### Counter-design B — Don't read predelete snapshots, only daily

Daily snapshots are smaller and more numerous; predelete snapshots can be huge if a sweep removes many tasks at once. Skipping predelete avoids loading large files.

**Rejected** because predelete is the *only* place a swept task lives if it was swept on the same day it was created (the daily snapshot for that day reflects the post-sweep state). On the author's machine, ~70% of historical Codex tasks were swept same-day. Excluding predelete defeats the RFC.

### Counter-design C — Push orphan attribution into per-playbook via cwd-only matching

When a rollout's cwd matches an existing task's cwd but no time window matches, attribute it to that task's playbook anyway. Would let orphan spend flow into the per-playbook ratios.

**Rejected** because it produces silently-wrong attributions: if the user later runs interactive Codex in the same cwd as last week's Kookr task, that interactive spend gets billed to the wrong playbook with no diagnostic. The current `(cwd, ±60 s)` heuristic is conservative on purpose. The orphan card (Change 2) is the honest surface for the un-attributable.

## Implementation phases

The author writes this code, not Claude — the predecessor RFC's PRs #176/177/178 totaled ~3500 LOC and proved the surface non-trivial enough to want phasing. Three PRs:

**PR 1 (load-bearing): snapshot union + bounded scan.** Changes 1 + 3. New module `src/server/use-cases/load-historical-tasks.ts`, integration in `task-routes.ts`. Update `cost-comparison-aggregator.test.ts` to cover the live-wins-on-collision invariant; add `load-historical-tasks.test.ts` with fixtures for the daily / predelete glob behavior. Sub-`scanDurationMs` ≤ 5 s on `window=all` post-clamp, locked in by a microbench with the author's real corpus size as the ceiling.

**PR 2: unbound-Codex aggregate.** Change 2. Wire shape extension in `src/shared/contracts/cost-comparison.ts`, aggregator + scanner sum the orphans, frontend gains a fourth card next to the Codex aggregate. `notes` entry shrinks to an informational "data shown above" rather than the current "X rollouts not bound" warning. Manual smoke: confirm orphan card sums approximately match the user's OpenAI billing dashboard for the same window (within ±10%).

**PR 3: decisions audit autowrite.** Change 4. Daily lifecycle-timer check, hand-coded markdown emission, server-log breadcrumb. Behind a `KOOKR_COST_DECISIONS_AUTOWRITE=1` env flag for the first 30 days post-merge so the author can reverse it if the auto-entries prove noisy. Flag retired in a follow-up commit if the format proves useful.

PR 1 is the only one that is load-bearing for the success metric. PRs 2 and 3 are independently revertable.

## Risks and open questions

1. **Snapshot retention is unspecified.** The codebase ships daily and predelete snapshots; nothing seems to prune them. On a multi-year-old install the snapshot glob could load gigabytes. **Mitigation:** PR 1 caps loaded snapshot files at 90 (oldest dropped) and surfaces a note when capped. **Open:** does the existing snapshot mechanism have a GC story? If yes, can we lean on it. If no, this RFC may need to grow a small GC pass.
2. **The live-wins-on-collision rule may regress live state.** If a live task is currently mid-mutation while the cost route reads, the snapshot's stable copy could be more consistent than the half-updated live copy. **Mitigation:** the cost route is read-only telemetry — staleness on a ms-scale is acceptable; consistency under concurrent mutation is not the panel's job.
3. **Orphan card may dominate the Codex visual story.** The author has paid materially more in interactive Codex than in Kookr-launched Codex. If the orphan card shows $200 and the bound card shows $5, the per-playbook table starts looking irrelevant. **Mitigation:** the visual separation in Change 2 is the answer — orphan is on a separate card, the per-playbook ratios are unchanged. If the visual signal is wrong, PR 2 is fully revertable.
4. **Autowrite may erode the "prompt to think" intent of the rule.** If the autowrite template is identical 12 months in a row, the author starts ignoring it. **Mitigation:** PR 3 ships behind a flag; if the entries become noise, retire the autowrite and restore the manual cadence.
5. **The 7-day margin in Change 3 is a guess.** Based on the predecessor RFC's `±60 s` discovery window plus a conservative buffer for clock skew across machines. **Open:** is there a sub-agent rollout in the author's corpus where parent `createdAt` precedes the first sub-agent rollout `session_meta.timestamp` by > 7 days? If yes, this margin is too tight. PR 1's microbench should print the worst-observed delta.

## Open questions (to resolve before PR 1 opens)

- **Q1.** Is there an existing snapshot GC story? Confirmed via grep: no — `tasks.json.daily.*` and `tasks.json.predelete.*` accumulate. The cap-at-90 mitigation is necessary, not optional.
- **Q2.** Should the `unboundCodex` card respect the `agent` filter chip? When the user filters to "Claude only," should the unbound card disappear? **Tentative:** yes — the filter chip is "show me this agent's data," and unbound Codex should not display under a Claude filter. If the user wants the cross-agent total, they're on "All" anyway.
- **Q3.** Do per-playbook rows for `<no-playbook>` make the success metric reachable on the author's actual usage pattern? Predecessor RFC's Phase-0 Finding C said no. **Action:** PR 1 should ship a follow-up note stating that, post-snapshot-union, if `<no-playbook>` still dominates the per-playbook table, the next step is an unrelated playbook-adoption push, not a cost-panel change.

---

## Predecessor cross-reference

| Predecessor RFC §          | This RFC's response |
|---|---|
| Finding A (ephemeral history) | Change 1 — snapshot union. Load-bearing. |
| §Discovery (`(cwd, ±60 s)`) | Unchanged. Snapshot-union recovers `cwd` + `createdAt` so the heuristic still works on snapshot-revived tasks. |
| §Aggregate metric shapes | Wire shape gains optional `unboundCodex`. Existing fields unchanged. |
| R6 (perf budget) | Change 3 — directory-walk clamp. Stays in budget. |
| Success metric | Unchanged target; this RFC makes the target reachable. |
| `cost-comparison-decisions.md` | Change 4 autowrite ensures cadence. |

