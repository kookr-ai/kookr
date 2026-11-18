# RFC: UX Dogfooding Findings — November 2026 (run 5: the Lucy panel)

- **Status**: Draft (living document, updated after every finding)
- **Author**: Claude (Fable 5.2), dogfooding session on the operator's live dashboard
- **Date**: 2026-11-16
- **Base**: `origin/main` @ `78db2d3da` (worktree `kookr-dogfood-202611-run5`)
- **Focus**: the Lucy panel (`src/frontend/avatar/AvatarDock.tsx`). The operator's brief:
  "needs a full overhaul. There is a very long scrolling contents, it's very hard to
  interact with Lucy right now."
- **North star** (operator, mid-session): Lucy should become "a sort of JARVIS": proactive,
  asks questions, reports, suggests things, asks for clarification; the operator can ask her
  a question and she understands and answers properly; she manages many tasks, "not just
  the last one that popped up in the chat".
- **Prior art**: umbrella #3632 ("make Lucy the dashboard operator"), where the operator
  already picked a layout from five mockups: a permanent operator column, about 340 px wide,
  with header, bust, conversation and composer, and a top-bar chip when hidden. The build
  on `origin/main` still ships the 264 x 348 px floating window from #3608.
- **Method**: measure the live panel in the operator's own browser with DOM probes (read
  only: the question cards there are the operator's real decisions and were never clicked),
  cross-check against `/api/asks`, `/api/tasks`, `/api/snapshot`, talk to Lucy through
  `POST /api/lucy/turn`, and root-cause each medium/high finding to `file:line`.

## Summary

Lucy's brain is ahead of her window. Asked through the API she is fast (first words in
about 3 s), grounded, follows a thread, asks which task you mean, and suggests what to do
first. The window she lives in undoes that: a fixed 264 x 348 px float in which fifteen
question cards (each taller than the list that holds them) take 5,255 px of scrolling, her
typed answer gets four lines and no history, and the card that confirms a launch is
squeezed to 8 px with its buttons out of reach.

Fourteen findings, in three families (plus one voice detail, L-F14):

- **The window** (L-F1, L-F4, L-F6, L-F7, L-F12): fixed size, competing scroll regions, no
  conversation. Three of the six high-severity findings are here (L-F1, L-F6, L-F7).
- **What counts as "waiting on you"** (L-F2, L-F3, L-F5): all 15 questions shown as waiting
  belong to finished tasks; the one task that really is blocked is somewhere else; the
  question that closes first is last.
- **Distance to the north star** (L-F8, L-F9, L-F10, L-F11, L-F13): she sees 4 of 15
  questions, can start a task but not answer, reply or snooze, and speaks first for three
  events only.

The layout answer already exists: the operator column the operator chose in #3632. This RFC
adds what the measurements say must go inside it: a queue instead of a stack, one
conversation thread, and confirmation cards that can never shrink.

## Findings

### L-F1. No question card fits in the question list: every answer needs scrolling inside a 198 px window (layout) — severity: high

Measured on the live dashboard (viewport 2221 x 1164 CSS px) with 15 questions waiting:

| What | Value |
|---|---|
| Lucy's window | 264 x 348 px, fixed: 3.8% of the viewport |
| Question list (`avatar-asks`), visible height | 198 px |
| Question list, content height | 5,255 px (26 window-heights) |
| One question card | 321 to 390 px (15 cards) |
| First card, bottom edge of each control | 142, 142, 171, 206, 239, 273, 306, 306 px |
| Keyboard tab stops inside the window | 137 |

The shortest card (321 px) is taller than the list window (198 px). So a question is never
on screen together with its last answer button: on the first card only the two link
buttons and "Open task" are reachable without scrolling; choices A, B, C and the text box
all sit below the fold. Reading 15 questions is 26 screens of scrolling in a 264 px wide
strip, and a keyboard user crosses 137 tab stops.

Root cause:

- `src/frontend/store/avatar-panel-prefs.ts:20-21`: `AVATAR_PANEL_WIDTH = 264`,
  `AVATAR_PANEL_HEIGHT = 348`. The comment says "The dock is fixed-size in this version."
  There is no resize, and the size does not follow the viewport.
