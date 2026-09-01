# RFC: Tier-Aware Playbook Resolution for Schedules

## Status

**Draft (v4 — post round-3 convergence)**

**Date:** 2026-06-24
**Author:** Jean Ibarz (with Claude)

---

## Problem

The schedule runner resolves a scheduled playbook **strictly** from the project tier:

```ts
// src/server/schedule-validator.ts (resolveLaunch, ~line 65)
const playbookPath = join(schedule.cwd, '.kookr', 'playbooks', schedule.playbook.path);
```

The same hardcoded join is repeated in `validateDefinitionFields` (~line 127), which gates create/update.

Every other launch surface resolves across three tiers — `project` (`<cwd>/.kookr/playbooks/`), `user` (`~/.kookr/playbooks/`), `plugin` (`<kookr-toolkit>/playbooks/`) — with `project > user > plugin` precedence (`src/core/playbook-discovery.ts`). The dashboard even *hides* this from schedule creation: `SchedulesDialog.tsx:235` filters the picker to `item.scope === 'project'`, with a code comment admitting schedules can't resolve other tiers yet.

Commit #1018 ("consolidate Kookr workflows into the plugin") moved operational playbooks out of `<repo>/.kookr/playbooks/` into the plugin tree. The dashboard still lists/launches them; the scheduler cannot find them and fails every fire with `dispatch_failed` / `missing_playbook`. The breakage was **silent** — no warning until each schedule's next cron tick.

Observed live breakage (`~/.kookr/schedules.json`, 2026-06-24):

| Schedule | cwd | playbook.path | Where the file is now | Intended tier |
|---|---|---|---|---|
| Kookr Nightly Repository Idea Scout | `~/git/kookr-prod` | `repository-idea-scout.md` | plugin tier | `plugin` |
| KB-MCP Nightly Repository Idea Scout | `~/git/kookr-prod` | `repository-idea-scout.md` | plugin tier | `plugin` |
| Local-Research Nightly Repository Idea Scout | `~/git/kookr-prod` | `repository-idea-scout.md` | plugin tier | `plugin` |
| KB-Scout Eval Daily Self-Reflection | `~/.claude` | `kb-scout-reflection.md` | only in worktree-local `.kookr/playbooks/` | `user` (after placement) |

The four broken schedules are **known and enumerated** — this matters for the migration strategy below.

The only current workaround is to symlink each relocated playbook back into the schedule's `<cwd>/.kookr/playbooks/`: fragile, per-cwd, rots silently, and re-fragments exactly what #1018 consolidated.

## Goals & Root Cause

Two distinct problems:

1. **Resolution gap (symptom):** the scheduler can't reach user/plugin-tier playbooks.
2. **Silent breakage on relocation (disease):** when a playbook moves, enabled schedules break with no operator-visible signal until 3am.

This RFC fixes both, and deliberately **avoids** two tempting-but-unsafe shortcuts that round-1/round-2 review eliminated:

- A **bare-filename fallback chain re-resolved every fire** — silently substitutes a different tier's same-named file when the original is gone (fail-fast → fail-silent regression for unattended schedules).
- A **runtime lazy-backfill probe** — structurally the *same* fallback chain, run once, on exactly the legacy schedules most likely to already be in a post-relocation broken state; plus a racy read-modify-write against the store's persist chain. It would reintroduce the very silent-substitution it was meant to prevent.

Instead: schedules carry an explicit, persisted `scope`; the four known-broken legacy schedules are migrated by an **operator-run, operator-reviewed one-time script**; resolution is single-scope and deterministic; and a throttled health signal makes future relocations visible before the next fire.

## Requirements

