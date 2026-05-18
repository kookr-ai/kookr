# RFC: Supervisor Finding Evidence Review Loop

**Status:** Draft (v3 - post round-2 critic revision)
**Date:** 2026-05-18
**Author:** Jean Ibarz (with Codex)

---

## Problem

Kookr's main product promise is to surface the tasks and agents that require attention. If a supervisor finding is wrong, too early, or missing, the operator's trust drops quickly.

PR #458 adds the first layer: when a finding is surfaced, Kookr keeps a bounded evidence audit across multiple observations. That audit can already distinguish stable evidence from timing-sensitive findings such as "needs input" that clear after a few seconds of terminal output.

The remaining gap is a detector-quality loop. Today the evidence audit is available to humans and diagnostics endpoints, but the system does not yet have a defined way to sample real examples, ask a cheap reviewer model to classify them, store the assessment, and turn repeated mistakes into concrete detector improvements.

Without that loop, false positives and false negatives are found mostly through manual operator frustration. That is too slow for the feature that decides whether work needs human attention.

## Empirical Checkpoint

The current branch already contains the runtime evidence substrate:

- `FindingEvidenceAuditor` records active and resolved finding evidence over time.
- `Monitor.processEvents()` observes detector results after event processing.
- `Monitor.applyWatchdogVerdict()` observes actionable watchdog findings.
- `Monitor.sampleFindingEvidence()` adds watchdog-tick samples with optional pane text.
- `/api/finding-evidence-audit` exposes all audit records and review candidates.
- Browser-bound snapshots strip `paneExcerpt` before sending evidence to clients.
- Requirement R2.11 documents the evidence-audit behavior.

The repo also already has a provider-neutral LLM boundary in `src/core/llm-types.ts` / `src/core/llm-factory.ts`, used by task naming and Telegram rephrasing. This RFC should reuse that boundary instead of creating a new provider abstraction.

## Goals

- Make detector-quality review a product mechanism, not an ad hoc debugging activity.
- Keep live supervision deterministic; do not call an LLM in the hot path for every finding.
- Use real evidence snapshots sampled across time so timing-related findings are judged fairly.
- Start with the smallest useful review loop: metadata-only, manual, false-positive-oriented.
- Store review outcomes only after the manual signal proves useful.
- Produce concrete detector-improvement candidates without automatically changing live alert behavior.
- Define when the mechanism runs and how operators or future skills should use it.

## Non-Goals

- Do not suppress or downgrade live findings automatically in V1.
- Do not send full terminal transcripts or raw secret-bearing logs to a model.
- Do not require a large model.
- Do not make the mechanism dependent on a Codex or Claude skill at runtime.
- Do not solve silent false negatives in M1.
- Do not replace deterministic detector tests with model judgments.

## Requirements

- Kookr SHALL keep runtime finding detection deterministic in V1.
- M1 SHALL review evidence asynchronously through an explicit manual action.
- M1 SHALL use only `possible_false_positive` and `transient_too_fast` records from the existing evidence auditor.
- M1 SHALL use metadata-only reviewer input by default.
- M1 SHALL validate reviewer output with a versioned schema and semantic consistency checks.
- M1 SHALL return review results without mutating live findings.
- M1 SHALL require an explicit positive budget before making model calls.
- Kookr SHALL support false-negative seeds before background trend reporting graduates beyond diagnostics.
- Kookr SHALL store review results separately from task state once persistence is introduced.
- Kookr SHALL keep detector-change proposals advisory until implemented and tested by a normal PR.

## Design

### 1. Keep Runtime Detection Separate From Review

The supervisor continues to surface findings exactly as it does today:

```text
events/watchdog -> deterministic detectors -> current anomaly/finding -> dashboard
```

The review loop starts after evidence exists:

```text
finding evidence audit
  -> candidate sampler
  -> privacy-filtered compact input
  -> small-model review
  -> validated review result
  -> diagnostics and later detector-change candidates
```

