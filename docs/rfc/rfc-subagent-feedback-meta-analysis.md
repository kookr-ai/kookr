# RFC: Subagent Feedback Meta-Analysis for Iterative RFC Review

**Status:** Draft (v3 - post-round-2 critic incorporation, presented for user review)
**Date:** 2026-05-13
**Author:** Jean Ibarz (with Codex)

---

## Problem

Kookr's `rfc-iterative-review` skill already uses multiple reviewer subagents to improve RFCs across rounds. The main agent acts as editor: it triages critic feedback, incorporates some findings, rejects others, and converges on a final document. That process produces useful local judgment, but most of the evidence evaporates into prose:

- Which critic found defects that materially changed the RFC?
- Which critic repeatedly produced plausible-sounding but wrong or irrelevant findings?
- Which critic caught issues that implementation later proved real?
- Which critic creates useful tension with another critic, even when its own recommendations are not directly incorporated?
- When should a critic prompt be evolved, retired, split, merged, or left alone?

The tempting answer is "score each subagent by whether the author incorporated its feedback." That is too weak and probably dangerous. Incorporation is a noisy proxy: an author can ignore valid feedback, accept bad feedback, prefer low-effort edits, or overfit to critic phrasing. Worse, optimizing critic prompts against this signal alone creates a Goodhart loop: critics learn to produce feedback that looks incorporable, not feedback that improves design quality.

This RFC proposes a conservative meta-analysis protocol for the RFC review loop. It captures lightweight structured traces during iterative review, preserves raw evidence for later re-judgment, and uses explicit promotion gates before any critic prompt or roster change lands.

## Evidence Base

This RFC was grounded in local repo and local literature sources.

Repo context:

- `plugin/skills/rfc-iterative-review/SKILL.md` already defines 3 review rounds, critic selection, the mandatory empirical checkpoint after round 1, adversarial `ambition-amplifier` vs `design-minimalist`, invocation logs, and convergence rules.
- Existing RFCs under `docs/rfc/` preserve human-readable critic incorporation records. Good examples include `rfc-ralph-loop-redesign.md`, `rfc-task-chime-browser.md`, `rfc-skill-agent-distribution.md`, and `rfc-cost-comparison-panel.md`.
- `plugin/skills/reviewer-distillation-*` already encodes a blind prediction / judge / mutator / meta-mutator loop with isolation rules, anti-cheating rules, and stall detection.
- `docs/adr/010-session-reflection-workflow.md`, `src/core/interaction-log.ts`, `src/core/feedback-bundle.ts`, and `src/server/use-cases/write-feedback-bundle.ts` provide an existing path for durable reflection data and feedback bundles.
- The scout found `/home/jean/.claude/reviewer-distillation-report-grafana.md`, where a simpler maintainer-lens prompt beat structural checklists. That is a direct caution against assuming more elaborate critic prompts are better.

Local KB context:

- `kb search` was required and attempted against `llm-as-judge`, `llm-agents`, `llm-self-improve`, and `llm-reasoning`, but failed with `Cannot read properties of undefined (reading 'faiss_search_ms')` after loading the FAISS index. `kb doctor` reported backend OK and a stale index with thousands of new/modified files. This RFC uses direct read-only search over local KB files as fallback.
- `/home/jean/knowledge_bases/llm-as-judge/patterns/llm-judge-18902c46.md`: naive holistic LLM judgments are fragile; rubric decomposition and trace grounding improve reliability.
- `/home/jean/knowledge_bases/llm-as-judge/patterns/bias-fbdec072.md`: judge bias can dominate evaluation variance; mitigation requires blinding, multi-dimensional rubrics, and bias audits.
- `/home/jean/knowledge_bases/llm-reasoning/patterns/verifier-55c9ffc0.md`: verifier-guided process supervision beats outcome-only feedback because it localizes credit assignment across intermediate steps.
- `/home/jean/knowledge_bases/llm-reasoning/patterns/multi-agent-11004abb.md`: multi-agent systems help when roles are structured and verification is explicit; raw consensus is not enough.
- `/home/jean/knowledge_bases/llm-reasoning/notes/2605.01566.md`: multi-agent reasoning can improve compute-efficiency frontiers, but cost should be routed adaptively to harder tasks.
- `/home/jean/knowledge_bases/llm-self-improve/patterns/self-distillation-98aeac48.md` and `iteration-10078551.md`: self-improvement loops need dense feedback, strict filtering, and calibration to avoid noise accumulation and reward hacking.

