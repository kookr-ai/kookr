# Predict before acting

Use when: about to run a destructive or outward-facing command, designing an agent loop that plans,
simulates or uses tree search, or deciding whether a dry run or preview can be trusted.

Decide by **how reversible the action is**, not by how clever the plan is. Where real execution is cheap,
act and look; simulated lookahead costs many model calls per step. This routing is a reasoned default, not
a measured result.

1. **Classify the action.**

   | Action | Examples | Do this |
   |---|---|---|
   | Cheap to undo, effects stay in your sandbox | edits in your own worktree, tests, builds, scratch files | Act, observe, undo if wrong. Do not simulate. |
   | Costly choice among candidates | one of several fixes, routes, queries or bookings under many constraints | Compare 2-5 candidates one step ahead with the same model, then act and observe. |
   | Hard to undo, or reaches outside the sandbox | `rm`, `git push --force`, `kill`, `git reset --hard`, dropping data, sending messages, merging, spending, editing shared or production state | Rules 2-8 below. |

   Self-generated feedback drifts after the first round; an outside teacher's critique keeps improving. Do
   not make every sub-agent deliberate (all tested models got worse at 2-3x the tokens). Sandbox rollback is
   cheap but does not undo network effects.

For a hard-to-undo action:

2. **Write the expected effect** in one or two lines: what will change, and what must not change.
3. **Read the real state first.** Agents assume empty environments and skip state verification
   ("Clean-Slate" bias), causing unintended side effects. List what is there; never kill, delete or
   force-push because "it must be stale / need a rebase / be stalled". Past failures: a `kill -9` that
   corrupted a build cache (later steps took ~4x longer), a force-push a clean PR never needed, a service
   stopped before its restart path was checked, an agent judged stalled from truncated telemetry.
4. **Dry-run through the real gate.** A preview must call the mutating command's own precondition checks; a
   preview built from flags or surface signals advertised actions the real command then refused. No real
   dry run? Say so and do not invent one: inspect the real state read-only (rule 3), narrow the action to
   one target, and ask first if it is also irreversible.
5. **Read a dry run's zero as "not measured".** Disabled and dry-run sweeps return success-shaped output (a
   zero count, an empty list); an agent read that as the problem having cleared.
6. **Act, then verify the effect, not the invocation.** A gate that checked that a write command ran, not
   that it wrote anything, passed when the write was suppressed: a gate keyed on invocation measures
   intent, not outcome. Compare the after-state with rule 2.
7. **A mismatch is a stop signal.** Do not push through. Record the expected-vs-observed gap as a lesson.
8. **Unauthorized and irreversible or outward-facing? Ask first** (see `asking-the-operator`).

If you build lookahead into an agent loop:

9. **Keep it shallow and wide.** LLM move choices tracked search breadth, not depth, and chained one-step
   predictions compound error.
10. **Gate it.** Skip lookahead on easy steps (skipping unneeded planning saved ~10% of reasoning tokens in
    a trained agent). With an API model, compare candidates only for rule 1's "costly choice" row; for the
    "hard to undo" row use rules 2-8, never imagined rollouts alone.
11. **Use the same model plus memory, not a trained simulator.** A frozen model grounded in remembered real
    transitions and rules learned from its prediction errors predicted next observations much better, with
    only modest planning gains; a procedure graph from trial runs helped on one benchmark and barely on
    another. Trained world models need open weights.
12. **Judge it by task success and incidents avoided**, not prediction accuracy; one-step accuracy gains
    did not translate linearly to planning success.
13. **Plan once when the task allows it.** Compiling a web task into one code plan cut latency about 10x and
    raised accuracy against a per-step loop.
14. **For code, run the tests.** Verbal critique fails for code because runtime errors are hard to put into
    words. Mental simulation matched an execution-based method on single-program benchmarks but is
    untested against real tests in a repository.
15. **A pre-action guard is not free.** Crafted inputs inflated a guard's tokens 13-63x (see
    [action containment](agent-action-containment.md) on guard latency), and generic guards caught overt
    harm but only ~15% of injection-driven harm to the agent's own owner.

Evidence: kb://agentic-capability-reports/notes/2026-11-13-world-model-lookahead-vs-act-observe-agents.md