This separation matters. A wrong model review should not hide an urgent permission request or a task that is genuinely blocked. The review loop is allowed to say "this detector probably fired too early"; it is not allowed to mutate the live anomaly queue in V1.

### 2. Responsibility Boundaries

Do not put schema construction, model calls, HTTP routing, and JSONL storage into one module.

Recommended boundaries:

| Boundary | Responsibility |
|---|---|
| `src/core/finding-evidence-review.ts` | Pure schemas, metadata-only input builder, output parser, semantic validation. No filesystem and no provider construction. |
| `src/core/finding-evidence-review.test.ts` | Input construction and validation tests. |
| `src/server/finding-evidence-review-service.ts` | Application service that selects candidates, estimates budget, calls an injected `LlmClient`, validates output, and returns/stores results depending on phase. |
| `src/server/review-log-store.ts` | Later JSONL persistence and retention. Server/infrastructure boundary, not core. |
| `src/server/routes/diagnostics-routes.ts` | Parse request, enforce local/admin/rate-limit guards, call the service. No review orchestration logic. |
| diagnostics projection types | Safe browser/API summaries only. Internal compact model inputs stay server-side. |

False-negative sources get their own normalized DTO later:

```ts
export interface AttentionMissSeed {
  id: string;
  agentId: string;
  occurredAt: string;
  reason: 'user_reply_without_active_finding' | 'manual_action_without_active_finding' | 'repeated_instruction';
  priorFindingState: 'none' | 'recently_resolved' | 'active_other_type';
  lookbackMs: number;
  eventSeq?: number;
}
```

The sampler consumes this DTO, not raw interaction-log or friction-analyzer internals.

The service reads evidence through a narrow port:

```ts
export interface FindingEvidenceCandidateReader {
  listReviewCandidates(limit: number): FindingEvidenceAuditRecord[];
}
```

M1 candidate filtering and ordering is a pure function over audit records. The service should not depend on `Monitor` internals or diagnostics route shape.

### 3. M1 Candidate Source

M1 is intentionally false-positive-oriented and uses only existing auditor verdicts:

- records with `possible_false_positive`;
- records with `transient_too_fast`.

Ambiguous active records, pane-change heuristics, and calibration examples move to M1b/M2 after the manual reviewer has proven useful.

Silent false negatives are important, but they require a different sampling design. They move to M3.

### 4. Trigger Policy

The review loop has four trigger modes, shipped in phases:

| Trigger | Phase | Behavior |
|---|---:|---|
| Manual diagnostics dry run | M1 | Operator asks Kookr to review a bounded current candidate batch; results are returned in the response. |
| Manual persisted review | M1b | Same as M1, but valid and invalid attempts are appended to the review log. |
| Scheduled sampler | M2 | Background timer reviews at most N candidates per interval within a cost budget. |
| False-negative seed enqueue | M3 | Interaction/friction seeds are sampled with task-scoped correlation metadata. |

Do not run the reviewer model synchronously inside `Monitor.processEvents()` or watchdog sampling. The detector can produce many observations quickly; the review loop only needs representative examples after timing has settled.

Recommended M1 defaults:

- feature flag: disabled unless reviewer config exists;
- manual route mode: `estimate_only` by default;
- max candidates per request: 5;
- model calls require `model_review` or later `persisted_review` plus a positive daily budget;
- minimum finding age before model review: 10 seconds;
- minimum observations before model review: 2;
- pane excerpts: disabled.

### 5. M1 Review Input Schema

M1 should be metadata-only. Do not include pane excerpts, operator text, task prompts, or full explanations until privacy filtering has stronger tests.

```ts
export interface FindingEvidenceReviewInputV1 {
  schemaVersion: 'finding-evidence-review-input.v1';
  candidateId: string;
  candidateKind: 'false_positive';
  agentId: string;
  finding: {
    type: string;
    subType?: string;
    explanationHash: string;
    detectedAt: string;
    status: 'active' | 'resolved';
    auditVerdict: string;
  };
  observations: Array<{
    observationId: string;
    sampledAt: string;
    ageMs: number;
    source: 'event' | 'watchdog_tick';
    anomalyStillPresent: boolean;
    lastEventType: string | null;
    lastEventSeq?: number;
    eventCount?: number;
    paneChangedSincePrevious?: boolean;
  }>;
  versions: {
    inputBuilder: 'finding-evidence-review-input.v1';
    evidenceAuditor: 'finding-evidence-audit.v1';
    detector?: string;
    appGitSha?: string;
  };
}
```

