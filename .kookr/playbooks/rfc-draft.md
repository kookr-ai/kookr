---
name: RFC Draft with Iterative Review
description: Draft an RFC in a worktree, run parallel critic subagents for N rounds, present for user approval
parameters:
  - name: topic
    description: "What the RFC is about (e.g., 'snooze state persistence across restarts')"
    required: true
  - name: context
    description: "Additional context — related issues, constraints, prior art, existing code to study"
    required: false
  - name: iterations
    description: "Number of critic review rounds (default: 3)"
    required: false
    default: "3"
checklist:
  - Created worktree and initial RFC draft
  - Completed critic review iterations with subagents
  - Incorporated feedback with documented rationale for each finding
  - Presented final RFC to user and waiting for approval
---

## Objective

Draft an RFC about **{{topic}}** following the iterative review workflow: write a draft, run parallel critic subagents to find issues, incorporate feedback, repeat for {{iterations}} rounds, then present the final document to the user and wait for explicit approval before taking any further action.

## Context

- **Repository**: Kookr (`/home/jean/git/kookr`) — AI agent supervisor
- **RFC location**: `docs/rfc/rfc-<slug>.md`
- **Existing RFCs**: Study 2-3 existing RFCs in `docs/rfc/` for format, tone, and depth before writing
- **Architecture docs**: `docs/architecture.md`, `docs/features.md`
- **Additional context**: {{context}}

## Phase 1 — Setup

Before starting any work, create a git worktree and work inside it:

```bash
git worktree add ../kookr-rfc-<slug> -b rfc/<slug> main
```

All changes must happen inside the worktree. Do NOT commit to main.

Read the project's CLAUDE.md for conventions. Read 2-3 existing RFCs in `docs/rfc/` to match the established format.

## Phase 2 — Draft the RFC

Write the initial draft at `docs/rfc/rfc-<slug>.md`. Follow the standard structure:

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

Be thorough in the first draft — the critics will catch what you miss, but a weak draft wastes review rounds on obvious gaps.

## Phase 3 — Iterative Critic Review

Run **{{iterations}} review rounds**. In each round:

1. **Launch 3-5 critic subagents in parallel** using the Agent tool. Always include:
   - `boundary-critic` — responsibility segregation, coupling, dependency direction
   - `failure-mode-analyst` — hidden assumptions, edge cases, failure modes
   - `design-minimalist` — YAGNI, over-abstraction, accidental complexity
   - `socratic-challenger` — probing questions to expose gaps

   Add these when relevant to the topic:
   - `operability-reviewer` — if the RFC affects runtime behavior, monitoring, recovery
   - `delivery-pragmatist` — if the RFC involves migration or phased rollout
   - `module-interface-auditor` — if the RFC defines new module boundaries
   - `state-machine-verifier` — if the RFC involves state transitions

2. **Prompt each subagent** to read the RFC file and provide specific, actionable feedback. Ask for: what the issue is, why it matters, and a concrete suggestion.

3. **Triage feedback** — for each finding, decide: incorporate, reject (with reason), or defer.

4. **Edit the RFC** — apply incorporated feedback. Update the Status line (e.g., `Draft (v2 — post-review revision)`).

5. **Early convergence** — if a round produces no substantive new findings, stop early. Note this in your summary.

## Phase 4 — Present to User

After completing the review rounds:

1. Print the final RFC content or tell the user the file path
2. Summarize: how many rounds ran, which critics participated, key changes per round
3. Ensure the RFC has a "Critic feedback incorporated" section listing what was addressed
4. **Ask the user explicitly**: "Here's the RFC after N review rounds. Please review and let me know your feedback before I proceed."

### CRITICAL: STOP AND WAIT

Do NOT:
- Commit or push the RFC
- Create a PR
- Start implementing the design
- Create follow-up tasks

Wait for the user's explicit direction. They may request changes, ask for more review rounds, reject the RFC, or approve it.

## Idempotency

- If a worktree with a similar name already exists, check if it has a draft RFC. If yes, resume from where it left off rather than starting fresh.
- If a draft RFC already exists at the expected path, read it and continue from the appropriate phase.

## Anti-Patterns

- **Don't implement before user approval.** This is a document-generation task, not an implementation task.
- **Don't rubber-stamp critic feedback.** Evaluate each finding — reject what's wrong or inapplicable, with documented reasons.
- **Don't skip the worktree.** Even "just docs" need a branch.
- **Don't invent a new RFC format.** Match existing RFCs in the project.
- **Don't run all 8 critics every round.** Pick the 3-5 most relevant. Diminishing returns past 5.
- **Don't iterate past convergence.** If round 2 produces nothing new, stop and present.
