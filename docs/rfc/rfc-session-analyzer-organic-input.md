# RFC: Make session-analyzer Distinguish Organic User Input from Orchestration Noise

**Status:** Draft (v1)
**Date:** 2026-07-31
**Author:** Jean Ibarz (with Claude)
**Tracking issue:** [#1057](https://github.com/kookr-ai/kookr/issues/1057)

---

## Summary

`plugin/skills/self-reflect/scripts/session-analyzer.ts` classifies transcript
messages as human input using a structural heuristic — Claude Code:
`!Boolean(obj.toolUseResult)` (`parseMessage`, lines 780-781); Codex CLI:
per-event-kind dispatch in `parseCodexMessage` (line 639) — plus a short,
inline noise filter, `isAnalyzerNoise` (lines 1207-1220). That heuristic
catches some machine-generated text (`<subagent_notification>` blocks are
already special-cased at parse time via `parseSubagentNotification`, line
971) but not all of it, and the three downstream reports
(`--user-messages`, `--patterns`, `--repeated-instructions`) apply
**inconsistent** amounts of machine-text filtering on top:
`collectRepeatedInstructions` consults `classifyWorkflowInjectedInstruction`
(lines 1915-1940); `analyzeMessages`'s correction pass (`isCorrection`, lines
1201-1205, feeding `--patterns`) does not consult it at all.

This RFC proposes: (1) a shared, three-way `MessageOrigin` classification
(`organic` / `machine_orchestration` / `ambiguous`) computed **once**, at
parse time, from structural + envelope evidence rather than free-text
regexes where a structural signal exists; (2) a second, smaller
**normalization-time** filter for the residual free-text template patterns
that have no structural marker; (3) minimal fixtures per orchestration
category to pin the classification without full transcript captures; (4) a
non-breaking rollout that adds an opt-out flag before changing any default
report output. It is a design document only — no code changes ship with it.

## Motivation / Evidence

From the issue, citing the 2026-06-20 reflection report:

- `Stop hook feedback: If you consider this Kookr task...` appeared 23 times
  and was classified as `[correction]`. This is `isCorrection` (line
  1201-1205) matching `CORRECTION_PATTERNS` (lines 207-232) against
  machine-appended stop-hook text that reached `humanMessages` because
  `analyzeMessages`'s correction pass never calls
  `classifyWorkflowInjectedInstruction`.
- Repeated-instruction top patterns were dominated by pre-PR reviewer
  prompts and launch templates rather than organic user messages — evidence
  that even where a classifier exists
  (`classifyWorkflowInjectedInstruction`, feeding
  `collectRepeatedInstructions`), its regex set is incomplete (stop-hook
  text and reviewer boilerplate are not in its pattern list at lines
  1919-1936).
- High-turn orchestration sessions such as `019ed7f6` and `019ed7d9` counted
  `<subagent_notification>` blocks as human turns. Per the code audit for
  this RFC, well-formed `<subagent_notification>` blocks are already
  excluded (`machineEvent = "subagent_notification"` set in `parseMessage`
  lines 816-821 and `parseCodexMessage` lines 665-673/720-727, then filtered
  by the `msg.isHumanInput` gate in `analyzeMessages` line 1134). The
  observed leakage is therefore most plausibly malformed/truncated
  notification payloads that fail `parseSubagentNotification`'s regex
  (line 971) and fall through to the `isAnalyzerNoise` string-prefix
  backstop (lines 1209-1216), which only matches an exact
  `<subagent_notification>` opening tag, not arbitrary malformed variants.
  This RFC treats "envelope failed to parse" as its own explicit outcome
  rather than a silent fallthrough (see Open questions).
- `--patterns` reported correction themes from output-format boilerplate
  like `**File**`, `**Severity**`, `**Category**`, and `**Verified**`. These
  are markdown fields the reviewer-finding parser already recognizes
  structurally (`extractMarkdownField`, line 1073, used by
  `parseReviewerFindings`, line 1052) — but only for text already identified
  as inside a `<subagent_notification>` payload. Plain-text reviewer output
  that isn't wrapped in the envelope tag has no structural marker today and
  falls to `renderPatterns`'s bag-of-words frequency pass (line 1736) same
  as organic text.

**Root cause, stated plainly:** the codebase already has the right idea
(`machineEvent`, `WorkflowFilteredReason`, `classifyWorkflowInjectedInstruction`)
in three different places, but no single classification pipeline. Each
report re-derives (or fails to derive) "is this organic" independently,
so fixing one report's false positives does not fix the others'.

## Proposed classification model

### Three-way outcome, not a boolean

