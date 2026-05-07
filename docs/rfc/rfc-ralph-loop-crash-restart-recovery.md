# RFC: Ralph loop crash-restart — let the user start the loop again

**Status:** Draft (v4 — post round-3 review, presented for user approval)
**Date:** 2026-05-08
**Author:** Jean Ibarz (with Claude)

---

## Problem

The user just survived a crash (Kookr server, WSL, OS, agent runtime, terminal). They open the dashboard, pick the same playbook + cwd + parameters they had running before, and click **Launch**.

They get a 409:

> `matching looped playbook task already exists: <task-id>`

The loop they wanted is sitting there in `running` status — but the agent process is dead, the dtach session may or may not be alive, and from the user's point of view nothing is moving. The dashboard offers no obvious "restart" button. The user has to hunt down the task, expand the Ralph panel, click **Cancel loop**, dismiss the toast, then re-open the launch dialog and retry. Some users do not know to do this; they reboot, wipe `~/.kookr`, or `git checkout` over their worktree to make the conflict go away.

This is unacceptable. Crash-restart of an in-progress Ralph loop is the exact moment Kookr should help the user, not stand in their way.

### Two roots, one user-facing symptom

1. **Phantom-live session — dtach-master-killed shape.** A WSL or OS-level kill of the dtach master process leaves the socket file on disk but no holding process. After Kookr restarts, `isLiveRalphSession` (`src/server/ralph-loop-service.ts:607`) returns `true` for the dead session because nothing wrote a terminal flag, and `reconcileStartupLoops` "preserves" the loop. The user sees `running` even though no agent process exists.
2. **Phantom-live session — agent-child-exited shape.** A different shape: the agent process exited (cleanly or via SIGKILL) but the dtach master is still running and the session's terminal hooks never wrote a `Stop`. Move 1 does NOT catch this; the user-facing Replace flow handles it.
3. **Genuine same-key conflict.** Loop is actually running fine; the user (or a second tab) tries to launch the same playbook+cwd+params again.

All three reach the duplicate check in `findActiveLoopedPlaybook` (`src/server/use-cases/looped-playbook-launch.ts:187`), which rejects when `task.status ∈ {open, pending, inProgress}` AND `task.ralphLoop.status ∈ {running, paused}`. After a crash the task survives in `inProgress` and the loop is "preserved", so the check fires.

### What the user does today

- Dashboard → Ralph panel → Cancel loop. Buried two clicks deep; most users do not find it.
- `DELETE /api/tasks/:id/ralph-loop` via curl. Power user only.
- Set `KOOKR_AUTO_RELAUNCH=false` and restart again. Two restarts; not discoverable.
- Edit `~/.kookr/tasks.json` by hand. We do not want this on the support path.

## Goals

1. **The user can press Launch again and get a working loop**, in the same flow as the original launch, without learning anything new about Kookr internals.
2. **The user can recover the existing loop's context** if that is what they wanted (continue the agent's conversation rather than restart).
3. **No two agents in the same cwd at the same time.** When the user replaces a loop, the runtime process tied to the old loop is killed *before* the new launch starts.
4. **Don't accidentally restart a working loop.** A user who refreshes the dashboard and hits Launch must not silently lose progress on a healthy loop.
5. **Fix the most common root cause too.** A startup-only liveness probe in `reconcileStartupLoops` so dtach-master-killed phantoms are correctly marked `failed` automatically. The user-facing Replace flow stays as the escape hatch for the residual cases (agent-child-exited and genuine conflict).

## Non-Goals

- **Detecting agent-child-exited phantoms at startup.** Empirical validation showed `LocalDtachBackend.isAlive` only catches the dtach-master-killed shape. Catching the other shape would require capturing the agent PID in the dtach manifest at attach time. Tracked under Open Questions; the user-facing Replace flow handles this case in the meantime.
- **Resumption of conversation context across the Replace path.** The "Open the running loop" button is the path for users who want resume; Replace itself is restart-only.
- **Reworking the two state machines** (`task.status` vs `ralphLoop.status`). Deferred by `rfc-ralph-loop-redesign.md`.
- **Cross-host / cross-machine recovery.** Single-host only.
- **Operational tuning knobs.** No new env vars in this RFC. Rollback is `git revert`. (See Move 1 rollback discussion under Open Questions.)
- **Modifying the runtime hot-path liveness check.** Move 1 lives in `reconcileStartupLoops` only; the existing `findLiveSession` (used by the cycler at runtime) is not touched. Round-3 (`socratic-challenger`) flagged that adding a probe timeout to the shared helper would regress the cycler.

