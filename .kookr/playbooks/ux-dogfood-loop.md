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
  - (implement=true) One fresh worktree per priority cluster, based on origin/main (or on the integration branch of unlanded work it must stack on, said in the RFC)
  - (implement=true) Each cluster has tests added, targeted vitest + typecheck green, conventional commit
  - Pushed, opened and merged the RFC (and, with implement=true, the fix branches) through the normal delivery cycle, without asking whether to push
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
  diff cleanly against what is actually deployed. The one exception: a cluster
  that changes files existing only on an earlier run's unlanded branch is cut
  from that branch (see "A rerun on the same panel" in the automation notes),
  and the RFC says so.
- **Deliver like every other task.** Push, open pull requests and merge once the
  gates pass, following the repository's delivery cycle (`CLAUDE.md`, "Complete the
  delivery cycle"). Do not ask whether to push or merge (operator decision, 18 Nov
  2026, #4156). Two runs that held their push for an answer left the question in their final
  report and pushed nothing, so the operator re-ran the loop on a dashboard that still had every
  finding.
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
   that never reached the remote and were never merged (a merged pull request's
   branch is deleted on the remote too, so also check
   `gh pr list --state merged --head <branch>`), the live dashboard still shows
   what that run measured, and landing those fixes is worth more than finding the same things
   again: land them first (push, pull request, merge, as in "Deliver like every other
   task").
   Before reporting a branch as unpushed, read the latest run's findings document
   (`docs/rfc/rfc-ux-dogfooding-findings-*.md`, the highest run number, on `origin/main`
   or on the newest `rfc/ux-dogfooding-*` branch). It says where earlier branches went:
   work often lands under another head, which the two checks above cannot see. Run 6's
   cluster branches, for example, were merged into its integration branch, and run 7's
   document says that branch went out as one pull request (#4148) under another name.
   A branch the document covers that way (its run's work is named as landed, or the
   pull request that carried it is named as merged) is not unpushed work: leave it
   alone.

5. **Check that merges reach production**: `pnpm train:status` (the integration train moves
   `main`, and production follows `main`) and `git log -1 origin/main`. A train that is not
   running, or halted, means nothing this run merges will be seen: say so to the operator at the
   start, through `kookr ask` (no `--wait`), not in the final report. Run 8 merged five pull
   requests before noticing the train had not run for a day.

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
- **A second dashboard tab speaks.** Lucy's clips play in one tab per browser profile, and
  a Playwright probe is another profile, so a probe tab talks over the operator. Close it as soon as the measurements are taken,
  and never switch Talk on there (it opens the operator's microphone).
- **Headless Chromium may never paint on this host** (no `requestAnimationFrame`, every
  click and screenshot waits forever). Run Playwright headed under a virtual display:
  `xvfb-run -a -s "-screen 0 1600x1000x24" pnpm exec playwright test <spec> --headed --workers=1`.
- **`origin/main` moves while you work.** Review a branch with the three-dot diff against
  its base (`git diff origin/main...HEAD`, or `origin/staging...HEAD` for a cluster rebased
  onto the integration branch); the two-dot diff shows other people's merges as your
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
  theorise: "62% of the task questions she read out were never played" came from that file.
- **A throwaway server needs a fake Telegram for task questions** (`POST /api/asks` answers
  503 without one): start `startFakeTelegram()` from
  `src/integrations/telegram/fake-telegram-server.ts` and pass its URL as
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
  in the review's time budget. Split the diff by area (one three-dot diff against the
  branch's base, limited to that area's files, per area), give each area its own fresh-context reviewer with the same
  brief, and post one verdict that lists every part. The Codex review lane needs
  `bubblewrap` on this host; without it the lane script exits 3 and the Claude lane is
  the one to use.
- **Push in the background with no time limit.** The fast gate ran past ten minutes on a host at
  load 55; a background `git push` given a ten-minute limit was killed mid-gate and reported as a
  rejected push. Start it with `run_in_background` and no `timeout`, and wait for its notification.
- **Clusters stacked on an unmerged branch: rebase them when their base lands.** Once the
  base pull request is squash-merged, `git fetch` and then, in each cluster's own worktree,
  `git rebase --onto origin/staging <old-base-head> <cluster-branch>` moves the cluster onto
  the merged commit (three of three applied
  with no conflict in run 7), then reinstall dependencies before running anything: the
  integration branch may carry a dependency bump the old base did not have.
- **Implementers' throwaway servers leave stand-in agents behind.** An implementer told to
  kill only the process it started stops its server and leaves the `dtach` and stand-in
  agent processes of its test tasks. Ask for their process ids in the report and stop
  them by id.
- **This repository has no ESLint.** `pnpm exec eslint` fails with `spawn eslint EACCES`
  because there is nothing to run; conventions are checked by `pnpm typecheck` and the
  design-token tests. Do not record "lint not run" as a gap.
- **Read a setting's value, not its name.** Run 8 reported "speech failed to start" because
  `KOOKR_TTS` was present in `.env`; its value was `false`. Six designers were briefed with the
  wrong sentence. Check the server's own log line or status route for what it concluded.
- **Lucy's interaction log holds earlier runs' probes.** Of 30 typed turns, 26 were this
  playbook's own (`conversationId` starting `dogfood-`, `r7-`, `r8-`). Filter them out before
  counting what the operator did, and give this run's probes an id of the same kind.
- **When the brief asks for a fleet of designers**, run two rounds: several blind to each other,
  each with one lens and the same evidence file, then critics on the written synthesis (what to
  cut, failure modes, delivery, a walkthrough as the operator). Give them screenshots and file
  paths, not conclusions, and record in the RFC what was adopted and what was rejected.
- **Stacked and sibling clusters.** Rebase a cluster as soon as the one under it merges, then ask
  its reviewer for a delta check (`git range-diff` shows what the rebase changed). Rows of the
  shared reference documents (`docs/reference/api.md`, `lucy-operator.md`) conflict between
  siblings: keep each change's own row. After a rebase onto a merged sibling, look for readers
  of anything this cluster changed: run 8's "named lines" cluster emptied a briefing that the
  already merged "board reply" quoted.
- **The push gate inherits the task's model keys.** A task's shell carries production's `.env`,
  and some server tests then call the real helper model. When that provider hangs, the gate
  fails on unchanged `main`. Push with the keys unset
  (`env -u OPENROUTER_API_KEY -u KOOKR_OPENROUTER_API_KEY -u KOOKR_LLM_PROVIDER pnpm deliver …`)
  and say so in the pull request.
- **One reviewer per cluster, kept for every round.** Write the requirements to a file, give a
  fresh agent the diff, the requirements and nothing from the implementer, and resume the same
  reviewer for fix checks. Post every round's verdict on the pull request, the blocks too.
- **No `&` inside a background command.** The harness then reports it finished at once and
  never notifies; let the harness do the backgrounding.
- **The playbook text a task receives comes from the checkout it was launched in.** A
  task launched in a parked `~/git/kookr` gets that checkout's older copy of this file.
  Read the current one with `git show origin/main:.kookr/playbooks/ux-dogfood-loop.md`
  before following it.

For every medium/high finding, attempt a code root-cause (grep server +
frontend, cite `file:line` in the RFC). A finding with a root cause is an
implementation ticket; one without is just a complaint.

## Phase 3 — Commit the RFC and decide

Commit the RFC in its worktree (`docs(rfc): ...`), push it and open its pull
request; it stays open for the Phase 4 log and Phase 5 lessons, and is merged in
Phase 5. Report the findings summary to the user. The `implement` parameter of
this run is **{{implement}}**. If it is not 'true', go straight to Phase 5 (which
merges the RFC's pull request), then ask, through `kookr ask` (no `--wait`),
whether to proceed to implementation.

## Phase 4 — Implementation fan-out (implement=true)

1. **Map before writing**: spawn parallel Explore subagents, one per priority
   cluster, asking for exact file:line maps of every change site, existing test
   conventions, and adjacent prior art (this repo has many near-miss branches —
   check `git log --oneline --all | grep -i <topic>` before re-inventing).
2. **One worktree per cluster**, named for the lead finding
   (`../kookr-f12-launch-ux -b fix/launch-cwd-validation origin/main`, or the
   unlanded integration branch in place of `origin/main` when the cluster must
   stack on it), then
   `pnpm install --prefer-offline` in each (the pnpm store makes this fast).
3. **Parallel implementation subagents**, one per cluster, each instructed to:
   read the actual files first (mapped line numbers drift), follow existing
   test conventions (Vitest; frontend uses `// @vitest-environment happy-dom`,
   or `jsdom` only when a test needs jsdom-specific behavior),
   add regression tests, run targeted `pnpm exec vitest run <files>` plus the
   repo typecheck, commit conventionally, and **not push**.
4. Review each agent's diff and test results yourself before reporting.
5. Push each verified branch, open its pull request and merge it once the gates
   pass (the delivery cycle; do not ask). Report the branches, pull requests and
   their final state.

## Phase 5 — Close the loop

- If the session surfaced lessons about *this playbook's process itself*,
  update this playbook in the same PR as the RFC.
- Merge the RFC's pull request once the gates pass (the delivery cycle; do not
  ask).
- Signal completion when the deliverables are pushed and their pull requests are
  merged, or a concrete blocker is recorded on them:
  `kookr signal completion-ready --note "..."`.
