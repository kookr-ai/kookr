# RFC: Per-project automation pause

**Status:** Draft (v4 — post round-3 revision, ready for user review)
**Date:** 2026-09-02
**Author:** Jean Ibarz (with Grok)
**Evidence pack:** `docs/rfc/rfc-per-project-automation-evidence.md` (treat as claims to verify)
**Related:** #1710 (global SAFE MODE), #2672 (orchestration pause), #2085 (fail-closed settings), #2899 (post-recovery queue fill)

---

## Problem

The operator can halt **all** Kookr automation with one Settings toggle (SAFE
MODE / `automationKillSwitch`). That is the right lever for a node-wide
incident. It is the wrong lever for "Lucy is eating the slot budget tonight;
leave kb-scout and Kookr deploy-convergence running."

This lever is **the next autonomous fire**, not occupancy. In-flight Lucy
tasks keep their slots until they complete or the operator aborts them
(existing UI). That is SAFE MODE parity, stated up front so "pause Lucy"
is not read as "kb-scout runs in five minutes." If the job tonight is
"free the cap now," abort the live Lucy tasks after flipping the pause.

The only scoped alternative today is toggling each schedule's `enabled` bit.
On this node that is thirteen Lucy-remote schedules plus several bits that
already mean something else (operator hold, consecutive-failure auto-pause, a
Grok batch deliberately left off). Bulk-disabling Lucy would forget which
schedules were already off; turning Lucy back on would resurrect work that
should stay dark.

Projects have grown their own inner gates (Lucy `SCHEDULER_ENABLED`, kb-scout
`self_evol_window`, reason-at-home `STUCK.md`, LRA `autonomy.json`). Those stay
the right *product* kill switches. Agent actuation — schedules, supervisors,
batches — should pause from **one Kookr project control**, and every project's
agent loops should ride that control.

---

## Goals

1. Give each Kookr project a pause with the **same actuation effect as SAFE
   MODE**, scoped to that project: autonomous launches for the project halt;
   operator **Launch Task** / unparented `kookr spawn` continue. Dashboard
   **Run Now** on a schedule is a schedule fire and skips (SAFE MODE parity).
2. Leave each schedule's `enabled` / `operatorHold` / auto-pause state
   untouched. The project pause is a conjunction, not a rewrite.
3. Show the pause on the project (drawer + sidebar), not only in Settings or
   the schedules list.
4. Make kb-scout's daily reflection pause with kb-scout (it lives under
   `~/.claude` / dotclaude today), without a flag-day on every schedule.

---

## Non-Goals

- Do not stop a project's **product runtime** (Lucy bot/newswire/price ticker,
  `kb serve`, LRA n8n/llama, a live RAH GPU run). Kookr pauses agent
  actuation. Inner product switches stay in those repos.
- Do not replace the global kill-switch or drain mode.
- Do not bulk-flip `schedule.enabled`. Do not comment out OS crontab.
- Do not make `kookr orchestration pause` per-project. That command is the
  named wrapper over **global** SAFE MODE plus the quota-pause ledger.
- Do not make the per-project lever **stricter** than SAFE MODE in v1 (do not
  block `kookr spawn` children or pipeline-starvation API kicks here). Closing
  that hole belongs in a follow-up that changes **both** levers together.
- Do not invent checkout-scoped identity for `kookr-prod` vs `kookr` in v1.
  One git-remote project id; the fine lever for "pause issue-batch, keep
  deploy-convergence" remains per-schedule `enabled`.
- Do not SIGTERM in-flight tasks when a project is paused.

---

## Round-1 empirical corrections

v1's evidence pack was grepped from a sibling checkout, not this tree
(`origin/main` `5b1161f9`). These claims were **false** and drove the rewrite:

| v1 claim | Live on this tree |
|---|---|
| `isAutonomousLaunchSource` is `schedule \| idle-refinery` | Also `post-recovery` (`src/core/automation-kill-switch.ts:33-39`, #2899) |
| SAFE MODE skip at `schedule-runner.ts` ~812 | Skip is ~947–967; ~812 is playbook resolution |
| Persist via `PUT /api/projects` | Write is `POST /api/projects/configs` |
| Drawer can follow `autoSyncOnManualLaunch` | That boolean is REST-only; absent from WS `projectConfigPartial` |
| `getProjectId` can be "unresolved" | Always returns a string (git id or `local/<basename>`) |
| kb-scout reflection cwd `~/.claude` is identity-less | Origin is `github.com/jeanibarz/dotclaude` |

---

## Requirements

- **R1.** `ProjectConfig` SHALL accept optional `automationEnabled`. Omitted or
  `true` = allowed. Explicit `false` = paused. Existing rows stay allowed.
- **R2.** Autonomous actuation for a project SHALL proceed only when global
  SAFE MODE is disengaged **and** `automationEnabled !== false` for that
  project **and** (for a schedule fire) the schedule is enabled and not held.
  No term rewrites another term.
- **R3.** Autonomous sources SHALL be whatever `isAutonomousLaunchSource`
  returns on this tree (`schedule`, `idle-refinery`, `post-recovery`). Do not
  restate a frozen two-source list. When that function gains a member, this
  gate SHALL apply to it via one shared predicate.
- **R4.** A paused project's due schedule fire SHALL record skip outcome
  `skipped_project_automation` / reason `project_automation`, **and** that
  outcome SHALL be added to every `skipped_safe_mode` consumer, including
  `DELIBERATE_SUPPRESSION_OUTCOMES` in `src/server/schedule-dead-man.ts`.
  Missing the dead-man set makes a Lucy pause look like starvation and
  self-heal. The schedule's `enabled` bit SHALL NOT change. Dashboard **Run
  Now** SHALL skip the same way SAFE MODE does (it goes through `fire()`).
- **R5.** Pause identity for a schedule SHALL be a **basename home map**
  (same pattern as `isSafeModeExemptSchedule`): `kb-scout-reflection.md` →
  `github.com/jeanibarz/kb-scout-evol`, else `getProjectId(schedule.cwd)`.
  No `Schedule.automationProjectId` field in P1. Two checkouts of the same
  remote share one pause. **Do not map the queue-feeder away from Lucy.**
  Follow-up: re-home the feeder to Kookr **and** skip paused *target* repos.
- **R6.** `getProjectId` always returns a string. "Unknown" is a Set miss
  (that id is not in the paused set) → do not skip. No `localPath` prefix
  fallback (it would match `/tmp` and `kookr` vs `kookr-prod`).
- **R7.** A non-boolean `automationEnabled` is dropped (same as every other
  invalid `ProjectConfig` field) → omit = allowed. Whole-file quarantine of
  `project-configs.json` remains **fail-open** (load `[]`, all projects
  allowed) plus a health/log warning. This file is an overlay bag, not the
  kill-switch; do not cargo-cult settings #2085 into a second global halt.
- **R8.** Writers are `POST /api/projects/configs` and WS `setProjectConfig`
  (field added to `projectConfigPartial` **and** the ConfigHandler patch
  list — do not cargo-cult `autoSyncOnManualLaunch`). Both go through
  `setConfig` (R15). A CLI that only edits the JSON file SHALL NOT be the
  design: the store is not file-watched. A `kookr project automation`
  HTTP-client subcommand is **delayed** until someone pauses from a
  terminal more than once; P1 is REST, P2 is the drawer.
- **R9.** `ProjectSummary` SHALL carry `automationEnabled` (default true
  when omitted) on **both** copies, **in the same slice as the gate** (not
  only P2 chrome). While paused, `configSeedsMembership` SHALL treat
  `automationEnabled === false` as a seed so untrack cannot delete a live
  pause. Unpause that leaves no other seeds may drop the row via the
  existing compact. No 409.
- **R10.** `ProjectConfigStore.setConfig` SHALL run
  `applyProjectAutomationTransition(prev, next, nowIso)`: stamp
  `automationPausedSince` on the true→false edge, clear it on false→true,
  preserve it on unrelated saves. Sanitize is prev-blind; the store is the
  only place that sees both.
- **R11.** `mayAutonomousActuate` lives next to `isAutonomousLaunchSource`.
  It takes `source`, `projectId`, `globalEnabled`, `pausedProjectIds`, and
  `safeModeExempt`. Polarity (`!== false` / Set membership) lives **inside**
  the function, not at callers. `safeModeExempt` bypasses **only** global
  SAFE MODE (R14). Callers: schedule `fire()`, provider-reset sweep,
  launch-service, idle-refinery **tick**, post-recovery **per-kick**,
  pipeline-starvation scout/kick (R17).
- **R12.** Schedule-runner resolves R5 **once**, skips if paused **before**
  calling `launchTask` (so `recordFireFailure` / `dispatch_failed` cannot
  auto-pause), and passes the same id as
  `LaunchTaskServerOptions.automationProjectId` (alongside `safeModeExempt`).
  Launch-service uses **only** that stamp for the project gate, never
  `opts.projectId` (scout target) and never a second `getProjectId(cwd)`.
  Missing stamp on an autonomous launch is a programming error in tests.
  Defense-in-depth errors use `AutomationKillSwitchError` with
  `code: 'project_automation'` (same class, extra code — not a new
  `err.name` that `mapErrorToReasonCode` would miss).
- **R13.** Post-recovery: do **not** short-circuit the whole tick when one
  project is paused. Gate each kick by `projectIdFromRepoSpecifier(candidate.repo)`.
  Global SAFE MODE may still suppress the whole tick.
- **R14.** Cross-repo orchestrator keeps its **global** SAFE MODE exemption.
  A **Kookr-project** pause SHALL skip it. A Lucy pause does not skip it.
- **R15.** Alias by **`localPath` string equality**, not `git remote` (so
  `setConfig` stays synchronous). A write of `automationEnabled` to any row
  is copied to every other in-memory row with the same `localPath`. The
  paused-id set is every `config.project` whose `automationEnabled === false`
  after that copy. Live `local/lucy` and `github.com/jeanibarz/lucy` share
  `/home/jean/git/lucy`, so POST to either pauses Lucy **and** lucy-l3
  (lucy-l3's `getProjectId` is the GitHub id). Projection: a `local/`
  summary SHALL read the same `automationEnabled` as its `localPath` sibling
  GitHub row when one exists.
- **R16.** Persistence allowlists that MUST all grow the field in the same
  PR, with one round-trip test (POST, WS, reload, unrelated notes patch all
  preserve `false` on `github.com/jeanibarz/lucy`): `ProjectConfig`,
  `sanitizeProjectConfig`, REST patch in `project-routes.ts`, WS
  `projectConfigPartial`, ConfigHandler whitelist.
- **R17.** `GET /api/health` SHALL include a block distinct from
  `safeMode`: the paused project ids, `automationPausedSince` per id, and
  an optional project-config load warning. `kookr status` / ops-digest
  SHALL print it. `safeMode.engaged=false` must not be readable as
  “automation is running.” Fire-time log:
  `[schedule] Skipping "<name>" — project automation paused (<projectId>)`.
  `mapErrorToReasonCode` SHALL inspect `error.code`, not only `error.name`.
- **R18.** Every autonomous launcher that calls `launchTask` SHALL pass
  `serverOpts.automationProjectId` (schedule-runner from R5; post-recovery
  and idle-refinery from `getProjectId` of their cwd/repo; provider-reset
  **per resume** from the originating schedule's R5). Missing stamp on an
  autonomous launch fails the launch in tests; production logs and refuses
  rather than guessing `opts.projectId`.
- **R19.** Pipeline-starvation scout/kick and post-resume refill stay
  `launchSource: 'api'` in this RFC (inherited SAFE MODE hole). Follow-up
  with descendant `kookr spawn` for **both** levers. Do not expand
  `isAutonomousLaunchSource` here. The Non-goal stands.
- **R20.** The paused-id set is a **live getter** from the in-memory
  `ProjectConfigStore` (same shape as `isAutomationEnabled()`), reread on
  every `fire()` / kick. Not a boot snapshot. Sanitize SHALL use
  `typeof automationEnabled === 'boolean'`, not a truthy check that would
  drop `false`. Missing `automationProjectId` stamp on an autonomous
  launch SHALL refuse in production (log + skip/throw), not only in tests.
  Provider-transient-retry and provider-reset per resume SHALL pass the
  stamp.

---

## Design

### 1. Conjunction, not bulk disable

SAFE MODE already asks "may this autonomous fire run?" at the schedule
runner and at `launchTask`. The per-project pause is the same question with
a project id.

Mutating `schedule.enabled` destroys hold/auto-pause/intentional-off
provenance; auto-re-arm would fight the pause; restore cannot replay prior
bits.

**Analogy.** A building has a master fire alarm (SAFE MODE) and per-floor
breakers (this RFC). You do not unscrew each bulb (`schedule.enabled`) to
darken a floor — you would lose which bulbs were already burned out.

**Where it breaks.** A bulb wired to the wrong floor follows that floor's
breaker. Live: kb-scout reflection cwd is `~/.claude` / dotclaude — R5's
basename map rewires that one playbook. The queue-feeder cwd is Lucy and
it *is* Lucy work (`spawnLeaves` default true against `jeanibarz/lucy`);
P1 lets it pause with Lucy on purpose.

### 2. Persistence

On `ProjectConfig`:

```ts
automationEnabled?: boolean;       // omit | true = allowed; false = paused
automationPausedSince?: string;    // ISO; omitted while allowed
```

On `Schedule` (optional, additive, not required for P1):

```ts
automationProjectId?: string;      // explicit pin; omit → basename map → cwd
```

P1 does **not** mutate live `schedules.json`. Reflection is covered by the
basename map. A future pin must round-trip `normalizeSchedule` / `create` /
`updateDefinition` or it will be stripped on reload.

Sanitize: non-boolean `automationEnabled` → in-memory `false` without
writing (R7). Persist in existing `project-configs.json`. No new file.

Polarity is `automationEnabled` (on by default). Kill-switch language stays
the global incident lever.

### 3. Predicate and identity

```ts
// src/core/automation-kill-switch.ts
export function mayAutonomousActuate(input: {
  source: TaskLaunchSource | undefined;
  projectId: string | undefined;
  globalEnabled: boolean;
  pausedProjectIds: ReadonlySet<string>;
  safeModeExempt?: boolean;        // bypasses global SAFE MODE only
}): 'allow' | 'safe_mode' | 'project_paused' | 'not_autonomous'
```

Fire-time in `schedule-runner.ts`, after global SAFE MODE, before the #2569
probe:

1. If the paused-id set is empty and project-config load is healthy, skip
   extra work.
2. Resolve R5 once. If paused → `skipped_project_automation` and **return**
   (never `launchTask`).
3. Pass `{ automationProjectId }` in `LaunchTaskServerOptions`.

`launchTask` defense in depth for idle-refinery / post-recovery /
starvation: `isAutonomousLaunchSource` + stamp paused →
`AutomationKillSwitchError` with `code: 'project_automation'`. Never a new
`err.name`. Never `launch_error`.

Idle-refinery: tick-level short-circuit when **Kookr** is paused (its cwd
is the server checkout; `umbrella-decompose.md` files issues in that
remote, not Lucy). Pausing Lucy does not stop it; that is correct.

Post-recovery: R13. Starvation: R17.

### 4. Skip vocabulary

New outcome `skipped_project_automation` is not local to two union files.
Required consumers (the live `skipped_safe_mode` set):

- `src/shared/contracts/schedule.ts` and `src/core/schedule.ts`
- `src/server/schedule-dead-man.ts` `DELIBERATE_SUPPRESSION_OUTCOMES`
- `src/server/schedule-runner.ts` `mapErrorToReasonCode`
- `src/server/schedule-service.ts` benign lists
- `src/frontend/components/SchedulesDialog.tsx`
- `src/frontend/components/ScheduleSection.tsx` (today paints SAFE MODE as
  `schedule-status-fail` — project pause SHALL render as a healthy skip)

A distinct outcome is kept so a Lucy pause is greppable without looking like
node-wide SAFE MODE. Reusing `skipped_safe_mode` was rejected: the dead-man
set is a one-line add, and lying in the ledger is worse than a missed
switch we will list in the PR.

### 5. UI

- Drawer: immediate toggle. Store-level R15 alias means the visible
  `local/lucy` row still pauses GitHub Lucy. Show "paused since" from
  `automationPausedSince` in the drawer, not a fourth banner chrome.
- Sidebar: paused mark when `automationEnabled === false`.
- Schedules copy: "skipped: project automation paused" (same healthy-skip
  paint as other deliberate suppressions; if SAFE MODE is currently
  `schedule-status-fail`, fix **both** in one case list).

### 6. Worked example (v2, after P1 pins)

Operator opens Lucy's project drawer, turns **Project automation** off.

- Next Lucy issue-batch tick records `skipped_project_automation`.
- Lucy orchestration supervisor does not launch.
- Lucy-l3 deploy-convergence also skips (same git remote).
- Queue-feeder **also skips** (Lucy cwd, no P1 pin — it is Lucy slot work).
- KB-Scout supervisor still fires. KB-Scout reflection still fires
  (basename map → kb-scout-evol, not dotclaude).
- Kookr deploy-convergence still fires.
- Post-recovery and pipeline-starvation kicks whose target is Lucy skip;
  kicks whose target is kb-scout still run.
- Manual Launch on Lucy still works. Dashboard Run Now on a Lucy schedule
  skips (SAFE MODE parity).
- Lucy Grok batch stays `enabled: false`.
- An in-flight Lucy supervisor may still `kookr spawn` children (inherited
  hole). Host cron `interaction-triage-nightly.sh` still `kookr spawn`s at
  03:15 until it becomes a Kookr schedule (named, not closed).

---

## Files to change

Core: `src/core/automation-kill-switch.ts` (+ tests), `src/core/schedule.ts`,
`src/shared/contracts/schedule.ts`, `src/shared/contracts/project-config.ts`,
`src/shared/contracts/project-summary.ts`, `src/core/project-summary.ts`,
`src/core/project-config-store.ts`, `src/shared/contracts/client-message-schema.ts`.

Server: `src/server/schedule-runner.ts` (skip + mapError), 
`src/server/schedule-dead-man.ts`, `src/server/schedule-service.ts`,
`src/server/launch-service.ts`, `src/server/idle-refinery-runner.ts` (only
if the launch gate is not enough — default: no tick fork),
`src/server/post-recovery-service.ts` (per-kick),
`src/server/routes/project-routes.ts` (`POST /api/projects/configs`),
WS ConfigHandler patch list, schedule store/validator for optional
`automationProjectId`.

Frontend: `ProjectDetailDrawer.tsx`, `ProjectSidebar.tsx`,
`SchedulesDialog.tsx`, `ScheduleSection.tsx`.

CLI: delayed (R8).

No live `schedules.json` mutation in P1. Basename map covers reflection.
Document the one-paragraph convention in `docs/configuration.md`.

---

## Edge cases

- **Global SAFE MODE + project pause.** Global wins the skip
  (`skipped_safe_mode`). Project pause is checked only when global
  automation is allowed.
- **kookr vs kookr-prod.** One project id. Pausing "Kookr" also skips
  deploy-convergence on the prod worktree. Fine lever: per-schedule
  `enabled`. Closed: no second identity scheme in v1.
- **Idle-refinery under a Lucy pause.** Continues; tick-short-circuit only
  when **Kookr** is paused (`umbrella-decompose.md` files in the server
  cwd's remote). Default off on this node.
- **Idea scouts hosted on kookr-prod cwd** (KB, local-research; currently
  off). They pause with **Kookr**, not with the scouted repo. Pin later if
  re-enabled; not P1 because they are off.
- **In-flight supervisor children.** Inherited SAFE MODE hole.
- **Pipeline-starvation scout/kick.** In R17 — treated as autonomous per
  target repo for both levers.
- **Host cron `kookr spawn`** (Lucy `interaction-triage-nightly.sh`). CLI
  launch, not gated by SAFE MODE today, not gated here. Follow-up or move
  that job to a Kookr schedule.
- **Whole-file project-config quarantine.** Fail-open + health warning
  (R7). Not a second SAFE MODE.
- **Corrupt boolean on one row.** In-memory pause, no disk rewrite, no
  global SAFE MODE.
- **macOS.** `getProjectId` already production on both OSes.

---

## Alternatives considered

### A. Bulk-set `schedule.enabled = false`

Rejected. Destroys provenance; auto-re-arm fights it.

### B. Disable OS cron

Rejected. The live fleet is Kookr's scheduler.

### C. Reuse `kookr orchestration pause` per project

Rejected. That surface is global SAFE MODE + quota ledger. Soft-quota
auto-resume must not lift a Lucy slot-budget pause.

### D. Key pause by cwd string, not project id

Rejected as the primary key. The sidebar unit is the project. Cwd is the
derivation input.

### E. Required `Schedule.projectId` / P1 pin of the queue-feeder (ambition r1)

Rejected. A flag-day on 27 rows is YAGNI. Pinning the feeder to Kookr so it
*keeps firing* while Lucy is paused leaves `spawnLeaves` eating Lucy slots
— the opposite of the motivating pause. P1 lets the feeder pause with Lucy.
Follow-up: re-home to Kookr **and** skip paused target repos. Reflection is
rewired by basename map, not a live JSON pin.

### F. Reuse `skipped_safe_mode` (minimalist)

Rejected. Ledger would lie; UI already has a SAFE MODE branch that would
show a Lucy pause as node-wide. New outcome + mandatory dead-man add is
cheaper than the operator confusion.

### G. Block descendant launches in v1 (ambition r1)

Deferred for in-flight `kookr spawn` children. Pipeline-starvation scout/kick
stays an inherited `api` hole in this RFC (R19); close it later for **both**
levers. R17 in v4 is the health/status digest of paused ids, not starvation.

### H. Fail-closed when identity is unknown

Rejected. `getProjectId` always returns a string; a Set miss must not halt
`local/tmp` because Lucy is paused.

### I. `localPath` prefix fallback

Rejected. Duplicate `local/lucy` vs GitHub Lucy, plus `/tmp` as a
`localPath`, make prefix match unsafe. R15 aliases the write instead.

### J. New `src/core/project-automation.ts`

Rejected. A `!== false` helper does not earn a sibling. Extend
`automation-kill-switch.ts`.

---

## Migration / rollout

1. Ship code. Omitted field → all projects allowed.
2. No live `schedules.json` mutation. Basename map covers reflection.
3. No backfill of `automationEnabled`.
4. Feature is opt-in (toggle off when needed). No flag.

## Implementation slices

- **P1 — Gate + live truth.** Fields, five allowlists, `setConfig` localPath
  sibling copy, `mayAutonomousActuate`, skip-before-launch + stamp on every
  autonomous launcher, launch-service `code`, post-recovery per-kick,
  dead-man set, reflection basename map, **health/status digest of paused
  ids**, `ProjectSummary.automationEnabled` on both copies, tests
  (`local/lucy` POST pauses GitHub Lucy; feeder pauses with Lucy; reflection
  does not; notes patch preserves `false`; mapError does not record SAFE MODE).
- **P2 — Surfaces.** Drawer toggle + "paused since", sidebar badge,
  schedules copy.
- **Follow-up:** re-home queue-feeder + skip paused targets; close in-flight
  `kookr spawn` children for **both** levers; move Lucy interaction-triage
  cron onto a Kookr schedule; optional checkout-scoped kookr-prod pause.

P1 is independently useful via `POST /api/projects/configs`.

---

## Open questions

None that block P1. Previously open:

1. Pausing Kookr skips `kookr-prod` deploy-convergence? **Yes**.
2. Queue-feeder pin in P1? **No** — it is Lucy slot work. Reflection is a
   basename map, not a live pin.
3. Orchestrator playbook honor for Lucy? **Not P1.**
4. Starvation kicks? **Follow-up** (inherited `api` hole). Health of
   paused ids is **in P1** (R17).

---

## Critic feedback incorporated

**Round 1 panel (N=5):** `boundary-critic`, `failure-mode-analyst`,
`design-minimalist`, `socratic-challenger`, `ambition-amplifier`.
`ambition-amplifier` 2026-09-02: novel finding (descendant launches and
required pins). `assumption-archaeologist`: not invoked (no ADR reasoning
being reversed).

**Adversarial pair:** Sided with **design-minimalist** against a required
`Schedule.projectId` flag-day and against making the per-project lever
stricter than SAFE MODE on child spawns. Sided with **ambition-amplifier**
that the queue-feeder / reflection pins are P1 (the motivating "pause Lucy,
leave the node feeding" story is false until they land) and that
post-recovery must be in the source set. Child-spawn / starvation blocking
is a named follow-up that should close the hole for **both** levers.

**Intent preservation check:** User asked for a per-project control with
similar effect to the global kill-switch, plus centralizing agent
automation on the Kookr surface. v2 still: conjunction not bulk-disable;
same autonomous sources as SAFE MODE (now including the live
`post-recovery` member); product runtimes out of scope; Kookr is the
control plane. The pivot "block descendants in v1" was presented as a
tradeoff and rejected so the lever stays similar to Settings.

Incorporated:

- Single `mayAutonomousActuate` owner; no sibling module; no restated
  two-source list (boundary, minimalist, failure-mode).
- `post-recovery` in R3; per-kick gate, not whole-tick suppress
  (failure-mode, boundary, ambition).
- Optional pin field exists; **v3 does not pin the feeder** (superseded by
  round 2). Reflection is a basename map.
- Same identity for runner and launch-service; never pause on
  tracked-projects `opts.projectId`; mapError must not auto-pause
  (failure-mode, socratic Q5).
- `POST /api/projects/configs`; WS schema + handler; CLI is HTTP; do not
  cargo-cult autoSync (socratic Q8, all).
- Duplicate `local/lucy` write alias (socratic Q4, failure-mode, boundary).
- Dead-man + both ProjectSummary copies + ScheduleSection healthy-skip
  (socratic Q10, boundary, failure-mode).
- Cut `localPath` prefix fallback; `getProjectId` always returns a string
  (minimalist, failure-mode).
- Timestamp owned by `setConfig` transition (boundary); kept despite
  minimalist cut because the banner needs "since" and the function already
  exists as a pattern.
- Close OQ1 (minimalist).
- Drop P3-as-SHALL; one docs paragraph.
- R11/G/OQ3 collapsed (failure-mode).

Rejected:

- Schedule tags instead of project id (socratic Q1) — sidebar unit is the
  project; pins handle the two exceptions.
- Reuse `skipped_safe_mode` (minimalist) — ledger would lie.
- Checkout-scoped kookr-prod pause in v1 (ambition) — fine lever exists.
- Block in-flight descendants in v1 (ambition r1). Starvation refill was
  pulled into v3 R17.
- Fail-closed unknown (ambition considered, RFC already H) — polarity kept.

`design-experimenter` 2026-09-02: round-1 empirical checkpoint. 13/13
claims CONFIRMED on this tree / live disk (live `:4800` HTTP hung; REST
probed in-process). Pack autonomous-source set and line numbers were
already rewritten in v2.

**Round 2 panel (N=5):** same five critics. `ambition-amplifier` 2026-09-02:
novel finding (starvation is a refill, not a descendant; launch-home stamp
must be a real `LaunchTaskServerOptions` field).

**Adversarial pair (round 2):** Sided with **failure-mode** against the
queue-feeder pin (keeping the feeder alive under a Lucy pause keeps
`spawnLeaves` eating Lucy slots). Sided with **ambition** that
pipeline-starvation belongs in this RFC (R17) and that the launch-home
stamp must be a typed server option, not prose. Sided with
**design-minimalist** on delaying the CLI, cutting a selected-project
banner, and not productizing a cwd→id cache. Kept optional
`Schedule.automationProjectId` as a future pin (round-trip required) but
P1 uses a basename map for reflection instead of mutating live JSON
(socratic Q1).

Incorporated from round 2:

- `LaunchTaskServerOptions.automationProjectId` (boundary, socratic,
  ambition, failure-mode). Skip-before-`launchTask` so
  `dispatch_failed` cannot auto-pause.
- `setConfig` write alias + paused-set alias (socratic Q4–Q5, boundary,
  failure-mode). P1 REST on `local/lucy` actually pauses Lucy.
- Five persistence allowlists + round-trip test (failure-mode).
- Predicate owns polarity; callers include reset-sweep (failure-mode,
  boundary).
- Queue-feeder is **not** pinned off Lucy (failure-mode). Reflection
  basename map (socratic Q1, minimalist).
- Starvation in R17 (ambition). Idle-refinery documented as Kookr-remote
  (socratic Q6, experimenter).
- R7 overlay + quarantine fail-closed (socratic Q7–Q8). Untrack 409
  (boundary).
- Cut CLI, banner, process-global cache (minimalist). Error `code` on
  existing class (minimalist, experimenter claim 6).

Rejected:

- Re-home feeder cwd in P1 as the only identity (minimalist) — follow-up,
  because a cwd move without target-repo skip is a different ops change.
- Fail-open on whole-file quarantine (v2) — polarity flipped to match
  settings #2085.
- Drawer-only alias (v2 R15) — store-level.

**Intent preservation check:** User asked for a per-project control similar
to the global kill-switch. v3 still matches SAFE MODE sources (plus the
starvation hole that made SAFE MODE *not* actually stop refill). Pausing
Lucy now honestly stops Lucy-homed schedules including the feeder.
Product runtimes stay out of scope.

**Round 3 panel (N=5):** `boundary-critic`, `failure-mode-analyst`,
`design-minimalist`, `socratic-challenger`, `operability-reviewer`.
`ambition-amplifier` skipped (rounds 1–2 only). `operability-reviewer`
2026-09-02: novel finding (P1 REST pause is invisible on `/api/health` /
`kookr status` / ops-digest — SAFE MODE is operable because those surfaces
exist).

**Adversarial pair (round 3):** Sided with **design-minimalist** on cutting
the unused pin field, delaying starvation source-set expansion, and **not**
turning `project-configs.json` quarantine into a second global SAFE MODE.
Sided with **operability-reviewer** that paused ids belong on `/api/health`
in the **same slice as the gate**, not only P2 chrome. Sided with
**boundary** that aliasing must be sync (`localPath` equality, not git in
`setConfig`) and that every autonomous launcher must pass the stamp.

Incorporated from round 3:

- R7 fail-open + warning; deleted R19 fail-closed (minimalist, socratic Q3).
- R9 membership seed only; deleted untrack 409 (minimalist, socratic Q4,
  boundary).
- Starvation stays an inherited `api` hole (minimalist; Non-goal restored).
- Cut `Schedule.automationProjectId` from P1 (minimalist).
- Alias by `localPath` equality, sync (socratic Q6, boundary).
- Health/digest of paused ids in P1 (operability, socratic Q9).
- `mapError` inspects `code` (socratic Q7, operability).
- Stamp pipe for every autonomous launcher (boundary, R18).
- Run Now = schedule fire, skips; Launch Task stays (socratic Q2).
- `ProjectSummary` in the gate slice (operability).

Rejected:

- `pausedProjectIds` on Settings next to the global kill-switch (socratic
  Q1) — the sidebar unit is the project; `ProjectConfig` is the per-project
  document.
- Keeping starvation in this RFC (ambition r2 / v3 R17).

**Intent preservation check:** User asked for a per-project control similar
to the Settings kill-switch. v4 still: conjunction not bulk-disable; same
autonomous sources as live `isAutonomousLaunchSource`; product runtimes out
of scope; Kookr is the control plane; Lucy pause honestly stops Lucy-homed
schedules including the feeder.

**Consensus attack** (`general-purpose` 2026-09-02): the panel shared a
frame — “per-project pause = SAFE MODE ∩ projectId” — and never asked
whether skip-next-fire is the right *effect* for a slot-budget story.
Concrete failure: pause Lucy at 21:00; in-flight supervisor children and
pending promotion keep occupying `maxActiveTasks`; kb-scout queues behind
them; the skip ledger looks healthy.

Triage: **incorporate as honesty, not as a P1 occupancy killer.** The user
asked for a lever *similar to* the Settings kill-switch; SIGTERM /
promotion-block would make it a different product. The Problem statement
now says this is the next fire, not tonight’s cap. Freeing slots now is
pause **plus** abort (existing UI). Occupancy-aware pause (block children
and pending promotion for the paused project) remains the named follow-up
that should change **both** levers, recorded here so it is not mistaken
for P1 success.

`general-purpose` 2026-09-02: consensus-attack — shared SAFE MODE-effect
frame; occupancy not in P1.

**Meta-analysis readiness:** invocations and findings are in
`docs/rfc/meta/rfc-per-project-automation.critic-trace.jsonl`.
Missed-risk sweep not performed.
