---
name: agent-fleet-orchestration
group: design-analysis
description: >
  Decide whether, and how, to split a task across a fleet of subagents, and pick which models play lead
  and worker. Covers routing by task shape (broad and parallel vs deep and sequential), model-tier
  economics (a strong lead with cheap Haiku-class workers vs one strong agent vs a more capable agent
  alone), the brief template that keeps cheap workers honest, verifying results instead of voting on them,
  and budget control (the lead's own tokens usually cost more than the whole swarm). For coding fleets it
  also covers who writes the plan, why tests written blind to the code should gate a change, how to route
  issues by observable features, and how to review a batch. Use before spawning more than two subagents, when
  choosing models for a multi-agent run, when splitting several issues across parallel implementers and
  test writers, or when a spend cap is in play.
keywords: subagent fleet, swarm, fan-out, orchestrator, orchestrator-worker, lead agent, haiku workers, model tier, cost per task, spend cap, budget, cheap model, small model, multi-agent vs single agent, task shape, breadth vs depth, majority vote, correlated errors, verification, brief template, context isolation, prompt caching, coding fleet, batch PR, multi-issue PR, parallel implementers, test writer, test-first, spec-first, plan handoff, difficulty routing, diff-only review
related: parallel-subagent-experiments, adversarial-swarm-analysis, token-efficiency, automation-design, tdd-workflow, independent-merge-review
---

# Agent fleet orchestration

## The idea

A fleet of cheap agents is very good at *coverage* and bad at *depth*. When a task splits into
independent parts whose results can be checked, a strong lead that writes briefs and synthesizes the
results, with cheap workers doing the reading, buys far more coverage per dollar than any single agent.
When each step depends on the reasoning of the last, splitting the work loses context at every hand-off,
and one strong agent wins. Decide by the **shape of the task**, not by the model.

## Step 1: classify the task shape

Break the task into sub-questions, then ask two things: can they be answered independently, and can an
answer be checked without redoing the work?

| Shape | Examples | Use |
|---|---|---|
| Broad, parallel, checkable | literature or KB surveys, codebase audits, edits to many separate files, log or issue triage, extraction | Strong lead + cheap worker swarm |
| Deep, sequential, tightly coupled | a subtle bug, a design decision, a proof, a refactor across interlocking code | One strong agent; the most capable model only if the task is beyond the strong one |
| Mixed: explore, then build | most real engineering tasks | Swarm the exploration; the lead keeps the reasoning and the build |
| Judging, voting, review | "have N agents check it and take the majority" | One strong reviewer plus checks done by code. Do not vote. |

Evidence behind this table, from the local KB (`kb search` finds each note by its arXiv ID):

- Multi-agent gains depend on task structure. They are largest at the edge of what the sub-agents can do,
  vanish when the sub-agents are strong, and sequential depth tasks favor a single agent (2601.14652).
- Independent parallel agents found the most issues (64.2% vs 50.8% for a single agent), but the single
  agent was cheapest per validated finding, and a centralized multi-agent setup was worse on both cost and
  accuracy (2604.18718).
- In an *iterative* planner-executor loop on offensive-security CTF tasks, using the same model in both
  roles beat mixed-tier pairs: "model coherence is more critical than raw capability differences between
  roles" (2604.17159). Don't hand a tightly coupled task from a strong model to a cheap one halfway
  through. A *one-shot* written plan behaves differently: see "Coding fleets" below (2608.06113).
- Small models break down on long, branching workflows: open 4B models completed 55-78% of tasks vs
  96-97% for proprietary models (2605.19743).

## Step 2: price it

Per-token prices drift, so read current rates from the `claude-api` skill. As of late 2026, Haiku 5.5 was
about 20x cheaper per token than Sonnet 5.5 and 40x cheaper than Opus 5.5, and Haiku bills 5x above
100K-token prompts. One measured run gives a useful scale:

- 8 Haiku 5.5 research workers, each with one question (about 12 turns and 80-114K peak context each),
  together cost **about $0.21**: 6.66M input-side tokens, 91% of them cache reads.
- The same tokens priced as Sonnet or Opus subagents would have cost about $3.55 or $7.09.
- The **Opus lead** that briefed them and synthesized the results cost about $2.27 before writing the
  deliverable, roughly 11x the whole swarm. Much of that was fixed session context such as tool and skill
  docs, re-read every turn.

So with cheap workers, **budget the lead's tokens, not the worker count**. With expensive workers, the
reverse holds: local run lessons record fan-outs of Opus (or unspecified) deep agents (about 100-150K
tokens each) pushing a $10 cap to $14-18 before the deliverable existed. Cap the worker count at
`(budget - reserve) / per-worker estimate`, and hold a reserve for the final deliverable.

Choosing the lead: for broad tasks, a Sonnet lead costs about half as much as an Opus lead and is enough
when the synthesis is straightforward. Use an Opus lead when the synthesis or the build step is hard.

## Step 3: write every brief in one pass

Generate the whole plan in one step. MAS-Orchestra, which emits the full orchestration in one decision,
used 51 calls on AIME24 against 1,288 for the search-based AFlow baseline, at higher accuracy
(2601.14652). Write all the briefs in one message, spawn them in one batch, and give
each brief:

1. **One non-overlapping question.** Partition the work. Never give N workers the same question.
2. **Exact tool syntax**, tested once yourself before launch. Name flags that don't exist, and tell
   workers to skip commands that take write locks. Cheap workers waste turns guessing syntax.
3. **An output schema.** For research: claim | number | source ID | URI | verbatim quote.
4. **"Not found is a valid answer."** Without this line, cheap workers pad their reports.
5. **A sub-question that argues the other side** (failure modes, when the approach loses), so the
   synthesis isn't one-sided.
6. **A file to write results to**, so they survive and the lead can read detail rather than a summary.
7. **A size bound**: about 900 words. Keep worker prompts under the cheap tier's price threshold.

Keep the shared part of every brief byte-identical and put it first, so it stays cached. Stabilizing the
prefix raised the cache hit rate from 38.7% to 79.2%; the full system, which also evicts stale context,
cut cost from $7.24 to $2.79 (2606.17016).

## Step 4: verify; don't vote

- **Errors are correlated.** Nine judges from seven model families were worth about 2 independent votes
  (n_eff about 2.0-2.5), and the best single judge matched the panel (2605.29800). Models from the same
  family behave even more alike (2604.21255), so copies of one cheap model voting is close to worthless.
  Majority voting collapses outright when most agents are wrong (2604.17139).
- **Check with code first.** Grep every cited quote and number against its source; run the tests. In the
  measured run (see the seed report in the `agentic-capability-reports` KB), 64 of 64 spot-checked
  citations from the Haiku workers matched their sources. Note that a
  source can exist in more than one place: check every copy before you call a citation fabricated.
- **Give verifiers a fresh context.** A three-role scaffold whose corrector never saw the conversation
  history roughly doubled a small agent's score (5.4% to 8.9%), and in the ablation the corrector alone
  captured most of that gain (2604.11465). A final QA-and-fix stage reduced damage from a
  sabotaged pipeline stage from 53.7 points to 0.6 or less (2606.12709). On three small Python
  services with seeded faults, a verifier that never saw the builder's artifacts beat the builder's own
  tests (sign test: 11 discordant fault comparisons favored it vs 1, p=0.006), and a fresh context of
  the *same* model beat a verifier from another provider (13 vs 0, p=0.0005). Independence of context
  mattered more than vendor (2610.28667).
- **Then one strong-model pass** over whatever code can't check.

## Step 5: synthesize in the lead

Synthesis, trade-offs, and any deep sequential sub-problem stay with the lead, or go to one strong
subagent. Don't add critique or deliberation layers to a hierarchy. In one study that made results worse
for all six models tested (up to 3.37x worse, using 1.8-2.7x more tokens), while engineering what went into
the context improved them by up to 76% (2605.16205).

## Coding fleets: plan strong, gate on blind tests

Use this when several coding issues are split across parallel implementers. Each rule below has its own
evidence, but the sequence as a whole has **not been tested end to end**: no study measures its net
savings over one strong agent per issue. Treat it as a pilot design.

**Sequence, per issue:**

1. The lead writes an **acceptance spec**: the observable behavior that must hold when the issue is
   done (inputs, outputs, error cases). It says nothing about how to implement it.
2. A strong model writes an **implementation plan** from the spec and the relevant code: files to
   change, approach, risks.
3. In parallel and in separate worktrees: an **implementer** gets the spec and the plan; a **test
   writer** gets the spec only, never the plan or the code.
4. The gate is running the test writer's tests against the implementation. On a failure the lead first
   checks the failing test against the spec, then sends a counterexample back to the implementer.
5. The lead cherry-picks one commit per issue onto the batch branch and makes shared edits such as
   version bumps itself. Then the full suite runs once. A strong model reviews each commit's diff on its
   own; the batch review covers only the integration diff.

**Rules and their evidence:**

- **Try spending the strong model on a written plan, handed over once.** On SWE-bench Verified, a
  plan written by Claude Sonnet 4.5 raised a Qwen3-Coder-30B executor from 42.8% to 57.8% Pass@1; a
  self-written plan reached 48.2% (2608.06113). This looks like it contradicts the mixed-tier result in
  Step 1 (2604.17159), but the studies differ in domain, models and hand-off shape. Our reading,
  untested: one written plan at a clean boundary helps, and mixing tiers inside an iterative loop
  hurts. A boundary is clean when the executor can finish from the spec and plan without asking the
  planner anything. The executor was an open 30B model, so applying this to Claude tiers is a transfer.
- **Gate on tests written from the spec, not from the code.** On function-level Python benchmarks
  (HumanEval+, MBPP, BigCodeBench), test-first generation detected 25% of faults vs 14% for
  code-first (2607.05139). See Step 4 for the fresh-context verifier evidence (2610.28667).
- **Have the lead validate those tests before they can block.** Raw independent tests blocked correct
  programs in 14/15 units, and in 2/15 once only valid tests were used (2610.28667). Generated
  regression tests can also lock bugs in: 8.4%-16.9% were *fault-enforcing* (they pass on the buggy
  code and fail on the fix) vs 2.4%-4.8% *fault-revealing* (they fail on the buggy code) (2610.11835).
- **Don't ask a model how hard an issue is.** Opus 4.6, used as a router, rated only 7 of 147
  verified-hard SWE-bench steps as "high" and failed all 40 trajectories it routed (2605.18859). A
  learned router choosing the cheapest capable model per request matched always-Sonnet-4.6 quality at
  54.1% lower cost (2605.17106). Both papers route per step or per request, not per issue. Without a
  trained router, our suggestion is to use observable features: send an issue to one strong agent
  outside the batch if it touches more than one module, has failed before, or has no clear spec.
- **Keep review context small.** No model detected more than 31% of human-flagged review issues even
  when given only the diff, and all 8 models tested got worse as context grew from diff-only to full context
  (2603.26130). So reviewing each issue's commit diff on its own, plus the small integration diff, is our judgment rather
  than a tested result. The executable tests carry the gate; the review is a second check, not the gate.
- **One worktree per writer, one commit per issue.** Agent patches that tangled refactorings into an
  issue fix were associated with lower odds of compiling (odds ratio 0.42, Java patches from
  Multi-SWE-bench), and method-level refactorings with lower odds of being correct (odds ratio 0.22)
  (2605.22526). Splitting work by issue and by file is our inference from that. Batching pays the fixed
  per-PR cost (pre-push suite, review, rebase) once instead of N times; no paper measures how much.
- **Retry only the failing issue.** In a simulation of schema-validation failures (gpt-4, 10 runs), a
  fixed up-front task split raised retry cost by up to 80.5% over a single monolithic run, because a
  failure re-ran its dependent steps. A split that branches at run time, re-running only what failed,
  cut retry cost by up to 51.7% (2605.15425). Capping retries at two before escalating or dropping the
  issue is a heuristic, not a measured value.
- **Don't show builders other agents' answers.** When given simulated peer agents' positions,
  GPT-5.4's SWE-bench accuracy fell from 1.00 to 0.23 at swarm size 2: it conformed to the peers.
  Claude Sonnet 4.6 held 100% (2605.10698). The measured risk is for non-Claude builders, but a builder
  needs only its spec and plan anyway.
- **Don't prompt for multiple approaches.** It raised reasoning tokens 2.4-7.4x with no success gain
  (96.5% vs 95.2%) (2608.01347).

## Infrastructure that matters

- **Central retry and rate-limit control** for concurrent agents cut failures from 72-100% to 0-18%
  (2604.17111). Don't let each agent retry on its own against a shared limit.
- **No shared worktree for writers.** Parallel agents in one git worktree destroy each other's
  uncommitted edits. Give each its own worktree, or forbid commands that change the working tree.
- **Measure, don't guess.** Subagent transcripts record per-message `usage`. Sum `cache_creation`,
  `cache_read` and `output` per assistant message, deduplicated by message id, and price the result.
  Check the cache TTL: 1-hour writes bill at 2x, 5-minute writes at 1.25x.

## Anti-patterns

- **Swarming a depth task.** If each step needs the last step's reasoning, the hand-offs cost more than
  the parallelism saves.
- **Voting with clones.** N copies of one model voting on one question adds cost without independence.
- **Fat lead context.** Pasting raw worker dumps or whole files into the lead is where the money goes.
  Have workers write files and return summaries.
- **Mixed tiers mid-task.** In an iterative planner-executor loop, a strong planner paired with a cheap
  executor underperforms the same model doing both. A one-shot written plan handed over at an issue
  boundary may be a different case, though that is untested (see "Coding fleets").
- **An LLM review as the only gate on code.** LLM reviewers caught at most 31% of human-flagged issues,
  and fewer with more context. Make executable, spec-derived tests the gate; the review checks what the
  tests can't.
- **No reserve.** Fanning out before reserving budget for the final deliverable leaves the run with
  spent money and nothing published.
- **Trusting the prose.** A confident worker report is not evidence. Verify the citations it rests on.

## Gaps in the evidence

The papers above test GPT-5, Claude 4.5, Gemini 3, Qwen and Llama models, and none states a small-to-large
price ratio. No paper in the KB compares one strong model against a fleet at the same total token
budget. Treat the Claude 5 cost figures as one measured run, and the quality claims as transfers from
other model families.

For coding fleets, no KB note measures defect escape against PR size or issue count, CI and rebase cost
amortized across a batch, merge-conflict rates for parallel agents, or a controlled planner and executor
size split on coding tasks. The next step is a pilot of about 5 small issues run both ways (batched
pipeline vs one strong agent per issue), comparing cost, wall-clock time, reviewer blocks and post-merge
defects. Source report: `spec-first-batch-pipeline-for-coding-agents` in the `agentic-capability-reports` KB.