## Design

Three moves, one PR.

### Move 1 — Startup-only liveness probe (NEW helper, not a `findLiveSession` reuse)

Round-3 review (`failure-mode-analyst`, `socratic-challenger`) caught two problems with the v3 plan to reuse `findLiveSession`:

- **Hot-path regression.** `findLiveSession` is also called from `claimLatestLiveOwner` (`ralph-loop-service.ts:416`) and `catchUpFromLatestStop` (`ralph-loop-service.ts:444`) — runtime call sites, not just startup. Adding a per-probe timeout there could cause the cycler to misclassify a slow-but-alive session as dead during normal operation.
- **Sync syscall dodges Promise.race.** `LocalDtachBackend.isAlive` uses `existsSync(entry.sock)` + `process.kill(pid, 0)` — both synchronous. `Promise.race(probe, sleep(500))` does not interrupt a sync syscall; on a stuck WSL fuse path the event loop wedges for the kernel timeout.

v4 ships a new startup-only helper:

```ts
// New helper, exported from ralph-loop-service.ts (or a startup-recovery local).
// Used ONLY by reconcileStartupLoops. The runtime findLiveSession is unchanged.
async function probeStartupLiveness(
  task: Task,
  terminalBackend: TerminalBackend,
  timeoutMs = 500,
): Promise<SessionInfo | null> {
  const candidates = task.sessions.filter(isLiveRalphSession);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const s = candidates[i];
    const alive = await withTimeout(
      probeWithAsyncFs(terminalBackend, s.tmuxSession),
      timeoutMs,
      false, // on timeout, treat as dead
    );
    if (alive) return s;
  }
  return null;
}
```

Two implementation requirements:

1. **`probeWithAsyncFs`** wraps `terminalBackend.isAlive` in async-friendly fs primitives. The minimal change: replace `existsSync(entry.sock)` with `await fs.promises.access(entry.sock)` inside `LocalDtachBackend.isAlive` so the existing function becomes genuinely async-cancellable. `process.kill(pid, 0)` stays sync (it is fast and does not block on filesystem). This change to `LocalDtachBackend.isAlive` is one line; the existing tests still pass because they just test the boolean return.

2. **`withTimeout`** is a tiny utility that wraps a Promise with a Promise.race against a deferred timer; on timeout, returns the fallback value (here, `false`). Standard pattern; ~10 lines. If a similar utility already exists in `src/core/`, reuse it.

`reconcileStartupLoops` is the only consumer:

```ts
// in reconcileStartupLoops, replace the synchronous find with:
const liveSession = await probeStartupLiveness(task, this.deps.terminalBackend);
```

#### Probe coverage

- **Catches.** dtach master process dead, socket file may persist (the WSL/OS-crash phantom).
- **Does not catch.** dtach master alive, agent child dead. User reaches the Replace dialog instead.
- **Aborted-status precedence.** When `session.lastStatus === 'aborted'`, `isLiveRalphSession` already filters it out; the probe is not consulted.

#### Probe budget

- Per-probe timeout: 500ms hardcoded.
- Sequential per-task (existing reconcile is sequential). 50 stale tasks ≤25s, 5 ≤2.5s. Acceptable for startup.
- No new env var, no kill switch. Rollback is `git revert`. The probe touches one existing function call site (`reconcileStartupLoops`); reverting is one file. See Open Questions for the rollback discussion.

#### Rollback narrative — the v3 fallback was wrong

v3 claimed "if `terminalBackend` is not set, fall back to today's logic." Round-3 (`failure-mode-analyst`, `delivery-pragmatist`) showed `terminalBackend: TerminalBackend` is non-optional in `RalphLoopServiceDeps` (`ralph-loop-service.ts:48`) — that fallback path is unreachable in production. v4 drops the false reassurance. The genuine rollback story is `git revert`. If post-deploy telemetry shows mass false-positives on Move 1, an env-var hotfix follows; the env var is not designed in advance.

