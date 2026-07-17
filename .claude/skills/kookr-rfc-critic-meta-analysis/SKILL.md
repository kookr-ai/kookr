---
name: kookr-rfc-critic-meta-analysis
description: Kookr-internal extension to rfc-iterative-review that captures append-only critic traces for later meta-analysis of RFC reviewer subagents.
keywords: kookr, rfc, critic, subagent, meta-analysis, reviewer, trace, iterative-review, prompt evolution
related: rfc-iterative-review, kookr-skill-naming-convention
---

# RFC Critic Meta-Analysis

Use this skill after `rfc-iterative-review` when drafting or revising Kookr RFCs that should contribute evidence about reviewer-subagent quality.

This skill does **not** replace `rfc-iterative-review`. It extends that workflow with a lightweight trace so future reports can answer which critics were useful, noisy, missing risks, or worth changing.

## Scope

This is Kookr-internal because it writes Kookr RFC artifacts under `docs/rfc/` and informs Kookr's reviewer-subagent roster. Do not promote it to the toolkit plugin unless the paths and schema ownership are generalized.

For the design rationale, see `docs/rfc/rfc-subagent-feedback-meta-analysis.md`.

## Trace Location

For an RFC at:

```text
docs/rfc/rfc-<slug>.md
```

write the trace at:

```text
docs/rfc/meta/rfc-<slug>.critic-trace.jsonl
```

Each line is one JSON object using `docs/schemas/critic-trace.v1.json`.

## When to Capture

During RFC review:

1. Run the normal `rfc-iterative-review` critic rounds.
2. After each critic returns, append one `invocation` event.
3. After the convergence **consensus attack** returns, append one `invocation` event too. It fires once, on the way out of Phase 2, and is not a panel lens — but its outcome is exactly what this trace measures, so it must not go unrecorded. Set `critic: "general-purpose"`, `extractionNote: "consensus-attack at convergence; not a panel lens"`, and reuse the final round number for `round` (the schema requires an integer ≥ 1, and a convergence-time run has no round of its own). Set `noSubstantiveFindings: true` when the verdict is "consensus survives" — a null verdict is a recorded outcome, not a skipped run.
4. For each substantive finding that survives triage, append one `finding` event.
5. Keep the normal human-readable `Critic Feedback Incorporated` section in the RFC.
6. At the end of the RFC, add a short `Meta-analysis readiness` note in the critic-feedback section.

Do not record every sentence from critic output. Record substantive findings: defects, missing constraints, empirical-check requests, scope changes, user-intent questions, or useful simplifications.

## Minimal Events

### Invocation

Write one invocation event per critic per round, including critics with no substantive findings, plus one for the convergence consensus attack (see "When to Capture" step 3).

```json
{
  "schemaVersion": "critic-trace.v1",
  "recordType": "invocation",
  "rfcPath": "docs/rfc/rfc-example.md",
  "round": 1,
  "critic": "failure-mode-analyst",
  "sourceRef": {
    "kind": "manual_excerpt",
    "excerptHash": "sha256:<hash>"
  },
  "substantiveFindingsExtracted": true,
  "extractedFindingIds": ["rfc-example-r1-failure-mode-analyst-f1-1a2b3c4d"],
  "noSubstantiveFindings": false,
  "extractionNote": "Raw subagent transcript unavailable; finding copied from final subagent response."
}
```

If the critic produced no substantive finding, use:

```json
{
  "schemaVersion": "critic-trace.v1",
  "recordType": "invocation",
  "rfcPath": "docs/rfc/rfc-example.md",
  "round": 2,
  "critic": "design-minimalist",
  "sourceRef": { "kind": "unavailable" },
  "substantiveFindingsExtracted": true,
  "extractedFindingIds": [],
  "noSubstantiveFindings": true
}
```

### Finding

Generate `findingId` as:

```text
<rfc-slug>-r<round>-<critic>-f<ordinal>-<8-char-rawFindingHash>
```

Example:

```json
{
  "schemaVersion": "critic-trace.v1",
  "recordType": "finding",
  "rfcPath": "docs/rfc/rfc-example.md",
  "round": 1,
  "critic": "failure-mode-analyst",
  "findingId": "rfc-example-r1-failure-mode-analyst-f1-1a2b3c4d",
  "summary": "Outcome updates must be append-only, not mutable fields.",
  "rawFinding": "Delayed outcome updates can corrupt historical records if old JSONL lines are rewritten.",
  "sourceRef": {
    "kind": "manual_excerpt",
    "excerptHash": "sha256:1a2b3c4d..."
  },
  "disposition": "used",
  "dispositionReason": "RFC changed to append outcome events separately from finding events.",
  "valueNote": "Preserves time-horizon separation and auditability."
}
```

For duplicates, preserve the later critic's record and point at the first matching finding:

