---
name: autonomous-experiment-loops
group: agent-automation
description: >
  Design or supervise an agent loop that proposes a change, runs it, measures, and keeps or reverts
  (autoresearch, prompt or harness self-evolution, ML experiment chains), so that its "wins" are real.
  Covers why the agent's own report cannot decide a keep, a statistical keep gate (noise floor, A/A control,
  paired comparison, regression check), fresh-context verification, retirement and gate-tightening rules,
  where to put human checkpoints, and when to stop. Use before launching or trusting an unattended
  experiment loop, when a loop reports steady gains, or when a keep or promote gate looks too easy to pass.
keywords: autoresearch, experiment loop, keep revert, ratchet, self-improving agent, self-evolution, false discovery, noise floor, A/A control, paired test, held-out validation, regression gate, self-report, reward hacking, fresh-context verifier, human checkpoint, plateau, promote gate
related: agent-fleet-orchestration, automation-design, autonomous-watch-loop, independent-merge-review, parallel-subagent-experiments
---

# Autonomous experiment loops

## The idea

A loop that keeps whatever scores higher will, on a noisy metric, keep noise and call it progress. Trust a
loop only as far as its keep decision comes from something other than the agent's own account, and from a
test that can say no. Evidence: report `2026-11-14-autonomous-experiment-loop-false-discovery-controls`
in the `agentic-capability-reports` KB.

## Rules

1. **Re-measure every claimed gain in a harness the agent cannot edit.** Agents overstate top-100 success
   4.8-9.3x and selecting on fitness did not make reports more accurate (2609.00652); they claim effects in
   no-signal worlds 16-44% of the time against a nominal 5% (2611.04070). Freeze the metric, the data split
   and the scoring code outside the agent's write access, and record the scoring-substrate version with
   each keep: a promote gate frozen at a baseline from an older, easier regime never fired.
2. **Measure the noise floor before the first iteration.** Run an A/A control (two identical candidates
   through the whole pipeline). If the gate crowns one, fix the gate. Repeat the baseline 3-6 times;
   variance rose in 71% of self-improving setups and run gaps reached 10.4 points (2608.18066).
3. **Keep on a paired comparison with a confidence interval, not "score went up".** Greedy acceptance
   falsely committed in 30-42% of runs with one real edit and 72-100% with none; a sequential paired gate
   cut it to about 0% with about 18% fewer evaluations (2606.08106, small Qwen models only). Log the
   margin next to the verdict; a pass by about 0.01 point is a decision, not a discovery.
4. **Gate on regressions too.** A gain on failed tasks says nothing about tasks that used to pass; 2 of 96
   candidate modifications cleared a two-gate rule (2609.08175). Expect most candidates to fail.
5. **Verify keeps with a fresh-context verifier** that does not see the agent's rationale. Context
   separation mattered, not provider: a same-model fresh verifier beat a different-provider one 13 to 0
   (2610.28667). Give it valid tests only, or it blocks correct work (14 of 15 units without that
   restriction). Budget 67K-126K tokens per unit.
6. **Retire by measured contribution after a minimum number of trials, with a size cap.** Ratchet-style
   retirement carried most of a +0.328 held-out lift; removing the minimum-trial floor fell below the
   control (2605.22148, 2605.19576). Do not set the threshold so tight it empties the library.
7. **Let gates only tighten.** A change that loosens a gate needs a human merge (2607.13070).
8. **Test every gate against its null case** (empty output, identical candidate). A zero-citation output
   scored 100% verified (0 divided by 0) in an operator run.
9. **Put humans at a few decision points** (hypothesis choice, promote, loosening a gate): 87.5% accepted
   papers with targeted checkpoints versus 25% full-auto and 50% step-by-step (2605.20025, n = 10).
   Correctness and novelty stay a human judgement (2604.20622).
10. **Keep the best checkpoint and stop at the plateau.** 58% of settings improved on the first valid
    attempt but 78% of continued searches ended below their peak (2607.25886); the mean agent stayed near
    the shipped baseline in 124 of 290 cells (2608.20318).

## Anti-patterns

- Trusting a sidecar or status field ("mirrored", "merged green") without reading the artifact it names.
- One run per configuration; shuffled task order flipped +1.5% to -4.5% (2608.18066).
- Letting the agent that wants to finish also set the field that authorizes finishing.
- A proxy metric that stopped tracking the external score mid-loop (2606.20657): re-check correlation.
- Counting a negative result against an idea before ruling out "underpowered" and "fixable flaw".

## Gaps

No matched-compute comparison against random search or a human recipe; no held-out versus training-set
gating ablation; PACE is only shown on 0.5B-3B models; no measured fabrication rate for an optimizer
reporting its own benchmark.