- **R1.** A schedule SHALL resolve its playbook from a **pinned tier** (`scope`): project, user, or plugin. Fire-time lookup SHALL search only the pinned tier's *current* directory — no cross-tier fallback.
- **R2.** `scope` SHALL be an **optional, additive** field on `SchedulePlaybook`. Note `SchedulePlaybook` is defined in **two** files — `src/core/schedule.ts` *and* `src/shared/contracts/schedule.ts`; both MUST gain the field or the types diverge. It SHALL be plumbed end-to-end: UI create/update → route → `CreateScheduleInput`/`UpdateScheduleDefinitionInput` → `ScheduleStore.create`/`updateDefinition`/`normalizeSchedule`, **and** through the validator's `validateCreate`/`validateDefinitionUpdate` field extraction (which today destructures `{ playbookPath, parameterValues }` and drops scope). Carry-through SHALL be by **merge, not reconstruction**, so a create/update payload that omits `scope` never strips an already-pinned scope.
- **R3.** A schedule with **no `scope`** (un-migrated legacy) SHALL behave exactly as today: resolve from the project tier only. No runtime probe, no guessing. This guarantees zero behavior change for every currently-working schedule.
- **R4.** The four enumerated broken schedules SHALL be fixed by a **one-time, idempotent migration script** that stamps an operator-decided `scope` on each, run at deploy time. No runtime backfill.
- **R5.** Fire-time resolution SHALL re-resolve the tier *directory* (so plugin version upgrades, which change the versioned plugin path, keep working) but SHALL NOT re-resolve the *tier*. A same-named file appearing in another tier later SHALL NOT shadow the scheduled one.
- **R6.** Create/update validation SHALL use the same single-scope resolver as runtime launch, resolving the **same scope** `resolveLaunch` would (including the `project` default for omitted scope) — so validation and fire-time cannot disagree on tier. `validateDefinitionFields` SHALL tolerate an unknown/unrecognized `scope` value gracefully (treat as unresolvable, not a hard throw), so a PR1 revert while a newer UI persists `scope` cannot wedge updates.
- **R7.** When the pinned tier no longer contains the playbook, launch SHALL fail with `missing_playbook` naming the pinned scope and searched directory.
- **R8.** The schedule-creation UI SHALL offer playbooks from all three tiers and persist the selected scope (remove the `scope === 'project'` filter).
- **R9.** The server SHALL surface, per schedule, a **resolution-health** indicator computed off the broadcast hot path (on the scheduler tick cadence, cached), so the dashboard shows a broken schedule before its next cron tick. This SHALL NOT add a filesystem stat to `enrichSchedule`/every list response. It SHALL be a **tri-state** (`unknown` | `resolvable` | `unresolvable`): a cache miss (e.g., the ~60s window before the first tick, or after a `cwd`/`path` edit) is `unknown` and renders neutral, never `broken`. Health SHALL be computed for **all** schedules including disabled ones (independent of the fire-eligibility `enabled` gate), so a disabled-because-broken schedule is still visibly broken. The true→false `warn` SHALL use explicit **seed semantics**: the first observed value within a process lifetime seeds the baseline silently; `warn` fires only on a transition between two observed ticks — so an already-broken schedule does not emit a spurious `warn` on every restart (it is surfaced via the dashboard badge instead).
- **R10.** `playbookId` stamped on the task SHALL remain the bare filename (current behavior), keeping cost-comparison/outcome-ledger buckets stable.
- **R11.** Resolution SHALL reject `playbook.path` values that escape the pinned tier directory (path-traversal guard, inherited from `playbook-launch.ts`). *(Non-gating hardening, free inside the resolver.)*

## Non-Goals