## Requirements

- The protocol SHALL preserve a structured, append-only record of substantive critic findings across RFC review rounds.
- The protocol SHALL preserve enough raw evidence to allow a later reviewer to re-judge the author's extraction, not just the author's summary.
- The protocol SHALL distinguish "accepted by the author" from "later validated as useful." Accepted findings are not automatically ground truth.
- The protocol SHALL support at least three evaluation time horizons:
  - **Immediate**: author disposition during RFC editing.
  - **Post-approval**: user feedback on the RFC.
  - **Post-implementation**: implementation, tests, PR review, or production behavior confirms or falsifies a finding.
- The protocol SHALL track false positives, missed risks, and costly noise. A critic that says little should not look strong merely because it has few false positives.
- The protocol SHALL treat adversarial critic conflicts as first-class prose evidence when the conflict changes the RFC. Machine-readable conflict records are deferred until manual reports show they are worth the added capture cost.
- The protocol SHALL make no automatic changes to reviewer prompts. Prompt evolution requires human approval and an explicit diff.
- The protocol SHALL remain lightweight for V1. A per-RFC JSONL trace and a manual aggregate report are enough; no database, dashboard, or report script in V1.
- The protocol SHALL keep portable plugin skills portable. Kookr-specific artifact paths belong in Kookr docs or Kookr-internal skills, not unqualified plugin guidance.

## Non-Goals

- No reinforcement learning or automated prompt mutation in V1.
- No leaderboard that ranks critics by a single scalar score.
- No claim that the main author or an LLM judge can perfectly evaluate design quality.
- No UI dashboard in V1.
- No scripted aggregate report in V1. The first report should be written manually after several traces prove the shape useful.
- No retroactive rewriting of old RFCs by hand. Historical RFCs can be mined opportunistically, but new structured traces are the durable path.
- No direct dependency from docs/reporting code on raw runtime feedback-bundle internals.
- No changes to Kookr's runtime supervisor behavior. This RFC concerns the RFC generation process and review-subagent maintenance.

## Primary Decision Target

The meta-analysis supports two decisions, in order:

1. **Should any critic prompt or critic-roster rule change?** This includes narrow prompt clarifications, new critics, retired critics, split critics, merged critics, and changes to when a critic is invoked.
2. **Is the iterative RFC review loop worth its cost for a class of RFCs?** This includes deciding whether some RFC types need fewer critics, fewer rounds, or a mandatory empirical checkpoint earlier.

The protocol does **not** try to compute abstract "RFC quality." It measures whether critic feedback created useful decision, evidence, or text deltas relative to the cost and noise it introduced.

## Definitions

**Critic finding:** A discrete actionable point from a reviewer subagent. It may be a defect, question, missing evidence request, scope challenge, simplification proposal, or empirical claim.

**Disposition:** The main author's immediate decision for a finding: `used`, `partially_used`, `rejected`, `deferred`, `duplicate`, or `needs_empirical_check`.

**Outcome:** A later assessment appended after more evidence appears: `validated`, `partially_validated`, `neutral`, `falsified`, `expired_unknown`, or `unknown`.

**Unknown vs neutral:** `unknown` means not enough later evidence exists yet. `neutral` means later evidence was checked and the finding did not demonstrably help or hurt. `expired_unknown` means the RFC was abandoned, superseded, or never implemented, so implementation validation will not arrive.

