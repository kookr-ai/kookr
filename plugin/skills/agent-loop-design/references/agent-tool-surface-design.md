# Agent tool surface design

Use when: building or auditing an agent's tools or MCP servers (tool count, task-level vs primitive
tools, descriptions and schemas, on-demand loading, output bounds, error wording), when tool calls pick
the wrong tool or burn tokens, or before changing tool wording or count.

The cost side is well measured; the success side rests mostly on one paper per claim, so test each
change on held-out tasks before keeping it.

## Rules

1. **Do not send every schema every turn.** Re-injecting full schemas costs 15K-55K tokens per turn;
   loading on demand cut a simulated 120-tool set from 47.3K to 2.4K tokens per turn (2604.21816; its
   94% vs 72% success figure is a projection, only tokens are measured).
2. **Keep the visible set small, and check that retrieval still finds what is needed.** Don't add a tool
   per API endpoint: with 300+ distractor tools, completion fell from about 80% to under 30% for several
   models, yet the same paper's iterative retrieval (334 prompt tokens) reached 36.88% success vs 55.31%
   for the best full-context model, because it missed implicit tool dependencies (2605.10787). In 80% of
   198 real BFCL failures the correct tool was the most-attended part of the prompt and the model still
   chose wrong, so the fault is in the final choice, not missing input: prompt-side edits recovered at
   most 23% of failures, attention-readout changes 59-91% (2606.16364, needs model access, single-turn
   only).
3. **In a narrow domain, give task-level tools, not raw primitives.** Four composite tools reached 90%
   vs 57% for generic HTTP tools at the same 32B model, with 10.6K vs 30K tokens per run (2606.18000;
   non-instruct models reached only 27-36%). Against: general coding CLIs reached 96-100% completion
   where domain-specific agents reached 45-50% (2604.27996), so keep a general shell available when the
   task is open-ended.
4. **Write each description once, short, and say when to use the tool.** Make confusable tools differ in
   their first line; put shared conventions (date format, units) in one place. Joint tuning of prompt
   and tool schemas raised success from 51.27% to 64.46% on ToolACE-1000 (2604.19821, one paper, its own
   benchmarks). For a small model, few-shot examples gave +21.5% and structured documentation +5.0%
   (2604.20148). Don't judge rewording on the tasks used to tune it: validation gains overstated
   held-out gains 2.6x in a neighbouring prompt-optimization study (2610.12601).
5. **Bound output at the source, keep a way to the full payload, never cut the error lines.** Cap bytes,
   not lines. Compressing terminal output except the error lines cut tokens 12-27% and kept critical
   information in 96% of sampled events (2604.19572). Read large CLI output from a file, not a pipe: one
   run returned about 1.12MB through a file redirect and about 145KB through a pipe; in one operator
   Codex-session sample 22 of 351 tool outputs were truncated. Don't pipe `git push` or other
   exit-code-bearing commands through `tail` or `grep`; it hides the failure. In-window truncation
   policy: the `token-efficiency` skill.
6. **Make errors say what to do next, and cap the retries.** Naming the error class predicts fixability,
   and feeding the failed call and its error back beats blind resampling (evidence in [agent failure
   recovery](agent-failure-recovery.md)). About 80% of successes come on the first attempt (2603.20380;
   per-category retry gain in [inference budget allocation](inference-budget-allocation.md)); a repair
   budget of three to four iterations is suggested (2607.05197). Don't let one error end the task, and
   don't retry the same call forever.
7. **Validate arguments, and expect meaning errors to survive.** Constrained decoding removed all
   illegal URLs, methods and arguments (+209% correctness on synthetic data) but slowed generation
   67-93% (2607.05936). 88-100% of residual failures on structured tasks were semantic (2604.20148).
8. **Treat tool descriptions and tool servers as untrusted input; pin and review third-party tool text,
   give each tool least privilege.** Descriptor manipulation caused up to 36% unsafe invocations at
   baseline; a layered defense reached 15% with 3-10% false positives (2512.06556). A tool benign during
   exploration and harmful at the last call scored 0.0 on a joint guard-success metric for prompt judges
   and heuristic guards (2605.17453). 7,039 of 68,312 analysed skills were over-privileged (2605.05868).
   See [untrusted-content defense](../../agent-safety/references/untrusted-content-defense.md).
9. **Don't guess a CLI's flags by running it**: an unknown `--help` can start the real job. Read usage
   text statically or run only tools known to be read-only.
10. **Measure the harness, not only the tool list.** The same retriever scored 93.1% on one harness and
    76.7% on Claude Code (2605.15184); a 20-task smoke run did not predict the full-set result
    (2605.14102; its orchestration result is in [long-horizon planning](long-horizon-planning.md)).

## Gaps (not found in the surveyed literature)

- No controlled sweep of tool count (5, 20, 100, 500 tools) with success at each point.
- Lazy schema loading is measured for tokens only; end-to-end success is projected.
- No study of informative vs terse error wording, structured vs plain-text output, or parameter
  renaming; no cross-model transfer of optimized descriptions.
- No code-as-action vs JSON tool call, or shell-only vs rich toolset, comparison at a fixed model.
- No Claude Code measurements of per-turn schema tokens or output caps.
