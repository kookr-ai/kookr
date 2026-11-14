# RFC: Playbook Chains — server-owned repetition of a playbook task

**Status:** Accepted (v3 — post round-2 review; implemented in the same PR)
**Date:** 2026-11-14
**Author:** Jean Ibarz (with Claude)
**Evidence pack:** [rfc-playbook-chains-evidence.md](rfc-playbook-chains-evidence.md)

---

## Problem

The operator often wants to run the same playbook several times in a row: for
example, run `agentic-capability-research.md` in `local-research-agent` ten times
overnight, each run answering one new question. Today the only way to do that
without babysitting is the self-continuation pattern
(`plugin/skills/self-continuation-task`): the prompt tells the agent "before you
finish, spawn another task with the same contract".

That pattern depends on the agent remembering an instruction from the start of
its context at the very end of a long run. A research run spawns a swarm of
workers, reads many files, and can compact its context; the "spawn your
successor" instruction is exactly the kind of early, non-task instruction that
gets lost. When it is lost, the chain silently stops. The agent also has to get
the mechanics right every time — a unique prompt so deduplication does not
collapse it, the right agent type, the parent link, closing itself afterwards.

The operator wants a deterministic mechanism instead: "launch this playbook,
repeat it N times" or "repeat it for H hours", with Kookr doing the repeating,
and the dashboard showing that the task is part of a chain and how much is
left.

## Requirements

- **R1 — Launch option.** A playbook launch from the Playbooks tab, the HTTP API
  or the CLI MAY carry a chain spec: a maximum iteration count, a duration, or
  both. A spec with neither is rejected.
- **R2 — Kookr spawns the successor, not the agent.** When an iteration's task
  ends, the Kookr server SHALL launch the next iteration itself, from durable
  task state. No agent instruction is load-bearing for the chain to continue.
- **R3 — An iteration always ends.** An iteration whose agent finished but never
  closed its task SHALL still end, so a forgetful agent cannot stall the chain.
- **R4 — Bounds.** The chain SHALL stop launching when the iteration count is
  reached, when the deadline has passed at an iteration boundary, or when a hard
  safety cap is hit — whichever comes first. A running iteration is never
  killed by the deadline; it finishes, and no successor follows.
- **R5 — Stop on demand.** The operator (button / CLI) and the running agent
  (CLI) SHALL be able to stop the chain "after the current iteration". An
  operator cancelling the current iteration's task SHALL also end the chain.
- **R6 — Crash safety.** A server restart at any point SHALL neither lose the
  chain nor launch the same iteration twice, and SHALL never leave two
  iterations of one chain running at once.
- **R7 — Runaway protection.** Iterations that fail or finish suspiciously fast
  several times in a row SHALL end the chain with a visible reason.
- **R8 — Indicators.** Every task in a chain SHALL show its position (`3/10`,
  or `#3 · 2h 14m left`), and the last task of an ended chain SHALL show why it
  ended.
- **R9 — Each iteration is a normal task.** Its own worktree, PR, cost, history
  and task card, linked to its predecessor via `parentTaskId`.

## Design

### Overview

A chain is a field on the task record (`Task.chain`), copied forward from each
iteration to the next. One server component, the **chain service**, owns every
write to that field. It sweeps the task store every 15 seconds. For each chain
it looks at the newest task (the **tip**) and, with one pure function, decides
to wait, end the chain, or launch the next iteration.

```
launch (Playbooks tab / API / CLI) ─ chain spec ─► task #1 { chain: {iteration: 1, …} }
                                                        │ agent works
                                                        ▼
                    chain service sweep (every 15 s, started after startup recovery)
                        tip still working ──────────────► wait
                        tip idle, never closed ─────────► complete it (backstop, R3)
                        tip ended: decideChainStep ─┬───► end(reason)
                                                    └───► launch task #2 { chain: {iteration: 2}, parentTaskId: #1 }
```

### Data model

