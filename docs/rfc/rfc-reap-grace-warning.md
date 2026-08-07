# RFC: Grace-period warning & user veto before hung-task reap

**Status:** Draft (v2 — post-review revision, 5-critic panel)
**Date:** 2026-08-06
**Author:** Jean Ibarz (with Claude)

---

## Problem

The **hung-task reaper** (issue #1526 Phase A / FM6) terminates an in-progress
task whose agent has been totally silent — no hook events, no pane change, no
token movement — for `hungTaskReapMinutes` (default 3h), once the watchdog also
reports `stale_agent` for that agent. Termination is **immediate and silent
until after the fact**: `reapHungTask` kills the session, transitions the task
to `terminated`, and *only then* broadcasts a post-hoc `alert`
(`src/server/hung-task-reaper.ts`).

This produces a bad interaction for the exact case the reaper is supposed to
serve. A human notices a task looks stalled, opens it, and starts composing a
manual prompt to take control. While they are reading or typing (acts that do
**not** reset any liveness channel — the draft has not been submitted, and the
watchdog only sees pane/hook/token activity), the 3h silence clock expires, the
watchdog tick fires, and the task **vanishes mid-composition**. The user gets no
warning, no countdown, and no way to say "no, I've got this — keep it alive."
Their in-progress prompt is lost along with the session.

The reaper is correct to exist — a genuinely wedged agent holding a slot for
33h (the original incident, task `20e2ddbd`) must be reclaimed. The defect is
that reaping is a **surprise with no human-in-the-loop escape hatch**. We keep
the automatic reclamation but give an attentive operator a clearly communicated,
time-bounded chance to veto a specific reap.

## Goals

1. **Advance warning.** Before a task is actually reaped, surface a visible,
   explicit, time-bounded notification: *"This task looks hung and will be
   terminated in N:NN. Keep it alive?"* — legible to a first-time user, and
   present the moment they open the task (carried in the snapshot, so a
   reconnecting or late-joining client sees it too).
2. **Structurally protect the operator who is present.** The server already
   knows, continuously, which task each connected dashboard has selected
   (`DashboardSelectionController`, per-connection `selectedTaskId`). A task that
   a **live connection currently has open is auto-held** (its reap deadline is
   pushed forward) for a **bounded** window — so the heads-down operator typing a
   recovery prompt is protected *without having to notice and click a banner*
   (which, by the very 120s reasoning below, they may not). An explicit
   **[Keep it alive]** veto is the additional, deliberate escape hatch (and the
   only protection for a client that is *not* currently on the task, e.g. a
   different tab or a just-reconnected client).
3. **No weakening of the safety property.** A genuinely wedged task that nobody
   is watching is still reclaimed automatically. The grace window and any vetoes
   add only a **bounded** delay to reclamation; they never block it
   indefinitely.
4. **Reuse existing surfaces.** Build on the existing snapshot projection (like
   `stuckReason` / `pendingSignal` / `drainStatus`), the existing `ClientMessage`
   command pattern, the existing settings store, the existing audit-row +
   Prometheus-counter conventions, and the existing `hung_suspect` stuck badge —
   no new transport, no new persistence, no bespoke server→client message type.

## Non-Goals

- **Not** changing *when* a task becomes reap-eligible. The 3-channel / 3h
  silence bar, the `stale_agent` gate, and the provider-pause carve-out
  (#1667/#1896) are unchanged. This RFC inserts a warned→veto-able phase *after*
  eligibility (and after the provider-pause hold) and *before* the kill.
- **Not** touching the sibling sweepers (completion-ready auto-close, pending-TTL
  expiry). Those act on tasks with **no live session to prompt into**, so the
  "user is mid-prompt" problem does not occur. Generalizing later is possible;
  out of scope here.
- **Not** persisting reap-warning state. It is ephemeral runtime state — a
  server restart re-evaluates eligibility from scratch. The coordinator is
  in-memory only (matching `Watchdog` / `SnoozeSuppressionTracker`).
- **Not** an *unbounded* presence hold. The presence auto-hold (Goal 2) is
  capped at `MAX_PRESENCE_HOLD_MS` from the first warning: a task a connection
  keeps selected but nobody actually works is still reclaimed after that ceiling,
  and disconnecting or selecting away releases it immediately. Presence never
  blocks reclamation indefinitely (Goal 3).
- **Not** a *draft-level* presence signal in v1. "Selected by a live connection"
  is the presence proxy (already server-side, zero new client plumbing).
  Distinguishing "open" from "actively typing" via a draft-presence message is a
  possible future refinement (Alternatives), not built here.

## Design

### Layering & ownership

Three cleanly separated responsibilities, mirroring the existing eligibility /
kill split:

- **Eligibility (pure, unchanged):** `core/hung-task-reaper.ts`
  `evaluateHungTaskReap`.
- **Warning-lifecycle state (new, `core/reap-warning-coordinator.ts`):** a
  clock-injected, `Map`-backed `ReapWarningCoordinator` — the *single source of
  truth* for warning state and for every transition's reason. This placement
  matches proven precedent: `core/watchdog.ts` and `core/snooze-suppression.ts`
  are both mutable, `Map`-backed, clock-injected core classes shared between the
  timer loop and a WS handler. ("Core" here means *deterministic given an
  injected clock, no I/O to another subsystem* — not side-effect-free in the FP
  sense; `Watchdog` and `settings-store` already establish that meaning.)
  **Exactly one instance per server process**, constructed at the composition
  root (`server/index.ts`) and threaded to both the watchdog tick
  (`lifecycle-timers.ts`) and the veto handler (`lifecycle-handler.ts`). Never
  export a module-level singleton (that is the hidden-global the boundary review
  warns against). A constructor doc-comment states the single-instance
  invariant.
- **Kill execution (unchanged):** `server/hung-task-reaper.ts` `reapHungTask`.
  Its contract does **not** change — it does not learn about the warning
  lifecycle. The warning is removed from the coordinator by the *caller* that
  decides to reap, not by the kill module.

### Warning state is carried in the snapshot — no new server→client message

The warning is projected onto the existing per-agent `AgentState` in the
snapshot, exactly like `stuckReason` and `pendingSignal`:

```ts
// AgentState (src/shared/contracts/agent-state.ts)
reapWarning?: {
  /** ms remaining until the reap deadline, computed server-side at snapshot
   *  build (deadlineAt − now) so the client never mixes two clocks. */
  remainingMs: number;
  /** total-silence duration captured when the warning was first raised. */
  silentForMs: number;
  /** how many times the user has extended this warning (for copy + the cap). */
  keptAliveCount: number;
  /** true once the veto cap is hit — the button is disabled, reap will proceed. */
  vetoCapReached: boolean;
};
```

The snapshot projection (`get-snapshot.ts`) reads
`reapWarningCoordinator.getWarning(taskId)` and sets the field. Consequences,
each resolving a specific review finding:

- **Reconnect / late-join is solved** (failure-mode F2, operability): any client
  that connects mid-window rehydrates the banner from the next snapshot — no
  reliance on catching a one-shot broadcast.
- **Clock skew is solved** (F5): the server sends `remainingMs`, not an absolute
  timestamp; the client counts down locally from receipt.
- **Two bespoke message types and a bespoke frontend slice are eliminated**
  (minimalism, boundary): there is no `taskReapWarning` / `taskReapWarningCleared`
  message. Raising, extending, or clearing a warning is reflected by the next
  snapshot broadcast (which the raising/vetoing/clearing code already triggers
  via the tick's `changed` path). This also removes the "un-exhaustive
  server→client dispatch switch" risk the delivery review flagged — the only new
  wire addition is one `ClientMessage`.

### Control flow

Two call sites consult the coordinator. This split is the core fix for
failure-mode **F1/F4/F6** (clearing must not be gated behind `stale_agent`).

**(A) Reap advancement — inside the existing gated path** (`maybeReapHungTask`,
after eligibility **and** the provider-pause hold both pass, at the exact point
it reaps today). Only reached on a `stale_agent` tick for a tracked agent, so
the existing safety property (never reap a task waiting on input/permission) is
preserved verbatim. Replace the immediate `reapHungTask` call with:

```
if (!warningPhaseEnabled) → reapHungTask now            // independent kill switch (below)
switch coordinator.advance(taskId, agentId, silentForMs, now, graceMs):
  'warn'  → audit(warned) + counter + console.warn; return false   // snapshot carries it
  'wait'  → return false                                            // countdown still running
  'reap'  → audit(expiredToReap) + counter; fall through to reapHungTask
```

`advance` **never blocks the tick** — it returns immediately; it must never
`await sleep(graceMs)`. (Explicit invariant: the grace delay is realized by
returning `wait` across successive 5s ticks, never by holding the tick open —
holding it would starve the `watchdogTickRunning` re-entrancy guard.)

**(B) Warning maintenance — a new unguarded pass**, once per watchdog tick after
the per-agent loop, iterating the coordinator's *own* warned task-ids
(`coordinator.warnedTaskIds()`), independent of which agents are tracked or
`stale_agent` this tick:

```
for taskId in coordinator.warnedTaskIds():
  task = taskStore.getTask(taskId)
  if !task or task.status !== 'inProgress':        coordinator.clear(taskId,'gone');      audit+counter
  else re-evaluate evaluateHungTaskReap(task, liveness, {now, threshold}):
    not eligible →                                 coordinator.clear(taskId,'recovered'); audit+counter
    eligible & now > deadline + STUCK_CLEAR_MS →   coordinator.clear(taskId,'stale');     audit+counter   // self-heal
    else → keep
if any cleared → broadcast snapshot
```

This pass is what makes the headline scenario correct: when the user submits a
prompt, the pane changes → `lastPaneChangeAt` advances → `evaluateHungTaskReap`
returns not-eligible → the warning is cleared (`recovered`) and the banner
disappears — even though the `stale_agent`-gated branch (A) is now skipped
because the agent went active (this is exactly F1). It also reclaims warnings
for tasks whose agent is no longer tracked (F4), and clears (via
`pendingSignal` → not-eligible) a task that flipped to `needs_input` (F6). The
`STUCK_CLEAR_MS` self-heal drops any warning left past its deadline without a
reap (e.g. the watchdog stopped calling it `stale_agent`) so a banner can never
freeze at 0:00.

The maintenance pass does **not** reap — reaping stays exclusively in gated path
(A), so the `stale_agent` guarantee is never weakened.

**(B′) Presence auto-hold — folded into the same maintenance pass.** For each
warned, still-eligible task, the server asks
`selectionController.isTaskSelectedByAnyConnection(taskId)` (a scan of the
per-connection selection map that already exists) and calls
`coordinator.applyPresence(taskId, present, now, graceMs)`. While a live
connection has the task selected and `now < warnedAt + MAX_PRESENCE_HOLD_MS`, the
coordinator keeps `deadlineAt` at least `min(now + graceMs, warnedAt +
MAX_PRESENCE_HOLD_MS)` — i.e. the reap is pushed forward, bounded by an absolute
ceiling measured from the first warning. This is the structural protection for
the heads-down typist the consensus review surfaced: the server already holds
the presence signal, so the typing operator is protected by a signal, not by
noticing a banner. Bounds that keep Goal 3 intact:

- The hold is capped at `MAX_PRESENCE_HOLD_MS` (15 min) from warn time, no matter
  how long the task stays selected — a selected-but-abandoned task still reaps.
- Presence requires a **live** connection: closing the tab
  (`unregisterConnection`) or selecting another task drops it from the map, and
  the hold releases on the next tick.
- `applyPresence` only ever *extends* toward the ceiling; it never reaps and
  never shrinks a manual veto’s longer deadline. Keeping the coordinator pure,
  presence is passed in as a boolean the server computed — the coordinator does
  not import the selection controller.

The `reapWarning` snapshot field carries `heldByPresence: boolean` so the banner
can tell a present user *why* the countdown is paused and how to make it
permanent (submit a message).

### The veto: `keepTaskAlive`, modeled as a deadline extension

Single new `ClientMessage`:

```ts
| { type: 'keepTaskAlive'; taskId: string }
```

Handled in `lifecycle-handler.ts` (routed from `ws.ts`; added to the handler's
`LifecycleMessage` `Extract<>` list — the routing switches have no
compile-time exhaustiveness, so this is added by hand and covered by a dispatch
test, per the delivery review). The handler calls
`coordinator.veto(taskId, now, extensionMs)`:

```
veto(taskId, now, extensionMs):
  w = warnings.get(taskId)
  if !w                         → { accepted:false, reason:'no_warning' }   // F9: validate
  if w.keptAliveCount >= MAX    → { accepted:false, reason:'cap_reached' }  // leave warning; reaps at deadline
  w.keptAliveCount++
  w.deadlineAt = now + extensionMs
  → { accepted:true }
```

**Veto = extend the deadline**, not a separate immunity map. This keeps *all*
warning state in one `warnings` map (boundary: single source of truth; minimalism:
fewer moving parts) and keeps the reprieve **honest and visible** — after a
veto the banner simply shows the new, longer countdown. On `accepted`: audit
(`vetoed`) + counter + `console.log` + trigger a snapshot broadcast (immediate
feedback). On `no_warning` / `cap_reached`: send a scoped `alert` to that client
so a too-late or capped click gets distinct feedback (operability: veto-ack
ambiguity), and reap proceeds at the deadline.

The natural way to keep a task alive *permanently* is to actually interact with
it — submit a prompt → pane changes → liveness resets → not eligible → cleared
by pass (B). The veto buys bounded time to do exactly that.

**Bounding repeated veto (failure-mode F3).** `keptAliveCount` is capped at
`MAX_REAP_VETOES` (3) and is only reset by a `recovered`/`gone` clear or a reap —
so it accumulates across extension cycles. Worst case a user who keeps clicking
without ever interacting holds the slot for `MAX_REAP_VETOES × extensionMs`
(≈ 30 min with a 10-min extension) and is then reaped regardless. This is a
bounded, explicitly-chosen, human-in-the-loop hold — not the indefinite silent
hold Goal 3 forbids. The slot-occupancy cost is called out in the settings help
and the banner. The auto-send-on-typing idea (Alternatives) is deliberately
**not** built, precisely so it cannot defeat this cap.

### Settings & kill switch

| Field | Default | Bounds | Meaning |
|---|---|---|---|
| `hungTaskReapWarningEnabled` | `true` | — | Independent kill switch for *just* the warned phase. `false` ⇒ reaper behaves exactly as today (immediate reap). |
| `hungTaskReapGraceSeconds` | `120` | `10`–`600` | Initial countdown between warning and reap. |

Extension length (`REAP_VETO_EXTENSION_MS`, 10 min), the veto cap
(`MAX_REAP_VETOES`, 3), and the presence ceiling (`MAX_PRESENCE_HOLD_MS`, 15 min)
are **hardcoded constants** (minimalism: no evidence anyone needs them tunable;
promote to settings only on real demand). Live
getters for the two settings are wired next to `getHungTaskReapEnabled` /
`getHungTaskReapMs`, read every tick (a change takes effect without restart; it
affects *future* warnings — an in-flight countdown keeps its captured deadline).

**Why an independent flag** (operability + delivery, a Critical): the only
existing gate `hungTaskReapEnabled` also gates the base reaper the whole
subsystem exists to preserve. If the warned phase misbehaves in prod, ops must
be able to disable *only* it (`hungTaskReapWarningEnabled=false`) and fall back
to the proven immediate reaper, without regressing to the 33h-wedge incident
(#1526). This is the primary rollback lever. A non-throwing coordinator logic
bug (e.g. deadlines that never expire) is not caught by the tick's per-agent
`try/catch`; this flag is how it gets turned off.

**Why 120s, not the user's suggested 10s.** 10s is a fine *toast auto-dismiss*
but far too short a *reaction window* for a heads-down operator. A task only
reaches this phase after ≥3h of total silence, so adding 120s (or even 600s) to
reclamation is negligible against the safety budget. Tunable for operators who
want it tighter/looser.

### Observability (operability review)

- **Cumulative counters** owned by the coordinator (`getMetrics()`):
  `warningsRaisedTotal`, `vetoedTotal`, `vetoRejectedTotal`,
  `expiredToReapTotal`, and `cleared{Recovered,Gone,Stale,Disabled}Total`.
  Exposed (with the live per-task state) via `GET /api/diagnostics/reap-warnings`
  — an in-memory read, not wired into `prometheus-exposition.ts` / `/metrics` /
  `/api/health` in this iteration (the diagnostics route is the ground-truth
  surface; promoting the counters into the Prometheus exposition is a small,
  additive follow-up if operators want alerting on them).
- **Logs**: `console.warn`/`console.log` at warn-raise, veto, and each clear,
  mirroring the existing `[hung-task-reaper] reaping task …` line so a live log
  tail traces the whole warn→veto→clear/reap story.
- **Audit** (`audit.jsonl`): `task.hungTaskReapWarned` (warn),
  `task.hungTaskReapVetoed` (veto, actor `user`), and a unified
  `task.hungTaskReapWarningCleared { reason }` on every clear (so a warn row is
  never left dangling with no resolution — the recovered/gone/stale clears are
  audited, not silent). The existing terminal `task.hungTaskReap` row gains
  `warnedAt?` / `keptAliveCount?` so a reap can be joined back to the warning
  that preceded it. Restart-dropped warnings are documented as intentionally
  producing no clear row (state was lost, not resolved) — an accepted limitation
  of in-memory state, mitigated by re-warn.
- **Live introspection**: `coordinator.snapshotState()` (active warning count +
  per-task `deadlineAt`/`keptAliveCount`) surfaced on the existing diagnostics
  route so an operator can answer "why is task X warned / not warned right now"
  from a ground-truth read path, not by reconstructing from audit + whatever the
  browser received.

### Frontend

- **No new store slice.** `reapWarning` arrives on `AgentState` in the snapshot;
  the existing agent-state merge carries it. A tiny selector exposes warned
  agents.
- **`ReapWarningBanner`**: a `warning`-severity banner on the affected task's
  card, counting down locally from `remainingMs` (one `setInterval(1000)` while
  any warning is active; deadline = `Date.now() + remainingMs` captured at
  receipt — skew-free). Copy, first-time-user legible:

  > ⚠️ **"{task name}" looks hung** — no activity for {N}h. It will be terminated
  > in **{m:ss}** to free the slot. **[Keep it alive]**

  `[Keep it alive]` sends `keepTaskAlive`. When `heldByPresence` the copy leads
  with "paused while you have this open — **send a message** to keep working on
  it." After `keptAliveCount ≥ 1` the copy notes "kept alive {n}×"; when
  `vetoCapReached`, the button is disabled and the copy switches to "will be
  terminated — **type a message and send it** to keep working on this task,"
  pointing the user at the permanent fix. The banner is
  the actionable escalation of the existing `hung_suspect` badge (badge
  unchanged).
- **SettingsDialog**: a toggle for `hungTaskReapWarningEnabled` and a numeric
  input for `hungTaskReapGraceSeconds`, beside the existing reaper controls,
  with help text noting the slot-occupancy cost of repeated vetoes.

## Delivery sequencing (delivery review)

Three stages, each independently verifiable; the safety-relevant change lands and
is proven before any UI:

1. **Core + settings + unit tests.** `ReapWarningCoordinator` (advance / veto /
   clear / warnedTaskIds / getWarning / snapshotState, fully clock-injected) with
   exhaustive unit tests for every transition, the cap, and the self-heal;
   settings fields + validation/clamp + defaults.
2. **Server wiring + contracts + audit + counters + integration test.** Insert
   advancement into `maybeReapHungTask` (composed *after* the provider-pause
   hold), add the maintenance pass, the `keepTaskAlive` route
   (`ws.ts` + `lifecycle-handler.ts` Extract list + handler), the `reapWarning`
   snapshot field, audit rows, counters, and the independent flag. A WS-level
   integration test proves the veto command actually routes and extends the
   deadline (guards the "green build, dropped command" partial state the
   delivery review flagged). Server behavior is correct and observable with no
   frontend.
3. **Frontend.** Banner + settings controls + dispatch. Safe to stage last: a
   missing/old frontend that receives the new `reapWarning` field simply ignores
   an unknown optional field (degrades to today), and the server→client path adds
   no new message type to route.

## Edge cases

- **User submits a prompt during the window** → pane changes → not eligible →
  pass (B) clears `recovered`; banner gone. (Headline scenario; the F1 fix.)
- **User still typing (not yet submitted)** → their connection has the task
  selected, so presence auto-hold (B′) pushes the deadline for up to
  `MAX_PRESENCE_HOLD_MS` without any click; the banner + button are also visible
  if they want to extend further, and submitting clears the warning. Protected
  structurally. (Goal 2 — the consensus-attack fix.)
- **User selects the task then walks away (tab still open)** → presence holds
  only until `warnedAt + MAX_PRESENCE_HOLD_MS`, then the countdown resumes and it
  reaps. Closing the tab or selecting another task releases the hold immediately.
  (Goal 3 preserved.)
- **Task terminates by another path (session dies / user cancels / completes)**
  during the window → not `inProgress` → pass (B) clears `gone`.
- **Server restart mid-warning** → in-memory warning lost; re-raised with a
  *fresh full* grace window on the next qualifying tick; no double-kill (reap
  re-checks eligibility). Produces no clear audit row (documented).
- **Veto races the deadline** → single-threaded JS; the veto’s deadline write
  and pass-(A)’s reap decision cannot interleave. Worst case: a reap that already
  entered `reapHungTask` cannot be undone (≤ one 5s tick); the audit trail
  records which won. Strictly better than today (no chance at all).
- **`stale_agent` gate flaps** while the task stays silent → warning persists
  (pass (B) keys on *eligibility*, not the gate), so no warn/clear broadcast
  churn. Genuine eligibility flap (silent→active→silent) clears then re-warns,
  which is correct; broadcasts fire only on real state change.
- **Warning phase disabled mid-window** (`hungTaskReapWarningEnabled=false`) →
  pass (B) still runs and clears all warnings (it is not gated on the flag), so
  banners disappear and the reaper reverts to immediate. (Fixes the delivery
  review’s "sweep lives inside the short-circuited branch" gap.)
- **Provider-paused task** (#1667/#1896) → the pause hold returns before
  advancement is reached, so a billing-paused task is never warned or reaped;
  when the provider reset elapses and the code falls through, advancement warns
  then reaps normally.
- **Many tasks warned together** (common outage wedges many agents) → warnings
  are cheap and staggered only by when each crossed 3h; the actual kill at
  deadline still goes through the unchanged `reapHungTask` loop. The reap
  fan-out is no more clustered than today’s (a restart already synchronizes all
  eligible reaps to the first tick); this RFC does not change the kill cadence.
  If clustered grace-expiry teardown ever proves a problem, the existing
  auto-close throttle pattern is the template — noted, not built (no evidence
  it’s needed; the warned phase adds delay, not concurrency).

## Alternatives considered

- **Presence/draft-driven auto-hold as the primary mechanism.** The dashboard
  does track a selected agent and composition focus. Auto-holding a reap while
  the user has the task open/typing is attractive but rejected as *primary*: a
  task left "selected" in a background tab would never be reclaimed (breaks
  Goal 3), and it couples the reaper to view state. The explicit, visible
  countdown + button protects the typing user without that coupling. A future
  enhancement may have the frontend *auto-send* `keepTaskAlive` when the user
  starts typing into a warned task — a pure UX convenience over the same command,
  same bounded extension, same cap, so the safety property is preserved. Noted,
  not in scope.
- **Two `ServerMessage` types + a dedicated frontend slice.** Rejected: warning
  state belongs in the snapshot (like `stuckReason`/`drainStatus`), which fixes
  reconnect for free and removes the message types, the slice, and the
  server→client routing risk.
- **A separate immunity/cooldown map for the veto.** Rejected in favor of
  extending the deadline: one map, one source of truth, and an honest visible
  countdown after veto.
- **Store warning state on the `Task` read model.** Rejected: ephemeral runtime
  state must not persist to `tasks.json`; the coordinator + snapshot projection
  is cheaper and clearer.
- **Reuse `snooze`.** Rejected: snooze suppresses *attention-queue* entries, not
  reaping, and is anomaly-scoped; overloading it conflates "hide this alert" with
  "don’t kill this task."
- **Just lengthen `hungTaskReapMinutes`.** Rejected: only delays the same silent
  surprise; the defect is the absence of warning + veto, not the threshold.

## Rollout & safety

- Two independent flags: `hungTaskReapEnabled` (whole reaper, unchanged) and
  `hungTaskReapWarningEnabled` (just the warned phase). Disabling the latter is
  an instant, low-risk revert to the proven immediate reaper.
- The kill itself is the unchanged `reapHungTask`; the only change to the reap
  path is a bounded delay before it, re-checking eligibility at the deadline. A
  coordinator bug degrades toward "today minus the surprise" (delayed/skipped
  reap), never toward a spurious kill.
- Full unit coverage on the coordinator (clock-injected), a server WS-level
  integration test for the veto route + deadline extension, and a frontend
  banner/dispatch test.

## Critic feedback incorporated

Five-critic panel (round 1): `failure-mode-analyst`, `design-minimalist`,
`boundary-critic`, `operability-reviewer`, `delivery-pragmatist`. Panel
selection gate: N = 5 (at cap; all lenses directly relevant — safety,
simplicity, boundaries, runtime operability, staged delivery onto a live-incident
code path).

- **Empirical grounding (post-round-1 check):** critics verified load-bearing
  claims against real source and corrected the RFC’s base assumptions — the
  actual `maybeReapHungTask` on `origin/main` carries a provider-pause carve-out
  (#1667/#1896), a disposition ledger, and `resolveMergedPr`, none of which the
  first draft accounted for. The design now composes advancement *after* the
  provider-pause hold. No further probe needed — the empirical claim (reaper gate
  structure) was checked against source, not debated.

- **failure-mode-analyst** — **F1 (critical): clearing was gated behind
  `stale_agent`**, so a prompt-submit (agent goes active) would freeze the banner
  at 0:00. Fixed by the unguarded maintenance pass (B) keyed on eligibility.
  **F2 (high): reconnect reintroduced the surprise** — fixed by carrying the
  warning in the snapshot. **F3 (high): unbounded repeated veto** — fixed with a
  `MAX_REAP_VETOES` cap that accumulates across cycles + documented slot cost +
  explicitly not building auto-send-on-typing. **F4:** maintenance iterates the
  coordinator’s own keys (untracked-agent leak fixed). **F5:** send `remainingMs`,
  not an absolute deadline (clock-skew fixed). **F6:** folded into F1. **F9:**
  veto validates an active warning exists.
- **design-minimalist** — dropped the two bespoke message types (fold into the
  snapshot), dropped the separate frontend slice, dropped the immunity map (veto
  = deadline extension), hardcoded the extension length and veto cap instead of
  new settings. Kept `hungTaskReapGraceSeconds` tunable (it argued a real case
  for that one). **Adversarial pair (`design-minimalist` vs the implied
  ambition to make everything tunable):** sided with minimalism on tunability
  (one setting, not three) but *added* one knob it did not ask for —
  `hungTaskReapWarningEnabled` — because the operability and delivery reviews
  independently showed the rollback lever is load-bearing, not speculative.
- **boundary-critic** — resolved the `reapHungTask` "unchanged vs also-emits"
  contradiction by removing the message entirely (kill module stays unchanged;
  snapshot carries state). Coordinator is the single source of truth for every
  clear reason; added `warnedTaskIds()`/`snapshotState()` enumeration to its API;
  documented the exactly-one-instance-per-process invariant; adopted its
  precise "core = deterministic-given-clock, not FP-pure" framing.
- **operability-reviewer** — added cumulative counters (in-memory, surfaced via
  `GET /api/diagnostics/reap-warnings` rather than the Prometheus exposition —
  see Observability), warn/veto/clear logs, a unified `WarningCleared` audit row
  + warn→reap linkage fields, live `snapshotState()` introspection, and the
  independent `hungTaskReapWarningEnabled` kill switch; documented the
  restart-drop limitation.
- **delivery-pragmatist** — specified the explicit 3-stage sequence; composed
  advancement after the provider-pause carve-out; added the independent rollback
  flag; noted the routing switches lack compile-time exhaustiveness so the
  `keepTaskAlive` route is added by hand + covered by an integration test; fixed
  the "disable-while-warning" edge (maintenance pass is not gated on the flag).

- `general-purpose <2026-08-06>: consensus-attack — FINDING (incorporated).` The
  panel shared a false framing assumption: that the reaper has no server-side
  "a human is working this task now" signal, so a banner+click is the best
  achievable protection for the typing operator. It is false — the server already
  retains per-connection `selectedTaskId` (`DashboardSelectionController`). The
  banner-only design protected only the *just-submitted* user (liveness clears on
  pane change at submit), not the user *still typing* — which is the literal
  complaint. Incorporated as the bounded **presence auto-hold** (Design B′):
  a task a live connection currently has selected is auto-held for up to
  `MAX_PRESENCE_HOLD_MS`, structurally protecting the heads-down typist while
  the ceiling + live-connection requirement preserve Goal 3. The manual veto and
  banner remain for not-currently-selected / reconnecting clients and as the
  explicit escape hatch. This was the single revision the consensus attack is
  permitted; no further round.
