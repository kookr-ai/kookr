# RFC: Model and reasoning-effort parity across agent launch paths

**Status:** Draft (v1)
**Date:** 2026-08-24
**Author:** Jean Ibarz (with Codex)

## Problem

Kookr's launch contract already carries optional `model` and `effort` pins, but
the feature is not actually symmetric across the supported coding agents or
launch surfaces. Claude Code exposes both fields in the Launch dialog. Codex
CLI exposes only effort because its model allowlist is empty, and Grok Build
exposes neither because both allowlists are empty. The adapters are also
inconsistent: Codex currently derives its model without consulting a per-task
model pin, while Grok always uses its constructor model and never emits an
effort flag.

This creates a misleading UI and means a request can be accepted by one path,
rejected by another, or silently use the agent default. Schedules and playbook
launches already carry the fields in their server contracts but do not give the
operator equivalent controls. The standalone `kookr spawn` documentation and
fast-fail validation describe the old asymmetric behavior as well.

## Evidence

The evidence was collected from the refreshed `origin/main` checkout and the
installed harnesses on 2026-08-24:

- Claude Code 2.1.239: `claude --effort __kookr_invalid__` reports the valid
  values `low, medium, high, xhigh, max`; `claude --help` advertises
  `--model <model>` and `--effort <level>`.
