---
name: agent-failure-recovery
group: agent-automation
description: >
  Decide how an agent should recover when its own task goes wrong mid-run: a tool error, a failing
  test, a bad edit that broke working code, a stuck loop, or a budget burning with no progress.
  Routes each failure class to one move (retry with backoff, feed the error back, ask a fresh-context
  critic, roll back to a verified checkpoint, run diverse variants with an automatic check, or stop
  and escalate), and says how to detect failures and where to put checkpoints. Use when an agent or
  subagent hits an error or a regression, before adding a retry or reflection loop to a harness, or
  when choosing an attempt budget.
keywords: error recovery, retry, reflect, reflexion, self-correction, self-critique, rollback, checkpoint, restore, replan, redundancy, n-version, best-of-n, majority vote, stuck loop, loop detection, stall, abstain, escalate, give up, lucky pass, coherence collapse, side effects, idempotency, attempt budget
related: automation-design, error-handling-patterns, agent-fleet-orchestration, tdd-workflow
---

# Agent failure recovery

## The idea

No single recovery policy wins. Retry, reflection, rollback, redundancy and stopping each work on one
kind of failure and waste money or do harm on the others. So **classify the failure first, then pick
the move**. Detection is usually the weak link: most agent failures are silent, so the agent never
gets to choose a recovery at all.

This skill covers an agent recovering inside its own task. For workflows and supervisors that recover
other work across ticks, use [[automation-design]]. For code-level retry, backoff and idempotency keys,
use [[error-handling-patterns]]. For fleets, use [[agent-fleet-orchestration]], which already covers
central retry control and fresh-context verifiers.

**Evidence limit.** No study in the source KB compares these policies on the same tasks at matched
cost, and none measures success versus attempts for agents. The routing table assembles separate
studies and is a synthesis, not a measured ranking. The attempt caps are heuristics.

## Step 1: detect, at the step, not at the end

- After every state-changing step, check one observable postcondition: a test result, a diff, the
  tool's return value, the file you meant to write.
- Before claiming done, re-run the acceptance check. Don't trust a summary of an earlier run.
- Treat the second identical action with an identical result as a loop.

Why: faults "propagate silently through stateful loops" (2603.06847). In 20,574 real coding-agent
sessions, only 9.33% of misalignment episodes were visibly resolved, and 91.49% of those needed a
developer to push back (2605.29442). Step-level checking caught 0.89 of failures against 0.41 for
judging the final output (2604.23581). A loop breaker cut wasted steps from 4.9% to 2.8% for a
loop-prone model (2604.21375). Agents also fail the other way and quit too early: one model's 19.14%
score on a tool benchmark came partly from premature termination on errors (2605.10787). So a failed
check means classify and act, not abandon.

## Step 2: route by failure class

| Failure class | Move | Evidence |
|---|---|---|
| **Transient**: rate limit, timeout, 5xx | Back off with jitter and retry through one shared limiter. For anything with side effects, check whether it already happened first. | Central retry cut concurrent-agent failures from 72-100% to 0-18% (2604.17111, mock server). A timed-out create often completed after the deadline (operator lessons). |
| **Deterministic with an error message**: compile error, stack trace, failing test, query error | Feed the exact error into the next attempt. One or two rounds. If the same error class comes back, the hypothesis is wrong: change approach. | Error-fed retry cut execution errors 41-50% vs 32-38% for blind resampling at 5 attempts, with the biggest gain at the first feedback step (2605.22937). Fix rates were over 80% for syntax and runtime errors, under 35% for logic errors (2606.17514). |
| **Logic error, no external signal**: tests pass but the output is wrong, or there is no test | Give the artifact and the spec to a fresh-context critic (a stronger model if available) and act on its concrete counterexample. Don't ask the same context to "reflect". | 90% of prompt-level self-critiques were boilerplate; Reflexion spent about 32K tokens per problem vs about 2K for a direct answer (2605.05737). A stronger step-level critic beat Reflexion by 8.5-12.1 points (2604.21611). |
| **Corrupted state**: the work was right, then a later step broke it | Restore the last verified checkpoint, environment included, and replan from there with a one-line note of what failed. | Coherence collapse (right code found, then overwritten) caused 39.7% of SWE-Agent failures; a checkpoint after a passing test recovered 5 of 5 gold edits (2603.24631, a small sample). Chat-only restore was correct 8% of the time vs 100% with sandbox state (2604.28138). |
| **Checkable output, cheap to produce** | Run 3 variants that differ in method (prompt style, code vs prose, model family) and let an automatic check or vote pick. | Agent variants co-fail far above chance (z=29.20), yet majority-of-3 cut mean failures from 387.44 to 130.99 (2606.20158). On repo-level coding, consensus added only +3.0 pp (p=0.08) (2603.24631). |
| **Stalled**: no progress over two attempts, or the budget is spent | Stop or escalate. Report what was tried and the state left behind. | 10.7% of passing SWE-agent runs were lucky passes reached by blind retries and regression cycles, at up to 40x the tokens (2605.12925). Progress over steps predicted the final result (rho=0.784), and switching strategy on a stall beat greedy search (2605.17373). |

## Step 3: place checkpoints at verified progress

- Take a checkpoint whenever a check passes: a commit after green tests, a sandbox snapshot after a
  verified step. Checkpoints are cheap: about 1-2% of run time with millisecond snapshots (2605.22781),
  and 0-1.9% end to end for Crab (2604.28138).
- Restore the environment (files, processes, sandbox), not only the conversation (2604.28138).
- Rolling back to a validated prefix beat repairing at the end: up to 71% lower latency and 70% fewer
  tokens at equal correctness, in code generation (2605.15238).
- External side effects don't roll back: sent messages, API writes, pushes, payments. DeltaBox lists
  missing network I/O rollback as a limit (2605.22781). Before such an action, record what you will
  do; after a failure, reconcile instead of repeating.

## Anti-patterns

- **Reflect with no signal.** "Think about what went wrong" in the same context mostly produces
  boilerplate (2605.05737), and reflection memory transfers badly across tasks (2605.29225).
- **Retrying until green.** A pass after many retries can be luck (2605.12925). A flaky suite retried
  in full never converged in real runs on this host; isolate the failing test instead.
- **Clone voting.** N copies of one model fail together (2606.20158, 2605.29800). Vary the method, and
  vote only where an automatic check can settle a tie.
- **Blind retry of a create.** A timeout is not proof that nothing happened. An idempotency key can
  also replay a dead result: "an id came back" is not success. Check the live state.
- **Stacking recovery layers.** Distributing deliberation across a hierarchy made results worse for
  all six models tested (up to 3.37x worse, at 1.8-2.7x the tokens) (2605.16205). Several self-healing
  frameworks report no numbers at all (2605.06737).
- **Killing as recovery.** `kill -9` can corrupt state that outlives the process, such as caches and
  lock files. Inspect what the process owned before restarting it.

## Gaps

Not found in the KB: a matched-cost comparison of these moves, a success-versus-attempts curve for
agents, measured cheap-to-strong model cascades on agent tasks, human-escalation numbers, loop-detector
precision for coding agents, and compensation for external side effects. Revisit the caps when such
evidence appears.

Source report: `agentic-capability-reports/notes/2026-11-14-agent-step-failure-recovery-policy.md`
in the local KB (`kb search "agent failure recovery policy" --kb=agentic-capability-reports`). arXiv
IDs refer to notes findable with `kb search`.