New optional field on `Task`, persisted with the task (tasks are stored as whole
JSON records, so no migration) and projected into the dashboard snapshot:

```ts
interface TaskChainState {
  chainId: string;          // minted when the chain starts (so a failed first launch can be ended)
  iteration: number;        // 1-based position of THIS task
  maxIterations?: number;   // count bound (absent = time-bounded only)
  deadlineAt?: string;      // ISO time bound (absent = count-bounded only)
  startedAt: string;
  unhealthyStreak: number;  // consecutive unhealthy iterations before this one
  successorTaskId?: string; // set once the next iteration exists
  idleClosedAfterActiveMs?: number; // idle backstop closed it; how long the agent was active
  stopRequest?: { at: string; by: 'operator' | 'agent'; reason?: string };
  ended?: { at: string; reason: ChainEndReason; detail?: string };
}

type ChainEndReason =
  | 'iterations_reached' | 'deadline_reached' | 'safety_cap'
  | 'stopped'             // stop requested by operator or agent
  | 'iteration_cancelled' // operator cancelled / manually stopped the iteration
  | 'runaway'             // 3 consecutive unhealthy iterations
  | 'launch_failed';      // successor launch failed 3 times in a row
```

- **The tip is derived:** the member with the highest `iteration` that has no
  `successorTaskId` and no `ended`. `successorTaskId` is the "already advanced"
  marker: without it, deleting or pruning the newest task would make its
  predecessor look like an unfinished tip and relaunch a chain (round 2).
- A time-bounded chain without an iteration count stops after 50 iterations
  (`CHAIN_TIME_ONLY_SAFETY_CAP`, end reason `safety_cap`).
- **Bounds are copied forward unchanged; control fields are not.** `stopRequest`
  and `ended` live only on the tip.
- **Only the chain service writes `chain`.** It reaches `launchTask` through
  the trusted server-only `LaunchTaskServerOptions.chain`, never through client
  `LaunchOpts`, and `createTask` stamps it atomically. A task spawned by hand
  can therefore never pose as an iteration, and a successor is findable by
  `chainId + iteration` the instant it exists.
- **Recipe for the next iteration** is re-derived from the tip's own persisted
  fields: `playbookSource` (id, scope, source cwd), `playbookParameterValues`,
  `cwd`, `projectId`, `agentType` and `launchIntent` (model / effort / tier
  pins). The playbook file is re-read per iteration, so an edit mid-chain
  applies to the next iteration, exactly as a manual relaunch would.

### Iteration boundary

The boundary is **the tip reaching a terminal status** (completed, cancelled,
terminated). It is derived from durable state by the sweep, so it does not
matter which of the many completion paths ran. An iteration gets there by:

1. **The agent closing it.** The agent runs `kookr signal completion-ready` or
   completes the task. 45 of the last 56 research runs ended with the agent
   completing its own task (evidence pack). Chain tasks are launched with
   `autoCloseOnSignal: true`, so a completion-ready signal closes the task right
   away instead of after the one-hour review grace.
