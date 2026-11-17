# RFC: UX Dogfooding Findings — November 2026 (run 6: Lucy as JARVIS)

- **Status**: Draft (living document, updated after every finding)
- **Author**: Claude (Fable 5.2), dogfooding session on the operator's live dashboard
- **Date**: 2026-11-17
- **Base**: `origin/main` @ `52bdaef95` (worktree `kookr-dogfood-202611-run6`)
- **Focus** (operator's brief): "Focus on lucy panel … which needs a full overhaul. End goal
  is lucy being as helpful as jarvis: being proactive, when she speaks/interact with the user
  it is always to ask for added value, the chat is nice, the interface is smooth, the panel
  for interacting with it is nice, the actions lucy can take are making it her really useful."
- **Relation to run 5**: run 5 (2026-11-16, same panel) wrote 14 findings (L-F1 to L-F14)
  and implemented two of its four clusters on local branches that were never pushed. Its RFC
  is on branch `rfc/ux-dogfooding-202611-run5`, not on `main`. This run does not re-measure
  what run 5 measured. It (a) reconciles run 5's findings against today's `main`, (b) uses
  run 5's unpushed column as the build under test, and (c) measures the four things the new
  brief adds: does she add value when she speaks, is the chat good, is the panel smooth, and
  can she do anything useful.
- **Method**:
  1. Read the operator's own history with Lucy from `~/.kookr/lucy-interactions.jsonl`
     (294 records, 2026-11-11 to 2026-11-17): everything she said, whether it was played,
     and every panel action.
  2. Talk to the live Lucy through `POST /api/lucy/turn` in my own conversation ids (look-only
     turns and refused action requests; nothing on the operator's dashboard was clicked).
  3. Merge run 5's two branches onto today's `main` in a fresh worktree
     (`kookr-lucy-jarvis-base`), run it on a throwaway server, and use the column as a user.
  4. Root-cause each medium/high finding to `file:line` on `origin/main`.

## Summary

Run 5 said "Lucy's brain is ahead of her window". Six days of the operator's own log say
the rest: she is not used. The operator moved her window 76 times and typed to her zero
times; asked her to do something twice and was told no twice; 15 of the 30 things she said
on her own were never played, and the ones that played read a whole question and every
choice aloud for 16 to 45 seconds about decisions that blocked nothing. Run 5's unpushed
column fixes the window. Used for real, it showed what was still missing: the conversation
read like a log, she said nothing on opening, and every request to act ended with the
operator doing the work.

Sixteen findings (J-F1 to J-F16), in four families:

- **Does she add value when she speaks** (J-F1, J-F4, J-F9, J-F15): mostly unheard, too
  long, silent on opening, one report said twice.
- **Is the chat good** (J-F3, J-F7, J-F8, J-F10, J-F11): a transcript, English only, no
  sign of what she is doing, lost in a new tab.
- **Is the panel smooth** (J-F2, J-F13, J-F14, J-F16): moved more than used; tiny controls.
- **Can she do anything** (J-F5, J-F6, J-F12): three refusals and one invented control.

Three clusters were built on top of run 5's two branches and merged on
`feat/lucy-jarvis-integration`. On that build, on a throwaway server: she opens with a
written briefing and follow-up buttons; the thread is a chat; she answered a task's
question and typed a reply into a task after one confirming press each (both verified in
the server's state and audit log); asked in French she answered in French; asked to
snooze she said there is no snooze. Nothing is pushed.

## Run 5 findings against today's `main`

`main` moved 16 commits since run 5's branches were cut; none of them touches the panel
layout. Run 5's two branches merge onto `52bdaef95` with no conflict; on the merged tree
`tsc -p .` is clean and the 32 Lucy, avatar, store and asks test files pass (886 tests).

| Run 5 finding | On `main` today | Where a fix exists |
|---|---|---|
| L-F1 question cards do not fit (high) | open | `feat/lucy-operator-column` (unpushed) |
| L-F2 finished-task questions shown as waiting (high) | open | both run-5 branches (unpushed) |
| L-F3 newest first (medium) | open | `feat/lucy-operator-column` |
| L-F4 window covers controls, no resize (medium) | open | `feat/lucy-operator-column` (docked from 1320 px) |
| L-F5 `GET /api/asks` has no task name (low) | open | `feat/lucy-question-awareness` |
| L-F6 launch card 8 px tall (high) | open | `feat/lucy-operator-column` |
| L-F7 one reply, four lines, no thread (high) | open | `feat/lucy-operator-column` |
| L-F8 she sees 4 of N questions (high) | open (re-observed today, J-F6) | `feat/lucy-question-awareness` |
| L-F9 she cannot act (high) | open (re-observed today, J-F5) | `feat/lucy-actions` (this run): answer, reply, close; snooze not built |
| L-F10 lists projects she then refuses (medium) | open | `feat/lucy-question-awareness` |
| L-F11 one reply style, English only (low) | open (re-observed today, J-F7) | `feat/lucy-actions` (this run), typed turns |
| L-F12 3D view squeezed to 56 px (low) | open | `feat/lucy-operator-column` |
| L-F13 speaks first for three events, nothing kept (medium) | open | `feat/lucy-speaks-first` (this run), written only |
| L-F14 two tabs speak at once (low) | open (re-observed in the log, J-F4); a one-tab claim exists, so the cause is unknown | not started |

## Findings

### J-F1. Most of what Lucy says unprompted is never heard, and what is heard runs 16 to 45 seconds (proactivity / value) — severity: high

From the operator's own interaction log, every clip Lucy started on her own since the
question announcements shipped (2026-11-13):

| What she said unprompted | Clips | Never played | Played to the end | Length |
|---|---|---|---|---|
| A task's question (`operator_ask`) | 24 | 15 (62%) | 9 | 32 to 86 words, median 53; 15.8 to 45.2 s, median 24 s |
| A task waits on a permission prompt | 2 | 0 | 2 | 5.5 and 8.8 s |
| A task she launched finished | 4 (2 texts, each twice) | 0 | 4 | 6.5 and 9.1 s |

- All 15 unplayed clips have the same reason, `audio_suspended`: the browser had not been
  clicked since the page loaded, so it refused to start sound. They are the 15 questions
  asked between 02:15 and 06:08 on 2026-11-16, while the operator was away. The text of an
  unplayed clip is kept, but on `main` only in a list of the last three messages
  (`src/frontend/audio/last-clip.ts:21`) that is hidden while any question is pending
  (run 5, L-F2): twelve of the fifteen were gone and the other three were not visible.
  There is no catch-up when the operator comes back.
- The 9 that played were never stopped early (`endedBy: finished` on all 26 clip endings in
  the log). A 24-second clip is the whole question and every choice read aloud:
  `"The task <name> needs your input. <question>. You can answer: A: …, B: …, C: …."`
  (`src/core/operator-asks.ts:106-110`). #3632's rule is "about 25 words when she
  interrupts"; the median is 53.
- Every one of the 24 was an opinion request from a task that carried on with its own
  recommended option (run 5, L-F2). So the longest thing she says is about the least urgent
  thing in the dashboard.

Against the brief ("when she speaks it is always to add value"): 15 of 30 unprompted
messages reached nobody, and the 9 question clips that played cost the operator about
4.1 minutes of listening for decisions that blocked nothing.

Suggested fix: she writes first and speaks second. Every unprompted message is a line in
the conversation thread whether or not sound could start. Aloud she says one sentence
(who asks, what about, whether anything is blocked) and leaves the choices to the card:
"The quota pill task wants your pick between three layouts; nothing is blocked." Opinion
requests from tasks that carried on are not spoken one by one; they are counted in the
next briefing.

### J-F2. More than half of everything the operator does with the panel is moving it out of the way (interface) — severity: high

137 panel actions in the log: 76 `move` (55%), 29 `restore`, 27 `minimize`, 4 `replay`,
1 `enable`. In one stretch on 2026-11-11 a single spoken summary was followed by 14 moves,
4 minimise/restore pairs and one replay. The operator's most frequent interaction with Lucy
is getting her window off whatever is underneath. This is run 5's L-F4 measured from the
operator's side, and the strongest argument for the docked column: a column has no `move`.

Root cause: `position: fixed` floating window with no layout room reserved (run 5, L-F4).

### J-F3. The operator has never typed to Lucy and has not completed a spoken exchange since 13 November (chat / discoverability) — severity: high

- Typed turns in the log: 14, and all 14 are run 5's own test conversations
  (`dogfood-r5-*` and one `typed-…` it typed in the panel). The operator: 0.
- Spoken turns (Talk): 13. Five were answered, four ended `interrupted` with no words
  heard, three ended `error` ("the speech recogniser failed (Speech recogniser took too long
  to answer)"), one was empty. The last answered one is from 2026-11-13.
- Time from the end of the operator's sentence to her first sound, in the five answered
  turns: 2.9, 8.7, 9.0, 9.2 and 10.2 s. The same question typed through the API gets its
  first words in 1 to 3 s (keep-list), so the wait is in the voice path, not the model.
- What the operator asked, in order: "How are you, Lucy?", "Can you tell me which tasks
  require my attention right now?", "How are you?", **"Suggest some solutions based on your
  findings and implement them."**, "Hello, how are you?", "What can you do?". The two real
  requests got "I can only report status for now, so I can't implement anything" and "I can
  report task status out loud … I can't start, stop, or change anything yet."

The operator tried her six times, asked her to do something twice, was told no twice, and
stopped. Nothing in the panel says what she is good at today (she can now launch, read a
terminal, and brief), so there is no reason to try again.

Suggested fix: the empty thread shows what she can do as things to press (see J-F8), she
opens with a briefing instead of waiting to be asked, and the list of things she must
refuse gets shorter (J-F5).

### J-F4. Her "it finished" report is said twice, six seconds apart, and each half is recorded twice (proactivity) — severity: medium

The one task she has launched for an operator-facing flow (run 5's README audit) produced,
in the log:

- 22:04:38 "The task I started "Audit README commands and environment variables" needs you." (two `said` records)
- 22:04:44 "The task I started "Audit README …" says it is done and is waiting for you to look at it." (two `said` records)

The first sentence says nothing the second does not, and "needs you" does not say why. The
doubled records are two dashboard tabs (sessions `2026-11-15T23-40-36-156Z` and
`2026-11-16T21-49-58-934Z`) that each fetched and played both clips to the end, 200 ms
apart (run 5, L-F14). A one-tab claim has existed since 2026-11-13 (a Web Lock plus a list
in `localStorage`, `src/frontend/audio/ask-announcement.ts:110-150`), so either it did not
hold here or the two tabs were in different browser profiles, where it cannot; not
root-caused.

Root cause of the wording: `src/server/lucy-operator/launch-controller.ts:545-558` has one
sentence per task event and `onTaskOutcome` (`:493-521`) reports each event as it arrives:
the finding observer's `needs_input` (`src/server/index.ts:810-820`) and the completion
signal's `completion_ready` (`:4628-4645`) are two events for one "it is done". A related
defect found while mapping: the announcement is deduplicated per task and kind
(`ask-announcement.ts:220-225`, key `report:<taskId>:needs_input`), and the key stays in
the 20-entry list, so a second "needs you" for the same task five minutes or more later is
never spoken and never reaches the conversation.

Suggested fix: one report per finished task, saying the outcome in one clause taken from
the task's closing summary ("…finished: 3 of 14 documented commands no longer exist"), and
one tab speaks.

### J-F5. Asked to act, she says no, and twice points at a control that does not exist (actions) — severity: high

Typed to the live Lucy today (conversation `dogfood-r6-a`):

| Asked | Answer |
|---|---|
| "Reply to the task that is waiting on me and tell it to go with its recommended option." | "I can't reply to tasks, so I can't send that. You answer on the question card in the panel or on Telegram…" |
| "Close the finished tasks that I have nothing left to review on." | "I can't close tasks, so I can't clear those out for you. You can close them from the board yourself…" |
| "Snooze the opinion questions until tomorrow." | "I can't snooze anything, questions included. **Snoozing is done from the question card in the panel or on Telegram**…" |
| "Which finished tasks have a PR that is still open and not merged?" | "I can't tell you that: I have no way to see pull request status, and I can't scan all 152 finished tasks." |
| "Open the one you think I should look at first." | "I can't open a question card, only a task, and I don't have a basis to rank the finished ones." |

There is no snooze on a question card or on Telegram (`git grep -i snooze` over
`src/frontend/avatar`, `src/server/asks`, `src/shared/contracts/asks.ts` and
`src/integrations/telegram` returns nothing). She sends the operator to look for a button
that was never built. "Close them from the board yourself" is true, and is the whole
problem: every answer ends with the operator doing the work.

Root cause: `src/core/lucy-operator/prompt.ts:23` ("You cannot reply to, close, snooze,
approve or stop a task") and `:28` ("you cannot answer it and you cannot take their answer
by voice"). Her seven tools are six look-ups and `propose_launch`
(`src/shared/contracts/lucy-turn.ts:47-51`). The proposal card and its confirm/decline
routes are launch-only (`src/server/lucy-operator/launch-controller.ts`,
`src/server/routes/lucy-operator-routes.ts:134-136`). Task delivery state (PR open, merged)
is on the task record but not in any tool result.

Suggested fix: rungs 1 and 2 of #3632's ladder for the conversation, behind one general
"proposal" card: answer a task's question (with a read-back), reply to a task, close a
finished task. Each is proposed by a tool, shown as a card that states exactly what will
be sent, and carried out only on the operator's confirmation, on the server. Her look-ups
gain what a task delivered (PR number and state).

### J-F6. She can still read only four of the waiting questions (awareness) — severity: high (run 5 L-F8, re-observed)

"For each of the ten waiting questions, tell me in a few words what it asks and what you
would pick." → "I can only see four of the ten; the other six aren't shown to me." She
then spent 7.8 s and seven look-ups reading tasks to reconstruct four recommendations.
`MAX_BOARD_ASKS_PENDING = 4` (`src/core/lucy-operator/board.ts:64`). Fixed by the
`read_questions` tool on run 5's unpushed `feat/lucy-question-awareness`; this is the
single strongest reason to land that branch.

### J-F7. Asked in French, she answers in English (chat) — severity: low (run 5 L-F11, re-observed)

"Qu'est-ce qui a besoin de moi maintenant ?" → "Nothing needs your approval right now. But
ten task questions are waiting on you…". `prompt.ts:41`: "Answer in English." The typed
reply to "for each of the ten questions…" came back as one 70-word paragraph because of
`:39` ("No lists, no markdown"), which is right for speech and wrong for a text box.

### J-F8. On run 5's column, the conversation is a transcript, not a chat (chat) — severity: high

Used the unpushed column (`feat/lucy-operator-column` merged onto today's `main`) on a
throwaway server with six tasks and six questions, at 1600 x 1000. The thread works: it
keeps every typed turn and survives a reload. What it looks like
(`/tmp/kookr-ux-shots/r6/11-dock-closeup.png`):

- Each turn is a full-width strip starting with a monospace label, "You" or "Lucy", then
  the text (`src/frontend/avatar/LucyThread.tsx:98,108`). Nothing separates who is speaking
  except a faint background; there is no time on any line.
- Her answer to "for each waiting question, what does it ask and what would you pick" is
  one paragraph of 88 words covering six questions. She recommends six picks; none of them
  is something to press. The question cards she is talking about are in a different region
  of the same column.
- While she works there is no sign of what she is doing. The turn stream carries
  `tool_call` events (she is reading a task's terminal); the thread shows nothing until
  text arrives.
- Three scroll regions share the column (tray, thread, and the open card inside the tray).
  At 1600 x 1000 with three questions the tray takes 444 px and the thread 337 px; with the
  opinions row open, 500 and 281. At 1280 x 800 the open card's last line is below the
  tray's fold again, and at 620 px of height the thread shows about six lines
  (`src/frontend/styles.css:17461-17464`: tray `max-height: 50%`; `:17320-17323`: thread
  `min-height: 72px`). The first card opens by itself, so the tray is at its tallest on
  every load.

Suggested fix: a real chat surface. Her messages and the operator's are visually distinct
and timestamped; a typed reply may contain a short list; what she is doing shows as one
quiet line while she works; anything she recommends that she can do comes with a button;
and the waiting tray is a compact strip that opens one card on demand instead of holding
half the column.

### J-F9. She says nothing when her panel opens, and the empty thread explains a feature from the first slice (proactivity) — severity: high

On opening the dashboard with three tasks blocked on a question, the thread reads: "Press a
speaker button on a task and I will read its summary to you."
(`src/frontend/avatar/LucyThread.tsx:27`). The composer's placeholder is "Ask Lucy to look
into something". Nothing says she can brief, read a terminal, recommend, or start a task,
and she does not offer the briefing she gives so well when asked (keep-list). #3632's
table has "the dashboard is opened, or the operator returns from a break → offers the
briefing"; it is not built. This is the other half of J-F3: nothing invites the first
message.

Suggested fix: on open, and on return after a break, she posts a short written briefing
built from the board without a model call ("3 tasks wait on your answer, 3 opinions wanted,
nothing running"), with two or three buttons under it for the obvious next steps ("Walk me
through the questions", "What should I do first?"). Spoken only if sound is already
allowed.

### J-F10. What she did and what she reports land outside the conversation, and the same request is shown three times (chat / actions) — severity: medium

Asked her to start a read-only task. In 300 px of column the request appears three times:
her reply ("I will launch an investigation in billing-api: List the unused exports … Say go
to start."), the card's description (the same sentence), and the card's "You asked" line
(the operator's sentence again). After Go, the card is replaced by a strip above the
composer: "Started · Open task · Dismiss", then "The task I started needs you. · Open task
· Dismiss" (`src/frontend/avatar/LucyLaunchCard.tsx:151,162`). Neither line is in the
thread, the second does not name the task or say why it needs the operator, and Dismiss
erases the only record that she launched something.

Suggested fix: actions are thread entries. The proposal is a card in the conversation
under a one-line reply; its outcome ("Started Find unused exports · Open") replaces the
buttons in place and stays in the history; her report is a normal message.

### J-F11. The conversation belongs to one browser tab (chat) — severity: medium

Opening the dashboard in a new tab (same browser profile) shows an empty thread: the
entries are kept in the tab's `sessionStorage`
(`src/frontend/store/lucy-conversation.ts:11,61`) and the conversation id is per page. The
server keeps the last 20 messages of each conversation
(`src/server/lucy-operator/service.ts:22`) but there is no way to read them back. Closing
the tab loses what she said, including anything she said unprompted.

Also seen: a new question arrived while I was typing. Focus and the half-typed text were
kept (good), a row appeared in the tray, and nothing was added to the thread. The thread
gets her unprompted words only through a fetched clip
(`src/frontend/avatar/useThreadSync.ts:102-119`): with sound off, Do Not Disturb or a
browser that blocks audio the text is still written (marked unheard), but when the speech
service is missing or fails, when another tab holds the claim, or when the panel is
switched off, nothing is written at all. A clip that was never played is still labelled
"said aloud" (`LucyThread.tsx:148`).

Suggested fix: unprompted messages are written to the thread at the moment they are
decided, before any audio is attempted; the thread is kept per browser profile rather than
per tab. A server-owned conversation is the longer-term answer.

### J-F12. Task questions do not exist without Telegram (onboarding) — severity: medium

Seeding the throwaway server: `POST /api/asks` → `503 {"error":"Telegram is not configured;
`kookr ask` is unavailable.","code":"not_configured"}`
(`src/server/routes/ask-routes.ts:83-87`). Lucy's question cards, the waiting tray and her
"what needs me" answers all depend on a service that is only built when a Telegram bot
token is set. An operator who uses the dashboard and Lucy but not Telegram gets no
questions at all, and a task that calls `kookr ask` is told the feature is unavailable.

Suggested fix: the dashboard is a delivery channel in its own right; build the ask service
whenever either channel exists, and drop the "Also on Telegram" note when it does not.

### J-F13. The header's three controls are 22 px icons, and Talk's tooltip is a configuration dump (panel) — severity: low

The column header holds three unlabeled 22 x 22 px icon buttons (Talk, Replay, Minimise).
When Talk is unavailable its tooltip is 300 characters: "Lucy live needs the speech
recogniser (set KOOKR_LUCY_EARS=true to let Kookr run it, or KOOKR_LUCY_EARS_URL for one
you run; see lucy-ears/docker-compose.yml); the helper model (set KOOKR_BASETEN_API_KEY or
BASETEN_API_KEY); the speech service (enable KOOKR_TTS or set KOOKR_TTS_URL)." Talk is the
main way to reach her by voice and is the smallest target in the column.

Suggested fix: Talk moves next to the composer as a labeled button of normal size; when it
is unavailable it says "Talk is not set up" and links to Settings.

### J-F14. "N agents waiting for input" overlaps "Skip All" in the task list (layout, not Lucy) — severity: low

At window widths of 1280 to 1600 px on run 5's build (column docked or floating) the
grouped "SIGNALED COMPLETE" row in the task list wraps "3 agents waiting for input" one
word per line, on top of the "Skip All" button
(`/tmp/kookr-ux-shots/r6/09-overlay-1280.png`). At 1280 px the page has its full width, so
the overlap is in the task list itself; the docked column makes it the normal case, because
the page keeps 1000 px. Fixed on `feat/lucy-chat-surface` (`11068080a`): the count stays on
one line and the buttons move under it when there is no room.

### J-F15. Her voice skips two of the gates the chime goes through (proactivity) — severity: low

#3632: "She goes through the same gate as the completion chime (sound off, do-not-disturb,
per-project mute) and logs each decision the same way." Sound off and Do Not Disturb are
checked (`src/frontend/audio/ask-announcement.ts:331-337`). The per-project mute is not:
`isProjectNotificationMuted` has three callers, all chimes and notifications
(`useAudibleAlert.ts:279`, `useTaskCompletionChime.ts:82`, `useNotifications.ts:56`). Her
unprompted clips are also absent from the audio-alert log (`audio-alert-log.ts:3`,
`AudioAlertSource` has no Lucy value). A project the operator muted still gets its
questions read aloud. Found from code, not observed. Not fixed in this run: the file is
being changed by another task (#4015).

### J-F16. Pressing Go shows nothing for 10 to 20 seconds (actions) — severity: low

Found while checking the merged build: after pressing Go on Lucy's launch card the card
stayed as it was, with its two buttons dimmed, until the launch finished (about 20 s on
the throwaway server; the same step took 9.4 s on the live dashboard in run 5's log). A
dimmed "Go" reads as a button that did nothing. Root cause:
`src/frontend/avatar/LucyLaunchCard.tsx` only sets `aria-disabled` while the confirm request
is pending. Fixed on the integration branch (`09b940828`): Go reads "Starting…" and is
marked busy.

## Things that worked well (keep-list)

- **The briefing is already good when asked for.** "Good morning Lucy. Brief me." → "One
  task needs you: a benchmark runner in one of the private projects lost contact with Kookr.
  Ten questions are waiting on their cards, twelve tasks are working, and the 7-day quota is
  at 82 percent." First words after 2.8 s, one look-up. This is the sentence she should say
  without being asked.
- **She investigates before recommending.** "What is the single most valuable thing I could
  do in the next five minutes?" → she read the lost task's terminal and answered "its
  terminal shows it is still alive and working, so it may just need reattaching rather than
  restarting. Want me to put it on your screen?" Three look-ups, 6.2 s.
- **She is honest about limits** ("I can only see four of the ten", "I have no way to see
  pull request status") rather than inventing an answer. The one exception is J-F5's snooze.
- **Run 5's column removes the worst of the old window.** In use the composer was always
  reachable, the launch card's Go and Cancel were on screen, a question arriving
  mid-sentence did not steal focus or the half-typed text, and a reload kept the thread. It
  is the right base to overhaul, not something to redo.
- **With `read_questions` she reads every question.** On the merged build the same "for
  each waiting question…" request that got "I can only see four of the ten" on `main`
  returned all six, with a pick for each.
- **Run 5's branches hold up**: both merge onto today's `main` without conflict, typecheck
  and pass their suites.

## Suggested priority order

Grouped into clusters that can each ship as one PR, in merge order. Clusters 1 and 2 are
run 5's unpushed branches; nothing below works without them.

1. **Lucy sees everything that waits** (run 5: L-F2, L-F5, L-F8, L-F10; J-F6). Branch
   `feat/lucy-question-awareness`, unchanged. Server and core only.
2. **Operator column** (run 5: L-F1, L-F3, L-F4, L-F6, L-F7, L-F12; J-F2). Branch
   `feat/lucy-operator-column`, unchanged.
3. **A real chat surface** (J-F8, J-F10, J-F11, J-F13, the panel half of J-F9). Bubbles
   with times, a line that says what she is doing, short lists, the waiting tray as a strip,
   proposals and reports inside the conversation, an inviting empty state, a labelled Talk
   button, the conversation kept per browser profile.
4. **Lucy acts** (J-F5; run 5 L-F9; J-F7 / L-F11). Answer a task's question, reply to a
   task, close a finished task: each proposed on a card and carried out on the server only
   after the operator confirms. Look-ups report what a task delivered (PR state). Typed
   replies may use a short list; she answers in the operator's language; she stops pointing
   at controls that do not exist.
5. **Lucy speaks first, in writing** (J-F1, J-F4, J-F9, J-F11; run 5 L-F13). A briefing
   when the dashboard opens and after a break, built without a model call; a written line
   for every unprompted message whether or not sound could start; one short spoken sentence
   for a question; a word when a task fails, stalls or finishes and wants review, grouped;
   one report per finished task that says why.
6. **Not started**: questions without Telegram (J-F12), her voice and the per-project mute
   (J-F15), the
   voice path's 9-second wait (J-F3), a server-owned conversation (J-F11's longer-term fix).

## Implementation (Phase 4)

All branches are local and **not pushed**. `feat/lucy-jarvis-integration` is the branch to
look at: it holds everything below merged together.

| Branch (worktree) | Cut from | Cluster | Findings |
|---|---|---|---|
| `feat/lucy-question-awareness`, `feat/lucy-operator-column` (run 5) | `origin/main` | 1, 2 | run 5 L-F1 to L-F8, L-F10, L-F12; J-F2, J-F6 |
| `feat/lucy-jarvis-base` (`kookr-lucy-jarvis-base`) | `origin/main` @ `52bdaef95` | merge of the two above, no conflict | |
| `feat/lucy-chat-surface` (`kookr-jf8-lucy-chat-surface`) | `feat/lucy-jarvis-base` | 3. A real chat surface | J-F8, J-F10, J-F11, J-F13, J-F14, panel half of J-F9 |
| `feat/lucy-actions` (`kookr-jf5-lucy-actions`) | `feat/lucy-jarvis-base` | 4. Lucy acts | J-F5, J-F7; run 5 L-F9, L-F11 |
| `feat/lucy-speaks-first` (`kookr-jf1-lucy-speaks-first`) | `feat/lucy-jarvis-base` | 5. Lucy speaks first, in writing | J-F1, J-F4, J-F9, J-F11; run 5 L-F13 |
| `feat/lucy-jarvis-integration` (`kookr-lucy-jarvis-integration`) | `feat/lucy-chat-surface` | everything merged, plus J-F16 | |

**Cluster 3, what changed.** The thread is a chat: her bubbles on the left, the operator's
on the right, each with a time. While she works one quiet line says what she is doing
("Reading a task's terminal…", then "Looked at 3 things"). A typed reply may contain a
short list. The "Waiting on you" tray is one folded line ("3 waiting on you · 3 opinions
wanted"); unfolding shows the rows, pressing a row shows the card, and no card opens by
itself. The conversation always keeps 45% of the column, and at 1280 x 800 an open card
with three choices is fully visible (the 3D view gives up its height to make that true).
Her launch card, what became of it and her report of the finished task are entries in the
thread; "Dismiss" is gone. An empty thread greets with three buttons. The composer grows
to five lines, Talk is a labelled button beside it, and the conversation is kept in
`localStorage`, shared by every open tab. The task list's grouped row no longer wraps its
count over its buttons (J-F14).

**Cluster 5, what changed.** A question is announced in one sentence of at most 25 words
("The task Billing migration needs your input: Run the table rename on production now?
Three choices are on my card.") instead of the question and every choice. `GET
/api/lucy/briefing` builds a briefing addressed to the operator without a model call; the
panel writes it when it is first shown and when the operator returns after ten minutes
away, and not again while nothing changed. The server writes one line in her thread when a
task she did not launch fails, goes quiet or loses contact (at once, further ones grouped
over two minutes), and when a task says it is finished and is still waiting ten minutes
later. Her words are written when no clip could be fetched. A task she launched gets one
report, which says what it waits for. Nothing new is spoken in this cluster.

**Cluster 4, what changed.** Three new tools, `propose_answer`, `propose_reply` and
`propose_close`, each ending the turn with a card that states exactly what will happen and
waits for Send or the operator's "go"; nothing counts down, at any autonomy level. The
model's arguments are selectors only (which task, which question, which choice), checked on
the server; the text of a reply or of a free-text answer is written by a separate call
that sees only the operator's own sentences, never what she read from tasks. On confirm
the server re-checks that the question is still waiting with the same choices, that the
task is in a state that allows it and that its session is live, then calls the same
functions the dashboard uses (`OperatorAsksPort.answer`, `submitMessage`, `completeTask`),
attributed to `lucy-operator` in the audit log. Look-ups say what a task delivered ("PR
#12 merged"). Her prompt no longer says she cannot reply or close, allows a short list in
a typed reply, answers in the operator's language, and forbids pointing at a control the
instructions do not name. On the integration branch the card sits in the conversation and
what became of it stays there as one line ("Reply to Invoice export bug: Sent · Open
task").

**Fixes made on the integration branch after the merge** (they exist only there): Go reads
"Starting…" (J-F16); the action card's outcome is a line of the conversation; a spoken
reply stays in English, because her Talk voice only speaks English, and the language rule
applies to typed turns; a permission prompt unfolds the waiting strip by itself, since she
says "the command is on my card"; a test that two tabs told the same thing at the same
moment leave one line.

The ten-minute hold on "wants your review" comes from a measurement made during review:
on the live instance 94 tasks signalled finished in the last 24 hours and 91 of 92 were
closed by the system within ten minutes (median 137 s). Written at once, that line would
have appeared about 94 times a day and been untrue almost every time.

**Brought up to date with `main`.** `origin/main` gained 11 commits during the run, two of
them in Lucy's code (#4103, her screen-reader region across minimise; #4100, task questions
she never said). They were merged into the integration branch (`14bbae0b7`, four conflicted
files; main's announcer ported into the column). The merge turned up one defect that
mattered: main holds a spoken task question while a launch card waits for its "yes", and
the new answer, reply and close cards are confirmed the same way, so a "yes" meant for a
question read aloud could have sent a reply or closed a task. The hold now covers both
kinds of card (`66e8c430d`, with tests). Two smaller fixes came with it: a question's words
enter the thread only once she has begun to say them (`077546c58`), and a question Talk
gave back is written when its clip cannot be fetched (`49ecf6fdd`). On the final head
`791084df0`: `tsc` clean; 482 files, 7,582 tests pass; the two browser specs pass 30 of 30
with the test server's quota check switched off, and 29 of 30 as normally run, because the
test server reads the operator's real plan quota (96% used, over the 90% launch threshold)
and refuses one of its task launches. That failure is the environment's, not the branch's.

**Verification, on `feat/lucy-jarvis-integration` @ `2c1ca38c8`** (before the merge of
`main`). Run by me after the last cluster merge: `tsc -p .` clean; 481 test files, 7,540 tests pass (all of `src/frontend`, the
Lucy core and server suites, routes, asks, contracts); `check:frontend` reports no new
errors; the documented-routes check passes; `e2e/avatar-panel.spec.ts` and
`e2e/finding-groups.spec.ts` 30 passed, headed under Xvfb. Each implementer also ran its own suites on
its branch (chat surface: 1,002 tests and 25 browser tests; actions: the whole suite,
28,043 passed; speaks-first: 3,661 tests). The merges conflicted in ten files (the
thread store and its test; docs; the dock; the launch controller's interface; route wiring; the
WebSocket message lists), all resolved by hand as unions of both sides.

Used in a browser on a throwaway server (temp home, a stand-in agent, a fake Telegram, the
real operator model), at 1600 x 1000 and 1280 x 800:

| Step | Result |
|---|---|
| Open the dashboard with six questions waiting | Briefing written with three follow-up buttons; tray folded to one line |
| "What should I do first?" | Answer in a bubble; "Looked at 1 thing" above it |
| "Answer the billing migration question: run it tonight." | Card "Answer Billing migration · Your choice: Run it tonight (recommended)"; Send; `/api/asks` shows the question answered with that choice; audit row `ask.dashboardAnswer`, actor `lucy-operator`; the answer was typed into the task |
| "Tell the invoice export bug task to also add a regression test for the last row." | Card "Typed into the task: Also add a regression test for the last row."; Send; the stand-in agent received exactly that line; audit row `lucy.action` |
| "Close the docs link audit task." | Refused: "…is still working: it has not said it is finished, so I will not close it." |
| "Snooze the remaining questions until tomorrow." | "I cannot snooze questions: they have no snooze…" (J-F5's invented control is gone) |
| "Quelles tâches attendent encore une réponse de ma part ?" | Answered in French, as a five-item list |
| Start a task through the card | Go, then "Starting…", then the task appears |
| 1280 x 800, a card with three choices open | Whole card visible; conversation keeps 45% |

**Known gaps.**

- **Closing a task was not exercised end to end.** The stand-in agent cannot raise a
  finished signal, so only the refusal was seen live; the accepted path is covered by the
  controller's unit tests.
- **Not run on the operator's dashboard.** Nothing here is deployed; Talk (voice) was not
  switched on at any point, so the spoken side of the new cards, the 25-word question
  sentence as audio, and the echo rules are covered by unit tests only.
- **The new prompt wording was tried on a handful of turns**, not measured.
- **The model still chooses when to propose and which task, question or choice.** A
  poisoned task could make her propose a wrong choice; the card and the confirmation are
  the gate. Reply text and free-text answers have the second guard (the separate writer).
- **Her voice path is unchanged** apart from the shorter question: the nine-second wait
  (J-F3), the per-project mute (J-F15) and the dropped second "needs you" clip (J-F4) are
  open. Nothing new is spoken: the briefing and the task-event lines are written only.
- **A stall on a task she launched is reported by nobody**, and after a server restart
  her launched tasks get no end report (the controller's memory is in-process).
- **ESLint was not run on any branch** (it fails to start in these worktrees with
  `spawn eslint EACCES`), and the whole test suite was run on the actions branch only, not
  on the merged tree (there: the frontend, Lucy, routes, asks and contracts suites).
- **Review depth.** I read the server wiring of cluster 5 and the confirm path of cluster
  4, and judged cluster 3 by using it and from screenshots; I did not read the three diffs
  line by line (about 12,000 added lines with tests).
- **With Talk on, the operator no longer hears a question's choices** before answering by
  voice; the choices are on the card.
- **No task was launched on the operator's live dashboard in this run**, and the playbook's
  reading-pane items (reply, complete with a rating, a bad working directory) were not
  repeated; runs 1 to 5 covered them.
- **On windows 900 px tall or less the 3D view shrinks to nothing while a card is open.**
- **The action card still shows "You asked"** under the sentence it repeats, and her
  one-line read-back sits above the card; the launch card no longer does either.
- **The documented-routes check does not see routes whose path is a constant in
  `src/shared/contracts`** (`src/core/documented-api-route-verifier.ts`), which includes
  every Lucy route. Found by two implementers independently; not fixed.
- **Questions without Telegram (J-F12)** are not started.

## Session log

- 2026-11-17 — **Phase 1 setup.** Dashboard live at `localhost:4800` (deployed commit
  `52bdaef95`, same as `origin/main`). 202611 already had runs 1 to 5, so this is run 6.
  Run 5 covered the same panel a day earlier; its task finished and its three branches are
  local only. Created this RFC worktree and an integration worktree
  (`kookr-lucy-jarvis-base`, branch `feat/lucy-jarvis-base` = `origin/main` + run 5's two
  branches, merged clean, typecheck and 886 tests green) before driving anything.
- 2026-11-17 — **Phase 2, the operator's history.** Read `~/.kookr/lucy-interactions.jsonl`
  and joined each thing she said to what the panel did with it (J-F1 to J-F4).
- 2026-11-17 — **Phase 2, talking to the live Lucy.** Nine typed turns through
  `POST /api/lucy/turn` in conversations `dogfood-r6-a` and `dogfood-r6-b`: a briefing, a
  "what should I do", three action requests, French, all ten questions, PR state (J-F5 to
  J-F7, keep-list). Nothing was clicked on the operator's dashboard.
- 2026-11-17 — **Phase 2, using run 5's column.** Ran the merged build on a throwaway
  server (temp home, port 4871, a stand-in agent, a fake Telegram, the real operator model)
  with six tasks and six questions, three of them from finished tasks. Typed three turns in
  the panel, opened a card, launched a task through Lucy with the Go button, reloaded,
  resized to 1280 x 800 and 1440 x 620, opened a second browser context, and sent a question
  while typing (J-F8 to J-F14). Screenshots in `/tmp/kookr-ux-shots/r6/`.
- 2026-11-17 — **Code maps.** Two Explore agents mapped the action path (launch proposal
  lifecycle, the real answer/reply/complete functions, delivery state) and the unprompted
  speech path (announcements, clip pipeline, thread sync, briefing code, signals). The
  second map corrected two of my statements (J-F1, J-F4, J-F11 reworded) and found J-F15
  and the dropped second "needs you" report.
- 2026-11-17 — **Phase 3.** Published three layout directions for the overhaul at
  https://claude.ai/artifact/XrFKRs1r2a6bboMf4AMiyF (owner-only) and asked the operator to
  pick (`kookr ask` a3fc7b520ee7, not waited on); going ahead with the recommended one,
  "conversation first".
- 2026-11-17 — **Phase 4 started.** Worktrees `kookr-jf8-lucy-chat-surface`
  (`feat/lucy-chat-surface`) and `kookr-jf5-lucy-actions` (`feat/lucy-actions`), one
  implementer each, both cut from `feat/lucy-jarvis-base` rather than `origin/main`: the
  playbook says to base every cluster on `origin/main`, but these clusters change files that
  only exist on run 5's unpushed branches, so they are stacked on them.
- 2026-11-17 — **Phase 4, clusters 3 and 5 done.** A third worktree
  (`kookr-jf1-lucy-speaks-first`) was added for cluster 5. Both implementers reported; I
  read the server wiring of cluster 5, sent it back for the ten-minute hold and for stable
  entry ids, merged clusters 3 and 5 into `feat/lucy-jarvis-integration` (one conflict, in
  the thread store, resolved by hand; three tests adjusted), and used the merged build on a
  throwaway server: briefing on open, two typed turns, a launch through the card (J-F16).
- 2026-11-17 — **Phase 4, cluster 4 done and everything merged.** The actions implementer
  reported; merged into `feat/lucy-jarvis-integration` (eight conflicts, by hand), moved
  the action card's outcome into the conversation, re-ran the suites, and used the three
  actions in a browser on a fresh throwaway server (table above).
- 2026-11-17 — **Review round.** Kept spoken replies in English, made a permission prompt
  unfold the strip, added the two-tab test, corrected this RFC (reconciliation table, J-F14,
  checks not run). Merged the 11 new commits of `origin/main` into the integration branch
  with an implementer, which found and fixed the spoken-"yes" defect above. Stopped the
  throwaway servers and their stand-in agents.
- 2026-11-17 — **Phase 5.** Playbook lessons from runs 5 and 6 are in this branch. The
  push question is with the operator.
