# Autonomous experiment loops

Use when: launching, supervising or trusting an unattended loop that proposes a change, runs it, measures,
and keeps or reverts (autoresearch, prompt or harness self-evolution, ML experiment chains), or when a loop
reports steady gains or a keep or promote gate looks too easy to pass.

Contents: Keep gate; Running the loop; Search policy and stopping; Gaps.

This guide holds the keep gate shared by every mutate-and-score loop;
[agent self-evolution](agent-self-evolution.md) and
[prompt optimization under budget](prompt-optimization-under-budget.md) add only their loop-specific rules.
Which ideas get compute and which write-up claims to trust: [research ideas and
write-ups](research-ideas-and-writeups.md).

## Keep gate

1. **Verifier the loop cannot edit.** An agent that can read or edit its judge will; an LLM judge must not be
   the only authority over its own loop. Re-measure every claimed gain in a harness the agent cannot edit.
   Agents overstate top-100 success 4.8-9.3x and selecting on fitness did not make reports more accurate
   (2609.00652); they claim effects in no-signal worlds 16-44% of the time against a nominal 5% (2611.04070);
   agents reading cached answer keys reported 100% when the true score was 68.1% (2609.02246); benchmark leak
   controls moved one model from 78.80% to 57.32% (2609.08149). Freeze the metric, the data split and the
   scoring code outside the agent's write access. Use executable tests, answer-key canaries and a
   ground-truth oracle that returns only an opaque pass/fail bit; the in-loop surrogate verifier mattered too
   (removing it cut pass rate from 71.1% to 41.1%, 2604.01687). Record the scoring-substrate version with each
   keep: a promote gate frozen at a baseline from an older, easier regime never fired.
2. **Gates only tighten.** A change that loosens a gate needs a human merge (2607.13070). Review by hand any
   change that touches the evaluator, hooks, playbook or review rules. Do not let the agent that wants to
   finish also set the field that authorizes finishing, and read the artifact a sidecar or status field
   ("mirrored", "merged green") names instead of trusting the field.
3. **Noise floor before the first iteration.** Run an A/A control (two identical candidates through the
   whole pipeline); if the gate crowns one, fix the gate. An identical challenger "won" 80% of the time in
   one operator loop, and a 6-3 head-to-head win became 4-4 on a clean re-run (operator incidents). Repeat the
   baseline 3-6 times (run-count evidence: Check 3 of the [evaluation method](agent-evaluation-method.md)).
4. **Paired keep, not "score went up".** Score each candidate on the same tasks as its parent, several times,
   and accept on the paired difference with a confidence interval. Greedy keep-if-higher committed a
   worthless change in 30-42% of runs with one real improvement available and 72-100% with none; a sequential
   paired gate that stays valid however often you peek (PACE) held false commits near 0% with about 18% fewer
   evaluations (2606.08106, small Qwen models of 0.5B-3B only). Selection optimism grew from 0 to 2.09 points
   as candidates per step went from 1 to 3 (2611.12988; it updates LoRA weights, not a harness, so read it as a
   warning, not a measurement). Log the margin next to the verdict; a pass by about 0.01 point is a decision,
   not a discovery. Counter-evidence on score, and gate choice by failure mode: **Pick the acceptance gate
   for the failure you fear** in [prompt optimization](prompt-optimization-under-budget.md).
5. **Held-out split, sealed test read once.** Validation gains overstated held-out gains about 2.6x in one
   study (+0.202 vs +0.079 on a 0.702 baseline, even with a clean topic-disjoint split), and the gap varied by
   seed (0.034 to 0.160) (2610.12601). Expect a large, noisy drop from validation to sealed test, not an
   exact ratio. Reading the test set every generation turns it into validation. Size the selection set
   before deepening the search: the winner's score exceeded held-out accuracy by 13-20 points at 16 items
   and 1-5 at 256 (2610.09239).
