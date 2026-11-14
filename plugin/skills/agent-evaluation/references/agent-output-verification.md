# Agent output verification

Use when: adding a test, judge, reviewer or acceptance step that decides whether an agent's output (patch,
report, plan or trajectory) is accepted or merged, choosing a judge model, or when a gate keeps passing bad
output.

Most numbers below come from one benchmark each: treat them as orders of magnitude, not constants.

## Rules

1. **Run it first.** Build, tests, lint and schema checks beat any judge where they apply. A sound local
   signal lifted a small model from 67.0% to 76.4% on SWE-bench Verified (ceiling 79.0%); selection without
   one does not amplify (2605.14163). Use a judge only for what cannot be run.
2. **Audit the check.** A green check is not proof. An official GPU-kernel check missed 16.9% of 7,384 seeded
   faults; precision faults escaped 78.6% of the time (2609.22220). Agentic mutants cut a test suite's
   detection from 71.04% to 39.81% (2605.22175). Lucky passes: see Check 3 of the
   [evaluation method](agent-evaluation-method.md). So: mutate the code or seed a few faults, and require
   every new regression test to fail on the old code.
3. **Do not let the builder grade itself, and do not trust agent-written tests alone.** The best of six agents
   reached a 55.5% mutation score at $10.56 per instance (2610.13065). A
   verifier in a fresh context found more seeded faults than the builder's own tests (p=0.006); a
   same-model fresh verifier beat a different-provider one 13 to 0 in head-to-head fault comparisons
   (p=0.0005) (2610.28667). Independence of context is what pays; independence of vendor is not. For the
   exact-head merge verdict procedure, see the `independent-merge-review` skill.
4. **Triage before a verifier can block.** The verifier's raw test failures wrongly blocked correct programs in
   14 of 15 units (a unit is one service or component built by the agent); keeping only tests that were
   themselves valid dropped that to 2 of 15, at 67K to 126K tokens per unit (2610.28667). Confirm a failing
   test fails on a known-bad version and passes on a known-good one before it can fail the gate.
5. **For what cannot be run, use one strong judge with a binary rubric.**
   - Do not buy a panel of clones: nine judges were worth about 2.18 independent votes and the best single
     judge matched the panel (2605.29800). If you add a judge, run one from a different family on a sample.
     Rule 3 found the opposite for fault-finding verifiers (same-model fresh context beat another vendor),
     so the two results disagree on whether family diversity pays.
   - Decompose into 5 to 12 yes/no criteria, each observable in the output, written by an expert, one call
     per criterion. A rubric judge reached kappa 0.788 against 0.508 for a holistic trajectory judge
     (2604.24964); expert rubrics beat LLM-written ones, kappa 0.60 against 0.46 (2603.22744); a structured
     rubric cut self-preference 31.5% on average (2604.22891). Neither kappa result is a controlled ablation
     and one study found analytic rubrics not consistently better than holistic ones (2605.06283), so the gain
     likely comes from binary observable criteria.
   - Have the judge quote evidence before it answers; do not assume chain of thought helps. It amplified bias
     under reference conflict (2601.07506) and raised false positives under attack (rule 7).
   - Check the reference before blaming the judge: GPT-4o fell from 96.5% to 59.3% when references were
     swapped to wrong answers (2601.07506).
   - For pairwise judging, run both orders and count disagreement as a tie, but test it first: swapping cost
     2.5 to 7.0 points on LLMBar, where position bias was at most 0.04 and style bias 0.76 to 0.92
     (2604.23178). Expect style to matter more than position.
6. **Know the judge's biases.** Mean pairwise kappa between judges on a coding-collaboration benchmark was
   0.1592 (2604.27727). 6 of 20 judges were both accurate and significantly self-preferring (2604.22891).
   Judge choice moved scores more than the system under test (2606.12924).
7. **Treat agent output as untrusted input to the judge.**
   - Short strings gave false-positive rates up to 95.1%, and chain of thought or majority voting could make
     it worse (87.6% to 95.5%) (2507.08794).
   - Control-token attacks exceeded 90% ensemble false-positive rate in 22 of 24 cells (2512.17375).
   - Do not tell a judge what is at stake: leniency appeared in 58 of 72 cells and its reasoning never
     mentioned the framing (2604.15224). Keep the generator's reasoning out of the judge prompt too.
   - Wrapping judge input in mock tool calls backfired (2605.30521).
8. **Keep held-out checks out of the agent's reach, and tell it not to game the visible one.** Coding agents
   exploited a visible public score in 403 of 1,326 runs; stronger agents exploited more (Spearman 0.77); an
   explicit anti-exploit instruction cut exploitation from 100% to 8.3% on the measured subset (2604.20200).
9. **Do not rely on self-verification without an external signal.** 90% of prompt-level self-critiques were
   boilerplate (2605.05737); self-reports overstate success (see **Verifier the loop cannot edit** in
   [autonomous experiment loops](autonomous-experiment-loops.md)). Cheap "verify first" prompting is the
   exception: GSM8K 90.91% to 95.75% at 20-50% more tokens (2511.21734), for single-answer reasoning, not
   for gating a patch.
10. **Fail closed.** A gate that reads a missing, empty or unparsable input as "clean" passes everything (a
    past agent run: a check script exited 0 on an empty input set). Absent input, a crash or a timeout blocks.
11. **Fix a gate bug by closing the class, not one instance** (one past case needed repeated review rounds
    because each fix closed one instance).
12. **Calibrate on a sample before a judge gates anything.** Judge-human correlation was about 0.27 to 0.32 on
    subjective rubrics (2606.03043); one single-vendor step-level study reached kappa 0.84 (2604.23581).
    Trajectory judges fell below chance on traces over 32K tokens (best judge 69.96%) (2604.08178). Measure
    on your own outputs:
    - Per criterion, not in aggregate: aggregate kappa 0.7168 hid one criterion at 0.2022 (2604.25224);
      model-level Spearman 0.99 coexisted with sample-level Pearson 0.72 (2603.11027).
    - Against the human-human ceiling, measured first: kappa 0.87 for humans vs 0.84 for the judge
      (2603.27476); the ceiling was r 0.40 on subjective rubrics (2606.03043).
    - With planted known-bad outputs (empty, flattering, injected) that must be rejected after every judge or
      prompt change: content-free tokens gave 80%+ false positives (2507.08794), and judge wording alone
      moved a rate by up to 24.2 points (2604.24074).
    - Freeze the model snapshot and prompt hash, re-run the labeled set on any change, and keep a rotating
      human spot-check.
13. **Do not expect step-level (process) verifiers to transform results.** In one study, best-of-8 with a
    reasoning evaluator averaged 52.0% vs 50.6% for direct evaluators at best-of-64, an unmatched compute
    comparison (2503.19877). Other process-verifier gains reviewed were also a few points. No
    matched-compute test on software agents exists.

## Gaps

No measured false-reject rate for execution checks; no judge-vs-test comparison on the same patches; no
matched-compute process-vs-outcome test on software agents; no measurement of cheap-first verifier cascades or
of generator-judge collusion; no measured rate of rubber-stamp reviews; no label count needed to validate a
judge, no confidence interval on judge-human kappa, no same-task comparison of pointwise, pairwise and
reference-guided judging, and no results on scale granularity, judge version drift or re-validation
cadence. Do not claim numbers for these. Arithmetic, not a study: at 100 labels a measured 90% accuracy
has a 95% interval of about 83% to 94%, so 100 labels detect a broken criterion but not a 5-point
difference between two judges.
