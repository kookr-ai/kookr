# RFC: UX Dogfooding Findings — November 2026 (run 7: Lucy's panel, a room of her own)

- **Status**: Draft (living document, updated after every finding)
- **Author**: Claude (Fable 5.2), dogfooding session on the operator's live dashboard
- **Date**: 2026-11-17
- **Base**: `origin/main` @ `5e371d14e` (worktree `kookr-dogfood-202611-run7`)
- **Focus** (operator's brief): the same brief as run 6 ("Lucy's panel needs a full
  overhaul, end goal Lucy as helpful as Jarvis: proactive, speaks only to add value, a nice
  chat, a smooth interface, useful actions") plus one new sentence: "I think the panel is
  too small, maybe it should have its own full side panel or even entire window for
  interacting with in a nice manner".
- **Relation to runs 5 and 6**: run 5 (2026-11-16) and run 6 (2026-11-17, 17 hours before
  this run) covered the same panel. Between them they wrote 30 findings and built five
  clusters, merged on the local branch `feat/lucy-jarvis-integration` (43 commits, about
  15,400 added lines over 121 files). **None of it was pushed**, so the operator's
  dashboard still runs the old floating window, and this run's brief describes that old
  window. Their RFCs are on local branches too (`rfc/ux-dogfooding-202611-run5`,
  `rfc/ux-dogfooding-202611-run6`). This run does not re-measure what they measured.
- **Method**:
  1. Read what the operator did with Lucy since run 6 ended, from
     `~/.kookr/lucy-interactions.jsonl`.
  2. Bring `feat/lucy-jarvis-integration` up to today's `origin/main` in a fresh worktree
     (`kookr-lucy-jarvis-run7`, branch `feat/lucy-jarvis-run7`) and run that build on a
     throwaway server (temporary home, a stand-in agent, a fake Telegram, the real operator
     model).
  3. Replay the operator's own failed sentences from today against that build, and measure
     the panel against the new sentence of the brief (size, a full side panel, a window of
     her own).
  4. Root-cause each medium or high finding to `file:line`.
  5. Nothing on the operator's dashboard is clicked. Live Lucy is only talked to through
     `POST /api/lucy/turn` in this run's own conversation ids.

## Summary

_Written at the end of the run._

## What changed since run 6

Run 6 ended at 04:19 UTC on 17 November. From then until this run started (21:37 UTC),
`~/.kookr/lucy-interactions.jsonl` shows:

- **The operator started typing to Lucy.** Run 6 counted zero typed turns in six days. Today
  there are three, all on the old window: "can you make it proceed ?" (19:21), a request to
  start a task about that failure (19:22) and "Give me a status of every running task, one
  by one." (20:38). The first two failed and became issues #4143 and #4144, both open and
  unassigned. The third worked: eight look-ups, 8.8 s, a 259-word answer.
- **The old window is still being dragged around**: 13 moves, 4 restores and 3 minimises
  in those 17 hours.
- **Her question clips are still long**: the four task questions she read aloud today ran
  16.5 s, 45.4 s, about 15 s and 21.3 s.
- **`main` gained 22 commits**, none in Lucy's code. They merge into the integration
  branch with no conflict; on the merged tree `tsc`, the frontend type check and the build
  pass.

So the brief for this run, written by the operator at 21:37, describes the window that
runs 5 and 6 already replaced on a branch the operator has never seen.

## Findings

### R7-F1. Two runs of fixes never reached the operator, because the push question sat at the end of a report (process) — severity: high

**Evidence.** Runs 5 and 6 both ended with "the push question is with the operator". Both
tasks then completed, and nothing was pushed: `git ls-remote --heads origin` has none of
`feat/lucy-jarvis-integration`, `feat/lucy-operator-column`, `feat/lucy-actions`,
`feat/lucy-chat-surface`, `feat/lucy-speaks-first`, `feat/lucy-question-awareness`, or the
two RFC branches. The operator launched this run 17 hours later with the same brief plus
"the panel is too small", which the unpushed column already addresses in part.

This run asked the same question at the start, through `kookr ask`, with a link to a page
of screenshots of the built column (https://claude.ai/artifact/K95ZcxuNwz8eX5LJG8QTNq,
owner-only). The operator answered **27 seconds later**, from the dashboard: "Push, open
PRs, merge when gates pass" (ask `c8e862999ab2`, created 21:48:45 UTC, answered 21:49:12).

**Root cause.** The playbook puts the push question in the final report
(`.kookr/playbooks/ux-dogfood-loop.md`, Phase 3 "stop here and ask whether to push" and
Phase 4 step 5 "ask which to push/PR"). A finished task's report is one of about a hundred
a day on this install (run 6 measured 94 finished signals in 24 hours), and a completed
task cannot be answered into. The question is never refused; it is never seen.

**Suggested fix.** In the playbook: ask the push question as soon as there is something to
show, with `kookr ask`, a link to real screenshots and two or three options, and carry on
without waiting; a rerun whose previous run left unpushed branches asks about those
branches in Phase 1. Done in this run and written into the playbook (Phase 5).

### R7-F2. On the built column, Lucy's widest setting is 560 px, and she has no window of her own (panel) — severity: high

**Evidence.** Measured on the merged build (`feat/lucy-column-and-actions`, throwaway
server) with the column's resize handle dragged as far as it goes:

| Window | Default column | Widest column | Share of the window |
|---|---|---|---|
| 1440 x 900 | 380 px | 440 px | 31% |
| 1920 x 1080 | 380 px | 560 px | 29% |
| 2560 x 1300 | 380 px | 560 px | 22% |

At 2560 px the dashboard keeps 2,000 px and she keeps 560. Her answer to "Give me a status
of every running task, one by one." is a six-item list in a bubble 471 px wide
(`/tmp/kookr-ux-shots/r7/03-status-widest-1920.png`); today's real answer to the same
sentence on the live dashboard was 259 words in eight paragraphs. There is no control that
gives her the whole window, and no address that opens her alone in a second window, so
"its own full side panel or even entire window" (the new sentence of the brief) is not
possible on either build.

**Root cause.** `src/frontend/store/avatar-panel-prefs.ts:23-26` (default 380, minimum 320,
maximum 560) and `:81-91` (`avatarColumnLayout`: three modes, `sheet`, `overlay`,
`docked`; none is full-window). The 3D view, the waiting strip and the conversation are
stacked in one column (`src/frontend/avatar/AvatarDock.tsx`), so extra width cannot be
used for anything but longer lines.

**Suggested fix.** A fourth mode, "Lucy's room": she takes the whole window, with the
conversation in a readable centre column, what waits on the operator in a rail beside it
with its cards open at full size, and her 3D view at a size where it is worth looking at.
One button and one shortcut switch between the column and the room, the choice is
remembered, and `/?lucy=room` opens the room directly so it can live in its own browser
window on a second screen. Raise the docked column's maximum as well, for operators who
want a wide side panel and the dashboard together.

### R7-F3. "Can you make it proceed?" after her own permission notice still gets "Which task do you mean?" (actions / awareness) — severity: high (issue #4143, re-observed on the built column)

**Evidence.** The operator's exchange of 19:21 UTC, on the live dashboard:

> Lucy (spoken, 19:21:10): "A task is waiting for your permission to use Bash. The command
> is on my card."
> Operator (typed, 19:21:39): "can you make it proceed ?"
> Lucy: "Which task do you mean? I can't approve or reply to a task myself, but I can open
> it on your screen or tell you what it's waiting for."

Replayed on the merged build with one task stopped on a permission prompt and six
questions waiting (conversation `r7-perm-a`):

> "can you make it proceed ?" → "Which task do you mean? There are seven waiting on you
> right now." (no look-up, 1.0 s)

In the built column the failure is on screen in one thread
(`/tmp/kookr-ux-shots/r7/05b-column-closeup.png`). Her own two lines, then the operator's,
then hers:

> "Six tasks are stopped on a question; Billing migration's closes first. Staging fixture
> refresh is waiting for a permission. Nothing else is running."
> "The task "Staging fixture refresh" is waiting for your permission to use Bash. The
> command is on my card."
> "can you make it proceed ?"
> "Which task do you mean? Several are waiting on you right now."

The column made the problem easier to see and did not fix it: what she wrote two lines
above is shown to the operator and not to the model.

Asked by name (conversation `r7-perm-b`): "Approve the permission prompt of the staging
fixture refresh task." → "I cannot approve permission prompts; that is not something I can
do. The staging fixture refresh task is still blocked on that permission, so it needs you
to approve it." Her own card, a few centimetres above the answer, has an **Approve once**
button. She does not mention it.

**Root cause.** Two gaps, both unchanged by runs 5 and 6:

1. What she says unprompted never enters the conversation the model sees. The permission
   notice is pushed to the dashboard and spoken by the browser
   (`src/server/lucy-permission-notice.ts`); the only path that records an unprompted
   sentence, `noteUnprompted` → `rememberSaid`
   (`src/server/lucy-live/create-lucy-live.ts:114`, `src/server/lucy-operator/service.ts:161`),
   serves task questions read out inside a hands-free voice session. A typed conversation
   gets nothing, so "it" has no referent.
2. Her instructions say she cannot approve (`src/core/lucy-operator/prompt.ts:35`) and
   forbid naming a control the instructions do not name (same file, the "Never point the
   operator at a button" rule). The permission card's buttons are not named anywhere in
   the instructions, so the correct behaviour under her rules is to say nothing about them.

**Suggested fix.** (a) Give every operator turn a short "what you said unprompted in the
last few minutes" note: the notice or question, the task it was about and when. (b) Name
the permission card and its two buttons in her instructions, and tell her that a request
to let a task proceed, with one permission prompt waiting or one she just announced, is
about that task: answer with what it wants to run and where the button is. (c) Approving
by herself stays out: it is the last slice of umbrella #3632 and needs its own setting.

### R7-F4. Asked to start a task, she answers "Which project?" and names none (actions) — severity: medium (issue #4144, re-observed on the built column)

**Evidence.** Live, 19:22 UTC: "can you spawn a task to self reflect about my answer so
that we can fix this interactivity problem ? …" → "Which project?"
(`launch / no_proposal / reason: ambiguous`). Replayed on the merged build, where exactly
two projects exist: same sentence, same two-word answer. On the live install the writer can
choose among 9 of the 52 projects, and Kookr's own project is not one of them.

**Root cause.** `src/server/lucy-operator/launch-wiring.ts:66` keeps a project only when
it has a local folder **and** `tracked === true` (or is `local/…`); `kookr-ai/kookr` has a
folder and `tracked: false`. The writer's "ambiguous" outcome carries no candidate list
back to the turn, so her sentence cannot name any.

**Suggested fix.** Any project with a local folder that the dashboard's own Launch dialog
offers is launchable; "you", "Lucy", "your panel" and "the dashboard" resolve to Kookr's
own project; and "Which project?" lists the three most recently used ones.

### R7-F5. Five minutes after a permission prompt appears, her card loses its buttons (actions) — severity: medium

**Evidence.** On the merged build, a task stopped on a permission prompt for seven minutes
shows this card at the top of her column: the task's name, "Waiting for your permission to
use Bash", the command, an "Open task" link, and "These buttons have timed out. Answer it
in the task's terminal." There is no Approve once and no Deny
(`/tmp/kookr-ux-shots/r7/05b-column-closeup.png`). Her notice comes 60 seconds after the
prompt by default, so the buttons she announces work for four minutes. The operator's own
history has a case of the long wait: a task "stuck on a permission prompt since 22:40"
was still stuck when a reviewer task asked about it (ask `3f739a24bcaf`, expired
unanswered).

**Root cause.** A card's buttons are bound to the prompt that was detected, for five
minutes: `src/shared/contracts/permission-request-binding.ts:1-2`
(`DEFAULT_PERMISSION_APPROVAL_TTL_MS` and its maximum, both 5 minutes),
`src/frontend/store/lucy-permission.ts:88-89` (`permissionButtonsLive`) and
`src/frontend/avatar/LucyPermissionCard.tsx:25,67` (the timed-out text). The binding
exists so a key press cannot land on a different prompt; nothing renews it while the same
prompt is still on screen.

**Suggested fix.** While the task's terminal still shows the same prompt, renew the
binding (on a timer, or when the operator presses a "Check again" button on the card), so
the buttons work for as long as the prompt does. Until then Lucy must know whether the
buttons are live before she points at them (see R7-F3): with dead buttons the useful
answer is "its buttons have timed out, I am opening the task", followed by opening it.

### R7-F6. Two pushes of a reviewed branch were rejected on a busy host (process) — severity: medium

**Evidence.** The landing branch was pushed with the related tests green (397 files, 8,701
tests) and a passing review. The repository's fast pre-push gate rejected it twice:

1. First push (load average 25 to 37): the smoke lane failed with "`~/.kookr` contains
   unexpected state … new file: achievements.json, resource-watchdog-audit.jsonl,
   resource-watchdog.state.json". The related-tests lane had passed (405 files, 8,939
   tests).
2. Second push (load average 55 to 62): the related-tests lane was killed ten minutes
   in ("Terminated"), before it could finish or re-run anything. By then five server test
   files that this branch does not touch had a timed-out test each (`diagnostics-routes`,
   `settings-api`, `idempotency-routes`, `integrations/telegram/index`, `index.test.ts`
   at 294 s). The kill was mine: the push ran as a background command with a ten-minute
   limit, and the gate needed longer on that host. The first push had finished inside the
   same limit only because the host was half as busy.

The load came from this run's own agents (four reviewers running mutation checks, two
implementers running tests and browsers) on top of the fleet's (the integration train's
full suite, a benchmark, three `kb doctor` processes).