- Grok Build 1.0.8: `grok --help` advertises `-m, --model <MODEL>` and
  `--reasoning-effort <EFFORT>` (alias `--effort`); `grok models` reports
  `grok-4.6` as the default and `grok-4.5` as another available model. The
  binary's embedded schema contains the effort values `low, medium, high,
  xhigh, max`.
- The maintained Codex fork's model catalog
  (`codex-rs/models-manager/models.json`) contains model-specific supported
  reasoning levels and the app-server `ModelListResponse` exposes those
  levels. The interactive CLI advertises `-m, --model <MODEL>` and accepts
  `model_reasoning_effort` through `-c`; it has no stable human-facing
  `models` command in the installed build.
- `src/shared/contracts/agent-types.ts` keeps provider-specific verified
  suggestions separate from bounded custom-pin validation; Grok effort
  suggestions remain empty because its CLI has no stable enumeration.
- `src/adapters/codex-cli-adapter.ts` and `src/adapters/grok-build-adapter.ts`
  forward model and effort independently.
- `src/frontend/components/LaunchEffortModelPickers.tsx` exposes both fields
  for every concrete agent in the full Launch dialog and Quick Launch, while
  PlaybookBrowser and SchedulesDialog carry the same pins.
- `bin/kookr-spawn.js` accepts bounded custom model ids for every agent and
  keeps provider suggestions as completion hints rather than a hard allowlist.

The mandatory post-Round-1 empirical checkpoint additionally verified that the
Codex model catalog maps naturally to `model -> effortOptions`, that the
installed Codex CLI accepts a supplied model plus effort config, and that the
installed Grok CLI accepts independent model and reasoning-effort flags and
enumerates models. It also falsified the assumption that Kookr already
propagates pins end-to-end: WS relaunch, standard playbook, Ralph create/
replace, queued promotion, crash recovery, and later Ralph iterations all
have concrete loss points. The existing Codex capability probe remains an
adapter diagnostic rather than a launch-critical dependency. Grok's exact
accepted effort tokens remain
unverified; the implementation keeps a custom effort entry enabled rather
than advertising an unverified list.

## Requirements

1. The full Launch dialog and Quick Launch SHALL present independent model and
   reasoning-effort controls for every concrete registered coding agent:
   Claude Code, Codex CLI, and Grok Build.
2. Playbook launches, Ralph loop launches, scheduled launches, direct API,
   remote relay/chat launches, `kookr spawn`, and dashboard-generated spawn
   commands SHALL carry both pins without dropping or silently rewriting them.
3. Each adapter SHALL translate both pins using the harness-native control:
   Claude Code `--model` / `--effort`, Codex `-c model=...` /
   `-c model_reasoning_effort=...`, and Grok `--model` /
   `--reasoning-effort`.
4. A stale hard-coded model allowlist SHALL NOT be the only source of truth.
   Kookr SHALL maintain verified provider suggestions where the harness exposes
   them, while the UI SHALL accept a custom model id and the adapter/CLI SHALL
   remain the final authority.
5. Effort options SHALL be grounded in harness verification or a documented,
   tested fallback. When a harness does not expose a stable effort
   enumeration, the UI SHALL show a custom input rather than advertise an
   unverified list, without preventing newly-added values.
6. Invalid request shapes remain 400s. A non-empty custom model/effort value
   is not rejected merely because Kookr's optional catalog is stale or
   unavailable.
7. Existing defaults remain unchanged when a pin is omitted. An explicit
   model/effort pin makes the selected concrete agent part of the launch
   contract. A round-robin or automatic-substitution launch with an explicit
   pin SHALL either resolve to a compatible concrete agent before consuming
   capacity/cursors, or return a deterministic 400/409 without creating a
   task. Kookr SHALL never silently carry a pin to an incompatible agent.
8. Tests SHALL cover adapter argv, API/WS/schedule propagation, CLI payload and
   help text, all dashboard launch surfaces, and at least one browser-level
   launch interaction for each agent type.
9. Documentation SHALL describe the controls, precedence, harness mappings,
   provider suggestions, custom-value behavior, and CLI examples for all three
   agents.

## Design

### 1. Provider suggestions and validation

The shared contract exposes provider-specific `modelSuggestionsForAgent()` and
`effortLevelsForAgent()` helpers. These are verified suggestions, not an
authority or an allowlist: model suggestions come from the current Codex and
Grok CLI catalogs plus Claude's maintained model set. Claude and Codex effort
suggestions come from their CLI behavior; Grok has no stable enumeration and
therefore exposes an empty suggestion list with a custom effort field. Every
provider keeps custom model and effort input available.

The server validates only a bounded printable-token shape before side effects,
plus rejects values that are already known to belong to another selected
harness. Unknown values pass through to the selected harness, which remains
the final semantic authority. This keeps newly released provider values usable
without a Kookr release and avoids claiming that one provider's catalog is
universal.

### 2. Verification and fallback maintenance

The verified inputs are the installed CLI outputs recorded above: Claude's
bounded invalid-effort probe, Codex's fork model catalog and effort vocabulary,
and Grok's `grok models` output plus its independently forwarded
`--reasoning-effort` flag. These checks are a maintenance/release verification
step, not a launch-critical runtime probe.

If a future harness exposes a stable structured catalog, the provider-specific
suggestion helper MAY be refreshed from it. If a command is unavailable or a
catalog cannot be trusted, Kookr retains tested built-in suggestions (or an
empty list where no effort vocabulary is verified) and keeps custom input
enabled. Known values may be used as compatibility hints for round-robin
selection (including dated variants of a known provider family), but
suggestions are never exhaustive and unknown custom values remain
harness-authoritative.

### 3. Launch propagation

Keep `LaunchOpts.effort` and `LaunchOpts.model` as the single server-side
fields. Audit and update every caller so the fields survive:

`Launch dialog / Quick Launch / PlaybookBrowser / SchedulesDialog / API /
kookr spawn / remote relay / Telegram -> route or WS mapper -> launch service
-> task persistence -> adapter`.

The audit explicitly includes the `launch`, `relaunch`, and `launchPlaybook` WS
schemas/handlers; `PreparePlaybookLaunchInput` and its normal playbook mapper;
the dedicated Ralph create/replace routes; schedule create/patch/fire and
automatic substitution; the queued task promotion path; crash recovery; and
every fresh Ralph iteration. The effective pins are persisted in the task's
launch metadata when the task is created, then read by promotion, recovery,
and loop relaunches. They are not inferred again from a transient request.

The existing schedule and Ralph fields remain the same; this change adds the
missing dashboard controls and removes model/effort-specific rejection that
was only justified by the old static allowlists. Direct API and schedule
validation performs only bounded string-shape checks. For a concrete launch,
the resolved adapter receives the explicit pins and the harness is the final
semantic authority. Adapter errors are surfaced as a typed, non-retryable
launch failure carrying agent/model/effort/failure class; adapters never
warn-and-drop an explicit pin.

Automatic agent substitution is not allowed for an explicit pin. For a direct
launch, an incompatible or unavailable concrete agent is rejected before task
creation or cursor/budget consumption. For a scheduled launch, the fire is
parked with a deterministic `provider_paused` outcome rather than changing
harness semantics; a round-robin schedule with explicit pins first resolves a
concrete available agent before consuming the schedule fire. These outcomes
are recorded as non-retryable schedule/launch results.

### 4. Native adapter translation

- Claude: preserve current `--model <id>` and `--effort <level>` handling.
- Codex: select `opts.model` when present, otherwise retain
  `resolveCodexModel(effort)`; emit the effort config independently so model
  and effort can be chosen together.
- Grok: pass `opts.model` when present, otherwise retain the configured model;
  add `--reasoning-effort <level>` independently of model selection.

All adapter argv builders remain pure/testable where possible. Explicit values
are bounded to a safe printable token (maximum 200 characters; no whitespace,
quotes, backslashes, or control characters) before being serialized into argv
or Codex TOML. An unsupported value is reported by the harness as a launch
error; Kookr does not silently substitute, drop, or rewrite a model or effort.

### 5. User interfaces and CLI

`LaunchEffortModelPickers` becomes capability-driven. It renders a model select
with per-model effort options when the catalog has them, and a text input/
datalist when the harness supports custom values. The same component is reused
by manual, quick, playbook, and schedule flows. `buildSpawnCommand` includes
both selected flags, and `kookr-spawn` accepts agent-specific custom model ids
while retaining bounded lexical validation.

### 6. Persistence and replay invariant

Add this versioned record to `TaskMetadata` and write it for every new task:

```ts
interface TaskLaunchPins {
  version: 1;
  state: 'known-pinned' | 'known-unpinned' | 'unknown' | 'malformed';
  effort?: string;
  model?: string;
}
```

`known-unpinned` is explicit for new records. Tasks loaded without the record
were created before model/effort pins existed and are treated as legacy
known-unpinned for automatic recovery; only an explicit `unknown` state blocks
automatic promotion.
Malformed records remain visible, block automatic promotion/recovery/Ralph
relaunch, and create a durable non-retryable data error. A manual relaunch
must explicitly choose new pins rather than inherit an unknown record.

All task-originated adapter launches go through one helper:

```ts
adapterOptionsForTask(
  task: Task,
  transient: Pick<AdapterLaunchOptions, 'tmuxName' | 'extraEnv' | 'bypassPermissions'>,
): AdapterLaunchOptions
```

It validates persisted values again, merges transient session/env options, and
is used by initial launch, queue promotion, crash recovery, normal relaunch,
Ralph replacement, and every later loop iteration. JSON/task persistence and
schedule normalization use the same versioned shape. Remote idempotency
fingerprints include both pins, as do Telegram/task parsers.

### 7. Observability and compatibility

Provider suggestions are ordinary shared contract data; they are not exposed
as a server capability block and never authorize substitution. Existing
persisted tasks and schedules remain readable; new writes always include
explicit `known-pinned` or `known-unpinned` metadata, while legacy tasks
without the field are safely interpreted as known-unpinned. Adapter launch
errors remain queryable as non-retryable task dispositions, and explicit pins
are retained for diagnosis.

Direct launches may accept a bounded custom value when capability data is
stale or absent, but admission records the task before the adapter is invoked
and treats a harness rejection as a non-retryable `launch_error` disposition;
it releases any reservation and leaves the failed task queryable with the
requested pins. Relay/provider entitlement remains the harness account's
authority; Kookr reports that authority's structured rejection and does not
attempt to duplicate provider authorization.

## Files to change

- Shared contracts and snapshot/schema: `src/shared/contracts/agent-types.ts`,
  `src/shared/contracts/messages.ts`, `src/shared/contracts/server-message-schema.ts`,
  `src/shared/protocol.ts`.
- Runtime adapters: `src/adapters/agent-adapter.ts`,
  `src/adapters/codex-cli-adapter.ts`,
  `src/adapters/grok-launch-args.ts`, `src/adapters/grok-build-adapter.ts`,
  `src/server/bootstrap/create-agent-runtime.ts`, snapshot wiring.
- Validation and propagation: `src/server/launch-service.ts`,
  `src/server/schedule-validator.ts`, routes and CLI spawn code.
- Durable launch metadata and replay: `src/shared/contracts/task.ts`,
  `src/core/task-read-model.ts`, `src/core/tasks.ts`,
  `src/server/agent-lifecycle.ts`, `src/server/crash-recovery.ts`,
  `src/server/ralph-loop-service.ts`.
- Remote/secondary launch boundaries: `src/remote/launch-broker.ts`,
  `src/integrations/telegram/parse-task.ts`, and Ralph route mappers.
- UI: `LaunchEffortModelPickers`, `LaunchTaskDialog`, `QuickLaunch`,
  `PlaybookBrowser`, `SchedulesDialog`, store snapshot handling, and styles.
- Tests and docs: focused adapter/contract/UI/API/schedule/CLI tests, one
  Playwright launch-flow matrix with fake agents and a legacy-server fixture,
  `docs/features.md`, `docs/requirements.md`, `docs/user-guide.md`,
  `docs/reference/cli.md`, `docs/reference/spawn-contract.md`, and this RFC.

## Edge cases

- A model catalog can change while the dialog is open. A selected value is
  retained as a custom value and is not cleared just because a later refresh
  omits it.
- A round-robin selection cannot choose agent-specific dropdown values until
  it resolves. The UI presents custom model and effort fields; the server
  applies known compatibility hints after resolution and leaves custom values
  to the selected harness.
- A missing binary is not shown as a selectable agent, preserving current
  preflight behavior. Provider suggestion maintenance is non-critical and
  custom controls remain available if a provider catalog changes.
- Grok's model list may require authentication. Auth failure degrades to the
  built-in model suggestions plus custom entry; it does not block launching a
  previously configured model.
- A per-task pin overrides a per-agent default, which overrides the harness
  default. Omitted pins preserve current behavior.
- CLI and API clients can send a model not present in the current suggestion
  list. The request remains valid if it is a non-empty string; the harness is
  authoritative for final acceptance.

## Alternatives considered

1. **Expand the static allowlists.** Rejected: it would fix the immediate
   dropdown but would repeat the current failure whenever a harness adds or
   retires a model, and it cannot represent Codex's model-specific effort
   matrix.
2. **Make every model a free-text field with no suggestions.** Rejected: it
   would be resilient but removes useful discoverability, especially for Grok
   where the CLI already provides a model list. The chosen design keeps
   suggestions while treating them as non-authoritative hints.
3. **Add a provider abstraction before fixing the launch paths.** Rejected:
   the existing adapters and `LaunchOpts` already provide the correct seams;
   a provider framework would expand scope without improving this bug.

## Critic feedback incorporated

Round 1 — incorporated: the critics required server-side shape validation,
explicit adapter errors, and complete WS/Ralph/playbook propagation. The
minimalist critic's scope recommendation was accepted: use provider-specific
suggestions and the existing launch contracts rather than introduce a provider
framework.

Round 1 adversarial pair resolution: ambition-amplifier was not launched;
the minimal design is appropriate because the user requested parity across
all existing paths, while a generic provider abstraction would be unrelated
scope.

Intent preservation check after Round 1: the revision still provides both
independent controls to all three agents, preserves omitted-pin defaults, and
uses verified provider suggestions with bounded custom fallback rather than a
provider-specific hard allowlist.

Mandatory empirical checkpoint: completed. Linnaeus, 2026-08-24: Codex
catalog and CLI controls pass; Grok model/flag controls pass but exact effort
enumeration remains open; the Kookr propagation gaps were falsified and are
addressed in this revision.

Round 2 — incorporated: provider discovery is explicitly UI/maintenance-only
and never authorizes substitution. Pin persistence is now a typed `launchPins` metadata
record with one task-to-adapter conversion helper; historical tasks without
that record are documented as pin-unknown and are never reconstructed by
guessing. WS relaunch, standard playbook, Ralph create/replace, schedule
forms, remote relay, queue promotion, recovery, and loop iterations are named
implementation/test boundaries. The requirements update is included because
the current requirements document still describes Codex/Grok controls as
unsupported. Shell-safe quoting is required for generated spawn commands and
Codex TOML, and provider suggestions remain non-authoritative.

Round 2 substitution decision: explicit pins disable automatic substitution.
Direct launches reject before cursor, budget, reservation, cancellation, or
task side effects; scheduled launches park as `provider_paused` when the pinned
agent is unavailable. A round-robin schedule resolves a concrete available
agent before creating the task. This resolves the round-robin ambiguity and
avoids silently destroying a running Ralph loop during replacement.

Round 2 compatibility decision: launch-capable owner dashboards receive the
typed capability block in the normal snapshot. Project-scoped viewers are not
launch-capable and receive neither controls nor capability data. A missing
block from an older server renders legacy custom controls but shows a warning
and surfaces the server's rejection rather than claiming the pin was accepted.

Intent preservation check after Round 2: all three agents still have both
independent controls, dynamic/fallback discovery remains required, and every
execution path named by the user is now either implemented in the contract or
explicitly guarded against pin loss.

Round 3 — incorporated: the final panel required a server-only
pin-compatibility predicate, explicit `TaskLaunchPins` states and
helper signature, remote/Telegram idempotency coverage, and a pre-reservation
schedule gate. The panel also caught Grok's unresolved effort enumeration;
the RFC now specifies an empty Grok effort suggestion list with a custom effort
input, so no unverified Grok value is advertised while the native flag remains
available for final harness validation. Ralph replacement must validate the
complete replacement plan before canceling the old loop and retain rollback
state until the new session attaches.

Intent preservation check after Round 3: the design still directly solves the
reported Codex UI asymmetry, adds parity for Claude/Grok, preserves defaults,
and covers every execution surface named by the user without introducing a
provider framework.

Final consensus attack: the panel's shared concern was that accepting a custom
pin and deferring semantic authority to the harness could leave capacity
consumed after a late rejection. The design resolves this with a queryable
non-retryable task disposition and reservation release. The intentionally
avoided question is provider-account entitlement: the harness/relay remains
the final authority, and Kookr preserves and surfaces its structured failure.

## Open questions

- Whether a future Codex or Grok CLI exposes a stable runtime catalog; the
  current built-in suggestions and custom-input path make this non-blocking.
- Existing tasks and schedules created before pin persistence have no reliable
  source for a previously omitted pin; they remain unpinned, while in-flight
  tasks with unknown persisted metadata require operator confirmation before a
  pin-sensitive relaunch.