2. **The operator closing it** from the dashboard.
3. **Restart recovery** completing or terminating it.
4. **The chain's idle backstop (R3).** Kookr already reminds an agent once, at
   its first Stop, to signal completion (`bin/kookr-stop-nudge.js`), but that
   reminder can be spent early — for example while a lead agent waits on its
   background workers — and nothing then closes a task whose agent simply
   stops. So for a chain tip that is `inProgress` with no pending signal, the
   service watches Kookr's existing **`needs_input` anomaly with a non-question
   subtype** (`Monitor.getCurrentAnomaly`). It is raised when the agent's last
   event is a clean Stop with nothing asked; it is *not* raised for a Stop
   parked on its own background shells or crons (`isBackgroundParked`), and the
   Monitor suppresses it while subagents are still outstanding — the same gate
   the terminal-success sweep (#2532) relies on. Those suppressions expire,
   though (a background shell after the watchdog's 45-minute park grace, a
   subagent after its 30-minute TTL), and the research playbook runs a `kb
   --refresh` that can take an hour. So the backstop also requires, with no
   time limit: the raw last Stop reports zero background tasks and crons, the
   Monitor's untimed outstanding-subagent count is zero, the provider is not
   paused, there is one live session and no pending signal. If all of that
   holds continuously for **5 minutes** (tracked in memory; the anomaly itself
   has no delay), the service surfaces any dirty worktree, re-checks idleness
   after that await, and completes the task (log reason `chain_idle_complete`,
   completion path `recovery`). It records how long the agent was active
   before going idle (`idleClosedAfterActiveMs`). A normal-length run closed
   this way counts as **healthy** — the consensus attack showed this is the
   common way iterations will end, not a rare fallback (see below). Only an
   agent that stalled within 2 minutes (for example on a question asked in
   prose) counts as unhealthy, so a chain that stalls every time still ends
   with `runaway` after three tries instead of burning its budget. A live
   `AskUserQuestion` is never auto-completed.
   Chain tasks are launched `unattended: true`, so interactive tools fail fast
   instead of parking the night on a question nobody will answer.

The backstop is what makes R2 true: the agent may forget the chain, forget to
signal, and forget to complete, and the chain still advances. The worst case
is the idle latency (staleness threshold + 5 minutes), not a stopped chain.

### The decision function

Policy is split in two pure functions in `src/core/playbook-chain.ts`:

**`classifyIteration(tip)`** reads only what the task lifecycle recorded:

| Tip state | Outcome |
|---|---|
| open / pending / inProgress | `running` |
| cancelled or terminated, receipt `source: 'user'` | `operator_stopped` |
| terminal, never had a session (launch failed after the task was created) | `finished`, unhealthy, never started |
| cancelled or terminated, any other source (watchdog, recovery, supervisor, pending-TTL…) | `finished`, unhealthy |
| completed by the idle backstop | `finished`; unhealthy only if the agent was active < 2 min |
| completed, ran < 2 min (measured from its first session, not from queueing) | `finished`, unhealthy |
| completed otherwise | `finished`, healthy |

**`decideChainStep(tip, now)`**: `wait` while running; `end('iteration_cancelled')`
when the operator stopped it; for a finished iteration, first match wins:

1. `stopRequest` set → `end('stopped')`
2. `iteration >= maxIterations` → `end('iterations_reached')`
3. `deadlineAt <= now` → `end('deadline_reached')`
4. no `maxIterations` and `iteration >= 50` → `end('safety_cap')`
5. unhealthy and `unhealthyStreak + 1 >= 3` → `end('runaway')`, or
   `end('launch_failed')` when the last one never started
6. otherwise → `launch` the next state (`iteration + 1`, bounds copied,
   `unhealthyStreak` reset on a healthy iteration).

Iterations count attempts: a failed iteration uses up one of the N. That keeps
spend bounded by N even if every run fails; the runaway breaker stops a chain
that keeps failing long before that.

No grace period for terminated tips: the service starts only after startup
recovery, so any tip recovery wanted to resume has already been reopened. If
the recovery phase itself failed, the service does not start at all until the
next clean restart (logged), rather than advance past a tip recovery missed.

### Launching the successor

The service re-runs `preparePlaybookLaunchWithMetadata` with the tip's recipe —
**without** `parentTaskId`, which would mark it as an attended manual relaunch —
prepends the chain notice (below), and calls `launchTask` with:

- `parentTaskId: tip.id` (lineage; the successor inherits `unattended`);
- `agentType` pinned to the tip's agent (KB lesson: successors must not fall
  back to the spawn default), plus its model / effort / tier pins;
- `autoCloseOnSignal: true`, `unattended: true`, `disableDedup: true` (every
  iteration has the same prompt);
