# Agent failure recovery

Use when: an agent or subagent hits a tool error, failing test, regression, stuck loop or a budget
burning with no progress mid-task, before adding a retry or reflection loop to a harness, or when
choosing an attempt budget.

**Classify the failure first, then pick the move**: each move works on one failure class and wastes
money or does harm on the others. This covers an agent recovering inside its own task. Supervisors
recovering other work across ticks: `automation-design`; code-level retry, backoff and idempotency keys:
`error-handling-patterns`; fleets (central retry control, fresh-context verifiers):
`agent-fleet-orchestration`. The routing table is a synthesis of separate studies, and the attempt caps
are heuristics.

## Step 1: detect, at the step, not at the end

- After every state-changing step, check one observable postcondition: a test result, a diff, the tool's
  return value, the file you meant to write.
- Before claiming done, re-run the acceptance check. Don't trust a summary of an earlier run.
- Treat the second identical action with an identical result as a loop.
- A failed check means classify and act, not abandon: agents also quit too early on errors.
- Never let the model's own "done", progress figure or confidence decide whether to continue or stop.
  Self-reported progress was 6-12% accurate mid-task, and ending on a self-reported marker completed
  fewer tasks than ending when the model makes no tool call.
- Audit the tool layer, not only the agent: silent failures were confirmed across 15 tools, 7 of which
  failed on over half of test cases. A green tool result is a claim; re-read the state it should have
  changed. Harness-or-model triage: [harness faults](harness-faults.md).
- On failed or suspicious runs, add a step-level judge: outcome-only judging caught 84% of loud injected
  faults but 45% of silent ones, with 33% false alarms on clean runs. Calibrate the judge on 50 to 100
  labeled runs of your own agent first.
- Use failure attribution to pick where to look, not to trigger a rollback. Agent-level blame was right
  ~80% of the time; exact-step blame 24-43%, and humans agree on the exact step only ~40%.
- Early-stop only on a detector fitted to your own traces (best case saved ~26% of tokens at 92%
  precision on a toy setup). Entropy-style stoppers stop converged loops, not doomed ones.

Why: most failures are silent, and step-level checking caught about twice as many failures as judging
the final output (0.89 vs 0.41).

## Step 2: route by failure class

| Failure class | Move | Evidence |
|---|---|---|
| **Transient**: rate limit, timeout, 5xx | Back off with jitter and retry through one shared limiter. For anything with side effects, check whether it already happened first: a timeout is not proof nothing happened. An idempotency key prevents a duplicate but can replay a failed result, so "an ID came back" is not success; check the live state. | Central retry cut concurrent-agent failures from 72-100% to 0-18% (mock API). A create call that timed out under load had often completed after the deadline. |
| **Deterministic with an error message**: compile error, stack trace, failing test, query error | Feed the exact error into the next attempt. One or two rounds. If the same error class comes back, the hypothesis is wrong: change approach. | Error feedback cut execution errors 41-50% vs 32-38% for blind resampling, mostly at the first feedback step. Fix rates were 83-88% for compile and Python runtime errors, but 24% for Java runtime errors and under 35% for wrong answers. |
| **Logic error, no external signal**: tests pass but output is wrong, or no test | Give the artifact and the spec to a fresh-context critic (a stronger model if available) and act on its concrete counterexample. Don't ask the same context to "reflect". | 90% of Reflexion-style self-critiques were boilerplate, at ~16x the tokens of a direct answer; stored reflections transferred badly. A stronger-model critic beat Reflexion by 8-12 points; verbal critique fails on runtime errors, where executable feedback is needed. |
| **Corrupted state**: the work was right, then a later step broke it | Restore the last verified checkpoint, environment included, and replan from there with a one-line note of what failed. | Overwriting correct code with a broken edit caused ~40% of SWE-Agent failures in one study; checkpointing after a passing test recovered all 5 matching cases (small sample). Restoring only the conversation was right 8% of the time vs 100% with sandbox state. |
| **Checkable output, cheap to produce** | Run 3 variants that differ in method (prompt style, code vs prose, model family) and let an automatic check or vote pick. Copies of one model are worse than varied methods; vote only where an automatic check can settle a tie (`agent-fleet-orchestration`). | Variants share failures far more than chance, yet majority-of-3 cut mean failures from 387 to 131. On repository-level coding, consensus added only 3 points, not significant. |
| **Stalled**: no progress over two attempts, or the budget is spent | Stop or escalate. Report what was tried and the state left behind. Don't retry until green: re-running a flaky full suite failed on a different test each time; isolate the failing test. | ~11% of passing SWE-agent runs were "lucky passes" via blind retries, at up to 40x the tokens. |

Don't stack recovery layers (`agent-fleet-orchestration`). Published recovery frameworks often report no
numbers.

## Step 3: place checkpoints at verified progress

- Checkpoint whenever a check passes: a commit after green tests, a sandbox snapshot after a verified
  step. Snapshots cost ~1-2% of run time.
- Restore the environment (files, processes, sandbox), not only the conversation.
- Rolling decoding back to the last prefix that compiled beat repairing at the end (up to 71% lower
  latency, 70% fewer tokens): support for the principle, not for agent checkpoints.
- External side effects don't roll back: sent messages, API writes, pushes, payments. Before such an
  action, record what you will do; after a failure, reconcile instead of repeating.
- Don't kill as recovery. `kill -9` corrupted a compile cache that outlived the process, and every
  relaunch ran ~4x slower until it was cleared. Inspect what a process owned before restarting it.

Evidence: kb://agentic-capability-reports/notes/2026-11-14-agent-step-failure-recovery-policy.md,
kb://agentic-capability-reports/notes/2026-11-14-agent-failure-detection-and-attribution.md
