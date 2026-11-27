# RFC: UX Dogfooding Findings — November 2026 (run 8: Lucy is closed)

- **Status**: Draft (running log)
- **Author**: Claude (Fable 5.2), dogfooding session on the operator's live dashboard
- **Date**: 2026-11-27 (all clock times below are UTC)
- **Base**: `origin/main` @ `e33d8654d` (worktree `kookr-dogfood-202611-run8`), the build production runs
- **Focus** (operator's brief, the same as runs 6 and 7 plus one sentence): "Lucy's panel needs a
  full overhaul. End goal is Lucy being as helpful as Jarvis: being proactive, when she
  speaks/interacts with the user it is always to ask for added value, the chat is nice, the
  interface is smooth, the panel for interacting with it is nice, the actions Lucy can take are
  making her really useful. I think the panel is too small, maybe it should have its own full
  side panel or even entire window." New this run: "Use a fleet of Sonnet subagents to get better
  ideas, brainstorm and criticize your ideas."
- **Relation to runs 5 to 7**: those runs replaced the floating window with a docked column, built
  "Lucy's room" (a full-window view), a chat thread, a written briefing and three confirmed
  actions. All of it is on `main` and in production since 18 November. This run does not
  re-measure it; it measures what the operator did with it.
- **Method**:
  1. Read what the operator did with Lucy since the column and the room shipped, from
     `~/.kookr/lucy-interactions.jsonl`, and what happened to every question a task asked.
  2. Photograph and measure the live panel in its three states (minimised, column, room) at
     1440, 1920 and 2560 px, read-only: the panel is opened through stored preferences, nothing
     is clicked, the tab is closed after each shot.
  3. Six Sonnet designers, each with a different lens and blind to the others, propose a
     redesign from the same evidence; a second round attacks the synthesis.
  4. Root-cause each medium or high finding to `file:line` on `origin/main`.
  5. Implement the accepted clusters, each in its own worktree, and deliver them.

## Summary

_(written at the end of the run)_

## Findings

### R8-F1. Since the column and the room shipped, the operator has not used her once (adoption) — severity: high

**Evidence.** `~/.kookr/lucy-interactions.jsonl`, from 18 November 12:00 (the day #4148 and #4153
reached production) to 27 November 17:30. The host was off from 23 November 20:46 to 27 November
17:21, so the window holds about five and a half days of running time.

| Measure | 18 to 27 November |
|---|---|
| Messages typed to Lucy | 0 |
| Spoken exchanges | 0 |
| Tasks launched through her | 0 |
| Times her panel was opened | 8 |
| How long it stayed open | 2 h 52 min once (left open), 1 min 47 s, 4 min 05 s, then five visits of 14, 3, 7, 3 and 9 seconds |
| Visits to the room | 2, lasting 5.8 s and 1.2 s |
| Questions tasks asked | 6: two answered, both from Telegram; two expired; one cancelled; one waiting |
| Questions answered from her panel | 0 |
| Lines she said aloud | 3 (one restart question, two permission notices), each while the panel was minimised and the tab hidden |

The baseline needs a correction that earlier runs did not make. The log holds 30 typed turns
before 18 November, but 26 of them carry conversation ids `dogfood-r5-*`, `dogfood-r6-*` and
`r7-*`: they are the earlier runs' own probes. The operator has typed to her **four times in
all** (once on 16 November, three times on 17 November). Two of the four failed ("Which task do
you mean?", "Which project?"; both fixed since by #4150). Of 13 spoken exchanges (11 to 15
November), 7 have no transcript at all. What the operator asked in the ones that have one: "Can
you tell me which tasks require my attention right now?", "What can you do?", "Suggest some
solutions based on your findings and implement them."

So there was never a habit to lose. The operator tried her about ten times in the first week,
got a useful answer about half the time, and stopped. The larger panel changed nothing in that,
because the operator has spent seven seconds in the room and has not typed in the column.

**Root cause.** Not a line of code. The findings that follow (R8-F2 to R8-F7, and R8-F10) are what the
operator meets in the few seconds she is open: the one decision that was waiting is folded
away, what she writes names nothing, the dashboard beside her says nothing is waiting, and her
voice is switched off (R8-F4).

**Suggested fix.** Stop treating her size as the problem. Measure every change of this run by
one number: questions answered from her surface, out of questions asked (today 0 of 6).

### R8-F2. In the operator's nine seconds with her today, the one question that needed an answer was a folded 31 px strip (proactivity) — severity: high

**Evidence.** The server restarted at 17:21:43. At 17:21:47 Kookr asked "Kookr restarted and found
4 interrupted tasks. Resume them?" (Resume / Leave stopped, ten minutes to answer; ask
`0bf07337fa98`). The operator opened Lucy's column at 17:26:28 and minimised it at 17:26:37, then
launched this run with the brief above. The question was live for those nine seconds. In the
column it is one line, 31 px tall, that reads "N waiting on you" with a chevron
(`/tmp/kookr-ux-shots/r8/live/column-1920-dock.png`, measured: `avatar-tray` 379 x 31 px); the
question, its two buttons and its deadline are behind that chevron. It expired at 17:31:47.