**Root cause.** (1) `scripts/local-only-smoke-files.ts` allows local state files by exact
name, and three files the server writes on purpose were missing. The delta reviewer traced
why they appear only on a busy host: the smoke run switches the resource watchdog off, but
outside Vitest the watchdog still switches itself on under pressure
(`buildResourceWatchdogConfig`, `src/server/index.ts:2114-2124`); with 20 or more dtach
sessions on the host it writes its two files and launches an investigation task inside the
smoke server (`src/server/resource-watchdog-service.ts:464-518`), and that task's prompt
unlocks an achievement. (2) The gate has no time limit of its own, and the
playbook's notebook already says to push in the background and wait for the notification;
I added a ten-minute limit to that background command, which is shorter than the gate on a
host at load 55.

**Suggested fix.** Allow the three files (done on the landing branch, with tests), and set
`KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0` in the smoke environment so the watchdog is really
off there (follow-up issue). For this playbook: push in the background with no time limit and wait for
its notification, and avoid running reviewers' mutation checks, implementers' test runs
and a push at the same time.

## Things that worked well (keep-list)

## Suggested priority order

## Implementation (Phase 4)

### Landed: the work of runs 5 and 6 (PR #4148)

The operator's answer to the early push question was "Push, open PRs, merge when gates
pass". The integration branch of run 6, brought up to today's `main`, went out as one pull
request: **#4148, "feat(lucy): a docked chat column, three confirmed actions and a written
briefing"**, 121 files, squash-merged into `staging` as `94f748cd8` on 18 November. The
integration train runs the full suite there and moves `main` to it.