- `launchSource: 'chain'`, a new **autonomous** source, so SAFE MODE holds
  chains like it holds schedules; the launch carries the trusted
  `automationProjectId` stamp. The per-project automation pause does *not*
  hold a chain (changed after dogfooding: most of the operator's projects carry
  a standing pause aimed at schedules, which stopped the first production chain
  after iteration 1, although the operator had started it in that project on
  purpose);
- server option `chain: next` (stamped at creation) and the playbook's delivery
  policy, exactly as a manual launch.

**Exactly once.** Before launching N+1 the service checks for an existing task
with the same `chainId` and iteration N+1; since chain state is stamped at
creation, that covers a crash anywhere between "tip finished" and "successor
recorded" — including a `launchTask` that threw after creating the task (that
stillborn task becomes the tip, counts as never started, and is not counted a
second time as a launch failure). `launchTask` flushes the task store right
after creating a chain task and before its agent starts, so a crash cannot
leave a live iteration whose record was never saved.
An in-process flag keeps sweeps from overlapping. No idempotency key is used:
the ledger would replay a stillborn successor instead of retrying (KB lesson).

**Launch errors.** "Not now" errors — SAFE MODE / automation pause, drain mode,
host-load or quota admission, spawn burst limit, full pending queue — are
*holds*: retried every sweep, not counted. Any other error counts; the third
consecutive failure ends the chain with `launch_failed` and the error text. The
counter is in memory; a restart grants a few more tries, which is harmless. A
launch that is merely queued (active-task cap reached) is a success.

**A stop that races the launch.** If a stop request lands on the old tip while
the successor launch is in flight, the service copies it onto the new tip right
after the launch returns, so that iteration becomes the last.

### What the agent sees

Each iteration's prompt starts with:

```
## Kookr chain — iteration 3 of 10 (runs until 2026-11-15 06:00 UTC)

This task is one iteration of a Kookr playbook chain. Kookr launches the next
iteration automatically after this task completes. Do NOT spawn a successor
task for this chain yourself, even if the instructions below say to.
Do one iteration of the playbook below, then finish the way you normally do.
If there is no work left, or continuing would cause harm, end the chain with:
  kookr chain stop --reason "<why>"
```

The notice is informational: the chain continues even if the agent ignores it.
It prevents a playbook prompt that still says "spawn your successor" from
producing an extra task, and gives the agent a way to end a chain whose work
ran out.

### Stopping a chain

`POST /api/tasks/:id/chain/stop` `{ reason?, by? }` accepts the id of any chain
member, resolves the tip, and sets `stopRequest`. The running iteration keeps
going; when it ends, the chain ends with `stopped`. Callers:

- a **Stop chain** button next to the chain badge (operator);
- `kookr chain stop [<task-id>] [--reason ...]`, defaulting to `$KOOKR_TASK_ID`
  (agent or operator shell). From inside a chain task it records `by: agent`.

To stop immediately, the operator cancels the current task as usual; that ends
the chain with `iteration_cancelled`.

### Launch surfaces

- **Playbooks tab:** a "Repeat" row with *Iterations* and *For hours*, both
  optional; filling either makes the launch a chain. Sent as
  `chain: { maxIterations?, durationMinutes? }` on the `launchPlaybook` WS
  message.
- **HTTP:** `POST /api/playbook-chains` `{ playbookPath, scope?, cwd,
  parameterValues?, agentType?, model?, effort?, maxIterations?,
  durationMinutes? }` → 201 with the first task.
- **CLI:** `kookr chain start <playbook> [--scope s] [--param k=v]...
  [--iterations N] [--hours H] [-C dir]` and `kookr chain stop`. This is also
  the first CLI that can launch a parameterised playbook without a `prompt`
  parameter (`kookr spawn --playbook` cannot, see the evidence pack), which
  agents and Lucy need in order to start chains on the operator's behalf.

Validation: `maxIterations` integer 1–200; `durationMinutes` integer 1–10080
(7 days); at least one present. Chains and Ralph loops are separate launch
modes and cannot be combined.

### Indicators

