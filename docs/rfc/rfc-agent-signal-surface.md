# RFC: Agent Signal Surface — Agent-to-User Notifications via Kookr

**Status:** Draft (brainstorming, v4 — adds Stop-hook adoption nudge per user direction)
**Date:** 2026-06-05
**Author:** Jean Ibarz (with Claude)

---

## Problem

A Kookr agent that reaches a workflow boundary has only two ways to involve the
user:

1. **Stop normally.** The `Stop` hook fires and the turn ends. But "stopped" is
   not "done": `turn-state.ts` maps **every** clean turn-end to `completed_turn`
   — the agent that finished step 1 of a 10-step plan, the agent that stopped to
   think, and the agent that genuinely finished the whole task are all
   `completed_turn`. The state encodes *a turn ended*, not *the task is
   complete*. Nothing the server observes carries the agent's belief "this whole
   task is finished."
2. **Call `AskUserQuestion`.** This is **modal and blocking**: the turn is held
   open in `waiting_for_input` (`src/core/turn-state.ts:48-54`) and the user
   must answer before the agent proceeds. For a soft "I think I'm done — shall I
   clean up / proceed?" this is the wrong instrument: it forces a Q&A where a
   non-blocking hint plus one click would do, and it pins a tmux turn while it
   waits.

The user's request, precisely: when an agent **believes a task is finished** and
wants to (say) do cleanup, it should be able to *signal that belief* to Kookr —
non-blocking — and Kookr decides how to surface it (highlight the one-click
Complete button from #727, raise a badge, chime). **Agent proposes, user
disposes.**

The load-bearing observation, confirmed in round-2 review: **that belief exists
only in the agent.** There is no deterministic server-side state to derive it
from — `completed_turn` is too coarse (it fires on every stop), and `anomaly` on
a clean stop is `needs_input/stop`, never null (`anomaly-detector.ts:99-101`).
So the feature the user asked for is necessarily an **explicit** signal from the
agent. An earlier draft (v2) tried to auto-derive completion from the Stop hook;
review showed that surfaces a state which does not carry the intent and would
cry wolf on every turn-end. v3 restores the user's framing: the agent signals
explicitly; Kookr surfaces it.

### What the data says

We probed real hook logs under `~/.kookr/hooks/` (483 sessions) before
committing:

- AskUserQuestion appears in **79/483 sessions (16%)** — not rare.
- Of structured questions sampled, roughly **half** are soft "how do you want me
  to proceed?" framing rather than a hard choice (keyword-approximate).
- These soft uses are `waiting_for_input`, i.e. the agent **blocking to say
  something it could have signalled non-blockingly** — exactly the population an
  explicit non-blocking channel would serve.

## Goals

- Give the agent a **non-blocking, explicit** way to express a small, bounded set
  of intents — the motivating one being "I believe this task is complete" — that
  Kookr surfaces as a one-click affordance.
- Let **Kookr own the surfacing**: the agent says *what*; Kookr decides *how*.
- Make the signal **safe**: surfacing it as "ready to complete" must be gated on
  the agent actually being idle, so a signal raised while the agent keeps working
  never invites premature completion.
- Provide an **acknowledgment path** so the agent can learn whether the user
  accepted or dismissed, enabling a loop (e.g. Ralph) to branch — designed now,
  shippable as a later increment.
- Preserve the boundary: a signal is a **hint**, never a state mutation.
  Surfacing `completion_ready` must NOT complete the task — it only invites it.

> **Follow-up (post-acceptance):** the original RFC made "surfacing must NOT
> complete the task" a hard non-goal (preserving propose/dispose). A later,
> **opt-in** extension relaxes this *only* for tasks that explicitly carry the
> `autoCloseOnSignal` policy — the motivating case being long self-continuation
> chains where finished-but-unreviewed tasks pile up against `MAX_ACTIVE_TASKS`
> and stall the chain. The default is unchanged (signal only surfaces); the
> propose/dispose boundary still holds for every task that did not opt in. See
> [reference/auto-close-on-signal.md](../reference/auto-close-on-signal.md).

## Non-Goals

- Do **not** let the agent complete, cancel, or transition the task itself.
  Completion stays the user-driven `completeTask` WS path. *(Relaxed by the
  opt-in `autoCloseOnSignal` follow-up above — off by default.)*
- Do **not** replace `AskUserQuestion`. Genuinely blocking questions still use
  it; signals fill the non-blocking gap.
- Do **not** auto-derive completion intent from the Stop hook. `completed_turn`
  does not mean "task done" (it fires on every turn-end); deriving
  `completion_ready` from it would surface meaning the state does not carry.
  (See Alternatives — this was the v2 design, now rejected.)
- Do **not** add a new `TaskStatus`. A pending signal is overlay state.
- Do **not** build a general agent→server RPC bus. One append-only signal verb
  plus a read-only outcome poll.
- Do **not** depend on the supervision-RFC Follow-up surface — it is **not
  implemented** (verified: `TaskNextActionSnapshot`/`projectAgentForClient`/the
  Follow-up group are absent from `src/`). Surface via `DetailPanel` (and,
  optionally, the task-list row) directly.

## Requirements

### Core — explicit signal channel

- Kookr SHALL expose a non-blocking way for an in-task agent to emit a signal of
  a bounded enum of kinds, addressed to its own task via `KOOKR_TASK_ID`.
- Emitting SHALL be idempotent per (task, kind) and SHALL fail soft: a server it
  cannot reach SHALL NOT fail the task. The CLI SHALL use **distinct exit
  codes** — server unreachable (advisory; exit 3) vs signal rejected
  (wrong/terminal task; exit 4, surfaced to the agent so a bad `KOOKR_TASK_ID`
  is visible, not masked).
- A raised signal SHALL be carried to the browser on the existing `update`/
  `snapshot` messages via a client projection (Design §3); it is server-held
  state, not frontend-derivable.
- The dashboard SHALL render the signal as a non-modal affordance (banner +
  highlighted Complete button) the user can act on (Complete) or dismiss.
- The "ready to complete" emphasis (pulsing Complete) SHALL be presented only
  when the agent's turn is idle (`turnState === 'completed_turn'`); a signal
  raised while the agent is `running` SHALL be a quiet badge, never a pulsing
  Complete button. This is the safety rule that removes the
  stale-signal-while-editing failure mode.
- A raised signal SHALL be cleared/superseded on: explicit dismiss, terminal
  status, or **a new turn start** (the next `user_prompt`/`UserPromptSubmit`),
  which indicates the agent's prior "done" belief is stale. Clearing SHALL NOT
  be keyed to a volatile in-memory counter (see Edge Cases / round-2 finding).

### Acknowledgment (designed now, shippable as a later increment)

- The channel SHALL record, in the audit trail, a `signal.raised` entry and a
  `signal.acknowledged` entry carrying `{ kind, outcome: 'accepted' | 'dismissed'
  | 'expired' }`. (The existing `kookr command outcome` plumbing records only
  `outcome:'accepted'` over four hardcoded event types — it does NOT yet carry a
  dismiss outcome or a signal kind, so these entry types must be added, not
  assumed.)
- A `kookr signal wait <kind> [--timeout N]` poller MAY expose the outcome to the
  agent (exit 0 accepted / 1 dismissed / 124 timeout). It SHALL be invoked only
  **after** the agent's Stop (or in a separate continuation task), never inline
  before a turn boundary, so it cannot pin a turn the way `AskUserQuestion` does.

### Adoption — Stop-hook nudge

- Kookr SHALL deliver, via a `Stop` hook, an **advisory reminder** to the agent
  that the explicit signal channel exists, so adoption does not rely solely on a
  CLAUDE.md/skill nudge the agent may ignore (per our "hooks > documentation"
  rule).
- The nudge SHALL be **non-coercive**: it informs the agent of the option and
  explicitly leaves the decision to the agent. It SHALL NOT assert that the
  current Stop means the task is complete — a clean turn-end does **not**
  reliably coincide with the Kookr task being finished, so the agent must judge
  in every case.
- The nudge SHALL fire **at most once per task** and SHALL NOT re-fire on
  subsequent stops (loop-prevention via the Stop payload's `stop_hook_active`
  flag plus a **durable per-task** dedup marker). Its worst-case cost is one
  extra agent turn.
- The nudge SHALL be **hard fail-open**: every code path SHALL exit 0, including
  on unhandled exceptions/rejections and on any inability to verify task state.
  It SHALL NOT exit non-zero. (Rationale: a non-zero Stop-hook exit is a
  `StopFailure`, which `turn-state.ts:42` maps to `blocked` — trapping the agent
  and suppressing the Complete affordance. The nudge must never be able to do
  that. Note the existing writer exits 1 on error; the nudge MUST NOT copy that.)
- The nudge SHALL NOT fire if it cannot positively confirm, at hook time, that
  the agent has **not** already raised a `completion_ready` signal and the task
  is **not** terminal. If that state cannot be read (e.g. server unreachable),
  the nudge SHALL skip (exit 0, no block) rather than nudge blind.
- The nudge SHALL be gated by a minimal "task has done real work" check (it
  SHALL NOT fire on a task's first trivial stop) so short tasks do not spend
  their one nudge on an obviously-incomplete state.
- The nudge SHALL be controllable by a runtime **kill switch**
  (`KOOKR_NUDGE_DISABLED`) that disables it for in-flight tasks without
  redeploying or relaunching them.
- The nudge SHALL ship **only after** the explicit channel (`kookr signal` verb
  + `/api/tasks/:id/signal` route) is deployed and verified — never in the same
  promotion — so agents are never reminded to run a verb that does not yet exist
  (which would also burn the one-shot dedup).
- The nudge is a **reminder of the feature only**; it does not raise, infer, or
  auto-emit any signal. (This is the boundary that distinguishes it from the
  rejected v2 auto-derivation: v2 *decided*; the nudge *reminds*.)

### Cross-cutting

- New wire/state SHALL follow existing conventions: discriminated-union
  `ServerMessage`/`ClientMessage`, Zod-validated client input, and a client
  projection rather than mutating raw `AgentState` in `Monitor`.
- The channel SHALL NOT let the agent mutate task lifecycle, config, or another
  task's state.

## Design

### 1. Shared read model

```ts
// src/shared/contracts/agent-signal.ts  (or inline in messages.ts while small)
export type AgentSignalKind = 'completion_ready';   // one kind; enum so it can grow

export interface PendingAgentSignal {
  kind: AgentSignalKind;
  note?: string;          // see redaction caveat — enum-only note preferred
  raisedTurnId: string;   // identity of the turn it was raised in (see §4)
}
```

**Governance rule for new kinds** (so the enum doesn't grow by impulse): a new
kind requires (a) a concrete user-facing use case, (b) a defined *accept* action,
and (c) a defined *dismiss* action. Absent all three, use `AskUserQuestion`.
(`needs_decision` from v1 was dropped for exactly this reason.)

### 2. Per-task state ownership

Following `rfc-supervision-next-actions.md`'s boundary rule, do **not** mutate
raw `AgentState` in `Monitor`. One task → one pending signal. Decision (was an
open question; round-2 minimalist pushed to just decide): **a nullable field on
the task record** (`TaskStore`). Clearing is then atomic with lifecycle
transitions already in `lifecycle-handler.ts`; no second store to wire into the
projection; no ephemeral-vs-durable split to invent. All signal lifecycle
transitions go through **one** `handleTaskTransition(taskId, snapshot)` entry
point so clear/supersede logic lives in one place (fixes round-1 "clear has no
owner / scattered across components").

### 3. The projection seam (must be built — it does not exist)

Verified: `projectAgentForClient()` does **not** exist; the seam is
`getSnapshotAgentsForClient()` returning `AgentState[]`, and **three** sites emit
`{type:'update'}` bypassing any projection: `lifecycle-handler.ts:175`,
`lifecycle-handler.ts:508`, `ws.ts:459` (`broadcastUpdate`).

Unlike v2's auto-stop derivation (which the frontend could have computed from
fields it already has), an **explicit** signal is server-held state the frontend
cannot derive — so it genuinely must ride the wire. Build:

```ts
// src/server/use-cases/get-snapshot.ts
export type ClientAgentState = AgentState & { pendingSignal?: PendingAgentSignal };
export function projectAgentForClient(agent, signalForTask): ClientAgentState { /* attach */ }
```

Route **all three** update sites + the snapshot path through it, and change the
wire type at `messages.ts:189` from `state: AgentState` to `state:
ClientAgentState`. (The supervision RFC's round-2 caught this exact snapshot-vs-
update consistency bug; we inherit the lesson.)

### 4. Lifecycle — turn identity, not event counter

Round-2 root-cause: `lastEventSeq` is the wrong key for "this turn." It is the
**untrimmed** last `eventSeq` (`monitor.ts:786`), while `turn-state.ts` trims
trailing `notification`/`subagent_stop` overlays before deciding `completed_turn`
— so the very cleanup events that keep `turnState` at `completed_turn` advance
`lastEventSeq`, breaking any dismissal keyed to it. And `Monitor`'s `eventSeq`
resets on restart (rebuilt from zero), so it is not durable.

Therefore key a raised signal to a **turn identity** that is stable against
trailing overlays and restart:

- `raisedTurnId` = the restart-stable id of the turn's terminating Stop event
  (the ingestion-layer `kookrSessionId + sequence`, which *is* preserved across
  restart per `hook-ingestion.ts:217-219`), not `Monitor.eventSeq`.
- **Supersede on new turn start.** When a new `UserPromptSubmit` arrives for the
  task (a genuinely new turn, distinct from trailing cleanup overlays), the prior
  signal's belief is stale → clear it. This is the correct "agent moved on"
  trigger, replacing the v2 sequence comparison.
- **Dismiss** is bound to `raisedTurnId`; it suppresses that signal until a new
  turn raises a fresh one. Because it is keyed to the Stop's stable id, a trailing
  `SubagentStop`/`Notification` does **not** re-surface it (fixes round-2 F1/F6),
  and a 30-min stale-subagent eviction timer flip does not swallow a later genuine
  signal (fixes F2).
- **Ralph:** the iteration-complete path early-returns without a terminal
  transition (`lifecycle-handler.ts:192-203`). Do **not** clear there. Clear on
  the next turn start (new `UserPromptSubmit`) or on real terminal (`cancelTask`)
  (fixes round-2 F3, which showed clearing above the early-return re-nags every
  iteration).

### 5. Surfacing (Kookr owns the UX)

For `completion_ready`: a compact "Agent reports: ready for review" banner in
`DetailPanel.tsx`; the existing one-click Complete button (#727) pulses **only
when `turnState === 'completed_turn'`** (idle), otherwise the banner shows but
Complete is normal. Optionally a soft chime via `maybePlayChime()` gates
(respecting DND/quiet-hours; a signal never overrides Do-Not-Disturb).
Optionally a list-level badge on `HealthyRow` (`FindingsPanel.tsx`) so a signal
is visible without opening the detail — a frontend-only add riding the same
`pendingSignal` field (does not wait for the unbuilt Follow-up surface). Visual
design is a pure frontend concern — a good candidate for `ui-mockup-variants`
before implementation.

### 6. Transport

`kookr signal <kind>` CLI verb (`bin/kookr-signal.js`): reads `KOOKR_TASK_ID`,
auto-detects the port, POSTs `/api/tasks/:id/signal` (namespaced under tasks,
co-located with `/api/tasks/:id/complete`). The kind is a bare argument (no shell
metacharacters → no hook command-scanning trip).

**Contract-first:** define the signal as an MCP tool schema
(`kookr_signal(kind, note?)`) now — emit-only — even though the MCP server is not
wired. The CLI is its first transport; when MCP lands it is a wire swap, not an
agent re-learn. Cheap (~10-line type), prevents contract divergence.

### 7. Adoption — the Stop-hook nudge

Because the completion belief exists only in the agent, there is no state to
auto-derive it from (that was v2's error). Adoption therefore depends on the
agent *remembering* to use the channel. A pure CLAUDE.md/skill nudge under-adopts
(our "hooks > documentation" rule). So Kookr delivers the reminder
**deterministically via a `Stop` hook**, while keeping the decision with the
agent.

**Why a Stop hook can do this, and its one constraint.** A `Stop` hook is the
only point where the agent is about to go idle, and the *only* hook output that
reaches the agent (rather than the user) is `{"decision":"block","reason":...}`,
which makes the agent take one more turn with `reason` as guidance. A bare exit-0
Stop hook's stdout goes to the user, not the agent — so to *remind the agent* we
must block once. The loop risk (block → continue → stop → block …) is closed by
the Stop payload's `stop_hook_active` flag: when true, the agent is already
continuing because of a stop hook, so the nudge exits 0 and never re-blocks.

**Mechanism.** Stop hooks are an array; Kookr already wires Stop to
`kookr-hook-writer.js` (fire-and-forget, exit 0). Add a **second** Stop hook
entry, `bin/kookr-stop-nudge.js`, leaving the writer pure. The nudge script:

```text
on Stop (read stop_hook_active from the RAW stdin payload — kookr's parser strips it):
  process.on uncaughtException/unhandledRejection -> exit 0   # HARD fail-open
  if KOOKR_NUDGE_DISABLED -> exit 0                  # runtime kill switch
  if stop_hook_active -> exit 0                      # already continuing; never re-block
  if no KOOKR_TASK_ID -> exit 0                      # not a managed task
  if per-task "nudged" marker present -> exit 0      # at most once per task (durable)
  read task state via KOOKR_API_BASE_URL:
    if unreachable / error -> exit 0                 # never nudge blind
    if already raised completion_ready -> exit 0     # nothing to remind
    if terminal -> exit 0
  if task has not done real work yet -> exit 0       # minimal activity gate
  set durable per-task "nudged" marker
  print {"decision":"block","reason": NUDGE_TEXT}; exit 0
  # any failure anywhere above -> exit 0 (no block)
```

Every branch ends in `exit 0`. The only path that blocks is the fully-qualified
one, and even it never throws past the top-level fail-open guard. This is the
load-bearing safety property: the nudge can at worst deliver an unwanted
reminder; it can never trap the agent in `blocked`.

`NUDGE_TEXT` (advisory, agent-decides, names the real feature):

> "If you consider this Kookr task fully complete and ready to be closed, signal
> it with `kookr signal completion-ready` so the user can review and complete it.
> If there is more to do — or this is just a turn boundary, not the end of the
> task — simply continue or stop as you judge. This reminder fires once per task."

**Decision stays with the agent.** The nudge never claims the task is done, never
emits a signal, and fires once. A Stop is not a reliable proxy for Kookr-task
completion, so the agent judges in every case — the nudge only ensures the option
is in-context at the moment it is most relevant.

**Dedup marker (decided: durable per-task).** A durable per-task flag in the
task envelope (survives restart, "once per task") rather than a tmpfs
per-session marker, so a server bounce doesn't re-nag. The "already raised
completion_ready" and "terminal" checks read the same task record the channel
writes, via `KOOKR_API_BASE_URL`; on any read failure the nudge skips (never
nudges blind).

**Kill switch and propagation.** `KOOKR_NUDGE_DISABLED` is checked at hook-run
time by the script. Because the Stop hook entry is baked into per-task settings
at spawn (`generateSettings`), a server-only flag would not reach in-flight
agents — so the disable signal must be runtime-readable by the script: propagate
the env via `buildAgentLaunchContext` (`agent-launch-context.ts:130`) for new
tasks, AND honor a runtime marker (e.g. `/dev/shm/.kookr-nudge-disabled`) the
script stats on each run so an operator can kill the nudge for already-running
tasks without relaunch. (Removing the hook entry from `generateSettings` only
affects future spawns; in-flight tasks keep their baked settings — hence the
runtime marker is the real escape hatch.)

**Sequencing (decided: nudge is its own slice, after the channel).** The nudge
is wired into `generateSettings` only after the `kookr signal` verb and
`/api/tasks/:id/signal` route are deployed and verified. Order of slices:
**(1)** explicit channel raise+surface → **(2)** acknowledgment increment →
**(3)** the Stop-hook nudge. This guarantees the verb the nudge points at always
exists, and avoids burning the one-shot dedup on a dead reference.

**Cosmetic note.** The block-then-continue causes one extra
`running → completed_turn` cycle, so the dashboard banner/Complete-pulse may
flicker once on the nudged turn. This is cosmetic (the `already-signaled` guard
keeps the nudge from firing after a real signal); acceptable, noted for the
implementer.

**Why this is the adoption fix, not a second feature.** The nudge is the
deterministic delivery of the reminder; the channel is the mechanism it points
at. Together they replace reliance on a doc-nudge the agent may ignore, without
crossing into auto-deciding completion. This directly retires the v3 "adoption is
the top risk relying on a CLAUDE.md nudge" concern.

### End-to-end trace

1. Agent decides the task is done; before stopping, runs `kookr signal
   completion-ready`. `bin/kookr-signal.js` reads `KOOKR_TASK_ID`, POSTs
   `/api/tasks/:id/signal`. Exit 0 (or 3 if no server — agent ignores; or 4 if
   rejected — agent sees it).
2. Server validates (Zod), sets the nullable `pendingSignal` on the task record
   keyed to the current turn's Stop id, writes a `signal.raised` audit entry,
   broadcasts an `update` projected through `projectAgentForClient`.
3. Agent stops → snapshot `turnState = completed_turn`. Frontend shows the banner
   and, because idle, pulses Complete.
4. User clicks Complete → `completeTask` runs; task leaves `inProgress`; the
   field clears; a `signal.acknowledged {outcome:'accepted'}` entry is written.
   Or user dismisses → `signal.acknowledged {outcome:'dismissed'}`; suppressed
   until a new turn raises a fresh signal.
5. (Optional, later) the agent had run `kookr signal wait` *after* its Stop in a
   continuation task; it now reads exit 0/1 and branches.

## Files to Change

Slice 1 — explicit channel (raise + surface):

- `src/shared/contracts/agent-signal.ts` (or inline) — `AgentSignalKind`,
  `PendingAgentSignal`.
- `src/shared/contracts/messages.ts` — `ClientAgentState`; `update`/`snapshot`
  carry it; add `dismissAgentSignal` to `ClientMessage`.
- `src/shared/contracts/client-message-schema.ts` — Zod for `dismissAgentSignal`.
- `src/server/use-cases/get-snapshot.ts` — **build** `projectAgentForClient`;
  route snapshot through it.
- `src/server/ws.ts` (`broadcastUpdate` ~:459) + `lifecycle-handler.ts` (~:175,
  ~:508) — route the three `{type:'update'}` sites through the projection.
- `src/server/routes/task-routes.ts` — `POST /api/tasks/:id/signal` (validate,
  redact, set field, audit `signal.raised`, broadcast).
- `src/server/ws-handlers/lifecycle-handler.ts` — `dismissAgentSignal`; clear on
  new-turn-start and terminal (NOT above the Ralph early-return); audit
  `signal.acknowledged`.
- Task-record field + single `handleTaskTransition` owner for clear/supersede.
- `bin/kookr.js` + `bin/kookr-signal.js` — the `kookr signal` verb.
- `src/frontend/components/DetailPanel.tsx` — banner + idle-gated Complete pulse;
  send `dismissAgentSignal`. Optional `FindingsPanel.tsx` `HealthyRow` badge.
- Skill / CLAUDE.md nudge.
- Tests: route validation/redaction/exit-codes; projection consistency across
  all three update sites + snapshot; turn-identity dismissal stable against
  trailing overlays and the stale-subagent timer flip; Ralph iteration does not
  clear; new-turn-start clears; idle-gating of the Complete pulse; frontend
  rendering.

Slice 2 — acknowledgment increment: `signal.raised`/`signal.acknowledged` audit
types, `kookr signal wait` poller (post-Stop only), outcome exit codes.

Slice 3 — Stop-hook nudge (**only after slices 1–2 are deployed and verified**):

- `bin/kookr-stop-nudge.js` (new) — once-per-task advisory nudge; **hard
  fail-open** (exits 0 on every path incl. uncaught errors); reads
  `stop_hook_active` from the raw payload; checks kill switch, durable marker,
  already-signaled/terminal (skip if state unreadable), activity gate; emits
  `{"decision":"block","reason":...}` at most once.
- `src/adapters/claude-code-adapter.ts` (`generateSettings`, ~:713-753) — add the
  nudge as a **second** Stop hook entry alongside `kookr-hook-writer.js`.
- `src/core/hook-writer-paths.ts` — build the nudge command path next to the
  writer command.
- `src/adapters/agent-launch-context.ts` (~:130) — propagate `KOOKR_NUDGE_DISABLED`.
- Durable per-task "nudged" flag in the task envelope; runtime kill marker
  (`/dev/shm/.kookr-nudge-disabled`) the script stats each run.
- Tests: never exits non-zero (incl. simulated crash/unhandled rejection); never
  re-blocks when `stop_hook_active`; skips when already-signaled/terminal/state-
  unreadable/kill-switch-set; respects the durable marker (one nudge per task,
  across restart); activity gate suppresses the trivial-first-stop case.

Explicitly NOT in scope: Stop-hook auto-derivation; agent-driven lifecycle
mutation; new `TaskStatus`; dependence on the unbuilt Follow-up surface; MCP
server wiring; durability of acknowledgment across restart (Open Question);
remote push of signals.

## Edge Cases

- **Trailing overlays after Stop.** `SubagentStop`/`Notification` advance
  `lastEventSeq` but are trimmed by `turn-state.ts`; keying the signal to the
  Stop event's stable id (not `lastEventSeq`) keeps dismissal stable (round-2 F1/F6).
- **Stale-subagent timer flip.** `deriveTurnStateForSnapshot` can flip
  `running`→`completed_turn` on a 30-min eviction timer with no new event
  (`monitor.ts:~722`, `SUBAGENT_TTL_MS`). The Complete-pulse gate reads live
  snapshot turnState, so it simply appears when genuinely idle; dismissal keyed
  to turn identity is not swallowed by the flip (round-2 F2).
- **Ralph iterations.** Don't clear on the iteration-complete early-return; clear
  on next turn start or real terminal (round-2 F3).
- **Server restart.** Task-record field persists with the task; `raisedTurnId`
  uses the restart-stable ingestion id, not `Monitor.eventSeq` (which resets)
  (round-2 F4). Acknowledgment durability is an Open Question.
- **`kookr signal wait` must not block a turn.** Invoke only post-Stop or in a
  separate continuation task; never inline before a turn boundary (round-2 F5).
  Otherwise it reintroduces the very blocking this RFC removes.
- **Audit scan cost.** `collectCommandOutcomes` whole-file-scans `audit.jsonl`
  per call (`kookr-command-outcome.ts:84-107`); a polling `signal wait` over a
  long run should tail/offset, not re-parse the whole file each poll (round-2 F5).
- **Wrong/terminal `KOOKR_TASK_ID`.** Child tasks get their **own**
  `KOOKR_TASK_ID` (`agent-launch-context.ts:145`), so inheritance is not a bug.
  Unknown/terminal task → reject with exit 4, not silently applied to a guess.
- **Note redaction is best-effort only.** The reused scrubber matches exactly 12
  token-prefix/PEM patterns (`lifecycle-handler.ts:538-557`); it does NOT catch
  bare passwords/env values/unknown formats, and notes broadcast to all clients.
  Prefer an enum-only note in the first increment; if free text is allowed,
  document the limit and never echo raw notes to clients that didn't see the
  transcript.
- **DND / quiet hours.** Surfacing respects existing chime/notification gates.
- **Stop-hook nudge loop.** Guaranteed bounded: if `stop_hook_active` is true the
  nudge exits 0 (the agent is already continuing from a stop hook), and a per-task
  dedup marker prevents a second block on a later natural stop. Worst case is one
  extra turn per task.
- **Nudge fires too early.** A task's first Stop may be far from done. The nudge
  is advisory and explicitly says "if this is just a turn boundary, continue" —
  but to avoid wasting the one turn on obviously-early stops, the marker check MAY
  be combined with a minimal "task has done real work" gate. Kept minimal because
  the agent decides regardless.
- **Nudge after the agent already signaled.** Skipped — the script checks the
  task record for an existing `completion_ready` (and terminal status) before
  blocking, so the agent is never nudged to do what it just did.
- **Nudge across restart.** A durable per-task marker (vs tmpfs per-session)
  avoids re-nagging after a server bounce; tmpfs is acceptable if "once per
  session" is good enough.

## Alternatives Considered

- **Auto-derive `completion_ready` from the Stop hook (the v2 design).**
  Rejected. (a) Technically, a clean Stop yields `anomaly: needs_input/stop`,
  never `null` (`anomaly-detector.ts:99-101`), so the v2 predicate would never
  fire. (b) Conceptually, `completed_turn` fires on **every** turn-end, so
  auto-surfacing would pulse "Complete?" on every stop — including dozens of
  intermediate stops — training users to ignore it. `completed_turn` does not
  carry "task done"; the intent exists only in the agent, which is why the signal
  must be explicit. A purely cosmetic "emphasize Complete whenever the task is
  idle" frontend touch is possible but is **not** `completion_ready` and carries
  no agent intent; out of scope.
- **Keep using `AskUserQuestion` for soft "I'm done."** The status quo the data
  shows is real (~half of AskUserQuestion uses are soft). Kept for genuinely
  blocking questions; this channel fills the non-blocking gap.
- **Hook/Notification text convention.** Rejected: parsing free-form agent output
  to drive a typed UX feature is brittle and not idempotent.
- **Let the agent complete the task directly.** Rejected: violates
  propose/dispose and the no-lifecycle-mutation non-goal.
- **Embed `pendingSignal` on `AgentState`/`Monitor`.** Rejected per the
  supervision RFC boundary rule.
- **Supersede via `lastEventSeq` comparison (v2).** Rejected: `lastEventSeq` is
  untrimmed and resets on restart; keying to turn identity + new-turn-start is
  correct.
- **Depend on the supervision Follow-up surface.** Rejected: not implemented.
- **Non-blocking Stop nudge (exit-0 stdout).** Rejected for the *agent* reminder:
  a plain exit-0 Stop hook's stdout is shown to the **user**, not fed to the
  agent, so it cannot remind the agent. Feeding text to the agent at Stop requires
  `decision:block` (one extra turn), bounded by `stop_hook_active` + dedup.
- **User-side "agent stopped without signaling" prompt.** A reasonable *separate*
  idea, but it nudges the user, not the agent. The user asked specifically for an
  agent-facing reminder; this is noted as possible future UX, not the nudge here.
- **Auto-signal from the Stop hook (v2).** Rejected again, and the nudge is the
  principled middle: it *reminds* the agent of the option but never *decides*
  completion, honoring that a Stop ≠ Kookr-task-done.

## Open Questions

- **Adoption metric (the top risk):** what acceptance/dismissal rate, over how
  many sessions, tells us agents actually use `kookr signal` and users act on it?
  Define before building the acknowledgment increment.
- Should the first increment ship raise+surface only, with acknowledgment
  (`signal wait` + audit outcomes) as a fast follow once raise+surface shows use?
- `agent-signal.ts` as its own file vs inline in `messages.ts` while one kind?
- Acknowledgment durability across restart (so an overnight `signal wait`
  survives a bounce) vs ephemeral with a documented re-signal convention?
- What exactly is the minimal "task did real work" gate keyed on (≥1 file-
  mutating tool use? ≥N turns?) — decided to include it; the precise predicate is
  for implementation.
- Nudge dedup (durable per-task marker), kill switch (`KOOKR_NUDGE_DISABLED` +
  runtime marker), hard fail-open, and slice-3-after-channel sequencing are
  **decided** (post delivery-pragmatist review), not open.

## Empirical Checkpoint

`design-experimenter` verified load-bearing claims against code and logs
(2026-06-05):

- **Confirmed:** no per-task sequence counter; hook sequence is per-
  `kookrSessionId`; `Monitor.eventSeq` resets on restart; `lastEventSeq` is the
  untrimmed last event.
- **Confirmed:** `completed_turn` means "a turn ended cleanly" — it fires on
  every Stop and does not encode "task done."
- **Confirmed (round-2):** a clean Stop yields `anomaly: needs_input/stop`, not
  `null`; the existing correct idle predicate is `DetailPanel.tsx:641`'s
  `isCompletedTurn`. This falsified v2's auto-derivation predicate and drove the
  v3 restructure to an explicit channel.
- **Refuted:** the supervision Follow-up surface is implemented — it is RFC-only.
- **Confirmed:** `projectAgentForClient` must be built; 3 update sites bypass the
  seam.
- **Confirmed:** redaction is a 12-pattern allowlist; `kookr-command-outcome.ts`
  records only `accepted` over 4 hardcoded event types (so `signal.acknowledged`
  with a dismiss outcome must be added, not assumed).
- **Sized the problem:** AskUserQuestion in 16% of sessions, ~half soft framing.

## Critic Feedback Incorporated

- **Adversarial pair (`design-minimalist` vs `ambition-amplifier`) — resolution
  (updated v3):** Round-2 evidence resolved the pair decisively toward
  `ambition-amplifier`'s position: the **explicit, acknowledged channel is the
  feature**, because the completion belief exists only in the agent and no
  server state carries it. `design-minimalist`'s "make it a pure frontend
  derivation" applies only to the cosmetic "emphasize Complete when idle" touch —
  which is explicitly *not* `completion_ready` — so it cannot replace the channel.
  `design-minimalist`'s other cuts were kept (drop `needs_decision`, decide
  field-over-store, enum-only note, no premature MCP bidirectionality).
  Rationale: v2 followed the minimalist/socratic round-1 pull toward
  Stop-surfacing and **dropped the user's actual motivation** (explicit agent
  intent); round-2 caught the inversion and v3 restores it.
- `socratic-challenger` round 1: forced the "is Stop already the signal?"
  question; round 2 answered it — Stop (`completed_turn`) fires on every turn-end
  and does not carry task-completion intent, so an explicit channel is required.
- `socratic-challenger` round 2: caught that v2 would cry wolf on every stop,
  that the AskUserQuestion data supports the explicit channel not auto-stop, and
  that v2 inverted the user's request — drove the v3 restructure.
- `failure-mode-analyst` round 1: split fail-soft exit codes; gated the Complete
  affordance on live idleness; honest redaction; Ralph early-return handling.
- `failure-mode-analyst` round 2: re-keyed dismissal/supersede from
  `lastEventSeq` to a restart-stable turn identity + new-turn-start trigger
  (fixes overlay re-nag, timer-flip swallow, restart, and Ralph re-nag); required
  `signal wait` to run post-Stop only; flagged the audit-scan cost.
- `boundary-critic` round 1: centralized lifecycle in one `handleTaskTransition`
  owner; corrected the projection seam (build it; route all 3 update sites);
  decided field-over-store.
- `design-minimalist` rounds 1–2: dropped `needs_decision`/`note`/`raisedAt`/
  supersede machinery; namespaced the route under `/api/tasks/:id/signal`;
  decided field-over-store; reduced the gated material to a sketch.
- `ambition-amplifier` rounds 1–2: acknowledgment path with proper
  `signal.raised`/`signal.acknowledged{outcome}` audit entries (not hand-waved
  reuse); MCP-schema-first; governance rule for new kinds; made the explicit
  channel the core rather than a gated afterthought.
- `design-experimenter` 2026-06-05: see Empirical Checkpoint; its round-2 finding
  (clean Stop ≠ `anomaly null`; `completed_turn` ≠ task done) is the pivot point
  of v3.

- **User direction 2026-06-05 (v4):** add a Stop-hook *nudge* to bridge adoption
  — but a nudge only, because a Stop does not reliably coincide with Kookr-task
  completion, so the agent must decide in every case. Incorporated as Design §7:
  a once-per-task, non-coercive `{"decision":"block","reason":...}` reminder
  guarded by `stop_hook_active` + a dedup marker, that points at the explicit
  channel and never auto-signals. Stop-hook semantics verified via the
  `claude-code-hooks` skill; kookr's hook-wiring (`generateSettings`,
  `kookr-hook-writer.js`, env propagation of `KOOKR_TASK_ID`) confirmed via code.
- `delivery-pragmatist` 2026-06-05 (v4 nudge): incorporated three ship-blockers —
  **hard fail-open** (a non-zero nudge exit → `StopFailure` → `blocked`, trapping
  the agent and suppressing Complete; `turn-state.ts:42`), **slice-3-after-channel
  sequencing** (never nudge toward a verb that isn't deployed, which also burns
  the one-shot dedup), and a **runtime kill switch** (`KOOKR_NUDGE_DISABLED` +
  `/dev/shm` marker, since the hook is baked into per-task settings at spawn).
  Also: skip-if-state-unreadable (never nudge blind), read `stop_hook_active`
  from the raw payload (kookr's parser strips it), durable per-task marker, and a
  noted cosmetic banner flicker on the block-continue turn.

### Invocation log

- `ambition-amplifier` 2026-06-05 round 1: novel finding (acknowledgment path is
  the load-bearing deferral; MCP-schema-first).
- `ambition-amplifier` 2026-06-05 round 2: novel finding (gate was backwards;
  acknowledgment plumbing doesn't exist as claimed).
- `design-experimenter` 2026-06-05: novel finding (v2 predicate falsified;
  Follow-up surface unbuilt; problem-size data).