**Value note:** A short free-text claim about why the finding matters. V1 keeps this free-form to avoid building a taxonomy before the team has real traces.

**Noise:** A finding that was factually wrong, already addressed, stylistic without behavioral impact, contradicted user intent, or consumed review effort without improving the RFC.

## Design

### 1. Capture an Append-Only Critic Trace

Each RFC review run writes a sidecar event log:

```text
docs/rfc/meta/rfc-<slug>.critic-trace.jsonl
```

This path is Kookr-specific because Kookr stores RFCs under `docs/rfc/`. If the portable `rfc-iterative-review` plugin skill is updated, it should describe the generic convention as "write a critic trace next to the RFC, under the repo's RFC metadata directory." The Kookr-specific path should live in this RFC and, if needed, a Kookr-internal wrapper skill.

V1 records only what is needed for later analysis. It intentionally drops the v1 draft's heavy taxonomy fields (`findingType`, `severity`, `immediateEffect`) until real traces prove those fields are worth the data-entry cost.

```ts
interface CriticFindingEvent {
  schemaVersion: 'critic-trace.v1';
  recordType: 'finding';
  rfcPath: string;
  round: number;
  critic: string;
  findingId: string;
  summary: string;
  rawFinding: string;
  sourceRef: {
    kind: 'agent_output' | 'manual_excerpt';
    path?: string;
    excerptHash: string;
  };
  disposition: 'used' | 'partially_used' | 'rejected' | 'deferred' | 'duplicate' | 'needs_empirical_check';
  dispositionReason: string;
  valueNote?: string;
  duplicateOfFindingId?: string;
  duplicateContext?: 'parallel_independent' | 'sequential_blind' | 'sequential_exposed' | 'unknown';
}
```

`findingId` is stable within one sidecar and generated as:

```text
<rfc-slug>-r<round>-<critic>-f<ordinal>-<8-char-rawFindingHash>
```

This gives deterministic local identity without making IDs depend on mutable summaries. Delayed outcomes refer to this ID.

Each critic invocation also gets one lightweight completeness record:

```ts
interface CriticInvocationEvent {
  schemaVersion: 'critic-trace.v1';
  recordType: 'invocation';
  rfcPath: string;
  round: number;
  critic: string;
  sourceRef: {
    kind: 'agent_output' | 'manual_excerpt' | 'unavailable';
    path?: string;
    excerptHash?: string;
  };
  substantiveFindingsExtracted: boolean;
  extractedFindingIds: string[];
  noSubstantiveFindings: boolean;
  extractionNote?: string;
}
```

This is the guard against author extraction bias. A critic that produced no useful feedback should have an invocation event with `noSubstantiveFindings: true`; a critic whose raw output was unavailable is marked as incomplete and should not be used for retirement decisions.

### 2. Append Later Outcomes, Do Not Rewrite Findings

Outcome updates are separate events:

```ts
interface CriticOutcomeEvent {
  schemaVersion: 'critic-trace.v1';
  recordType: 'outcome';
  findingId: string;
  assessedAt: string;
  assessor: 'rfc_author' | 'implementer' | 'reviewer' | 'user' | 'reflection_task';
  horizon: 'post_approval' | 'post_pr_open' | 'post_review' | 'post_merge' | 'post_production';
  outcome: 'validated' | 'partially_validated' | 'neutral' | 'falsified' | 'expired_unknown';
  evidence: string;
  evidenceRefs?: Array<{
    kind: 'pr' | 'test' | 'review_comment' | 'feedback_bundle_export' | 'runtime_observation' | 'user_feedback' | 'other';
    ref: string;
    summary: string;
  }>;
}
```

The original finding event stays immutable. This preserves the time sequence: what the author believed during review, what changed later, and who made the later judgment.

V1 ownership:

| Horizon | Owner | Required when |
|---|---|---|
| Immediate disposition | RFC author | Every iterative review round. |
| Post-approval | RFC author | User approves, rejects, or requests RFC changes. |
| Post-implementation | Implementer during PR follow-through | The RFC is implemented and tests/PR review expose evidence tied to a finding. |
| Production/runtime | Separate reflection task | Only when real runtime evidence later confirms or contradicts the RFC. |

V1 only requires the immediate disposition and post-approval update. Post-implementation updates are strongly recommended when there is explicit evidence. Production/runtime linkage is future work.

### 3. Record Missed Risks During Aggregate Sweeps

A trace that only records emitted findings cannot measure false negatives. When implementation, PR review, user review, or production evidence exposes an issue that no critic caught, append:

```ts
interface MissedRiskEvent {
  schemaVersion: 'critic-trace.v1';
  recordType: 'missed_risk';
  rfcPath: string;
  discoveredAt: string;
  evidence: string;
  expectedCritics: string[];
  matchedFindingIds: string[];
  note: string;
}
```

`matchedFindingIds` may be empty. This is the denominator for "the critic should plausibly have caught this." It prevents quiet critics from looking artificially strong.

Missed-risk events are **optional during day-to-day RFC drafting** and **required only for RFCs included in an aggregate report**. Before an RFC enters an aggregate corpus, the author must either append missed-risk events for that horizon or mark the report's trace-completeness section as "missed-risk sweep not performed." This avoids pretending false-negative data exists when it does not.

### 4. Record Productive Conflict in Prose First

Adversarial value often lives in the resolution between findings, not in either finding alone. When critic conflict changes the RFC, document the resolution in the existing prose section.

The existing prose requirement for `ambition-amplifier` vs `design-minimalist` remains the V1 mechanism. Structured `conflict_resolution` events are deferred until the first manual report proves conflict analysis needs machine-readable fields. This keeps V1 capture small while preserving the most important human-readable rationale.

### 5. Keep V1 Capture Small

V1 changes the RFC workflow in two places:

1. Keep the existing human-readable "Critic feedback incorporated" section.
2. Add or append the critic trace with critic invocation events, substantive findings, and immediate dispositions.

No round-summary event is required in V1. Counts can be computed later from finding events. If the author needs context that is not a finding, it belongs in prose.

The author should record only substantive findings, not every sentence from critic output. To reduce extraction bias, each finding event stores `rawFinding` and `sourceRef.excerptHash`. If raw subagent output is unavailable, `sourceRef.kind` is `manual_excerpt` and the trace is marked incomplete in the RFC's `Meta-analysis readiness` note.

Before a trace is used in an aggregate report, perform a minimal validation pass:

- Invalid JSONL lines are counted in trace completeness and excluded.
- Duplicate `findingId` values are counted and excluded from prompt-change evidence.
- Outcome events whose `findingId` has no finding event are counted as orphaned and excluded.
- Unknown enum values are counted and excluded.
- Missing required fields make the event invalid.

Formal JSON Schema validation is a V1 implementation artifact, not a report-script requirement.

### 6. Bias Controls

V1 required controls:

- Preserve raw finding text or a hashed excerpt pointer.
- Preserve one invocation/completeness event per critic run, including explicit no-finding runs.
- Preserve rejected, duplicate, and falsified findings.
- Do not use incorporation rate alone.
- Include author-bias context in `dispositionReason` when rejection depends on user intent, scope budget, or subjective taste.
- Require human approval for every prompt or roster diff.

Controls required before broad/default rollout of a critic change:

- Evaluate a holdout set not used to motivate the change.
- Use a blinded finding packet when feasible. A blinded packet hides critic name, order, disposition, and author-supplied value claims; it shows raw finding text, RFC excerpt, and later evidence. If identity is obvious from role-specific language, mark `blindable: false`.
- Compare against false-positive burden and missed-risk examples, not only useful findings.
- Validate across at least two time windows or RFC types before retiring a critic or changing default roster rules.

This split is deliberate. Round-1 review found that the original bias-control list read like a research protocol and would block small useful improvements.