It went out as one pull request and not as the five clusters of run 6's priority list,
because the fixes run 6 made after merging the clusters exist only on the merged branch
(among them the hold that stops a spoken "yes" from confirming the wrong card), so no
single cluster is a state anyone verified.

| Step | Result |
|---|---|
| Related tests on the merged tree | 397 files, 8,701 tests pass; `pnpm typecheck` and `pnpm build` clean |
| Independent review, round 1 (four fresh-context parts over 20,870 diff lines) | BLOCK: nine small defects, no critical finding; the five attempts to cause an action without the operator all failed |
| Fixes | `c4afae3c6` (expiry race, announced outcomes, focus, Open task on her own lines, briefing signature, docs, an unused export) and `5e2ff1140` (real-server tests for close, answer and reply) |
| Round 2, fix check | PASS; 21 mutants on the fix diff, 18 killed |
| Smoke allow-list and one doc sentence (`36693a7af`, `94405e0b5`), delta review | PASS; 9 of 9 mutants killed |
| Fast gate on the third push | 406 related test files, 8,992 tests, and the smoke lane pass |
| Browser specs on the final head | `e2e/avatar-panel.spec.ts` and `e2e/finding-groups.spec.ts`, 30 of 30 |
| Follow-ups | Thirteen larger defects in one issue, #4149 |