`AgentState.chain` carries the chain state. A `ChainBadge` sits next to the
existing `RalphLoopBadge` in task rows (FindingCard, HealthyRow, CompletedRow):

- count-bound: `⛓ 3/10`; time-bound: `⛓ #3 · 2h 14m left`; both: `⛓ 3/10 · 2h 14m`
- stop requested: `⛓ 3/10 · stopping`
- last task of an ended chain: `⛓ 3/10 · ended: deadline reached`

The tooltip states the contract: "Kookr launches the next iteration when this
task completes", the bounds, and the end detail. The tip of a running chain
shows a **Stop chain** button.

### Observability

Every non-`wait` decision, hold, launch failure and idle completion logs one
`[playbook-chain]` line to the server log with chain id, iteration and reason.
The end reason and detail are durable on the tip and visible in the badge.

## Files to change

| File | Change |
|---|---|
| `src/shared/contracts/playbook-chain.ts` (new) | `TaskChainState`, `ChainEndReason`, `ChainSpec`, limits |
| `src/core/playbook-chain.ts` (new) | `validateChainSpec`, `initialChainState`, `classifyIteration`, `decideChainStep`, `renderChainPreamble` (pure) |
| `src/core/task-read-model.ts`, `src/core/tasks.ts` | `chain?` on `Task` / `CreateTaskOptions`; `updateChain` mutator |
| `src/shared/contracts/agent-state.ts`, `core/monitor.ts`, snapshot projection | expose `chain` |
| `src/shared/contracts/task.ts`, `core/automation-kill-switch.ts` | `'chain'` launch source, autonomous |
| `src/server/launch-service.ts` | `LaunchTaskServerOptions.chain` stamped at `createTask` |
| `src/server/use-cases/prune-aged-task-records.ts` | never prune an unfinished chain tip |
| `src/server/playbook-chain-service.ts` (new) | start / stop / sweep / idle backstop |
| `src/server/index.ts` | construct; start after `runStartupRecoveryPhase`; stop on shutdown |
| `src/server/ws-handlers/playbook-handler.ts`, client schema | `chain` on `launchPlaybook` |
| `src/server/routes/playbook-chain-routes.ts` (new) | `POST /api/playbook-chains`, `POST /api/tasks/:id/chain/stop` |
| `bin/kookr-chain.js`, `bin/kookr.js` | CLI |
| `src/frontend/…/ChainBadge.tsx` (new), task rows, `PlaybookBrowser.tsx` | indicator, stop button, Repeat inputs |
| `docs/reference/api.md`, `docs/reference/playbook-chains.md` (new) | docs |
| `plugin/skills/self-continuation-task/SKILL.md`, `plugin.json` | point to chains for "same playbook N times / H hours"; version bump |

## Edge cases

- **Server down across the deadline.** The first sweep after restart ends the
  chain with `deadline_reached`.
- **Restart between completion and successor launch.** The first sweep (after
  recovery) launches it; the existence check prevents a duplicate.
- **Restart mid-iteration.** Recovery reopens or resumes the tip before the
  sweep starts, so the chain waits for it; if recovery leaves it terminated, it
  counts as an unhealthy iteration and the chain moves on.
- **Lead agent waiting on background workers.** Not `needs_input` (background
  work suppresses it), so neither the backstop nor the sweep touches it.
- **Agent asks a question with `AskUserQuestion`.** Chain tasks are unattended,
  so the call is denied and the task is flagged operator-needed; the backstop
  never completes a live question.
- **Queued successor reclaimed by the pending-queue TTL.** Its cancel receipt is
  `source: watchdog`, so it counts as an unhealthy iteration, not an operator
  cancel.
- **Operator reopens an earlier iteration** after its successor exists. It is
  no longer the tip, so the chain ignores it; the operator is running it by hand.
- **Agent manually spawns a successor** out of habit. That task has no `chain`
  field and the chain is unaffected.
- **Playbook deleted or parameters invalid** mid-chain. Three failed launches
  end the chain with `launch_failed` and the error text.
