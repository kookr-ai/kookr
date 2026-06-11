---
name: UX Dogfood Loop
description: Use the live Kookr dashboard as a real user, log every friction point into a living RFC, then fan out implementation of the accepted findings across parallel worktrees
cwd: $HOME/git/kookr
parameters:
  - name: focus_area
    description: "Optional area to stress (e.g. 'launch flow', 'triage composer', 'playbooks tab'). Default: broad pass over classic workflows"
    required: false
  - name: target_projects
    description: "Comma-separated projects allowed for launching real tasks (default: kookr, knowledge-base-mcp-server, reason-at-home — private projects only)"
    required: false
  - name: implement
    description: "If 'true', proceed from the committed RFC straight into the implementation fan-out phase (default: stop after the RFC and ask)"
    required: false
    default: "false"
checklist:
  - Verified dashboard is live and created the RFC worktree BEFORE starting workflows
  - Drove real user workflows (UI + API) launching tasks only in allowed projects
  - Updated the RFC after every finding, not at the end
  - Root-caused high-severity findings to exact file/line in the codebase
  - Committed the RFC with severity/evidence/fix per finding and a priority order
  - (implement=true) Mapped code with parallel Explore agents before writing fixes
  - (implement=true) One fresh worktree per priority cluster, based on origin/main
  - (implement=true) Each cluster has tests added, targeted vitest + typecheck green, conventional commit
  - Asked the user before pushing any branch or opening any PR
---

## Objective

Run Kookr the way a real user would, convert every moment of friction into an
RFC finding with evidence and a suggested fix, and (optionally) implement the
findings in parallel worktrees. This is a self-improvement loop: the product
supervises agents, so using it *is* testing it.

Prior art: `docs/rfc/rfc-ux-dogfooding-findings-2026-06.md` (21 findings from
the first run of this loop) — match its format and depth.

## Hard rules (learned the hard way)

- **Never commit in a pre-existing checkout** — not the main repo, not the
  production runtime worktree (`~/git/kookr-prod`), not sibling worktrees.
  Every artifact (RFC, fixes) gets its own fresh worktree:
  `git worktree add ../kookr-<short-name> -b <branch> origin/main`.
- **Never launch dogfood tasks into `kookr-prod`** even if the Launch dialog
  defaults there — that is the supervisor's own working copy.
- **Fetch before branching**: local `main` is routinely stale and the running
  dashboard tracks `origin/main`. Base everything on `origin/main` so fixes
  diff cleanly against what is actually deployed.
- **Ask before push/PR.** Commit freely in worktrees; pushing and opening PRs
  needs an explicit user go-ahead.
- Commits end with: `Co-Authored-By: <the assistant's model name> <noreply@anthropic.com>`

## Phase 1 — Setup

1. Confirm the dashboard is live: `curl -s localhost:4800/api/snapshot | head -c 400`.
2. Create the RFC worktree immediately (the RFC is a *running log*, not a
   final report): `git worktree add ../kookr-dogfood-<yyyymm> -b rfc/ux-dogfooding-<yyyymm> origin/main`.
3. Seed `docs/rfc/rfc-ux-dogfooding-findings-<yyyy-mm>.md` with: status Draft,
   method, empty Findings / Things-that-worked-well / Session-log sections.

## Phase 2 — Dogfood with a running RFC

Drive classic workflows end to end, focusing on **{{focus_area}}** if given.
Launch real, useful tasks only in: {{target_projects}} (default: the three
private projects). Good task seeds: README-vs-code consistency audit, dead-code
scan, bug hunt in a subsystem, playbook/skill improvement suggestions.

Cover at minimum:
- API surface as a scripter would (`/api/projects`, `/api/tasks`, `/api/snapshot`)
  — cross-check numbers that appear side by side; contradictions are findings.
- UI happy path: launch via the dialog, watch the live terminal, reply to a
  signaled-complete task, complete it with a rating.
- UI unhappy path: at least one deliberate bad input (e.g. nonexistent cwd) —
  observe what the error says, what gets lost, what the recovery advice is.
- Rail/triage behavior over time: where does a waiting-on-you task end up?

**Update the RFC after every finding** — severity (high/med/low), evidence
(exact strings, API values, screenshots), suggested fix. Append a session-log
line per block of activity. Also record what worked *well* (keep-list), and
finish with a suggested priority order grouping findings into shippable
clusters.

Screenshot/automation notes that save an hour:
- Only `@playwright/test` is installed — `import { chromium } from '@playwright/test'`;
  scripts must run from the repo root; delete them after each run.
- Persist `storageState` once (after skipping onboarding) and reuse it;
  `deviceScaleFactor: 2` for readable close-ups; screenshots to `/tmp/kookr-ux-shots/`.
- Scope selectors: the onboarding overlay's "Skip" collides with finding-card
  "Skip" buttons (`getByTestId('onboarding-overlay').getByText('Skip')`).
- The harness blocks bare `sleep`; poll states via the API instead.
- `waitUntil: 'networkidle'` is flaky — the dashboard's WebSocket keeps the
  network busy. Use `'domcontentloaded'` + a fixed `waitForTimeout`.
- **Re-verify "bugs" in a single browser context before recording them.**
  localStorage-backed behavior (e.g. launch-draft restore) looks broken if
  your probe spawns a fresh context without re-saving `storageState` — two of
  this session's three suspected regressions were probe artifacts.
- The composer placeholder changes with task state ("Message X…" vs
  "Signaled complete — review or send a follow-up…") — match on
  `placeholder*="follow-up"` or use stable testids (`action-complete`).
- When a monitor waits for a task to re-signal, don't gate on
  `raisedAt >= monitor start` — the re-signal often lands before the monitor
  arms. Compare against the *previous* signal's `raisedAt` instead.

For every medium/high finding, attempt a code root-cause (grep server +
frontend, cite `file:line` in the RFC). A finding with a root cause is an
implementation ticket; one without is just a complaint.

## Phase 3 — Commit the RFC and decide

Commit the RFC in its worktree (`docs(rfc): ...`). Report the findings summary
to the user. If **{{implement}}** is not 'true', stop here and ask whether to
push the RFC branch and/or proceed to implementation.

## Phase 4 — Implementation fan-out (implement=true)

1. **Map before writing**: spawn parallel Explore subagents, one per priority
   cluster, asking for exact file:line maps of every change site, existing test
   conventions, and adjacent prior art (this repo has many near-miss branches —
   check `git log --oneline --all | grep -i <topic>` before re-inventing).
2. **One worktree per cluster**, named for the lead finding
   (`../kookr-f12-launch-ux -b fix/launch-cwd-validation origin/main`), then
   `pnpm install --prefer-offline` in each (the pnpm store makes this fast).
3. **Parallel implementation subagents**, one per cluster, each instructed to:
   read the actual files first (mapped line numbers drift), follow existing
   test conventions (Vitest; frontend uses `// @vitest-environment jsdom`),
   add regression tests, run targeted `pnpm exec vitest run <files>` plus the
   repo typecheck, commit conventionally, and **not push**.
4. Review each agent's diff and test results yourself before reporting.
5. Report all branches + commits to the user and ask which to push/PR.

## Phase 5 — Close the loop

- If the session surfaced lessons about *this playbook's process itself*,
  update this playbook in the same PR as the RFC.
- Signal completion when the deliverables are committed and the push/PR
  question is in the user's hands: `kookr signal completion-ready --note "..."`.
