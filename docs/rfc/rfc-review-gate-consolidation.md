# RFC: Review-Gate Efficiency — cheapen the pre-push panel now, earn the correctness de-dup with data

**Status:** Draft (v3 — post round-2 critic revision; presented for user review)
**Date:** 2026-10-10
**Author:** Jean Ibarz (with Claude)
**Evidence pack:** [`rfc-review-gate-consolidation-evidence.md`](./rfc-review-gate-consolidation-evidence.md)

---

## TL;DR

The operator asked: the pre-push reviewer fan-out looks like overkill, and it
looks redundant with the independent merge review — keep one, not both?

Investigation + a measured probe answered: **the waste is real but the "drop a
stage" instinct is not yet supported.** So:

- **Do now** — cut the pre-push panel's token *waste* (not its purpose): run
  the pre-push *nit* lanes on a cheap model (which also makes them faster),
  reuse an existing context pack when present, and correct the merge-review
  rationale (its value is fresh-context + exact-head + hard-gate, **not**
  cross-vendor — that was falsified). Three skill-doc edits, no code contracts,
  no gate-script changes.
- **Don't drop pre-push `correctness` yet** — the redundancy is unmeasured and
  a careless drop opens a zero-review hole. Turn it into a one-off experiment
  with a safe default (keep correctness everywhere) and ship the drop only if
  the data earns it.

## Problem

An autonomous Kookr delivery pays for two LLM review passes: the **pre-push
panel** (`pre-pr-review` §8 — diff-adaptive, median 3 lanes: `correctness`,
`lint-like`, `test`) and the **independent merge review**
(`independent-merge-review` — fresh-context, bound to the exact merge head,
hard gate on `kookr-ai/kookr`). The measured waste (evidence pack):

- **The pre-push panel carries the most token waste**: median **1.34M context
  tokens/panel**, ~13% of combined task spend, **~27% of its bytes are
  duplicate re-reads** across sibling agents, and every Layer-1 specialist runs
  on the **uncontrolled `general-purpose` default (opus-4-8)** — a nit-level
  lint priced like a deep audit. Its runtime is driven by the **SKILL.md spawn
  prose**, not the `reviewer-fanout` TS contract (which has **no non-test
  caller** — confirmed), so the real lever is the spawn template.
- **The merge review spends fewer tokens and records the defect catches**:
  ≈0.23× a pre-push panel *on the cache-weighted token axis*, 24 PRs / 34
  blocks with ~17 real code defects (auth bypass, data loss, crash, unbounded
  allocation) carrying reproductions.

**The two stages are not commensurable, and the operator asked about speed too
— so token-per-block is the wrong single ruler.** The pre-push panel is a
**parallel fan-out that runs before the PR exists**, off the critical path
(~zero added wall-clock); the merge review is **sequential, gated, and on the
critical path** — a BLOCK drives the `autonomous-review-loop` (review → fix →
re-push → re-run every deterministic `.hooks/pre-push` gate, minutes each →
fresh review at a new head, against a 10-iteration cap). So the token count can
*invert* the true latency cost, and the "0.23×" is cache-weighted (the Codex
merge lane is ~2.9M *raw* input, more than a 1.34M panel). On value, the
pre-push panel's measured output is **~80% non-blocking improvement edits**
(tests added, stale comments fixed) — prevention, not blocks — so "low-yield on
a blocking-defect ruler" judges a prevention stage on a final-gate's metric,
and the merge review's catches are *conditional on the pre-push panel having
already run upstream*. This RFC therefore (1) targets the pre-push panel's
**token waste** (which also *reduces* its latency) without downgrading what it
is *for*, and (2) refuses to treat "drop the correctness pass" as a
token-ranking exercise — that question is decided on a latency-and-safety axis
in Part 2, not on tokens-per-block.

But two things the first-draft design leaned on did **not** survive scrutiny
(round-1 panel + a mandatory empirical probe re-slicing 591 verdicts by
implementer vendor):

