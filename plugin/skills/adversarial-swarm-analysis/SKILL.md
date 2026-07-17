---
name: adversarial-swarm-analysis
description: Analyze an open question by casting 3-5 deliberately conflicting expert roles, running them in parallel and blind to each other, sharpening them in a debate round, attacking their consensus with a devil's advocate, then synthesizing a verdict that preserves disagreement instead of averaging it. Use for decisions, strategy, idea generation, hypothesis triage, experiment post-mortems, or any question where a single lens would return "it depends".
keywords: swarm, debate, devil's advocate, multi-agent analysis, decision, should we, tradeoff, pros and cons, stress test, red team, second opinion, brainstorm, strategy, hypotheses, post-mortem, judgment call
related: rfc-iterative-review, requirements-engineering, placement-picker
---

# Adversarial Swarm Analysis

A template for questions where the answer depends on which lens you look through. One agent asked "should we kill the free tier?" returns a balanced non-answer. A swarm of agents with *conflicting interests*, each forbidden from being balanced, returns a spectrum — and the shape of their disagreement is the actual finding.

The workflow is domain-agnostic. Only the roles change between "should we ship this pricing change", "why is this test flaky", "which of these five ideas is worth building", and "what did this experiment actually show".

## When to Use

Use it when the question is **open, consequential, and lens-dependent**:

- A decision with real tradeoffs (pricing, architecture, hiring, go/no-go).
- Idea generation where you want range, not the first obvious answer.
- Strategy evaluation (a trading rule, a launch plan, a migration approach).
- Troubleshooting where the cause is genuinely unknown and competing hypotheses deserve independent champions.
- Reflecting on an experiment or incident where the interpretation is contested.
- Any moment you catch yourself writing "it depends on…" — that is the swarm's cue.

## When NOT to Use

- **The question has a lookup answer.** "What port does the server bind to?" needs a grep, not a swarm.
- **The work is mechanical.** Renames, migrations, test fixes — use `implementer` agents or do it yourself.
- **The domain already has a specialist workflow.** For RFCs and design docs, use `rfc-iterative-review` — it is this pattern already specialized: the roles were made permanent (a fixed critic roster), the loop revises a document between rounds instead of debating, and Phase 4 appears there as a bounded, run-once consensus attack at convergence. Don't reinvent it here.
- **You already know the answer and want validation.** The swarm will give you a manufactured fight. Ask directly instead.
- **The user needs a decision in seconds.** A swarm is 3-11 subagent calls depending on tier. Say what it would cost and offer it; don't spend it unasked.

## The Three Invariants

Everything below is negotiable except these. Break one and you get theater made of agents.

1. **Roles must conflict, not complement.** "Marketer, SMM specialist, content manager" is one role wearing three hats — their interests coincide, so their answers converge. Real value comes from opposed interests: growth vs. sustainability, speed vs. correctness, revenue now vs. trust later, the person who owns the upside vs. the person who gets paged at 3am.
2. **Experts must not see each other — until every first opinion is in.** The moment one expert reads another's conclusion, it starts adjusting. Independence is not a nice-to-have, it is the mechanism. Launching all experts in a single message — parallel, blind — buys it for free. The debate round (Phase 3) deliberately lifts this *after* the independent pass has been banked, and runs parallel too so nobody conforms in real time; what the invariant forbids is contaminating the first opinion.
3. **The merge preserves conflict.** A bad synthesis flattens five sharp opinions into "on one hand, on the other hand". A good one says: *here everyone agreed despite opposed incentives (strong signal); here two experts contradict flatly, and here is what each side costs.* Conflict is the most valuable output — it marks where the decision is genuinely risky rather than where everyone nodded along.

## Phase 0 — Frame the Question

Before casting anyone, write one sentence stating the decision or question, in a form an expert could take a position on. "Think about our pricing" is not analyzable. "Should we remove the free tier and go fully paid with a 14-day trial?" is.

If the question is compound ("should we do X, and if so how?"), split it and swarm the first part only. Experts asked two questions answer neither.

State any hard constraints (budget, deadline, non-negotiables) in the frame — every expert will receive it verbatim, and constraints keep the swarm from re-litigating settled ground.

## Phase 1 — Cast Conflicting Roles (you, the orchestrator)

**You do not analyze.** Your job in this phase is casting. Analyzing here contaminates the merge later, because you will have picked a side before hearing anyone.

Generate **3-5 roles for this specific question** — do not reach for a stock roster. For each role, write:

- **Name** — the lens, e.g. "Growth-obsessed investor", "On-call SRE", "Churned free user".
- **Focus** — the one thing it fixates on.
- **Bias** — what it systematically overrates. Name it explicitly; the expert is told to lean into it, not correct for it.

