# RFC: Non-Blocking Launch Dependency Incidents

## Status

**Phase 1 implemented (v4 - provider-aware admission)**

**Date:** 2026-05-13
**Author:** Jean Ibarz (with Codex)
**Implementation branch:** `rfc/launch-dependency-incidents`

---

## Problem

Historically, Kookr blocked task launch when a declared launch dependency failed preflight. The concrete failure on 2026-05-13 was a playbook launch for `local-research-agent` that declared `dependencies: [kb]`. Kookr ran `kb doctor --format=json`, received a non-zero exit, and rejected the task before creating it. The provider-aware admission slice in issue #2841 now preserves the task but prevents the adapter launch when health is confirmed degraded.

That behavior was wrong for advisory context sources, but the issue also exposed the
opposite failure mode: Kookr admitted work whose required provider was already
unhealthy. Kookr is an attention router and supervisor, so it should preserve the
vetted launch intent and surface the dependency failure without consuming a worker
slot. Unknown health is fail-open when no stronger circuit evidence exists, so
a broken diagnostic path does not pause a healthy fleet; it must not erase a
previously confirmed degraded or half-open gate.

The observed case also exposed two independent bugs:

- Kookr classified an index failure as `server_reachability` because fallback substring matching saw `server` inside `knowledge-base-mcp-server`.
- After rebuilding the KB index, `kb doctor` returned `warn` with index/backend OK, but `kb search` still failed with `Cannot read properties of undefined (reading 'faiss_search_ms')`. A doctor-only preflight does not prove the KB search capability works.

## Empirical Grounding

Round-1 empirical probing verified the load-bearing claims:

- Before Phase 1, `launch-service.ts` ran dependency preflight before prompt normalization, dedup, and task creation. A dependency finding threw `LaunchPreflightError` before any task existed.
- Dedup uses the effective prompt string. Any dependency warning appended before dedup would change task identity.
- WS, REST, and playbook dependency parsing accepts string dependencies only. Object-form dependency declarations require contract/parser changes.
- On this machine, `kb doctor --format=json` can return `status: "warn"` with `index`, `backend`, and `active_model` OK while `kb search ...` fails with `Cannot read properties of undefined (reading 'faiss_search_ms')`.

No empirical claim was falsified. The KB-first lookup for prior notes could not run because `kb search` is itself failing with the same runtime error; this RFC therefore relies on repo-local evidence and the live reproduced failure.

## Recommendation

The current string dependency contract is treated as a required admission
declaration: confirmed degradation parks the task before adapter launch. A clean
or unknown result remains launchable only when no confirmed degraded/half-open
state already exists; future explicit advisory policies can opt into degraded
launch behavior without changing the durable intent contract.

My recommendation is deliberately phased:

1. **Phase 1 fixes the launch boundary.** Keep the existing string dependency contract. Run a better KB preflight, classify failures accurately, persist the launch intent, and park confirmed-degraded work without consuming a worker slot. Healthy results launch; unknown results launch unless stronger degraded/half-open circuit evidence already exists.
2. **Phase 2 adds durable dependency incidents.** Add explicit dependency policies, a persistent redacted incident store, UI inspection, and manual repair tasks on top of the delivered admission queue.
3. **Phase 3 adds guarded self-healing.** Auto-repair and GitHub escalation become opt-in automation after incident classification, sanitization, repair verdicts, and rate limits exist.

Do not start with unconditional GitHub issue creation or unconditional repair-agent spawning. Those are useful endpoints, but they require dedupe, redaction, authority boundaries, queue semantics, and loop control.

## Phase 1 Requirements

- **P1-R1.** A declared dependency SHALL NOT prevent task creation or queueing. Confirmed dependency degradation SHALL park the task before adapter launch; unknown health SHALL remain fail-open only in the absence of stronger degraded/half-open circuit evidence.
- **P1-R2.** Phase 1 SHALL keep the public dependency contract as a string array. Object-form dependency policies are deferred.
- **P1-R3.** Phase 1 SHALL preserve the user's original task prompt for identity, deduplication, relaunch, and display.
- **P1-R4.** Phase 1 SHALL attach a minimal `launchHealthSummary` or equivalent metadata to the task/result when KB is degraded.
- **P1-R5.** Launch notes SHALL be passed to the adapter/session after dedup, not by mutating `Task.prompt`. Confirmed degradation SHALL use a durable `launchAdmission.status: "parked"` marker instead of starting the adapter; unknown findings may continue with a bounded note.
- **P1-R6.** Phase 1 SHALL parse structured `kb doctor --format=json` output even when the command exits non-zero.
- **P1-R7.** Phase 1 SHALL add a bounded, read-only `kb search` smoke test so doctor-pass/search-fail is visible at launch time.
- **P1-R8.** Phase 1 SHALL redact and bound any diagnostic snippets returned to clients or inserted into launch notes.
- **P1-R9.** Failure to record or display diagnostics SHALL NOT turn an otherwise healthy circuit into a fleet-wide block. Unknown evidence SHALL NOT clear an existing degraded/half-open decision.