Replace ad hoc `isHumanInput: boolean` reasoning with an explicit
`MessageOrigin` union, computed once per `ParsedMessage`:

```ts
type MessageOrigin =
  | "organic"              // a human typed or pasted this
  | "machine_orchestration" // hook / subagent / launch template / reviewer envelope
  | "ambiguous";            // envelope looked machine-shaped but failed to parse cleanly
```

`ambiguous` matters precisely because of the malformed-`<subagent_notification>`
evidence above: today those messages silently become `organic` by omission.
Making "we tried to classify this and couldn't" a first-class, countable
outcome is cheap and turns a silent leak into a visible one (surfaced in
report summaries — see Backwards-compatibility).

### Two classification stages, not one

The issue's second RFC question — extraction time vs normalization time vs
both — has a concrete answer once the evidence is split into two kinds of
signal:

**Stage 1 — parse/extraction time, structural evidence only.**
Runs inside `parseMessage` / `parseCodexMessage`, where the raw JSONL object
is still in scope. Classifies from **envelope structure**, not prose
matching:

- `toolUseResult` presence (existing signal, Claude Code).
- Codex event-kind dispatch (existing signal — `response_user` /
  `event_user` / `function_call` etc., via `codexEventKind`).
- A parseable `<subagent_notification>...</subagent_notification>` envelope
  → `machine_orchestration`. An envelope-shaped-but-unparseable string (has
  the opening tag, JSON parse fails, or closing tag missing) →
  `ambiguous`, not a silent fallthrough to `organic`.
- Session-injected launch/system markers already recognized purely by
  position or exact-prefix match (`<environment_context>`,
  `<task-notification>`, `<local-command-caveat>`, AGENTS.md injection,
  worktree-guardrail preamble) — these are today's `isAnalyzerNoise`
  string-prefix checks (lines 1209-1216), moved earlier because they are
  positional/structural (always the first line of an injected block), not
  because their content changed.
- Hook-injected feedback: Claude Code's stop-hook output is injected as a
  distinguishable JSONL entry shape (a `system`-adjacent or tool-adjacent
  entry, not free-typed `user` text) — this RFC recommends confirming the
  exact hook-output JSONL shape against a live capture before implementation
  (see Open questions) rather than assuming a text-prefix match is
  sufficient, since `"Stop hook feedback: If you consider this Kookr
  task..."` is prose that a human could in principle also type.

**Stage 2 — normalization time, free-text evidence.**
Runs where `classifyWorkflowInjectedInstruction` already lives
(`collectRepeatedInstructions`, line 1957) and where `isCorrection` should
also run. Classifies from **prose template matching** for the residual
categories that have no structural envelope: pre-PR reviewer specialist
prompts (`/^you are the .*-specialist reviewer for a kookr pr\b/i`),
workflow-chain launch templates (`/^you are continuing a sequential kookr
github-issue implementation chain\b/i`), task-assignment templates, and
output-format boilerplate lines (`` /^-\s+\*\*(File|Severity|Category|
Verified|Comment)\*\*:/ ``, generalizing `extractMarkdownField`'s field regex
into a detector rather than only an extractor).

**Recommendation: both stages, with a hard rule on which does what.**
Stage 1 owns anything decidable from message shape/envelope alone — cheap,
unambiguous, computed once, reusable by every downstream report. Stage 2
owns anything decidable only from prose content — inherently a growing,
maintained pattern list, and *only* applied at the two call sites that
currently need it (`collectRepeatedInstructions`, and the corrected
`isCorrection`/`analyzeMessages` path). Splitting this way means a new
report added later gets Stage 1 filtering for free (it consumes
`ParsedMessage.origin`) and opts into Stage 2 only if it does its own
prose-pattern matching — which is exactly the shape of the existing bug
(`isCorrection` never opted in).

### Structured events over text patterns

Per the issue's fourth question, three message families should become
structured events (a typed field set at parse time) rather than staying
text patterns matched downstream, in priority order:

1. **`<subagent_notification>` payloads** — already mostly there
   (`machineEvent`); extend to record `parseFailed: boolean` for the
   `ambiguous` case instead of silently not setting `machineEvent`.
2. **Reviewer-finding envelopes** (`**File**`/`**Severity**`/etc.) —
   `extractMarkdownField`/`parseReviewerFindings` already parse these
   structurally when inside a `<subagent_notification>`; the same field
   grammar should be recognized as a structural marker (not just an
   extraction target) even for bare reviewer text so Stage 2 doesn't need a
   parallel regex reimplementing what `extractMarkdownField` already knows.
