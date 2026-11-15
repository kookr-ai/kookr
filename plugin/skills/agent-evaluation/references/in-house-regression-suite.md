# In-house regression suite

Use when: building an evaluation suite from your own repository history, or gating an agent update (model,
prompt, skill, harness) on your own tasks rather than a public benchmark.

Checks 1-4 of the [evaluation method](agent-evaluation-method.md) (grade every episode, sound tasks,
repeats, a decision rule fixed in advance) still apply; these rules add how to build the suite and what the
update gate reads.

## Rules

1. **Mine merged fix commits that have a fail-to-pass test.** About one in three raw candidates validated
   (~$1 per instance); a selective pipeline finalized ~80% of eligible changes. Reusing one environment
   across tasks on the same base cut setup from 3.6 to 1.5 hours per task.
2. **Strip future commits and gold files from the sandbox.** Removing git-history and local-file leak routes
   moved one model from 79% to 57% while a model that did not exploit them barely moved. Mined tasks carry
   their answer in history by construction. Check issue/diff alignment too (Check 2 of the [evaluation
   method](agent-evaluation-method.md)).
3. **Mutation-check LLM-written tests before they become the oracle.** 8-17% of generated regression tests
   were fault-enforcing (they pass on the buggy code); the best agent's mutation score was ~56% while test
   validity was 88-96%.
4. **Gate on per-slice scores and per-task flips, not the aggregate.** A real regression can move the
   aggregate ~2-6 points but its slice 25+ points. Track secondary metrics too (citation validity can fall
   while the target rises; see [prompt optimization](prompt-optimization-under-budget.md)). Ignore the
   agent's own progress report; it is often wrong.
5. **Add one process check, with a floor baseline beside it.** A step-level judge raised silent-fault recall
   from 0.45 to 0.77 at ~3x cost, but an 8B step judge flagged 397 of 400 trajectories, the same as an
   always-faulty baseline.
6. **Keep a held-out slice and size the selection set** (selected scores overshot held-out accuracy 13-20
   points at 16 items, 1-5 at 256).
7. **Keep a production signal.** ~70% of one runtime's silent failures were caught by human observation of
   the user view, not automated tests.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-in-house-regression-evals-for-agent-updates.md
