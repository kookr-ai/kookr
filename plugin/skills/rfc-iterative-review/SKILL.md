---
name: rfc-iterative-review
description: Iterative RFC drafting workflow — draft in worktree, run parallel critic subagents, incorporate feedback over N rounds, present to user before any action
keywords: rfc, design document, proposal, design exploration, architecture decision, write rfc, draft rfc, generate rfc, create rfc, design doc
related: spawn-child-task, kookr-playbooks, requirements-engineering, adversarial-swarm-analysis
---

# RFC Iterative Review Workflow

When a task involves generating an RFC or design document, follow this workflow. Do not skip to implementation — the user reviews the final document before anything is committed or built.

## When to Use

- You are asked to write, draft, or generate an RFC
- You are asked to create a design document or proposal
- A Kookr task prompt mentions RFC generation
- You are exploring a design space and need to produce a structured recommendation

## Phase 1 — Setup and Draft

### Worktree

If not already in a worktree, create one before writing anything:

```bash
git worktree add ../kookr-rfc-<slug> -b rfc/<slug> main
```

### Draft the RFC

Write the initial draft at `docs/rfc/rfc-<slug>.md` following the project's existing RFC format:

```markdown
# RFC: <Title>

**Status:** Draft
**Date:** <today>
**Author:** Jean Ibarz (with Claude)

---

## Problem
## Requirements
## Design
## Files to change
## Edge cases
## Alternatives considered
```

Study existing RFCs in `docs/rfc/` for tone, depth, and structure. Match them — don't invent a new format.

## Phase 2 — Iterative Critic Review

Run **3 review rounds** by default (the task prompt may specify a different number).

### Shared evidence pack (assemble once, before the panel)

Before launching the first critic panel, assemble a **shared evidence pack** and reuse it across every round. Without it, each critic independently rebuilds the same mental model of the codebase (re-reading the same files, re-running the same probes) — in one real session that redundant re-exploration, not the critique, is what drove each critic to $10–15 and the panel to the majority of the run's cost.

