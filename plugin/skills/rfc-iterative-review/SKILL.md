---
name: rfc-iterative-review
description: Iterative RFC drafting workflow — draft in worktree, run parallel critic subagents, incorporate feedback over N rounds, present to user before any action
keywords: rfc, design document, proposal, design exploration, architecture decision, write rfc, draft rfc, generate rfc, create rfc, design doc
related: spawn-child-task, kookr-playbooks, requirements-engineering
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

### Each round

Launch the following subagents **in parallel** using the Agent tool. Pick 3-5 that are most relevant to the RFC's topic.

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

**When to skip the checkpoint:**
- Round 1 produced no empirical claims — all findings were definitional, stylistic, or structural.
- All empirical claims require platforms/tools unavailable (e.g., macOS runner needed but only Linux present); in this case, note the gap explicitly in the RFC's Open Questions section.

**Invoking:** launch `design-experimenter` with a prompt that lists the specific claims to probe, the RFC path, and a time budget (default 4 hours). Record its verdict in the RFC's "Critic feedback incorporated" section and edit the RFC text per its recommendations before round 2 begins.

Converge early (skip further critic rounds) if empirical probes have falsified the load-bearing claims — the correct response is to restructure the RFC around reality, not to iterate further on a design whose premise is broken.

**Subagent prompt template:**

> Review the following RFC document for [agent's focus area]. The document is at `<path-to-rfc>`. Read it completely, then provide specific, actionable feedback. Focus on substantive issues — not formatting or style. For each finding, state: (1) what the issue is, (2) why it matters, (3) a concrete suggestion.

### After each round

1. **Triage feedback** — categorize each finding as: incorporate, reject with reason, or defer
2. **Edit the RFC** — apply incorporated feedback directly to the document
3. **Add a revision note** — at the bottom of the RFC or in the Status line (e.g., `Draft (v2 — post-review revision)`)
4. **Early convergence** — if a round produces no substantive findings (only minor or already-addressed items), you may stop iterating early. Note this in your summary.

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

## Phase 3 — Present to User

After completing all review rounds, present the RFC to the user:

1. **Show the final RFC** — either print it or tell the user where to find it
2. **Summarize the review process** — how many rounds, which critics, key changes made
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

## Anti-Patterns

- **Don't rubber-stamp critic feedback.** Actually evaluate each finding — some will be wrong or inapplicable. Document why you rejected items.
- **Don't implement before approval.** The entire point of this workflow is human review before action.
- **Don't skip the worktree.** RFCs are written artifacts — they need a branch even if they're "just docs".
- **Don't invent a new RFC format.** Match existing RFCs in the project.
- **Don't run 5+ critics when 3 suffice.** Pick the most relevant ones for the topic. More critics != better — it's diminishing returns past 4-5.
- **Don't iterate if converged.** If round 2 produces nothing new, stop and present. Mention that you stopped early due to convergence.
