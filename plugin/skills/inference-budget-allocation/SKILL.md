---
name: inference-budget-allocation
group: design-analysis
description: >
  Decide where to spend extra inference compute on a task: more parallel samples (best-of-N, majority
  vote), longer reasoning per attempt, retries, or a stronger selector. Covers when sampling pays (only
  with a ground-truth check such as tests), why LLM-judge and vote selection saturate, where extra thinking
  starts to hurt, adaptive stopping (stop when two attempts agree), and the hidden costs (wall-clock,
  lucky passes, retry loops). Use before adding N attempts, raising an effort or thinking setting,
  adding a retry loop, or asking several agents to vote.
keywords: test-time compute, best-of-n, self-consistency, majority vote, thinking budget, reasoning effort, overthinking, early stopping, adaptive sampling, retries, pass@k, selection, verifier, LLM judge, reward hacking, compute budget
related: agent-fleet-orchestration, token-efficiency, independent-merge-review
---

# Inference budget allocation

## The idea

Extra compute helps only where a signal can separate good output from bad. Spend on that signal first, on
sample count second, and on thinking length last. Measured evidence comes from the local KB (`kb search`
finds each note by arXiv ID). Most of it is single-turn math and code, so for multi-turn agents treat the
numbers as direction, not as promises.

## Rules

1. **Ask first: is there a cheap check?** Tests, a parser, an executed program, a schema. If yes, sample
   4-8 candidates and select with the check. On SWE-bench Verified, 8 candidates with an execution-grounded
   selector took a small model from 67.0% to 76.4% (oracle best-of-8: 79.0%); the paper's rule: reliable
   amplification "requires a local soundness signal such as execution or tests" (2605.14163). Test-based
   selection over a 4-agent ensemble reached 84.2% vs 79.2% for one agent, and the LLM-judge baseline did not
   beat the single agent (2610.10242).
2. **No check: stay near 5 samples and do not use a judge panel.** Self-consistency gains flatten early
   (MMLU 87.9% to 89.0%; the note reports "diminishing returns beyond n=5" for some subsets, 2604.19395). Nine LLM judges behaved like 2.18
   independent votes because their errors correlate (2605.29800). A self-judged search lost 25-30 points on
   HLE's subjective domains while gaining 5-17 points on its objective ones (2605.15177).
3. **Cap thinking per attempt; raise the cap only when the check fails.** Accuracy peaked near 1.5K
   reasoning tokens on easy problems and near 8K on hard ones, then fell (two 32B models, 2604.10739; treat
   as an example, not a constant). 61-93% of reasoning steps were redundant across 8 conditions (2605.23926).
   Most measured savings come from training (length-aware RL: up to 52.6% shorter chains, 2603.08000), so with
   a hosted model the lever you have is the effort or budget setting and a task-level stop.
4. **Sample sequentially and stop on agreement.** A chain-of-thought plus program pair stopped when both
   agreed: 9.3x fewer samples than 40-sample self-consistency, GSM8K 95.7% at about 2.6 samples (2604.17433).
   Two attempts that agree by different methods are stronger evidence than N copies of the same method.
5. **Route effort per step or per task.** An agent-step effort router cut reasoning tokens up to 52.7% at
   matched success on TAU-Bench (2603.07915); it needs a trained router, so the transferable rule is
   "easy steps low effort, escalate on failure".
6. **Do not retry blindly.** Retry gain ran from about 20 points (web search) to about 3 points
   (delegation) on local models with retries capped at 5 (2603.20380). Extra orchestration cut GAIA Level 1
   accuracy from 54.72% to 50.94% while raising cost (2605.14102). 10.7% of passing SWE-agent runs were
   "lucky passes" costing up to 40x more tokens (2605.12925). Retry on categories where you have seen gain,
   and cap attempts.
7. **Price wall-clock, not only tokens.** An ensemble matched one Opus call's 84.5% on AIME at about 6x the
   wall-clock (133 s vs 22 s) (2605.04236). Selection across 4+ agents cost 670K-1670K tokens per instance
   and accuracy slipped beyond 4 agents (2610.10242).
8. **Reserve headroom for the deliverable.** Operator observation (one or two runs, not measured): four
   deep subagents took a $10 cap to about $18 and the final publish step was withheld. Cap fan-out at
   (budget - reserve) / per-agent estimate.

## Anti-patterns

- Fixed N regardless of difficulty or agreement.
- Majority vote or judge panel as the only selector for code or agent actions.
- Raising the thinking setting on every call because it helped on one hard task.
- Trusting an average token saving without checking the hardest benchmark row. A budget-aware method cut
  about 55% of tokens and raised average accuracy, yet its note records AIME-25 falling from 88.00 to 64.00
  (the note flags that row as unclear; check the paper table before relying on either, 2605.11625).
- Training or distilling on vote winners and expecting a higher ceiling: best@64 fell after training on
  voted labels (2604.15618).

## Gaps (not measured in the KB)

One long chain vs N short chains at equal tokens on one model; best-of-N saturation and over-optimization
curves; a step or turn budget sweep on SWE-bench; dollar cost per resolved issue for parallel sampling; a hard
thinking-cap baseline at matched accuracy. Report: `agentic-capability-reports` KB, note
`2026-11-14-samples-vs-longer-reasoning-under-fixed-inference-budget`.