### Move 2 — `POST /api/tasks/:taskId/ralph-loop/replace-with-new` endpoint

Steps:

1. **Validate (route layer).** `taskId` exists; `task.status` not terminal; `task.ralphLoop` exists. 404/400 as appropriate.
2. **Key match.** Build the duplicate key from the request body and from the stored task. If they don't match, return 400 with `code: 'replacedTaskId_key_mismatch'`. Catches the user-edited-a-parameter-after-409 case.
3. **Acquire in-flight key.** `inFlightLoopedPlaybooks.add(key)` inside try/finally. If already in-flight, return 409 with `code: 'replace_already_in_progress'`.
4. **Cancel runtime + loop.** Call `cancelTaskLifecycle(replacedTaskId, ...)` — kills sessions, deregisters from monitor/watchdog, **and sets `task.status='cancelled'`** via `taskStore.cancelTask` (verified at `agent-lifecycle.ts:283`). Then `ralphLoopService.cancelLoop(task)` (idempotent; flips `loop.status='cancelled'`). The combined post-state on success is `task.status='cancelled' + loop.status='cancelled'`.
   - **No artificial timeout** wrapping `cancelTaskLifecycle`. Round-3 (`failure-mode-analyst`) showed a 5s wrapper produces partial-state on timeout: `stopAllLiveSessions` aborts sessions sequentially (`agent-lifecycle.ts:195-201`), so a partial-loop timeout leaves some `lastStatus='aborted'`, others not, and `taskStore.cancelTask` never runs. Better to let the operation complete; concurrent Replaces 409 cleanly while the in-flight key is held.
   - **If `cancelTaskLifecycle` throws**, abort: release the in-flight key, return 500 with `code: 'lifecycle_cancel_failed'`. Do not proceed to launch. Same reasoning — partial state from a launch over a partly-killed runtime is worse than asking the user to retry.
5. ~~Per-session `lastStatus='aborted'` write.~~ **Cut.** Round-3 (`failure-mode-analyst`) showed `cancelTaskLifecycle` already does this on the success path via `stopAllLiveSessions`. The v3 step was redundant on success and cosmetic on the abort path. The protection against future-reconcile re-claim comes from `cancelTaskLifecycle`, not from a separate write.
6. **Audit write.** Append `ralph_loop_replaced` to the interaction log with `{ replacedTaskId, oldIteration, newPlaybookPath, cwd, source, ts }`. Append a `replaced_by_user` row to the old task's `ralph-iterations.jsonl`. Best-effort (warn-log on failure; do not block).
7. **Launch.** Call `launchLoopedPlaybook` with the request body. The duplicate check now passes because `cancelled+cancelled` is excluded by both active-status sets.
8. **Release the in-flight key** in `finally`.
9. **Return 201** with the new task body.

#### Conflict-body shape (deploy-order safety)

Verified empirically in v4 prep: today's 409 body is `{ error: <msg>, taskId: <id> }` — `taskId` is **already at the top level** (the route handler spreads `err.details` into the body at `task-routes.ts:459`). v4 adds two fields, both additive; nothing existing is moved or renamed.

```json
{
  "error": "matching looped playbook task already exists",
  "taskId": "...",
  "conflictKind": "duplicate_active_loop",
  "ralphLoop": { "status": "running", "currentIteration": 4, "lastIterationStartedAt": 1714680000000 }
}
```

The frontend narrows on `body.conflictKind === 'duplicate_active_loop'` to show the Replace dialog. An old frontend on a new backend ignores the new fields. A new frontend on an old backend sees no `conflictKind` and falls through to the existing generic toast. **Either deploy order is safe.** No breaking change.

### Move 3 — UI: confirm dialog with two actions

Frontend behavior on receiving a 409 with `conflictKind === 'duplicate_active_loop'`:

> **A loop is already running for this playbook.**
>
> Task `<short-id>`, iteration `<N>`. Last iteration started `<relative-time>`.
>
> [ Replace it (start fresh) ] [ Open the running loop ]
>
> *Replace it (start fresh)* — stops the old agent and starts a new one with the same prompt. The agent's previous conversation is not carried over. Recommended after a crash if the old loop hasn't been making progress.
>
> *Open the running loop* — takes you to the existing task. Use this if the loop is still working and you want to attach.

