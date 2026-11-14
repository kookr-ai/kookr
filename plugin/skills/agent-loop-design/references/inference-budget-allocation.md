# Inference budget allocation

Use when: deciding where extra inference compute buys a better answer, before adding N parallel attempts
(best-of-N, majority vote), raising an effort or thinking setting, adding a retry loop, or asking
several agents to vote.

Spend on a signal that separates good output from bad first, sample count second, thinking length last.
Most evidence is single-turn math and code: for multi-turn agents the numbers are direction, not
promises. To make a loop cheaper or faster instead, see [agent inference
efficiency](agent-inference-efficiency.md).

## Rules

1. **Ask first: is there a cheap check?** Tests, a parser, an executed program, a schema. If yes, sample
   4-8 candidates, run every one through the check, and keep one that passes. On SWE-bench Verified, 8
   candidates with an execution-grounded selector took a small model from 67.0% to 76.4% (oracle
   best-of-8: 79.0%); reliable amplification "requires a local soundness signal such as execution or
   tests" (2605.14163). Test-based selection over a 4-agent ensemble reached 84.2% vs 79.2% for one
   agent, and the LLM-judge baseline did not beat the single agent (2610.10242).
2. **No check: stay near 5 samples and do not use a judge panel.** Never make majority vote or a judge
   panel the only selector for code or agent actions. Self-consistency gains flatten early (MMLU 87.9%
   to 89.0%; "diminishing returns beyond n=5" for some subsets, 2604.19395). Judge errors correlate
   (nine judges behaved like 2.18 independent votes, 2605.29800; more in `agent-fleet-orchestration`). A
   self-judged search lost 25-30 points on HLE's subjective domains while gaining 5-17 on its objective
   ones (2605.15177).
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
   static low effort degraded results (2603.07915).
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
   source; check the paper table, 2605.11625).
10. **Don't train or distill on vote winners expecting a higher ceiling**: best@64 fell after training
    on voted labels (2604.15618).

## Gaps (not measured in the surveyed literature)

- One long chain vs N short chains at equal tokens on one model.
- Best-of-N saturation and over-optimization curves.
- A step or turn budget sweep on SWE-bench; dollar cost per resolved issue for parallel sampling.
- A hard thinking-cap baseline at matched accuracy.