```json
{
  "schemaVersion": "critic-trace.v1",
  "recordType": "finding",
  "rfcPath": "docs/rfc/rfc-example.md",
  "round": 1,
  "critic": "socratic-challenger",
  "findingId": "rfc-example-r1-socratic-challenger-f2-9e8d7c6b",
  "summary": "Outcome ownership is unclear.",
  "rawFinding": "Who is allowed to assign laterOutcome, and under what evidence standard?",
  "sourceRef": {
    "kind": "manual_excerpt",
    "excerptHash": "sha256:9e8d7c6b..."
  },
  "disposition": "duplicate",
  "dispositionReason": "Same issue as failure-mode finding f1, with different framing.",
  "duplicateOfFindingId": "rfc-example-r1-failure-mode-analyst-f1-1a2b3c4d",
  "duplicateContext": "parallel_independent"
}
```

### Outcome

Append outcomes later. Do not edit the original finding line.

```json
{
  "schemaVersion": "critic-trace.v1",
  "recordType": "outcome",
  "findingId": "rfc-example-r1-failure-mode-analyst-f1-1a2b3c4d",
  "assessedAt": "2026-05-13T19:00:00Z",
  "assessor": "implementer",
  "horizon": "post_pr_open",
  "outcome": "validated",
  "evidence": "The implementation needed a separate outcome event to avoid rewriting original finding events.",
  "evidenceRefs": [
    {
      "kind": "pr",
      "ref": "https://github.com/kookr-ai/kookr/pull/123",
      "summary": "PR implemented append-only outcome events."
    }
  ]
}
```

### Missed Risk

Do not force missed-risk bookkeeping during drafting. When producing an aggregate report, either append `missed_risk` events for the horizon being evaluated or mark the report's trace-completeness section as `missed-risk sweep not performed`.

```json
{
  "schemaVersion": "critic-trace.v1",
  "recordType": "missed_risk",
  "rfcPath": "docs/rfc/rfc-example.md",
  "discoveredAt": "2026-05-14T10:00:00Z",
  "evidence": "PR review found the schema allowed orphaned outcome events.",
  "expectedCritics": ["failure-mode-analyst", "boundary-critic"],
  "matchedFindingIds": [],
  "note": "No round-1 critic identified orphaned outcome validation."
}
```

## Bias Controls

Minimum controls for every trace:

- Preserve raw finding text or a hashed excerpt pointer.
- Preserve one invocation event per critic run, including explicit no-finding runs.
- Preserve rejected, duplicate, and falsified findings.
- Do not use incorporation rate alone.
- Include author-bias context in `dispositionReason` when rejection depends on user intent, scope budget, or subjective taste.
- Require human approval for every prompt or roster diff.

Before broad/default rollout of a critic change:

- Evaluate a holdout set not used to motivate the change.
- Use a blinded finding packet where feasible.
- Compare against false-positive burden and missed-risk examples, not only useful findings.
- Validate across at least two time windows or RFC types before retiring a critic or changing default roster rules.

## Evolution Paths

### Fast Path: Low-Risk Prompt Clarification

Allowed for narrow clarifications that preserve a critic's role.

Required packet:

- One concrete trace example.
- One narrow prompt diff.
- One counterexample check explaining why the diff is not RFC-specific.
- One rollback condition describing what future trace pattern should revert it.
- Human approval.

Do not claim global improvement until later traces confirm it.

### Full Path: Prompt Philosophy or Roster Change

Required for adding, retiring, splitting, merging, or substantially changing a critic.

1. Observe at least five RFCs or two active RFC-writing days, and at least three invocations of the target critic.
2. Diagnose with a manual aggregate report.
3. Propose a promotion packet with target dimensions, diff, examples, holdout plan, expected failure mode, and rollback condition.
4. Trial in shadow mode or on holdout RFCs.

Do not retire high-variance critics solely because their useful findings are infrequent. `design-minimalist` and `ambition-amplifier` are adversarial by design; a critic can be valuable even when the author chooses the other side.

## Manual Aggregate Report

After 3-5 complete traces, write:

```text
docs/reports/rfc-critic-meta-analysis-YYYY-MM-DD.md
```

Include:

- Corpus: RFCs, rounds, critics, total substantive findings.
- Trace completeness: raw finding coverage, missing source refs, invalid events, orphaned outcomes, duplicate IDs, unknown/expired outcomes.
- High-value finding examples.
- False-positive examples.
- Missed-risk examples, or `missed-risk sweep not performed`.
- Adversarial-pair outcomes.
- Cost notes: triage burden, extra rounds, and visible model/runtime cost.
- Proposed changes, or `insufficient evidence`.
- Holdout/trial recommendation if a full-path change is proposed.

## Validation Before Aggregate Use

Before using a trace in an aggregate report:

- Count and exclude invalid JSONL lines.
- Count and exclude duplicate `findingId` values from prompt-change evidence.
- Count and exclude orphaned outcome events.
- Count and exclude events with unknown enum values.
- Treat missing required fields as invalid.

Invalid events are evidence of trace-quality problems, not evidence about critic quality.
