---
name: Product Improvement Autoloop
description: Fully autonomous product-improvement loop — simulate a first-time-user journey, auto-file ranked activation issues, implement the repo-groundable ones (independent-review-gated), route media/host-verification work to a needs-human label, then self-continue until gaps converge
repo-tags: [github]
tags: [workflow, loopable]
deliveryPreAuthorized: true
autoCloseOnSignal: true
parameters:
  - name: repoFullName
    description: "Target repository (owner/repo). Blank uses the launch project / current git remote."
    required: false
    type: select
    source: tracked-projects
    defaultFrom: git-remote
  - name: persona
    description: "First-time user to simulate, e.g. 'a non-technical Windows user who has never used a virtual audio device'."
    required: false
    default: "a non-technical first-time user"
  - name: platform
    description: "The OS/hardware the persona has, e.g. 'Windows 11, a USB webcam, wired headphones'."
    required: false
    default: ""
  - name: productGoal
    description: "The activation moment that means 'it worked'. Blank = infer from the README and state it."
    required: false
    default: ""
  - name: maxFilePerCycle
    description: "Max new issues to file this cycle."
    required: false
    default: "6"
  - name: maxImplementPerCycle
    description: "Max auto-implementable issues to send to the implementation batch this cycle."
    required: false
    default: "3"
  - name: maxCycles
    description: "Hard stop: how many cycles this chain may run in total (prevents an unbounded loop)."
    required: true
    default: "5"
checklist:
  - "A journey log for the persona was produced, anchored to doc file:line"
  - "New activation gaps were deduped against open issues and auto-filed (ranked P0..P3)"
  - "Only repo-groundable (docs/code) issues went to the implementation batch; media/host-verification issues got the needs-human label and were NOT auto-implemented"
  - "Every implementation PR passed an independent fresh-context review before merge"
  - "The chain self-continued only if new gaps remain and the cycle budget is not exhausted, else it stopped and reported convergence"
---

## Objective

Run the **fully autonomous** product-improvement loop for `{{repoFullName}}`: each cycle simulates **{{persona}}**'s journey to the activation goal, auto-files the activation gaps it finds, implements the ones it can safely ground in the repo (behind an independent-review merge gate), routes the rest to humans, then spawns the next cycle — until the backlog of *new* gaps converges or the cycle budget runs out.

This is the **non-gated escalation** of `product-onboarding-improvement-cycle` (which stops at draft issues for approval). Use this one only when autonomous filing + implementation is explicitly wanted. It composes:
- `kookr-toolkit:user-test-simulator` — docs-first journey simulation.
- `kookr-toolkit:product-owner` — prioritization + issue drafting.
- `parallel-issue-batch` — supervised implementation to merged PRs (owns its own review/merge safety).

## Context