Check the cast before launching: **for every role, name the role whose interests it directly opposes.** If any role has no opponent, it is padding — replace it. Three genuinely opposed roles beat five that agree.

### Casting a predefined specialist instead

When a lens matches a specialist agent that already exists, use the specialist rather than a generated role — it carries a sharper prompt than you'd write inline. From the toolkit: `kookr-toolkit:failure-mode-analyst` (risk and hidden assumptions), `kookr-toolkit:design-minimalist` (YAGNI, accidental complexity), `kookr-toolkit:ambition-amplifier` (scope capped to dodge the hard part — a natural adversary to the minimalist), `kookr-toolkit:socratic-challenger` (probing questions), `kookr-toolkit:delivery-pragmatist` (sequencing and blast radius), `kookr-toolkit:operability-reviewer` (runtime truth). Mix freely: a swarm of two generated roles plus two specialists is normal. Everything else runs on `general-purpose` with a role prompt.

## Phase 2 — Run the Experts (parallel, blind)

Launch every expert **in one message, multiple Agent calls**, so they run concurrently and cannot see each other. Give each the identical question frame plus its own role.

Each expert's prompt should say, in your own words:

> You are an expert with the role **{name}**. Your focus is {focus}. Your bias is {bias} — do not fight it; it is your value here.
>
> Analyze the question strictly from your position. **Do not be balanced. Do not account for other viewpoints** — other experts are doing that, in parallel, right now. Your job is to push your angle to its limit.
>
> Return: (1) your verdict from your position — for / against / conditional; (2) two to three arguments from *your angle specifically*, not generic ones; (3) the one risk most visible from where you stand that others will miss. Short and hard, no hedging, no fluff. Your reply is data for a synthesizer, not a message to a human.

Forbidding balance is the counterintuitive move that makes this work. Five experts each trying to see all sides produce five identical cautious paragraphs. Five experts each pushing one angle produce a real spectrum.

**Ground the experts when grounding is possible.** In a codebase, tell them which files to read and require that claims cite evidence. For market or product questions, tell them to search rather than recall. An unfalsifiable swarm is confident and useless; the bias license covers *emphasis and priorities*, never invented facts.

## Phase 3 — Debate Round (optional — off by default, on for the Full tier)

Show each expert a digest of what the others said and let it respond — again all in parallel, so nobody conforms in real time.

> You are **{name}**, in round two. Your original position: {their opinion}. You now see the other experts' opinions.
>
> Do not cave under pressure, and do not ignore a strong argument either. Return: where an opponent's argument genuinely lands against you (concede it honestly); where you hold your line and why their objection is weak; whether your verdict changed and how. This is a reaction to opponents, not a restatement.

Weak arguments fall away here and strong ones harden. The post-debate positions are what go to the merge **and to the advocate in Phase 4** — the advocate must attack the agreement that actually survived the debate, not the pre-debate opinions, or it will attack a consensus that no longer exists.

The round doubles expert cost, so **run it for consequential, hard-to-reverse questions** (the Full tier under Scaling the Cost) and skip it otherwise. Skip it too when the first pass already produced flat, unambiguous contradiction — the conflict is the finding, and sharpening it costs a round and changes nothing.

## Phase 4 — Devil's Advocate Attacks the Consensus

The quiet danger is **fake agreement**: experts converge not because the answer is good but because they all inherited the same blind spot. It reads as confidence, which makes it more dangerous than open conflict.

So one agent — running after the experts (post-debate, if Phase 3 ran), before the merge — is obligated to find the crack. Use `general-purpose` with this brief. Do **not** reach for `kookr-toolkit:failure-mode-analyst` here: its definition mandates an output ending in `Risk Rating` and `Recommendation: [Proceed with caution/Revise/Block]`, which has no slot for "consensus survives" — it must fill the form, so it manufactures the concern this step exists not to manufacture.

> You are the devil's advocate. Here are the swarm's opinions. Your only job is to attack their agreement.
>
> If they converged, find why they might **all be wrong at once**: a shared assumption nobody checked, a scenario nobody raised because it was inconvenient. Return: the most dangerous shared assumption; a concrete scenario where the swarm's unanimous view is fatally wrong; the one question the group carefully avoided. Do not be polite — your value is saying what the group does not want to hear.
>
> If the experts genuinely disagree, say so plainly and name the sharpest unresolved conflict instead of manufacturing one. If they agreed and the agreement looks sound, say **that** — "the consensus survives, no shared blind spot found" is a legitimate and complete answer. Do not invent a concern to justify the call.

This is one call, and it runs once. It structurally breaks groupthink: consensus now has to *survive an attack* rather than merely occur. Its output enters the synthesis as another voice, not as the verdict — the merge weighs it like any expert and is free to reject it.

