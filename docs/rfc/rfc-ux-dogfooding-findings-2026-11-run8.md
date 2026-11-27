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

**Root cause.** Not a line of code. The four findings that follow (R8-F2 to R8-F5) are what the
operator meets in the few seconds she is open: the one decision that was waiting is folded
away, what she writes names nothing, the dashboard beside her says nothing is waiting, and she
is mute.

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

### R8-F4. After a restart she is mute, and the panel says speech "is not set up" when it is (voice) — severity: medium

**Evidence.** Speech is configured on this install (`KOOKR_TTS` is set in production's `.env`).
After today's unclean restart `GET /api/lucy-live/status` answers `{"available":false,"reason":
"Lucy live needs the speech service (enable KOOKR_TTS or set KOOKR_TTS_URL)."}`, no speech
process is running, and she said nothing aloud all day: not the restart question (the same
question was spoken on 18 November), not the task question. The panel's only sign is a button
that reads "Talk is not set up", whose tooltip gives the sentence above: advice to enable a
setting that is enabled.

**Root cause.** _(to confirm in Phase 4)_ the status reports "not configured" and "configured but
not running" with the same sentence, and nothing restarts the speech service or says it is
down.

**Suggested fix.** Tell the two cases apart ("Speech is switched on and its service is not
running"), say it once in her thread when a line that should have been spoken was not, and
retry the service's start.

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
shown only when hands-free can be used (R8-F4 says why not when it cannot).

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

**Root cause.** Reproduced with the same model and key, outside Kookr. OpenRouter sends
`deepseek/deepseek-v4.1-flash-1017` to one provider, Sail Research, which answers after 20
seconds with `429 rate_limit_exceeded`, `provider_code: ttft_deadline_guard` ("temporarily
rate-limited upstream … limit_source: upstream_provider_share"), with or without tools,
streaming or not. Since #4255 (23 November, an operator decision) Kookr sends no provider
preference and the routing rule on the OpenRouter account chooses; that rule has one provider
for this model and no second choice. On Kookr's side:

- `src/adapters/llm/openrouter-chat-stream.ts:160` keeps only the error's `message` ("Provider
  returned error") and drops `metadata` (which provider, which code);
- a failed turn ends with one fixed sentence and no retry (`src/core/lucy-operator/turn.ts`);
- no health field reports her model.

**Suggested fix.** (a) For the operator: add a second provider to the account's routing rule for
this model, or choose another model for her (`KOOKR_LUCY_OPERATOR_MODEL`); asked through `kookr
ask` during this run. (b) In Kookr: say the provider's real error ("OpenRouter: Sail Research is
rate-limited, 429"); give up on the first token after 8 seconds instead of 28; when the model
fails, answer from the board without it and say so; report her model's last success and failure
in `/api/health`.

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

_(written after the brainstorm)_

## Suggested priority order

_(written after the brainstorm)_

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
- Scope choice: this run does not re-drive the launch dialog, the live terminal or the rating
  flow (runs 1 to 4 did, and the brief is Lucy), and launches no task of its own.
