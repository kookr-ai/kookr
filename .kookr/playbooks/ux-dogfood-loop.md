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
- **Ask before push/PR, and ask early.** Commit freely in worktrees; pushing and
  opening PRs needs an explicit user go-ahead. Do not leave that question for the
  final report: two runs in a row ended with "the push question is with the
  operator", the tasks completed, and nothing was pushed, so the operator re-ran
  the loop on a dashboard that still had every finding. As soon as there is
  something to show, send one `kookr ask` (no `--wait`) with a link to real
  screenshots and two or three options ("Push and open the PRs", "Push, open PRs,
  merge when gates pass", "Keep it local"), and carry on. Asked that way, the
  question was answered in 27 seconds. No answer means no push.
- Commits end with: `Co-Authored-By: <the assistant's model name> <noreply@anthropic.com>`

## Phase 1 — Setup

1. Confirm the dashboard is live: `curl -s localhost:4800/api/snapshot | head -c 400`.
2. Create the RFC worktree immediately (the RFC is a *running log*, not a
   final report): `git worktree add ../kookr-dogfood-<yyyymm> -b rfc/ux-dogfooding-<yyyymm> origin/main`.
3. Seed `docs/rfc/rfc-ux-dogfooding-findings-<yyyy-mm>.md` with: status Draft,
   method, empty Findings / Things-that-worked-well / Session-log sections.
4. **Look for work earlier runs left unpushed** before measuring anything:
   `git branch --list 'rfc/ux-dogfooding-*'` and the fix branches their RFCs name,
   checked against `git ls-remote --heads origin`. If a previous run built fixes
   that never reached the remote, the live dashboard still shows what that run
   measured, and landing those fixes is worth more than finding the same things
   again: ask about them first (see "Ask before push/PR, and ask early").

## Phase 2 — Dogfood with a running RFC

Drive classic workflows end to end. Focus area for this run (empty means a
broad pass): **{{focus_area}}**
Projects where real tasks may be launched (empty means the default, the three
private projects): **{{target_projects}}** Prioritise the repos that feed Kookr's own self-recursive
improvement — `knowledge-base-mcp-server`, `local-research-agent`,
`reason-at-home` — so the work you trigger is genuinely useful, not throwaway.
Good task seeds: README-vs-code consistency audit, dead-code scan, bug hunt in a
subsystem, playbook/skill improvement suggestions.

**Mature same-month reruns (run 3+).** When prior runs this month already drove
the UI and found it polished, net-new *UI* findings are scarce and re-driving the
same launch→terminal→triage paths is low-value (and launching tasks seeds the
junk `local/*` rows earlier runs flagged). Shift the pass to **reconciliation +
code-rooted latent hazards**: confirm which prior findings are still open on the
*current* `origin/main` (cite `file:line`; delegate this to a read-only Explore
agent), promote resolved ones to the keep-list, and mine new findings from
`?? 0` / `?? fallback` coercions that render a partial-or-absent value as an
authoritative total (these are invisible to a live API cross-check on fully
populated data). Prefer read-only API + code evidence over new task launches, and
say in the session log that you made this scope choice. When you then implement,
*defer* (don't auto-ship) findings that need a product/contract decision — a
backward-compat default change, a project-identity rename, a guard against a
field the type says is always present — and surface them to the operator instead.

**Gather context before you launch.** Spend the first few minutes mining what
the system has recently done — it tells you what to try and often surfaces UX
regressions directly:
- Recently-merged PRs in the target repos (`gh pr list --repo <r> --state merged
  --limit 20`, or the project card's PR link) — a just-shipped change is the
  best place to look for a follow-up task *and* for UX that regressed.
- Recently-completed tasks (`GET /api/tasks`, or the overview's "Recently
  completed") — their prompts and outcomes seed realistic new tasks and reveal
  which flows users actually run.
- Use that context to pick a task that a real operator would plausibly run next,
  then watch the full launch → live-terminal → signaled-complete → reply →
  complete-with-rating lifecycle end to end.

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
- **The operator's own browser is live data.** Question cards, permission cards and
  launch cards there are real decisions (mirrored to Telegram): measure them with read-only
  DOM probes, never click an answer, Send or Dismiss. Exercise those flows on a throwaway
  server seeded through `POST /api/asks` (`scripts/ask-lucy-browser-proof.ts` shows how).
- **A second dashboard tab speaks.** With Lucy's panel on, every open tab plays her clips,
  so a probe tab talks over the operator. Close it as soon as the measurements are taken,
  and never switch Talk on there (it opens the operator's microphone).
- **Headless Chromium may never paint on this host** (no `requestAnimationFrame`, every
  click and screenshot waits forever). Run Playwright headed under a virtual display:
  `xvfb-run -a -s "-screen 0 1600x1000x24" pnpm exec playwright test <spec> --headed --workers=1`.
- **`origin/main` moves while you work.** Review a branch with the three-dot diff
  (`git diff origin/main...HEAD`); the two-dot diff shows other people's merges as your
  deletions.
- **Explore agents cannot write files**, and a closing hook can replace their last message
  with a notebook note. Ask for the map "in your final message", and if it comes back empty,
  ask the same agent to send it again rather than re-exploring.
- **A rerun on the same panel starts from the last run's branches, not from the live
  dashboard.** If the previous run left unpushed fix branches, the live dashboard still
  shows what that run already measured. Merge those branches onto `origin/main` in a fresh
  integration worktree, run *that* build on a throwaway server, and dogfood it; stack new
  clusters on the integration branch and say so in the RFC.
- **The operator's history is evidence.** `~/.kookr/lucy-interactions.jsonl` records what
  Lucy said (`kind: said`), what the panel did with each clip (`kind: ui`, joined on
  `clipId`: started, ended, unheard and why) and every panel action. Count before you
  theorise: "62% of her unprompted clips were never played" came from that file.
- **A throwaway server needs a fake Telegram for task questions** (`POST /api/asks` answers
  503 without one): start `startFakeTelegram()` from
  `src/integrations/telegram/fake-telegram-server.js` and pass its URL as
  `KOOKR_TELEGRAM_API_URL`, as `scripts/ask-lucy-browser-proof.ts` does.
- **Never print `.env`.** A `grep` with a `sed` redaction leaked three API keys into this
  session's transcript when the pattern did not match. List names only
  (`cut -d= -f1 .env`), and read a secret inside the launcher script that needs it.
- **A blocked command runs nothing.** The task hooks reject `git add -A` and `rm -rf` on a
  variable path, and they reject the whole Bash call: an edit earlier in the same command
  did not happen. Stage by path, delete by literal path, and re-run the rest.
- **Ask implementers to write their report to a file as well as their last message**; the
  closing hook can replace the message.
- **Landing a large stack: review it in parts.** One reviewer cannot read 15,000 lines
  in the review's time budget. Split the diff by area (one `git diff origin/main...HEAD --
  <files>` file per area), give each area its own fresh-context reviewer with the same
  brief, and post one verdict that lists every part. The Codex review lane needs
  `bubblewrap` on this host; without it the lane script exits 3 and the Claude lane is
  the one to use.
- **Push in the background with no time limit.** The fast gate ran past ten minutes on a host at
  load 55; a background `git push` given a ten-minute limit was killed mid-gate and reported as a
  rejected push. Start it with `run_in_background` and no `timeout`, and wait for its notification.
- **Clusters stacked on an unmerged branch: rebase them when their base lands.** Once the
  base pull request is squash-merged, `git rebase --onto origin/staging <old-base-head>
  <cluster-branch>` moves each cluster onto the merged commit (three of three applied
  with no conflict in run 7), then reinstall dependencies before running anything: the
  integration branch may carry a dependency bump the old base did not have.
- **Implementers' throwaway servers leave stand-in agents behind.** An implementer told to
  kill only the process it started stops its server and leaves the `dtach` and stand-in
  agent processes of its test tasks. Ask for their process ids in the report and stop
  them by id.
- **This repository has no ESLint.** `pnpm exec eslint` fails with `spawn eslint EACCES`
  because there is nothing to run; conventions are checked by `pnpm typecheck` and the
  design-token tests. Do not record "lint not run" as a gap.
- **The playbook text a task receives comes from the checkout it was launched in.** A
  task launched in a parked `~/git/kookr` gets that checkout's older copy of this file.
  Read the current one with `git show origin/main:.kookr/playbooks/ux-dogfood-loop.md`
  before following it.

For every medium/high finding, attempt a code root-cause (grep server +
frontend, cite `file:line` in the RFC). A finding with a root cause is an
implementation ticket; one without is just a complaint.

## Phase 3 — Commit the RFC and decide

Commit the RFC in its worktree (`docs(rfc): ...`). Report the findings summary
to the user. The `implement` parameter of this run is **{{implement}}**. If it is
not 'true', stop here and ask whether to push the RFC branch and/or proceed to
implementation.

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
   test conventions (Vitest; frontend uses `// @vitest-environment happy-dom`,
   or `jsdom` only when a test needs jsdom-specific behavior),
   add regression tests, run targeted `pnpm exec vitest run <files>` plus the
   repo typecheck, commit conventionally, and **not push**.
4. Review each agent's diff and test results yourself before reporting.
5. Report all branches + commits to the user and ask which to push/PR.

## Phase 5 — Close the loop

- If the session surfaced lessons about *this playbook's process itself*,
  update this playbook in the same PR as the RFC.
- Signal completion when the deliverables are committed and the push/PR
  question has been asked through `kookr ask` (and, if the operator said yes,
  the branches are pushed and the pull requests are open or merged):
  `kookr signal completion-ready --note "..."`. A question that exists only in
  the final report does not count as asked.
