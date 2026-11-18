# RFC: UX Dogfooding Findings — November 2026 (run 7: Lucy's panel, a room of her own)

- **Status**: Findings recorded and acted on. #4148, #4150 and #4153 are merged; R7-F5, R7-F8 and the follow-up issues #4149, #4151 and #4154 are open.
- **Author**: Claude (Fable 5.2), dogfooding session on the operator's live dashboard
- **Date**: 2026-11-17 to 2026-11-18 (all clock times below are UTC)
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
  window. Their RFCs were on local branches too (`rfc/ux-dogfooding-202611-run5`,
  `rfc/ux-dogfooding-202611-run6`); both documents are published with this one, unchanged,
  as `rfc-ux-dogfooding-findings-2026-11-run5.md` and `...-run6.md` in this directory. This run does not re-measure what they measured.
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

The most important finding of this run is not about Lucy. Runs 5 and 6 had already
replaced the window this run was asked to overhaul, and none of it had reached the
operator, because both runs left "may I push?" in their final report. Asked at the start
of this run, through `kookr ask` with screenshots, the question was answered in 27
seconds: "Push, open PRs, merge when gates pass". So this run did three things.

1. **Landed runs 5 and 6.** One pull request, #4148, after an independent review in four
   parts (nine small defects fixed, no critical finding, every attempt to cause an action
   without the operator failed). It is on `main`, and production updated itself to it
   during this run.
2. **Measured what the landed column still lacks**, against the brief's new sentence and
   against the operator's own failed requests of the day: eight findings (R7-F1 to R7-F8).