### 7. Evolution Protocol

Critic changes use two paths.

**Fast path: low-risk prompt clarification**

Allowed when the change is narrow, preserves the critic's role, and fixes a concrete repeated failure such as style-only feedback or ignoring explicit user scope.

Requirements:

- One concrete trace example.
- One narrow prompt diff.
- One counterexample check explaining why the diff is not merely RFC-specific.
- One rollback condition describing what future trace pattern should revert it.
- Human approval.
- No roster change.
- No claim that the change improves global critic quality until later traces confirm it.

**Full path: prompt philosophy or roster change**

Required for adding, retiring, splitting, merging, or substantially changing a critic.

1. **Observe:** collect at least five RFCs or two active RFC-writing days, and at least three invocations of the target critic. For retirement, require evidence across at least two RFC types or two time windows.
2. **Diagnose:** produce a manual aggregate report with high-value examples, false positives, missed risks, conflicts, and estimated review burden.
3. **Propose:** write a promotion packet: target dimensions, prompt/roster diff, examples, holdout plan, expected failure mode, rollback condition.
4. **Trial:** run in shadow mode or on holdout RFCs. Do not replace the default critic until the trial improves the target dimension without materially worsening false-positive burden or missed-risk exposure.

Allowed actions:

- **Evolve** a critic prompt when the same failure pattern repeats and the fix is a generic instruction, not a memorized example.
- **Add** a critic when missed-risk events show a recurrent review dimension that existing critics do not cover.
- **Subtract** a critic only after rare-event and complementarity checks. Do not retire high-variance critics merely because their useful findings are infrequent.
- **Split** a critic when it mixes two valuable but conflicting behaviors that cannot be judged cleanly.
- **Merge** critics when two roles produce redundant findings and their combined prompt can stay focused.

Forbidden actions:

- Do not auto-edit plugin agents from aggregate metrics.
- Do not evolve prompts from only incorporated findings.
- Do not optimize for verbosity, number of findings, author agreement, or neat low-cost findings.
- Do not embed RFC-specific facts into a general critic prompt.
- Do not retire `design-minimalist` or `ambition-amplifier` solely because one side often "loses"; adversarial tension is part of their purpose.

### 8. Manual Aggregate Report First

After 3-5 complete traces, write a manual report:

```text
docs/reports/rfc-critic-meta-analysis-YYYY-MM-DD.md
```

Report sections:

- Corpus: RFCs included, rounds, critics, total substantive findings.
- Trace completeness: raw finding coverage, missing source refs, unknown/expired outcomes.
- Critic-by-dimension analysis.
- High-value finding examples.
- False-positive examples.
- Missed-risk examples.
- Adversarial-pair outcomes.
- Cost notes: triage burden, extra rounds, and any model/runtime cost visible from task logs.
- Proposed changes, or `insufficient evidence`.
- Holdout/trial recommendation if a full-path change is proposed.

A script is intentionally deferred until after this manual report proves which parts are repetitive and worth automating.

## Files to Change

V1 implementation would touch:

| Path | Change |
|---|---|
| `.claude/skills/kookr-rfc-critic-meta-analysis/SKILL.md` | New Kookr-internal skill documenting the trace workflow and when to load it after `rfc-iterative-review`. |
| `docs/schemas/critic-trace.v1.json` | Canonical machine-readable event schema. |
| `docs/rfc/meta/.gitkeep` | Keep the Kookr RFC trace directory tracked. |

Optional later changes:

| Path | Change |
|---|---|
| `plugin/skills/rfc-iterative-review/SKILL.md` | Generic note that repos may maintain per-RFC critic traces; no Kookr-specific paths. Requires plugin version bump if edited. |
| `docs/reference/rfc-critic-meta-analysis.md` | Human guidance and examples if the schema starts being used by more than the Kookr-internal skill. |
| `scripts/rfc-critic-report.ts` | Generate reports after manual reports prove the stable shape. |
| `package.json` | Add `rfc:critic-report` only when the script exists. |