- **"Cross-vendor independence is why the merge review catches more" — FALSE.**
  The Codex lane's higher block rate is a **same-vendor**, large-PR,
  lane-strictness effect (same-vs-cross pooled 5.6% vs 3.1%, p=0.20). The
  "smoking gun" #3375 was **fully same-vendor** (Codex implementer, Codex
  pre-push panel, Codex merge reviewer); what caught its bugs was fresh context
  + exact head + prompt/effort.
- **"Pre-push `correctness` is redundant with the merge review" — UNPROVEN.**
  No same-PR comparison exists; the only observable population shows the merge
  review adding nothing over pre-push, and the one clear win (#3375) has
  unreadable pre-push transcripts. Dropping a lane whose overlap is unmeasured
  drops an unknown amount of coverage.

So this RFC captures the proven waste now and **earns** the structural change
(dropping a correctness pass) with measurement instead of asserting it.

## Part 1 — Do now (uncontested; independent of the redundancy question)

### 1.1 Cheap model for the nit lanes, at the spawn site

The live lever is the `pre-pr-review` §8 spawn template, not the dead TS
contract. Pin a per-lane model there:

```
# lint-like (pure nits: conventions/deadcode/docs-drift): cheap model
Agent({ subagent_type: "general-purpose", model: "sonnet", prompt: "[[kookr-workflow:reviewer-fanout]] role=lint-like …" })
# correctness: unchanged (kept; deep audit) — default/strong model
Agent({ subagent_type: "general-purpose", prompt: "[[kookr-workflow:reviewer-fanout]] role=correctness …" })
```

Codex lane: the equivalent model argument on `spawn_agent`. No contract field,
no schema change.

**Prerequisite (one-off, not a pipeline):** before pinning, run a small A/B —
replay `lint-like` (and, separately, `test`) on ~15 stored diffs, current model
vs sonnet, and check finding-equivalence by hand. The `test` lane is **not a
pure nit** (a missed coverage gap can hide a real defect), so `test` is
downgraded **only if** the A/B shows no finding loss; otherwise `test` stays on
the default model and only `lint-like` is pinned. This A/B is a Part-1
prerequisite — it is the same kind of one-off analysis that produced this RFC's
evidence, needing no runtime instrumentation.

### 1.2 Use the review context pack when present

Promote the existing `parallel-issue-batch` guidance to a general sentence in
`pre-pr-review` §8: *when a review pack exists for this unit, inline it into
every specialist prompt; otherwise proceed cold.* This cuts cold-start
re-reading without making the pack a precondition (it is unbuildable on
interactive work, OSS PRs, and plugin-consumer repos — making it "mandatory"
would mean "silently skipped"). Two hard rules:

- The pack is a **floor, not a ceiling** — specialists stay free to re-read
  source to verify a load-bearing claim.
- The **merge reviewer never receives the pack** — it must stay blind to the
  implementer; the pack carries implementer-chosen content.

### 1.3 Re-base the merge-review rationale (correct a falsehood)

Rewrite the `independent-merge-review` rationale so it rests on the property the
data supports: **fresh-context + exact-head + hard-gate enforcement.** Strike
every "cross-vendor is why" assertion. Name, in one sentence, the **minimum
model/effort** the reviewer spawns at, so the Claude fallback under a Codex
outage is not silently a weaker pass. This is the sole protection in the
outage window (see Edge cases); it is a prose floor on the existing spawn, not
a new config surface.

**Files (Part 1):** `plugin/skills/pre-pr-review/SKILL.md` (§8 per-lane
`model:` + "use pack if present" + merge-reviewer-excluded note);
`plugin/skills/independent-merge-review/SKILL.md` (re-based rationale +
strength floor); `src/core/independent-merge-review-skill.test.ts` (extend the
text pins for the re-based rationale); `plugin/.claude-plugin/plugin.json`
(version bump — the pre-push hook requires it for `plugin/**` changes). No
changes to `scripts/kookr-merge.sh`, `hooks/gh-pr-merge-gate.sh`, or any
TypeScript contract.

## Part 2 — Earn the correctness de-dup (do not ship on assertion)

This Part answers the operator's original question directly: *is the pre-push
correctness pass redundant with the merge review, so we can keep only one?* The
honest answer today is "unknown," so the deliverable is a method to decide it,
not a decision.

### 2.1 The experiment (one-off analysis, no runtime pipeline)

Run as a one-off study over existing PR history + local transcripts + `gh`
(exactly how this RFC's evidence was produced — no new telemetry subsystem):

- **Same-head overlap (the core test).** On a sample of PRs, run the pre-push
  `correctness` pass and the merge review **at the same head**, and measure
  whether merge-review findings ⊇ pre-push correctness findings. *Same head is
  non-negotiable*: a pre-push-caught-and-fixed defect is absent from a later
  final head, so a different-head comparison would trivially (and falsely) read
  "complementary." Supplement with a replay of the pre-push correctness pass on
  the recorded pre-push heads of the 17 code-defect blocked PRs, asking "would
  pre-push have caught this?"
- **Latency and operator-interruption are first-class PASS/FAIL axes, not a
  token footnote.** Measure mean **wall-clock to merge** and the
  **human-escalation rate** (cap-proximity), *separately from* token cost —
  because moving a correctness catch from the parallel, off-critical-path
  pre-push panel to a sequential merge-time BLOCK (fresh review + re-run every
  deterministic gate, against the 10-iteration cap) can raise wall-clock and
  tip near-cap PRs into operator interruptions **even if reviewer tokens fall**.
  The operator asked for speed; a drop that saves tokens but slows delivery or
  adds escalations **fails** the gate.
- **Account for selection bias.** The only locally inspectable population is
  "small, mostly-Claude PRs" where both passes already agree; the hard cases
  (#3375, Codex-implemented blocks) have unreadable transcripts (evidence pack
  §2 caveat). An overlap study run only on the clean set is **biased toward
  reading "redundant"** — it measures the population where pre-push adds least.
  The study must either reach the hard cases (e.g. re-run both passes on
  replayed hard diffs) or explicitly state it cannot conclude "redundant" from
  the clean set alone.
- **Pre-register the escape detector** before the study: "a revert or `fix:`
  PR within N days citing the merged PR." Without it, reversibility is not real.

### 2.2 Ship the drop only if earned — safe default, flag-gated, scoped

- **Default: keep `correctness` everywhere** (today's behavior; no code).
- Ship the drop **only if** 2.1 shows redundancy *and* no net-cost regression.
- When shipped: behind `KOOKR_PREPUSH_CORRECTNESS=1|0` (default `1`), enabled
  **only on positive evidence of an autonomous self-merge lane**
  (`REPO=kookr-ai/kookr` and `KOOKR_TASK_ID` present and merge via `pnpm
  merge`) — **never** on OSS PRs, human manual merges, or plugin-consumer
  repos, which run `pre-pr-review` *without* a merge review (dropping it there
  = correctness reviewed in neither stage). Rollback is a config flip.
- If `select-specialists.sh` then needs the hard/advisory classification, note
  that the live classifier lives in **one** place today
  (`hooks/gh-pr-merge-gate.sh:60`) plus a prose snippet; extract a shared
  `scripts/lib/review-policy.sh` **at that point** (not before), and — because
  the merge-gate hook is installed as a **symlink** into `~/.claude/hooks` and
  guards the live merge — make it **fail-closed on a missing lib**,
  symlink-path-aware (`readlink -f`), keep the skill's inline block with a
  parity test, and add a hook test that runs through a symlink from a foreign
  directory. (Round-2 delivery flagged that a naive `source` here silently
  disables the merge guard via the hook's fail-open ERR trap.)

### 2.3 If 2.1 shows the passes are complementary

Part 2 is abandoned; the delivered value is Part 1 plus the documented finding
that the two passes are complementary, not duplicative. That is a legitimate,
recorded outcome — and a direct, evidence-based answer to the operator's
question.

## Non-Goals

- Removing the independent merge review or weakening the hard gate (#1717/#3027
  exist because zero-review merges caused incidents).
- Removing the deterministic `.hooks/pre-push` gates (build/test/validate) —
  not reviewers, not in scope.
- Editing the `reviewer-fanout` TS contract (dead code; the lever is the spawn
  template).
- A standing telemetry subsystem / `implementer-lane:` verdict field — the
  experiment is a one-off analysis; such instrumentation is justified only if a
  recurring rollout monitor is later needed, or the cross-vendor question (O4)
  is actually pursued. Deferred, not built.
- Making the context pack mandatory (unbuildable on many flows; would reach the
  blind merge reviewer).
- Moving `deadcode`/`conventions` to deterministic non-LLM checks — a promising
  idea (ambition-amplifier) but `rfc-pr-checklist-contract`'s territory.
- Changing hard/advisory *semantics*, or re-drawing which repos are which.

## Edge cases

- **Codex outage → Claude fallback → Claude implementer (correlated load).**
  After a Part-2 drop, the merge review degrades to a same-vendor pass. The
  data says vendor is not the guarantee, so same-vendor is acceptable **at the
  pinned strength floor (1.3)** — that floor is the protection. A pre-push
  "backstop" cannot help here: the pre-push panel already ran at push time and
  cannot be resurrected at merge time. If a stronger guarantee is wanted, the
  *only* viable form is a **merge-stage** rule ("under same-vendor degradation,
  require a second pass"), not a pre-push one — noted as Open question O5, not
  built.
- **OSS / human-manual-merge / plugin-consumer repo.** No merge review runs, so
  correctness stays pre-push there — the default, not an exception.
- **Advisory repo with no verdict and no timeout label (14% of Lucy merges).**
  The real O3 gap (bigger than the 2% timeout rate). Out of scope here;
  recorded as O3.
- **Pack unbuildable.** 1.2 is "use if present," so this degrades to today's
  cold read.

## Alternatives considered

- **v1: drop pre-push correctness now, cross-vendor as the rationale.**
  Falsified (cross-vendor) / unproven (redundancy) — the reason this is v3.
- **Keep pre-push only, drop the merge review (operator's first option).**
  Rejected: the merge review is the cheap stage with the demonstrated
  defect-catch record and the hard gate that closed #1717; its working property
  (fresh-context + exact-head) is exactly what pre-push lacks.
- **Standing instrumentation first (v2 Phase-0: fan-out JSONL +
  `implementer-lane:`).** Rejected for now: round-2 (minimalist + delivery)
  showed the experiment can be a one-off analysis over existing data, and the
  writer has no emitter today (the live panel is prose-driven) and risks
  dirtying the clean-tree HMAC marker. Build a monitor only if a recurring
  rollout needs one.
- **Extract `review-policy.sh` up front (v2 A3).** Rejected: the "triplicated
  classifier" premise was overstated (one shell copy + prose; `kookr-merge.sh`
  is hard-only), and sourcing a lib into the symlinked merge-gate hook is a
  fail-open hazard. Deferred into 2.2, fail-closed, only when a consumer needs
  it.
- **Risk-tiered / cross-vendor-enforced merge review (ambition-amplifier).**
  Deferred: the vendor benefit is unproven; revisit only if O4 data shows a
  real effect.
- **Thread model/effort through the TS fan-out contract / mandatory pack (v1
  D2/D3).** Rejected: dead code; independence-breaking. Replaced by 1.1/1.2.

## Open questions

- **O1:** Does a cheap model lose `lint-like`/`test` findings? (1.1 A/B — gates
  the `test` downgrade.)
- **O2:** Is pre-push correctness actually redundant with the merge review?
  (2.1 same-head overlap — gates all of Part 2.)
- **O3:** Why do 14% of advisory-repo merges carry no review artifact at all?
- **O4:** Is there a real cross-vendor effect at scale (would need
  `implementer-lane:` recorded, not the trailer proxy)? Decides whether
  risk-tiered dual-vendor review is worth pursuing.
- **O5:** Should the merge gate itself require a second pass when it degrades to
  same-vendor under a Codex outage? (A merge-stage safety rule, if the strength
  floor proves insufficient.)

## Critic feedback incorporated

**Round 1** — boundary-critic, failure-mode-analyst, design-minimalist,
ambition-amplifier, delivery-pragmatist (shared evidence pack; panel N=5,
within cap). v1 (drop pre-push correctness now, cross-vendor rationale,
TS-contract + mandatory-pack edits) was challenged on: redundancy unproven
(failure-mode); cross-vendor asserted-not-established (ambition); split by lane
not responsibility + classifier duplication (boundary); TS contract is dead
code + over-built (minimalist); zero-correctness-review path on non-autonomous
flows + metrics not computable (delivery).

**Post-round-1 empirical checkpoint (MANDATORY)** — `design-experimenter`,
2026-10-10: **cross-vendor FALSIFIED** (same-vs-cross 5.6% vs 3.1%, p=0.20;
#3375 fully same-vendor); merge review catches real defects **CONFIRMED**
(24 PRs/34 blocks, ~71% code defects) but **redundancy still UNPROVEN**; **dead
code CONFIRMED**; timeouts rare (2%) but 14% of advisory merges carry no review
artifact. → v2 restructured around reality (converged early out of the full
round schedule per the iterative-review workflow, which directs restructuring
when probes falsify a premise).

**Round 2** — failure-mode-analyst, design-minimalist, delivery-pragmatist (on
restructured v2). All three converged that the shipped scope should be the
**minimal Part 1**; the fixes applied in v3:
- *Minimalist:* cut the standing telemetry subsystem and `implementer-lane:`
  (make the experiment a one-off analysis); correct the overstated
  "triplicated classifier" (one shell copy + prose; `kookr-merge.sh` hard-only);
  defer `review-policy.sh` to when a consumer needs it; delete the
  vendor-aware fallback (contradicts the re-based rationale).
- *Delivery:* drop `kookr-merge.sh` from scope (its jq already ignores unknown
  lines); the symlinked merge-gate hook makes a naive shared-lib `source`
  **fail-open** — so 2.2's deferred extraction is specified fail-closed,
  symlink-aware, with an inline parity test and a foreign-dir symlink hook
  test.
- *Failure-mode:* the A1 "ship now vs gated" contradiction → the cheap-model
  A/B is now a Part-1 prerequisite and `test` downgrades only if it shows no
  loss; B2's vendor fallback is temporally impossible → deleted, A4 strength
  floor is the stated protection with a merge-stage rule noted as O5; R6b
  different-head flaw → 2.1 now mandates **same-head** overlap.

**Adversarial pair (ambition-amplifier ↔ design-minimalist):** both agreed the
TS-contract edits should become a doc-level model pin and that the "near-zero
pre-push value" premise should be tested against existing data now. They
diverged on added ambition (cross-vendor enforcement, deterministic deadcode).
**Resolution:** sided with the minimalist on v3 mechanism/scope (no contract
field; spawn-site pin; one-off experiment; defer dual-vendor and
deterministic-deadcode to Alternatives/O4) but adopted ambition's cheap
*empirical* demand (the same-head overlap study) — because it tests the
load-bearing premise, and expanding the mechanism before establishing the
premise is backwards.

**Invocation log:**
- ambition-amplifier 2026-10-10: novel finding (cross-vendor unproven → routed
  to checkpoint, which falsified it).
- design-experimenter 2026-10-10: empirical checkpoint — cross-vendor
  FALSIFIED, redundancy UNPROVEN, dead-code CONFIRMED (see above).
- assumption-archaeologist: not invoked — no ADR-justified behavior changed
  (the gates trace to issues #1717/#1305/#3027, not an ADR).
- general-purpose 2026-10-10: consensus-attack — **found a shared blind spot
  (incorporated).** The panel treated the two stages as *commensurable* on one
  token axis and one blocking-defect axis (the evidence pack even labeled them
  "expensive/low-yield" vs "cheap/high-yield"), and no critic questioned the
  ruler — so the operator's *speed* dimension and the pre-push panel's ~80%
  non-blocking *prevention* output fell out of the diagnosis, and Part 2's
  overlap study is selection-biased toward "redundant" by data availability.
  Incorporated as one revision: the Problem section now frames the stages by
  function (parallel/off-critical-path prevention vs sequential/gated final
  block) rather than a shared ruler; Part 1 notes the cheap-model win also cuts
  latency; Part 2.1 makes wall-clock + escalation first-class PASS/FAIL axes and
  adds the selection-bias caveat. This did not reopen the review (one triage,
  one revision) and reinforces the RFC's direction — it makes dropping pre-push
  correctness look *more* like something to be earned, not less.
