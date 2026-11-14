# Agent failure recovery

Use when: an agent or subagent hits a tool error, failing test, regression, stuck loop or a budget
burning with no progress mid-task, before adding a retry or reflection loop to a harness, or when
choosing an attempt budget.

**Classify the failure first, then pick the move**: each move works on one failure class and wastes
money or does harm on the others. This covers an agent recovering inside its own task. Supervisors
recovering other work across ticks: `automation-design`; code-level retry, backoff and idempotency keys:
`error-handling-patterns`; fleets (central retry control, fresh-context verifiers):
`agent-fleet-orchestration`.

**Evidence limit.** No study in the surveyed literature compares these policies on the same tasks at
matched cost, and none measures success versus attempts for agents. The routing table assembles separate
studies and is a synthesis, not a measured ranking. The attempt caps are heuristics.

## Step 1: detect, at the step, not at the end

- After every state-changing step, check one observable postcondition: a test result, a diff, the tool's
  return value, the file you meant to write.
- Before claiming done, re-run the acceptance check. Don't trust a summary of an earlier run.
- Treat the second identical action with an identical result as a loop.
- A failed check means classify and act, not abandon: agents also quit too early (one model's 19.14% on
  a tool benchmark came partly from premature termination on errors, 2605.10787).

Why: most failures are silent. In 20,574 real coding-agent sessions, only 9.33% of misalignment episodes
were visibly resolved, and 91.49% of those needed a developer to push back (2605.29442). Step-level
checking caught 0.89 of failures against 0.41 for judging the final output (2604.23581). A loop breaker
cut wasted steps from 4.9% to 2.8% for a loop-prone model (2604.21375).

## Step 2: route by failure class

| Failure class | Move | Evidence |
|---|---|---|
| **Transient**: rate limit, timeout, 5xx | Back off with jitter and retry through one shared limiter. For anything with side effects, check whether it already happened first: a timeout is not proof nothing happened. An idempotency key prevents a duplicate but can replay a failed result, so "an ID came back" is not success; check the live state (observed in the author's runs). | Central retry cut concurrent-agent failures from 72-100% to 0-18% (2604.17111, against a mock API server). In the author's runs, a create call that timed out under load had often completed after the deadline. |
| **Deterministic with an error message**: compile error, stack trace, failing test, query error | Feed the exact error into the next attempt. One or two rounds. If the same error class comes back, the hypothesis is wrong: change approach. | In graph-query generation with small models, retrying with the error message cut execution errors 41-50%, vs 32-38% for blind resampling at 5 attempts; the biggest gain came at the first feedback step (2605.22937). Over up to 10 feedback rounds on coding problems, fix rates were 88.2% for compile errors and 82.8% for Python runtime errors, but 23.6% for Java runtime errors and under 35% for wrong answers (2606.17514). |
| **Logic error, no external signal**: tests pass but output is wrong, or no test | Give the artifact and the spec to a fresh-context critic (a stronger model if available) and act on its concrete counterexample. Don't ask the same context to "reflect". | 90% of Reflexion-style self-critiques were boilerplate, at about 32K tokens per problem vs about 2K for a direct answer (2605.05737); stored reflections transferred badly to other tasks (2605.29225). A stronger model critiquing each step beat Reflexion by 8.5-12.1 points on reasoning benchmarks; verbal critique fails on code runtime errors, where executable feedback is needed (2604.21611). |
| **Corrupted state**: the work was right, then a later step broke it | Restore the last verified checkpoint, environment included, and replan from there with a one-line note of what failed. | Overwriting correct code with a broken edit caused 39.7% of SWE-Agent failures in one study; checkpointing after a passing test recovered all 5 such edits that matched the reference fix (2603.24631, small sample). Restoring only the conversation was correct 8% of the time, vs 100% with the sandbox state too (2604.28138). |
| **Checkable output, cheap to produce** | Run 3 variants that differ in method (prompt style, code vs prose, model family) and let an automatic check or vote pick. Copies of one model are worse than varied methods; vote only where an automatic check can settle a tie (judge-correlation evidence in `agent-fleet-orchestration`). | Separately built variants share failures far more than chance (429 vs about 115 expected), yet majority-of-3 cut mean failures from 387.44 to 130.99 (2606.20158). On repository-level coding, consensus added only 3.0 points, not significant (p=0.08) (2603.24631). |
| **Stalled**: no progress over two attempts, or the budget is spent | Stop or escalate. Report what was tried and the state left behind. Don't retry until green: re-running a flaky full suite failed on a different test each time in one observed run; isolate the failing test. | 10.7% of passing SWE-agent runs were "lucky passes" via blind retries and regression cycles, at up to 40x the tokens (2605.12925). Measured progress correlated with final result (rank correlation 0.784), and switching strategy on a stall beat greedy search by a small margin (0.208 vs 0.192, one benchmark of ML research agents) (2605.17373). |

Don't stack recovery layers (evidence in `agent-fleet-orchestration`, 2605.16205). Recovery frameworks
often publish no numbers: one self-healing framework gives none (2605.06737), and one set of MCP
recovery patterns is stated as untested hypotheses (2603.13417).

## Step 3: place checkpoints at verified progress

- Checkpoint whenever a check passes: a commit after green tests, a sandbox snapshot after a verified
  step. They are cheap: DeltaBox spent about 1-2% of run time on snapshots (2605.22781), Crab added
  0-1.9% end to end (2604.28138).
- Restore the environment (files, processes, sandbox), not only the conversation (2604.28138).
- Finer-grain support for the principle, not agent checkpoints directly: rolling C/C++ decoding back to
  the last prefix that compiled beat repairing at the end, with up to 71% lower latency and 70% fewer
  tokens at equal correctness (2605.15238, 32B model).
- External side effects don't roll back: sent messages, API writes, pushes, payments (DeltaBox lists
  missing network I/O rollback as a limit, 2605.22781). Before such an action, record what you will do;
  after a failure, reconcile instead of repeating.
- Don't kill as recovery. In one observed case `kill -9` corrupted a compile cache that outlived the
  process, and every relaunch ran about 4x slower until it was cleared. Inspect what a process owned
  before restarting it.

## Gaps (not found in the surveyed literature)

- No matched-cost comparison of these moves; no success-versus-attempts curve for agents.
- No measured cheap-to-strong model cascades on agent tasks; no human-escalation numbers.
- No loop-detector precision for coding agents; no compensation for external side effects.