- `src/frontend/styles.css:17381-17397`: `.avatar-asks` is one scroll region for all cards;
  `.avatar-dock-ask-waiting .avatar-asks { max-height: none; }` lets it take all the room,
  which is still only 348 - 30 (header) - 56 (3D strip) - 62 (typed box) = 198 px.
- `src/frontend/avatar/AskCard.tsx:150-226`: every waiting card is rendered fully expanded
  (question, background, links, one full-width button per choice, text box, note). There is
  no collapsed form and no "one at a time" view.

Suggested fix: the operator column chosen in #3632 (full viewport height, about 340 px wide
or wider), with the questions shown as a queue: one line per question, one expanded at a
time, and a count. Acceptance, with 15 questions waiting: the composer and Talk are
reachable without scrolling, one whole card with all its choices is visible, and the
question that closes soonest is first.

### L-F2. All 15 "waiting" questions belong to tasks that have finished; they still take the whole window and hide the message list (triage / data trust) — severity: high

`/api/asks` returns 30 questions: 15 pending, 10 answered, 3 expired, 2 cancelled. Joining
the 15 pending ones to `/api/tasks` by `taskId`:

| Task status | Pending questions |
|---|---|
| completed | 14 |
| terminated | 1 |
| running / needs input | 0 |

These are opinion requests: the task asked, carried on with its recommended option and
finished 16 to 20 hours ago. Nothing is waiting on them. The panel treats them exactly like
a question that blocks a running task:

- the card is amber-edged with "N h left", and the window gets the "ask waiting" layout;
- the bubble badge and the hover card count them as "questions for you";
- `src/frontend/styles.css:17396`: `.avatar-dock-ask-waiting .avatar-dock-transcript { display: none; }`
  removes the list of spoken messages for as long as any question is pending. With opinion
  requests open for 24 h (up to 7 days, `asks.ts:231`), the message list was unreachable
  for the whole session.
- Meanwhile the task rail says "NEEDS YOU (1)" (one task, unrelated to any of the 15). The
  dashboard has two disagreeing answers to "what is waiting on me", and the 264 px window
  is the only place in the dashboard where these 15 questions exist.

Root cause: `OperatorAskView` (`src/shared/contracts/asks.ts:333-356`) carries no hint of
whether the asking task is still running or whether it waits on the answer, so the panel
cannot tell "a task is blocked on this" from "tell me when you have a minute".

Suggested fix: send the asking task's status (and whether a `kookr ask --wait` poll is
live) with each question; show blocking questions first and expanded, and group opinion
requests from finished tasks under one collapsed "N opinions wanted" row that never hides
the conversation.

### L-F3. Questions are listed newest first, so the one that closes soonest is last (ordering) — severity: medium

The time-left labels down the list read: 8 h, 8 h, 7 h, 7 h, 7 h, 7 h, 6 h, 6 h, 6 h, 6 h,
6 h, 5 h, 5 h, 5 h, 4 h. The question that expires first (4.3 h left, asked 19.7 h ago) is
at the bottom, about 5,000 px down.

Root cause: `src/server/asks/ask-service.ts:402` sorts `b.createdAt - a.createdAt` (newest
first) and `visibleOperatorAsks` (`src/frontend/store/operator-asks.ts:187-189`) only
filters. Nothing orders by `expiresAt` or by whether a task is blocked.

Suggested fix: order by (blocking first, then `expiresAt` ascending) in the panel.

### L-F4. The floating window covers dashboard controls and cannot be resized (layout) — severity: medium