- **Repo:** `{{repoFullName}}` — assess its **user-facing** docs/UX; this cycle may both file AND implement, so treat the repo's real state as ground truth.
- **Persona:** {{persona}} · **Platform:** {{platform}} · **Activation goal:** {{productGoal}} (infer + state if blank).
- **The merge gate:** implementation PRs merge only after an **independent fresh-context review** (the `independent-merge-review` rail / `parallel-issue-batch`'s own supervision). This loop removes the *human* gate, not the *review* gate. One caveat: on a repo whose CLAUDE.md/AGENTS.md documents independent review as **advisory**, `parallel-issue-batch` treats a BLOCK/missing/timeout verdict as advisory and merges after local gates pass — so on such repos set `mergeAfterImplementation=false` here so a human merges.
- **Budgets:** `maxFilePerCycle` and `maxImplementPerCycle` bound each cycle; `maxCycles` bounds the whole chain.

## Phases

### Phase 1 — Simulate + prioritize
Spawn `subagent_type: "kookr-toolkit:user-test-simulator"` (persona/platform/goal) for the journey log, then `subagent_type: "kookr-toolkit:product-owner"` to dedup against `gh issue list --repo {{repoFullName}} --state open` and rank the survivors (P0..P3). If the product can't run on `{{platform}}` at all, file one P0 and skip to Phase 4.

### Phase 2 — Auto-file (bounded), with routing
File up to **{{maxFilePerCycle}}** new issues with the repo's labels. For each, set a **Kind** and route it:
- **Auto-implementable** — `docs` or `code` fully groundable in the repo (e.g. an explainer assembled from existing modules, a factual asset-path guide). Eligible for Phase 3.
- **needs-human** — anything that needs **real-host truth** (screenshots of an external app, a verified install flow, by-ear judgment), **media production** (video/motion), or **UI/design** work an issue-implementer can't produce from a doc task. Apply a `needs-human` label (create it if absent) and **exclude from Phase 3**. (The pilot learned this the hard way: a VoiceMeeter-routing guide or an onboarding video cannot be auto-implemented faithfully.)

### Phase 3 — Implement the auto-implementable ones
Launch `parallel-issue-batch` for `{{repoFullName}}` with:
- **`issueSelector` = an explicit list of ONLY this cycle's auto-implementable issue numbers** (e.g. `230 231 232`). **Never leave it blank** — a blank selector makes the batch scan every open issue (and its starvation-refill path can auto-gather more), which would pull a `needs-human` issue into implementation. The explicit list is the primary guard; `parallel-issue-batch` also skips the `needs-human` label as defense-in-depth.
- `targetIssueCount` ≤ **{{maxImplementPerCycle}}**; `mergeAfterImplementation` = `true` (merge when safe).
- **`extraInstruction`** (the only channel that reaches each implementer child without editing the verbatim child-prompt template): *"Docs/code only. Any step you cannot ground in the repo — the exact UI of an external app, a shipped artifact that may not exist yet, or a by-ear result — must be written as `TODO (needs real-host verification)`, never invented. The reviewer must confirm nothing was fabricated."*

It implements each in its own worktree, opens one PR per issue that Closes it, obtains an **independent review**, and merges only when the verdict is clean and checks pass (see the merge-gate note in Context). Do not merge a host-dependent doc whose key steps are unverified.

### Phase 4 — Converge or continue
- Record this cycle: gaps found, filed, routed-to-human, implemented+merged.
- **Stop** (report convergence) if: no *new* gaps survived dedup this cycle, OR `maxCycles ≤ 1` (this is the last budgeted cycle), OR every remaining open gap is `needs-human`.
- **Otherwise** spawn exactly one successor: re-launch this same playbook for `{{repoFullName}}` with `maxCycles` **decremented by 1** (and the same persona/platform/goal) via `spawn-child-task` / the continuation contract. One cycle = at most one spawn; never fan out multiple successors. If you cannot decrement `maxCycles`, stop rather than guess.

## Idempotency Rules

1. **Dedup every cycle** against open AND recently-closed issues — never re-file or re-implement a gap already tracked; a returned gap behind a closed issue is a regression (new issue, reference the closed one).
2. Tag each cycle's issues with the persona + a cycle date so successive runs are distinguishable.
3. A `needs-human` issue stays filed and is **not** re-filed or auto-implemented on later cycles — count it as known, not new.
4. If a child implementation task is still open from a prior cycle, do not launch a conflicting one for the same issue.

## Anti-Patterns

- **Never auto-implement a `needs-human` issue** (host-verification / media / UI). Filing it is fine; implementing it autonomously is the failure mode this playbook exists to avoid.
- Never merge without an independent review verdict — removing the human gate does not remove the review gate.
- Never let the chain run unbounded — `maxCycles` is required and must decrement; a cycle that can't decrement it must stop, not guess.
- Don't duplicate issues `repository-idea-scout`, `product-onboarding-improvement-cycle`, or open issues already track.
- Don't pad to `maxFilePerCycle` — file only genuine, deduped gaps; an empty cycle is a valid convergence signal.
- Don't let an implementer fabricate steps it can't ground — unverifiable parts are `TODO`, not invented.

## Scheduling

To run this on a cadence, schedule it from the Kookr dashboard (there is no CLI/API create) or via the `schedule` skill; set `modelTier: "small"` on the *schedule* for routine runs, and point `cwd` at the target repo's local checkout. Because `deliveryPreAuthorized: true`, scheduled runs file + implement without prompting — so keep `maxCycles` modest and review the `needs-human` queue yourself. The fleet must have this plugin version synced for the two subagents to resolve.