- **Operator deletes the live tip** (found while dogfooding: a completed tip,
  held between iterations, was deleted from the dashboard and the chain was
  lost). Single delete is refused (`live_chain_tip`, HTTP 409) and "clear
  completed" skips the tip until it has a successor or the chain has ended.
- **Terminal-task pruning** (#2765, 1-day default). An unfinished tip is exempt;
  earlier iterations age out normally.
- **Permission prompt.** With `KOOKR_BYPASS_ALL_PERMISSIONS` off, an iteration
  blocked on a permission dialog is not idle, so the backstop leaves it alone;
  the dashboard's attention queue surfaces it like any blocked task. (The
  operator's install runs with bypass on.)
- **Stop request vs crash.** A stop request is persisted on the next store
  flush; a crash inside that window loses it, and the operator sees the chain
  still running and can press Stop again.

## Alternatives considered

1. **Keep self-continuation, but re-inject the instruction** (e.g. a Stop hook
   that blocks and reminds the agent to spawn). Rejected: the agent would still
   own the mechanics (prompt uniqueness, agent type, parent link, closing
   itself), and the server already knows everything needed to launch the next
   iteration.
2. **Ralph loop.** Repeats a prompt inside *one* task: iterations share a card
   and history, and the boundary is any Stop from the owner session
   (`stop-event-ownership.ts` has no background-work check), so a lead agent
   ending a turn while its workers run would be cut into a new iteration. It
   only accepts playbooks with `loop:` frontmatter. Chains want the opposite
   (R9).
3. **Schedules with a completion trigger.** Schedules already have
   `maxTriggers`, stop reasons and an autonomous launch source, and a
   `* * * * *` cron with overlap-skip approximates "start again when done".
   A real `onPredecessorTerminal` trigger mode was considered (design-minimalist,
   round 1). Rejected: the schedule service is built around cron occurrences —
   fires are reserved by `scheduledFor` receipts, the ledger records one row per
   occurrence (skips included), catch-up and dead-man alerting assume a cron
   cadence — none of which has a meaning for "when the previous run ends". A
   chain is also ephemeral: a schedule object would have to be created,
   surfaced in the Schedules panel, and archived to run a playbook five times.
   Chains reuse what is reusable: the playbook launch recipe, the autonomous
   launch gate, and the schedule's vocabulary.
4. **A separate chain store.** Rejected: only the tip changes, and every field
   already lives on tasks; a store would be a second source of truth to
   reconcile on restart.
5. **Trigger from `TaskStore.transition()`** (the single terminal chokepoint)
   instead of sweeping. Rejected: it is synchronous core code, and launching a
   task from inside it would invert the core→server dependency; a callback is
   also lost on a crash between completion and launch, which the sweep handles
   for free. The sweep is a cheap in-memory scan every 15 s.
6. **Our own idle timer** for the backstop. Rejected in favour of the existing
   `needs_input` anomaly, which already encodes "idle with nothing asked" and
   the background-work suppression.

## Non-goals

- Running iterations in parallel (fan-out). One iteration at a time.
- Chaining *different* playbooks (pipelines). Same playbook and parameters.
- Per-chain cost caps. Subscription sessions report `$0` (see
  `RalphCostSignal`), so a cost cap would be a paper guardrail; the count and
  time bounds are the real ceilings.
- Server-side "no progress" detection. Progress is playbook-specific (the
  research playbook's progress is a ledger line outside git); the agent's
  `kookr chain stop` and the bounds cover it.
- Waiting for the predecessor's PR to merge before the next iteration.
  Iterations advance on task completion; playbooks whose next run needs merged
  code merge within the run (the default pre-authorized delivery does).
- Per-iteration parameter lists or `{{chain.iteration}}` template variables.
- Killing the running iteration at the deadline.

## Rollout

Additive. Tasks without `chain` behave exactly as before; the service ignores
them. One PR: contracts + pure core with unit tests, the service with tests for
the risky paths (crash between launch and record, stop during launch, stillborn
successor, pending-TTL cancel, idle backstop, never two live iterations), then
routes, CLI and UI. Kill switches: SAFE MODE holds `launchSource: 'chain'`;
stopping is per chain.

Acceptance test (live, hermetic dev instance on a throwaway port): a trivial
playbook launched as a 3-iteration chain; restart the server mid-chain; verify
exactly 3 tasks linked by `parentTaskId`, never two running at once, and the tip
ended `iterations_reached`.

## Critic feedback incorporated

**Round 1** (failure-mode-analyst, design-minimalist, ambition-amplifier,
state-machine-verifier, boundary-critic; N = 5).

Incorporated:
- *failure-mode-analyst #1* — the v1 claim that Kookr auto-signals completion
  on a clean turn was **false**: `TaskStore.evaluateCompletionSignal` has no
  production caller (verified by grep). The only end-of-task prompt is the
  once-per-task Stop nudge. Added R3 and the idle backstop on the existing
  `needs_input` anomaly; chain tasks are now `unattended`.
- *state-machine #1 / failure-mode #6* — recovery reopens `completed` and
  `terminated` tasks, and background services start before recovery
  (`index.ts` 3933 vs 4228). The service now starts only after
  `runStartupRecoveryPhase`, which also removes the 15-minute grace.
- *state-machine #3* — prune can delete a tip (1-day default); added the
  exemption.
- *state-machine #4 / failure-mode #3* — cancelled tasks never carry a
  termination reason; classification now keys on the terminal receipt source.
- *failure-mode #4* — passing `parentTaskId` into the playbook prepare step
  marks an attended manual relaunch; successors set lineage at `launchTask`.
- *failure-mode #2 / state-machine #7* — a stop racing the launch is copied
  forward.
- *failure-mode #5 / state-machine #6 / boundary #3* — dropped the idempotency
  key; exactly-once rests on stamping at creation plus the existence check.
- *boundary #1, #5* — one service owns every chain write; the tip is derived.
- *boundary #2* — classification split from bound policy.
- *boundary #4* — chain state goes through server-only launch options.
- *design-minimalist #1, #2* — dropped `successorTaskId`, persisted
  `launchFailures` and the grace period; one runaway rule.
- *design-minimalist #4 / ambition #6* — Alternative 5 now states the real
  reason (layering + crash), not "five call sites".

Rejected:
- *design-minimalist #3* (schedule completion trigger) — see Alternative 3.
- *design-minimalist #5, #6* (UI only; cut HTTP/CLI start) — kept: there is no
  CLI that can launch a parameterised playbook today, and agents/Lucy start work
  on the operator's behalf through the CLI. `chain status` and `GET /chain` were
  cut.
- *design-minimalist #7* (count only) — the user explicitly asked for "for Y
  hours".
- *design-minimalist #8* (no new launch source) — the source is what makes
  SAFE MODE and project pause hold chains.
- *ambition #2, #4, #5* — no-progress detection, cost caps, per-iteration
  params: Non-goals, with reasons.
- *ambition #1* — the research ledger lives in `~/knowledge_bases`, outside git,
  so iteration N+1 sees it immediately; merge-gating is a Non-goal.
- *ambition #3* — restart interruptions are handled by recovery-first ordering
  rather than by re-running the same iteration number.

Adversarial pair: on scope, I sided with design-minimalist on internal
machinery (fewer fields and counters) and with the user's explicit ask over
both critics on surface (time bound kept, CLI start kept, no cost or progress
features added).

`ambition-amplifier 2026-11-14: novel finding` (restart vs runaway accounting).

**Round 2** (failure-mode-analyst, state-machine-verifier, design-minimalist;
N = 3; ambition-amplifier skipped — v2 added no deferred items).

Incorporated:
- *failure-mode #1* — `needs_input` suppression expires (45-min park grace,
  30-min subagent TTL); the backstop now checks the raw Stop counts, the untimed
  subagent count, provider pause, and re-checks after its await.
- *failure-mode #2 / state-machine #3* — idle-closed iterations were made unhealthy; the consensus attack later narrowed this to immediate stalls (under 2 minutes active).
- *failure-mode #3* — chain tasks are flushed to disk before the agent starts.
- *failure-mode #4* — chains are held when startup recovery failed.
- *failure-mode #6* — stillborn tips end as `launch_failed` and are not
  double-counted.
- *state-machine #1* — pruning an ended tip alone resurrected the chain: prune
  is now whole-chain-or-nothing, and `successorTaskId` is back as the
  "already advanced" marker (also covers a deleted tip). This reverses the
  round-1 minimalist cut, with that reason.
- *design-minimalist #3* — dropped the persisted `safetyCap` field.
- *design-minimalist #5* — HTTP and WS both call `startChain`.

Rejected:
- *design-minimalist #1* (complete as soon as the anomaly appears) — the
  premise was wrong: `detectNeedsInput` raises it at the Stop itself with no
  staleness delay, so the 5-minute hold is the only staleness gate.
- *design-minimalist #2* (treat every launch error as a hold) — `launchTask`
  throws deterministic validation errors (model, effort, cwd, blacklisted
  agent) that would then retry every 15 s forever.
- *design-minimalist #4* (merge stop reasons, derive the streak) — the two stop
  reasons read differently on the badge; deriving the streak needs the same
  copied state.
- *failure-mode #5* — documented as an edge case rather than adding a
  permission-block timeout.
- *state-machine #4* (reopened terminated tips) — operator action; documented.

**Consensus attack** — `general-purpose 2026-11-14: consensus-attack — finding`.
The evidence pack read `completionPath: api_complete` as "the agent closed its
own task (45/56)". The attack checked the receipts: those tasks carry
`source: user`, closed in sub-second batches every 30–60 minutes with the next
batch launched seconds later. Something outside the agents (the operator or an
orchestrating session) was closing them, and in surviving transcripts 2 of 8
leads never signalled at all. So the idle backstop is the *expected* end of
many iterations, and counting every backstop close as unhealthy (round 2)
would have ended healthy overnight chains with `runaway` after three
forgetful-but-successful runs. Incorporated: a backstop close counts as
unhealthy only when the agent was active for under 2 minutes. The evidence
pack's telemetry note is corrected accordingly.

**Acceptance test (live, hermetic instance on port 4917):** a 3-iteration chain
of a trivial playbook whose even iterations deliberately stop without closing.
Iteration 1 closed itself; the server was killed and restarted while iteration
2 was parked; recovery reattached the session, the service started after
recovery, and the idle backstop closed iteration 2 five minutes later;
iteration 3 closed itself and the chain ended `iterations_reached`. Exactly 3
tasks, linked by `parentTaskId`, never two running at once; each successor
launched within about 15 seconds of its predecessor closing.

**Signal-path acceptance run (advisor follow-up).** A second hermetic chain
whose iterations record a lesson decision and run `kookr signal
completion-ready` showed why agents' signals often "don't count": each agent
raised the signal mid-turn, kept going (a Stop-hook retrospective prompt resumed
its turn), and the event pipeline cleared the signal as stale ("turn resumed").
That is pre-existing behaviour for every task. The chain still advanced: the
idle backstop closed each iteration 5 minutes after it went idle. The service
also closes a tip whose signal *does* survive (at the first sweep where the
signal is 30 s old and the turn has ended; 10 minutes at most), because Kookr's generic auto-close
waits out the review window and holds for an open PR — which the research
playbook deliberately leaves open.

Intent preservation check: the load-bearing motivation is "do not rely on the
agent remembering". v1 still relied on it (completion); v2 removes that with
the backstop. The explicit asks — N iterations or Y hours, any playbook,
indicators with remaining iterations/time — are all still met.
