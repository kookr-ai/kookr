# RFC: Ralph Loop — Iteration-As-Task Reframing & Findings

**Status:** Draft (v3 — post 4-agent critic review of v2)
**Date:** 2026-05-06
**Author:** Jean Ibarz (with Claude)

(See git history for v1 and v2. v1 proposed bolt-on improvements to the post-#68 redesign. v2 reframed: each iteration is its own task, parent record holds policy. v3 incorporates the agent review: keeps the reframing, splits it into a Phase 0 cheap fix that ships today and an opt-in Phase 2 full migration, and explicitly acknowledges the playbook-side alternative.)

---

## The bug that motivated this RFC

User report, 2026-05-06, **after PR #67/#68 shipped**:

> "I closed one task and all of them where gone again, the original problem is still there."

Code path that produces it (`src/server/ws-handlers/lifecycle-handler.ts:167–212`):

```ts
case 'completeTask': {
  const completingTask = this.deps.taskStore.getTask(msg.taskId);
  if (
    completingTask?.ralphLoop
    && (completingTask.ralphLoop.status === 'running' || completingTask.ralphLoop.status === 'paused')
  ) {
    this.deps.ralphLoopService.cancelLoop(completingTask);   // ← kills all future iterations
  }
  …
  await completeTaskImpl(msg.taskId, this.deps.getLifecycleDeps());   // ← kills all live sessions
  …
}
```

The user clicks "complete" on what looks to them like *one finished iteration*. The handler interprets it as "complete the entire loop." PR #68 stopped the *current* session from being killed mid-flight; it left the `cancelLoop` call in place. The redesign hardened owner-ref discipline within the existing model. **This bug isn't an owner-ref bug — it's a model bug.**

## The reframing

> User: "The essence of a Ralph loop is to spawn a task with an intemporal prompt, let it does its thing until completion, and then spawn again the exact same prompt. … Imagine the user spawns a task with a prompt, and when it finishes it just clicks complete and relaunches the task. **All the mechanisms are nearly already there.**"

A Ralph loop is *a series of sibling tasks sharing a prompt and a continuation policy*. Each iteration is a normal task. The "loop" is the rule that says "when this task hits a terminal status, spawn the next one if policy allows."

Under that reframing, the bug becomes structurally impossible: clicking complete *is* what triggers the next iteration. There is no special case for the dispatcher to get wrong.

The agent review confirmed that this is the correct shape but flagged that v2's migration plan was unrealistic. v3 splits the work into three independently-shippable phases.

---

## Phase 0 — Ship the bug fix today (P0)

**Source:** delivery-pragmatist review of v2; refined after correctness-specialist review caught a worktree-cleanup race in the naive deletion variant.

### The naive deletion that doesn't work

The literal "smallest change" — delete the `cancelLoop` call from `completeTask` — has a follow-on bug. After deletion, `completeTask` still calls `completeTaskImpl`, which:

1. Transitions `task.status` to `'completed'`.
2. Releases worktree leases.
3. Fire-and-forgets `cleanupTaskWorktrees` — which `rm -rf`s the task's worktree directory once `isClean` passes.

The Stop hook on the killed owner session then arrives async, sees `ralphLoop.status === 'running'`, and tries to spawn iteration N+1 in a directory racing with deletion. The user's "all of them are gone" symptom gets worse, not better.

### What ships instead

Short-circuit the `completeTask` handler when the target is a Ralph child whose loop is still active. Stop the live session(s) only — skip every task-level teardown step:

```ts
case 'completeTask': {
  const completingTask = this.deps.taskStore.getTask(msg.taskId);

  // Ralph child whose loop is still active: "complete" means "this
  // iteration is done", not "the task is done". Skip task-level
  // teardown (status transition, lease release, worktree cleanup —
  // any of which would corrupt the next iteration's state) and just
  // stop the live session(s). The Stop hook on the killed owner
  // session is what spawns iteration N+1 in this same task. To stop
  // the loop entirely, use cancelTask.
  if (
    completingTask?.ralphLoop
    && (completingTask.ralphLoop.status === 'running' || completingTask.ralphLoop.status === 'paused')
  ) {
    for (const session of completingTask.sessions) {
      if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
        await cleanupSessionResourcesImpl(session.tmuxSession, this.deps.getLifecycleDeps());
        this.deps.taskStore.updateSession(completingTask.id, session.tmuxSession, { lastStatus: 'completed' });
      }
    }
    return { duplicate: false };
  }

  // [rest of original completeTask handler unchanged]
}
```

After this:

- `completeTask` on a Ralph child stops the live session(s) and returns. `task.status` and `task.ralphLoop` are untouched. No worktree cleanup. No lease release.
- The killed owner session's Stop hook arrives, sees `ralphLoop.status === 'running'`, evaluates predicate / cap / cost via the cycler, and spawns iteration N+1 in the still-intact task cwd.
- After predicate / cap / cost terminates the loop (`ralphLoop.status` becomes `'completed'`/`'failed'`), the early-return guard no longer fires and `completeTask` falls through to the normal completion flow — terminated loops get full task-level teardown the next time the user clicks complete.

### The complementary change to cancelTask

`cancelTask` on a Ralph child today does **not** call `cancelLoop`. It kills the owner session via `cancelTaskImpl`, the Stop hook fires, and the loop service spawns iteration N+1 — i.e. the dashboard's Cancel button is broken for Ralph children. To make the reframing complete (complete = next iteration; cancel = loop done), we add a `cancelLoop` call to the `cancelTask` handler **before** `cancelTaskImpl`:

```ts
case 'cancelTask': {
  const cancellingTask = this.deps.taskStore.getTask(msg.taskId);
  if (
    cancellingTask?.ralphLoop
    && (cancellingTask.ralphLoop.status === 'running' || cancellingTask.ralphLoop.status === 'paused')
  ) {
    this.deps.ralphLoopService.cancelLoop(cancellingTask);
  }
  await cancelTaskImpl(msg.taskId, this.deps.getLifecycleDeps());
  // [rest unchanged]
}
```

`cancelLoop` is synchronous; it flips `ralphLoop.status` to `'cancelled'` before `cancelTaskImpl` kills the session. The Stop hook then sees `'cancelled'` and skips both branches in `event-pipeline.ts:218–235` — no spawn.

### Phase 0 — verification

- Symptom test: launch a loop with `iterationCap: 5` and a predicate that never fires; complete iteration 2's task from the dashboard. The owner session is killed, `task.status` and the worktree are untouched, and iteration 3 launches automatically via the Stop hook.
- Paused-arm coverage: same test parameterized over `loopStatus ∈ {'running', 'paused'}` for both `completeTask` and `cancelTask`.
- Terminated-loop coverage: `completeTask` and `cancelTask` on a Ralph child whose loop is already `'completed'` fall through to the standard completion / cancellation flow.
- Regression: `cancelTask` on a Ralph child now cancels the loop (was a silent no-op before this PR; the dashboard's Cancel button now does what the label says).

Scope: ~25 lines of handler logic + ~70 lines of tests in `ws.test.ts`. One PR.

### Phase 0 risks

| Concern | Phase 0 status |
|---|---|
| Double-Stop spawning two children (FM1) | **Already mitigated** — `lastHandledStopFingerprint` dedup at `ralph-loop-service.ts:464–466` is unchanged. |
| Worktree cleanup race (raised by correctness-specialist v3) | **Mitigated by short-circuit** — `cleanupTaskWorktrees` is no longer called for active Ralph loops. |
| Predicate cwd vs worktree cwd (FM10) | **Pre-existing, unchanged** — Phase 0 doesn't touch the cycler. Worth a separate fix RFC. |
| MAX_ACTIVE_TASKS stall (FM5) | **Unchanged** — same legacy `launchFreshTaskSession` path. |
| Server crash recovery | **Unchanged** — `reconcileStartupLoops` still applies; loop status field is what it always was. |
| Stale digest / completion toast for intermediate iterations | **Acceptable for Phase 0** — the digest only fires on the terminal completeTask after the loop ends; intermediate iterations no longer emit a toast (they shouldn't anyway, since the iteration's "completion" is internal to the loop). |

Phase 0 is a behavior change, not a model change. The data model (task.ralphLoop, ownerSessionId, fingerprint dedup) is untouched.

---

## Phase 1 — Surface loop state cleanly on the existing model (P1, optional)

**Source:** v1 findings F2/F3/F4 from the experimental run.

Independent of Phase 0. Independent of any model change. Just fixes the API surface so the loop is observable:

- Fix `/api/tasks/:id` returning 404 for active tasks (likely a route-registration bug; not loop-specific).
- Surface `iterationsCompleted`, `state`, `terminationReason`, `totalCostUsd` in the listing endpoint (the data exists in the cycler; just isn't serialized).
- Make `task.status` transition to `completed` synchronously when `lastIterationExitReason === 'predicate_satisfied'`. Currently lags 2–3 minutes per the experimental-run observation.

Scope: ~80 lines. One PR. Ships independently of Phase 0 or Phase 2.

---

## Phase 2 — Full iteration-as-task migration (P2, optional, multi-PR)

**Source:** the user's reframing; design-minimalist + boundary-critic + delivery-pragmatist + failure-mode-analyst reviews.

Ship Phase 2 only if Phase 0 + Phase 1 prove insufficient. Reasons it might be worth it:

- Each iteration deserves its own dashboard row (the user's mental model).
- Eliminate owner-ref bookkeeping entirely (close to ~150 lines).
- Eliminate the `task.status` ↔ `ralphLoop.status` two-state-machine concern (deferred from #68).

Reasons it might not be worth it:

- Phase 0 already fixes the user's bug.
- The boundary-critic and FMA found that the "simpler model" hides ~700–1100 lines of touched code, including:
  - `ralph-cycler.ts` (~285 lines) — must be rewritten or dissolved into the relauncher.
  - `task-routes.ts` — 26 references to `ralphLoop` across pause/resume/cancel/complete/attach/updatePrompt handlers.
  - `looped-playbook-launch.ts:187` (`findActiveLoopedPlaybook`) — the dedup guard reads `task.ralphLoop`; without an update, two parallel loops can launch.
  - `reconcileStartupLoops` (`ralph-loop-service.ts:351–413`) — needs an analogue for the new model or new-model loops crash-recover incorrectly.
  - `cleanupTaskWorktrees` interaction — sibling tasks share `cwd`; one's cleanup must not nuke the next iteration's state.
  - Persistence — `RalphLoopRecord` needs its own persistence path parallel to `task-persistence.ts`.

The realistic split is **four PRs**, not the two v2 claimed:

1. **PR A — entity + store + persistence.** New `RalphLoopRecord` type in `src/core/ralph-loop-record.ts` (per boundary-critic: domain data lives in `core`). New `RalphLoopStore`. JSON persistence path. `parentLoopId?: string` field on `Task`. Backwards-compat: read both `task.ralphLoop` (legacy) and `task.parentLoopId` (new) at startup. ~250 lines + tests.

2. **PR B — relauncher hook + cycler dissolution.** Free function `onTaskTerminal(task, deps): Promise<void>` exported from `src/server/ralph-loop-relauncher.ts` (per boundary-critic: stateless, no class needed). Wired into `event-pipeline.ts` via an explicit dep injection (not a global pub-sub — per the codebase pattern at `event-pipeline.ts:55`). Predicate evaluation moves here from `ralph-cycler.ts`. The cycler class becomes dead code. ~300 lines added + ~285 deleted.

3. **PR C — route + dispatcher migration.** Update `looped-playbook-launch.ts` to write a `RalphLoopRecord` and create a child task. Update `task-routes.ts`'s 26 `ralphLoop` references to dispatch on `parentLoopId` for new-model loops. New `cancelLoop` REST/WS operation. Update `findActiveLoopedPlaybook` to use `RalphLoopStore`. New startup reconciliation: any `RalphLoopRecord.status === 'running'` whose `lastChildTaskId` task is in a non-terminal status with no live session → mark loop `failed`. ~200 lines.

4. **PR D — legacy deletion.** After all in-flight legacy loops drain (typically a week given iteration caps), remove the dual-codepath: drop `ownerSessionId`, `claimRalphLoopOwner`, `findLiveSession`, `isStopFromMainTaskSession`, `RalphLoopState`, the `task.ralphLoop` field, the cycler class. ~400 lines deleted.

Total: ~750 lines added, ~685 deleted, four PRs.

### Phase 2 — failure modes that must be addressed in the design

The failure-mode-analyst flagged 16 concerns. The load-bearing ones for Phase 2:

| # | Concern | Mitigation in design |
|---|---|---|
| FM1 | Double-Stop on `T_n` spawning two `T_{n+1}` | Per-loop spawn lock keyed on `loopId`. Equivalent to `lastHandledStopFingerprint` but at the relauncher level. ~10 lines. |
| FM4 | Cost trails terminal status; cap overshoots by 1 | Predicate evaluation defers spawning until token-tracker drains. Already a soft pattern in `event-pipeline.ts:186–199` for fire-and-forget cost scans; Phase 2 needs an explicit await. |
| FM5 | `MAX_ACTIVE_TASKS` ceiling stalls loops | Loop children should bypass the ceiling or have their own quota — they don't represent independent user-initiated work. Decision needed; current legacy code never trips this because session rotation happens within one task. |
| FM6 | `launchTask` throws → dangling `childTaskIds` | Transactional pattern: append to `childTaskIds` only after `createTask` returns successfully. |
| FM7 | Server crash between `T_n` complete and `T_{n+1}` spawn → stuck loop | New startup reconciliation in PR C: scan `RalphLoopRecord`s, fail records whose last child terminated without a successor and whose status is still `running`. |
| FM10 | Predicate cwd vs worktree cwd | Predicate runs in `loop.cwd` (= `child.cwd`, since they're identical for non-worktree-jumping playbooks). Playbooks that jump to worktrees (like `implement-github-issue.md`) write `.batch-stop` to the *batch* cwd anyway — that's already the contract. Phase 2 doesn't make this worse. Independent fix recommended for the cwd/worktree mismatch. |
| FM11 | Persisted task with both `ralphLoop` and `parentLoopId` | Dual-codepath gate per task, not per server: if a task has `ralphLoop`, route through legacy; if it has `parentLoopId` instead, route through new. After PR D, only `parentLoopId` survives. |
| FM12 | 20× transcript files, broadcasts, hook subscriptions | Real operational cost. Mitigations: shared-`cwd` worktree cleanup runs only on the *last* child's terminal state; per-iteration `ralph-iterations.jsonl` lives at the loop level (`<loop.cwd>/.kookr/ralph-state/<loopId>/iterations.jsonl`), not per-child. |
| FM14 | `RalphLoopRecord` not persisted → restart loses parents | PR A includes JSON persistence. Required. |
| FM15 | `cleanupTaskWorktrees` deletes worktree `T_{n+1}` will reuse | Worktree cleanup conditional: skip if `task.parentLoopId != null && loop.status === 'running'`. The loop's own cancel/terminal path runs cleanup when no further child will spawn. |

### Phase 2 — boundary corrections from the boundary-critic review

- **`RalphLoopRecord` lives in `src/core/`**, not `src/server/`. Codebase rule: `core/` = domain data, `server/` = I/O orchestration.
- **`RalphLoopRelauncher` is a free function `onTaskTerminal(task, deps)`**, not a class. No private state survives between calls.
- **`childTaskIds` and `parentLoopId` need a clear write-authority**: `RalphLoopStore.appendChildTask(loopId, taskId)` is the explicit method; `createTask` calls it during task creation. Not two independent write paths.
- **Cycler dissolves into the relauncher at PR B**, not deferred. Currently both would own the continuation predicate.
- **Event-pipeline imports the relauncher via dep injection** (matching `ralphCycler?: RalphCycler` at `event-pipeline.ts:55`), not a generic pub-sub mechanism (which doesn't exist in this codebase).

### Phase 2 — explicit additions vs v2

These are items v2 omitted that the critics flagged:

- `pauseLoop` / `resumeLoop` / `updatePrompt` operations: route them through the loop record. `pause` = `loop.status = 'paused'`, relauncher noops. `resume` = back to `running`. `updatePrompt` = mutate `loop.prompt`; next spawn picks up the new prompt. The currently-running child task is not affected by any of these.
- `zeroDiffConvergence` and `lastZeroDiffStreak` fields on `RalphLoopRecord` — used by the cycler's continuation logic; carry forward.
- Plugin-coexistence guard runs at *loop launch*, not per-child task creation. Avoids N filesystem reads per iteration.

---

## Alternative: playbook-side relauncher

**Source:** design-minimalist agent.

The user's "all the mechanisms are nearly already there" admits an even simpler reading: the playbook itself calls `POST /api/tasks` to spawn the next iteration. The engine adds a `parentLoopId` field for accounting and a small `RalphLoopRecord` for cap enforcement, but **no `onTaskTerminal` hook in the event pipeline**.

Under this reading:

- The `implement-github-issue.md` playbook already manages durable state (`.batch-attempted`, `.batch-stop`).
- Its final phase becomes: "if predicate not satisfied and cap not reached, `curl POST /api/tasks` with the same prompt + `parentLoopId`."
- Engine enforces the cap as a pure check (rejects child task creation if `loop.iterationsCompleted >= loop.iterationCap` or cost exceeded).
- Engine has no opinion on Stop events.

**Pros:**

- Even smaller engine surface than Phase 2's relauncher hook (~100 fewer lines).
- More aligned with the user's reframing — the loop is a *series of user-initiated relaunches*, just automated via the playbook.
- Easier to compose with custom workflows: any playbook can opt into looping by just calling the API.

**Cons:**

- A rogue or buggy playbook could ignore the cap (engine's check is the only enforcement).
- Slightly heavier per-iteration latency (extra HTTP round-trip vs in-process spawn).
- The standalone `ralph-wiggum@claude-code-plugins` already does roughly this; if Kookr's engine offers no extra value beyond cap enforcement, why have a Kookr-specific Ralph mode at all?

**Lean for v3:** keep the playbook-side option open as a Phase 2 alternative. The decision between engine-hook and playbook-side comes down to whether engine-enforced cap discipline is worth the relauncher complexity. For single-operator deployments (the current Kookr threat model), playbook-side is probably enough.

---

## Findings from the experimental run (carried through)

These came from the multi-issue Ralph loop run on 2026-05-06 with selector `12, 11, 8` and `mergeAfterImplementation=true`. They are independent of model and ship from playbook + engine separately.

| # | Finding | Disposition |
|---|---|---|
| F1 | Plugin-coexistence check forced manual workaround. | Coexistence override header (~10 lines). Independent. |
| F2 | `/api/tasks/:id` returned 404 for an active task. | **Phase 1.** Likely route-registration bug. |
| F3 | `ralphLoop.iterationsCompleted` / `state` not exposed on listing. | **Phase 1.** Fold into the same PR. |
| F4 | `task.status` lagged after `predicate_satisfied`. | **Phase 1.** Synchronous transition in the relauncher / cycler. |
| F5 | `.batch-attempted` recorded before real work commits → cap=3 cliff. | Playbook-side, independent. Replace with `.batch-state.json` distinguishing recorded from completed attempts. |
| F6 | Duplicate-PR check is purely lexical on branch name. | Playbook-side, independent. Use GraphQL `closingIssuesReferences` for semantic check. |
| F7 | `.batch-attempted` / `.batch-stop` not namespaced per loop. | Defer until plugin-coexistence override (F1) ships. Today's guard makes this concern incidental. |
| F8 | Runtime banner duplicates per-iteration discipline already in playbook body. | Skip per design-minimalist's "don't add a flag" call. Playbook authors edit the body if they want it gone. |
| F9 | Stale per-issue worktrees accumulate across launches. | Housekeeping tool: `bin/kookr-gc`. Independent. |
| F10 | Per-iteration cost of "no-op terminator." | Fundamental. Document, don't fix. |

---

## What v2 got wrong (acknowledgement)

The agent review surfaced four substantive defects in v2:

1. **Scope was off by ~2×.** v2 claimed "~350 net new + ~150 deleted" across two PRs. Honest accounting (per design-minimalist + delivery-pragmatist) is ~750 added + ~685 deleted across four PRs. v3 reflects this in Phase 2.

2. **Migration was framed as "no flag day" via a global env var.** Per delivery-pragmatist, that strands persisted state in mixed shape on restart and leaves rollback orphaned tasks. v3's per-task model gate (FM11) is more correct.

3. **Several deletions were asserted, not justified.** `lastHandledStopFingerprint`, `findActiveLoopedPlaybook`, `cleanupTaskWorktrees` interaction — all real load-bearing logic that needs explicit replacement, not deletion. v3 calls each one out.

4. **Persistence and startup recovery were entirely missing.** v2 didn't mention `RalphLoopRecord` persistence or how `reconcileStartupLoops` would work for the new model. Both are mandatory for a server-restart-safe migration. v3 puts them in PRs A and C respectively.

---

## Recommendation

**Ship Phase 0 today.** It's a 6-line deletion, fully reversible, and addresses the user's reported bug. It also confirms (or refutes) the user's reframing in production: if "click complete = next iteration spawns" feels right to users, that validates the reframing direction. If it feels wrong, we have data to push back on.

**Phase 1 is independent and worth doing whenever someone has time.** Pure observability win.

**Defer Phase 2 unless Phase 0 + Phase 1 prove insufficient.** The full migration is ~four PRs of careful work with persistence, startup recovery, dual-codepath gating, and dashboard implications (M5 from v2). It's the right shape if we commit to it, but the user's bug doesn't require it. Watch for:

- Users reporting that "20 dashboard rows for one logical loop" is too noisy.
- Operators wanting to introspect a specific child task without untangling rotated sessions.
- Future loop policies (e.g., conditional re-prompt mutation) that don't fit the rotate-sessions-in-one-task model.

If those signals appear, Phase 2 is justified. Otherwise, Phase 0 + Phase 1 may be the whole answer.

---

## Open questions

- **Q1.** Phase 2 vs the playbook-side relauncher alternative — when do we have enough data to choose? **Lean:** after Phase 0 ships and we observe whether playbook-side cap enforcement is enough in practice. If users abuse the cap, engine hook is needed. If they don't, playbook-side ships.
- **Q2.** The per-task model gate (FM11) requires the dispatcher to inspect `task.ralphLoop` *or* `task.parentLoopId`. Is that sufficient, or should the gate be a single resolved field (`task.loopModel: 'legacy' | 'iteration-as-task'`) for clarity? **Lean:** start with two-field check; collapse to single field only if the dual check turns out confusing during PR C reviews.
- **Q3.** Should Phase 0 also include a small cleanup of `cancelLoop`'s public API to indicate it's now only callable from `cancelTask` and the explicit (future) `cancelLoop` op? **Lean:** no. Keep `cancelLoop` as-is; just don't auto-invoke it from `completeTask`. Minimal blast radius.
- **Q4.** The predicate-cwd-vs-worktree-cwd hazard (FM10) is pre-existing. Worth a small dedicated RFC, or fold into Phase 0? **Lean:** dedicated. Out of scope for "fix the bug the user reported"; in scope for "make Ralph loops actually robust."
