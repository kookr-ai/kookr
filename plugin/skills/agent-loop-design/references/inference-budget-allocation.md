# Inference budget allocation

Use when: deciding where extra inference compute buys a better answer, before adding N parallel attempts
(best-of-N, vote, judge, synthesis, debate), raising an effort or thinking setting, adding a retry or
revision loop after a failed attempt, or asking several agents to vote.

Spend on a signal that separates good output from bad first, sample count second, thinking length last.
Most evidence is single-turn math and code: for multi-turn agents the numbers are direction, not
promises. To make a loop cheaper or faster instead, see [agent inference
efficiency](agent-inference-efficiency.md).

Contents: Rules · After a failed attempt: revise or resample · Combining parallel attempts · Gaps.

## Rules

1. **Ask first: is there a cheap check?** Tests, a parser, an executed program, a schema. If yes, sample
   4-8 candidates, run every one through the check, and keep one that passes. On SWE-bench Verified, 8
   candidates with an execution-grounded selector took a small model from 67.0% to 76.4% (oracle
   best-of-8: 79.0%); reliable amplification "requires a local soundness signal such as execution or
   tests" (2605.14163). Test-based selection over a 4-agent ensemble reached 84.2% vs 79.2% for one
   agent, and the LLM-judge baseline did not beat the single agent (2610.10242). For multi-turn agents,
   select whole attempts by executing them: log-probability voting transfers poorly to search agents,
   and retrieval-grounded weights at N=4 matched the old method at N=8 (65.9% vs 65.7%, 2608.24024).
2. **No check: pick the selector by output type, never a judge panel.** Never make majority vote or a
   judge panel the only selector for code or agent actions. Judge errors correlate (nine judges behaved
   like 2.18 independent votes, 2605.29800; more in `agent-fleet-orchestration`).
   - Short exact answer: plain majority vote, near 5 samples. Gains flatten early (MMLU 87.9% to 89.0%;
     "diminishing returns beyond n=5" for some subsets, 2604.19395), and a sharpening method did not
     beat it (MATH-500, Qwen3-8B: vote 0.932 vs 0.924-0.928, 2605.28142).
   - Free text: one judge comparing candidates pairwise, both orderings, not one score each: 86% vs 59%
     on a 500-pair diagnostic (2605.15177). Selector quality moved results more than candidate diversity
     (diverse team + judge 0.810 win rate, majority vote 0.496, synthesis 0.179, 2603.20324; its own
     judge, and decoupled judges cut the rates 53-67%, so 0.810 is an upper bound). Use a judge from
     another family than the workers, though a second family shares much of the bias (rule 13). A
     self-judged search lost 25-30 points on HLE's subjective domains, gaining 5-17 on objective ones
     (2605.15177).
3. **Cap thinking per attempt; raise the cap only when the check fails**, not on every call because it
   helped once. Accuracy peaked near 1.5K reasoning tokens on easy problems and near 8K on hard ones,
   then fell (two 32B models, 2604.10739; an example, not a constant). Most measured savings come from
   training (length-aware RL: up to 52.6% shorter chains, 2603.08000), so with a hosted model the lever
   is the effort or budget setting and a task-level stop.
4. **Sample sequentially and stop on agreement**, not a fixed N regardless of difficulty. A
   chain-of-thought plus program pair stopped when both agreed: 9.3x fewer samples than 40-sample
   self-consistency, GSM8K 95.7% at about 2.6 samples (2604.17433). Two attempts that agree by different
   methods are stronger evidence than N copies of the same method.
5. **Route effort per step or per task: easy steps low effort, escalate on failure.** An agent-step
   effort router cut reasoning tokens up to 52.7% at matched success on TAU-Bench; it needs a trained
   router. Adaptive effort cut reasoning tokens 35.2% to 52.7% at matched or better accuracy, while
   static low effort degraded results (2603.07915; gpt-oss-20b and Qwen3-1.7B, not Claude models).
6. **Do not retry blindly; retry on categories where you have seen gain, and cap attempts.** Retry gain
   ran from about 20 points (web search) to about 3 (delegation) on local models with retries capped at
   5 (2603.20380). 10.7% of passing SWE-agent runs were "lucky passes" costing up to 40x more tokens
   (2605.12925). Extra orchestration can lower accuracy while raising cost ([long-horizon
   planning](long-horizon-planning.md) rule 7).
