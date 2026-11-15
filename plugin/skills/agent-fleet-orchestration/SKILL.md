---
name: agent-fleet-orchestration
group: design-analysis
description: >
  Decides whether to split a task across subagents and which models play lead and worker: routing by task
  shape, tier cost, a brief template for cheap workers, verifying instead of voting, escalation, handoffs
  and shared worktrees, and coding fleets. Use before spawning more than two subagents, choosing models
  for a multi-agent run, splitting issues across parallel implementers and test writers, or when a spend
  cap is in play.
keywords: subagent fleet, swarm, fan-out, orchestrator, orchestrator-worker, lead agent, haiku workers, model tier, cost per task, spend cap, budget, cheap model, small model, multi-agent vs single agent, task shape, breadth vs depth, majority vote, correlated errors, verification, brief template, context isolation, prompt caching, coding fleet, batch PR, multi-issue PR, parallel implementers, test writer, test-first, spec-first, plan handoff, difficulty routing, diff-only review, escalation, cascade, handoff, file ownership
related: parallel-subagent-experiments, adversarial-swarm-analysis, token-efficiency, automation-design, tdd-workflow, independent-merge-review, agent-memory-and-learning
---

# Agent fleet orchestration

Cheap fleets buy coverage, not depth. Decide by the **shape of the task**, not by the model.

## Step 1: classify the task shape

Split the task into sub-questions. Ask: can they be answered independently, and can an answer be
checked without redoing the work?

| Shape | Examples | Use |
|---|---|---|
| Broad, parallel, checkable | KB or literature surveys, codebase audits, edits to many separate files, log or issue triage, extraction | Strong lead + cheap worker swarm |
| Deep, sequential, tightly coupled | a subtle bug, a design decision, a proof, a refactor across interlocking code | One strong agent; the most capable model only if the task is beyond the strong one |
| Mixed: explore, then build | most real engineering tasks | Swarm the exploration; the lead keeps the reasoning and the build |
| Judging, voting, review | "have N agents check it and take the majority" | One strong reviewer plus checks done by code. Do not vote. |

- **Expect gains only at the edge of the workers' ability**; they vanish when workers are strong.
  Parallel agents find the most issues, but one agent is cheapest per validated finding, and a
  centralized multi-agent setup loses on both cost and accuracy.
- **Do not hand a tightly coupled task from a strong model to a cheap one midway.** In iterative loops
  the same model in both roles beats mixed tiers (a one-shot written plan differs; see Step 6).
- **Keep long, branching workflows off small models**; they break down there.

## Step 2: price it

Read current rates from the `claude-api` skill. Haiku-class workers cost ~20x less per token than
Sonnet-class and ~40x less than Opus-class.

- **With cheap workers, budget the lead's tokens, not the worker count.** In a measured run an Opus lead
  cost ~11x its whole 8-worker Haiku swarm, much of it fixed session context re-read every turn.
- **With expensive workers, cap the count.** Fan-outs of Opus deep agents (~100-150K tokens each) pushed
  a $10 cap to $14-18 before the deliverable existed. Cap workers at
  `(budget - reserve) / per-worker estimate`. Reserve budget for the final deliverable before fanning
  out, or the run ends with money spent and nothing published.
- **Pick the lead by synthesis difficulty.** A Sonnet lead costs about half an Opus lead and is enough
  for straightforward synthesis; use Opus when the synthesis or build is hard.
- To make a cheaper model do a stronger one's work, see
  [cheap-worker adaptation](../agent-memory-and-learning/references/cheap-worker-adaptation.md).

## Step 3: write every brief in one pass

Plan the whole fan-out in one decision (far fewer calls than search-based orchestration). Write all
briefs in one message and spawn them in one batch. Before launch:

- **Test every tool command once yourself**; cheap workers waste turns guessing syntax.
- **Put the shared part first and keep it byte-identical** across briefs so it stays cached.
- **Give each worker a different question.** Never give N workers the same one.
- **Keep each worker's prompt under 100K tokens**; the cheap tier's price jumps above that (see
  `claude-api`).

```text
[Shared prefix, identical in every brief]
Tools: <exact, tested command syntax>. These flags do not exist: <...>.
Skip commands that take write locks: <...>.
Output schema: <fields; for research: claim | number | source ID | URI | verbatim quote>
"Not found" is a valid answer. Do not pad.
Write full results to <path>; return a summary of at most ~900 words.

[Per-worker part]
Question: <one question, not overlapping any other worker's>
Also answer: <the case against: failure modes, when this approach loses>
```

## Step 4: verify; don't vote

- **Do not vote, and never vote with clones.** Errors are correlated: nine judges from seven families
  were worth ~2 independent votes; same-family copies agree even more; majority voting collapses when
  most agents are wrong.
- **Check with code first.** Grep every cited quote and number against its source; run the tests. Check
  every copy of a source before calling a citation fabricated.
- **Give verifiers a fresh context** that never saw the builder's history or artifacts, and end with a
  QA-and-fix stage. Independence of context matters more than vendor: a fresh copy of the same model
  beat another provider's verifier.
- **Then run one strong-model pass** over whatever code can't check.
- **Do not trust the prose.** A confident worker report is not evidence; verify what it rests on.

### Step 4b: escalate a cheap worker's task on checked evidence

- **Do not trigger on the worker's self-confidence.** On code no uncertainty score reached 0.70 AUC,
  and self-reports overstate success several-fold. Sampled scores do better but cost extra calls.
