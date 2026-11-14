# In-house regression suite

Use when: building an evaluation suite from your own repository history, or gating an agent update (model,
prompt, skill, harness) on your own tasks rather than a public benchmark.

Checks 1-4 of the [evaluation method](agent-evaluation-method.md) (grade every episode, sound tasks,
repeats, a decision rule fixed in advance) still apply; these rules add how to build the suite and what the
update gate reads.

## Rules

1. **Mine merged fix commits that have a fail-to-pass test.** About one in three raw candidates validated,
   at about $1.01 per instance (172 of 522, 2610.25308); a selective reconstruction pipeline finalized
   79.6% (900 of 1,130 eligible changes, 2607.28591). The two start from different pools, so do not compare
   the yields. Reusing one environment across tasks on the same base cut setup from 3.60 to 1.50 hours per
   task.
2. **Strip future commits and gold files from the sandbox.** Removing git-history and local-file leak routes
   moved one model from 78.80% to 57.32%, while a model that did not exploit them moved from 49.98% to
   49.11% (2609.08149). Mined tasks carry their answer in history by construction; that is an inference,
   not tested by the paper. Check issue/diff alignment too (Check 2 of the evaluation method).
3. **Mutation-check LLM-written tests before they become the oracle.** 8% to 17% of generated regression
   tests were fault-enforcing (2610.11835); the best agent's mutation score was 55.5% while test validity
   was 88% to 96% (2610.13065).
4. **Gate on slices and flips, not the aggregate.** Injected regressions moved the aggregate 1.7 to 5.9
   points but the responsible slice 25 to 91 points (2606.11686). A secondary metric can regress while the
   target rises (citation validity under prompt optimization: Rules list, rule 6 of [prompt
   optimization](prompt-optimization-under-budget.md)). Do not read the agent's own progress report:
   mid-task accuracy was as low as 5.8% to 11.5% (2609.08589).
5. **Add one process check, with a floor baseline beside it.** Outcome-only judge recall on silent faults
   was 0.451 against 0.766 for a step-level judge at about 3x cost, but the 8B step judge flagged 397 of
   400 trajectories, the same as an always-faulty baseline (2609.00038).
6. **Keep a held-out slice and size the selection set**: the selected score exceeded held-out accuracy by 13
   to 20 points at 16 items and 1 to 5 at 256 (2610.09239).
7. **Keep a production signal.** About 70% of one agent runtime's silent failures were caught by human
   observation of the user view, not by automated tests (2606.14589).

Evidence against: the 21.5-point leak drop is one model; offline scores predicted online results only after
judge tuning (51.1% to 82.0%, 2606.08867); a reported $2.10 per month upkeep excludes human time
(2607.00345).

## Gaps

No rank correlation or same-model score drop between a public agent benchmark and a private suite; no
per-task flip rate at equal aggregate; no detection rate for injected regressions on a random task subset;
no flaky-task rate or upkeep person-hours for agent evals.