## Delivered Provider-Admission Requirements

- **P1-R10. [Implemented by issue #2841.]** Queued tasks SHALL persist normalized launch dependency intent so promotion can re-evaluate the same policy.
- **P1-R11. [Implemented by issue #2841.]** Required dependency failure during promotion SHALL use an explicit blocked-pending representation, not plain `pending`.

## Future Requirements

- **F-R1.** Explicit dependency declarations SHALL support `advisory` and `required` policies.
- **F-R2.** Required dependency failures SHALL be exposed through the same redacted public error shape as advisory incidents.
- **F-R5.** Dependency incidents SHALL be fingerprinted, deduplicated, persisted, and retained with bounds.
- **F-R6.** Manual repair tasks SHALL use an internal recursion guard and return a machine-readable repair verdict.
- **F-R7.** Auto-repair and GitHub escalation SHALL be opt-in, rate-limited, and server-mediated.

## Non-Goals

- No automatic GitHub issue creation in Phase 1.
- No automatic repair-agent spawning in Phase 1.
- No public dependency object contract in Phase 1.
- No persistent incident store in Phase 1.
- No general queue blocked-state redesign in Phase 1; issue #2841 adds only the minimal durable `parked` / `probing` admission marker and the `half_open_waiting_for_capacity` reason needed for provider-aware promotion.
- No cloud telemetry or remote crash reporting.
- No guarantee that a degraded task produces the same answer quality as a task with KB healthy.
- No runtime transcript monitoring for dependency failures in Phase 1. Phase 1 only handles launch-time evidence.

## Phase 1 Design

### Scope

Phase 1 is a small backend reliability change:

- `dependencies: ['kb']` remains valid.
- Confirmed KB/provider failure becomes parked admission work.
- Healthy evidence continues launch. Unknown evidence continues launch only when no stronger degraded/half-open circuit state exists.
- The prompt identity remains unchanged.
- The launch result/task carries minimal health metadata.
- A session receives a short launch note only when a launch remains admissible; confirmed degradation is represented by the parked task instead.

No incident ids, persistent incident store, full incident inspection panel, repair task, public policy object, or GitHub issue creation ships in Phase 1; the dashboard only surfaces parked counts and reasons.

### Core And I/O Boundary

Historical pre-Phase-1 code shelled out from `src/core/launch-dependency-preflight.ts`. The delivered implementation removes that boundary violation.

Delivered split:

- `src/core/launch-dependency-preflight.ts`: pure types, structured classification, report shaping, redaction helpers that operate on provided strings/objects.
- `src/server/launch-dependency-runner.ts`: concrete bounded `kb doctor` and `kb search` execution.
- `launch-service.ts`: orchestrates the runner and applies the provider-aware admission decision.

This keeps external process execution at an I/O boundary while letting core logic remain testable.

### Launch Flow

Pre-Phase-1 behavior threw before task creation:

```ts
const findings = await runLaunchDependencyPreflights(opts.dependencies);
if (findings.length > 0) throw new LaunchPreflightError(findings);
```

Phase 1 behavior:

```ts
const report = await runLaunchDependencyPreflights(opts.dependencies);
const admission = launchDependencyAdmission.evaluate(opts.dependencies);

const guardedPrompt = await applyWorktreeGuardrails(opts.prompt, opts.cwd);
const effectivePrompt = normalizePromptFileReferences(guardedPrompt, opts.cwd);

// Dedup uses effectivePrompt only, not launch notes.
const existing = checkSubmission(taskStore, effectivePrompt, agentType, opts.cwd);

const task = taskStore.createTask({
  prompt: effectivePrompt,
  cwd: opts.cwd,
  launchIntent: buildLaunchIntent(opts),
  launchAdmission: admission.admit ? undefined : toTaskLaunchAdmission(admission),
});

if (!admission.admit) {
  taskStore.pendTask(task.id);
} else {
  await adapter.launch(task, { launchNote: formatLaunchHealthNote(report.findings) });
}
```

The exact adapter API may differ; the requirement is that the warning is separate from the durable prompt before dedup.

### KB Preflight

Phase 1 KB preflight runs:

1. `kb doctor --format=json`
2. a bounded read-only search smoke test that exercises the query path

The smoke test must not refresh or mutate the index. No-results is acceptable if the command exits successfully. Command failure becomes a classified finding such as `query_runtime_failure`; confirmed degradation parks the dependent launch while an unclassifiable timeout remains fail-open.

Structured classification order:

1. Parse `kb doctor --format=json` stdout even when exit code is non-zero.
2. Classify from failed `checks[]` first.
3. Classify the search smoke test from its error code/stderr.
4. Use broad substring heuristics only as fallback.

This directly prevents the `knowledge-base-mcp-server` substring misclassification.

### Minimal Redaction

Phase 1 does not need a full incident redaction subsystem, but it must not return raw command output blindly.

Minimum rules:

- cap stdout/stderr snippets
- redact home prefix to `~`
- redact token-like key/value strings
- redact URLs with embedded credentials
- omit full prompts and full environment variables

This redacted shape is used for launch health metadata, API errors, and launch notes.

### Admission-Aware Queued Tasks

The provider-aware admission slice (issue #2841) extends the queued-task
contract without changing the public string dependency declaration:

- every declared dependency is retained in `Task.launchIntent` with the original prompt, repository, agent, effort, model, and idempotency key;
- confirmed degradation creates `Task.launchAdmission.status: "parked"`, keeps the task in `pending`, and consumes no worker slot;
- promotion re-runs the bounded preflight, skips parked work while degradation remains, and permits one half-open recovery probe before returning the circuit to `healthy`;
- health collection failures are `unknown` and remain fail-open only without stronger degraded/half-open evidence, so instrumentation gaps neither create an unbounded retry loop nor bypass a confirmed gate;
- capacity and launch-dependency diagnostics report parked work separately from tasks that already launched with degraded findings.
- dependency declarations are included in active-task dedup identity and are forwarded by one-shot schedules as well as interactive/looped launches;
- persisted launch intent validation reconstructs the complete replay contract before promotion, crash recovery, provider retry, or provider-reset replay uses it;
- a claimed half-open probe is durable (`probing`) with its exact session id before adapter launch. Launch failure re-parks only after that session is proven stopped. A rejected stop in direct launch, promotion, or crash recovery retains the exact marker, busy circuit, and possibly-live session ownership. Timeout before the creation callback retains that identity even with zero session rows; a late callback links and reaps it. Completion/cancellation/termination may win the work outcome. Successful owner-controlled cleanup settles the circuit and clears the terminal marker immediately; unresolved cleanup, creation, or circuit ownership retains the fence until runtime reconciliation or startup atomically settles the durable marker and process-local circuit. The marker alone does not assert process liveness and deletion skips/refuses it. Non-terminal ownership then degrades/re-parks, while terminal ownership releases to one unclaimed half-open probe unless confirmed degradation observed through cleanup keeps the circuit degraded. A live reconciled probe clears its marker unless confirmed degradation recorded at or after that probe began still controls the circuit;
- dependency-parked tasks are exempt from the generic pending TTL and excluded from launchable pending depth so unrelated work-conservation actuators can still refill free slots;
- REST replay/duplicate responses preserve admission metadata, while compact task listings retain only safe legacy intent pins and redact prompt-bearing/replay fields.

Implementation ownership:

- `launch-service.ts` computes submission-time dependency health, stores the normalized launch intent, and applies the provider-aware admission circuit before adapter launch.
- `agent-lifecycle.ts` owns promotion-time behavior. It re-runs dependency preflight before `adapter.launch`, updates parked admission state, and passes only applicable launch notes to the adapter.
- The adapter launch boundary accepts the optional launch note without changing the durable task prompt.

The general policy-object queue contract is deferred to Phase 2. This slice
already preserves string dependency declarations across queue promotion and
parks confirmed-degraded work.

## Phase 2 Design

Phase 2 turns launch health into a durable incident system.

### Explicit Dependency Policy

The public protocol can then accept both legacy string form and object form:

```ts
type LaunchDependencyPolicy = 'advisory' | 'required';

type LaunchDependencyDeclaration =
  | LaunchDependency
  | {
      name: LaunchDependency;
      policy: LaunchDependencyPolicy;
    };
```

Legacy string declarations remain required; object form with `policy: 'advisory'` opts into degraded launch.

### Durable Launch Intent For Queued Tasks

Queued tasks need enough launch intent to retry correctly:

```ts
interface QueuedLaunchIntent {
  dependencies: NormalizedLaunchDependencyDeclaration[];
  launchSource?: string;
  lastLaunchHealthSummary?: LaunchDependencyHealthSummary;
  pendingLaunchBlocker?: RedactedLaunchPreflightError;
  nextPromotionAttemptAt?: string;
}
```

Promotion rules:

- advisory failure at promotion: launch degraded
- required failure at promotion: set `pendingLaunchBlocker`, set `nextPromotionAttemptAt`, skip this task until retry time, and allow later pending tasks to promote
- required dependency later passes: clear `pendingLaunchBlocker` and promote normally
- user cancels: normal cancellation
- user changes policy: clear/recompute blocker

This avoids FIFO starvation and avoids treating a dependency block as a generic launch crash.

### Incident Model

The core model owns classification and fingerprinting; the server store only persists/upserts already-shaped records.

```ts
interface DependencyIncident {
  schemaVersion: 'dependency-incident.v1';
  id: string;
  fingerprint: string;
  dependency: LaunchDependency;
  category: LaunchPreflightFailureCategory | 'query_runtime_failure';
  status: 'open' | 'triaged' | 'repairing' | 'verifying' | 'resolved' | 'needs_human' | 'ignored';
  severity: 'info' | 'warning' | 'critical';
  firstSeenAt: string;
  lastSeenAt: string;
  occurrenceCount: number;
  affectedTaskIds: string[];
  latestTaskId?: string;
  summary: string;
  redactedEvidence: RedactedDependencyEvidence;
  repairTaskId?: string;
  repairVerdict?: RepairVerdict;
  githubIssueUrl?: string;
  nextAllowedActionAt?: string;
}
```

Persistence rules:

- atomic JSON write
- best-effort upsert with in-memory fallback
- bounded snippets
- max affected task ids per incident with rollup count
- prune resolved/ignored incidents by age
- compact old occurrences

Terminal states:

- `resolved`: terminal until the same fingerprint recurs, then reopens.
- `ignored`: terminal for notifications and auto-repair until the user unignores it. Task-level degraded launch metadata remains visible.
- `needs_human`: not terminal for the incident. It may transition to `ignored`, `repairing` after user retry, `resolved` after verification, or GitHub escalation after approval.

Incident state transitions:

| From | Trigger | To |
|---|---|---|
| `open` | user inspects or classifier assigns action | `triaged` |
| `open` / `triaged` / `needs_human` | manual repair task launched | `repairing` |
| `repairing` | repair task returns `fixed` | `verifying` |
| `verifying` | preflight passes | `resolved` |
| `verifying` | preflight still fails | `needs_human` |
| `repairing` | repair verdict `local_state_documented` | `needs_human` unless verification now passes |
| `repairing` | repair verdict `kookr_bug` / `upstream_bug` | `needs_human` with proposed issue body |
| `repairing` | repair verdict `inconclusive` | `needs_human` |
| any non-terminal | user ignores fingerprint | `ignored` |
| `ignored` | user unignores | `open` |
| `resolved` | same fingerprint recurs | `open` |

### Fingerprinting

Fingerprinting lives in pure core code:

```ts
fingerprintDependencyIncident(finding: LaunchDependencyFinding): string
```

Canonicalization rules:

- strip timestamps, request ids, durations, temp paths, and home path prefixes
- bucket volatile ports and PIDs
- include dependency name, provider check id, category, stable error code, and active model id when model identity changes behavior
- cap normalized detail length
- detect collisions when the same fingerprint receives materially different failed checks

Test vectors:

| Failure | Fingerprint behavior |
|---|---|
| `kb doctor`: active model index not built for model A | distinct from model B if model id differs |
| `kb doctor`: backend ECONNREFUSED | distinct from empty index |
| `kb` binary ENOENT | distinct configuration failure |
| malformed doctor JSON | one parse-failure fingerprint per dependency/version |
| doctor passes but smoke search crashes with `faiss_search_ms` | query-runtime fingerprint, not index fingerprint |
| same error with different request ids/timestamps | same fingerprint |

### UI Surface

Phase 2 adds a dedicated dependency incident surface, not the existing agent findings queue. Agent findings are about agent behavior. Dependency incidents are system diagnostics. They can influence attention severity, but they should not masquerade as stuck-agent findings.

Initial UI:

- task badge: `KB degraded`
- incident list / detail panel
- inspect redacted evidence
- ignore / unignore fingerprint
- spawn manual repair task

Severity rules:

- first advisory failure for one task: `info`
- same fingerprint affecting multiple active tasks: `warning`
- required dependency blocking queued or manual launches: `critical`
- failed repair verdict: `warning` or `critical` depending on affected task count

### Manual Repair Task

Manual repair is Phase 2. It is a normal Kookr task spawned from an incident action, with an internal-only override:

```ts
dependencyPreflightOverride: {
  skip: ['kb'];
  reason: 'dependency-repair';
  originIncidentId: string;
  suppressAutoRepair: true;
}
```

This override is not accepted from external REST or WS clients.

The server action rejects duplicate active repair for the same fingerprint. If `repairTaskId` is active and the incident is `repairing` or `verifying`, the action routes the user to the existing repair task instead of spawning another.

Repair target resolution uses dependency-specific server/adapters code. The generic repair launcher does not inspect KB-shaped fields. For KB, the resolver may suggest the symlinked KB CLI checkout from redacted doctor output, but Kookr validates that the path exists, is a git repo, is under an allowed local root, and matches expected repo identity. If validation fails, Kookr falls back to the Kookr repo or asks the user.

Repair tasks return a machine-readable verdict:

```ts
type RepairVerdict =
  | { status: 'fixed'; verificationCommand: string; verificationResult: string; changedFiles?: string[] }
  | { status: 'local_state_documented'; operatorAction: string; verificationCommand?: string }
  | { status: 'kookr_bug'; proposedIssueBody: string; evidenceRefs: string[] }
  | { status: 'upstream_bug'; targetRepo: string; proposedIssueBody: string; evidenceRefs: string[] }
  | { status: 'needs_human'; reason: string }
  | { status: 'inconclusive'; reason: string };
```

The server verifies `fixed` by rerunning the relevant preflight before marking the incident resolved.

## Phase 3 Design

### GitHub Escalation

GitHub issue creation is server-mediated and not part of Phase 1.

The repair task may produce a proposed issue body. The server action owns:

- target repo selection
- dedupe against open issues
- final sanitization
- approval policy
- issue creation or comment update

Default behavior is manual approval. Trusted local automation may later enable auto-escalation for high-confidence `kookr_bug` verdicts, but only after a successful dedupe query and only within rate limits.

### Auto-Repair

Auto-repair is opt-in:

```text
KOOKR_AUTO_REPAIR_DEPENDENCY_INCIDENTS=false
```

Eligibility:

- advisory dependency only
- known bounded repair action
- fingerprint not ignored
- no active repair task for the fingerprint
- global active repair budget available
- per-dependency cooldown elapsed
- previous repair verdict was not `needs_human`

Auto-repair tasks and their descendants carry `originIncidentId` and `suppressAutoRepair`, preventing recursive repair storms.

## Delivered And Future Files

Phase 1 delivered across these boundaries:

- `src/core/launch-dependency-preflight.ts`: pure report types, structured classification, redacted public finding shape.
- `src/core/launch-dependency-preflight.test.ts`: structured classification, doctor non-zero JSON, search-smoke failure classification, redaction.
- `src/server/launch-dependency-runner.ts`: bounded concrete `kb doctor` and `kb search` execution.
- `src/core/launch-dependency-admission.ts`, `src/core/task-launch-intent.ts`: provider circuit and durable replay contract.
- `src/core/pending-task-ttl.ts`, `src/core/capacity-ledger.ts`, `src/core/launch-dependency-diagnostics.ts`: distinct capacity-wait, dependency-parked, confirmed, and unknown populations.
- `src/server/launch-service.ts`: preserve prompt identity, persist launch intent, park confirmed-degraded work, and pass runtime launch notes only for admissible launches.
- `src/server/agent-lifecycle.ts`, `src/server/crash-recovery.ts`, `src/server/reconciliation.ts`, `src/server/startup-recovery.ts`: promotion, restart, partial-session cleanup, terminal precedence, and bounded half-open recovery.
- `src/server/schedule-validator.ts`, `src/server/schedule-runner.ts`, `src/server/ralph-loop-service.ts`: scheduled/loop dependency propagation and deferred-owner recovery.
- `src/server/routes/task-routes.ts`, `src/server/ws-handlers/launch-result.ts`: metadata-stable REST/WS feedback and safe compact projection.
- Focused tests beside each module cover direct launch, promotion, crash recovery, restart, replay/dedup, capacity, scheduling, and Ralph ownership.

Phase 2:

- `src/core/playbook.ts`: dependency declaration type with policies.
- `src/core/playbook-parser.ts`: parse string and object dependency declarations.
- `src/shared/contracts/playbook.ts`: shared dependency contract.
- `src/shared/contracts/messages.ts`: launch dependency contract for WS.
- `src/shared/contracts/client-message-schema.ts`: accept legacy string dependencies and object dependencies.
- `src/server/routes/task-routes.ts`: parse REST dependencies through the same normalization path and return redacted required-failure errors.
- `src/core/dependency-incident.ts`: incident draft, fingerprinting, severity, redaction model.
- `src/server/dependency-incident-store.ts`: persistent best-effort store.
- `src/core/types.ts`: queued launch intent, `pendingLaunchBlocker`, `nextPromotionAttemptAt`, and incident/task cross-references.
- `src/server/ws.ts` / handlers: dependency incident snapshot and actions.
- `src/frontend/*`: degraded badge, incident inspection, manual repair action.
- repair verdict ingestion and verification endpoint/action.

Phase 3:

- optional GitHub escalation action
- auto-repair budget and cooldown state

Docs:

- `docs/features.md`: resilience section adds advisory launch degradation and dependency incidents.
- `docs/architecture.md`: launch dependency flow, I/O boundary, repair recursion guard.

## Edge Cases

- **Agent binary missing.** Still blocking. No useful session can run.
- **Invalid cwd.** Still blocking unless a future RFC defines a safe resolver.
- **KB doctor passes but search fails.** Phase 1 catches this with a smoke search and parks the dependent launch.
- **Diagnostic recording/display fails.** Unknown collection remains fail-open only without an existing confirmed degraded/half-open gate. Kookr logs a server warning.
- **Identical task launched during outage and after recovery.** Dedup uses the original prompt/cwd/agent identity, not the degradation note.
- **Queued task sees dependency state change in the current slice.** Confirmed degradation keeps the task parked; a clean preflight moves it through one half-open recovery probe. Unknown health cannot erase either state.
- **Required dependency fails at promotion in Phase 2.** The task gets `pendingLaunchBlocker` and `nextPromotionAttemptAt`; later pending tasks are not starved.
- **Repair task causes another dependency incident.** Internal override suppresses auto-repair recursion.
- **Private data in diagnostics.** Redaction applies before UI, prompts, transcripts, and GitHub escalation.
- **Fingerprint over-collapses failures.** Collision detection records materially different failed checks under a collision flag and keeps latest evidence separate.
- **User ignores a fingerprint.** Notifications and auto-repair are suppressed; task-level degraded state remains visible.

## Alternatives Considered

### Keep Hard Blocking

Rejected as a pre-create rejection. It optimizes for preflight purity over user momentum and loses the vetted launch intent. The current boundary parks confirmed-degraded work after creating the durable pending record.

### Make Every Dependency Non-Blocking

Rejected. Some prerequisites define whether an agent session can produce useful work. The current string contract treats declared dependencies as required for admission; explicit advisory policy is deferred until the public policy contract is introduced.

### Mutate The Prompt With Warnings

Rejected. It breaks task identity and dedup semantics. Use launch metadata plus adapter/session launch notes instead.

### Add Public Dependency Policies In Phase 1

Rejected. It is a reasonable Phase 2 design, but public policy objects would expand WS, REST, and playbook parser scope before queue semantics are ready. The current slice keeps the string contract and uses the parked marker for confirmed failures.

### Always Auto-Create GitHub Issues

Rejected as the default. Many failures are local state, and public escalation needs sanitization, dedupe, and target repo selection.

### Always Auto-Spawn Repair Agents

Rejected as the default. It is useful in trusted local mode but needs loop control, budgets, and machine-readable repair verdicts.

### Remove Dependency Preflights Entirely

Rejected. Preflights are useful because they make degraded capabilities explicit before the agent wastes time. The problem was either rejecting before persistence or admitting work after a confirmed required-provider failure.

## Implementation Plan

### Phase 1: Provider-Aware Admission For Declared Dependencies

- Move concrete KB command execution to server/adapters.
- Parse non-zero doctor JSON structurally.
- Add bounded KB search smoke test.
- Treat confirmed dependency findings as parked admission work.
- Preserve task prompt identity.
- Store minimal launch health metadata.
- Launch healthy findings, and unknown findings without stronger circuit evidence, with a bounded runtime launch note.
- Add focused tests.

### Phase 2: Incident Surface And Manual Repair

- Add explicit dependency policy contract.
- Expand the incident model beyond the minimal parked-pending state already delivered by issue #2841.
- Add redacted incident model and best-effort store.
- Add fingerprint dedupe and lifecycle.
- Expand the dashboard beyond its current parked-count/reason pill into a full incident inspection surface.
- Add manual repair task action with internal preflight override.
- Require machine-readable repair verdict and verification.

### Phase 3: Guarded Automation

- Add optional auto-repair budgets/cooldowns.
- Add server-mediated GitHub escalation from repair verdicts.
- Add runtime dependency incident detection from transcript/tool failures if needed.

## Open Questions

- What exact smoke search command is stable enough for KB without refreshing or mutating state?
- Should Phase 1 persist `launchHealthSummary` on `Task`, return it only in the launch result, or both?
- Should advisory dependency failures ever prompt for confirmation once explicit policies exist?
- How long should ignored/resolved incident fingerprints be retained?
- Which dependencies beyond KB deserve providers in Phase 2?

## Critic Feedback Incorporated

- `design-minimalist` 2026-05-13 round 1: narrowed v1 to degraded KB launch, classification, smoke test, and minimal metadata; moved incident UI, repair tasks, auto-repair, and GitHub escalation into later phases.
- `failure-mode-analyst` 2026-05-13 round 1: made incident persistence best-effort, moved redaction before storage/prompt injection, added global/per-dependency auto-repair budgets, stale evidence handling through verification, and bounded retention.
- `boundary-critic` 2026-05-13 round 1: stopped mutating `Task.prompt`, moved fingerprinting/classification into core, separated dependency incidents from agent findings, introduced provider boundaries, and made GitHub escalation server-mediated.
- `socratic-challenger` 2026-05-13 round 1: elevated doctor-passes/search-fails into Phase 1 via KB smoke search, specified queued task behavior, internal repair preflight override, lifecycle transitions, fingerprint vectors, and repair authority.
- `ambition-amplifier` 2026-05-13 round 1: added incident lifecycle suitable for later automation, classifier/action matrix direction through provider design, machine-readable repair verdicts, and guarded self-healing eligibility.
- `design-experimenter` 2026-05-13: verified prompt/dedup ordering, string-only dependency parsing, doctor-pass/search-fail behavior, and current throw-before-task behavior.
- `state-machine-verifier` 2026-05-13 round 2: mapped all repair verdicts to incident transitions, clarified terminal states, and deferred required-dependency queue blocking to Phase 2.
- `failure-mode-analyst` 2026-05-13 round 2: required redacted error shapes for required failures, persisted launch dependency intent for queued promotion, blocked-pending skip/retry semantics, and duplicate manual repair guard.
- `boundary-critic` 2026-05-13 round 2: moved concrete KB command execution out of core, added queued launch intent ownership, and made required promotion blocking an explicit Phase 2 state rather than plain `pending`.
- `design-minimalist` 2026-05-13 round 2: removed public object-form dependency contract, incident ids, provider repair hooks, queue blocked-state redesign, and UI inspection from Phase 1.
- `design-minimalist` 2026-05-13 round 3: no blockers.
- `failure-mode-analyst` 2026-05-13 round 3: no blockers.
- `boundary-critic` 2026-05-13 round 3: clarified Phase 1 queued launch-note ownership in `agent-lifecycle.ts` and moved repair verdict ingestion/verification into Phase 2 ownership.
- Adversarial scope decision 2026-05-13: agreed with `design-minimalist` for Phase 1 scope, while retaining `ambition-amplifier`'s self-healing loop as explicit later-phase architecture because the user's goal includes diagnosing and tackling dependency failures inside Kookr.
