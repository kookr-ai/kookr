---
name: predict-before-acting
group: agent-automation
description: >
  Decide when an agent should predict an action's outcome before taking it (simulated lookahead, a
  "world model", a dry run, a plan mode) and when it should simply act, observe the result and undo if
  needed. Routes by how reversible the action is: act-and-observe inside a sandbox, worktree or test run;
  predict, check against real state and verify the effect for actions that are hard to undo (deleting,
  force-pushing, killing processes, sending messages, spending money, changing shared or production
  state); shallow lookahead over a few candidates only when one wrong choice is expensive. Covers when
  simulated lookahead is not worth its cost, why a dry run must reuse the real command's precondition
  checks, and how to check the effect rather than the invocation. Use before a destructive or outward-facing
  command, when designing an agent loop that plans, simulates or uses tree search, or when deciding
  whether a dry run or preview can be trusted.
keywords: world model, lookahead, simulate before acting, simulative reasoning, predict outcome, dry run, plan mode, preview, irreversible action, destructive command, side effects, act and observe, ReAct, tree search, MCTS, rollback, checkpoint, sandbox, verify effect, precondition gate, clean-slate bias
related: agent-fleet-orchestration, automation-design, autonomous-watch-loop, asking-the-operator, disk-reclaim
---

# Predict before acting

## The idea

An agent can imagine what an action will do before it takes it, or it can take the action and look.
Where real execution is cheap, looking is the better default: the real result is one command away, and
simulated lookahead costs many model calls per step for gains no study has compared with real
execution. Predicting pays in two places: when the action can't be taken back, and when several
options compete and a wrong commit is expensive. The evidence for this split is indirect (see below). Decide by **how reversible the action is**, not by how clever the plan is.

## Step 1: classify the action

| Action | Examples | Do this |
|---|---|---|
| Cheap to undo, effects stay inside your sandbox | edits in your own worktree, running tests, builds, local scratch files | Act, observe, undo if wrong. Don't simulate. |
| Costly choice among candidates | picking one of several fixes, routes, queries or bookings under many constraints | Compare 2-5 candidates one step ahead with the same model, then act and observe. |
| Hard to undo, or reaches outside the sandbox | `rm`, `git push --force`, `kill`, `git reset --hard`, dropping data, sending messages, merging, spending, editing shared or production state | Predict, check against real state, dry-run through the real gate, act, verify the effect (Step 2). |

Evidence (local KB; `kb search` finds each note by its arXiv ID):

- Lookahead helps, but costs many calls per step. An LLM world model that simulated candidate web
  actions beat the same agent acting reactively (a plain act, observe, repeat loop) by +4 to +18 points depending on the task family: 23.0%
  vs 19.0% on a 100-task WebArena subset, 29.8% vs 20.2% on multi-hop questions, 32.2% vs 14.4% on
  constrained flight search. It sampled 20 candidate actions and 20 critic evaluations per step, and the
  note gives no token figures (2507.23773). Against other search methods the margins are smaller: tree
  search with a pre-execution tool score beat LATS 69.04 vs 66.55 on ToolBench (2603.12740). No study in
  the KB compares lookahead with real execution on the same tasks.
- Self-generated feedback drifts. In skill learning, self feedback was the most accurate of four methods
  (31.08%; human-written skills reached 74.50%) but dropped after round 1, while critique from a teacher model kept improving over 4 rounds
  (2604.20087; a model's critique, not the environment's). Adding deliberation to every sub-agent made all
  6 models tested worse (up to 3.37x) at 1.8-2.7x the tokens (2605.16205, an adversarial
  partially observable game).
- Harm data is only suggestive. Of 547 reported coding-agent incidents, 326 were high or critical, and
  destructive operations were 24.5% (2605.30777; the denominator is incidents, not actions), so the focus
  on irreversible actions rests on judgment as much as on measurement.
  Sandbox rollback is cheap (about 1.86 ms) but does not undo network effects (2605.22781).

No study in the KB splits the value of prediction by reversibility. The routing above combines the
harm data, the cost data and the real-run lessons below. Treat it as a reasoned default, not a measured
result.

## Step 2: for a hard-to-undo action

1. **Write the expected effect** in one or two lines: what will change, and what must not change.
2. **Read the real state first.** Agents "frequently exhibit 'Clean-Slate' bias, assuming empty
   environments and skipping state verification, leading to unintended side effects" (2605.10787).
   List what is there before you delete, kill or overwrite it.