7. **Price wall-clock, not only tokens.** An ensemble matched one Opus call's 84.5% on AIME at about 6x
   the wall-clock (133 s vs 22 s, 120B-parameter ensemble) (2605.04236). Selection across 4+ agents cost
   670K-1670K tokens per instance and accuracy slipped beyond 4 agents (2610.10242).
8. **Reserve headroom for the deliverable.** Operator observation (one or two runs, not measured): four
   deep subagents took a $10 cap to about $18 and the final publish step was withheld. Keep a reserve
   (cost of the final step plus a margin); cap formula in `agent-fleet-orchestration`.
9. **Check the hardest benchmark row, not the average saving.** A budget-aware method cut about 55% of
   tokens and raised average accuracy, yet AIME-25 fell from 88.00 to 64.00 (flagged unclear in the
   source and not confirmed by a later verification pass; check the paper table, 2605.11625).
10. **Don't train or distill on vote winners expecting a higher ceiling**: best@64 fell after training
    on voted labels (2604.15618).

## After a failed attempt: revise or resample

11. **Revise only with a new signal; otherwise resample or restart.** Raw compile, runtime or test
    output is a new signal: revise from it, at most 3 rounds. One round of testbench-log feedback lifted
    resolved rate from 38.6% to 83.2% (2605.15226); execution-validated repair converged in 2-3
    iterations (2604.23940); logic errors fix far less often ([agent failure
    recovery](agent-failure-recovery.md)). The model's own critique is not a new signal: no surveyed
    same-model, token-matched result has self-refinement beating independent samples, and Self-Refine
    made good answers worse in 18.3% of cases (2605.17305). Restart a globally wrong candidate (wrong
    file, wrong approach): patch repair saved 91.2% of tokens over regeneration only when the candidate
    was nearly right (2605.15301).
12. **Keep a best-so-far copy, revert when the score drops, and gate each round on a margin or held-out
    check.** Greedy "keep if the score rose" committed false changes 30-100% of the time; an
    anytime-valid test cut that to about 0% (2606.08106).
13. **A different or stronger critic is not automatically better.** A stronger supervisor critic needs
    headroom and fails on code (2604.21611); stronger judges are not less self-preferring (2604.22891); a
    second family shares the bias (judge-judge agreement 52% vs judge-expert 22-40%, 2606.12071).
14. **Treat an exhausted fix-review budget as terminal.** In the author's runs a fix-to-review loop spent
    its 10 attempts (about 16 defects fixed, a new variant at each review): record a terminal state
    instead of looping on, and give every fix commit its own review.

## Combining parallel attempts

15. **Use the cheapest aggregator with a trustworthy signal** (rules 1-2); no synthesis, debate or
    multi-agent layer by default. Synthesis and debate win narrowly at high cost: MMLU-Pro, Llama 70B,
    synthesis 71.4%, debate 70.0%, self-consistency 68.7%, one chain 64.3%; hard tasks +9.0 points at
    15-20x one chain's compute, easy +2.2 (2605.01566). Measure against plain self-consistency first
    (this includes the debate round of `adversarial-swarm-analysis`). Debate minus majority ranged -0.6
    to 4.9 points (2601.22297); argumentative debate raised sycophancy from a median 50% to 79%
    (2604.21564, human-agent, not agent-agent). Multi-agent layers: `agent-fleet-orchestration`.
16. **When most same-family workers may be wrong, pair the vote with a check.** With corrupted agents at
    ratio 0.6 or more, vote accuracy fell to 0.8% on one track (2604.17139), yet majority of three still
    helped under correlated failures (2606.20158, see [agent failure recovery](agent-failure-recovery.md)).

## Gaps (not measured in the surveyed literature)

- One long chain vs N short chains at equal tokens on one model; best-of-N saturation curves.
- A step or turn budget sweep on SWE-bench; dollar cost per resolved issue for parallel sampling.
- A hard thinking-cap baseline at matched accuracy.
- Token-matched Self-Refine vs independent samples; a round-by-round refinement curve; matched-cost
  repair vs restart on SWE-bench; cheap vs strong critic per dollar.
- Oracle pass@N vs the selector's pick on one pool; reward-model best-of-N vs majority vote at matched
  tokens; aggregator-size sweep; token cost of pointwise vs pairwise vs tournament selection;
  matched-token multi-agent vs single agent on a final-answer benchmark.
