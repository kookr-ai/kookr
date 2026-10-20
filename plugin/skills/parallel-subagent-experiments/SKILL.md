---
name: parallel-subagent-experiments
description: >
  For a HARD, OPEN research or design problem — one where the right mechanism is unknown or the design
  is underdetermined, so a single attempt is a guess — run several subagents IN PARALLEL, each pursuing
  a DIFFERENT approach, each required to (1) ground its design in existing expert knowledge via web/arxiv
  search AND any local knowledge bases (e.g. a `kb` CLI), and (2) demonstrate its result with NUMBERS and
  controls. Then synthesise the strongest, and treat agreement ACROSS the independent approaches as a
  robustness result. Use when you would otherwise hand-tune one mechanism in a loop, or debate a design
  with no ground truth. Do NOT use for single-fact lookups, mechanical edits, or a task with one obvious method.
keywords: parallel subagents, parallel experiments, competing approaches, diverse approaches, unknown mechanism, underdetermined design, hypothesis triage, robustness, convergence, literature grounding, arxiv, knowledge base, controls, ablation, open research problem, hard problem, spread the bet, multi-agent experiment
related: adversarial-swarm-analysis, rfc-iterative-review, clear-writing-reviewer
---

# Parallel subagent experiments

## The idea

Some problems are not "look it up" or "apply the known method" — the mechanism itself is unknown, or the
design space is wide and underdetermined, so any single attempt is a guess you then tune in a loop. That
loop is the trap: one agent grinding parameters on one idea can burn a long time and still land on a
local dead end. Instead, **spread the bet**: run several subagents at once, each committed to a
*different* approach, each forced to justify itself against the published literature and against real
numbers. The best answer wins on evidence; and when several independent mechanisms reach the *same*
result, that agreement is itself a finding — the result is robust to the implementation, not an artifact
of one wiring.

This method earns its keep on open problems where independence is the whole point. The canonical win
looks like this: three different candidate mechanisms are each handed to a separate agent, all three
reproduce the target phenomenon, and the convergence shows the effect follows from a *general principle*
rather than from one specific biophysics or one lucky parameter set. It earns its cost only on genuinely
hard, open problems; on anything with a known method, a single agent (or doing it yourself) is cheaper
and better.

## When to use it — and when not

**Use it when** the problem is open and a single attempt is a guess:
- an unknown *mechanism* (what process produces this phenomenon?);
- an underdetermined *design* (several plausible architectures, no ground truth to pick one);
- a hypothesis that needs *triage* across competing explanations;
- you catch yourself about to hand-tune one idea in a long loop.

**Do NOT use it for** single-fact lookups, mechanical edits (renames, typos), a task with one obvious
correct method, or anything a single focused agent (or you) can do directly. Over-spawning is wasted
cost and reviewer load, not rigor.

## The contract each agent must follow

Give every agent the SAME shared context (the goal, the success criteria as *numbers*, the tools, the
run command) and a DISTINCT assigned approach. Require of each:

1. **Ground the design in existing expert knowledge — do not invent from scratch.** Each agent must
   search the literature first: web / arxiv for papers, AND any local knowledge bases available in the
   project. If the project ships a `kb` CLI, use it (`kb list` to see shelves; `kb search "<query>"
   --kb=<shelf>`, or omit `--kb` to search all). Adapt the established mechanisms to the assigned
   approach, and **cite** what it used.
2. **A distinct approach per agent.** The whole value is diversity; two agents doing the same thing is
   waste. Name each one's mechanism/architecture explicitly in its prompt.
3. **Its own isolated scratch directory.** Each agent writes a self-contained module + probe in its own
   dir (e.g. the session scratchpad, one subfolder per agent) so they never collide. They do not touch
   the repo or each other's files.
4. **Demonstrate with NUMBERS and controls.** Each must print the success-criteria numbers and, where it
   can, a control/ablation showing its mechanism is load-bearing (not a baseline artifact). It must
   report honestly — never claim success the numbers do not show, and state exactly where it breaks if
   it fails.

Spawn them in one batch so they run concurrently. Set a reasoning effort appropriate to the difficulty.

## Synthesis (your job after they return)

- **Compare on the numbers**, not the prose. Pick the approach that is cleanest *and* best grounded.
- **Convergence is a result.** If multiple independent approaches reach the same outcome, record that —
  it means the result is robust to the mechanism, which is stronger than any single implementation.
  Disagreement is also information: it localises which assumption matters.
- **Integrate the winner** into the repo as its own tested module, and write it up clearly — run the
  prose through the project's writing-quality pass (e.g. the `clear-writing-reviewer` agent or the
  `clear-technical-writing` skill) before you ship it.
- **Keep the losers' evidence** in the record — a recorded dead end has value; note why the winner won.

## Anti-patterns

- **Spawning for a known-method task.** If there is one right way, just do it; parallel agents are pure
  overhead.
- **Agents that skip the literature.** Ungrounded reinvention is exactly what this method exists to
  avoid; the web + knowledge-base grounding is mandatory, not optional.
- **Agents sharing a directory or the repo tree.** They collide; give each its own scratch dir.
- **Over-spawning.** Three to four distinct approaches is plenty; more is diminishing returns and
  multiplied cost.
- **Trusting the prose.** Judge on the printed numbers and controls; a confident report with weak numbers
  is a fail.