At its default bottom-right position the window's rectangle covers the centre of four
controls of the task view behind it: "Send & Next" (the reply composer's second button),
the task ID chip, "Link" and "Share". It can be dragged or sent to another corner, where it
covers something else; it cannot be resized or docked.

Root cause: `position: fixed; z-index: 120` (`styles.css:17170`) with the fixed size above;
nothing reserves layout room for it. The column layout from #3632 removes the overlap.

### L-F5. `GET /api/asks` has no task name; the panel's cards do (API consistency) — severity: low

The card header reads "Implement issue 3711 as merged PR asks", but the same question from
`GET /api/asks` has only `taskId` (keys: `allowText, context, createdAt, delivery,
expiresAt, id, idempotencyKey, links, options, question, sessionId, state, taskId`). A
scripter listing open questions must join `/api/tasks` (8 MB+) to say who asked. The name
is added only in the socket view (`OperatorAskView.taskName`, `asks.ts:340`).

Suggested fix: include `taskName` and the task's status in the REST listing too.

### L-F6. Lucy's launch confirmation card is 8 px tall: the "Go" and "Cancel" buttons cannot be reached (layout, confirmation of a spending action) — severity: high

Asked Lucy (typed, through `POST /api/lucy/turn`) to start a README audit in
`knowledge-base-mcp-server`. She answered "…Say go to start." and the server pushed the
proposal card to the panel. Measured in the panel, with the 15 questions and one typed
reply showing:

| Region | Height |
|---|---|
| Header | 30 px |
| 3D strip | 56 px |
| Question list | 112 px |
| **Launch card (`.avatar-launch`)** | **8 px visible, 372 px of content** |
| Typed box and last reply | 139 px |

The card that says what will be launched, where, and at which autonomy level, with its Go
and Cancel buttons 533 px down inside an 8 px scroll window, is not visible at all
(screenshot `/tmp/kookr-ux-shots/r5-03-launch-card-8px-invisible.jpg`). After the launch,
the "Started · Open task · Dismiss" row is 1 px tall (30 px of content). The only way to
confirm was to know to type "go". When the task finished, her report ("The task I started
"Audit README commands and environment variables" says it is done and is waiting for you to
look at it.", with Open task and Dismiss) landed in the same region: 3 px visible of 140 px.
The one thing she said unprompted in this session could not be read. At the Hands-off level the same card carries the cancel
countdown, which would be just as invisible.

Root cause: `src/frontend/styles.css:17570` gives `.avatar-launch`
`flex: 0 1 auto; min-height: 0`, so it may shrink to nothing, while `.avatar-typed`
(`:17592`) is `flex: none` and the question list has `max-height: none` (`:17396`). In a
348 px window the three compete and the one card that needs a decision right now loses.

Suggested fix: a card that waits for a confirmation is never a shrinkable row. In the
column layout it is part of the conversation, pinned directly above the composer, with a
floor height that always shows its buttons.

### L-F7. A typed conversation keeps one reply, in a 4-line box, and forgets what was asked (conversation) — severity: high

Typed "Give me a status of every running task, one by one." in the panel. Lucy's answer
was good (five tasks, one clause each, plus the task waiting on an answer), but:

- it is shown in a box 72 px high holding 204 px of text: 4 of 12 lines, the rest by
  scrolling inside the box (`.avatar-typed-reply { max-height: 72px }`, `styles.css:17596`);
- the question disappears on send: `setText('')` and nothing echoes it, so the panel never
  shows what the answer is an answer to;
- the next send erases the previous answer (`setReply('')`,
  `src/frontend/avatar/LucyTypedInput.tsx:148`). There is no thread, no scroll-back;
- the reply appears under the text box and the autonomy label, at the very bottom edge of
  the window, pushing the question list from 198 px down to 120 px;
- the conversation id lives in a module variable (`LucyTypedInput.tsx:44`), so a page
  reload starts a new conversation and she forgets the earlier turns. The server keeps 20
  messages per conversation (`src/server/lucy-operator/service.ts:22`) but the panel shows
  none of them.

The panel has three unconnected places where Lucy "says" something: the typed reply (last
one only), the Talk exchange (`avatar-live`, last exchange only, 84 px), and the spoken
message list (last 3 clips, `src/frontend/audio/last-clip.ts:18`, hidden while a question
is pending, L-F2). None is a conversation.

Suggested fix: one conversation thread for everything she and the operator say, typed or
spoken, newest at the bottom, with the composer pinned under it; questions, permission
prompts, launch cards and her unprompted reports are entries in that thread.

### L-F8. Lucy can see 4 of the 15 waiting questions and cannot read the others (many-task awareness) — severity: high

Asked: "How many questions from tasks are waiting for my answer, and which one closes
first?" She answered: "Fifteen questions are waiting. Of the four I can see … the other 11
aren't listed, so I can't say for certain which one is oldest." Asked to read the question
about the task facts column (one of the 11): "I don't see it … the other 11 aren't shown
to me."

Root cause: `src/core/lucy-operator/board.ts:64` `MAX_BOARD_ASKS_PENDING = 4` (and
`:224-228` "and N more questions not listed"), with no tool that reads the rest. Same shape
for finished tasks: `MAX_BOARD_FINISHED = 6` (`:63`); asked what happened while the
operator was away she said "I can only see the six most recent finishes".

Suggested fix: a `read_questions` look tool (all pending questions, ordered by closing
time, with whether the task still waits) and a "what changed since" tool backed by the
event log, so the board stays short but nothing is out of her reach.

### L-F9. Lucy cannot act on what she reports: she cannot take an answer, reply, snooze or close (JARVIS gap) — severity: high

Asked "What needs me right now?", she ended with: "There are also 15 questions from other
tasks waiting, which you answer with the buttons on the cards, not by voice." Those are the
buttons from L-F1. Her prompt makes this a rule (`src/core/lucy-operator/prompt.ts:23,28`):
"You cannot reply to, close, snooze, approve or stop a task" and "you cannot answer it and
you cannot take their answer by voice: they answer with the buttons on the card". (Talk has
its own voice-answer path with a read-back, #3714; the typed conversation has none.) The one
thing she can start is a launch. Against the north star (she manages many tasks), the
missing rungs of #3632's ladder are: record the operator's answer to a question (rung 2,
with a read-back), reply to a task (rung 2), snooze or mark seen (rung 1, with Undo).

### L-F10. Lucy lists 52 projects she can start tasks in, then refuses the main one without saying why (launch) — severity: medium

"Which projects can you start a task in?" → "Any of the 52 projects Kookr knows, such as
kookr-ai/kookr…". "Start a task in kookr to list dead exports…" → "kookr isn't one of the
available projects — which project should I use?"

Root cause: `list_projects` reports every project the dashboard knows, while the launch
path keeps only tracked or `local/` projects (`src/server/lucy-operator/launch-wiring.ts:62`).
`kookr-ai/kookr` is `tracked: false` in `/api/projects`. The refusal names neither the
rule nor the projects that do work.

Suggested fix: `list_projects` marks which projects she may launch in, and the refusal
says "kookr is not tracked; I can launch in A, B, C".

### L-F11. One reply style for voice and for typing (conversation) — severity: low

`prompt.ts:39,41`: "one to three sentences … No lists, no markdown" and "Answer in English",
for typed turns too. A typed request for a status of five tasks comes back as one
paragraph. The operator's own task prompts are partly in French. Suggested fix: typed turns
may use short lists, and she answers in the language she was addressed in.

### L-F12. The 3D view is squeezed to a 56 px strip exactly when the panel is busiest (layout) — severity: low

With questions pending, `.avatar-dock-asking .avatar-dock-view { min-height: 56px; }`
(`styles.css:17391`): a 264 x 56 px band of the 3D scene, still rendering. It takes 16% of
the window and shows neither her face nor anything useful. In the column layout the bust
gets a fixed, collapsible place.

### L-F13. She speaks first for three events only, and what she said is not kept anywhere readable (proactivity) — severity: medium

From code (`src/frontend/avatar/AvatarDock.tsx:327-352`, `src/frontend/store/lucy-launch.ts:90-93`),
Lucy starts talking on her own when: a task asks a question, a task has waited a minute on
a permission prompt, and a task she launched herself finishes. The rest of #3632's "when
she speaks first" table is not built: no briefing when the dashboard is opened or the
operator comes back, nothing when a task fails, stalls or goes quiet, nothing when a task
finishes and wants review, nothing on spend. And each unprompted message is a sound clip
plus an entry in the 3-item message list, which is hidden while any question is pending
(L-F2): with sound off, or after a reload, there is no record that she said anything.

Suggested fix: her unprompted messages are entries in the conversation thread (L-F7), text
first and voice second, and the thread opens with a short briefing ("one task is blocked on
you, 15 opinions wanted, 5 running, 6 finished since you were last here").

### L-F14. Two open dashboard tabs both speak the same message at the same time (voice) — severity: low

While this session had a second dashboard tab open in the operator's browser, a new
question arrived and `~/.kookr/lucy-interactions.jsonl` recorded the same announcement
played to the end in both tabs within 200 ms of each other (`lucy_clip_ended`, sessions
`2026-11-15T23-40-36-156Z` and `2026-11-16T21-49-58-934Z`, both `playedMs: 9125`). #3632
lists "only one tab speaks when several are open" as a rule still to decide; today every
tab with the panel on speaks. Suggested fix: one speaking tab, chosen with a
`BroadcastChannel` or Web Locks lease, the visible tab first.

## Things that worked well (keep-list)

- **Lucy's answers are fast and grounded.** Twelve typed turns: first text after 0.9 to 7.3 s
  (median about 3.4 s), 1 to 3 model steps. She read five terminals in parallel to answer
  "which task is stuck" and gave a per-task status without inventing anything.
- **She keeps the thread within a conversation.** "And how much has that one cost so far?"
  resolved "that one" to the task from the previous answer.
- **She asks instead of guessing.** "What's up with the PR?" → "Which one do you mean — the
  running opencode container hardening PR, or one of the finished issue PRs?"
- **She suggests a next step in priority order** ("Answer the letter PDF question first,
  since that task is blocked on it, then…").
- **She says what she cannot see** ("the other 11 aren't listed") rather than making it up.
- **Unknown project is refused cleanly**: "I don't see a project called
  banana-does-not-exist … so I haven't started anything. Which project did you mean?"
- **The launch itself is sound**: the proposal restated the task in full, "go" in the same
  conversation started it, and it went to the project's own checkout, not `kookr-prod`.
- **Question cards are complete**: question, background, link buttons, Open task, choices,
  typed answer, "Also on Telegram. The first answer wins." Nothing is missing from a card;
  the problem is fifteen of them in 198 px.

## Suggested priority order

Grouped into clusters that can each ship as one PR.

1. **Operator column** (L-F1, L-F4, L-F6, L-F7, L-F12, and the panel side of L-F2, L-F3,
   L-F13). Replace the floating window with the full-height column from #3632: header,
   compact bust, "waiting on you" queue (one line per item, one open at a time, blocking
   first then by closing time, opinions from finished tasks folded into one row), one
   conversation thread, confirmation cards pinned above a pinned composer. Acceptance, with
   15 questions pending: the composer and Talk are reachable without scrolling; one whole
   card with all its choices is visible; the item that closes soonest is first; a launch
   card's Go and Cancel are on screen; a typed question and its answer both stay visible
   after the next question.
2. **Lucy sees everything that waits** (L-F2, L-F3, L-F5, L-F8, L-F10). Server and core:
   each question carries the asking task's status and whether a task still waits on it
   (socket view and `GET /api/asks`), a `read_questions` look tool so no question is out of
   her reach, and `list_projects` says where she may launch.
3. **Lucy acts on questions and tasks** (L-F9). Rung 1 and 2 of #3632's ladder for the
   typed and spoken conversation: take the operator's answer to a question with a
   read-back card, reply to a task, snooze. Needs a design pass on the proposal card
   becoming general (today it is launch-only, `launch-controller.ts`). Not started here.
4. **Lucy speaks first, in writing too** (L-F13, L-F11). Briefing on open and on return,
   failures and stalls, finished-and-wants-review; typed replies may use lists. Builds on
   the thread from cluster 1. Not started here.

## Implementation (Phase 4)

Clusters 1 and 2 are implemented on two branches cut from `origin/main`, committed and
**not pushed**. Clusters 3 and 4 are not started.

| Branch (worktree) | Cluster | Findings addressed |
|---|---|---|
| `feat/lucy-operator-column` (`../kookr-lf1-lucy-operator-column`) | 1. Operator column | L-F1, L-F4, L-F6, L-F7, L-F12; panel side of L-F2, L-F3 |
| `feat/lucy-question-awareness` (`../kookr-lf8-lucy-question-awareness`) | 2. Lucy sees everything that waits | L-F2 (server), L-F5, L-F8, L-F10 |

**Cluster 1, what changed.** Lucy's open panel is a full-height column docked on the right
(380 px by default, 320 to 560 by dragging its left edge or with the arrow keys, width
saved). The dashboard shrinks beside it (`--lucy-column-width` on the root drives
`.app`'s right padding and moves the right-edge overlays); at 768 px and below it is a
full-width sheet. Inside, top to bottom: header, 3D view at a fixed 120 px, a "Waiting on
you" tray (one line per question, one card open at a time, soonest to close first, opinion
requests from finished tasks folded into one row), one conversation thread (typed turns,
Talk exchanges and spoken clips, kept across a reload in `sessionStorage`), the launch card
with Go and Cancel that cannot shrink, and the composer pinned at the bottom. Window
dragging and "move to the next corner" are gone; the minimised bubble stays, and its
badge and hover card no longer count opinion requests as questions waiting for you.

**Cluster 2, what changed.** Every question view carries `taskEnded` (the asking task is
terminal or gone) on the socket and on `GET /api/asks`, which also gains `taskName`; the
list is re-sent when a task with a pending question ends. Lucy has a `read_questions` tool
(every pending question, running tasks first, then soonest to close), her board orders
questions the same way and says when a task has finished, `list_projects` marks where she
may launch, and the unknown-project refusal names the projects she can launch in.

**Before and after, 15 pending questions.** The two columns are not the same run: "before"
is the DOM probe on the operator's live dashboard, "after" is the Playwright spec on a
throwaway server at a smaller viewport, where the 14-finished / 1-running split is fed to
the page as an `operatorAsks` socket message (the server producing that field is proven
separately, by a real-server test in `src/server/index.asks.test.ts`). The live dashboard
was not re-measured because neither branch is deployed.

| Measure | Before (live dashboard, 2221 x 1164) | After (browser spec, 1440 x 900) |
|---|---|---|
| Open question with all its choices visible | never (card 321 to 390 px in a 198 px list) | yes, inside the tray's visible box |
| Fifteen questions from finished tasks | 5,255 px of cards | one folded row |
| Order | newest first | soonest to close first |
| Launch card Go / Cancel | 8 px region, unreachable | fully in the viewport, above the composer |
| Typed turns kept | last answer only, 4 lines | every question and answer, kept across reload |
| Spoken messages while a question is pending | hidden | in the thread |
| Dashboard controls covered | 4 | 0 (the page ends where the column starts) |

**Verification.** Run by me on both branches merged together onto the then-current
`origin/main` in a throwaway worktree (no conflicts): `tsc -p .` clean; 2,169 tests pass
in the avatar, store, audio, Talk, Settings, design-token, asks and Lucy suites;
`check:frontend` reports no new errors; `e2e/avatar-panel.spec.ts` 21 passed, headed under
Xvfb with the default worker count. That spec covers the eight acceptance criteria plus
resizing, the three layout modes, the right-edge overlays and an axe scan. Plain headless
Chromium does not paint on this host (a bare page never fires `requestAnimationFrame`), so
the spec has not been run headless here.

**How the column shares the window** (added after review, when a 1280 px window showed the
top bar colliding beside the default column): the page always keeps 1000 px.

| Window width | Mode | Column |
|---|---|---|
| 768 px and below | sheet | full width over the page |
| 769 to 1319 px | overlay | floats over the right of the page, below the top bar; the page keeps its layout |
| 1320 px and above | docked | beside the page, width = min(saved width, window - 1000) |

**Known gaps (not fixed here).**

- Between 769 and 1319 px the column floats over the right part of the page, so it covers
  page controls again (L-F4) until it is minimised. Docking at those widths needs the top
  bar and the reading pane to follow the page width (container queries), not the window.
- A task that ends through a path outside the task-outcome hook (launch failure cleanup,
  crash recovery, the migrate-source quiesce in the task routes, schedule runtime) does not
  re-send the question list; the mark is corrected at the next question change or
  reconnect. Completing a task, stopping it from the dashboard and dead-session cleanup do
  re-send. REST and Lucy's tools always compute it fresh.
- "Its task has ended" is the only signal. A running task that asked without waiting and
  moved on still counts as possibly waiting (see #4040 for why the wait poll is not a
  reliable signal yet).
- Talk transcripts and typed turns are now kept in the tab's `sessionStorage` (text only)
  so the thread survives a reload; they are gone when the tab closes.
- Below about 600 px of window height the composer can clip.
- The two proof scripts under `scripts/` were run against the first version of the column
  (11/11 and 9/9), not re-run after the layout-mode follow-up.

## Session log

- 2026-11-16 — **Phase 1 setup.** Dashboard live at `localhost:4800`. Fetched origin;
  202611 already had runs 1 to 4, so this is run 5 on `origin/main@78db2d3da`. Seeded this
  RFC before driving anything.
- 2026-11-16 — **Phase 2, panel measurements.** Opened the dashboard in the operator's
  Chrome and measured Lucy's window with read-only DOM probes (L-F1, L-F3, L-F4). Joined
  `/api/asks` to `/api/tasks` (L-F2, L-F5). The 15 question cards are the operator's real
  decisions, also on Telegram: none was clicked, answered or dismissed.
- 2026-11-16 — **Phase 2, talking to Lucy.** Nine look-only typed turns through
  `POST /api/lucy/turn` in my own conversation ids (L-F8, L-F9, L-F11, L-F13, keep-list), one typed
  in the panel itself to see how the reply is shown (L-F7). Talk (the microphone) was not
  switched on: it would open the operator's real microphone; covered from code only.
- 2026-11-16 — **Phase 2, launching through Lucy.** Unhappy path: a project that does not
  exist, then `kookr` (L-F10). Happy path: one real task, a README-versus-code audit in
  `knowledge-base-mcp-server` (task `fc6ae2be`), proposed by Lucy and confirmed by typing
  "go" because the card's buttons were unreachable (L-F6).
- 2026-11-16 — **Phase 3.** RFC committed. Published three mockups of the column's inside
  (tray above the thread, one thread, two tabs) at
  https://claude.ai/artifact/C8UhTbd9FiRLxso5tBVbeW (owner-only) and went ahead with the
  recommended one, the tray above the thread. Noticed in the interaction log that my
  second tab spoke over the operator's (L-F14), so that tab is now closed.
- 2026-11-16 — **Phase 2, the launched task finished.** Lucy's "it is done" report arrived
  in the 3 px launch region (added to L-F6). The audit task is left signaled-complete in
  `knowledge-base-mcp-server` for the operator to read; replying to it and rating it (the
  reading-pane happy path) was covered by runs 1 to 4 and not repeated.
- 2026-11-16 — **Phase 4 started.** Two Explore agents mapped the frontend and the server;
  two worktrees (`kookr-lf1-lucy-operator-column`, `kookr-lf8-lucy-question-awareness`),
  one implementer each, for clusters 1 and 2.
- 2026-11-17 — **Phase 4 done.** Both implementers reported; I read both diffs, re-ran
  their unit suites, softened one sentence in `read_questions`, and merged the two branches
  onto the current `origin/main` in a throwaway worktree to check them together.
- 2026-11-17 — **Phase 5.** Five process lessons from this run added to the playbook
  (`.kookr/playbooks/ux-dogfood-loop.md`).
- 2026-11-17 — **Review round.** A 1280 px window showed the top bar colliding beside the
  default column and the bubble still counted opinion requests; both fixed on the column
  branch (the page keeps 1000 px; three layout modes). Re-merged and re-ran everything
  myself; cropped the three "before" screenshots to Lucy's window so they show none of the
  operator's task text.