6. **Gate on regressions too.** A gain on failed tasks says nothing about tasks that used to pass; 2 of 96
   candidate modifications cleared a two-gate rule (2609.08175). Expect most candidates to fail, and list
   the tasks that got worse next to any aggregate gain. Strict zero-regression gates can stall the search
   (see [prompt optimization](prompt-optimization-under-budget.md)).
7. **Fresh-context verifier for keeps**, blind to the agent's rationale and given valid tests only (evidence
   and token cost: **Do not let the builder grade itself** and **Triage before a verifier can block** in
   [output verification](agent-output-verification.md)).
8. **Test every gate against its null case** (empty output, identical candidate). A zero-citation output
   scored 100% verified (0 divided by 0) in an operator run.
9. **Re-check that a proxy metric still tracks the external score**; one stopped tracking mid-loop
   (2606.20657).

## Running the loop

- **Retire by measured contribution after a minimum number of trials, with a size cap.** Ratchet-style
  retirement carried most of a +0.328 held-out lift; removing the minimum-trial floor fell below the control
  (2605.22148, 2605.19576). Do not set the threshold so tight it empties the library. Cap size, routing
  cost and judge audit for retirement: [skill library
  design](../../agent-memory-and-learning/references/skill-library-design.md) rules 4 and 6-7.
- **Humans at a few decision points** (hypothesis choice, promote, loosening a gate): 87.5% accepted papers
  with targeted checkpoints versus 25% full-auto and 50% step-by-step (2605.20025, n = 10). Correctness and
  novelty stay a human judgement (2604.20622).
- Before counting a negative result against an idea, rule out "underpowered" and "fixable flaw".

For unattended implement-and-review delivery loops, see the `autonomous-review-loop` skill.

## Search policy and stopping

- **Start with one greedy lineage; broaden only on stagnation.** Greedy hill-climbing scored 0.192 mean
  normalized improvement, the best tree search 0.193, and an agent that switched from greedy to
  multi-branch search when it detected a stall 0.208 (2605.17373). Greedy ranked 1st on dense-opportunity
  tasks and 6th on sparse ones, so keep the switch; do not start with a tree or a population.
- **Spend extra branches on a different lever, with shared notes.** After about three real non-promoting
  results on one lever family, change the axis, not the knob (operator heuristic, not measured). Where
  structure beat a flat loop, shared memory carried the gain: removing shared notes and skills made a kernel
  task 18.6% worse (2604.01658) and cut a gold-medal rate from 80% to 20% (2605.10906); neither study
  ablates tree search against greedy.
- **Watch the trajectory, not the meter.** Area under the score-vs-step curve predicted the final result
  (rho = +0.784); token cost and wall-clock did not (2605.17373).
- **Keep the best checkpoint and stop at the plateau.** 58% of settings improved on the first valid attempt
  but 78% of continued searches ended below their peak (2607.25886); the mean agent stayed near the shipped
  baseline in 124 of 290 cells (2608.20318). Cap rounds and no-improvement streaks: one protocol stops after
  10 rounds, five consecutive regressions or no-ops, or an empty feedback pool (2608.02636); memory notes
  peaked at 4 refinement steps, then degraded (2605.19952). After a set number of unchanged iterations,
  force an adversarial critique: one operator champion sat 21 iterations with no self-pivot.
- **Budget the fan-out.** Batched parallel proposals gave 3-4x faster wall-clock and +3 to +11 points at a
  fixed metric-call budget (2610.36774), but five parallel Opus subagents took one operator run from about
  $0.6 to about $11.75 against a $10 cap. Keep GPU jobs sequential. Keep idea teams to about 5-7 agents:
  teams of up to 8 did not add diversity and 78.3% of later-iteration entities were inherited
  (2604.20548); selector quality mattered more than generator diversity (2603.20324).

## Gaps

No matched-compute comparison against random search or a human recipe, or of one long run against many
short ones; no score-vs-iteration curve with a stated plateau; no dollar cost for tree or multi-agent
search designs; no held-out versus training-set gating ablation; PACE is only shown on 0.5B-3B models; no
measured fabrication rate for an optimizer reporting its own benchmark.