The null verdict matters because the advocate is *obligated* to attack, so it will tend to produce an attack whether or not one exists. Here that only costs a weak input the merge can discard. In a workflow with a loop — where a finding could trigger another round — an unbounded advocate can defer convergence forever; see `rfc-iterative-review` for how that gets bounded.

## Phase 5 — Merge (you, the orchestrator)

You synthesize — you hold the full context and have to report to the user anyway. Delegate the merge to a fresh `general-purpose` agent only when the opinions are too large to hold comfortably; hand it the frame plus the full opinion set.

Synthesis is not averaging. Produce:

1. **Agreement** — what experts with *opposed incentives* still agreed on. The most reliable signal you have. Lead with it.
2. **Conflict** — where they contradict directly. Name each conflict explicitly and say **what each side costs**. Do not smooth it over.
3. **Blind spots** — a risk only one expert (or the advocate) named, that survives scrutiny anyway.
4. **The advocate's attack** — did the consensus survive it? Say so either way.
5. **Verdict** — for / against / conditional, plus **what would change it**. A verdict with no falsifier is an opinion.

Write densely. Keep disagreement as information; suppressing it destroys the thing you paid a swarm to find.

The prompt-level discipline here does the job that a low temperature does in a raw-API implementation: the experts were told to be extreme, and the synthesizer is told to be sober and evidence-bound. Do not import their rhetorical heat into the verdict.

## Phase 6 — Report

Give the user the merge, not the transcript. Lead with the verdict, then the conflicts and what each side costs, then agreement, then the surviving blind spots. Say how many experts ran and what lenses they held, so the user can spot a lens you failed to cast — that is the most common real defect, and only they can see it.

Offer the raw expert opinions; don't dump them unasked.

## Adapting to a Domain

The phases never change. The casting does — and a bad cast is a wasted swarm.

| Task | Roles that genuinely conflict |
|------|-------------------------------|
| Product / pricing decision | Growth investor · on-call engineer · churn-risk existing user · support lead who eats the tickets |
| Trading or bidding strategy | Return-maximizer · risk manager who gets blown up by the tail · execution-cost realist · regime-change skeptic |
| Idea generation | Ambitious visionary · shipping-next-month pragmatist · the user who has to change their habits · the competitor who copies it in a week |
| Bug troubleshooting | One champion per rival hypothesis (each argues *its* cause is the real one), plus a "the repro is lying" skeptic |
| Experiment reflection | Champion of the hypothesis · statistical skeptic · confound-hunter · "we measured the wrong thing" critic |
| Architecture / tech choice | `design-minimalist` · `ambition-amplifier` · `operability-reviewer` · `delivery-pragmatist` (specialists; qualify with `kookr-toolkit:`) |

For troubleshooting specifically, one champion per hypothesis is the highest-value cast in this table: it stops the swarm from converging on the first plausible cause and forces each candidate to be argued at full strength before you compare them. The 3-5 bound still holds — cap it at four champions plus the skeptic. With more candidate causes than that, cut the weakest hypotheses before casting rather than growing the swarm.

## Scaling the Cost

Count it as: experts (3-5), doubled if the debate round runs, plus one for the advocate. That spans 3 to 11 calls. Three tiers:

- **Cheap — 3 calls:** three experts, no debate, no advocate. A quick second opinion.
- **Default — 5 calls:** four experts, no debate, advocate on. Most decisions.
- **Full — 11 calls:** five experts, debate round, advocate. Consequential and irreversible.

Scale to the stakes, not to the excitement. And when the user's question is a one-liner, ask before spending eleven agents on it.

## Anti-Patterns

- **Complementary roles.** The most common failure. Roles that share interests give you one opinion at five times the price. Apply the opponent test.
- **Analyzing while orchestrating.** If you form a verdict in Phase 1, the merge becomes you defending it. Cast, then listen.
- **Leaking opinions into the first pass.** Sequential launches in Phase 2, or pasting expert A's take into expert B's opening prompt, destroy the independence the whole design rests on. One message, parallel calls. (Phase 3 shares opinions on purpose — but only once every independent first opinion is banked.)
- **Averaging at the merge.** "There are pros and cons, it depends on your priorities" — this is the single-agent answer you ran a swarm to avoid.
- **A devil's advocate that pulls its punches.** Its assignment is to attack, not to write a balanced assessment — an advocate that softens the strongest version of its objection to sound agreeable has wasted the call. This is about effort, not verdict: "the consensus survives" after a genuine attack is a real result (see Phase 4). What fails the job is not attacking.
- **Manufacturing a fight over a lookup.** Some questions have answers. Check that yours doesn't before casting.
- **Ungrounded confidence.** Bias licenses emphasis, not fabrication. Where facts are checkable, require the experts to check them.
- **Reporting the transcript.** Nine agents' raw output is not a finding. The synthesis is the deliverable.
