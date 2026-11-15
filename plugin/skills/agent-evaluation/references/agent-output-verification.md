# Agent output verification

Use when: adding a test, judge, reviewer or acceptance step that decides whether an agent's output (patch,
report, plan or trajectory) is accepted or merged, choosing a judge model, or when a gate keeps passing bad
output.

Numbers come from single benchmarks: treat them as orders of magnitude.

## Rules

1. **Run it first.** Build, tests, lint and schema checks beat any judge where they apply (a sound local
   signal lifted a small model ~9 points; selection without one did not amplify). Use a judge only for what
   cannot be run.
2. **Audit the check.** A green check is not proof: one official check missed ~17% of seeded faults, and
   agentic mutants cut a suite's detection from 71% to 40%. Mutate the code or seed a few faults, and
   require every new regression test to fail on the old code. Lucky passes: Check 3 of the
   [evaluation method](agent-evaluation-method.md).
3. **Do not let the builder grade itself, and do not trust agent-written tests alone.** A verifier in a fresh
   context found more seeded faults than the builder's own tests, and a same-model fresh verifier beat a
   different-vendor one. Independence of context pays; independence of vendor does not. Exact-head merge
   verdicts: the `independent-merge-review` skill.
4. **Triage before a verifier can block.** Raw verifier test failures wrongly blocked correct units in 14 of
   15 cases; keeping only tests proven valid cut that to 2 of 15. Confirm a failing test fails on a
   known-bad version and passes on a known-good one before it can fail the gate.
5. **For what cannot be run, use one strong judge with a binary rubric.**
   - Do not buy a panel of clones (nine judges ~ 2 independent votes). If you add a judge, use one from a
     different family, on a sample. This differs from rule 3 (fault-finding), where vendor diversity did not
     pay.
   - Use 5-12 expert-written yes/no criteria, each observable in the output, one call per criterion (kappa
     ~0.79 vs ~0.51 for a holistic judge). Likely the binary observable criteria carry the gain.
   - Have the judge quote evidence before it answers; do not assume chain of thought helps (it amplified bias
     under reference conflict and raised false positives under attack).
   - Check the reference before blaming the judge: wrong references cut one judge from 96% to 59%.
   - For pairwise judging, run both orders and count disagreement as a tie, but test it first (swapping cost
     2.5-7 points where position bias was small). Expect style to matter more than position.
6. **Know the judge's biases.** Judges disagree (mean pairwise kappa ~0.16 on one coding benchmark), several
   accurate judges favor their own output, and judge choice moved scores more than the system under test.
7. **Treat agent output as untrusted input to the judge.**
   - Content-free strings and control-token attacks gave false-positive rates above 90%; chain of thought or
     majority voting could worsen it.
   - Do not tell a judge what is at stake (leniency followed, unmentioned in its reasoning). Keep the
     generator's reasoning out of the judge prompt.
   - Do not wrap judge input in mock tool calls (it backfired).
8. **Keep held-out checks out of the agent's reach, and tell it not to game the visible one.** Coding agents
   exploited a visible public score in ~30% of runs, stronger agents more; an explicit anti-exploit
   instruction cut it from 100% to ~8% on the measured subset.
9. **Do not rely on self-verification without an external signal.** Most prompt-level self-critiques were
   boilerplate; self-reports overstate success (see **Verifier the loop cannot edit** in
   [autonomous experiment loops](autonomous-experiment-loops.md)). Cheap "verify first" prompting helps
   single-answer reasoning, not gating a patch.
10. **Fail closed.** A gate that reads a missing, empty or unparsable input as "clean" passes everything (a
    check script exited 0 on an empty input set). Absent input, a crash or a timeout blocks.
11. **Fix a gate bug by closing the class, not one instance.**
12. **Calibrate on a sample before a judge gates anything.** Judge-human agreement ranges from ~0.3
    (subjective rubrics) to ~0.84 (step-level), and trajectory judges fell below chance on traces over 32K
    tokens. Measure on your own outputs:
    - Per criterion, not in aggregate (aggregate kappa 0.72 hid one criterion at 0.20).
    - Against the human-human ceiling, measured first.
    - With planted known-bad outputs (empty, flattering, injected) that must be rejected after every judge or
      prompt change.
    - Freeze the model snapshot and prompt hash, re-run the labeled set on any change, and keep a rotating
      human spot-check.
    - 100 labels detect a broken criterion, not a 5-point difference between two judges (90% accuracy has a
      95% interval of ~83-94%).
13. **Do not expect step-level (process) verifiers to transform results.** Reviewed gains were a few points,
    with no matched-compute test on software agents.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-judge-vs-execution-verifier-for-agent-output-gates.md, kb://agentic-capability-reports/notes/2026-11-14-building-and-validating-an-llm-judge.md