Core owns deterministic input hashing:

```ts
export function canonicalizeReviewInputV1(input: FindingEvidenceReviewInputV1): string;
export function computeReviewInputHashV1(input: FindingEvidenceReviewInputV1, hmacKey: Buffer): string;
```

Storage and queueing receive the core-computed hash. They do not recompute their own representation.

Use HMAC-salted hashes for any string-derived hash that could otherwise become a cross-task correlation handle. Review input hashes are rebuilt from the privacy-filtered input; do not copy existing audit `paneHash` values into model input or public dry-run responses.

The HMAC key is local to the Kookr installation, stored outside logs, and generated if missing. Server config owns key lifecycle and injects the key into pure core hashing so `core` does not read files or environment variables. Rotating the key invalidates old review-input hashes and dedupe keys, which is acceptable because review history is diagnostics data rather than task state.

### 6. M1 Review Output Schema

M1 asks the model to classify the evidence, not design detector changes:

```ts
export interface FindingEvidenceReviewV1 {
  schemaVersion: 'finding-evidence-review.v1';
  candidateId: string;
  verdict:
    | 'supports_finding'
    | 'timing_false_positive'
    | 'likely_false_positive'
    | 'unclear';
  confidence: 'low' | 'medium' | 'high';
  evidenceRefs: string[];
  rationale: string;
  reviewedAt: string;
  reviewer: {
    provider: string;
    model: string;
    promptVersion: 'finding-evidence-review-prompt.v1';
  };
}
```

Validation requirements:

- `evidenceRefs` must reference existing `observationId` values from the compact input.
- Allowed M1 verdicts are `supports_finding`, `timing_false_positive`, `likely_false_positive`, and `unclear`.
- `rationale` is capped, control characters are stripped, and diagnostics render it as plain text.
- Invalid JSON, schema failures, unknown verdicts, bad refs, or inconsistent verdicts produce an invalid-attempt result, not a detector-quality verdict.

Suggested detector actions and detector-change summaries are deferred to M4, after repeated verdict grouping exists.

### 7. Privacy Filter

Every outbound model field goes through one review privacy filter, even metadata. The filter owns:

- allowlisted fields;
- max string lengths;
- secret-pattern denylist;
- HMAC-salted hashes;
- metadata-only default;
- optional excerpt inclusion later behind `includePaneExcerpt`;
- diagnostic reasons for omitted fields.

M1 does not send pane excerpts. A later excerpt-enabled version requires an explicit opt-in, max excerpt length, redaction test corpus, and diagnostics that say whether excerpts were enabled, omitted by policy, or omitted by redaction uncertainty.

### 8. Configuration And Access

M1 uses the existing `LlmClient` boundary and environment-driven provider selection. The review service should add component-level settings around that existing client:

| Setting | Default | Behavior |
|---|---|---|
| `KOOKR_FINDING_REVIEW_ENABLED` | `false` | Manual route returns disabled unless true or explicit local dev override is present. |
| `KOOKR_FINDING_REVIEW_MAX_CANDIDATES` | `5` | Hard per-request cap. |
| `KOOKR_FINDING_REVIEW_TIMEOUT_MS` | `15000` | Per model call timeout. |
| `KOOKR_FINDING_REVIEW_DAILY_COST_CENTS` | `0` | `0` means estimate-only; non-dry-run model calls are refused. Positive values enable calls up to the budget. |

The diagnostics route must fail closed in this order:

