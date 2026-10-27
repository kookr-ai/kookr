---
name: Product Onboarding Improvement Cycle
description: Simulate a first-time user's journey through a product's docs, prioritize what blocks activation, and draft issues + onboarding-media recommendations for your approval — gated, loopable
repo-tags: [github]
tags: [workflow, loopable]
deliveryPreAuthorized: false
autoCloseOnSignal: true
parameters:
  - name: repoFullName
    description: "Target repository (owner/repo). Blank uses the launch project / current git remote."
    required: false
    type: select
    source: tracked-projects
    defaultFrom: git-remote
  - name: persona
    description: "The first-time user to simulate, e.g. 'a non-technical Windows user who has never used a virtual audio device'."
    required: false
    default: "a non-technical first-time user"
  - name: platform
    description: "The OS/hardware the persona actually has, e.g. 'Windows 11, a USB webcam, wired headphones'."
    required: false
    default: ""
  - name: productGoal
    description: "The activation moment that means 'it worked' for this persona. Blank = infer from the README and confirm."
    required: false
    default: ""
  - name: limit
    description: "Max draft issues to present this cycle (keeps the backlog focused)."
    required: false
    default: "8"
checklist:
  - "A journey log for the persona was produced, anchored to doc file:line, ending at the first blocker"
  - "Findings were deduped against open issues and ranked by effect on activation (P0..P3)"
  - "Up to {{limit}} draft issues + an onboarding-media plan were presented for approval"
  - "Nothing was filed, pushed, or implemented without explicit operator approval"
---

## Objective

Run one **gated** cycle of product-onboarding improvement for `{{repoFullName}}`: find out, honestly, whether **{{persona}}** can reach the product's core value on their own — then hand back a ranked, approval-ready set of improvements. This playbook is the onboarding/activation specialization of `repository-idea-scout`: it is driven by a *simulated first-time-user journey*, not a general backlog scan, and it stops at the approval gate by design.

It composes two subagents shipped in this plugin:
- `kookr-toolkit:user-test-simulator` — walks the docs as the persona and logs every friction point.
- `kookr-toolkit:product-owner` — prioritizes the findings against the activation goal and drafts issues.

## Context

- **Repo:** `{{repoFullName}}` — assess its **user-facing** docs (README, setup/getting-started/install guides), not its internal/dev docs.
- **Persona:** {{persona}} · **Platform:** {{platform}} · **Activation goal:** {{productGoal}} (if blank, derive from the README and state it for confirmation in Phase 1).
- **Gating:** this cycle **drafts** issues and **presents** them. It does not file, label, push, or implement anything without explicit operator approval. Implementation is a separate, operator-launched step (see Phase 5).
- **Tools:** `gh` for reading existing issues/labels; the two subagents above; no write operations until the gate is passed.

## Phases

### Phase 1 — Frame the activation path
Read the README and user-facing docs. Write the shortest step sequence the persona must complete to reach the goal (install → prerequisites → configure → first run → tune). If `productGoal` was blank, state the inferred goal explicitly. Note the platform constraint up front: if the product cannot run on `{{platform}}` at all, that is the headline finding — say so and skip to Phase 4 with a single P0.

### Phase 2 — Simulate the first-time-user journey
Spawn `subagent_type: "kookr-toolkit:user-test-simulator"` with the persona, platform, goal, and the Phase-1 activation path. It returns a journey log: ordered steps, each anchored to a doc `file:line`, each with a friction note, severity, a `doc-grounded|inferred` grounding label, and a fix idea. Do not re-walk the path yourself.

### Phase 3 — Prioritize, dedup, and draft (as the product owner)
Spawn `subagent_type: "kookr-toolkit:product-owner"` (or adopt its lens) with the journey log, persona, platform, and goal. It must:
1. **Dedup:** `gh issue list --repo {{repoFullName}} --state open --limit 100` (+ keyword searches). Drop or annotate ("tracked by #N") any finding an open issue already covers. This is the load-bearing step when the cycle repeats.
2. **Rank** survivors by effect on activation (P0 blocks activation → P3 polish).
3. **Draft** up to **{{limit}}** issues (title, user story, anchored "why", acceptance criteria, labels from the repo's existing taxonomy, and `Kind: docs|code|media|design`), plus an **onboarding-media plan** (the 1–3 steps where a diagram/screenshot/short video/in-product cue beats prose, with the reason).

### Phase 4 — Present for approval (the gate)
Return the three-section product-owner output (findings digest → ranked draft issues → media plan) to the operator. **Stop here.** Do not file issues. State clearly: "Approve the set (or a subset) and I will file them; approved issues can then be implemented via the Parallel Issue Batch playbook."

### Phase 5 — Hand-off (only after approval, operator-initiated)
On explicit approval: file the approved issues with the repo's labels (reuse `issue-proposal-refinement` conventions), then the operator launches **`parallel-issue-batch`** against the filed issues to implement them (that playbook owns its own review/merge safety). This playbook does **not** spawn implementation itself.

## Idempotency Rules

1. **Dedup every run against open issues** — never re-draft a gap an open issue already tracks; annotate it instead.
2. Tag each cycle's drafts with the persona + a date so successive runs are distinguishable and regressions are visible.
3. Treat a previously-filed-and-closed issue whose gap has **returned** as a regression (new draft, reference the closed issue), not a duplicate.
4. If nothing new survives dedup, report "no new activation gaps this cycle" and close — do not pad the backlog to hit `{{limit}}`.

## Anti-Patterns

- **Do not auto-file or auto-implement.** The whole point of this playbook is the approval gate; `deliveryPreAuthorized` is false deliberately.
- Do not duplicate issues `repository-idea-scout` or open issues already track.
- Do not rewrite the docs in this task — this cycle observes, prioritizes, and drafts; fixing is Phase 5's batch.
- Do not let the user-test-simulator's `inferred` (no-device) findings be presented as verified runtime results.
- Do not pad to `{{limit}}` — a focused P0/P1 set beats an exhaustive wishlist.

## Running it on a loop (optional, still gated)

To iterate periodically, schedule this playbook (via the Kookr schedule UI, or the `schedule` skill / a cron routine) rather than looping in-process; set `modelTier: "small"` on the *schedule* for routine runs. Each scheduled run re-audits, dedups against the now-larger issue set, and surfaces only genuinely new activation gaps — so the backlog converges instead of ballooning. The loop stays gated: it keeps proposing, you keep approving. A fully-autonomous variant (auto-file + auto-launch `parallel-issue-batch` each cycle) is a deliberate future escalation, not the default — enable it only by raising `deliveryPreAuthorized` and wiring Phase 5, with the project's independent-review-before-merge rail in force.