- **No runtime backfill / probe.** (Eliminated in round 2 as unsafe; replaced by R4's migration script.)
- No convergence of `resolveLaunch` with `preparePlaybookLaunch`. Only the tier path/lookup primitive is shared.
- No change to dashboard discovery/listing or the UI launch flow beyond the schedule-create picker (R8).
- No change to cron cadence, catch-up, trigger-limit, capacity, or drain-gate logic.
- No code-driven relocation of playbook files; placing `kb-scout-reflection.md` is an operational step (Migration).
- No `repo-tags` gating for scheduled launches; an optional create-time *warning* only (Edge Cases).

## Design

### Shared single-scope resolver

Add `src/core/playbook-paths.ts` (small, I/O-light; keeps `playbook-discovery.ts` a pure scan-and-parse module):

```ts
export function playbookScopeDir(scope: PlaybookScope, cwd: string): string | undefined {
  switch (scope) {
    case 'project': return join(cwd, '.kookr', 'playbooks');
    case 'user':    return userPlaybooksDir();
    case 'plugin':  return pluginPlaybooksDir();   // may be undefined (no plugin)
  }
}

/** Resolve a bare filename within ONE known scope. No fallback chain. */
export function resolvePlaybookInScope(
  playbookPath: string, scope: PlaybookScope, cwd: string,
): { filePath: string } | undefined {
  const dir = playbookScopeDir(scope, cwd);
  if (dir === undefined) return undefined;
  const filePath = join(dir, playbookPath);
  if (!isPathInside(filePath, dir)) return undefined;   // R11
  return existsSync(filePath) ? { filePath } : undefined;
}
```

`isPathInside` moves here from `playbook-launch.ts` so there is one copy. `userPlaybooksDir`/`pluginPlaybooksDir` are imported from `playbook-discovery.ts` (server modules already import them from there — no layer inversion). The `playbook-launch.ts` import-swap (replace its private `resolvePlaybooksDir`/`isPathInside` with these) is an **optional follow-up cleanup**, not part of the regression fix, to keep blast radius off the all-UI-launches path.

> Note: no `probePlaybookScope`. There is deliberately no fallback chain anywhere in the runtime *resolution/launch* path. The only thing that ever *chooses* a scope by searching is the one-time migration script (R4), where a human reviews the result. (A read-only cross-tier probe also exists in `schedule-resolution-alert.ts` to compute the operator hint in the unresolvable-playbook alert — issue #1661 — but it never resolves or launches from the probed tier, so the no-fallback resolution invariant is unaffected.)

> **Follow-up (#2887):** A schedule may now persist `playbook.sourceCwd`
> separately from its task-execution `cwd`. Resolution uses
> `schedule.playbook.sourceCwd ?? schedule.cwd`, while the selected scope remains
> pinned with no cross-tier fallback. Fired tasks record the resolved resource's
> full source identity, including its content digest.

### Why single-scope + migration, not runtime backfill

Verified facts driving this:

- The plugin dir is **version-pinned** (`resolvePluginDir` → `.../kookr-toolkit/<version>/playbooks/`); a stored *absolute* path would rot, so we re-resolve the *directory* — but the *tier* is stable intent (R5).
- Schedules run **unattended and autonomous**, often mutating. Any per-fire or first-probe fallback chain can silently run a different tier's same-named file. Round 2 showed a one-time probe is the *same* hazard, run on the worst-positioned schedules.
- The broken set is **enumerated and small** (4). A reviewed migration script stamps the *intended* scope (human decision), eliminating the guess, the racy store write, and the per-fire probe cost in one move.

### Scheduler changes

`resolveLaunch`:

```ts
async resolveLaunch(schedule: Schedule): Promise<ResolvedScheduleLaunch> {
  if (!existsSync(schedule.cwd)) throw new ScheduleValidationError(/* missing_cwd */);
  const scope = schedule.playbook.scope ?? 'project';          // R3: legacy = project, no probe
  const resolved = resolvePlaybookInScope(schedule.playbook.path, scope, schedule.cwd);
  if (!resolved) {
    throw new ScheduleValidationError(
      `Playbook not found in ${scope} tier: ${schedule.playbook.path}`,
      { playbook: 'Playbook not found' },
    );
  }
  const raw = await readFile(resolved.filePath, 'utf-8');
  const playbook = parsePlaybook(raw, schedule.playbook.path, schedule.cwd, scope);
  // interpolate, criteria, expandConfiguredCwd, projectId derivation unchanged.
  // playbookId stays schedule.playbook.path (R10).
}
```

Corrections from earlier drafts: `parsePlaybook` receives the **real scope** (its 4th arg is already optional — confirmed via the existing `playbook-launch.ts` call). The original decision kept `sourceCwd` equal to `schedule.cwd`; the #2887 follow-up above supersedes that detail by persisting a distinct catalog source and recording it on fired tasks.

`validateDefinitionFields` makes the identical single-scope substitution (R6), defaulting missing scope to `project`.

`resolveLaunch` remains **pure/read-only** — no store writes, no persistence side effects (this is what round 2 flagged as the riskiest part of the backfill design; it is gone).

### Scope carry-through (R2) — the strip hazard

Today several places reconstruct `playbook` (or extract its fields) as `{ path, parameters }`, which would silently drop `scope`:

- `ScheduleStore.create` (schedule.ts ~258), `updateDefinition` (~291), `normalizeSchedule` (~368)
- the PATCH route (`schedule-routes.ts:62-65`) rebuilds `patch.playbook` as `{ path, parameters }`
- the validator's `validateCreate` (~39-40) and `validateDefinitionUpdate` (~57-58) destructure `{ playbookPath, parameterValues }`, dropping scope **before** `validateDefinitionFields` — so without threading scope here, validation resolves the `project` default while runtime resolves the pinned tier, silently breaking R6 parity.

All of these must **carry `scope` through by merge**:
`scope: input.playbook.scope ?? existing?.playbook.scope`. An update that omits scope must preserve the pinned one (prevents an API client that sends only path+parameters from un-pinning a schedule). `SchedulePlaybook` (in **both** `core/schedule.ts` and `shared/contracts/schedule.ts`), `CreateScheduleInput`/`UpdateScheduleDefinitionInput`, and the create/update wire contract gain optional `scope`.

### Resolution health (R9) — off the hot path

`enrichSchedule` is pure/synchronous and runs on every list/broadcast (~16 broadcast sites, several per fire). Putting `existsSync` there is an O(N) sync-FS stat per broadcast — an O(N²) storm during startup catch-up, and flapping health during a plugin version swap. Instead:

- The scheduler tick (already every 60s) computes `resolvePlaybookInScope(...)` once per schedule and caches `{ resolvable, scope, checkedAt }` in a side map keyed by `(id, path, scope, cwd)`.
- `enrichSchedule` reads the cached value (no FS) and includes it in `ScheduleResponse`.
- The dashboard renders an unresolvable schedule as broken (the existing local-path-health pattern). On a `resolvable: true → false` transition, the runner emits a `warn` log (greppable without a dashboard visit).

This gives proactive visibility without the stat storm and without flapping (a single transient miss is one tick, debounced by the next tick).

*Leaner fallback if R9 is deferred:* surface the execution-ledger's existing `missing_playbook`/`dispatch_failed` reason in the schedule row. Reactive (only after the first failed fire) and zero new FS — strictly better than today, available with no new mechanism.

### UI: schedule-create picker (R8)

`SchedulesDialog.tsx` drops the `item.scope === 'project'` filter, shows all tiers (the browser already labels scope), and sends the selected `scope`. Must ship **after** the server accepts/stores scope (Phasing) so a plugin-playbook create can't 400 against an old server.

## Files To Change

- `src/core/playbook-paths.ts` (new): `playbookScopeDir`, `resolvePlaybookInScope`, relocated `isPathInside`.
- `src/core/schedule.ts`: optional `scope?: PlaybookScope` on `SchedulePlaybook`, `CreateScheduleInput`, `UpdateScheduleDefinitionInput`; merge-carry `scope` in `create`/`updateDefinition`/`normalizeSchedule`; add cached tri-state `playbookResolution` to `ScheduleResponse`; `enrichSchedule` reads cache only (no FS).
- `src/shared/contracts/schedule.ts`: the **second** `SchedulePlaybook` definition gains `scope?: PlaybookScope`; `ScheduleResponse` contract gains `playbookResolution`.
- `src/server/schedule-validator.ts`: `resolveLaunch` + `validateDefinitionFields` use `resolvePlaybookInScope`; `validateCreate`/`validateDefinitionUpdate` thread `scope` into the validated fields; default missing scope to `project`; tolerate unknown scope gracefully (R6); pass scope to `parsePlaybook`; remains pure (no store writes).
- `src/server/schedule-runner.ts`: resolution-health computed per tick for **all** schedules (independent of the `enabled` gate) + cache + seeded transition `warn` log (R9).
- `src/server/routes/schedule-routes.ts`: pass `scope` through POST and PATCH (PATCH currently rebuilds `{path, parameters}` — add scope).
- `src/shared/contracts/*`: optional `scope` on create/update messages; `playbookResolution` on `ScheduleResponse`.
- `src/frontend/components/SchedulesDialog.tsx`: remove project-only filter; send `scope` (R8).
- `scripts/migrate-schedule-scopes.*` (new, R4): idempotent; stamps the 4 enumerated schedules (idea-scout×3 → `plugin`, reflection → `user`); no-op if already stamped; prints a before/after diff for operator review.
- Tests: `playbook-paths.test.ts` (per-scope resolve, traversal reject, plugin-dir-undefined); `schedule-validator.test.ts` (resolve each scope; legacy→project; missing→`missing_playbook`; validation/runtime parity; `playbookId` invariant); `schedule.test.ts` (scope round-trips create/update/normalize; **scope survives an update that omits it**; cached health); `schedule-runner.test.ts` (plugin-scoped fires; pinned-tier-deleted fails loudly with no substitution; health transition logs); migration-script test (idempotent, correct stamps); `SchedulesDialog` test.

## Edge Cases

- **Pinned tier file deleted.** Loud `missing_playbook` (R7) + unresolvable in the list (R9). No silent cross-tier substitution.
- **Plugin version upgrade between fires.** Same scope/filename, new versioned dir — re-resolving the *directory* picks it up (intended). Residual TOCTOU: if the upgraded playbook renamed a parameter, fire-time `interpolateParameters` may throw / leave `{{param}}`. Surfaces as a launch error (same as today); fire-time param re-validation is an Open Question.
- **Legacy schedule, never migrated.** Resolves project tier only = today's behavior (R3). The migration script, not runtime, fixes the known ones.
- **Existing symlink workaround in place.** Symlink lives in the project tier; a legacy (unmigrated) schedule still resolves it. No conflict.
- **Update payload omits scope.** Merge-carry preserves the pinned scope (R2). Test-covered.
- **`repo-tags` on a plugin playbook.** Scheduled launches bypass repo-tag *gating* (failing a nightly on a tag mismatch is worse than running it; the user explicitly picked it). Create/update MAY emit a non-blocking *warning* when a chosen plugin playbook's `repo-tags` don't intersect the cwd's detected tags — caught at human time, never at 3am.
- **`pluginPlaybooksDir()` undefined (no plugin).** `resolvePlaybookInScope` returns undefined → `missing_playbook`, surfaced via R9. No exception escapes.
- **Path traversal in `playbook.path`.** Rejected (R11). Inputs are bare filenames; hardening, non-gating.
- **Reflection schedule.** Needs the file placed once in `~/.kookr/playbooks/` (Migration) *and* the migration script stamping `scope: user`; then resolves from any cwd, immune to future plugin-name collisions.

## Migration & Rollback

- **Schema:** additive optional `scope`; no destructive migration.
- **One-time script (R4):** operator runs `migrate-schedule-scopes`; it prints the proposed stamps for review, then writes `scope` onto the 4 schedules. Idempotent.
- **Operational step:** place `kb-scout-reflection.md` into `~/.kookr/playbooks/` (a single shared copy, not per-cwd symlinks). The three idea-scout schedules need no file move (plugin tier already has the file). A startup check SHOULD `warn` if the migration script has not been run (any enumerated schedule still lacks `scope`) or a `scope: user` schedule's file is absent — closing the "operator forgot to run the script" gap.
- **Deploy gap:** fires before the script/placement record `missing_playbook`; under the default `auto` catch-up (since #1900) a missed startup fire auto-launches once per boot (lease-gated), or set `KOOKR_MANUAL_CATCHUP` to recover them via Run Now inside the 24h window instead.
- **Rollback:** revert code. Note: the old `normalizeSchedule` whitelists `{path, parameters}` and will **silently strip `scope`** from `schedules.json` on the next persist after revert. No schedule breaks (old binary resolves project-tier as before, except the 4 known ones revert to broken). Re-deploy + re-run the idempotent script re-stamps them. Document this so operators aren't surprised the field vanished. Reverting PR1 while a newer UI (PR3) still persists `scope` is safe because the server ignores unknown JSON fields and `validateDefinitionFields` tolerates an unknown scope gracefully (R6) — it does not 400 on it.

## Acceptance Tests

1. Plugin-scoped schedule whose `cwd` lacks the file resolves from the plugin tier and fires.
2. Un-migrated legacy schedule (no `scope`) resolves project tier only — identical to today; no probe occurs.
3. The migration script stamps the 4 enumerated schedules with the intended scopes and is a no-op on re-run.
4. A `project`-pinned schedule whose project file is deleted fails `missing_playbook` and does **not** resolve a same-named plugin file.
5. A same-named file added to a higher tier after pinning does not change which file fires.
6. `updateDefinition` with a payload omitting `scope` preserves the pinned scope (no un-pin); validation resolves the **same** scope `resolveLaunch` would (R6 parity).
7. Create/update against a plugin playbook passes validation; runtime resolves the same tier.
8. `playbook.path='../escape.md'` rejected at validation and runtime.
9. `playbookId` on the task equals the bare filename regardless of scope.
10. Resolution-health marks an unresolvable schedule broken on the tick cadence without adding FS stats to `enrichSchedule`; a cache miss renders `unknown` (not broken); a true→false transition emits a `warn`.
11. An already-broken schedule emits **no** spurious `warn` on process restart (seed semantics); a **disabled** broken schedule is still reported `unresolvable`.
12. Schedule-create picker lists a plugin playbook and round-trips its scope (R8).
13. Plugin playbook with non-matching `repo-tags` still fires; create-time surfaces a non-blocking warning.
14. An unknown `scope` value (e.g., from a newer client after a PR1 revert) is tolerated gracefully — reported unresolvable, not a hard validation throw.

## Phasing

- **PR 1 (regression fix, minimal blast radius):** `playbook-paths.ts`; `scope` on `SchedulePlaybook`/inputs with merge-carry through store + route; single-scope `resolveLaunch`/`validateDefinitionFields` (legacy→project); migration script. → Fixes the 3 idea-scout schedules on deploy+script; enables the reflection fix once the file is placed. No UI, no health field.
- **PR 2 (R9 health, additive):** tick-cadence cache + `playbookResolution` on `ScheduleResponse` + transition `warn`. Additive response field; frontend ignores unknown fields until it renders them.
- **PR 3 (R8 UI picker):** drop the filter, send scope. **Must land after PR 1 is live** (else plugin-playbook creates 400 against an old server).
- **Operational step** (any time after PR 1): place `kb-scout-reflection.md` in `~/.kookr/playbooks/`.

## Alternatives Considered

### Bare-filename fallback chain, re-resolved every fire (v1)
Minimal code, no schema change. **Rejected:** converts fail-fast into silent substitution for unattended schedules; lets later same-named files shadow the target.

### Runtime lazy backfill probe (v2)
Resolve scope by a one-time project→user→plugin probe on first fire, persist it. **Rejected in round 2:** (a) the probe *is* a fallback chain run on exactly the post-relocation-broken schedules, so it can pin the wrong tier silently — the very regression it claimed to fix; (b) the persist is a racy read-modify-write against the store's persist chain and is silently un-pinned by the existing `updateDefinition` reconstruction. Replaced by the reviewed migration script (R4) + single-scope runtime (R3).

### Store the resolved absolute path once
**Rejected:** the version-pinned plugin dir makes an absolute path rot on upgrade. Pin the *scope*, re-resolve the *directory* (R5).

### Fix #1018's migration only (re-point schedules, no code)
**Rejected as insufficient:** fixes this instance, not the class — the next relocation breaks schedules silently again. R9 is the durable answer.

### Converge `resolveLaunch` onto `preparePlaybookLaunch`
**Rejected:** imports UI-only concerns (capability gating, git-remote defaults, projectId reconciliation) into the scheduler. Sharing the tier path primitive captures the right dedup at far less risk.

### Make the scheduler call `discoverPlaybooks` and pick by id
**Rejected:** parses every playbook in every tier per fire and applies repo-tags gating — both wrong for the scheduler.

## Critic Feedback Incorporated

- **Empirical validation (code-grounded):** confirmed (a) `SchedulesDialog.tsx:235` project-only picker filter; (b) param-snapshot is frontend-only (`playbook-usage.ts`) — the `sourceCwd=tierDir` justification was false; (c) plugin dir is version-pinned (`resolvePluginDir`) so absolute-path storage rots; (d) `playbookId` feeds cost-comparison/outcome-ledger buckets (keep bare filename); (e) `schedule-routes.ts:62-65` PATCH and `ScheduleStore.create`/`updateDefinition`/`normalizeSchedule` reconstruct `{path,parameters}`, stripping any new field — hence R2's merge-carry.
- `failure-mode-analyst (r1+r2) 2026-06-24`: **two pivots** — r1 killed the fail-fast→silent-substitution regression by pinning scope; r2 showed the *backfill probe re-introduced it*, so backfill was removed entirely in favor of the reviewed migration script (R4); kept the `playbookId` invariant; removed the false param-snapshot justification.
- `delivery-pragmatist (r2) 2026-06-24`: adopted the 3-PR phasing; added the route-layer scope plumbing and the merge-carry across store/normalize; added the rollback note that `normalizeSchedule` strips `scope` on revert; named the exact (now eliminated) backfill-wiring gap, resolved by dropping backfill.
- `design-minimalist (r1+r2) 2026-06-24`: replaced runtime backfill with the one-time migration script for the known set; moved the `playbook-launch.ts` refactor to optional; kept the new module small; trimmed the overclaimed boundary justification.
- `ambition-amplifier (r1+r2) 2026-06-24`: kept the UI picker fix (R8) and resolution-health (R9) so the fix works end-to-end and the silent-breakage *class* is addressed; added the true→false transition `warn` so health is signalled, not merely displayed.
- `socratic-challenger (r1) 2026-06-24`: adopted "resolve/pin, don't re-decide every fire"; answered shadowing (AT-5) and the reflection home/precedence question (pin `scope:user`).
- `boundary-critic (r1) 2026-06-24`: single clean home for `isPathInside`/path helpers; `playbook-launch` swap is like-for-like (now optional); flagged the `playbookId` semantics (R10).
- `failure-mode-analyst (r3) 2026-06-24`: **converged** on the two architecture classes (silent substitution + race/persist confirmed eliminated). Folded in tightening: tri-state `unknown` health for cache-miss; health computed for disabled schedules too; seeded transition-`warn` semantics (no spurious warn on restart); enumerated the duplicate `SchedulePlaybook` type and the validator extraction sites as scope-carry points.
- `delivery-pragmatist (r3) 2026-06-24`: **converged** on phasing/rollback. Folded in: `validateDefinitionFields` must tolerate an unknown scope gracefully (PR1-revert-while-PR3-live); startup `warn` if the migration script hasn't run.
- **Adversarial-pair resolution (design-minimalist ↔ ambition-amplifier):** on **backfill** I sided with the minimalist (a reviewed one-time migration script for an enumerated set beats runtime probe machinery) — decisive because round-2 failure-mode proved the runtime probe is actively unsafe; on **silent-breakage detection** I sided with ambition (keep R9 + transition warn) — because schedules are unattended and "visible only at fire time" is the original disease. R9 was reshaped to live off the broadcast hot path to satisfy the minimalist's complexity/perf concern.
- **Intent preservation check:** the user's load-bearing motivation is "schedule these playbooks without per-cwd symlinks." Preserved — plugin/user playbooks resolve with no symlinks; the one manual step (reflection) is a single shared user-tier copy, not a symlink. No user motivation dropped.

## Open Questions

- Should `kb-scout-reflection.md` ship in the plugin tier (zero-setup everywhere) vs. user tier (per-user customizable)? v3 assumes user tier; pinning `scope:user` is safe either way.
- Should fire-time re-validate parameters against a possibly-upgraded plugin playbook to catch parameter drift, rather than failing in `interpolateParameters`?
- Should R9 escalate beyond a `warn` log + dashboard badge (e.g., a push notification, or auto-disable after N consecutive unresolvable ticks)?
- Should a later RFC converge `resolveLaunch` and `preparePlaybookLaunch` now that they share the tier path primitive?