1. Feature flag enabled.
2. Existing LLM provider config available.
3. Authenticated admin or loopback-only request; do not trust spoofable forwarded headers unless the deployment explicitly opts in.
4. `POST` for any model-calling operation.
5. Explicit mode: `estimate_only`, `model_review`, or later `persisted_review`; default `estimate_only`.
6. Positive daily budget for `model_review` or later `persisted_review`.
7. Per-request candidate cap and rate-limit.
8. CSRF/header token if the route is browser-reachable.

M1 should track a process-local daily spend counter before M1b persistence exists. That is not sufficient for multi-process production scheduling, but it prevents accidental repeated manual calls in the first implementation. M1b/M2 can persist the counter.

A dry run returns a safe projection, not the exact model input:

```ts
export interface ReviewDryRunResponseV1 {
  schemaVersion: 'finding-evidence-review-dry-run.v1';
  candidates: Array<{
    candidateId: string;
    anomalyType: string;
    auditVerdict: string;
    observationCount: number;
    ageMs: number;
    privacyOmissions: string[];
    inputHash: string;
  }>;
  wouldCallModel: false;
  estimatedTokens: number;
  estimatedCostCents?: number;
}
```

The exact compact input is available only behind an explicit local-only debug mode.

### 9. Persistence And Queueing

M1 does not need persistence to prove the review signal. It can return validated review results directly in the manual route response.

M1b adds append-only persistence:

```text
~/.kookr/finding-evidence-reviews.jsonl
```

`ReviewLogStore` requirements:

- single-writer append queue or file lock;
- one JSON object per line;
- invalid lines skipped with diagnostics;
- corrupted-line quarantine if compaction rewrites the file;
- retention compaction via temp-file rename;
- model text stored with length caps and treated as untrusted;
- invalid model attempts stored as non-verdict records with `failureKind`, `rawOutputHash`, provider, model, prompt version, and input hash.

M2 adds a separate queue/checkpoint ledger. The review log is an audit artifact, not scheduler state. Queue entries use:

```ts
type ReviewCandidateState =
  | 'queued'
  | 'in_progress'
  | 'reviewed'
  | 'failed_retryable'
  | 'failed_terminal';
```

Each queued item stores `candidateId`, `inputHash`, `attemptCount`, `lastAttemptAt`, and `nextRetryAt`. Completion is idempotent by `candidateId + inputHash`.

Queue invariants:

- each in-progress item has a `runId` and `leasedUntil`;
- expired leases return to `failed_retryable` or `queued` according to attempt count;
- append the valid review or invalid attempt before marking the queue item `reviewed`;
- startup reconciles queue state from the review log by `candidateId + inputHash`;
- estimated spend is recorded before a call, actual spend is reconciled after provider response when usage data exists.

### 10. Cost And Scheduler Controls

M2 enforces costs before any background model call:

- estimate tokens from the compact input before enqueue/review;
- reject candidates that exceed per-candidate limits;
- persist daily spend/token counters;
- stop reviewing once the daily budget is exhausted;
- cap reviews per detector type so one noisy detector does not consume the whole budget;
- use retry limits and exponential backoff for provider failures;
- acquire a single-process lock so two Kookr processes do not both run the scheduler.

Diagnostics should show candidates sampled, candidates skipped by reason, model calls attempted/succeeded/failed, invalid outputs, storage failures, scheduler last run, next run, budget used, budget remaining, and provider availability.

### 11. False-Negative Seeds

M3 adds false-negative candidates only after M1/M2 prove the review loop useful.

A valid false-negative seed needs task-scoped correlation metadata:

- target task/agent;
- message/action source;
- event sequence or timestamp;
- prior finding state within a configurable lookback window;
- seed reason enum;
- confidence before model review.

The sampler should also include stratified non-finding task windows so diagnostics are not limited to operator-visible misses. Trend reporting must include denominators: eligible, sampled, reviewed, invalid, skipped.

The M3 sampling frame is all task-time windows with no active finding, stratified by:

- task state;
- terminal activity;
- detector opportunity;
- task age;
- recent finding state.

Track `eligible`, `sampled`, `reviewable`, `unreviewable`, `reviewed`, and `miss_confirmed`.

