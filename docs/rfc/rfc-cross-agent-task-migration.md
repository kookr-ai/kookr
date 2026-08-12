# RFC: Cross-Agent Task Migration ("Resume with a different agent")

**Status:** Draft (v2 — post round-1 critic review; design pivoted from
reopen-and-mutate to linked continuation task)
**Date:** 2026-08-12
**Author:** Jean Ibarz (with Claude)

---

## Problem

A developer runs several tasks under one coding agent — say Grok Build — and
that agent's provider goes away mid-flight: a weekly/usage quota is exhausted, a
subscription limit trips, a region outage hits, or the vendor rate-limits the
account. Every in-flight task under that agent stalls at once. Kookr's existing
recovery machinery cannot help, because the *agent itself* is unavailable — not
the terminal, not the machine.

The developer still has quota on a **different** agent (Claude Code, Codex CLI).
They want to take the interrupted work and continue it there — ideally in one
motion for a whole batch, not task-by-task by hand — and optionally make that
other agent the new default so freshly launched tasks also use it until the
first agent's quota resets.

Kookr has three adjacent capabilities but none solves this:

1. **Restore lost agent sessions** (`rfc-restore-lost-agent-sessions.md`, Draft)
   forks the *same* provider's conversation back into the *same* task and agent
   (`claude --resume --fork-session` / `codex fork`). Explicitly single-task and
   explicitly not cross-agent. You cannot fork a Grok conversation into Claude.
2. **Default agent selection** (`rfc-default-agent-selection.md`, Accepted)
   already persists `settings.defaultAgentType` and resolves it at launch — the
   mechanism the "make it default" toggle reuses — but it only affects *new*
   launches, not the already-interrupted backlog.
3. **Crash recovery** (`crash-recovery.ts`) relaunches dead sessions under the
   task's stored agent via provider fork. Same-agent, automatic, not a
   user-triggered batch choice.

The missing capability is a **user-triggered, batchable, cross-agent
migration**: continue interrupted tasks under a *different* chosen agent, with an
optional "and make it the default" toggle.

## The core distinction

Kookr already distinguishes *terminal liveness* from *conversation
recoverability* (restore RFC). This RFC adds a third axis:

> **conversation-preserving restore** (same vendor, fork the transcript) is not
> the same thing as **context-handoff migration** (different vendor, transplant
> the *work*, not the *conversation*).

Cross-vendor conversation state is **not portable** — there is no supported way
to load a Grok Build conversation into Claude Code. So migration cannot be a
provider fork. The genuinely portable, **attributable** state is:

- the task's **intent**: `userPrompt` + `criteria`; and
- any **already-persisted, vendor-neutral progress digest** on the task
  (`task.completionDigest`, when present) — a summary of what the agent did.