- **Split failures by kind.** Given the error, a cheap model fixes most compile and Python runtime
  errors, but few Java runtime errors and under 35% of logic errors. Retry it with the error at most
  twice (a heuristic), then escalate (or drop the issue) when a spec-derived test still fails. A green
  check is not proof: weak tests accept wrong patches (see
  [patch acceptance](../agent-evaluation/references/coding-agent-patch-acceptance.md)).
- **Do not route by an LLM's difficulty rating** (see Step 6).
- **Check the worker was alive.** A worker that died at launch in 1-5 s is an infrastructure fault;
  escalating fixes nothing.
- **Escalate with a fresh context** (spec, failing test or counterexample, short failure summary), never
  the failed transcript; agents overwrite already-correct code. (Inference; untested head to head.)
- **Track the escalation rate.** Cheap-first wins while cheap cost + escalated share x strong cost <
  strong cost (at a 20x price ratio and equal tokens, until about 95% escalate). Measure it: cheaper
  reasoning models can cost more, and one-way handoff can trail strong-only. **Cap the cascade at one
  level**: an adversary can push reroutes from ~10% to ~100%.

## Step 5: synthesize in the lead

- **Keep synthesis, trade-offs and any deep sequential sub-problem in the lead**, or give them to one
  strong subagent.
- **Do not add critique or deliberation layers**; they made every tested model worse at ~2-3x the tokens.
  Engineer the context instead. Use parallel proposers and one aggregator; skip debate rounds, voting
  and self-refinement.
- **Keep the lead's context thin.** Never paste raw worker dumps or whole files into it; read the
  workers' files for detail.

## Step 6: coding fleets: plan strong, gate on blind tests

Use when several issues are split across parallel implementers. Each rule has evidence, but the
sequence is **untested end to end**; treat it as a pilot. Per issue:

1. **The lead writes an acceptance spec**: observable behavior (inputs, outputs, error cases), nothing
   about implementation.
2. **A strong model writes the implementation plan** (files, approach, risks), handed over once at a
   clean boundary: the executor can finish without asking the planner anything. It beat a self-written
   plan, measured on an open 30B executor only.
3. **In parallel, one worktree per writer**: the implementer gets spec + plan; the test writer gets the
   spec only, never the plan or code (test-first caught 25% of faults vs 14%).
4. **Gate on the test writer's tests, validated by the lead before they can block.** Raw blind tests
   blocked correct programs in most units, and generated tests can lock bugs in (pass on buggy code,
   fail on the fix). On a failure, check the test against the spec, then send the implementer a
   counterexample. Retry only the failing issue: split work at run time, since a fixed up-front split
   re-runs dependent steps on every failure and raises retry cost.
5. **One commit per issue**, cherry-picked by the lead onto the batch branch; no refactorings tangled
   into a fix (lower odds of compiling and being correct). The lead makes shared edits (version bumps)
   and runs the full suite once. A strong model reviews each commit's diff alone; the batch review
   covers only the integration diff. Batching pays the fixed per-PR cost once.

- **Do not ask a model how hard an issue is.** An LLM router missed almost all hard steps; trained
  routers (per step or per request, not per issue) cut cost by about half at matched quality. Without
  one, send an issue to one strong agent outside the batch if it touches more than one module, has
  failed before, or has no clear spec.
- **Do not make an LLM review the only gate.** Reviewers caught at most 31% of human-flagged issues,
  fewer with more context; keep review context small.
- **Do not show builders other agents' answers.** Some models conform to peers and collapse (Claude
  held in one test); test yours before adding peer reviewers.
- **Do not prompt for multiple approaches**: several times the reasoning tokens, no success gain.

## Step 7: handoffs, infrastructure and budget tracking

- **Pass structured handoffs, validate them with code, and re-check prohibitions**; "do not"
  compliance decays over turns while status checks stay green.
- **Gate shared state at write time**: filter input before summarizing (cleaning the finished summary
  leaves toxic input in). For state several agents write, use a read-set version check (blocks most
  stale commits, but hurts single-shard collaborative writing).
- **Centralize retry and rate-limit control**; do not let each agent retry on its own against a shared
  limit.
- **No shared worktree for writers.** Assign each writer its own worktree and a disjoint file set before
  spawning (or forbid commands that change the working tree). Serialize shared files (global
  stylesheet, changelog, version file) or have the lead edit them. Forbid `git stash`, `checkout` and
  `restore` in the lead's tree. Prevent merge conflicts, and re-verify any LLM resolution as a new diff.
- **Launch synchronously.** A background fan-out lost all results when the host exited.
- **Measure, don't guess.** Sum `cache_creation`, `cache_read` and `output` per assistant message from
  subagent transcripts' `usage`, deduplicated by message id, and price it. Check the cache TTL: 1-hour
  writes bill above 5-minute writes (rates in `claude-api`).

Evidence: kb://agentic-capability-reports/notes/2026-11-13-haiku-swarm-vs-single-agent-at-10-dollars.md,
kb://agentic-capability-reports/notes/2026-11-13-spec-first-batch-pipeline-for-coding-agents.md,
kb://agentic-capability-reports/notes/2026-11-14-multi-agent-topology-equal-budget-and-failure-modes.md,
kb://agentic-capability-reports/notes/2026-11-14-escalation-signals-for-cheap-worker-to-strong-model.md