M3 should define its own compact input/output schema instead of stretching the M1 finding-review schema into miss detection.

### 12. Diagnostics UI

M1 does not need a dashboard project. The manual route response is enough.

After M1b/M2 creates durable volume, add a diagnostics-only "Detector Quality" surface:

- review-loop health counters;
- counts by verdict over the selected time window;
- recent high-confidence likely false positives;
- recent possible false negatives after M3;
- detector targets with repeated suggested changes after M4;
- links to evidence audit records and compact review input hashes;
- a "needs human review" bucket for unclear cases.

This should live under diagnostics or supervisor tooling, not the normal attention queue. The live attention queue should remain for actionable work, not detector research.

### 13. Skills And Operating Docs

Runtime use does not require a skill. The code knows when to collect evidence and when to enqueue candidates through deterministic triggers.

A skill or operator playbook is useful only around the human workflow:

- inspect detector-quality diagnostics;
- choose high-confidence repeated patterns;
- write a detector-fix PR with tests;
- compare review outcomes before and after the fix;
- decide whether a detector proposal graduates into product behavior.

Create a skill only after M1/M2 exists and the workflow stabilizes. The skill should describe how humans and agents use the review outputs; it should not be the runtime trigger.

## Phased Implementation

### M0: Evidence Audit Substrate

Already implemented by PR #458. Confirm `/api/finding-evidence-audit` has enough metadata for compact review candidates and that client projections keep raw excerpts private.

### M1: Manual Metadata-Only Reviewer

- Build compact metadata-only inputs from existing evidence-audit candidates.
- Reuse `LlmClient` through an injected dependency.
- Add strict output parsing and semantic validation.
- Add a local/admin manual diagnostics route with dry-run default.
- Enforce fail-closed route guards and a positive daily budget before any model call.
- Return review results in the route response; do not persist by default.
- Test input construction, privacy filtering, invalid output handling, evidence-ref validation, and route guardrails.

### M1b: Review Log

- Add `ReviewLogStore` under `src/server/`.
- Persist valid reviews and invalid attempts to JSONL.
- Add log reading for diagnostics.
- Add compaction/retention only if manual volume justifies it.

### M2: Background Sampler

- Add a disabled-by-default scheduler.
- Enqueue candidates only after minimum age and observation thresholds.
- Enforce per-interval, per-detector, token, and daily cost budgets.
- Deduplicate by `candidateId + inputHash`.
- Add queue state, retries, backoff, and single-process locking.

### M3: False-Negative Seeds

- Add normalized `AttentionMissSeed` DTOs from interaction and friction signals.
- Require task-scoped correlation and lookback metadata.
- Add stratified sampling of non-finding task windows.
- Track false-negative candidates separately from false-positive candidates in diagnostics.

### M4: Detector Proposal Reports

- Group repeated review verdicts by detector target.
- Generate advisory reports such as:
  - "needs_input fires too early when pane changes within 3 seconds";
  - "permission_blocked should require stable permission_request evidence";
  - "Ralph continuation prompts often need a next-action finding after terminal status."
- Require a normal implementation PR and deterministic tests before any detector changes ship.

## Files To Change

M1:

- `src/core/finding-evidence-review.ts`
- `src/core/finding-evidence-review.test.ts`
- `src/server/finding-evidence-review-service.ts`
- `src/server/finding-evidence-review-service.test.ts`
- `src/server/routes/diagnostics-routes.ts`
- `src/server/routes/diagnostics-routes.test.ts`
- `docs/requirements.md`

M1b/M2:

- `src/server/review-log-store.ts`
- `src/server/review-log-store.test.ts`
- `src/server/lifecycle-timers.ts` or a new scheduler module
- scheduler/service tests

M3/M4:

- `src/core/friction-analyzer.ts`
- `src/core/interaction-log.ts` or existing interaction readers
- diagnostics UI files if/when durable volume exists
- later operator skill for detector-quality reports

## Edge Cases

