# Training task synthesis

Use when: fine-tuning or RL-training a small agent and there are not enough real runs to learn from, so you
must mine, generate or gate training tasks and environments (the "make the tasks" step of [cheap-worker
adaptation](cheap-worker-adaptation.md) Step 4).

Build the harness-tuned baseline first ([cheap-worker adaptation](cheap-worker-adaptation.md) Step 2): a
prompted role scaffold alone took one 8B model from 5% to 9% on AppWorld with no training.

1. **Mine tasks from real artifacts that already carry an oracle:** merged PRs with fail-to-pass tests,
   resolved issues, CVEs with exploits, real databases and tool backends. Real PRs turned into verified
   edits lifted a 32B model from 18% to 31% on SWE-bench Verified. Treat LLM-invented tasks as a supplement:
   SFT on synthetic composite tasks scored about 90% in distribution and about 18% on unseen combinations.
2. **Gate every task before training; the filter matters more than the generator.** The reference solution
   passes, a no-op fails, a mutated solution fails, and a second solver can solve it. Expect to discard
   about half. A self-play run with a hard data gate scored about 0.71; ungated runs collapsed to near 0.
3. **Reward a task proposer for validity times difficulty, never difficulty alone.** Solver-failure rewards
   alone invite unsolvable or ambiguous tasks.
4. **Audit the verifier and the passing runs.** About 11% of passing SWE-bench Verified runs are lucky
   passes; a repeated final write passed the tests in 2 of 16 AppWorld templates until one count assertion
   was added; agent-written test suites reached at best a 55% mutation score.
5. **Admit by measured difficulty, keep the set small, stop early, and hold out by source repository, not
   by task.** A working band kept tasks passing 1 to 5 of 8 rollouts. A 1K subset beat the full 50K pool;
   self-play gains peaked at round 2-4 and collapsed from round 3. Confirm any in-loop gain on a held-out
   check.

Synthetic-task gains vary widely: one task-generation loop gained about +1 on one benchmark and +11 on
another at thousands of GPU-hours per iteration, so check the cost per point before scaling.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-synthesizing-training-tasks-and-environments-for-small-agents.md
