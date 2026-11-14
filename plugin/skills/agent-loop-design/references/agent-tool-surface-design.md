---
name: agent-tool-surface-design
group: design-analysis
description: >
  Design the set of tools an agent sees and what comes back from them: how many tools to show, whether
  to use task-level or primitive tools, how to word descriptions and schemas, how to load a large
  toolset on demand, how to bound and structure tool output, how to word errors and cap retries, and
  how to treat third-party tool descriptions as untrusted. Use when building or auditing an agent's
  tools or MCP servers, when tool calls pick the wrong tool or burn tokens on schemas and output,
  when a toolset keeps growing, or before changing tool wording or tool count.
related: agent-fleet-orchestration, token-efficiency, agent-efficiency-retrofit, hook-driven-workflow-enforcement, claude-code-permissions
---

# Agent tool surface design

## The idea

The tool surface is everything the agent sees about its tools: which tools, how each is described,
what a call returns and what an error says. It costs tokens on every turn and shapes which tool the
agent picks. The cost side is well measured; the success side rests mostly on one paper per claim, so
test each change on held-out tasks before keeping it.

## Rules

1. **Do not send every schema every turn.** Re-injecting full schemas costs 15K-55K tokens per turn (2604.21816).
   Loading schemas on demand cut a simulated 120-tool set from 47.3K to 2.4K tokens per turn
   (2604.21816; its 94% vs 72% success figure is a projection, only tokens are measured). Retrieving
   tools from a large MCP corpus cut schema exposure from 693,574 to 1,298 tokens (2606.16591). Showing
   one tool per step cut tokens per task from 4,152 to 1,186 (2606.16813).
2. **Keep the visible set small and check that retrieval can still find what is needed.** With 300+
   distractor tools, completion fell from about 80% to under 30% for several models (2605.10787); the
   same paper's iterative retrieval cut prompt tokens to 334 but reached 36.88% vs 55.31% for the best
   full-context model (success rates; 334 is prompt tokens), because it missed implicit tool
   dependencies. In 80% of 198 real BFCL failures the correct tool was the most-attended part of the
   prompt and the model still chose wrong, so the fault is in the final choice, not in missing input:
   prompt-side edits recovered at most 23% of failures, while changes to the model's attention
   readout recovered 59-91% (2606.16364, needs model access, single-turn only).
3. **In a narrow domain, give task-level tools, not raw primitives.** Four composite tools reached 90%
   vs 57% for generic HTTP tools at the same 32B model, with 10.6K vs 30K tokens per run (2606.18000;
   non-instruct models reached only 27-36%). Extra navigation tools cut function-level IoU (overlap with the true location) from 24.28
   to 13.71 in a localization agent (2512.20957). Against: general coding CLIs reached 96-100%
   completion where domain-specific agents reached 45-50% (2604.27996), so keep a general shell
   available when the task is open-ended.
4. **Write each description once, short, and say when to use the tool.** Make confusable tools differ in
   their first line and put shared conventions (date format, units) in one place. Joint tuning of the
   prompt and tool schemas raised success from 51.27% to 64.46% on ToolACE-1000 (2604.19821, one paper
   on its own benchmarks). For a small model, few-shot examples gave +21.5% and structured
   documentation +5.0% (2604.20148). Validation gains overstate held-out gains: 2.6x in a neighbouring
   prompt-optimization study (2610.12601).
5. **Bound output at the source and keep a way to the full payload.** Cap bytes, not lines. Truncating
   observations with a tool that fetches the full payload cut cost 61% and 87% on two benchmarks with
   competitive scores (2606.17016). Compressing terminal output but never the error lines cut tokens
   12-27% and kept critical information in 96% of sampled events (2604.19572). Read large CLI output
   from a file, not a pipe: one run returned about 1.12MB through a file redirect and about 145KB through
   a pipe; in one operator Codex-session sample 22 of 351 tool outputs were truncated (kb lessons
   `cli-stdout-capture-redirect-to-file-not-pipe...` and `compress-tool-output-around-decisions...`).
6. **Make errors say what to do next and cap the retries.** Naming the error class predicts fixability
   (share of cases fixed: compile errors 88.2%, runtime errors 82.8% in Python and 23.6% in Java, 2606.17514, code
   repair). Putting the failed call and its error back in context beat blind resampling (query errors
   down 41-50% vs 32-38%, 2605.22937). About 80% of successes come on the first attempt and retry gain
   ranged from about 20 points (web search) to about 3 (delegation) (2603.20380); a repair budget of
   three to four iterations is suggested (2607.05197). One model succeeded on only 19.14% of tasks,
   which the paper blames on stopping early after errors (2605.10787).
7. **Validate arguments, and expect meaning errors to survive.** Constrained decoding removed all
   illegal URLs, methods and arguments (+209% correctness on synthetic data) but slowed generation 67-93%
   (2607.05936). 88-100% of residual failures on structured tasks were semantic, not syntactic
   (2604.20148).
8. **Treat tool descriptions and tool servers as untrusted input.** Descriptor manipulation caused up to
   36% unsafe invocations at baseline; a layered defense reached 15% with 3-10% false positives
   (2512.06556). Malicious MCP payloads reached 100% attack success rate (ASR) undefended on most tools
   (2603.24203). A tool benign during exploration and harmful at the last call scored 0.0 on a joint
   guard-success metric (GUARDEDJOINT) for prompt judges and heuristic guards (2605.17453). 7,039 of 68,312 analysed skills
   were over-privileged (2605.05868). Pin and review third-party tool text; give each tool least privilege.
9. **Measure the harness, not only the tool list.** The same retriever scored 93.1% on one harness and
   76.7% on Claude Code (2605.15184); added orchestration lowered accuracy from 54.72% to 50.94%, and a
   20-task smoke run did not predict the full-set result (2605.14102).

## Anti-patterns

- Adding a tool for every API endpoint, then wondering why the agent picks the wrong one.
- Guessing a CLI's flags by running it: an unknown `--help` can start the real job. Read usage text
  statically or run only tools known to be read-only.
- Piping `git push` or another exit-code-bearing command through `tail` or `grep`, which hides its failure.
- Summarising away the error line to save tokens.
- Rewording descriptions on the same tasks used to judge the result.
- Letting one error end the task, or retrying forever with the same call.

## Gaps

- No controlled sweep of tool count (5, 20, 100, 500 tools) with success at each point.
- Lazy schema loading is measured for tokens only; end-to-end success is projected.
- No study of informative vs terse error wording on tool results, structured vs plain-text output, or
  parameter-renaming; no cross-model transfer of optimized descriptions.
- No code-as-action vs JSON tool call, or shell-only vs rich toolset, comparison at a fixed model.
- No Claude Code measurements of per-turn schema tokens or output caps.

Evidence: the cited papers are filed in the local KBs (`kb search "<arXiv id>"`); the full report with
quotes is the `agentic-capability-reports` note `2026-11-14-tool-surface-design-for-agents`.
