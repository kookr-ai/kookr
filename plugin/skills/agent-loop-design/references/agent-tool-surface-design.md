# Agent tool surface design

Use when: building or auditing an agent's tools or MCP servers (tool count, task-level vs primitive
tools, descriptions and schemas, on-demand loading, output bounds, error wording), when tool calls pick
the wrong tool or burn tokens, before changing tool wording or count, or when deciding which calls to
run in parallel, ahead or speculatively.

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

## Executing tool calls

11. **Parallelize only read-only calls, and declare dependencies.** Label each tool read-only, idempotent
    write or non-idempotent write; batch only read-only calls in one message, and let a failed call
    cancel its dependents instead of running them on bad inputs. Overlapping calls with decoding gave
    1.26x (BFCL v3), 1.44x (SWE-bench Lite) and 1.24x (HotpotQA) (2605.15077). Against: SWE-bench Lite
    accuracy was 44.3% vs 47.6%, latency was injected (5 s on BFCL), and safety relied on
    developer-written read/write annotations.
12. **Plan calls ahead only for repeated, checkable tasks, with a reactive fallback, and count tokens,
    not only calls.** A validated plan DAG cut tool calls from 11.81 to 6.82 per run while tokens sent
    rose from 111,530 to 117,593 (2605.14051). The compiled-plan 10x latency figure (2605.21470) is
    against a weak baseline and 9% of its plans were still invalid; see [long-horizon
    planning](long-horizon-planning.md) rules 1 and 5.
13. **No speculative tool launch without a measured hit rate and a rollback path.** Streamed launch could
    hide latency for 73.9% of queries on paper, but no per-query signal predicts it (Spearman rho +0.12)
    and about 1.7% of queries net-lose (2606.20113). No surveyed paper reports a hit rate for predicted
    tool calls. A speculative or parallel write needs a way back: sandbox checkpoint/rollback cut state
    overhead from 23-48% to 1-2% (2605.22781), but it does not undo network side effects.
14. **Treat a client timeout as unknown, not failed.** Verify server state before retrying, and retry only
    idempotent calls or calls with an idempotency key (details in [agent failure
    recovery](agent-failure-recovery.md), transient row). In the author's runs: background anything past
    a few minutes, arm one monitor, and end the turn instead of polling.
15. **Do not cut call counts blindly.** Call volume correlated with success at r about 0.7 in one 22-model
    study (observational, 2603.20380).

## Gaps (not found in the surveyed literature)

- No controlled sweep of tool count (5, 20, 100, 500 tools) with success at each point.
- Lazy schema loading is measured for tokens only; end-to-end success is projected.
- No study of informative vs terse error wording, structured vs plain-text output, or parameter
  renaming; no cross-model transfer of optimized descriptions.
- No code-as-action vs JSON tool call, or shell-only vs rich toolset, comparison at a fixed model.
- No Claude Code measurements of per-turn schema tokens or output caps.
- No hit rate for predicted tool calls, no measure of wasted work from wrong early calls, no tool-time
  vs decode-time split in a real loop, no same-model parallel vs sequential comparison on tokens and
  call count, no way to undo external side effects.
