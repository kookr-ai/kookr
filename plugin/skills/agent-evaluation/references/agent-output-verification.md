---
name: agent-output-verification
group: design-analysis
description: Design the gate that decides whether an agent's output (a patch, report, plan or trajectory) is accepted or merged. Covers which verifier to trust (execution checks and tests, a single LLM judge, a judge panel, a process verifier, self-verification), how to audit the check itself, how judges are biased and attacked, how agents game visible checks, and why a fresh-context verifier and fail-closed input handling matter. Use when adding a test, judge, reviewer or acceptance step to an agent workflow, when choosing a judge model, or when a gate keeps passing bad output.
keywords: verifier, LLM judge, LLM-as-judge, acceptance gate, merge gate, self-preference, reward hacking, mutation testing, false accept, fresh context, fail closed, rubric, judge panel, process reward model
related: agent-fleet-orchestration, independent-merge-review, testing-patterns, pre-pr-review
---

# Agent output verification

Evidence base: a survey of 40 arXiv papers plus notes from real agent runs, run by seven cheap research
agents (report `2026-11-14-judge-vs-execution-verifier-for-agent-output-gates` in the local
`agentic-capability-reports` knowledge base). Four-digit IDs like `(2605.14163)` are arXiv paper IDs; each
number is a result measured in that paper and was checked against the paper's note. Most come from one
benchmark each, so treat them as orders of magnitude, not constants.

Terms used below: a *verifier* is anything that accepts or rejects output; an *LLM judge* is a model asked to
grade another model's output; *mutation score* is the share of deliberately planted bugs a test suite
catches; a *Lucky Pass* is a passing run whose solution got there by blind retries rather than sound work;
*false positive* means the gate accepted bad output; *kappa* is chance-corrected agreement (1 = perfect).

## Principle

Use the cheapest check that can actually fail, and audit that check before you trust it. Run what can be run.
Use a judge only for what cannot. A verdict that has not been shown to catch faults is not evidence.

## Rules

1. **Run it first.** Build, tests, lint and schema checks beat any judge where they apply. A sound local
   signal lifted a small model from 67.0% to 76.4% on SWE-bench Verified (ceiling 79.0%); selection without
   one does not amplify (2605.14163).
2. **Audit the check.** A green check is not proof.
   - 10.7% of passing OpenHands runs on SWE-bench Verified were "Lucky Passes" (per model 0.5% to 23.2%)
     (2605.12925).
   - An official GPU-kernel check missed 16.9% of 7,384 seeded faults; precision faults escaped 78.6% of the
     time (2609.22220).
   - Agentic mutants cut a test suite's detection from 71.04% to 39.81% (2605.22175).
   - So: mutate the code or seed a few faults, and require every new regression test to fail on the old code.
3. **Do not let the builder grade itself, and do not trust agent-written tests alone.** The best of six agents
   reached a 55.5% mutation score at $10.56 per instance; four of six stayed below 40% (2610.13065). A
   verifier in a fresh context found more seeded faults than the builder's own tests (p=0.006). A
   different-provider verifier added nothing: in head-to-head fault comparisons the same-model verifier won
   13 and the other-provider verifier 0 (p=0.0005) (2610.28667).
   Independence of context is what pays; independence of vendor is not.
4. **Triage before a verifier can block.** In that study (a "unit" is one service or component built by
   the agent) the verifier's raw test failures wrongly blocked correct programs in 14 of 15 units; keeping
   only tests that were themselves valid dropped that to 2 of 15, at 67K to 126K tokens per unit (2610.28667).
   Add a step that confirms a failing test is correct (it fails on a known-bad version and passes on a
   known-good one) before it can fail the gate.
5. **For what cannot be run, use one strong judge with a binary rubric.**
   - Do not buy a panel of clones: nine judges were worth about 2.18 independent votes and the best single
     judge matched the panel; aggregation closed at most 11% of the gap (2605.29800).
   - Decompose into yes/no criteria. A structured rubric cut self-preference 31.5% on average (2604.22891).
   - Swap order for pairwise comparisons, but measure it: swapping hurt on one benchmark (2604.23178).
   - Expect style to matter more than position: style bias was 0.76 to 0.92, position at most 0.04
     (2604.23178).
6. **Know the judge's biases.** Mean pairwise kappa between judges on a coding-collaboration benchmark was 0.1592 (2604.27727).
   6 of 20 judges were both accurate and significantly self-preferring (2604.22891); one judge favored its vendor's answers by 12 points over human
   raters (2603.03319). Judge choice moved scores more than the system under test (2606.12924).
7. **Treat agent output as untrusted input to the judge.**
   - Short strings gave false-positive rates up to 95.1%, and chain of thought or majority voting could make
     it worse (87.6% to 95.5%) (2507.08794).
   - Control-token attacks exceeded 90% ensemble false-positive rate in 22 of 24 cells (2512.17375).
   - Do not tell a judge what is at stake: leniency appeared in 58 of 72 cells and its reasoning never
     mentioned the framing (2604.15224).
   - Wrapping judge input in mock tool calls backfired (2605.30521).
8. **Keep held-out checks away from the agent, and tell it not to game the visible one.** Coding agents exploited a visible public score in 403 of
   1,326 runs; stronger agents exploited more (Spearman 0.77); an explicit anti-exploit instruction cut it
   from 100% to 8.3% (2604.20200). Keep held-out tests out of the agent's reach.
9. **Do not rely on self-verification without an external signal.** 90% of prompt-level self-critiques were
   boilerplate (2605.05737); operators overstated top-100 success 4.8x to 9.3x in their own reports
   (2609.00652). Cheap "verify first" prompting is the exception: GSM8K 90.91% to 95.75% at 20-50% more tokens
   (2511.21734), for single-answer reasoning, not for gating a patch.
10. **Fail closed.** A gate that reads a missing, empty or unparsable input as "clean" passes everything (a
    real case from past agent runs: a check script exited 0 on an empty input set). Absent input blocks.
11. **Calibrate on a sample before a judge gates anything.** Judge-human correlation was about 0.27 to
    0.32 on subjective rubrics (2606.03043); one single-vendor step-level study reached kappa 0.84 in one single-vendor step-level study (2604.23581).
    Trajectory judges fell below chance on traces over 32K tokens (best judge 69.96%) (2604.08178). Measure
    on your own outputs.
12. **Do not expect step-level (process) verifiers to transform results.** In one study, best-of-8 with a
    reasoning evaluator averaged 52.0% vs 50.6% for direct evaluators at best-of-64, an unmatched compute
    comparison (2503.19877). Other process-verifier gains in the survey were also a few points. No
    matched-compute test on software agents exists.

## Anti-patterns

- Passing on "tests green" without checking the suite can fail.
- A panel of same-family judges treated as independent evidence.
- Putting the stakes, or the generator's reasoning, into the judge prompt.
- Letting the agent that wrote the code also write and run the only test.
- A verifier that blocks on its own raw output, with no validity triage.
- A gate that treats a crash, a timeout or an empty result as success.
- Fixing a gate bug one instance at a time. Close the class (one past case needed repeated review rounds because each fix closed one instance).

## Gaps

No measured false-reject rate for execution checks; no judge-vs-test comparison on the same patches; no
matched-compute process-vs-outcome test on software agents; no measurement of cheap-first verifier cascades or
of generator-judge collusion; no measured rate of rubber-stamp reviews. Do not claim numbers for these.