3. **Dry-run through the real gate.** A preview must call the same precondition checks as the mutating
   command. A preview built from flags or surface signals advertised actions the real command then
   refused (kb shelf `agent-task-lessons`). If the tool has no real dry run, say so and don't invent one:
   inspect the real state read-only instead (item 2), narrow the action to one target, and ask first if
   the action is also irreversible.
4. **Read a dry run's zero as "not measured".** Disabled and dry-run sweeps return success-shaped output,
   such as a zero count with an empty list, and an agent read that as the problem having already cleared
   (agent-task-lessons).
5. **Act, then verify the effect, not the invocation.** A gate that checked that a write command ran,
   not that it wrote anything, passed when the write was suppressed: "A gate keyed on invocation
   measures intent, not outcome" (kb shelf `agent-task-lessons`). Compare the after-state with step 1.
6. **A mismatch is a stop signal.** Don't push through. Record the gap between expected and observed as
   a lesson.

If the action is irreversible or outward-facing and nobody authorized it, ask first (see
`asking-the-operator`).

## Step 3: if you build lookahead into an agent loop

- **Keep it shallow and wide.** LLM move choices tracked search breadth, not depth, and ignored deeper
  nodes in their own reasoning (2605.06840, a board game). Chained one-step predictions compound error
  (2606.21775, robotics).
- **Gate it.** Skip lookahead on easy steps. In a trained agent, skipping planning when it was not needed
  saved about 10% of reasoning tokens (5,451 to 4,925; 2605.22138). With an API model, a simple rule is:
  compare candidates only for Step 1's "costly choice" row; for the "hard to undo" row, use Step 2's
  predict-and-verify, never imagined rollouts alone.
- **Use the same model plus memory, not a trained simulator.** A frozen model (no weight updates) grounded in remembered
  real transitions and rules learned from its own prediction errors raised next-observation exact match
  from 20.06 to 52.88, with planning gains only "modest" (2606.30639). A frozen model with a procedure
  graph learned from trial runs reached 85.5% on tau-Bench, but only 37.4% vs 36.3% for a simpler
  method on ScienceWorld (2606.12780). Trained or test-time-trained
  world models need open weights (2609.08162, 2607.03441).
- **Judge it by task success and incidents avoided, not prediction accuracy.** "One-step prediction
  accuracy gains did not translate linearly to planning success" (2606.30639).
- **Plan once when the task allows it.** Compiling a web task into one code plan cut latency from 122 s to
  11.7 s and raised accuracy from 61% to 89% against a per-step loop (2605.21470).
- **For code, run the tests.** Verbal critique fails for code because runtime errors are hard to put into
  words (2604.21611). Mental simulation matched an execution-based method on single-program benchmarks
  at 70% of its tokens (2604.21598), but no note compares it with running real tests in a repository.

## Anti-patterns

- **Simulating what you could cheaply observe.** Inside a worktree, running the test costs less than
  predicting its result, and it is ground truth.
- **Trusting a preview that does not share the real command's checks.** It will promise actions the real
  command refuses, or miss guards it enforces.
- **Treating "invoked" as "done".** Check the after-state.
- **Acting on an assumed state.** Killing, deleting or force-pushing because "it must be stale", "it must
  need a rebase" or "it must be stalled" without reading the state first. Real-run lessons include a
  `kill -9` that corrupted a build cache (later steps took 226-365 s instead of 60-72 s), a force-push a
  clean PR never needed, a service stopped before its restart path was checked, and a supervised agent
  judged stalled from truncated telemetry.
- **Deep imagined rollouts.** Errors compound, and the model's own decisions ignore the deep nodes.
- **Treating a pre-action guard as free.** Crafted inputs inflated a guard's tokens 13-63x and latency up
  to 148x (2606.14517). Generic guards caught overt harm but only 14.8% of injection-driven harm to the
  agent's own owner (2604.18658).

## Gaps in the evidence

- No study compares world-model lookahead with plain ReAct on the same model and benchmark with token
  counts, or splits the benefit by how reversible the action is.
- No detection or false-positive rates for predicting side effects before deletes, sends or production
  changes.
- No depth or branching sweep with a cost curve for tool agents, and no comparison of lookahead
  triggered by uncertainty with lookahead at every step.
- Suggested pilot: 20 tasks that each contain one hard-to-undo action, run three ways (plain
  act-observe; predict-and-verify only at hard-to-undo actions; one-step lookahead at every step), 3 runs
  each, measuring success, wrong-effect incidents and tokens.

Source report: `world-model-lookahead-vs-act-observe-agents` in the `agentic-capability-reports` KB.