Run 6's RFC listed two checks as not done. "ESLint was not run" has no remedy: the
repository has no ESLint (`pnpm exec eslint` fails because there is nothing to run). "The
whole suite was not run on the merged tree" is now the integration train's job.

### Cluster A: she remembers what she said, names her card's buttons, launches in Kookr (R7-F3, R7-F4; issues #4143, #4144)

Branch `fix/lucy-remembers-notices` (worktree `kookr-r7-lucy-notices`), three commits, 43
files, rebased onto `staging` after #4148 merged.

**What changed.** The server keeps one small record of what she said or wrote unprompted
(at most six items, none older than 15 minutes, each leaving as soon as what it was about
is over). Every turn, in every conversation, shows it to the model as a labelled note
after the board; it is never added to the history and never given to the calls that write
a launch description, a reply or an answer. Her instructions name the permission card and
its three buttons. The board line of a task blocked on a permission prompt says the tool,
the command (the server's redacted copy, cut to 160 characters) and whether the card's
buttons still work, computed on the server from the same five-minute binding the card
uses. Every project with a folder on this machine is launchable, which is what the Launch
dialog offers; Kookr's own project is identified by project id, never by name; and "Which
project?" names up to three candidates, Kookr first, then the most recently used.

**Before and after**, real model (`deepseek/deepseek-v4.1-flash-1017`), throwaway server,
one task stopped on a permission prompt and six questions waiting, three runs per
sentence, all three alike:

| Operator's sentence | Before (merged build of runs 5 and 6) | After |
|---|---|---|
| "can you make it proceed ?" | "Which task do you mean? Several are waiting on you right now." | "The task Staging fixture refresh is blocked on a permission prompt: it wants to run `for f in fixtures/*.sql; do psql staging -f "$f"; done`. Press Approve once on the card at the top of your panel, which works for about 4 more minutes." |
| "Approve the permission prompt of the staging fixture refresh task." | "I cannot approve permission prompts; that is not something I can do. … it needs you to approve it." | "… Its card is at the top of your panel and the buttons still work for about 4 more minutes, so press Approve once there. I cannot press it myself." |
| The same, six minutes after the prompt (buttons timed out) | (not tried) | "… Its card is on your panel but the buttons have timed out, so you answer in the task's terminal, which I have just opened for you." (and the task is opened) |
| "can you spawn a task to self reflect about my answer so that we can fix this interactivity problem ? …" | "Which project?" | A launch card in `kookr-ai/kookr` |
| "start a task to tidy the changelog for the next release" (three projects) | "Which project?" | "Which project: kookr, billing-api or lucy?" |

The "before" column is this run's replay (R7-F3, R7-F4); the implementer's own "before"
runs were made on a server whose state had changed and are not used here.

**Tests.** `pnpm typecheck` clean; 39 files, 1,156 tests of the Lucy core, server, routes
and asks suites pass, with four new test files (the note's rendering and bounds, the
record, each writer through the service to what the model was sent, and a real-server
boot).

**Left out, on purpose.** Approving through Lucy (the last slice of umbrella #3632).
Item 3 of #4144 (a task launched from a conversation gets a pointer to that conversation).
The briefing is not recorded, because the browser decides whether it is shown. "Recorded"
means "reached a dashboard", not "was heard". Spoken turns were not tried against the real
model.

**The implementer also found**, on the merged build of runs 5 and 6: a request about
Kookr itself was proposed in an unrelated project when that project was the only one
listed (3 of 3; fixed in this cluster), and she said that approving a permission prompt
"is done in Settings" (2 of 3; not seen in 12 runs after the change).

### Cluster B: Lucy's room and a wider column (R7-F2)

Branch `feat/lucy-room` (worktree `kookr-r7-lucy-room`). _Written when the implementer
reports._

## Session log

- 2026-11-17 — **Phase 1 setup.** Dashboard live at `localhost:4800` (deployed commit
  `5e371d14e`, same as `origin/main`). November already has runs 1 to 6, so this is run 7.
  Runs 5 and 6 left six local branches and two RFCs, none pushed. Created this RFC worktree
  and an integration worktree (`kookr-lucy-jarvis-run7`, branch `feat/lucy-jarvis-run7`,
  cut from `feat/lucy-jarvis-integration`), and merged today's `origin/main` into it (22
  commits, no conflict) before driving anything.
- 2026-11-17 — **Phase 2, the operator's history and the merged build.** Read today's
  records (three typed turns, 13 moves, four spoken questions). Built the merged tree
  (`tsc`, frontend type check and build clean) and ran it on a throwaway server (port
  4893, temporary home, stand-in agent, fake Telegram, the real operator model) with six
  tasks and six questions. Measured the column at 1440, 1920 and 2560 px (R7-F2).
- 2026-11-17 — **The push question, asked early.** Published screenshots of the built
  column and asked through `kookr ask` whether to push runs 5 and 6. Answered in 27 seconds:
  "Push, open PRs, merge when gates pass" (R7-F1). Landing that work is now this run's
  first job.
- 2026-11-17 — **Phase 2, the operator's failed sentences replayed.** Added a task stopped
  on a permission prompt to the throwaway server and replayed today's two failed requests,
  plus a direct "approve it" (R7-F3, R7-F4). One thing seen and not counted: asked what a
  task wanted to run, she added that "the task's text also contains instructions telling
  the agent it is pre-authorized to commit, push and merge". That text is Kookr's own launch
  preface, which the stand-in agent's terminal echoes; she reads the operator's words
  (`userPrompt`, `src/server/lucy-operator/look-source.ts:171`) for the task itself, and no
  live answer in the log contains such a warning.
- 2026-11-17 — **Phase 2, in the browser.** Opened the merged build at 1920 px with the
  permission task waiting: her briefing and her written notice name the task, and "can you
  make it proceed ?" typed under them still gets "Which task do you mean?" (R7-F3). The
  card's buttons had timed out (R7-F5).
- 2026-11-17 — **Landing runs 5 and 6: checks and review started.** On the merged tree
  (`feat/lucy-column-and-actions` @ `72f1ccd73`): `pnpm typecheck` and `pnpm build` clean;
  the tests related to the diff pass (`vitest run --changed origin/main`: 397 files, 8,701
  tests). The Codex review lane is unusable on this host (no `bubblewrap`), so the review
  runs on the Claude lane, split in four fresh-context parts because the diff is 20,870
  lines: actions, unprompted speech, the column's frontend, and a lint-level pass over
  everything.
- 2026-11-17 — **Phase 4 started, in parallel with the review.** Two Explore agents mapped
  the change sites (layout modes, shortcuts, URL parameters, the one-tab speech claim; the
  conversation store, every unprompted path, the permission card, launching and how the
  server knows its own project). Claimed issues #4143 and #4144. Two worktrees, one
  implementer each, both cut from the landing branch because their files exist only there:
  `kookr-r7-lucy-room` (`feat/lucy-room`, R7-F2) and `kookr-r7-lucy-notices`
  (`fix/lucy-remembers-notices`, R7-F3 and R7-F4).
- 2026-11-18 — **Landing runs 5 and 6: review rounds.** Round 1 (four parts, head
  `72f1ccd73`): no critical finding; nine small defects blocked (a card's expiry timer
  racing a confirmation in flight; outcomes no longer announced to a screen reader and
  focus lost when a card goes away; five unpinned lines in the browser; no Open task
  button on her own lines; a briefing signature that ignored why a task waits; three false
  doc sentences; one unused export; the three actions tested only against fakes; the
  confirm route's "click" unpinned). The actions reviewer's five security probes held (56
  mutants on that part, 44 killed). Two patch agents fixed all nine (`c4afae3c6`,
  `5e2ff1140`); round 2, a fix check, passed on `5e2ff1140` (21 mutants, 18 killed, three
  test nits left). Eleven larger defects go into one follow-up issue.
- 2026-11-18 — **Landing: two rejected pushes.** The smoke lane, then a test lane that my
  own ten-minute limit killed, both on a host at load 25 to 62 (R7-F6). Added the three state files to the smoke
  allow-list and corrected one doc sentence (`36693a7af`, `94405e0b5`); the delta was
  reviewed and passed on `94405e0b5`. Third push started with no time limit.
- 2026-11-18 — **Landed.** Third push passed the fast gate (406 related test files, 8,992
  tests, smoke). Browser specs 30 of 30 on the final head. Opened #4148, filed the
  review's thirteen larger defects as #4149, posted the round-1 BLOCK record and the final
  PASS, and ran `kookr merge 4148`: retargeted to `staging` and squash-merged as
  `94f748cd8`.
- 2026-11-18 — **Cluster A reported and rebased.** The notices implementer finished
  (three commits, real-model before/after in its report). Rebased onto `staging` with no
  conflict; its independent review and a re-run of its tests are in progress.