| Case | Handling |
|---|---|
| Model returns invalid JSON | Store/return invalid-attempt result; do not count as detector verdict. |
| Model cites missing evidence | Invalid-attempt result. |
| Model returns inconsistent verdict | Invalid-attempt result. |
| Candidate contains possible secrets | M1 metadata-only; later privacy filter omits unsafe fields. |
| Finding resolves inside grace window | Prefer `timing_false_positive` over generic `likely_false_positive`. |
| Candidate remains active for a long time | Review once per input hash; do not re-review identical evidence. |
| Same detector produces many candidates | Sample and cap per detector target. |
| Operator message is ambiguous | M3 seed stays low-confidence or `unclear`; never accepted without task correlation. |
| Review log is deleted | Diagnostics history resets; runtime supervision is unaffected. |
| Hosted model unavailable | Manual route returns unavailable; scheduler skips with health counters. |
| Diagnostics renders rationale | Plain text only; no markdown execution, HTML injection, or command affordance. |

## Alternatives Considered

### Use Only Deterministic Heuristics

The existing evidence audit already does this. It is cheap and reliable, but it cannot reason well over mixed signals such as "the terminal advanced for two seconds, then stopped, and the finding still claims input is needed." The reviewer model is useful as an offline judge over compact evidence, not as the live detector.

### Let The Model Decide Live Findings

Rejected for V1. It adds latency, cost, privacy exposure, and nondeterminism to the core attention surface. A model can review whether detectors are healthy; it should not be the first-line supervisor until there is enough evidence that it improves precision and recall safely.

### Make This A Skill Instead Of Runtime Code

Rejected as the primary mechanism. A skill can teach an agent how to interpret detector-quality reports, but a skill does not run inside the Kookr monitor, cannot reliably sample evidence at timed intervals, and cannot maintain durable review state. Runtime code should collect and review; skills can guide human follow-up.

### Store Reviews On Each Task

Rejected. Detector-quality reviews are product telemetry, not task lifecycle state. Keeping them in a separate JSONL log avoids task-state churn, makes retention simple, and prevents model output from becoming part of startup-critical data.

## Open Questions

- Which cheap reviewer model should be the default for local development and production?
- Should the local-only debug mode expose exact compact inputs, or should M1 keep all public responses projection-only?
- What is the right daily cost budget for always-on review after M2?
- How many repeated high-confidence reviews are enough before Kookr should suggest a detector change?
- Should detector-quality diagnostics be local-only, or can they be shared in bug reports after redaction?
- What exact interaction-log fields are safe and sufficient for M3 false-negative seeds?

## Critic Feedback Incorporated

- Round 1 boundary-critic: split pure core review logic, server review orchestration, diagnostics routing, and JSONL persistence; added normalized `AttentionMissSeed` instead of reading raw interaction/friction internals.
- Round 1 design-minimalist: narrowed M1 to metadata-only manual false-positive review; moved persistence to M1b, background scheduling to M2, false-negative seeds to M3, and detector proposals to M4.
- Round 1 operability-reviewer: added configuration, route guardrails, cost controls, review-log requirements, invalid-attempt handling, queue states, and scheduler observability.
- Round 1 failure-mode-analyst: added task-scoped false-negative correlation, stratified sampling later, single privacy filter, stable evidence refs, version context, and hostile model-output rendering rules.
- Round 2 boundary-critic: added `FindingEvidenceCandidateReader`, safe dry-run projection, core-owned canonical input hashing, and finding-oriented verdicts.
- Round 2 design-minimalist: narrowed M1 candidates to existing `possible_false_positive` and `transient_too_fast` audit records; moved pane-change, ambiguous-active, and calibration sampling out of M1; removed ignored excerpt config.
- Round 2 operability/failure review: made M1 model-calling modes require a positive budget, specified fail-closed route guard order, defined local HMAC key semantics, added queue lease/recovery invariants, and defined the M3 false-negative sampling frame.
- Round 3 reviewers: found no substantive blockers; incorporated wording nits for trigger count, review modes, HMAC ownership, M1 observation wording, and M3 schema separation.