3. **Workflow launch templates** (`REVIEWER_FANOUT_LAUNCH_MARKER` and
   siblings) — these already carry an explicit, greppable marker string
   (`"[[kookr-workflow:reviewer-fanout]]"`, line 1913). Any *new* launch
   template introduced elsewhere in the codebase should be required to
   carry an equivalent marker rather than relying on a prose-shape regex,
   the same review discipline `rfc-delivery-gate-streamlining.md` applied to
   its own template changes.

Stop-hook feedback and ad hoc CLI-injected text (bare prose, no tag, no
marker) remain Stage 2 candidates by necessity — they are not events kookr
controls the shape of upstream (the hook output format is Claude Code's, not
ours), so pattern matching is the ceiling, not a stopgap.

## Alternatives considered

- **Single unified regex blocklist, extended in place.** Rejected: this is
  the status quo's failure mode. `CORRECTION_PATTERNS`,
  `isAnalyzerNoise`'s prefixes, and `classifyWorkflowInjectedInstruction`'s
  patterns are three independent lists already; adding a fourth without
  unifying the underlying classification would reproduce the exact
  inconsistency (`--patterns` vs `--repeated-instructions`) that motivated
  this RFC.
- **Do all classification at extraction time only (no Stage 2).** Rejected:
  stop-hook prose and some launch-template variants have no structural
  envelope to key off; forcing them into Stage 1 would mean parse-time code
  doing prose regex matching anyway, just relocated — no actual
  simplification, and it couples the low-level parser to a prompt-template
  vocabulary that changes independently of transcript format.
- **Do all classification at normalization/report time only (no Stage 1).**
  Rejected: every report currently re-implements its own subset of
  filtering (the root cause). Pushing everything downstream keeps that
  duplication; Stage 1 exists specifically to give every report a shared,
  correct-by-construction default.
- **A confidence score instead of a three-way enum.** Considered for
  `ambiguous` handling. Rejected for v1: a numeric score needs a threshold
  someone has to tune per report, and the concrete evidence (malformed
  `<subagent_notification>`) is a binary "did the envelope parse" fact, not
  a graded one. Revisit only if Stage 2's prose matching produces a case
  that is genuinely a gradient rather than a parse failure.
- **LLM-based classification of ambiguous messages.** Rejected as
  disproportionate: the tool is a lightweight reflection script run
  routinely; adding a model call per ambiguous message changes its
  performance and dependency profile for a problem the structural/prose
  split already resolves for the evidenced cases.

## Backwards-compatibility with existing reports

- **Default report output changes are the risky part**, not the
  classification machinery. `--user-messages` already drops
  `machineEvent`-tagged messages; extending Stage 1 coverage will make it
  drop *more* text than before by default, which is the intended fix but is
  also, mechanically, a silent behavior change on every existing saved
  report/diff a user might be comparing against.
