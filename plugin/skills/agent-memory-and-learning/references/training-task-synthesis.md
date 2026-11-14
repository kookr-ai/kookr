# Training task synthesis

Use when: fine-tuning or RL-training a small agent and there are not enough real runs to learn from, so you
must mine, generate or gate training tasks and environments (the "make the tasks" step of [cheap-worker
adaptation](cheap-worker-adaptation.md) Step 4).

Build the harness-tuned baseline first ([cheap-worker adaptation](cheap-worker-adaptation.md) Step 2): a
prompted role scaffold alone took Qwen3-8B from 5.4% to 8.9% on AppWorld with no training (2604.11465).

## Rules

1. **Mine tasks from real artifacts that already carry an oracle:** merged PRs with fail-to-pass tests,
   resolved issues, CVEs with exploits, real databases and tool backends. Real PRs turned into verified
   edits lifted a 32B model from 18.3% to 30.6% on SWE-bench Verified with 96.3% valid patches (2602.07457);
   gated self-play bug injection in real repos took a 32B model from 41.0% to 51.4% (2512.18552). Treat
   LLM-invented tasks as a supplement: no paper reviewed measures simulated-tool fidelity. SFT on synthetic composite
   tasks scored about 90% in distribution and about 18% on unseen combinations (2512.01970).
2. **Gate every task before training; the filter matters more than the generator.** The reference solution
   passes, a no-op fails, a mutated solution fails, and a second solver can solve it. Expect to discard
   about half: one pipeline kept 139 of 324 environments and 19,777 of 35K tasks (2609.05576). A self-play
   run with a hard data gate scored about 0.71; ungated runs collapsed to about 0.002-0.007 (2605.22217).
3. **Reward a task proposer for validity times difficulty, never difficulty alone.** Solver-failure rewards
   alone invite unsolvable or ambiguous tasks (2510.23595); verifier acceptance times failure rate raised
   Pass@1 from 28.8% to 45.4% on integrals (2605.06660).
4. **Audit the verifier and the passing runs.** 10.7% of passing SWE-bench Verified runs are lucky passes
   (2605.12925); a repeated final write passed the tests in 2 of 16 AppWorld templates until one count
   assertion was added (2610.09142); agent-written test suites reached at best a 55.5% mutation score, and
   the reference executable moved it only from 37.7% to 38.1% (2610.13065).
5. **Admit by measured difficulty, keep the set small, stop early, and hold out by source repository, not
   by task.** One working band kept tasks passing 1 to 5 of 8 rollouts (2610.14118; no paper ablates the
   band). A 1K subset beat the full 50K pool (2610.14028); self-play gains peaked at round 2-4, with collapse
   from round 3 (2605.09959). Confirm any in-loop gain on a held-out check (2610.14238).

## Evidence against

- ClawLoop's task-generation gains were +0.8 on one benchmark against +10.9 on another, at about 2,375
  GPU-hours per iteration (2610.14118).
- Agents choosing synthetic data beat random choice by only 0.35-1.78 points on BFCL (2610.12190).

## Gaps

- No per-stage yield or unsolvable-task rate; no simulated-tool fidelity measurement.
- No real-versus-synthetic head-to-head on one agent benchmark; no cost-per-point breakdown.
