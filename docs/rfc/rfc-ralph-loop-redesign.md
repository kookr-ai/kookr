# RFC: Ralph Loop Redesign

**Status:** Draft (v4 — post-round-3 review, presented for user review)
**Date:** 2026-05-06
**Author:** Jean Ibarz (with Claude)

(See git history for v1, v2, v3 and the round-by-round critic record.)

---

## Problem

The Ralph loop concept works: re-inject a fixed prompt into a fresh agent runtime after every Stop, until a predicate or cap fires. The current implementation does not — at least, it has not survived production use without a steady drip of structural bugs and confusing UX surprises.

Today (2026-05-06) alone, in a single session, we shipped two fixes for the same end-to-end behaviour ("does iteration 2 actually fire after iteration 1 stops?") and discovered a third UX issue:

| | Class |
|---|---|
| **PR #61** — `pollUntilExists` dropped `replayExisting`, silently lost SessionStart, owner refs stayed null, every Stop was rejected upstream by `isStopFromMainTaskSession`, loop frozen at iteration 0. | Race in hook ingestion, brittle three-way owner-ref matching. |
| **PR #64** — `event-pipeline.ts`'s two `new RalphLoopService({…})` constructions in the Stop hot path didn't pass `launchFreshTaskSession`. Optional-typed dep, runtime guard, stderr-only failure, loop transitions to `failed`. | Multiple instantiation sites with diverging deps; defensive optional deps that the compiler can't enforce. |
| **`completeTask` UX** — clicking "mark complete" on the dashboard for a Ralph-loop task killed every session of every iteration including the one currently working. The loop record stayed `running` while `task.status` became `completed` (contradictory snapshot). | Two state machines on one entity; UX dispatcher unaware of the loop layer. |

These share the same shape: **the loop's behaviour is encoded across many surfaces, so any one of them can drift and the failure mode is silent.** Iteration N+1 simply doesn't start, and the only signal is a stderr line a user never reads.

The architecture problems we're fixing in this RFC:

- **Three-way owner-ref matching.** `isStopFromMainTaskSession` requires `loop.ownerSessionId === terminalSessionId && loop.ownerRuntimeSessionId === event.sessionId && loop.ownerTranscriptPath === event.transcriptPath`. Each ref has its own race-prone propagation path. PR #61 fixed one; the other two are dead weight that bought us a regression.
- **Optional deps with runtime defensive checks.** `RalphLoopServiceDeps.launchFreshTaskSession?` is typed optional but required in practice. PRs that touch the wiring at one of the four call sites forget the others. The compiler is silent.
- **`completeTask` doesn't know about Ralph loops.** The dashboard's "mark complete" goes through the lifecycle layer; the lifecycle layer's `completeTask` calls `stopAllLiveSessions` which kills every iteration's session. The dispatcher (the WS handler that receives the user's intent) is the natural place to compose loop-aware behaviour, but today's code routes through the unaware lifecycle layer first.

The architecture problems this RFC explicitly **defers**:

- **Two state machines on one entity** (`task.status` vs `task.ralphLoop.status`). Round-2 review (`design-minimalist`) showed collapsing them touches 34 non-test sites across 8 files. Correctness-neutral relative to the three production bug classes. Worth a follow-up RFC; tracked here as Open Question.

## Goals

1. **Make the three bug classes structurally impossible.** Both bugs we shipped today, plus the UX collision, must be unrepresentable in the new model — the compiler enforces it where possible.
2. **One PR, ~250 lines.** Round-2 (`design-minimalist`, `socratic-challenger`) was firm that the original three-move bundle was over-scoped. v4 ships only the two correctness moves; the cleanup move is deferred.
3. **Don't break in-flight loops.** No flag day, no migration utility, no need to drain existing work before deploy. Removed fields are optional and ignored after deploy.

## Non-Goals

- New looping primitives (sub-loops, fan-out, agent voting). Out of scope.
- Replacing the agent runtime contract. Stop hooks remain the iteration-boundary signal.
- Distributed Ralph (multi-host loops). Single-host only.
- Reworking playbook *content*. Out of scope; covered by RFC `rfc-implement-github-issue-batch-mode.md`.
- **Hook-ingestion consolidation.** Round-1 (`ambition-amplifier`) flagged this as a deferred-but-uncomfortable item. Genuinely out of scope.
- **Per-iteration timeout / tool-call cap enforcement.** Not load-bearing for the three bug classes.
- **Iterations as first-class child-task entities.** Round-1 (`design-minimalist`, `socratic-challenger`) argued — and rounds 2-3 reinforced — that this is an entity-model rewrite. Empirically: `grep parentTaskId src/frontend/` returns zero hits.
- **`task.status` / `loop.status` collapse.** Round-2 (`design-minimalist`) showed surface area exceeds 34 sites. Defer to a follow-up RFC.
- **Codex adapter changes for symmetry.** Round-3 (`design-minimalist`) called this speculative — Codex Ralph loops aren't a code path that exists. Add when needed.

## Design philosophy

Two structural moves.

### Move 1 — Singleton orchestration, required deps, no holders

Today: `RalphLoopService` is constructed in four places, each passing a different subset of optional deps. Three of those four constructions did not pass `launchFreshTaskSession` until PR #64; the fourth (`startup-recovery.ts`) doesn't need it (different code path) so the asymmetry was correct only by accident.

Proposed:

1. Construct `RalphLoopService` **once at bootstrap**, in `index.ts`, after `launchServiceDeps` is built.
2. Pass the singleton into every consumer that needs it: `wireEventPipeline` (Stop hot path), task-routes module (attach/cancel/inspect — `task-routes.ts:42` currently constructs its own; replace with the injected singleton), and `runStartupRecoveryPhase` (`reconcileStartupLoops`).
3. **Make all production deps required** at the constructor, not optional. The compiler enforces "every call site has the launcher".
4. Methods that don't use a particular dep keep working — the dep is available to them, they simply don't reach for it. Round-1 / round-3: rejected as overengineering.

Why: PR #64's bug class becomes unrepresentable; the holder shim goes away; tests still construct their own instances per-test (the singleton is a runtime convention, not a class-level enforcement).

### Move 2 — One owner ref, by deletion + correct write order

Today: `isStopFromMainTaskSession` requires three independent references to match. Each has its own propagation path; PR #61's fix was for one of them.

Two parts. Round-2 (`failure-mode-analyst`) caught that v2 had inverted the data flow claim — it asserted ownerSessionId was set before the agent spawn, when in fact it is set *after*. Both parts ship together; Part A alone would narrow the race but not close it.

#### Part A: keep only `loop.ownerSessionId`

Delete `loop.ownerRuntimeSessionId` and `loop.ownerTranscriptPath`. Match Stop events on the terminal session id only:

```ts
// New (~6 lines, 1 comparison)
if (!loop.ownerSessionId || terminalSessionId !== loop.ownerSessionId) return false;
const session = task.sessions.find(s => s.tmuxSession === terminalSessionId);
if (!session) return false;
return true;
```

Why this is enough on the happy path: the cycler creates a new terminal session (a new `kookr-XXXX`) on every fresh-runtime launch via `claudeCodeAdapter.launch`. Terminal session ids are unique per iteration. The runtime-session-id and transcript-path refs were defensive against "what if the runtime restarts in place inside the same dtach session?" — the single-host Ralph cycler does not do this.

Acknowledged false-accept widening: removing the runtime-session-id comparison means manual `claude --resume <other-session>` invocations attached to a Ralph dtach (rare; user-initiated) will be accepted as iteration boundaries. Documented in Edge Cases. Round-3 also flagged subagent-Stop, in-place runtime restart, and dtach name collision — verified against the parser: `SubagentStop` maps to `subagent_stop` (different event type, doesn't fire the cycler), `/clear` and `/compact` don't end the turn (no Stop fires), 8-hex-char UUIDs make collision astronomically improbable. None of those three are actual regressions.

#### Part B: write `ownerSessionId` BEFORE the agent process spawns

Today's `launchFreshRuntime` (`src/server/ralph-loop-service.ts:536-548`):

```ts
const newSessionId = await this.deps.launchFreshTaskSession(task, prompt);  // ← spawns agent
const newSession = currentTask.sessions.find(s => s.tmuxSession === newSessionId);
claimRalphLoopOwner(currentTask, newSession, { allowTransfer: true });        // ← sets ownerSessionId
```

The `await` on line 1 spawns the agent and returns *after* the agent process is alive. The agent CAN emit Stop in the gap between line 1 returning and line 3 executing. Stop hits `isStopFromMainTaskSession`, sees the *old* `ownerSessionId`, returns false, Stop is silently dropped — same shape as PR #61, different field.

Fix: pre-allocate the new tmux name and write `loop.ownerSessionId` synchronously, before the spawn. Round-3 (`design-minimalist`) was right that introducing a `setRalphOwner` store method to wrap a single field assignment was overengineering. The cleanup is direct:

```ts
private async launchFreshRuntime(task: Task, prompt: string): Promise<string> {
  const newTmuxName = `kookr-${randomUUID().slice(0, 8)}`;

  // Write the owner ref BEFORE the spawn. There is no async boundary here,
  // so any Stop event from the new agent — which can only fire after the
  // spawn — will see the up-to-date ownerSessionId.
  task.ralphLoop!.ownerSessionId = newTmuxName;

  try {
    await this.deps.launchFreshTaskSession(task, prompt, { tmuxName: newTmuxName });
  } catch (err) {
    // Spawn failed: the owner ref now points at a session that doesn't
    // exist. Roll it back and let the catch in handleStopFingerprint
    // mark the loop failed as today.
    if (task.ralphLoop?.ownerSessionId === newTmuxName) {
      delete task.ralphLoop.ownerSessionId;
    }
    throw err;
  }

  // Re-check after the await. If cancelLoop fired during the spawn (e.g.
  // user clicked "complete" while the agent was booting), kill the
  // newly-spawned session and bail.
  const liveLoop = this.deps.taskStore.getTask(task.id)?.ralphLoop;
  if (!liveLoop || liveLoop.status !== 'running') {
    await this.deps.terminalBackend?.killSession(newTmuxName).catch(() => undefined);
    delete task.ralphLoop?.ownerSessionId;
    throw new RalphLaunchInterruptedError(`loop status changed during launch (now ${liveLoop?.status ?? 'gone'})`);
  }

  return newTmuxName;
}
```

Three concrete changes from today's code:

1. `claudeCodeAdapter.launch` accepts an optional `{ tmuxName }` in `AdapterLaunchOptions`. If supplied, the adapter uses it instead of generating one. Default behaviour for non-Ralph callers (`launchTask` for first iteration, resume) is unchanged. Round-3 (`boundary-critic`) raised that this leaks a cycler-specific concern into a shared interface; the alternative (`reserveSessionName()` method on the adapter) costs the same surface and pushes the name-format coupling elsewhere. We accept the optional parameter and document the constraint in the adapter's JSDoc. (Codex stayed untouched in this redesign; issue #1366 later extended `tmuxName` — and the rest of the `AdapterLaunchOptions` contract, `extraEnv`/`bypassPermissions` — to the Codex and Grok adapters so the contract is honored uniformly. See `src/adapters/adapter-launch-options-contract.test.ts`.)
2. The owner ref is written synchronously, before the spawn. No new store method.
3. A spawn-failure rollback and a post-spawn re-check are added (round-3 `failure-mode-analyst` findings).

### Move 3 — `completeTask` UX fix at the route layer

Today: clicking "mark complete" sends a `completeTask` WS message; `ws-handlers/lifecycle-handler.ts` (the actual dispatcher per round-3 verification) calls `completeTask` from `agent-lifecycle.ts:207`, which calls `stopAllLiveSessions` — killing every iteration session.

Round-2 (`boundary-critic`) flagged that adding `ralphLoopService` to `LifecycleDeps` reintroduces the optional-dep pattern this RFC fights. The dispatcher already has the singleton (per Move 1). The dispatcher is the right place to compose loop-aware behaviour.

Proposed: in the WS lifecycle handler:

```ts
case 'completeTask': {
  const task = taskStore.getTask(msg.taskId);
  if (task?.ralphLoop && (task.ralphLoop.status === 'running' || task.ralphLoop.status === 'paused')) {
    ralphLoopService.cancelLoop(task);    // existing method
  }
  await completeTask(msg.taskId, lifecycleDeps);   // unchanged
  // ... existing broadcast/feedback logic
}
```

`cancelLoop` is already exposed and externally called (`task-routes.ts:304`). The dispatcher already receives `ralphLoopService`. No new dep on `LifecycleDeps`. No optional `?.` chain in the lifecycle helper.

Round-3 (`boundary-critic`) confirmed there is no REST `completeTask` route; the WS handler is the only dispatch path, so the guard does not need to be duplicated.

UX consequence: the user's "mark complete" intent is honored — the loop stops launching new iterations, then the existing `completeTask` flow runs `stopAllLiveSessions` which kills the currently-live iteration. Combined with Move 2 Part B's post-spawn re-check, an iteration that was mid-launch when the user clicked complete is also killed before it can become orphan.

## Design

### Stop event acceptance — re-check sufficiency

Round-3 (`failure-mode-analyst`) noted the v3 re-check `if (liveLoop.status !== 'running') return;` between `await ralphCycler.handleStop(...)` and `await this.launchFreshRuntime(...)` is necessary but not quite sufficient. A second, different-fingerprint Stop arriving via `catchUpFromLatestStop` (called from `resumeLoop`) could overwrite `handlingStopFingerprint` while Stop A is mid-await — both proceed, cycler advances twice for one logical iteration.

Fix: the re-check verifies fingerprint equality too:

```ts
const action = await this.deps.ralphCycler.handleStop(this.deps.taskStore, {...});
const liveLoop = this.deps.taskStore.getTask(task.id)?.ralphLoop;
if (
  !liveLoop ||
  liveLoop.status !== 'running' ||
  liveLoop.handlingStopFingerprint !== stopFingerprint   // ← new
) return;
if (action.kind === 'launch_fresh') {
  await this.launchFreshRuntime(actionTask, action.text);
}
```

Three lines of conditions, plus matching cleanup in the existing catch (lines 486–499 already write `lastHandledStopFingerprint = stopFingerprint` on success and on the catch path).

### Data model

```ts
// Old
interface RalphLoopState {
  // ... unchanged fields ...
  ownerSessionId?: string;
  ownerRuntimeSessionId?: string;     // ← removed
  ownerTranscriptPath?: string;       // ← removed
  // ... rest unchanged ...
}

// New
interface RalphLoopState {
  // ... unchanged fields ...
  ownerSessionId?: string;
  // ... rest unchanged ...
}
```

Two field deletions. Both deleted owner refs were optional, so removal is type-narrowing without deserialization concerns. No new fields.

### Wiring

`index.ts`, in bootstrap order:

```ts
// ... taskStore, monitor, watchdog, hookWatcher, githubScanner, autoNameTask all built ...
// ... lifecycleDeps, getMaxActiveTasks, launchServiceDeps built ...

// Singleton, all deps required.
const ralphLoopService = new RalphLoopService({
  taskStore, monitor, serverCwd, broadcastToAll,
  ralphCycler, terminalBackend, tokenTracker, interactionLog,
  launchFreshTaskSession: (task, prompt, opts) => launchFreshTaskSession(launchServiceDeps, task, prompt, opts),
  completeTask: (taskId) => completeTask(taskId, lifecycleDeps),
});

wireEventPipeline({ ..., ralphLoopService });
registerTaskRoutes({ ..., ralphLoopService });
runStartupRecoveryPhase({ ..., ralphLoopService });
```

Three call sites, one constructor, no holders, no optional deps. `task-routes.ts:42` (currently constructs its own `RalphLoopService`) is updated to receive the singleton from deps.

## Files to change

One PR, ~250 lines diff (±50). Estimate is grounded per-file rather than eyeballed:

| File | Approx diff | What changes |
|---|---|---|
| `src/server/index.ts` | ~25 lines | Single `RalphLoopService` instantiation; pass singleton to 3 call sites; remove the launchFreshTaskSession holder shim. |
| `src/server/ralph-loop-service.ts` | ~50 lines | Drop `?` on every constructor dep; rewrite `launchFreshRuntime` (pre-allocate tmuxName, sync owner write, post-spawn re-check, spawn-failure rollback); add fingerprint equality to the inter-await re-check in `handleStopFingerprint`. |
| `src/server/event-pipeline.ts` | ~30 lines | Accept singleton from deps; drop two `new RalphLoopService(...)` constructions; drop the holder shim. |
| `src/server/routes/task-routes.ts` | ~15 lines | Accept singleton from deps instead of constructing it locally (line 42). |
| `src/server/startup-recovery.ts` | ~5 lines | Accept singleton from deps. |
| `src/server/ws-handlers/lifecycle-handler.ts` | ~10 lines | `case 'completeTask'`: call `ralphLoopService.cancelLoop` first when the task has an active loop. |
| `src/server/ralph-stop.ts` | ~20 lines | Drop two ref comparisons. |
| `src/shared/contracts/ralph.ts` | ~5 lines | Remove `ownerRuntimeSessionId`, `ownerTranscriptPath` from `RalphLoopState`. |
| `src/core/tasks.ts` | ~15 lines | `claimRalphLoopOwner` simplified to one field assignment; signature unchanged. |
| `src/adapters/claude-code-adapter.ts` | ~10 lines | `launch` accepts optional `tmuxName` in `AdapterLaunchOptions`; default to existing behaviour when omitted; JSDoc documents the cycler-only constraint. |
| `src/adapters/agent-adapter.ts` | ~5 lines | `AdapterLaunchOptions.tmuxName?: string` added. |
| `src/server/launch-service.ts` | ~5 lines | Plumb `tmuxName` option through `launchFreshTaskSession`. |
| Tests | ~50-70 lines | 7 test files reference removed fields (round-2 grep): `ralph-stop.test.ts`, `hook-watcher.test.ts`, `ralph-startup-reconcile.test.ts`, `ralph-loop-service.test.ts`, `event-pipeline.test.ts`, `tasks.test.ts`. `ralph-stop.test.ts` exists *because of* PR #61 — its assertions need to be ported to the new one-ref check, not deleted, so the regression coverage isn't lost. |

If the diff grows past ~400 lines, pause and update the document.

## Edge cases

- **Loop in flight at deploy.** Deleted owner refs are optional. Existing in-memory loop records that have them set will simply have them ignored. No flag day, no migration utility.
- **Crash between sync `ownerSessionId` write and async spawn.** Recovery's `reconcileStartupLoops` sees a loop with an `ownerSessionId` whose dtach socket is dead, marks the loop `failed` with `kookr_crash` audit. Same behaviour as today.
- **Spawn fails after `ownerSessionId` set.** The catch in `launchFreshRuntime` rolls back `ownerSessionId` (sets to undefined) and re-throws. `handleStopFingerprint`'s existing catch (lines 492–500) marks the loop `failed`. The rollback prevents the failure mode round-3 (`failure-mode-analyst`) flagged: `ownerSessionId` pointing at a session that never registered.
- **User clicks "complete" mid-cycler-advance.** Two layers of protection: (a) the re-check between `ralphCycler.handleStop` and `launchFreshRuntime` checks status + fingerprint equality; (b) `launchFreshRuntime`'s post-spawn re-check kills a just-spawned session if `cancelLoop` fired during the spawn. Combined: no orphan iteration N+1.
- **A Stop arrives from a stale terminal session.** The check `loop.ownerSessionId === terminalSessionId` rejects the stale Stop. Stale dtach session is cleaned up by the existing watchdog/reconcile path.
- **Manual `claude --resume` against a Ralph dtach session.** The Stop is accepted as an iteration boundary. Accepted trade-off; documented. Removing the runtime-session-id ref to defend against developer self-injury would re-introduce the PR #61 race in the field this RFC is trying to delete.
- **Subagent Stop events.** Verified harmless: `SubagentStop` maps to `subagent_stop` in the parser (`hook-parser.ts:185-187`), and the cycler only reacts to `stop` / `stop_failure` events (`event-pipeline.ts:192, 229`). Subagent completion does not trigger the cycler.
- **`/clear` or `/compact` inside the agent's runtime.** Don't end the turn, no Stop fires, no false accept.
- **Dtach name collision.** 8-hex-char random UUIDs (~4B options); birthday collision at √4B ≈ 65k concurrent sessions on the same host. Astronomically improbable; not a realistic regression.

## Critic feedback incorporated

Round 1 ran 5 critics in parallel: `boundary-critic`, `failure-mode-analyst`, `design-minimalist`, `ambition-amplifier`, `socratic-challenger`. Round 2 ran 3 (`failure-mode-analyst`, `design-minimalist`, `boundary-critic`). Round 3 ran the same 3 to verify v3's revisions held.

**v1 → v2** (ambition-amplifier ↔ design-minimalist adversarial pair, sided with design-minimalist):
- Cut iterations-as-first-class-child-tasks and the four-phase migration. Empirically falsified the "dashboard already handles parentTaskId" claim.

**v2 → v3:**
- **Move 1 (`loop.status` → `task.status` collapse) deferred** to a follow-up RFC. Round-2 `design-minimalist` showed it touches 34 non-test sites across 8 files; v2's file list was incomplete; the collapse loses the `failed`/`terminated` semantic distinction.
- **Race ordering corrected.** v2's claim was inverted relative to actual code.
- **`completeTask` guard moved from `agent-lifecycle.ts` to the route dispatcher.** Round-2 `boundary-critic`.
- **New false-accept cases acknowledged** (manual `claude --resume`).

**v3 → v4:**
- **`setRalphOwner` store method dropped** (round-3 `design-minimalist`). Replaced with a direct one-line field write in `launchFreshRuntime`. Two writers to `loop.ownerSessionId` (round-3 `boundary-critic`'s concern) collapse to one.
- **Codex adapter row removed from file table** (round-3 `design-minimalist`). Speculative until a Codex-Ralph code path exists.
- **REST equivalent caveat removed** (round-3 `boundary-critic`). Verified: no REST `completeTask` route.
- **Re-check fingerprint equality added** (round-3 `failure-mode-analyst`). The v3 status-only re-check missed the `catchUpFromLatestStop`-via-`resumeLoop` interleaving.
- **Post-spawn re-check + spawn-failure rollback added in `launchFreshRuntime`** (round-3 `failure-mode-analyst`). Closes the cancelLoop-during-spawn race and the dangling-ownerSessionId-after-throw case.
- **Subagent / `/clear` / dtach-collision false-accept findings evaluated and rejected** with parser evidence; documented in Edge Cases so the trail is preserved.
- **Adapter API decision recorded** (round-3 `boundary-critic`'s `reserveSessionName()` alternative). Accepted optional `tmuxName` parameter on `AdapterLaunchOptions` with JSDoc constraint; documented why the alternative wasn't chosen.

**Round-2 → round-3 invocation log:**
- `ambition-amplifier` not invoked rounds 2-3: round-1 findings were addressed in v2 and then mooted by v3's deferral of Move 1. Further ambition probing would have been diminishing returns.
- `assumption-archaeologist` not invoked: this RFC does not propose changes to behaviour originally justified by an ADR.

**Empirical validation checkpoints (mandatory between rounds):**
- Between R1 and R2: verified zero frontend references to `parentTaskId`; verified `claimRalphLoopOwner` has 6 call sites.
- Between R2 and R3: verified `launchFreshRuntime` calls `claimRalphLoopOwner` *after* the await spawn (not before, as v2 claimed); verified `completeTask` WS dispatcher location.
- Between R3 and v4: verified `SubagentStop` is a separate event type (`subagent_stop`) that doesn't fire the cycler — falsifying round-3's (e) finding before incorporation.

**Adversarial pair resolution.** `ambition-amplifier` and `design-minimalist` disagreed on whether Move 1 (loop.status collapse) and the agent-overshoots-one-unit-of-work problem belonged in this RFC. Sided with `design-minimalist` on both: Move 1 deferred to a follow-up RFC; per-iteration enforcement out of scope. The dimension we agreed with `design-minimalist` on was scope tightness — if we had picked `ambition-amplifier`'s framing this RFC would have been a 4-PR migration without the bugs being demonstrably closed sooner.

## Open Questions

- **Follow-up RFC for `loop.status` / `task.status` collapse.** Defer until production fixes from this RFC have soaked. Tracked here so it isn't forgotten.
- **`AdapterLaunchOptions.tmuxName` ergonomics.** Currently optional; the cycler is the only caller. If a future feature needs the same control (e.g. test harnesses), revisit whether a `reserveSessionName()` factory method is cleaner.
