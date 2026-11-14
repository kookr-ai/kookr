# Predict before acting

Use when: about to run a destructive or outward-facing command, designing an agent loop that plans,
simulates or uses tree search, or deciding whether a dry run or preview can be trusted.

Where real execution is cheap, act and look; simulated lookahead costs many model calls per step. Predict
when the action can't be taken back, or when options compete and a wrong commit is expensive. Decide by
**how reversible the action is**, not by how clever the plan is.

## Step 1: classify the action

| Action | Examples | Do this |
|---|---|---|
| Cheap to undo, effects stay inside your sandbox | edits in your own worktree, running tests, builds, local scratch files | Act, observe, undo if wrong. Don't simulate. |
| Costly choice among candidates | picking one of several fixes, routes, queries or bookings under many constraints | Compare 2-5 candidates one step ahead with the same model, then act and observe. |
| Hard to undo, or reaches outside the sandbox | `rm`, `git push --force`, `kill`, `git reset --hard`, dropping data, sending messages, merging, spending, editing shared or production state | Predict, check against real state, dry-run through the real gate, act, verify the effect (Step 2). |

- Evidence: lookahead helps but costs. An LLM world model simulating candidate web actions beat the same agent acting
  reactively by +4 to +18 points by task family (32.2% vs 14.4% on constrained flight search), sampling 20
  candidate actions and 20 critic evaluations per step; no token figures (2507.23773). Against other search
  methods margins are smaller (tree search with a pre-execution tool score: 69.04 vs 66.55 for LATS on
  ToolBench, 2603.12740). None of the studies
  reviewed compares lookahead with real execution on the same tasks.
- Self-generated feedback drifts: in skill learning, self feedback was the most accurate of four methods
  (31.08%; human-written skills 74.50%) but dropped after round 1, while a teacher model's critique kept
  improving over 4 rounds (2604.20087). Deliberation in every sub-agent made all 6 models worse (up to
  3.37x) at 1.8-2.7x the tokens (2605.16205, an adversarial partially observable game).
- Harm data is only suggestive: of 547 reported coding-agent incidents, 326 were high or critical
  (2605.30777; the denominator is incidents, not actions; destructive share in
  [action containment](agent-action-containment.md)). Sandbox rollback is cheap (about 1.86 ms) but does
  not undo network effects (2605.22781).

None of the studies reviewed splits the value of prediction by reversibility. The routing combines the
harm data, the cost data and the real-run lessons below: a reasoned default, not a measured result.

## Step 2: for a hard-to-undo action

1. **Write the expected effect** in one or two lines: what will change, and what must not change.
2. **Read the real state first.** Agents "frequently exhibit 'Clean-Slate' bias, assuming empty
   environments and skipping state verification, leading to unintended side effects" (2605.10787). List
   what is there; never kill, delete or force-push because "it must be stale / need a rebase / be stalled".
   Real-run lessons: a `kill -9` that corrupted a build cache (later steps took 226-365 s instead of
   60-72 s), a force-push a clean PR never needed, a service stopped before its restart path was checked,
   and a supervised agent judged stalled from truncated telemetry.
3. **Dry-run through the real gate.** A preview must call the mutating command's own precondition checks;
   in a real-run lesson, a preview built from flags or surface signals advertised actions the real command
   then refused. No real dry run? Say so and don't invent one: inspect the real state read-only (item 2),
   narrow the action to one target, and ask first if it is also irreversible.
4. **Read a dry run's zero as "not measured".** Disabled and dry-run sweeps return success-shaped output (a
   zero count, an empty list), and in a real-run lesson an agent read that as the problem having cleared.
5. **Act, then verify the effect, not the invocation.** In a real-run lesson, a gate that checked that a
   write command ran, not that it wrote anything, passed when the write was suppressed: "A gate keyed on
   invocation measures intent, not outcome". Compare the after-state with item 1.
6. **A mismatch is a stop signal.** Don't push through. Record the expected-vs-observed gap as a lesson.
7. **Unauthorized and irreversible or outward-facing? Ask first** (see `asking-the-operator`).

## Step 3: if you build lookahead into an agent loop

- **Keep it shallow and wide.** LLM move choices tracked search breadth, not depth, and ignored deeper
  nodes in their own reasoning (2605.06840, a board game). Chained one-step predictions compound error
  (2606.21775, robotics).
- **Gate it.** Skip lookahead on easy steps: in a trained agent, skipping unneeded planning saved about 10%
  of reasoning tokens (5,451 to 4,925; 2605.22138). With an API model, compare candidates only for Step 1's
  "costly choice" row; for the "hard to undo" row use Step 2, never imagined rollouts alone.
- **Use the same model plus memory, not a trained simulator.** A frozen model grounded in remembered real
  transitions and rules learned from its prediction errors raised next-observation exact match from 20.06
  to 52.88, with planning gains only "modest" (2606.30639). A frozen model with a procedure graph from
  trial runs reached 85.5% on tau-Bench, but 37.4% vs 36.3% for a simpler method on ScienceWorld
  (2606.12780). Trained or test-time-trained world models need open weights (2609.08162, 2607.03441).
- **Judge it by task success and incidents avoided**, not prediction accuracy: "One-step prediction
  accuracy gains did not translate linearly to planning success" (2606.30639).
- **Plan once when the task allows it.** Compiling a web task into one code plan cut latency from 122 s to
  11.7 s and raised accuracy from 61% to 89% against a per-step loop (2605.21470).
- **For code, run the tests.** Verbal critique fails for code because runtime errors are hard to put into
  words (2604.21611). Mental simulation matched an execution-based method on single-program benchmarks at
  70% of its tokens (2604.21598), but no study reviewed compares it with real tests in a repository.
- **A pre-action guard is not free.** Crafted inputs inflated a guard's tokens 13-63x (latency: see
  [action containment](agent-action-containment.md) rule 9; 2606.14517). Generic guards caught overt harm
  but only 14.8% of injection-driven harm to the agent's own owner (2604.18658).

## Gaps

- No same-model, same-benchmark comparison of world-model lookahead with plain ReAct with token counts,
  and no split of the benefit by reversibility.
- No detection or false-positive rates for predicting side effects of deletes, sends, production changes.
- No depth or branching sweep with a cost curve for tool agents.
- No comparison of uncertainty-triggered lookahead with lookahead at every step.
