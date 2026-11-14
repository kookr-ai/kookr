# Autonomous experiment loops

Use when: launching, supervising or trusting an unattended loop that proposes a change, runs it, measures,
and keeps or reverts (autoresearch, prompt or harness self-evolution, ML experiment chains), or when a loop
reports steady gains or a keep or promote gate looks too easy to pass.

This guide holds the keep gate shared by every mutate-and-score loop; [agent
self-evolution](agent-self-evolution.md) and [prompt optimization under
budget](prompt-optimization-under-budget.md) add only their loop-specific rules. Which ideas get compute and
which write-up claims to trust: [research ideas and write-ups](research-ideas-and-writeups.md).

## Keep gate

1. **Verifier the loop cannot edit.** An agent that can read or edit its judge will; an LLM judge must not
   be the only authority over its own loop. Re-measure every claimed gain in a harness the agent cannot edit
   (agents overstated success 5-9x, claimed effects in no-signal worlds 16-44% of the time, and reported
   100% from cached answer keys). Freeze the metric, data split and scoring code outside its write access;
   use executable tests, answer-key canaries and an oracle that returns only an opaque pass/fail bit, and
   keep an in-loop surrogate verifier too (removing it cut pass rate 71% to 41%). Record the
   scoring-substrate version with each keep: a promote gate frozen at an older, easier baseline never fired.
2. **Gates only tighten.** A change that loosens a gate needs a human merge. Review by hand any change to the
   evaluator, hooks, playbook or review rules. Do not let the agent that wants to finish also set the field
   that authorizes finishing; read the artifact a status field ("mirrored", "merged green") names, not the
   field.
3. **Noise floor before the first iteration.** Run an A/A control (two identical candidates through the whole
   pipeline); if the gate crowns one, fix the gate (an identical challenger "won" 80% of the time in one
   loop). Repeat the baseline 3-6 times (Check 3 of the [evaluation method](agent-evaluation-method.md)).
4. **Paired keep, not "score went up".** Score each candidate on the same tasks as its parent, several times,
   and accept on the paired difference with a confidence interval. Greedy keep-if-higher committed a
   worthless change in 30-42% of runs with one real improvement available and 72-100% with none; a
   sequential paired gate that stays valid however often you peek held false commits near 0% (shown on small
   models only). Selection optimism grows with candidates per step. Log the margin next to the verdict; a
   pass by ~0.01 point is a decision, not a discovery. Gate choice by failure mode: **Pick the acceptance
   gate for the failure you fear** in [prompt optimization](prompt-optimization-under-budget.md).
5. **Held-out split, sealed test read once.** Validation gains overstated held-out gains ~2.6x even with a
   clean split, and the gap varied by seed; expect a large, noisy drop, not an exact ratio. Reading the test
   set every generation turns it into validation. Size the selection set before deepening the search: the
   winner overshot held-out accuracy by 13-20 points at 16 items, 1-5 at 256.
6. **Gate on regressions too.** A gain on failed tasks says nothing about tasks that used to pass; 2 of 96
   candidates cleared a two-gate rule. Expect most candidates to fail and list the tasks that got worse next
   to any aggregate gain. Strict zero-regression gates can stall the search (see [prompt
   optimization](prompt-optimization-under-budget.md)).
7. **Fresh-context verifier for keeps**, blind to the agent's rationale and given valid tests only (see **Do
   not let the builder grade itself** and **Triage before a verifier can block** in [output
   verification](agent-output-verification.md)).
8. **Test every gate against its null case** (empty output, identical candidate): a zero-citation output
   scored 100% verified (0 divided by 0).
9. **Re-check that a proxy metric still tracks the external score**; one stopped tracking mid-loop.

## Running the loop

- **Retire by measured contribution after a minimum number of trials, with a size cap.** Removing the
  minimum-trial floor fell below the control; do not set the threshold so tight it empties the library.
  Cap, routing cost and judge audit: [skill library
  design](../../agent-memory-and-learning/references/skill-library-design.md) rules 4 and 6-7.
- **Humans at a few decision points** (hypothesis choice, promote, loosening a gate): targeted checkpoints
  beat both full-auto and step-by-step review (small study). Correctness and novelty stay a human judgement.
- Before counting a negative result against an idea, rule out "underpowered" and "fixable flaw".

For unattended implement-and-review delivery loops, see the `autonomous-review-loop` skill.

## Search policy and stopping

- **Start with one greedy lineage; broaden only on stagnation.** An agent that switched from greedy to
  multi-branch search on detecting a stall beat both pure greedy and the best tree search (greedy ranked 1st
  on dense-opportunity tasks, 6th on sparse ones). Do not start with a tree or population.
- **Spend extra branches on a different lever, with shared notes.** After ~3 non-promoting results on one
  lever family, change the axis, not the knob (heuristic). Shared notes and skills carried the gain where
  structure beat a flat loop: removing them cut one gold-medal rate from 80% to 20%.
- **Watch the trajectory, not the meter.** Area under the score-vs-step curve predicted the final result;
  token cost and wall-clock did not.
- **Keep the best checkpoint and stop at the plateau.** 78% of continued searches ended below their peak.
  Cap rounds and no-improvement streaks (one protocol: 10 rounds, or five consecutive regressions or
  no-ops, or an empty feedback pool; memory notes peaked at 4 refinement steps). After a set number of
  unchanged iterations, force an adversarial critique.
- **Budget the fan-out.** Parallel proposals gave 3-4x faster wall-clock, but five parallel Opus subagents
  took one run from ~$0.6 to ~$11.75 against a $10 cap. Keep GPU jobs sequential. Keep idea teams to ~5-7
  agents (more added no diversity); selector quality mattered more than generator diversity.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-autonomous-experiment-loop-false-discovery-controls.md, kb://agentic-capability-reports/notes/2026-11-14-autonomous-research-search-policy-and-stopping.md