The Kookr-specific workflow belongs in `.claude/skills/` with a `kookr-` prefix. The portable plugin skill must not hardcode `docs/rfc/meta` or Kookr's report paths. If the plugin ever emits or validates `critic-trace.v1`, the schema must move into plugin-portable documentation with Kookr paths kept out; until then, `critic-trace.v1` is Kookr-owned.

Discovery/use rule: Kookr RFC tasks load `rfc-iterative-review` first, then `kookr-rfc-critic-meta-analysis` for trace capture. The Kookr skill extends the portable workflow; it does not fork the critic orchestration rules.

## Edge Cases

- **Manual extraction is biased.** V1 mitigates this by storing raw finding text and source hashes. It does not eliminate author extraction bias.
- **Raw subagent output is unavailable.** Use `manual_excerpt` or `unavailable` in the invocation event, mark the trace incomplete, and do not use that RFC for prompt-retirement decisions.
- **One finding maps to multiple edits.** Keep one finding record and describe the value note broadly; do not duplicate per line changed.
- **Multiple critics find the same issue.** Use `duplicateOfFindingId` and `duplicateContext`. Aggregate duplicate convergence separately from novelty.
- **A rejected finding later proves right.** Append an outcome event with `validated`; do not rewrite the original disposition.
- **A critic is valuable by being wrong.** Sometimes a wrong finding forces the RFC to document why a feared failure cannot happen. Capture that in `valueNote`, not as pure noise.
- **Historical RFC prose is inconsistent.** Treat backfilled historical data as exploratory unless original critic output and RFC revisions are available.
- **Survivorship bias.** RFCs that are rejected, abandoned, or superseded should receive `expired_unknown` outcomes rather than silently disappearing from the corpus.
- **Feedback bundle coupling.** Future production-evidence linkage should use a stable exported evidence reference, not raw feedback-bundle internals.
- **Malformed traces.** Invalid events are included in trace-completeness counts but excluded from prompt-change evidence until fixed.
- **KB search failures.** Meta-analysis tasks should record retrieval failures explicitly, as this RFC did, and fall back to local file inspection or `kb search --refresh` when warranted.

## Alternatives Considered

### A. Rank critics by incorporation rate

Rejected. Incorporation is easy to measure but too easy to game. It rewards agreeable, low-friction feedback and punishes critics whose job is to create useful tension.

### B. Use an LLM judge to score every critic finding

Rejected as the primary mechanism. LLM judges are useful assistants but biased. They can be used with rubric decomposition, blinding, and audit samples, but not as sole ground truth.

### C. Automatically mutate critic prompts after every report

Rejected. This creates a self-referential optimization loop with high risk of overfitting, prompt drift, and reward hacking. Human-approved prompt diffs and holdout validation are required.

### D. Build a database, dashboard, and report script first

Rejected for V1. JSONL sidecars plus one manual report are enough to learn whether the signal is useful.

### E. Only standardize the prose section

Rejected as insufficient. Round-1 `design-minimalist` was right that prose headings are the cheapest V0, but prose alone does not preserve raw finding text, stable IDs, duplicate relationships, missed risks, or later outcomes.

### F. Put Kookr paths directly into the portable plugin skill

Rejected. `rfc-iterative-review` ships through the toolkit plugin. Kookr-specific paths and report conventions belong in Kookr-internal skill/docs, or the plugin skill must describe them generically.

## Open Questions

- Should the trace be mandatory for every Kookr RFC once the Kookr-internal skill exists, or only for RFCs explicitly intended to feed meta-analysis?
- Should post-implementation outcome updates happen during `kookr-post-push`, a named reflection task, or only when a human asks for a meta-analysis pass?
- Which first holdout set should be used for prompt-change trials: recent RFCs, synthetic RFCs, or future live RFCs in shadow mode?
- If `critic-trace.v1` proves useful beyond Kookr, should it move from Kookr-owned `docs/schemas/` into the portable toolkit plugin?