**What the pack contains** (assemble from the orchestrator's own pre-panel investigation — the same pipeline map + telemetry work you already do before the panel; do not spawn extra investigators just to fill it):

1. **Pipeline map** — the relevant modules/files, their responsibilities, and how they connect for the area the RFC touches. A critic should be able to orient from this instead of re-deriving it.
2. **Telemetry / evidence findings** — concrete measurements, log excerpts, cost/latency numbers, or reproduction notes gathered before the panel.
3. **Source pointers** — file paths and line ranges for the load-bearing claims, so a critic who wants to re-verify can jump straight to the source.

**How to deliver it:** paste the pack (or a link to a written pack file, e.g. `docs/rfc/rfc-<slug>-evidence.md`) into **every** critic's prompt via the subagent prompt template below. The pack is assembled once and shared verbatim so all critics reason from one evidence set.

**The pack is "evidence to check," not settled facts.** Every item in the pack — a pipeline map, a telemetry claim, an investigator's summary — can be **wrong**, and a critic independently re-deriving it is exactly how that gets caught. The pack is a **floor, not a ceiling**: it saves critics the cold-start re-exploration, but critics stay free (and are encouraged) to re-read source and re-verify any pack claim. See "Preserving redundancy" below — the cap limits *breadth*, never *depth*.

### Each round

Launch the following subagents **in parallel** using the Agent tool. Select critics through the **Panel Selection Gate** below (3–5, hard max 5), picking the ones most relevant to the RFC's topic.

> **Invocation note:** The agent names below appear unqualified for readability. When calling `Agent({ subagent_type: "..." })`, prepend `kookr-toolkit:` to every name (e.g., `kookr-toolkit:boundary-critic`). Unqualified `subagent_type` does not resolve for plugin-namespaced agents.

| Subagent | When to include |
|----------|----------------|
| `boundary-critic` | Always — checks responsibility segregation, coupling, dependency direction |
| `failure-mode-analyst` | Always — finds hidden assumptions, edge cases, what could go wrong |
| `design-minimalist` | Always — catches over-abstraction, YAGNI violations, accidental complexity |
| `socratic-challenger` | Always — exposes gaps through probing questions |
| `ambition-amplifier` | Rounds 1-2 only, paired with `design-minimalist` (counterweight). Skip after round 3 unless the latest revision adds new "deferred" or "future work" items. |
| `assumption-archaeologist` | When the RFC proposes changes to behavior originally justified by an ADR's reasoning. Skip for UI polish, documentation-only RFCs, or organizational changes — the agent will respond "Out of scope". |
| `operability-reviewer` | When the RFC affects runtime behavior, monitoring, recovery |
| `delivery-pragmatist` | When the RFC involves migration, phased rollout, or risky sequencing |
| `module-interface-auditor` | When the RFC defines new module boundaries or public APIs |
| `state-machine-verifier` | When the RFC involves state transitions or workflow steps |

### Panel Selection Gate (checked — do not skip)

Before launching a round's panel, run this gate. It converts the old prose rule ("3–5, hard max 5") into a checked constraint — the count is an assertion, not a suggestion that gets exceeded in practice.

1. **List** the critics you intend to launch this round (by name).
2. **Count** them → `N`.
3. **Assert `N ≤ 5`.** This is a hard cap on the number of distinct critic lenses per round. `design-experimenter` invoked via the post-round-1 empirical checkpoint or the `assumption-archaeologist` hand-off is a verification step, **not** a panel lens — it does not count against `N`.
4. **If `N ≤ 5`:** proceed. Aim for 3–5; more critics is not better — it is diminishing returns and multiplied cost past 4–5.
5. **If `N > 5`:** **stop.** You may not launch more than 5 unless you record an explicit justification. Write, in the RFC's "Critic feedback incorporated" section, a line of the form:

   `Panel cap override — round <n>: launched <N> critics because <specific reason this RFC needs this lens breadth>. Justification: <why 5 is insufficient here>.`

   Without that recorded line, cut the panel back to 5. The override is a deliberate, logged exception — not the default.

**The cap limits breadth, not depth.** `N` counts *distinct lenses in a round*. It never limits a single critic from re-reading source or re-verifying a suspicious pack claim, and it never suppresses the mandatory post-round-1 empirical check. See "Preserving redundancy" below.

### Adversarial pair: `ambition-amplifier` + `design-minimalist`

The two are deliberately paired adversaries — one pulls toward bigger scope, one pulls toward less code. When both produce conflicting verdicts on the same scope, the author writes one sentence in the RFC's "Critic feedback incorporated" section naming which they agreed with and why. The choice is not optional — leaving it implicit means the contradiction was rationalized rather than resolved.

This is a reminder, not a gate. No automated check fires if the sentence is missing. A future RFC may convert this to a hook (per CLAUDE.md Persistence Mechanism Picker, hooks > documentation).

### Hand-off: `assumption-archaeologist` → `design-experimenter`

If `assumption-archaeologist` reports any `unverified` assumptions, invoke `design-experimenter` on those rows as the next step — `unverified` means the assumption is load-bearing but no evidence has been checked. This hand-off is encoded as an orchestration rule, not as an output cell, so callers cannot miss it by skipping the agent's "Notes" section.

### Invocation log (manual)

After invoking `ambition-amplifier` or `assumption-archaeologist`, add a one-line entry to the RFC's "Critic feedback incorporated" section: `<agent-name> <date>: <novel finding | no novel finding | out-of-scope>`. The line is the sole record. If invocation entries stop appearing across 90 days, the agent has been retired by disuse — that is the retirement signal.

### After round 1 — Empirical validation checkpoint (MANDATORY)

Before launching round 2, scan round-1 findings for **load-bearing empirical claims** — anything of the form "X works", "Y survives Z", "feature F is available on platform P", "under condition C the system does D". If any exist, invoke the `design-experimenter` subagent to run real probes against them.

**Why this is mandatory, not optional:** without it, round 2 re-debates the same hypothetical concerns round 1 raised, critics escalate theoretical edge cases, and the RFC grows to accommodate risks that a 10-minute experiment could have falsified. Empirical grounding between rounds converts speculation into evidence and prevents the review cycle from drifting into analysis paralysis.

**This checkpoint is intentional redundancy — keep it.** The shared evidence pack makes critics *efficient* (no cold-start re-exploration), but the pack can be wrong. This checkpoint is the redundancy that *falsifies* wrong load-bearing claims — including claims that originated in the pack itself. It is the depth counterpart to the breadth-limiting Panel Selection Gate: the cap trims how many lenses run per round, this check preserves the deep second look that catches wrong information. Do not trim it as "duplication" of the pack or of round-1 critique — the whole point is that an independent empirical probe can contradict both.

**When to skip the checkpoint:**
- Round 1 produced no empirical claims — all findings were definitional, stylistic, or structural.
- All empirical claims require platforms/tools unavailable (e.g., macOS runner needed but only Linux present); in this case, note the gap explicitly in the RFC's Open Questions section.

**Invoking:** launch `design-experimenter` with a prompt that lists the specific claims to probe, the RFC path, and a time budget (default 4 hours). Record its verdict in the RFC's "Critic feedback incorporated" section and edit the RFC text per its recommendations before round 2 begins.

Converge early (skip further critic rounds) if empirical probes have falsified the load-bearing claims — the correct response is to restructure the RFC around reality, not to iterate further on a design whose premise is broken.

**Subagent prompt template:**

> Review the following RFC document for [agent's focus area]. The document is at `<path-to-rfc>`. Read it completely, then provide specific, actionable feedback. Focus on substantive issues — not formatting or style. For each finding, state: (1) what the issue is, (2) why it matters, (3) a concrete suggestion.
>
> **Shared evidence pack (evidence to check — NOT settled fact):** the following pipeline map and telemetry findings were gathered before this panel so you don't have to rebuild them from scratch:
>
> ```
> <paste the shared evidence pack here — pipeline map, telemetry/measurements, source pointers>
> ```
>
> Treat every item above as a claim to verify, not a given. If any of it is load-bearing for your review, re-read the cited source and confirm it — the pack can be wrong, and catching that is part of your job. Do not, however, re-explore the whole codebase just to reconstruct what the pack already gives you.

### Preserving redundancy (breadth vs depth)

The efficiency measures above (shared pack, panel cap) cut *wasteful* redundancy — many critics re-deriving the same map — without cutting the *useful* redundancy that catches wrong information. Hold these four lines firm:

- **The pack is a floor, not a ceiling.** It labels its contents "evidence to check." Critics stay free to re-read source and independently re-verify any claim; independent re-derivation is how a wrong pipeline map or a bad telemetry number gets caught.
- **The cap limits breadth, not depth.** It bounds *distinct lenses per round*, never a single critic's re-verification of a suspicious claim. A warranted second look is depth, and the cap must never suppress it.
- **The post-round-1 empirical check stays mandatory.** It is the deep, independent falsification step for load-bearing claims (see above). It is not "duplication" of the pack or of round-1 critique — keep it.
- **The consensus attack at convergence stays.** It is the one step that can catch a blind spot *shared by the whole panel and the pack* — the failure no additional lens and no extra round can reach, because it lives in the framing they all inherit. It is bounded to one run and cannot reopen the review (see below), so it is not a paralysis risk. Do not trim it as duplication of the critics.

### After each round

1. **Triage feedback** — categorize each finding as: incorporate, reject with reason, or defer
2. **Edit the RFC** — apply incorporated feedback directly to the document
3. **Add a revision note** — at the bottom of the RFC or in the Status line (e.g., `Draft (v2 — post-review revision)`)
4. **Intent preservation check** — before deciding whether to continue, re-read the original user ask, the RFC's Non-Goals, and its Alternatives considered section. Identify any explicit user motivation, constraint, or rejected alternative that is load-bearing. Verify the post-critic design still honors each one. If critic feedback would pivot away from one, the next revision must present that pivot as an explicit tradeoff/choice, not as the silent recommendation. If the original ask has no load-bearing motivation or rejected alternative, record this as a no-op: `Intent preservation check: no load-bearing motivation.`
5. **Early convergence** — if a round produces no substantive findings (only minor or already-addressed items), you may stop iterating early. Note this in your summary.
6. **Before leaving Phase 2 — run the consensus attack** (below) **once**. This step is unconditional: it fires on *every* exit from the review loop, whether you converged early, exhausted the scheduled rounds, or stopped because probes falsified the premise. Do not treat it as a rider on early convergence — a last round that produced findings still exits through here.

### What counts as substantive

- Missing edge cases or failure modes
- Architectural concerns (coupling, boundary violations, layering)
- Unnecessary complexity that can be removed
- Gaps in requirements or design that would block implementation
- Contradictions between sections

### What to reject

- Style preferences that don't affect correctness
- Suggestions to add features beyond the RFC's scope
- Generic advice that doesn't apply to this specific design
- Redundant points already covered in the document

### At convergence — one consensus attack (runs ONCE per RFC)

Every critic reads the same document and the same evidence pack, so every critic inherits the same framing. An assumption the RFC asserts as given is invisible to all of them at once — and that is exactly what a quiet round looks like from the inside. "No substantive findings" is therefore ambiguous: it means either the draft is sound, or the panel shares a blind spot. This step disambiguates. More rounds of the same panel cannot: they reproduce the blind spot, because it is in the framing rather than in any one lens.

Launch **one** `general-purpose` agent against the *panel's agreement*, not against the RFC:

> Here is the RFC at `<path>`, the shared evidence pack, and the findings from `<N>` rounds of critic review. The panel has converged. Your job is not to review the RFC — it is to attack their agreement.
>
> Find the assumption this RFC (or its evidence pack) asserts as given that no critic questioned, because it sat in the framing rather than in the argument. Return: (1) the shared assumption most likely to be load-bearing and wrong, (2) a concrete scenario in which the converged design fails because of it, (3) the question the review carefully avoided.
>
> If you find no shared blind spot and the convergence looks sound, **say exactly that**. "The consensus survives — no shared blind spot found" is a legitimate, expected result and a complete answer. Do not manufacture a concern to justify the call.

This is **depth, not breadth**: like the post-round-1 empirical check and the `assumption-archaeologist` hand-off, it is a verification step, **not** a panel lens — it does not count against `N` in the Panel Selection Gate.

**Use `general-purpose`, not `kookr-toolkit:failure-mode-analyst`.** The tempting choice is wrong: that agent's definition mandates an output format ending in `Risk Rating: [Critical/High/Medium/Low]` and `Recommendation: [Proceed with caution/Revise/Block]`, and instructs it to "assume anything not proven is wrong". There is no slot in that template for "consensus survives" — so it must fill the form, which manufactures the concern this step exists *not* to manufacture, and burns the single permitted revision on it. The null verdict has to be expressible, so the advocate needs a prompt that permits it.

### Bounds on the attack — do not remove these

The advocate is *obligated* to look for a crack, so it will tend to produce one whether or not one exists. Left unbounded it can defer convergence forever — the analysis-paralysis failure the empirical checkpoint already exists to prevent. Three bounds keep it terminal:

1. **It runs at most once per RFC** — at the first convergence, not at every convergence. The first attack carries nearly all the value; a second is where the paralysis lives.
2. **Its output never triggers another round.** Triage it exactly like any other finding — incorporate, reject with reason, or defer — for at most one revision. Worst case is +1 agent call and +1 edit.
3. **An empirical attack routes to `kookr-toolkit:design-experimenter`, never to more debate.** If the scenario is testable ("it breaks under condition C"), run the probe — that terminates with a yes or no. Another critic round is generative and would only manufacture more opinions.

Record the verdict in the RFC's "Critic feedback incorporated" section, keyed on the agent so it stays legible to the invocation log's disuse scan: `general-purpose <date>: consensus-attack — <finding | consensus survives>`. A "consensus survives" line is a real outcome worth recording — it is the difference between a draft nobody attacked and one that was attacked and held.

## Phase 3 — Present to User

After completing all review rounds, present the RFC to the user:

1. **Show the final RFC** — either print it or tell the user where to find it
2. **Summarize the review process** — how many rounds, which critics, key changes made, and what the consensus attack returned
3. **List the "Critic feedback incorporated" section** — the RFC should have a section (like existing RFCs do) summarizing what critic feedback was addressed
4. **Ask explicitly for the user's feedback** — e.g., "Here's the RFC after 3 review rounds. Please review and let me know your feedback before I proceed."

### STOP here

**Do not** do any of the following until the user explicitly approves:
- Commit or push the RFC
- Create a PR
- Start implementing the design
- Create follow-up tasks or issues

The user may want to:
- Request changes to the RFC
- Ask for additional review rounds
- Reject the RFC entirely
- Approve and ask you to proceed with implementation

Wait for their explicit direction.

The sole exception is an invocation from the shipped
`architecture-refactor-rfc.md` playbook that carries all three activation
fields below in its prompt and durable state:

```yaml
callerPlaybook: architecture-refactor-rfc.md
rfcDeliveryAuthorized: true
durableState: state.json
```

That playbook is delivery-pre-authorized specifically to turn one converged
large-refactor RFC into a reviewed merge, a durable umbrella, and a Phase-1
self-advancing launch. When (and only when) all three fields are present, do not
ask for approval here; continue into Phase 4. A natural-language request to
"keep going", an inherited delivery default, or a missing/unreadable state file
does not activate the exception. All ordinary RFC work stops here unchanged.

## Phase 4 — Authorized Architecture-Refactor Continuation Tail

This continuation tail runs only when `rfcDeliveryAuthorized: true` is present
in the caller contract.

This tail is narrow and ordered. The full operational contract lives in
`plugin/playbooks/architecture-refactor-rfc.md`; follow it rather than inventing
a parallel flow.

1. **Freeze and publish the converged RFC.** Record its path and exact head in
   the durable state, create or resume the one marker-bound RFC PR, and run the
   repository's pre-push/pre-PR gates.
2. **Obtain independent exact-head review.** Run `independent-merge-review` in a
   fresh context. Require a latest `pass` comment whose `review-head-sha`
   equals the current RFC PR head. A missing, BLOCK, unbound, or stale verdict
   fails closed. A correction changes the head and therefore requires a new
   verdict.
3. **Merge with an exact-head guard.** In `kookr-ai/kookr`, use `pnpm merge` so
   the independent verdict is enforced by the repository wrapper. Elsewhere,
   resolve the repository's allowed merge method and use the pull-request merge
   REST endpoint with the reviewed head as its expected `sha`. Never merge
   without an atomic expected-head guard. Persist the confirmed merge commit
   only after the PR reports `MERGED` with a non-empty merge SHA.
4. **Prove reachability from fresh main.** Run `git fetch origin main`, then
   `git merge-base --is-ancestor "$RFC_MERGE_SHA" origin/main`, and verify the
   RFC exists in a temporary checkout of that fetched base. Do not create or
   modify an umbrella if any proof is missing.
5. **Create or resume one durable umbrella.** Match by the stable finding
   marker, persist its URL/number, and write the merged RFC reference plus one
   valid sequential `kookr-phase-ledger`. P1 has no dependency; every later
   phase depends only on its adjacent predecessor. Round-trip validate the
   ledger before launch.
6. **Launch Phase 1 once.** Use a prompt file and `kookr spawn
   --idempotency-key "chain:<repo>:<umbrella>:phase:P1" --unattended --json`.
   On timeout, look up the same key; never mint another. Persist the confirmed
   task id and append a `kookr-phase-result` comment. A missing task id fails
   closed and must not be recorded as a successful launch.

The durable state carries the idempotent references `rfcPrUrl`, `rfcHeadSha`,
`rfcMergeSha`, `umbrellaIssueUrl`, `umbrellaIssueNumber`, and `phase1TaskId`.
Revalidate a reference before reusing it. Stop with a discoverable blocker when
review, merge, reachability, ledger, or launch evidence is missing or stale.
Never launch P2 from this tail; the Phase-1 self-advancing task and durable
backstop own subsequent progression.

## Anti-Patterns

- **Don't rubber-stamp critic feedback.** Actually evaluate each finding — some will be wrong or inapplicable. Document why you rejected items.
- **Don't implement before approval outside the authorized architecture-refactor path.** Ordinary RFC work still stops for explicit approval. The `architecture-refactor-rfc.md` exception may continue only when all three activation fields validate and every Phase 4 fail-closed gate passes.
- **Don't skip the worktree.** RFCs are written artifacts — they need a branch even if they're "just docs".
- **Don't invent a new RFC format.** Match existing RFCs in the project.
- **Don't run more than 5 critics without a recorded justification.** The Panel Selection Gate makes this a checked cap, not a suggestion: 3–5 per round, hard max 5, and `N > 5` requires a logged override line in "Critic feedback incorporated". Pick the most relevant lenses — more critics != better, it's diminishing returns and multiplied cost past 4–5. (The cap limits breadth; it never blocks a critic from re-verifying a suspicious claim, and never counts the mandatory empirical-check `design-experimenter`.)
- **Don't let critics each re-explore from cold start.** Assemble the shared evidence pack once and paste it into every critic's prompt. But mark it "evidence to check," not settled fact — never suppress a critic's re-verification of a load-bearing claim.
- **Don't iterate if converged.** If round 2 produces nothing new, run the consensus attack once, then stop and present. Mention that you stopped early due to convergence.
- **Don't let the consensus attack reopen the review.** It is a final input, not a gate with veto power. One call, one triage, at most one revision — then present. An advocate that can order another round can defer convergence forever.
- **Don't treat "consensus survives" as the advocate failing.** A null verdict is information: it says the agreement was attacked and held. Re-running it to get a "real" finding is how you manufacture one.