The relative-time hint uses `lastIterationStartedAt` from the conflict body. Round-3 (`socratic-challenger`) noted that the same string ("loop never completed an iteration") fires for both crash AND fresh-genuine-conflict. v4 drops the special string; the dialog just shows raw "iteration N, last started <relative-time>" and lets the user judge. For iteration 0 with `lastIterationStartedAt === 0`, the dialog shows "iteration 0 (not yet started)" — neutral wording that doesn't presume crash.

#### Caveat for the agent-child-exited case (round-3 `socratic-challenger` Q5)

If the user clicks "Open the running loop" on a phantom that Move 1 missed (agent-child-exited), they land on the task detail panel and see a Ralph iteration log with no recent activity. The panel surfaces this honestly — iteration count is stale, no recent diffs — so the user can choose Cancel loop from there. The label is not a lie ("Open the running loop"); it takes them to what Kookr believes is the running loop. The user discovers reality and recovers. This is the intentional residual UX after Move 1's narrowing.

### Audit events

One new event: `ralph_loop_replaced`. The user-initiated Cancel-button path keeps no event today; that is a separate change if wanted.

### New iteration-log exit reason

`replaced_by_user` joins the exit-reason union in `src/shared/contracts/ralph-iteration-log.ts`. The runtime parser in `core/ralph-iteration-log.ts:86` strict-validates and silently drops unknown values today, which is a forward-compat hazard.

Fix: `parseIterationRecord` maps unknown exit reasons to a fallback `'unknown'` value (one new enum entry, one one-line change). Old readers on new logs no longer drop rows.

**Telemetry note (round-3 `failure-mode-analyst` Q6):** today's parser increments `malformedLines` when an exit reason is unknown. After the fallback, those rows parse successfully and `malformedLines` no longer counts them. This is a small telemetry shift — operators monitoring `malformedLines` for forward-compat alerts will see the metric drop slightly. Acceptable; the dropped rows were silent data loss anyway. Note in the release notes.

## Files to change

- `src/server/ralph-loop-service.ts` — add `probeStartupLiveness` helper. `reconcileStartupLoops` calls it instead of `task.sessions.find(isLiveRalphSession)`. The runtime `findLiveSession` is **not** modified.
- `src/adapters/local-dtach-backend.ts` — `isAlive` switches `existsSync` to `await fs.promises.access(...).then(() => true).catch(() => false)`. The function is already declared `async`; no signature change.
- `src/server/use-cases/looped-playbook-launch.ts` — extend the 409 body details with `conflictKind`, `ralphLoop.{status, currentIteration, lastIterationStartedAt}`. Regression test asserting `cancelled+cancelled` is excluded.
- `src/server/routes/task-routes.ts` — register `POST /api/tasks/:taskId/ralph-loop/replace-with-new`. Handler composes `cancelTaskLifecycle` + `ralphLoopService.cancelLoop` + audit + `launchLoopedPlaybook`. No artificial timeout around lifecycle cancel.
- `src/server/routes/task-routes.test.ts` — concurrent replace 409, lifecycle-failure 500-with-no-launch, key-mismatch 400.
- `src/server/ralph-loop-service.test.ts` — `probeStartupLiveness` returns null when probe times out; null when probe rejects; the alive session when probe resolves true.
- `src/server/ralph-startup-reconcile.test.ts` — existing tests get explicit `FakeTerminalBackend.isAlive` returns now that the probe runs through the backend. `withTimeout` is exercised via a fake that delays its resolution longer than the timeout.
- `src/core/interaction-log.ts` — extend `InteractionEvent` union with `ralph_loop_replaced`.
- `src/shared/contracts/ralph-iteration-log.ts` — add `replaced_by_user` and `unknown` to the exit-reason union.
- `src/core/ralph-iteration-log.ts` — `parseIterationRecord` maps unknown exit reasons to `'unknown'` instead of returning null; existing strict-validation tests updated.
- `src/frontend/components/PlaybookBrowser.tsx` — narrow on `conflictKind`, render inline confirm with two actions.
- `src/frontend/components/PlaybookBrowser.test.tsx` — fold new tests into the existing suite.
- `docs/architecture.md` — short note on Replace + on the liveness probe's coverage limit.
- `docs/features.md` — add a line under the Ralph feature.

