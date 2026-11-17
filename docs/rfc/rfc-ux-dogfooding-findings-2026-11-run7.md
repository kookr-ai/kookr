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

## Things that worked well (keep-list)

## Suggested priority order

## Implementation (Phase 4)

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