The room shows the same question at full size (`room-1920.png`), which is the layout the
operator has seen for seven seconds in nine days.

**Root cause.** The strip starts folded in every tab and unfolds only on a click:
`src/frontend/store/avatar-panel-prefs.ts:210-217` (`loadTrayExpanded`: folded unless this tab
saved `'1'`). Run 6 folded it because fifteen stale questions used to fill the window (L-F2);
that cause was fixed separately, and the fold stayed.

**Suggested fix.** A question that is waiting is never folded: in the column, the question that
closes soonest is shown whole, with its answers, above the conversation; the others are one
line each beneath it. Minimised, she shows the question's sentence and its answers beside the
bubble instead of a badge (R8-F3).

### R8-F3. With Lucy minimised, the dashboard says "nothing waiting" and "All clear" while a task's question is waiting (data trust) — severity: high

**Evidence.** `/tmp/kookr-ux-shots/r8/live/bubble-1920.png`, taken at 17:32 with one task
question waiting (ask `a802f3fb13b1`, "Earnings Watch UX review: Claude in Chrome can't reach the
console. Can you sign in on this PC so I can run the browser fleet?", 117 minutes left):

- the task list's header: "NEEDS YOU (0) nothing waiting";
- the overview: "0 NEEDS INPUT" and "All clear — agents working autonomously.";
- Lucy: a 58 px circle with a badge "1".

Minimised is the state she is in almost all the time (R8-F1). In that state the only sign of a
task's question on the whole dashboard is a digit on a circle. One minute earlier, with a budget
finding raised (`column-1920.png`), the two lists both said "1" and meant different things: the
dashboard's "Waiting on you" held the budget finding and not the question, Lucy's "1 waiting on
you" held the question and not the budget finding.

**Root cause.** The dashboard's "needs you" is the findings queue and nothing else:
`src/frontend/components/FindingsPanel.tsx:558-561` ("nothing waiting" when `findings.length ===
0`) and `src/frontend/components/OverviewEmptyState.tsx:377-380` ("All clear"). Questions live in
their own store (`src/frontend/store/operator-asks.ts`) that only Lucy's panel reads. A question
asked without `--wait` leaves its task in the Working group, so nothing else marks it.

**Suggested fix.** The two sentences must not be shown while a question or a permission prompt is
waiting: "Needs you" counts them, the overview lists them above the findings with their task's
name, and pressing one opens Lucy on that card. One count, used by the dashboard and by her.

### R8-F4. Speech is switched off on this install, so everything she has to say must be readable (voice) — severity: low (a fact about the install, and a correction)

**Evidence.** Production's `.env` has `KOOKR_TTS=false`; the file was last saved at 17:21:31, twelve
seconds before today's restart. The server log says "[tts] Text-to-speech disabled" and `GET
/api/lucy-live/status` answers "Lucy live needs the speech service (enable KOOKR_TTS or set
KOOKR_TTS_URL)", which is true. She said nothing aloud today: not the restart question (the same
question was spoken on 18 November), not the task's question.

A first draft of this finding said the speech service had failed to start and that the panel's
message was wrong. It was not: I had read the setting's presence in `.env` as "enabled" without
reading its value. The six designers of round 1 were given that wrong sentence, and three of them
proposed a "say truthfully why she is silent" line and a restart of the service; both are
dropped.

**What stays true.** With speech off, the hands-free conversation and every spoken notice are
gone, and what is left of "Jarvis" is what she writes and what the operator can press. That is
the reason this run's clusters are all about the written surface. The one visible cost of the
switched-off speech is the dead button of R8-F7.

### R8-F5. What she writes when her panel opens names no task and no amount (proactivity / value) — severity: high

**Evidence.** The whole content of her column when photographed at 17:32
(`column-1920-dock.png`):

> "One task is stopped on a question. Six more are working."
> "A task has gone over its budget." [Open task]

Thirty centimetres to the left the dashboard says which task and by how much: "BUDGET EXCEEDED,
Test Inkling 2 Mini Unsloth Context Throughput, Task cost $51.25 exceeds 2x threshold ($50.00)".
The question she counts is not quoted and its task is not named. Neither bubble offers the
decision: the question's four answers are behind the folded strip, the budget line has "Open
task" only. A minute later the briefing read "One task is stopped on a question. Compte rendu
finetuning LFM3 contexte 128k has gone quiet. Six more are working." (`GET /api/lucy/briefing`):
tasks in trouble are named, the question is not.

**Root cause.** The briefing is assembled from fixed phrases per kind of need
(`src/core/lucy-operator/operator-briefing.ts:107-124`, `:200`), and a question is only ever
counted. The budget line falls back to "A task" when the event carries no name she can say
(`src/server/lucy-says.ts:155-167`, `singleEventSentence`), and no line carries an amount.

**Suggested fix.** Every line she writes first names its task and carries what the operator can
do about it in one press: the question's own sentence with its answers, the budget line with
the two figures and the finding's own buttons. A line that can name nothing is not written.

### R8-F6. The room is nine tenths empty, and the column is two thirds empty (layout) — severity: high

**Evidence.** Measured on the live dashboard (`measurements.json`):

| Window | Room: conversation area | What is in it | Column: thread area | What is in it |
|---|---|---|---|---|
| 1440 x 900 | 1040 x 748 | one bubble and three chips, about 100 px tall | 379 x 646 | two bubbles, about 150 px |
| 1920 x 1080 | 1459 x 928 | the same | 379 x 826 | the same |
| 2560 x 1300 | 2040 x 1148 | the same | 379 x 1046 | the same |

The room's right rail holds her 3D view (460 x 281 at 1920) and one question card; under the
card it is empty too (`room-1920.png`, `room-2560.png`). Nothing in the room says what the fleet
is doing, what finished, what she did, or what she could do. The operator's request for "its own
full side panel or even entire window" is met in pixels and not in content: the window exists
and has one sentence in it.

**Root cause.** The room is the column's three parts given more room (`src/frontend/avatar/
AvatarDock.tsx`, the `room` branch; `avatar-panel-prefs.ts:140-144`). There is no content made
for it.

**Suggested fix.** See "The design" below: the room becomes a desk with what waits, what the
fleet is doing and the conversation side by side.

### R8-F7. The column's text field is 148 px wide; a dead button beside it takes 139 px (chat) — severity: medium

**Evidence.** In the 380 px column the composer row is: "Talk is not set up" (139 x 31 px, cannot
be used), the text field (148 x 31 px, its placeholder cut to "Ask Lucy, or tell her"), "Send".
The field shows about 20 characters. In the room the same field is 685 x 60 px.

**Root cause.** `src/frontend/avatar/AvatarDock.tsx:876-897` renders the Talk button with its
unavailable text inside the composer row; `src/frontend/avatar/LucyTypedInput.tsx:380-397` lays
the three out on one line.

**Suggested fix.** The field takes the whole row and grows to several lines; Talk is an icon,
shown only when hands-free can be used; switched off, its place in Settings is enough.

### R8-F8. An expired question says "Expired with no answer" and not what happened (wording) — severity: medium

**Evidence.** The restart question's card after 17:31:47: "Expired with no answer. Kookr restarted
and found 4 interrupted tasks. Resume them?" What happened is that the four tasks were resumed
(`~/.kookr/interrupted-tasks.json`, batch `2346850c0f1c`: `decision.choice: "resume"`, `by:
"timeout"`). The card reads as if nothing was done.

**Root cause.** `src/frontend/avatar/AskCard.tsx:102` has one text for every expired question; the
restart question's default is applied by the interrupted-tasks code and never written back to
the question.

**Suggested fix.** A question with a default says it while it waits ("Resumed automatically in 4
min") and says what was done when it closes ("No answer: the 4 tasks were resumed").

### R8-F9. A dashboard error toast lands on her 3D view in the room (layout) — severity: low

**Evidence.** `room-1920.png`: the toast "Reclaimed 1 finishedAwaitingAck task(s) (1 hard-TTL)…"
covers the 3D view, in a room where the dashboard it belongs to is hidden.

**Suggested fix.** In the room, toasts sit below the header on the conversation's side, or wait
for the dashboard.

### R8-F10. Her chat is down in production, and nothing on the dashboard says so (chat) — severity: high

**Evidence.** Every question sent to her on the live server today fails. Five of five, from this
run's own conversation ids (`r8-conv-chat1` to `3`, `r8-lead-1`), for example:

> `POST /api/lucy/turn` "What needs me right now?" → `{"type":"done","end":"error","reason":"The
> model provider returned an error.","totalMs":28014,"steps":1}`

The operator would wait 28 seconds for that sentence. `~/.kookr/server.log` says no more than the
panel: "[lucy-operator] model call failed at step 1: OpenRouter reported an error in the stream:
Provider returned error". Nothing in `/api/health` or in the System indicator mentions her
model. The last turn that succeeded is from 18 November; nobody has talked to her since
(R8-F1), so nobody knows how long she has been down.

**Root cause.** Reproduced with the same model and key, outside Kookr. The operator's OpenRouter
workspace has a guardrail (`https://openrouter.ai/workspaces/default/guardrails`) that allows one
provider and one model family:

- `deepseek/deepseek-v4.1-flash-1017` goes to Sail Research, which answers after 20 seconds with
  `429 rate_limit_exceeded`, `provider_code: ttft_deadline_guard` ("temporarily rate-limited
  upstream"), with or without tools, streaming or not. The model has about 25 other providers on
  OpenRouter, all healthy; asking for one of them (`provider.ignore`, `provider.order`) answers
  `404 … Provider not allowed by guardrail: 51 endpoints excluded`.
- Any other model (five tried, among them the runner-up of the model trial on #3632) answers
  `404 … Model blocked by guardrail`.

So nothing Kookr sends can reach a working endpoint on that account. Since #4255 (23 November, an
operator decision) Kookr sends no provider preference, which is right and is not the cause. On
Kookr's side:

- `src/adapters/llm/openrouter-chat-stream.ts:160` keeps only the error's `message` ("Provider
  returned error") and drops `metadata` (which provider, which code);
- a failed turn ends with one fixed sentence (`src/core/lucy-operator/turn.ts`);
- no health field reports her model;
- her typed conversation can only use OpenRouter, while her spoken one already uses Baseten.

**Suggested fix.** (a) In Kookr (cluster A): say the provider's name and status ("OpenRouter's
provider Sail Research is rate-limited (429)"); give up on a provider that has sent nothing for
12 seconds (the slowest healthy first text in the operator's history was 9.4 s, so 8 would cut
healthy turns; reasoning counts as data); when the model fails, answer from the board without it
and say so; stop asking a provider that just failed twice for a minute; report her model in
`/api/health`. (b) The operator, asked during the run (ask `7d6f17c077c9`), chose "Switch her to
another model". No other model passes the guardrail, so the switch is to another service (cluster
G): the same model family on Baseten, with the key this install already has and that her spoken
conversation already uses. Measured today with tools and streaming: a tool call in 0.2 to 1.1 s.
Baseten becomes her default when its key is configured; `KOOKR_LUCY_OPERATOR_PROVIDER` chooses.
(c) The guardrail itself stays the operator's: the helper-model calls that go through OpenRouter
meet the same wall.

## Things that worked well (keep-list)

- **The interaction log.** Every number in R8-F1 came from one file in a few minutes, and it
  separates what the operator did from what the earlier runs did (their probes carry their own
  conversation ids).
- **The question card at full size** (room rail, 424 x 395 px): the question, its background, four
  answers, a free-text answer and "Also on Telegram. The first answer wins." Nothing to change in
  it; it needs to be where the operator looks.
- **The default on a restart question.** Nobody answered and the four tasks were resumed anyway.
- **Her status answer** (run 7's keep-list) still holds: the content she can produce when asked
  is better than what she volunteers.

## The design

**Principle.** She comes to the operator with the decision ready; the operator never has to open
her to find out what she wants. A bigger surface comes second and must be full. Mock-ups, with
today's screenshots beside them: https://claude.ai/artifact/JndKL29DUNG8XsRhctqxx7 (owner-only).

The design is judged by one number, with its limits said: **questions and permission prompts
answered from her surface, out of those raised** (today 0 of 6). Six in nine days is a small
sample and Telegram competes for the same answers, so the number is read together with how often
the new card is dismissed ("Later"); both are logged by cluster D.

| Slice | What the operator gets | Findings | This run |
|---|---|---|---|
| 0. She answers when her model does not | In place of "The model provider returned an error" after 28 s: within 8 s, one sentence naming the provider and its status, then what waits and what is in trouble, from the board, marked as not written by the model. A breaker stops calling a provider that just failed twice. Her model's health in `/api/health`. | R8-F10 | cluster A |
| 1. One list of what waits | "Needs you" and the overview count questions and permission prompts, name their tasks, and never say "nothing waiting" or "All clear" while one waits; pressing the row opens Lucy on it. The same function feeds her badge. | R8-F3 | cluster B |
| 2. The decision comes to the bubble | Minimised, she grows once into the question with its answers (or the permission prompt with Approve once and Deny), without taking focus, not while the operator types, not under Do Not Disturb; "Later" shrinks her for good for that item. Open, the column never folds a waiting question. | R8-F2 | cluster D |
| 3. Lines that name and offer | The briefing names the task that asks and its time left; the budget line carries both amounts; no line says "A task"; no all-clear line. An expired question with a default says what was done. | R8-F5, R8-F8 | cluster C (wording and data), cluster F (the card) |
| 3b. A text field worth typing in | The field takes the whole row and grows; the dead Talk button goes when hands-free cannot be used. | R8-F7 | cluster E |
| 4. The desk | The full window in three columns: decisions, the fleet with one line of what each task last did, the conversation; her 3D view as a portrait, toasts off her. | R8-F6, R8-F9 | asked (see below); not started |
| 5. Actions that replace clicks | "Close the finished ones" (one card listing each task and why), snooze a finding, relaunch, stop; each behind a card that re-checks on press. | run 6 J-F5, run 7's list | asked; not started |

### What the Sonnet fleet changed

Round 1, six designers blind to each other (the Jarvis loop, the surface, "more surface is the
wrong fix", actions, proactivity, the conversation). Round 2, four critics on the synthesis (what
to cut, failure modes, delivery, a walkthrough as the operator). Their reports are in the
session's scratch directory and are summarised here because they will not outlive it.

**Adopted.**

- *From five of six designers independently:* one list of what waits; the question with its
  answers where the operator already looks; lines that name the task and the amount. This
  agreement is why slices 1 to 3 are built first.
- *From the skeptic:* the baseline correction in R8-F1 (26 of 30 typed turns were earlier runs'
  probes). It reverses the story from "the bigger panel killed usage" to "there was never usage".
- *From the conversation designer:* R8-F10. Its three test questions failed; without that lens
  this run would have redesigned a chat that does not answer.
- *From the failure-mode critic, into the implementers' briefs as requirements:* a card that
  appears by itself never takes keyboard focus; its buttons ignore presses for 600 ms after it
  appears; a press re-checks the question and says "already answered on Telegram" rather than
  vanishing; a permission prompt's command is shown whole or Approve is disabled; one count per
  task and kind; one breaker for her model; a reply from the board is always labelled.
- *From the walkthrough critic:* the card waits until two seconds after the last keystroke and
  never appears over someone typing in a terminal (scenario 2 was "worse than today" without
  it); the fallback reply does not pretend to have understood a command.
- *From the delivery critic:* the cut into clusters by file ownership, and two facts that changed
  the briefs: the budget amounts exist only inside a sentence (`src/core/budget-checker.ts`), and
  a question carries no default (`src/shared/contracts/asks.ts`).
- *From the minimalist:* no retry that overrides the operator's routing rule; no re-growing card
  near expiry; cut the "wants review, groundwork done" and "gone quiet, last terminal line"
  lines from this run.

**Rejected, with the reason.**

- *"Quote the question in her briefing"* (three designers). Her briefing deliberately never
  carries a question's text, so that a task cannot shape her sentence
  (`src/core/lucy-operator/operator-briefing.ts`, header). The briefing names the task; the card
  beside it shows the text as data.
- *"Tell the operator why she is silent, restart the speech service"* (three designers). Built on
  my wrong sentence; see R8-F4.
- *"Delete the room", "make her Telegram-only", "remove the 3D view"* (the skeptic, the
  minimalist). The operator asked for a window three times; whether it earns its place is the
  operator's call, and it is asked with a mock-up rather than decided here.
- *"Open the column by default on a wide window"* (the surface designer). Nothing in the history
  says an uninvited panel is wanted; today's visit lasted nine seconds.
- *Browser notifications, a tab title that changes, a sound.* Telegram already reaches the
  operator away from the screen, and 2 of 2 answered questions came from it.

**Left open by the critics, and true.** The walkthrough's verdict on the brief's own words: "nice
chat: no", "too small: no". Slices 0 to 3 do not make the conversation more rewarding (they make
it answer), and they do not make her bigger. The desk and the actions are where those two words
would be met, and the minimalist's objection to both stands until somebody uses them. That
disagreement is the question put to the operator.

### Asked of the operator during the run (`kookr ask`, not waited on)

- `7d6f17c077c9`, her model: fix the routing rule on OpenRouter, switch her model, or let Kookr
  retry other providers. Cluster A does not depend on the answer.
- `3f64fe78f3ba`, the full window: desk after the four fixes (recommended), desk first, no desk,
  or batch actions too. With the mock-up page.

## Suggested priority order

1. **She answers** (R8-F10): cluster A, and the operator's routing rule. Nothing else about the
   conversation matters while every turn fails.
2. **The dashboard stops saying "nothing waiting"** (R8-F3): cluster B. The only change that
   works with her closed and costs the operator nothing.
3. **The decision at the bubble, the question unfolded** (R8-F2): cluster D.
4. **Lines that name the task and the amount; expired questions that say what was done**
   (R8-F5, R8-F8): clusters C and F.
5. **The text field and the dead button** (R8-F7): cluster E.
6. **The desk** (R8-F6, R8-F9) and **batch actions**: the operator's call; not started.
7. Carried over and still open: R7-F5 (a permission card's buttons die after five minutes), R7-F8
   (the top bar at 1000 px), approving through Lucy (the last slice of #3632), #4149, #4183.

## Session log

- 17:28 Setup. The task received the playbook text of a checkout 779 commits behind
  (`/home/jean/git/kookr`): its copy still says "ask before push". The current playbook
  (`git show origin/main:.kookr/playbooks/ux-dogfood-loop.md`) and `CLAUDE.md` say to deliver
  without asking (#4156); this run follows the current one. `implement` is true.
- 17:30 Worktree `kookr-dogfood-202611-run8` from `origin/main` @ `e33d8654d`. No unpushed work
  from earlier runs: run 7's document names #4148, #4150 and #4153 as merged, and the follow-ups
  #4151, #4154 and #4166 are merged since.
- 17:31 to 17:33 Live read-only probe (nine page loads, about 80 s in all, no click). Screenshots
  and `measurements.json` in `/tmp/kookr-ux-shots/r8/live/`.
- 17:35 Read `~/.kookr/lucy-interactions.jsonl` and `~/.kookr/asks/asks.json`: R8-F1, R8-F2.
- 17:40 Six Sonnet designers started, blind to each other (lenses: the Jarvis loop, the surface,
  "more surface is the wrong fix", actions, proactivity, the conversation).
- 17:36 to 17:45 The conversation designer's three test questions and one of mine all failed after
  28 s: R8-F10. Reproduced against OpenRouter directly (five request shapes, all 429 from Sail
  Research).
- 17:50 Round 2: four Sonnet critics attack the synthesis (what to cut, failure modes, delivery,
  a walkthrough as the operator).
- 17:52 Mock-up page published; two questions put to the operator with `kookr ask` (no wait).
- 17:55 Four cluster worktrees from `origin/main` (`kookr-r8-a-model-fallback`,
  `kookr-r8-b-one-waiting-list`, `kookr-r8-c-named-lines`, `kookr-r8-d-decision-bubble`), one
  implementer each. Host load 52 before they started (the fleet's own work).
- 18:05 Correction: speech is switched off in `.env`, it did not fail to start. R8-F4 rewritten;
  the mock-up page corrected.
- 18:25 RFC pushed, pull request #4270 opened (stays open as this log).
- 18:40 The operator answered both questions on Telegram: "Build the desk after the 4 fixes" and
  "Switch her to another model".
- 18:45 Cluster A reviewed by me: its 8-second deadline would have cut healthy turns (9 of 30 past
  turns took over 5 s to their first text, one 9.4 s) and it could not see reasoning arrive. Sent
  back; now 12 s of provider silence, reasoning counts.
- 18:55 Probing "another model" through the operator's account: every other model and every other
  provider is refused by a workspace guardrail. Baseten answers in under a second. Cluster G
  started (stacked on A).
- 19:00 Clusters A, B and C to independent review (fresh context, blind to the implementers).
  Cluster D built; sent back to rebase onto B, which touches three of the same files.
- Scope choice: this run does not re-drive the launch dialog, the live terminal or the rating
  flow (runs 1 to 4 did, and the brief is Lucy), and launches no task of its own.