- **Recommendation:** ship an explicit `--include-filtered-*`-style escape
  hatch consistent with the two flags that already exist
  (`--include-filtered-workflow`, `--include-filtered-repeated-instructions`,
  lines 316-317) for each newly-filtered category, so a user auditing "why
  did this message disappear" can always get it back. This is a naming
  convention already established by this file, not a new pattern.
  New filtering therefore ships **filtering-off-by-default in the first
  release** (classify but don't drop; surface counts only), flips to
  filtering-on-by-default in a follow-up once a run against real session
  history shows no organic message misclassified as
  `machine_orchestration` (see Rollout).
- **Report summaries gain a filtered-message count** (already precedented
  by `RepeatedInstructionCollection.filteredCount`/`filteredReasons`, lines
  177-198) for `--user-messages` and `--patterns`, so the `ambiguous` and
  `machine_orchestration` categories are visible in output, not just
  silently absent — directly answering the issue's acceptance criterion
  "explicitly decide what remains visible."
- **JSON output (`--format json`) is additive-only:** `origin` is a new
  field on `ParsedMessage`/`SessionAnalysis` entries; no existing field is
  renamed or removed, so scripts consuming today's JSON shape keep working.

## Testing / evaluation fixtures

Per the issue's proposed evaluation fixtures, each fixture is a **minimal
synthetic JSONL snippet** (2-5 lines, redacted/synthetic content, no real
session data) asserting one classification outcome — not a captured
transcript. Categories, each becoming one small fixture file under
`plugin/skills/self-reflect/scripts/__fixtures__/` (new directory) or
inline `it()`-scoped literals if the existing test file already inlines
JSONL for `parseMessage`/`parseCodexMessage` (whichever matches current test
conventions in the sibling `.test.ts`, to be confirmed at implementation
time):

| Fixture | Expected `origin` | Stage that decides it |
|---|---|---|
| Well-formed `<subagent_notification>{...}</subagent_notification>` | `machine_orchestration` | Stage 1 (envelope parse) |
| Truncated/malformed `<subagent_notification>` (opening tag, broken JSON) | `ambiguous` | Stage 1 (envelope parse failure) |
| Stop-hook feedback text (`"Stop hook feedback: If you consider this Kookr task..."`) | `machine_orchestration` | Stage 1 if hook output has a distinguishable JSONL shape; Stage 2 fallback otherwise |
| `<local-command-caveat>` block | `machine_orchestration` | Stage 1 (existing prefix check, relocated) |
| Pre-PR reviewer specialist launch prompt (`"You are the test-specialist reviewer for a kookr PR..."`) | `machine_orchestration` | Stage 2 (`classifyWorkflowInjectedInstruction`, extended to `isCorrection`'s call path) |
| Reviewer finding boilerplate lines (`- **File**: ...`, `- **Severity**: ...`) | `machine_orchestration` | Stage 2 (generalized `extractMarkdownField` detector) |
| Organic lifecycle command (`"create PR and merge"`) | `organic` | both stages: no match, default |
| Organic correction (`"the plugin version bump broke X, please fix"`) | `organic` | both stages: no match, default |

Each fixture is 1-2 KB max — the point is one representative message per
category, not a realistic multi-turn session. A regression test asserts
`origin` for each fixture and, separately, that `--patterns` and
`--user-messages` agree with `--repeated-instructions` on the same input
(closing the exact inconsistency this RFC starts from). This keeps the
suite fast and reviewable without ever committing real (even redacted)
session transcripts, which tend to accrete PII and balloon in size over
time — a known failure mode this RFC deliberately avoids by fixturing at
the single-message level, not the transcript level.

## Rollout

1. **This RFC** — no code.
2. **Implementation issue (follow-up, per the issue's "Follow-up Work"
   note):** add `MessageOrigin` type, Stage 1 classification in
   `parseMessage`/`parseCodexMessage`, `ambiguous` handling for malformed
   envelopes. No report output changes yet — `origin` is computed and
   attached but unused by rendering. Fixtures land here.
3. **Follow-up: wire Stage 1 into `isCorrection`/`analyzeMessages`**,
   closing the `--patterns` gap that produced the stop-hook/boilerplate
   evidence. Ship behind `--include-filtered-*`-style flags per
   Backwards-compatibility, filtering off by default.
4. **Follow-up: Stage 2 prose classifier**, reusing/extending
   `classifyWorkflowInjectedInstruction` and applying it uniformly to both
   `--patterns` and `--repeated-instructions`.
5. **Follow-up: flip filtering on by default** once a run against the same
   2026-06-20-style reflection window shows the stop-hook/boilerplate/
   malformed-notification counts have gone to zero (or near-zero, with
   remaining cases visible via the filtered-count summary) without any
   organic message moving to `machine_orchestration`/`ambiguous` in a manual
   spot-check.

Each step is independently revertable (an added field, then an added flag,
then a flipped default) — no step requires the others to have shipped to be
safe on its own.

## Open questions

- **O1 — exact stop-hook JSONL shape.** This RFC assumes Claude Code's
  stop-hook output is injected as a structurally distinguishable entry, but
  that was not verified against a live capture during this RFC (out of
  scope for a design doc with no code changes). The implementation issue
  must confirm this before deciding whether stop-hook feedback is a Stage 1
  or Stage 2 signal; if it turns out to be indistinguishable from typed user
  text at the JSONL level, it stays Stage 2 permanently and the fixture
  table above is updated accordingly.
- **O2 — should `ambiguous` ever be treated as `organic` for
  `--repeated-instructions` specifically?** That report already requires
  `uniqueSessions.size >= 2` (line 1984) before surfacing a pattern, which
  is itself a weak defense against one-off malformed envelopes; worth
  deciding whether that existing threshold is sufficient or `ambiguous`
  needs its own suppression there.
- **O3 — Codex CLI stop-hook / orchestration equivalents.** The evidence
  cited in the issue is Claude Code-flavored (`Stop hook feedback:`,
  `<subagent_notification>`). Codex CLI's `codexEventKind` dispatch may need
  its own equivalent orchestration-noise categories; this RFC does not
  claim parity has been verified, only that the same `MessageOrigin`
  enum should apply to both providers' `ParsedMessage` output.
- **O4 — where the field-boilerplate detector generalizes to.** Making
  `extractMarkdownField`'s field grammar (`` `**File**` ``-style) a detector
  usable outside `<subagent_notification>` payloads risks false-positiving
  on organic messages that happen to use bold markdown fields for
  unrelated reasons. Needs a real-fixture check before Stage 2 ships, not
  just the synthetic table above.
