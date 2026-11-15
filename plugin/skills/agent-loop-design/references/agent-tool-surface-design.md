# Agent tool surface design

Use when: building or auditing an agent's tools or MCP servers (tool count, task-level vs primitive
tools, descriptions and schemas, on-demand loading, output bounds, error wording), when tool calls pick
the wrong tool or burn tokens, before changing tool wording or count, or when deciding which calls to run
in parallel, ahead or speculatively.

Token savings are well measured; success gains mostly rest on one study each, so test each change on
held-out tasks before keeping it.

## Rules

1. **Do not send every schema every turn.** Full schemas cost 15K-55K tokens per turn; loading on demand
   cut a 120-tool set from ~47K to ~2.4K tokens per turn. The success gain is projected, only tokens are
   measured.
2. **Keep the visible set small, and check that retrieval still finds what is needed.** Don't add a tool
   per API endpoint: with 300+ distractor tools, completion fell from ~80% to under 30%. But retrieval
   that misses implicit tool dependencies loses badly too (37% vs 55% for full context). Wrong picks are
   mostly a final-choice fault, not missing input; prompt edits recovered under a quarter of them.
3. **In a narrow domain, give task-level tools, not raw primitives.** Four composite tools reached 90% vs
   57% for generic HTTP tools at lower token cost. Keep a general shell available for open-ended work:
   general coding CLIs beat domain-specific agents there.
4. **Write each description once, short, and say when to use the tool.** Make confusable tools differ in
   their first line; put shared conventions (date format, units) in one place. For a small model add
   few-shot examples. Don't judge rewording on the tasks used to tune it: tuning-set gains overstate
   held-out gains ~2-3x.
5. **Bound output at the source, keep a way to the full payload, never cut the error lines.** Cap bytes,
   not lines. Compressing terminal output except the errors cut tokens 12-27% and kept the critical
   information. Read large CLI output from a file, not a pipe (a pipe returned ~145KB where a redirect
   returned ~1.1MB). Don't pipe `git push` or other exit-code-bearing commands through `tail` or `grep`;
   it hides the failure. In-window truncation policy: the `token-efficiency` skill.
6. **Make errors say what to do next, and cap the retries.** Naming the error class predicts fixability,
   and feeding the failed call and its error back beats blind resampling (see [agent failure
   recovery](agent-failure-recovery.md)). ~80% of successes come on the first attempt; budget three to
   four repair iterations (per-category gain: [inference budget
   allocation](inference-budget-allocation.md)). Don't let one error end the task or retry forever.
7. **Validate arguments, and expect meaning errors to survive.** Constrained decoding removed illegal
   URLs, methods and arguments but slowed generation 67-93%; 88-100% of residual failures were semantic.
8. **Treat tool descriptions and tool servers as untrusted input; pin and review third-party tool text,
   give each tool least privilege.** Descriptor manipulation caused up to 36% unsafe invocations at
   baseline; layered defenses cut it to ~15%. A tool benign during exploration and harmful at the last
   call defeated prompt judges and heuristic guards. See [untrusted-content
   defense](../../agent-safety/references/untrusted-content-defense.md).
9. **Don't guess a CLI's flags by running it**: an unknown `--help` can start the real job. Read usage
   text statically or run only tools known to be read-only.
10. **Measure the harness, not only the tool list.** The same retriever scored 93% on one harness and
    77% on Claude Code; a 20-task smoke run did not predict the full-set result.

## Executing tool calls

11. **Parallelize only read-only calls, and declare dependencies.** Label each tool read-only,
    idempotent write or non-idempotent write; batch only read-only calls in one message, and let a failed
    call cancel its dependents. Overlapping calls with decoding gave ~1.2-1.4x speedups, but accuracy
    dropped on one coding benchmark and safety depended on developer-written read/write annotations.
12. **Plan calls ahead only for repeated, checkable tasks, with a reactive fallback, and count tokens,
    not only calls.** A validated plan DAG cut tool calls from ~12 to ~7 per run while tokens sent rose
    slightly. Compiled-plan latency claims use a weak baseline and 9% of plans were invalid; see
    [long-horizon planning](long-horizon-planning.md) (**Plan up front only when...**, **Validate the
    plan**).
13. **No speculative tool launch without a measured hit rate and a rollback path.** No per-query signal
    predicts a hit, and ~2% of queries net-lose. A speculative or parallel write needs a way back:
    sandbox checkpoint/rollback cut state overhead from 23-48% to 1-2%, but it does not undo network
    side effects.
14. **Treat a client timeout as unknown, not failed.** Verify server state before retrying, and retry
    only idempotent calls or calls with an idempotency key (see [agent failure
    recovery](agent-failure-recovery.md), transient row). Background anything past a few minutes, arm
    one monitor, and end the turn instead of polling.
15. **Do not cut call counts blindly.** Call volume correlated with success (r about 0.7, observational).

Evidence: kb://agentic-capability-reports/notes/2026-11-14-tool-surface-design-for-agents.md,
kb://agentic-capability-reports/notes/2026-11-14-tool-call-scheduling-parallel-async-speculative.md