3. **Built and merged two clusters on top**: Lucy's room, a full-window view, with a
   wider side column (#4153); and Lucy knowing what she just said, naming the buttons on
   her own permission card, and being able to start a task in Kookr's own project (#4150,
   closing #4143 and #4144). Both are merged into `staging`, where the integration train
   runs the full suite before moving `main`.

Against the brief:

| The brief asks for | State after this run |
|---|---|
| A panel that is not too small: "its own full side panel or even entire window" | The docked column can take up to half the window, and the room gives her the whole window, also as a window of her own on a second screen (#4153, merged). |
| A nice chat | Landed in #4148: bubbles with times, a line that says what she is doing, lists, a conversation shared by every tab. In the room it gets a reading column of its own. |
| Proactive, and speaking only to add value | Landed in #4148: a written briefing on opening and on return, one line when a task fails, stalls or wants review, questions announced in one sentence. Still open: nothing new is spoken, and R7-F5. |
| Useful actions | Landed in #4148: answer a task's question, reply to a task, close a finished task, each behind a card. #4150 makes "can you make it proceed?" work up to the last step: she names the task, the command and the Approve once button. Pressing it for the operator is the last slice of #3632 and is not built. |
| A smooth interface | The switch between column and room rebuilds nothing. "Open task" on her cards, which opened nothing on `main`, is fixed in #4153 (R7-F7). |

## What changed since run 6

Run 6 ended at 04:19 UTC on 17 November (its task record's `finishedAt`). From then until this run started (21:37 UTC),
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

The repository's `CLAUDE.md` says the opposite of the playbook for the operator's own
repositories ("Do not ask whether to push or merge. Standing policy grants that Jean-owned
merge default"). The playbook's rule is the stricter of the two and both runs followed
it, as did this one. Which of the two should apply to this playbook is the operator's
decision; this run only changed when and how the playbook asks.

**Suggested fix.** In the playbook: ask the push question as soon as there is something to
show, with `kookr ask`, a link to real screenshots and two or three options, and carry on
without waiting; a rerun whose previous run left unpushed branches asks about those
branches in Phase 1. Done in this run and written into the playbook (Phase 5).

### R7-F2. On the built column, Lucy's widest setting is 560 px, and she has no window of her own (panel) — severity: high

**Evidence.** Measured on the merged build (`feat/lucy-column-and-actions` (the integration branch `feat/lucy-jarvis-run7`, renamed for the pull request), throwaway
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

### R7-F6. Two pushes of a reviewed branch failed on a busy host: the gate rejected one, my own time limit killed the other (process) — severity: medium

**Evidence.** The landing branch was pushed with the related tests green (397 files, 8,701
tests) and a passing review. Two pushes in a row then failed in the repository's fast
pre-push gate:

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
lesson notebook this playbook's runs keep (a shared list of one-line lessons from earlier
runs) already says to push in the background and wait for the notification;
I added a ten-minute limit to that background command, which is shorter than the gate on a
host at load 55.

**Suggested fix.** Allow the three files (done on the landing branch, with tests), and set
`KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0` in the smoke environment so the watchdog is really
off there (follow-up issue). For this playbook: push in the background with no time limit and wait for
its notification, and avoid running reviewers' mutation checks, implementers' test runs
and a push at the same time.

### R7-F7. "Open task" on Lucy's cards opens nothing (actions) — severity: high

**Evidence.** Found by the room implementer while wiring "Open task" out of the room, and
present on `origin/main`: pressing **Open task** on a question card or a permission card
in Lucy's panel selects the task and then clears the selection. The card reports success
and no task is shown. It is the button R7-F5's card falls back to when its Approve
buttons have timed out ("Answer it in the task's terminal"), so on `main` a permission
prompt older than five minutes has no working control on her card at all.

**Root cause.** `openAskingTask` in `src/frontend/App.tsx` calls `selectAgent(agentId,
taskId)` and then `selectProject(null)` to close the project drawer; `selectProject`
clears the selected task. It dates from #3955. `selectRecentTask` in the same file (the
project drawer's recent-task row) has the same order and no test; it was not confirmed in
a browser.

**Suggested fix.** Close the drawer first, then select. Done on `feat/lucy-room`
(`fix(lucy): "Open task" in Lucy's panel leaves the task selected`), with a test at the
App level. `selectRecentTask` is left for its own change.

### R7-F8. At the page's 1000 px minimum the top bar's findings count runs into "System" (layout, not Lucy) — severity: low

**Evidence.** With five to seven findings waiting, "N findings waiting" wraps onto two
lines when the page is 1060 px wide and overlaps "System" at 1000 px
(`/tmp/kookr-ux-shots/r7/room/column-default-1440.png`,
`column-widest-1920.png`). The docked column is what narrows the page to that width, so
the wider maximum of this run makes it reachable in a 1920 px window. Not re-checked on a
build without the column.

**Suggested fix.** Let the top bar's findings label shorten ("7 waiting") below a width
threshold. Run 6 fixed a similar overlap in the grouped row's header (J-F14).

## Things that worked well (keep-list)

- **Asking the push question early, with something to look at.** Twenty-seven seconds to
  an answer that two finished runs never got.
- **Replaying the operator's own failed sentences.** "can you make it proceed ?" and the
  self-reflection request, taken word for word from `~/.kookr/lucy-interactions.jsonl`,
  were better tests than anything invented: both failed on the merged build of runs 5 and
  6, and both are the before/after of cluster A.
- **Her status answer is good.** "Give me a status of every running task, one by one."
  got eight look-ups and a correct paragraph per task in 8.8 s on the live dashboard. What
  was wrong with it was the four-line window it was shown in.
- **The action design held under attack.** The actions reviewer tried five ways to cause
  an action without the operator (agent text reaching what is sent, a confirm without the
  operator, a stale or replaced card, a viewer calling the routes, races) and all five
  failed; 44 of 56 mutants on that part were killed before any fix.
- **Review in parts found real things.** Nine small defects in runs 5 and 6 that the
  runs' own verification had not: a "timed out" line left in the thread after a reply
  that was in fact sent, outcomes no longer announced to a screen reader, the three
  actions tested only against fakes.
- **The implementers looked at their own screenshots.** The room's implementer changed
  five things after reading its own PNGs, and found on the way that "Open task" on her
  cards had never worked (R7-F7).
- **The merge wrapper and the train.** `kookr merge` retargeted, checked the verdict and
  merged in one command; the train found and reverted an unrelated bad dependency bump
  that was ahead of #4148 without help.

## Suggested priority order

1. **Lucy's room and the "Open task" fix** (R7-F2, R7-F7). #4153, merged. The fix alone
   was worth landing: without it a permission prompt older than five minutes had no
   working control on her card.
2. **She knows what she just said, and can launch in Kookr** (R7-F3, R7-F4). #4150,
   merged, closes #4143 and #4144.
3. **Buttons that last as long as the prompt** (R7-F5). Renew the card's five-minute
   binding while the task's terminal still shows the same prompt. Not started. After
   #4150 she at least says the buttons have timed out and opens the task.
4. **Approve through Lucy** (the last slice of #3632). With R7-F3 and R7-F5 done, "make
   it proceed" stops one press short: a confirmation card for the approval, behind its
   own setting, is the natural next action. Not started; it needs the operator's
   decision on the setting.
5. **The review follow-ups** (#4149, #4151, #4154): among them a task she launched that
   goes quiet and is reported by nobody, the dashboard that stays reachable with Tab
   under the room, and the smoke check's watchdog that switches itself on.
6. **Process** (R7-F1, R7-F6): in the playbook, done in this branch.
7. **Small layout** (R7-F8): the top bar at the page's 1000 px minimum.

Carried over from run 6 and still open: her voice path (the nine-second wait, the
per-project mute), questions without Telegram, a conversation owned by the server, and
Talk never having been switched on in any of these runs.

## Implementation (Phase 4)

### Landed: the work of runs 5 and 6 (PR #4148)

The operator's answer to the early push question was "Push, open PRs, merge when gates
pass". The integration branch of run 6, brought up to today's `main`, went out as one pull
request: **#4148, "feat(lucy): a docked chat column, three confirmed actions and a written
briefing"**, 126 files, squash-merged into `staging` as `94f748cd8` at 23:36 on 17 November. The
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
| Follow-ups | Twelve larger defects in one issue, #4149 (ten from round 1, two from the delta review) |

Run 6's RFC listed two checks as not done. "ESLint was not run" has no remedy: the
repository has no ESLint (`pnpm exec eslint` fails because there is nothing to run). "The
whole suite was not run on the merged tree" is now the integration train's job.

### Cluster A: she remembers what she said, names her card's buttons, launches in Kookr (R7-F3, R7-F4; issues #4143, #4144)

Pull request **#4150**, squash-merged into `staging` as `6ef60c8f4` (branch
`fix/lucy-remembers-notices`, 44 files, rebased onto `staging` after #4148 merged). Its
review took three rounds: round 1 blocked on a second sentence under one record entry
keeping the first one's time, and on the untested line that hands a permission notice to
the record; round 2 on a repeated launch report still shown as old, and on a doc claim
about where the command sits on the line; round 3 passed. The same fix commit steadied
three tests that read an audit file as soon as it existed (one had failed once in the
room branch's push gate). One larger follow-up is #4151: she may quote the command in a
typed reply, and her replies are kept in the conversation's history.

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

### Cluster B: Lucy's room and a wider column (R7-F2, R7-F7)

Pull request **#4153**, squash-merged into `staging` as `39c2d5448` (branch
`feat/lucy-room`, 26 files, rebased onto `staging` after #4148 merged). Its review took
three rounds: round 1 blocked on five small defects (the dashboard's keys were held back
on the saved flag and not on the room being on screen, so a panel that failed to render
left them dead; another tab switching the panel off left this tab's room flag set; focus
lost when leaving on a narrow window; focus pulled out of an open dialog; one untested
guard); round 2 on the missing test of the real panel's "room shown" report; round 3
passed. Two larger follow-ups are in #4154: the dashboard under the room can still be
reached with Tab, and a clip that starts in a room entered from the bubble is logged as
"minimized". Screenshots: https://claude.ai/artifact/RXsdFs1v1UzZus39DbYyXu (owner-only).

**Lucy's room.** A fourth layout beside the sheet, the floating column and the docked
column: she covers the whole window, and the dashboard stays mounted underneath. From
1100 px wide the room has a slim header, the conversation in a centred reading column of
at most 760 px with a larger composer under it, and a side rail (400 to 520 px) holding
her 3D view at about 280 px tall above what waits on the operator: permission cards
first, then every question a task waits for as an open card, then opinion requests folded
under one line. Below 1100 px it is one column. An **Expand** button in the column's
header enters it and **Back to dashboard** leaves it; a rebindable shortcut does the same
(Alt+Shift+L, Cmd+Ctrl+Shift+L on macOS); `/?lucy=room` opens the dashboard with her in
the room and is then removed from the address. The room is kept per browser tab, so the
dashboard can stay in one window and Lucy in another on a second screen. Nothing is
unmounted by the switch: the 3D view is not rebuilt, a half-typed message stays, and the
briefing is not asked for again. "Open task" on a card leaves the room, so the task is
visible beside her column.

**A wider column.** The docked column may take what is left once the page has its
1000 px, up to half the window: 560 px at 1560, 920 px at 1920, 1280 px at 2560. In a
wide column the conversation and composer stay 760 px wide, centred.

**Also in this cluster.** The "Open task" fix (R7-F7); while the room covers the
dashboard, the dashboard's own keys (Enter, Escape, the Alt shortcuts) do nothing, so
they cannot act on a task that is out of sight; two panel actions, `expand` and
`collapse`, are recorded, so the next run can count how the room is used.

**Seen in a browser** (throwaway server, real model, 24 screenshots in
`/tmp/kookr-ux-shots/r7/room/` at 2560, 1920, 1440, 1000 and 420 px wide): the room with
a permission prompt and six questions waiting, after two typed turns with list answers,
with nothing waiting, and the column at its new widest. The implementer changed five
things after looking at its own screenshots: a short conversation now sits at the foot,
beside the composer; bubbles and composer share the same edges when the thread scrolls;
the rail keeps its width when its scrollbar appears; entering is a 180 ms fade of the
conversation, with no wipe that would show the dashboard resizing underneath; with only
opinion requests left the rail says "Nothing is waiting on you." above them.

**Tests.** `pnpm typecheck` clean; 29 files, 694 tests of the avatar, preferences,
shortcut, telemetry, settings and design-token suites pass, 61 of them new for the room;
four new browser tests (enter, type, rail and leave; the address and the shortcut; Open
task; scroll position across the switch); seven mutations of the new behaviour each fail
a test.

**Not verified.** The switch animation frame by frame, a real GPU (the screenshots are
software-rendered), the macOS shortcut on a Mac, a screen reader. The dashboard under the
room has its keys blocked but can still be reached with Tab, as under the full-width
sheet today. At 2560 px the reading column leaves 640 px of margin on each side.

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
  test nits left). Ten larger defects go into one follow-up issue.
- 2026-11-18 — **Landing: two failed pushes.** The gate's smoke lane rejected the first;
  my own ten-minute limit killed the second in its test lane, both on a host at load 25 to 62 (R7-F6). Added the three state files to the smoke
  allow-list and corrected one doc sentence (`36693a7af`, `94405e0b5`); the delta was
  reviewed and passed on `94405e0b5`. Third push started with no time limit.
- 2026-11-18 — **Landed.** Third push passed the fast gate (406 related test files, 8,992
  tests, smoke). Browser specs 30 of 30 on the final head. Opened #4148, filed the
  review's twelve larger defects as #4149, posted the round-1 BLOCK record and the final
  PASS, and ran `kookr merge 4148`: retargeted to `staging` and squash-merged as
  `94f748cd8`.
- 2026-11-18 — **Cluster A reported and rebased.** The notices implementer finished
  (three commits, real-model before/after in its report). Rebased onto `staging` with no
  conflict; its independent review and a re-run of its tests are in progress.
- 2026-11-18 — **Cluster A reviewed.** #4150 opened for #4143 and #4144 (fast gate: 59
  related test files, 1,545 tests, smoke). Round 1 of its review blocked on two small
  defects (a second sentence under one record key kept the first one's time; the line
  that hands a permission notice to the record had no test); a patch agent is fixing them.
  One larger follow-up filed as #4151.
- 2026-11-18 — **Cluster B reported.** The room implementer finished (four commits, 24
  screenshots, R7-F7 and R7-F8 found on the way). Rebased onto `staging` with no conflict;
  its independent review and a re-run of its tests and browser specs are in progress.
- 2026-11-18 — **The train.** `staging` holds #4148; the integration train is still busy
  with an unrelated dependency bump (#4146) that it reverted as the cause of a red run, so
  `main` has not moved yet.
- 2026-11-18 — **Cluster A merged.** Round 2 of #4150's review blocked on two more small
  defects; fixed (`d99ef200b`), round 3 passed, `kookr merge 4150` squash-merged it into
  `staging` as `6ef60c8f4`.
- 2026-11-18 — **Cluster B merged.** #4153 opened (fast gate: 368 related test files,
  one audit test flaky on its first run; browser specs 34 of 34). Round 1 blocked on five
  small defects, round 2 on one test gap, round 3 passed; `kookr merge 4153`
  squash-merged it into `staging` as `39c2d5448`. Follow-ups filed as #4154.
- 2026-11-18 — **Deployed.** The train promoted #4148 to `main`, and production updated
  itself to a `main` that contains it while this run was still working.
- 2026-11-18 — **Phase 5.** Playbook lessons of this run are in this branch (ask the push
  question early, look for unpushed work first, review a large stack in parts, push in the
  background with no time limit, rebase stacked clusters onto `staging` once their base
  has merged). Stopped the throwaway servers and their stand-in agents.