## Critic Feedback Incorporated

### Round 1

- **design-minimalist** 2026-05-13 (novel finding): v1 schema and report-script plan were too heavy. Incorporated by cutting taxonomy fields, round-summary records, package script, and V1 report automation. V1 now uses a smaller append-only trace plus a manual report after 3-5 RFCs.
- **boundary-critic** 2026-05-13 (novel finding): portable plugin boundary was wrong. Incorporated by moving Kookr-specific trace workflow to a proposed `.claude/skills/kookr-rfc-critic-meta-analysis` skill and keeping plugin changes optional/generic.
- **failure-mode-analyst** 2026-05-13 (novel finding): manual extraction, mutable later outcomes, missed risks, unstable IDs, duplicate-order bias, and malformed sidecars were under-specified. Incorporated by adding raw finding/source hashes, append-only outcome events, missed-risk events, stable ID rule, independent duplicate flag, and trace-completeness reporting.
- **socratic-challenger** 2026-05-13 (novel finding): primary decision target, outcome ownership, unknown-vs-neutral, unit of analysis, conflict representation, retirement gates, cost, and report overreach were unclear. Incorporated by adding Primary Decision Target, owner table, outcome definitions, conflict records, stricter retirement gates, cost notes, and `insufficient evidence` report state.
- **ambition-amplifier** 2026-05-13 (novel finding): v1 had named the hard problems but not made useful-signal semantics, re-judgment evidence, missed-risk denominator, promotion packets, or blinded packets executable. Incorporated by splitting value claims, requiring raw finding text, adding missed-risk records, promotion packets, and concrete blinded-packet guidance.

**Adversarial pair resolution:** `design-minimalist` and `ambition-amplifier` conflicted on trace richness. The resolution is a smaller schema with stronger evidence fields: cut optional taxonomy and automation, keep raw finding text, append-only outcomes, missed-risk records, and conflict records. This preserves the semantic evidence needed for later analysis without turning every RFC round into a 20-field data-entry exercise.

**Empirical validation checkpoint:** Round 1 produced no load-bearing empirical claims requiring a `design-experimenter` probe. Findings were structural/protocol-level; the KB CLI failure was already reproduced locally and by scout/critics.

### Round 2

- **design-minimalist** 2026-05-13 (novel finding): v2 still carried too much V1 ceremony (`rfcContentHash`, value taxonomy, duplicate independence, author-bias field, required missed-risk/conflict events, and a reference doc). Incorporated by removing document hashes, collapsing value claims to free text, replacing duplicate independence with a simpler duplicate context, keeping bias in disposition reasons, making missed-risk sweeps aggregate-time only, keeping conflict resolution prose-only in V1, and dropping the V1 reference doc.
- **failure-mode-analyst** 2026-05-13 (novel finding): malformed traces, author extraction bias, `later_confirmed` conflict, missed-risk scheduling, duplicate-order context, and fast-path overfitting remained. Incorporated by adding invocation/completeness events, validation rules for aggregate inclusion, removing `later_confirmed`, requiring missed-risk sweep status for aggregate reports, adding duplicate context, and adding counterexample/rollback requirements to the fast path.
- **boundary-critic** 2026-05-13 (novel finding): schema ownership and skill handoff were still ambiguous. Incorporated by making `docs/schemas/critic-trace.v1.json` the canonical machine contract, narrowing the Kookr skill to workflow ownership, adding typed evidence refs, and defining the handoff from portable `rfc-iterative-review` to Kookr-internal trace capture.

**Round 2 convergence note:** Remaining round-2 feedback was tightening rather than redesign. V3 keeps the core shape: Kookr-internal workflow, append-only trace, raw evidence, manual reports first, and human-approved prompt changes only. No round-3 critic pass is planned unless the user asks for more rigor.