Estimated diff: ~350 lines. Same as v3.

## Edge cases

- **Crash during Replace, between cancel and launch.** Old task is `cancelled`. New task does not exist. User opens dialog, normal Launch succeeds.
- **`cancelTaskLifecycle` throws or hangs.** Throws → abort, no launch, user retries. Hangs → in-flight key held; concurrent Replace 409s; user can wait or kill the server. Genuine pathology; not specifically defended against in this RFC.
- **Old task already deleted between dialog open and click.** Validation 404. Frontend retries the original Launch.
- **User edits a parameter after the 409.** Key mismatch → 400 with `code: 'replacedTaskId_key_mismatch'`. Frontend shows "the parameters you edited no longer match the conflicting task — try Launch again."
- **`reconcileStartupLoops` probe times out (500ms).** Treat as dead, mark loop `failed` with `kookr_crash`.
- **WSL fuse path is wedged.** Async `fs.promises.access` respects the timeout (unlike sync `existsSync`). The probe returns false for that session, the loop gets `failed` instead of wedging startup. Acceptable.
- **Two Replace calls, same `replacedTaskId`, near-simultaneous.** First wins the in-flight key; second 409s with `code: 'replace_already_in_progress'`.
- **Replace targets a `paused` loop.** `cancelLoop` handles paused.
- **Phantom agent-child-exited reaches the dialog.** User sees the conflict dialog (Move 3); clicks Replace. Replace works (cancelTaskLifecycle is idempotent on already-dead sessions).
- **Old reader on new log.** `replaced_by_user` accepted as `unknown` (forward-compat fallback). No malformed-lines spike.
- **New frontend on old backend.** Conflict body has no `conflictKind`; frontend treats as the existing generic 409 and falls through.
- **Future RFC adds another `conflictKind` value** (round-3 `socratic-challenger` Q6). The frontend narrows on exact string match; an unknown `conflictKind` falls through to the existing generic toast. This is the intended forward-compat: the dialog is opt-in per kind. A future RFC can opt-in its own kind by name.

## Alternatives considered

### A. Sequential frontend `DELETE` + `POST`

Rejected: race conditions, lifecycle kill needs to be synchronous with cancel for Goal 3, idempotency belongs at the endpoint.

### B. Auto-replace on duplicate detection (no dialog)

Rejected: silently destroys a healthy loop in the genuine-conflict case (Goal 4).

### C. Liveness probe only, no Replace endpoint

Rejected: probe doesn't catch all phantom shapes (empirically validated); genuine same-key conflict still needs a UX. The probe ships *with* the dialog.

### D. Resume the agent's conversation in the new task

Rejected: changes Replace from "start over" to "branch", a different feature.

### E. Probe both dtach master and agent child PIDs

Considered. Requires persisting agent PID alongside the dtach manifest. Not adopted in this RFC because (a) PID is not currently captured, (b) the change has its own risks, (c) the agent-child-exited shape is a residual case for the user who reported the dtach-master-killed shape. Tracked as Open Question 1.

### F. Defer Move 1 entirely; ship only Move 2 + Move 3

Considered after round-3. The Replace dialog handles all phantom shapes uniformly, so the probe is not strictly necessary for the user's reported scenario — they would just see the dialog instead of an automatic recovery. Rejected because:
- The probe is small (one new helper, one async fs change, ~80 lines).
- The probe converts the user's reported scenario from "dialog every time" to "no dialog ever" for the dominant shape.
- Empirical validation already done; not deferring is not free, but not shipping is not free either (the user keeps clicking Replace forever for the WSL-crash case).

The probe is load-bearing for UX simplicity even if not strictly necessary for correctness. Goal 5 stands.

### G. Extract a runtime-safe shared probe helper used by both startup and runtime call sites

Considered after round-3 `socratic-challenger` Q1. Rejected: the runtime `findLiveSession` runs on the cycler hot path and a 500ms timeout there could change cycler behavior. Keeping the startup probe separate avoids coupling startup correctness to runtime perf.