The task's **checkout** (`task.cwd`) is *context*, not an attributable snapshot.
The round-1 consensus attack (verified against the real stores, see "Consensus
attack" below) falsified an assumption every critic had inherited from an earlier
draft: that each task's `cwd` is an isolated per-task worktree holding that
task's work. It is not — in this backlog **833 tasks share 13 cwds; 103 of 105
migratable Grok candidates share their checkout with other tasks and none is a
dedicated git worktree.** On a shared branch the git commit history is the
*branch's* history, not the interrupted session's work, so a brief that labels
"recent commits" as "what the interrupted agent produced" **fabricates
attribution**. The corrected brief therefore does not claim commit attribution;
it leads with intent + digest and treats the working tree honestly as a possibly
shared checkout (§2).

Migration **reconstructs a continuation brief** from the attributable state and
launches a **fresh session under the new agent in the same checkout**. This is
how a human hands work from one agent to another; the RFC makes it a
first-class, auditable operation.

## Design pivot from v1 (why a *new task*, not a reopened one)

The v1 draft proposed reopening the interrupted task, overwriting its
`agentType`, and relaunching via `launchFreshTaskSession`. Round-1 review
falsified that approach against the code, from five independent angles:

- **`launchFreshTaskSession` bypasses all backpressure, dedup, and
  effort/model validation** (`launch-service.ts:954`); only the *new-task* path
  `launchTaskCore` enforces them. A batch reopen would stampede the target
  provider (failure-mode-analyst).
- **Overwriting `task.agentType` corrupts the cost/outcome comparison ledgers**,
  which aggregate by `task.agentType` (`outcome-ledger.ts`,
  `cost-comparison-aggregator.ts`) — a task 90% done by Grok would be credited
  entirely to Claude (socratic-challenger, verified).
- **A failed reopen leaves `agentType` mutated with no compensation**, so later
  crash-recovery relaunches under the wrong agent (boundary-critic,
  failure-mode-analyst).
- **`registerNewAgent` re-registers every non-terminal session** on a reopened
  task, reviving the "ghost agent" bug restore was designed to avoid
  (boundary-critic).
- **The whole durable-attempt state machine was a copy of restore's**, whose
  only reason to exist (`uncertain`) this RFC explicitly deletes
  (design-minimalist, boundary-critic).

**Resolution:** migration **creates a new task that continues the work**, linked
to the interrupted one, launched through the ordinary task-creation path. The
original task is left as an immutable historical record and marked with a
pointer to its successor. This:

- inherits real backpressure/dedup/validation for free (it *is* the new-task
  path);
- never touches `task.agentType`, so ledgers stay correct and the operation is
  naturally **reversible** (when Grok quota resets, just launch new Grok tasks —
  the migrated task is a separate record);
- needs **no durable attempt state machine** — a continuation task is an
  ordinary task that existing reconcile/crash-recovery already handle;
- makes lineage a simple task-level pointer, not a parallel session schema.

This is the v1 draft's "Alternative F" — now the chosen design, because the
review proved the "reuse the reopen path" instinct was reusing the wrong seam.

## Requirements

### Functional

1. Kookr SHALL classify each task as `migratable` or give a stable
   `not_migratable` reason (status not migratable, live session exists, missing
   cwd, cwd gone, git unavailable, target agent unavailable, same-agent (use
   restore), already migrated, worktree contended, workflow owner unsupported).
2. Kookr SHALL let the user choose the **target agent** from server-advertised
   agent types.
3. Kookr SHALL migrate a **single** task or **all currently-migratable** tasks
   (optionally filtered by source agent, e.g. "all Grok tasks").
4. A migrate SHALL create a **new continuation task** under the target agent, in
   the interrupted task's worktree, with a reconstructed continuation brief, and
   record a two-way lineage link between the two tasks.
5. Kookr SHALL re-resolve `effort`/`model` against the **target** agent; source
   levers the target does not accept SHALL be dropped, not passed through.
6. Batch migrate SHALL create continuation tasks through the ordinary launch
   path so existing backpressure applies (queue at capacity; bounded, clearly
   labelled rejection past the pending cap).
7. The user MAY set the target agent as the new default in the same action; this
   SHALL write `settings.defaultAgentType` through a shared settings-update path
   that preserves validation, audit, and snapshot broadcast, and SHALL respect
   existing guardrails (remote-chat Codex opt-in, round-robin cursor).
8. Explicit per-task migration SHALL be available via CLI and GUI with identical
   server semantics.

### Safety and operability

1. Batch migrate SHALL be supervisor-gated and idempotent: a task already
   migrated (has a live successor) SHALL NOT be migrated again
   (`already_migrated`); an in-process lock SHALL prevent concurrent
   double-migrate of the same task.
2. Migratability SHALL be re-checked at execution time with a **live backend
   liveness probe** (not a stale read-model), reusing the dedup path's probe.
3. Within one batch, tasks that **share a worktree** SHALL NOT both migrate;
   Kookr SHALL migrate one per worktree and block the rest
   (`worktree_contended`).
4. `setAsDefault` SHALL be applied only when the target agent passes preflight
   **and** at least one migration succeeded; otherwise `defaultUpdated:false`
   with a reason.
5. Migrating a **user-cancelled** task SHALL require an explicit opt-in in both
   single and batch scopes (cancelled work may have been abandoned on purpose).
6. Migration SHALL emit structured audit events (per-task migrated / blocked,
   default-updated) with a correlation id.

## Design

### 1. Migratability classification

A pure `classifyMigration(task, targetAgent, ctx)` in
`src/core/migration/migratability.ts`. `ctx` carries a **pre-resolved**
`Map<AgentType, AvailabilityResult>` (computed once per request from the adapter
capability cache, not per-task I/O) and a `liveSession(taskId): boolean` probe
so the function stays pure/testable while execution-time callers pass a real
backend probe.

```ts
type NotMigratableReason =
  | 'status_not_migratable'   // completed, or open/pending (never ran under the agent)
  | 'live_session_exists'     // a session is actually alive (live-probed)
  | 'missing_cwd' | 'cwd_gone' | 'git_unavailable'
  | 'missing_intent'
  | 'target_agent_unavailable'
  | 'same_agent_use_restore'  // target == source; route to restore instead
  | 'already_migrated'        // task already has a live successor
  | 'worktree_contended'      // another selected task shares this cwd (batch only)
  | 'workflow_owner_unsupported'; // Ralph loops own their own relaunch
```

Candidate statuses: `terminated`, `cancelled` (opt-in), and `inProgress` with no
live session (live-probed; the source is terminated first, see §3). **`pending`
and `open` are excluded** — they never ran under the agent, so there is nothing
to continue; the user changes the default and relaunches instead.

`cwd` authority: classification and the git summary both read **`task.cwd`** (the
value the launch path actually uses); per-session `gitBranch` is advisory
context only. `git_unavailable` (cwd exists but is not a usable git worktree) is
distinct from `cwd_gone`.

The classifier also returns an advisory `worktreeShared: boolean` (not a block):
true when `task.cwd` is used by more than one task in the store or the session is
not a dedicated git worktree (`gitIsWorktree !== true`). It does not disqualify a
task — the consensus attack showed ~98% of the real backlog is shared, so hard-
blocking would make the feature useless for its own motivating user — but it (a)
drives the honest brief framing (§2) and (b) is surfaced in the `migratable`
listing and CLI dry-run so the user sees which migrations carry a clean per-task
tree vs a shared checkout. A `--only-isolated` CLI flag / dialog filter lets a
cautious user restrict to `worktreeShared === false`.

### 2. Continuation brief reconstruction

`buildContinuationBrief(task, worktree)` in
`src/core/migration/continuation-brief.ts`, assembled to be **honest about
attribution** (consensus-attack fix):

- **Intent** (attributable, portable): `task.userPrompt` (preferred) or
  `task.prompt`, plus `criteria`. This is the load-bearing content. (POC: all 105
  real Grok candidates have a clean `userPrompt`.)
- **Progress digest** (attributable): `task.completionDigest` when present — an
  already-persisted, vendor-neutral summary of what the agent did/attempted
  (`completion-digest.ts`). Cheap, format-agnostic, and genuinely tied to this
  task. Included when available.
- **Working-tree state** (context, NOT attributed to the session): a bounded,
  read-only `git status --porcelain` of *uncommitted* changes only. It is
  labelled honestly — when the checkout is shared (§1 `worktreeShared`), the
  brief says "these uncommitted changes are in a shared checkout and may include
  unrelated in-progress work — verify before assuming they belong to this task."
  The brief does **not** present commit history as "what the interrupted agent
  produced" (that attribution is false on a shared branch). Detached HEAD, dirty
  tree, and non-repo degrade to "assess the working tree before editing."
- **Handoff framing**: explicit instruction that this is a *continuation* of the
  named intent under a new agent after the previous agent (named) was
  interrupted, and that it must assess current state before changing anything.

Rationale: the consensus attack showed the worktree is usually a shared,
long-lived checkout, so the brief's value comes from the **intent + digest**, not
from a git snapshot. For the minority of tasks in a dedicated worktree
(`worktreeShared === false`), the same brief is simply more precise because the
uncommitted changes there *are* likely this task's.

Raw vendor transcript parsing is **not** used (deferred, Phase 2). The brief is
delivered via the adapters' existing post-start input mechanism, never on argv.

### 3. Migration as a linked continuation task

`migrateTask(task, targetAgent, opts)` (a use-case method, sited next to
`batchAbortTasks` in `src/server/use-cases/task-lifecycle-commands.ts`; no new
god-service):

1. **Guard**: acquire an in-process per-task lock; re-run `classifyMigration`
   with a live probe; bail with the blocked reason if not migratable.
2. **Quiesce the source** if `inProgress` with a dead session: `terminateTask`
   it first (normalizes `lastStatus`, so no ghost session survives).
3. **Create the continuation task** through the ordinary task-creation +
   launch path (the same code behind `POST /api/tasks`): `prompt` = continuation
   brief, `agentType` = target, `cwd` = `task.cwd`, `userPrompt` =
   `task.userPrompt`, `criteria` = `task.criteria`, `migratedFromTaskId` =
   `task.id`, `migratedFromAgentType` = `task.agentType`, and an
   `idempotencyKey` derived from `migrate:${task.id}:${targetAgent}`.
4. **Link back**: set `task.migratedToTaskId` = new task id (happens-before the
   launch is observable, so a crash cannot silently allow a second migrate — and
   the derived `idempotencyKey` de-dupes even if the marker write is lost).
5. **Result**: `{ taskId, outcome: 'migrated'|'queued'|'blocked', reason?,
   newTaskId? }`. `queued` is the ordinary at-capacity pending outcome;
   `blocked: queue_full` is the bounded past-pending-cap rejection.

Lineage fields (task-level, additive; no session schema change):

```ts
interface Task {
  migratedFromTaskId?: string;   // on the continuation task
  migratedFromAgentType?: AgentType;
  migratedToTaskId?: string;     // on the interrupted source task
}
```

Crash safety needs **no new machinery**: the continuation task is an ordinary
task; if the server dies between create and attach, existing reconcile /
crash-recovery treat it exactly like any other freshly-launched task. The only
migration-specific durable state is the two link fields.

### 4. Batch scope, worktree safety, and result shape

```ts
type MigrateScope =
  | { kind: 'ids'; taskIds: string[] }
  | { kind: 'all'; fromAgent?: AgentType; includeCancelled?: boolean };
```

The server resolves `all` to the current migratable set (optionally filtered by
`fromAgent`), then **de-duplicates by `cwd`**: at most one task per worktree
migrates in a batch; the rest are `worktree_contended` (they can be migrated in a
later run once the first continuation is done with the tree). Each surviving
candidate runs through `migrateTask`; backpressure from the ordinary launch path
bounds concurrency, so migrating 100 tasks does not spawn 100 agents — excess
become `queued`, and past the pending cap they are `blocked: queue_full` (re-run
to drain). The response is per-task so CLI/GUI render a mixed result.

### 5. "Set as new default" (shared settings path)

`setAsDefault:boolean`. When true and the target passed preflight and ≥1
migration succeeded, the server writes `settings.defaultAgentType = targetAgent`
through a **shared** `applyDefaultAgentUpdate(deps, targetAgent, actor)` helper
extracted from the `PUT /api/settings` route so the write keeps its
validation + audit-log append + snapshot broadcast (today those live inline in
the Hono handler; calling `settings.update()` directly would skip audit and
broadcast — boundary-critic). Existing guardrails (remote-chat Codex opt-in,
round-robin cursor preservation) are unchanged. `defaultUpdated:false` carries a
reason when suppressed.

### 6. API

```http
POST /api/tasks/migrate            (supervisor-gated)
{
  "scope": { "kind": "ids", "taskIds": ["..."] } |
           { "kind": "all", "fromAgent": "grok-build", "includeCancelled": false },
  "targetAgent": "claude-code",
  "effort": "high",        // optional, re-validated against target
  "setAsDefault": false
}
-> 200 {
  "targetAgent": "claude-code",
  "defaultUpdated": false,
  "defaultUpdateReason": null,
  "results": [
    { "taskId": "...", "outcome": "migrated", "newTaskId": "..." },
    { "taskId": "...", "outcome": "queued" },
    { "taskId": "...", "outcome": "blocked", "reason": "worktree_contended" }
  ]
}

GET /api/tasks/migratable?targetAgent=claude-code&fromAgent=grok-build
-> 200 { "candidates": [ { "taskId","name","cwd","fromAgent","eligible","reason?" } ] }
```

Mixed per-task outcomes are still `200` (detail is per-task). `400` malformed,
`403` supervisor gate, `409` single-task target already migrating.

### 7. CLI

`kookr migrate` (thin HTTP client, dispatch branch in `bin/kookr.js`, module
`src/cli/kookr-migrate.ts`):

```txt
kookr migrate --to claude-code [--from grok-build] [--all | <taskId...>]
              [--include-cancelled] [--set-default] [--dry-run] [--yes]
              [--effort high]
```

`--dry-run` calls `/api/tasks/migratable` and prints the plan (candidates,
eligibility, brief preview) without launching. `--all --from grok-build --to
claude-code --set-default` is the headline flow. Without `--yes`, prints the plan
and asks to confirm. A same-agent target prints the blocked reason plus the
restore API hint (restore has no CLI surface — an acknowledged CLI-only gap).

### 8. GUI

Mirroring `AbortActiveButton` (`FindingsPanel.tsx:1539`) and the existing
per-task actions in `DetailPanel.tsx`:

1. A **"Migrate interrupted…"** control-room button opens a dialog showing the
   migratable set (from `/api/tasks/migratable`), a **target agent** picker
   (`AgentTypeSelector`), an optional **source-agent filter** ("only Grok
   Build"), an **include-cancelled** toggle, and a **"Make this the default
   agent"** checkbox. V1 uses the **`all` (optionally filtered) scope** — no
   per-row checkbox multi-select (design-minimalist: the evidenced need is
   whole-agent migration; arbitrary partial-batch can come later).
2. A per-task **"Migrate to…"** action in `DetailPanel.tsx` for the single-task
   case, next to restore/relaunch.

Mutations call `fetch('/api/tasks/migrate')` (reads already use `fetch`);
mixed-result toast shows per-task outcomes. On success the continuation tasks
appear as active under the new agent, linked to their sources.

Concrete dialog layout should be chosen from mockup variants before build (per
`ui-mockup-variants`); this RFC fixes behavior and placement, not pixels.

## Relationship to restore (`rfc-restore-lost-agent-sessions.md`)

| | Restore | Migrate (this RFC) |
|---|---|---|
| Agent | same | different (user-chosen) |
| Mechanism | provider fork (`--resume`/`fork`) | new continuation task, fresh launch |
| Preserves | vendor conversation | worktree + intent + digest |
| Task identity | same task | new linked task; source kept as history |
| Scope | single | single / all(-from-agent) |
| Durable attempt state | yes (has `uncertain`) | none (ordinary task lifecycle) |

If the user targets the **same** agent and a fork is possible,
`classifyMigration` returns `same_agent_use_restore` and the GUI routes to
restore. A small shared helper `isForkEligible(session)` (owned by the restore
service, imported by the classifier) decides fork-possibility so the two
features agree instead of duplicating the check.

## Files To Change

- `src/core/migration/migratability.ts` — classifier + reasons (new).
- `src/core/migration/continuation-brief.ts` — brief + read-only git summary (new).
- `src/core/task-read-model.ts` — `migratedFromTaskId`, `migratedFromAgentType`,
  `migratedToTaskId`.
- `src/core/tasks.ts` — set/read lineage links; `createTask` accepts the lineage
  + `migratedFromAgentType`.
- `src/server/use-cases/migrate-tasks.ts` — `migrateTasks` (batch) +
  `resolveMigratable` + per-task `migrateOne`. **As implemented** this landed as
  a focused new use-case module rather than methods inside
  `task-lifecycle-commands.ts` (the batch/scope-resolution + probe surface was
  cleaner standalone; it still avoids a god-service and reuses the launch path).
- `src/server/settings-service.ts` — shared `applyDefaultAgentUpdate`
  (validate + persist + audit + broadcast). **As implemented** this is a new
  helper the migrate path calls; the `PUT /api/settings` route keeps its own
  inline sequence (it validates the whole settings object), so the route was not
  refactored in this PR.
- `src/server/routes/task-routes.ts` — `POST /api/tasks/migrate`,
  `GET /api/tasks/migratable` (the GET is registered before `/api/tasks/:id` to
  avoid param shadowing).
- `bin/kookr.js` + `bin/kookr-migrate.js` — CLI command. **As implemented** the
  CLI is a plain-JS `bin/` module (matching sibling `bin/kookr-spawn.js` /
  `bin/kookr-drain.js` that share its dispatch), not `src/cli/kookr-migrate.ts`.
- `src/frontend/components/FindingsPanel.tsx` — Migrate dialog + button.
- `src/frontend/components/DetailPanel.tsx` — per-task "Migrate to…".
- `docs/architecture.md`, `docs/features.md` — document migration.

## Edge Cases

- **Live session.** Live-probed at execution → `live_session_exists`; never
  migrate an actually-running task.
- **cwd removed / not a git repo.** `cwd_gone` / `git_unavailable`; brief for the
  latter degrades to "assess the tree". No worktree recreation.
- **Grok task, no transcript.** Fine — brief uses intent + digest + git.
- **Target binary missing.** `target_agent_unavailable` via preflight; no silent
  fallback.
- **Source effort/model invalid for target** (Grok has no effort levels). Dropped.
- **Two tasks share a worktree.** One migrates; others `worktree_contended`.
- **Batch exceeds pending cap.** Excess `queued`, then `blocked: queue_full`;
  re-run to drain (not a stampede, not silent truncation).
- **Same agent + fork possible.** `same_agent_use_restore`; route to restore.
- **Ralph loop.** `workflow_owner_unsupported`.
- **Already migrated.** `already_migrated` (source has a live successor).
- **`setAsDefault` but all migrations blocked / target preflight fails.** Default
  not written; `defaultUpdated:false` + reason.
- **Cancelled source.** Requires `--include-cancelled` / the dialog toggle in
  both scopes; audit records that a user-cancelled task was continued.
- **Crash mid-migrate.** Continuation is an ordinary task; existing recovery
  handles it. `idempotencyKey` + `migratedToTaskId` prevent a duplicate.
- **Cost/outcome ledgers.** Unaffected — source keeps its `agentType`; the
  continuation is credited to the target. History stays truthful per agent.

## Phase 2 (named follow-ups, not built in V1)

Each names the shipped module it would reuse, so these are scoped slices, not
vapor (ambition-amplifier):

1. **Proactive one-click prompt** (not autonomous failover): when
   `quota-adapter.ts` / `circuit-breaker.ts` signal a provider is exhausted and
   N same-agent tasks land `terminated` in a window (`reconciliation.ts` already
   tallies this), push a dismissable quick-action
   (`src/shared/contracts/quick-action.ts`, already a shipped UI pattern) —
   "Migrate N stalled Grok tasks to Claude?" — that calls this RFC's endpoint.
   Adds a *trigger*, not a new mutation.
2. **Richer activity digest in the brief**: extend the digest beyond
   `completionDigest` using the normalized `AgentEvent` stream
   (`agent-events.ts`, `completion-digest.ts`) — the "what did the old agent get
   stuck on" signal git cannot express. Feasibility gate: confirm events survive
   session death / restart (today wired only to Ralph completion).
3. **Reversible default**: store `previousDefaultAgentType` + `overrideReason`
   when `setAsDefault` fires, so a later "auto-revert when the source recovers"
   feature has the data (today `defaultAgentType` is a bare scalar).
4. **Per-project default**: an optional `ProjectConfig.defaultAgentType` in the
   existing resolution chain (`launch-service.ts:647`), so migrating one
   project's backlog doesn't repoint every project.
5. **`kookr migrate --revert`**: use `migratedFromTaskId`/`migratedToTaskId`
   lineage to reconstruct the reverse batch once the source recovers.

## Alternatives Considered

### A. Extend restore to be cross-agent
Rejected. Restore's contract is a conversation-preserving provider fork;
cross-vendor fork is impossible and overloading restore blurs a reviewed
boundary. Migration shares helpers (`isForkEligible`) but stays distinct.

### B. Replay the raw original prompt under the new agent
Rejected as default. Discards on-disk work; can repeat destructive side effects.
The continuation brief frames the work as *continue* and points at the worktree.

### C. Reopen the interrupted task and swap its `agentType`
**Rejected after round-1 review** (was the v1 draft). Bypasses backpressure via
`launchFreshTaskSession`, corrupts per-agent cost/outcome ledgers, needs
`agentType` rollback on failure, revives the ghost-session bug, and forces a
copied durable-attempt state machine. The linked-continuation design avoids all
of these.

### D. Summarize the source vendor transcript into the brief
Deferred (Phase 2.2). Couples V1 to vendor transcript formats (Grok's is
unproven/absent). `completionDigest` + git are vendor-neutral and available now.

### E. Automatic quota-triggered failover
Deferred (Phase 2.1). V1 is explicit; a proactive one-click prompt (not
autonomous launch) is the right next step and reuses shipped quota/circuit-breaker
signals.

### F. A brand-new spawn primitive
Rejected. Migration composes the existing task-creation + launch path; a parallel
spawn path would duplicate backpressure, dedup, and validation.

## Test Plan

### Unit
- `classifyMigration` returns each stable reason for the right shapes; excludes
  `completed`/`pending`/`open`; gates `cancelled` behind opt-in; uses the injected
  live probe; `same_agent_use_restore` via `isForkEligible`.
- `buildContinuationBrief` includes intent + digest + git; never reads a
  transcript; degrades on detached/dirty/non-repo; bounds git output.
- Effort/model re-resolution drops levers invalid for the target.
- Lineage: continuation carries `migratedFromTaskId`/`migratedFromAgentType`;
  source carries `migratedToTaskId`; source `agentType` unchanged.

### Server / integration
- `POST /api/tasks/migrate` `ids` and `all(+fromAgent)`; per-task outcomes;
  worktree-contended dedup; over-cap → `queued` then `blocked: queue_full`.
- Continuation created via the ordinary path (backpressure/dedup/validation
  observed); source ledger attribution unchanged.
- `setAsDefault` writes through the shared helper (audit + broadcast present),
  survives restart, suppressed when all fail / preflight fails; remote-chat guard
  intact.
- Supervisor gate; live-probe at execution; in-process double-migrate lock;
  `already_migrated` on a second attempt.

### Frontend
- Migrate dialog lists candidates; target picker + default checkbox +
  include-cancelled wired; mixed-result toast; per-task "Migrate to…" routes
  single migrate; continuation appears linked under the new agent.

### Manual / E2E
- Take a real interrupted Grok task with useful remaining work; `kookr migrate
  --to claude-code --dry-run` then real run; verify a continuation task launches
  under Claude in the same worktree, resumes, and finishes; source shows
  "migrated to <id>"; ledgers unchanged.

## Open Questions

1. What is a trustworthy provider-exhaustion signal to gate Phase 2.1
   (`quota-adapter`/`circuit-breaker` thresholds)?
2. Do the `AgentEvent`-derived digests survive session death / restart enough to
   enrich the brief (Phase 2.2 feasibility)?
3. Should batch migrate offer a stagger beyond pending-queue promotion to be
   gentle on the target provider?

## Critic Feedback Incorporated

### Round 1 — 2026-08-12

- **failure-mode-analyst** — proved `launchFreshTaskSession` bypasses
  backpressure/dedup/validation; forced the pivot to the new-task path; drove
  worktree-contention handling, `queue_full` outcome, live-probe-at-execution,
  `setAsDefault` gating, git-preflight, and cancelled opt-in in both scopes.
- **socratic-challenger** — task-identity-vs-work-identity (→ new linked task);
  found the cost/outcome ledger corruption from `agentType` mutation; raised
  reversibility and clean-tree concerns (→ handoff framing, no hard gate;
  measured: 105/105 candidates have clean intent, 27/105 lightly-dirty trees).
- **design-minimalist** — cut the durable attempt state machine (reuse existing
  dedup/`IdempotencyLedger`/`reconcile()`), dropped `migrationBriefKind` and
  per-row multi-select for V1, sited migration in `task-lifecycle-commands.ts`.
- **boundary-critic** — exposed the settings-path leak (audit/broadcast live in
  the route → shared `applyDefaultAgentUpdate`), the ghost-session registration
  risk, `cwd` authority ambiguity (→ use `task.cwd`), and named `isForkEligible`.
- **ambition-amplifier 2026-08-12: novel finding** — proactive one-click prompt,
  activity-digest brief, reversible/per-project default, `--revert`; captured as
  named Phase 2 slices reusing shipped modules.
- **Adversarial pair (ambition vs design-minimalist):** resolved in favor of
  **design-minimalist** for the V1 surface — ship the clean manual migration now
  — while adopting ambition's cheapest correctness win (fold the existing
  `completionDigest` into the brief) and recording its larger ideas as scoped
  Phase 2, because a verified, deployed feature that unblocks the actual
  quota-exhaustion problem outweighs a broader design that risks not landing.
- **Intent preservation check:** the user's load-bearing asks — resume
  interrupted work under a *different* agent, in single/batch/all scopes, choose
  the agent, optionally make it the default, in CLI *and* GUI — are all preserved.
  The one silent-looking pivot (new task vs literally the same task record) is
  surfaced explicitly here and in Alternative C as a deliberate tradeoff, not a
  quiet substitution; the user's work is still continued in the same worktree.

### Consensus attack — 2026-08-12

`general-purpose 2026-08-12: consensus-attack — novel finding (design corrected).`

The attack found a shared blind spot all five critics inherited from the
framing: **per-task worktree isolation**. The probe (run against the real stores,
the workflow's "route an empirical attack to a probe, not more debate" rule)
confirmed it decisively — 833 tasks share 13 cwds; **103 of 105 migratable Grok
candidates share their checkout with other tasks and 0 are dedicated git
worktrees.** Consequence: a brief presenting shared-branch commit history as
"what the interrupted agent produced" fabricates attribution.

Design corrected rather than iterated further (empirical attacks terminate, they
do not reopen rounds): the brief now leads with **intent + `completionDigest`**
(genuinely attributable), reports only *uncommitted* working-tree state with an
honest shared-checkout caveat, and drops commit-history-as-progress; the
classifier surfaces an advisory `worktreeShared` flag and a `--only-isolated`
filter. The feature's value proposition is restated honestly: migration re-drives
a task's **intent** under a new agent in its original checkout, not a transplant
of an isolated per-task snapshot. This shrinks the "clean handoff" headline but
makes the shipped behavior truthful — and the E2E acceptance run will use a task
with genuinely resumable intent to validate productive resumption (the value
claim the POC's constructibility check did not, by itself, establish).