## Critic feedback incorporated

### Round 1
- **`boundary-critic`** — task-scoped endpoint URL; orchestration in route layer.
- **`failure-mode-analyst`** — synchronous lifecycle kill; in-flight key with try/finally; audit; key-mismatch 400.
- **`design-minimalist`** — dropped disabled "Keep both"; cut `protocol.ts` change; folded tests into existing suite.
- **`socratic-challenger`** — Replace / Open running buttons; both restart and resume paths surfaced; honest "last iteration" hint.
- **`operability-reviewer`** — `ralph_loop_replaced` event; `replaced_by_user` exit reason; warn-logs on orphan paths.
- **`ambition-amplifier`** — phantom-live-session as a primary fix (Move 1 added).

### Round 2 + empirical
- **`design-experimenter` (empirical)** — `LocalDtachBackend.isAlive` validated. Catches dtach-master-killed; does NOT catch agent-child-exited. Move 1 narrowed; Open Question 1 created.
- **`state-machine-verifier`** — corrected post-Replace state to `cancelled+cancelled`; `isActiveLoopState` predicate dropped; reuse existing `findLiveSession`. (The reuse decision was reversed in round 3 — see below.) Per-session `lastStatus='aborted'` write added. (That step was also cut in round 3.)
- **`failure-mode-analyst` (round 2)** — per-stage timeouts; lifecycle-throws resolved as ABORT; forward-compat fallback.
- **`design-minimalist` (round 2)** — cut kill switch, idempotency TTL env var, redundant `ralph_loop_cancelled` event, `isActiveLoopState` predicate.
- **`delivery-pragmatist`** — `conflictKind` discriminator for deploy-order safety; FakeTerminalBackend stub requirement noted.

### Round 3
- **`failure-mode-analyst` (round 3)** — Three blockers resolved: (a) the `terminalBackend`-not-set fallback was dead code; v4 drops the false claim, rollback is git revert. (b) `existsSync` blocks Promise.race; v4 makes `isAlive` use async `fs.promises.access`. (c) v3 step 5 (per-session aborted write) was redundant with `cancelTaskLifecycle`; v4 cuts it. (d) The conflict body shape was not actually broken — empirical check showed `taskId` is already top-level (route spreads `err.details`), so adding `conflictKind` is non-breaking. Telemetry note on `malformedLines` regression added.
- **`delivery-pragmatist` (round 3)** — `terminalBackend` optional-vs-required ambiguity resolved (v4 drops the fallback narrative entirely; type stays required). 5s lifecycle timeout cut (the partial-state-on-timeout was worse than the in-flight hold).
- **`socratic-challenger` (round 3)** — Move 1 reuse-vs-separate-helper resolved as separate (runtime hot-path safety). Misleading "loop never completed an iteration" string dropped. Caveat for the "Open the running loop" button on agent-child-exited phantoms documented honestly. Alternative F (defer Move 1 entirely) considered and rejected with reasoning.

### Adversarial-pair resolution

`design-minimalist` (rounds 1 and 2) repeatedly argued for cutting Move 1 from this RFC. `ambition-amplifier` (round 1) argued for keeping it. The author sided with `ambition-amplifier` after round 1 because the empirical validation showed Move 1's WSL-crash coverage works and is small. The author sided with `design-minimalist` on every operability-theater item (kill switch, TTL env var, predicate, redundant event, fallback narrative). v4's net is that Move 1 keeps the substantive improvement, and Move 2+3 keep the user-facing fix; everything ornamental was cut.

## Open Questions

1. **Probe the agent child PID, not just the dtach master.** Requires `LocalDtachBackend` to capture the agent PID at attach time. Catches the agent-child-exited phantom. Follow-up RFC.
2. **Should the new endpoint also delete the old task?** Default: leave it.
3. **Probe rollback story — env var or git revert.** v4 chooses `git revert` on the grounds that Move 1 is small and well-tested. If post-deploy telemetry shows mass false-positive `failed` marks (operator can see this in `[ralph-recovery] Examined N running loop(s): 0 preserved, N failed.` log lines), a follow-up hotfix adds `KOOKR_LIVENESS_PROBE_DISABLED`. Designing the env var in advance is YAGNI.
