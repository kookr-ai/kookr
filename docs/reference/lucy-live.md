# Lucy live: hands-free conversation with the avatar

Lucy live lets you talk to Lucy, the character in the optional avatar panel, and hear her answer
about a second after you stop speaking. You can talk over her to stop her, and a cough or a click
does not. This page covers setup,
how a turn works, the timings measured when it was built, and its limits. The user-facing summary is
in [features](../features.md#talk-to-lucy-hands-free-optional-off-by-default).

## Setup

1. Turn on the speech service (`KOOKR_TTS=true`, a GPU makes her voices fast) and a Baseten helper
   model (`KOOKR_BASETEN_API_KEY`). Both are existing Kookr settings.
2. Let Kookr run Lucy's ears, a local speech recogniser that needs an NVIDIA GPU (about 3.2 GB of
   GPU memory). Add `KOOKR_LUCY_EARS=true` to Kookr's `.env` and restart Kookr:

   - Kookr starts `lucy-ears/docker-compose.yml` in the background (Docker compose project
     `lucy-ears`, container `kookr-lucy-ears`) and waits for its `/health`. The first start downloads
     about 2.4 GB of model weights into the `lucy-ears-models` volume, so it can take several minutes
     (`KOOKR_LUCY_EARS_HEALTH_TIMEOUT_S`, default 900, bounds the wait). Kookr itself does not wait:
     it comes up at once and Lucy live switches on by itself when the recogniser is healthy.
   - It listens on `127.0.0.1:8095` only (`KOOKR_LUCY_EARS_PORT` changes the port).
   - A routine Kookr restart leaves the container running, so the next start reuses it. To free the
     GPU memory run `pnpm prod:stop --with-sidecars`.
   - Without an NVIDIA GPU (no `nvidia` runtime in Docker) nothing is started and the status says so.
   - A recogniser already started by hand with the same compose file is adopted as is: same
     container and weights, nothing downloaded again.

   **Running it yourself instead.** Start it with
   `docker compose -f lucy-ears/docker-compose.yml up -d`, then set
   `KOOKR_LUCY_EARS_URL=ws://127.0.0.1:8095` (or the address of a recogniser on another machine).
   When `KOOKR_LUCY_EARS_URL` is set, Kookr uses that recogniser and never starts or stops one,
   even if `KOOKR_LUCY_EARS=true` is also set. If its host is not a loopback address (`localhost`,
   `127.x.x.x` or `[::1]`), Kookr logs one warning at start-up: the recogniser receives your
   microphone audio, so your voice then leaves this machine. Lucy live still switches on.
3. Open the avatar panel (Settings → Notifications & Alerts → Avatar panel) and press **Talk**.

`GET /api/lucy-live/status` reports whether everything is configured, and if not, what is missing.
While Kookr is still bringing the recogniser up it answers `available: false, starting: true` with a
reason that mentions the download, rather than a plain "unavailable".

## How a turn works

Four models share the work, each doing what it was measured to do well:

| Part | What does it | Why this one |
|---|---|---|
| Hearing when you start and stop | A voice detector in the browser | Reacts in the same instant, so her volume can drop with no network round trip |
| Confirming that it was speech | Silero VAD v5 in the Kookr server | Tells a voice from a cough or a door in about 1 ms per 32 ms of audio, so only speech stops her |
| Turning speech into text (her ears) | LFM3-Omni-2B in llama.cpp, local GPU | Final text about 0.2 s after you stop, because it reads the audio while you speak |
| Deciding what to say (her brain) | Kookr's helper model on Baseten | Answers from the task status without inventing facts |
| Saying it (her voice) | Kokoro, the voice you chose in Settings | Renders a sentence in a fraction of a second |

While you speak, the browser streams your audio to the Kookr server, which forwards it to the
recogniser. About once a second the recogniser re-reads everything said so far, so the text on screen
is a draft that improves as you talk. When you stop, the final text goes to the helper model with the
current task status. Its answer is cut into sentences as it arrives; each sentence is made speakable,
turned into audio and sent to the browser, so the first sentence plays while the rest is still being
written.

**Interrupting her.** The browser's detector only knows that something loud happened, so it does
not stop her on its own. When you start speaking while she is busy (from the moment you finish a
question until she has finished answering it, or while any of her audio is still playing), three things
happen:

1. The browser turns her volume down to a quarter within about 30 ms and sends your audio to the
   server as a *candidate* interruption. Her answer carries on in the background and any sentence
   already on its way still arrives.
2. The server runs the candidate's audio through Silero (a small neural network that gives the
   probability that each 32 ms slice is human speech, the same model Kookr's dictation uses to skip
   silence). Three slices above 0.5 (about 0.1 s of voice) confirm it. The server then sends
   `speech_confirmed`, abandons her answer (the history keeps only what you heard, marked as
   interrupted) and treats the candidate's audio as the start of your next turn.
3. On `speech_confirmed` the browser stops her sound and clears whatever was queued. If instead the
   sound ends first, or about 0.7 s pass with no voice, the server sends `speech_rejected`, drops the
   audio, and the browser brings her volume back and plays on. If neither message arrives within
   1.5 s the browser stops her anyway, because a stuck connection is more likely to mean "stop" than
   "keep talking". It then sends `barge_in`; because the server still holds that candidate undecided,
   it treats `barge_in` as a confirmation (abandons the answer and listens to the candidate's audio
   as your turn), so the words you keep saying are not lost.

**Speaking with pauses.** The browser ends a turn after 0.6 s of quiet, or after 30 s of speech, so a
long request often arrives as several parts. Talking over her only stops her once she has started to
speak (the server is in `speaking`). If you start again while she is still turning your words into text
or thinking (`transcribing` or `thinking`), nothing has been said yet, so the new speech is the rest of
the same request: the earlier part ends as `interrupted` with the reason "continued", the new part
carries its text, and she answers the whole request once, as one turn. The panel shows the request
growing: the earlier text first, then drafts of the whole. A new sound that turns out not to be speech
(`speech_cancel`) leaves the earlier parts to be answered alone. With the voice check on, the
choice is made by when you started: if you began before she said anything, the part joins even if one
of her sentences slipped out while the check was deciding. Every part's text is written to
the interaction log (redacted as usual), including parts that ended `interrupted`; a part that was
joined to a later one says so in its `reason`. When a turn is cut at 30 s, the browser raises its noise floor only if the turn was flat like a fan
(its average is within 6 dB of its quietest quarter second); a long request keeps the floor, so the
words that follow are heard at the usual bar.

If a loud sound goes on and on (a fan switched on, a drone) and Silero rejects it, the browser treats
that sound as background noise: its noise floor rises to the sound's level, so the same sound does not
duck her again every moment. Speech clearly louder than the noise is still heard, and the floor falls
back by itself once the room is quiet.

Because Silero filters the noise, the browser's own bar for a candidate while she talks is 0.15 s of
loud sound, down from 0.3 s. Silero also guards ordinary turns: if a whole turn never contains a
slice it calls speech, the turn ends as empty without asking the recogniser, which stops invented
text such as "Merci." on silence. The browser reports `barge_in_duck`, `barge_in_stop` and
`barge_in_rejected` timings, measured from the moment its detector fired.

LFM3-Omni can also answer by itself, and it is the model behind the in-browser Ava experiment. It is
used here only as ears because, given the same task status, it invented answers to five of six
questions it could not know (a pull request "was merged", "we've spent 118 hours today"). The helper
model answered all ten test questions without inventing anything.

## What she answers from, and what leaves the machine

With Talk on and launching off, each answer comes from the helper model on Baseten, a model provider
outside your machine. With each question Kookr sends it Lucy's instructions, the last few exchanges of
the conversation, your words (as the recogniser heard them, secrets hidden) and a short task status, at
most 2,500 characters, built fresh for every turn. In order, the status holds:

1. **Needs the operator.** Every live task that is waiting on you, the longest wait first: its short
   name, its project, why it waits and for how long. The reasons are Kookr's own words, the same
   findings the operator conversation's board shows: waiting for permission to use a tool (for example
   "permission to use Bash"), it asked a question in its session, it says it is finished and wants
   review, it has stalled and gone quiet, it keeps hitting the same error, and so on. At most eight are
   listed, with how many more wait. When nothing waits it says so. When the status is too long, this
   part is the last to be cut.
2. **The integration train**, when this server watches one (the production port): halted, for how
   long and why in plain words ("main itself fails the full test suite"); stalled, when merged changes
   have not reached `main` for a while and the train is not running; otherwise a short all-clear.
3. **Questions from tasks** (`kookr ask`): the ones waiting, with their choices, and the ones closed in
   the last few minutes (see [Questions from tasks](#questions-from-tasks)).
4. **Task counts and lists:** how many tasks are in each state, the unfinished ones with when they last
   changed, and the six that ended last, with the reason a stopped one gave.

What is never sent:

- the command, file path, URL or any other text a permission prompt shows. Only the tool's name goes,
  and only when Kookr took it from the agent's own permission request (not from the terminal screen)
  and it looks like a tool name (`Bash`, `WebFetch`, `mcp__github__create_issue`), not a secret;
  otherwise she says "a tool";
- the text of a finding or of a task's "finished" note: an agent may have written it;
- the train's halt reason as the train wrote it, and its last-cycle detail, which can quote test output.
  An unknown halt reason becomes "a problem it reported";
- long or unpronounceable task titles (they become "a task with no short name"), task requests, terminal
  output and ids. Task names, project names and question text pass through the same secret redaction as
  the spoken summaries, and terminal codes are removed.

She can tell you what waits and why; she cannot answer a permission prompt or review a task. The
dashboard does that.

Measured against the real helper model with `scripts/measure-lucy-needs-operator.ts` (ten questions
such as "what needs me?", "is anything stuck?" and "is the train running?", over three made-up
situations: a Bash permission prompt plus a task waiting for review; nothing waiting; a stalled task, a
waiting question and a halted train), three runs, 90 answers on 16 Nov 2026: 89 named the right task
(or, with nothing waiting, said so), and none invented a task, a time or a train state, by the script's
word checks and on reading every answer. The weak spot is "does anything need my review?" with only a
stalled task waiting: once she offered the stalled task as the thing to review, and twice she began
"yes, one task needs you" before saying that nothing waits for review. With the train healthy, "are my
merged changes reaching main?" got "I don't have that" each time: the all-clear line does not say so.

## Measured timings

Measured on 2026-11-11 on an RTX 3090 shared with Kookr's other speech services and an unrelated
model server. Test speech was synthetic English, streamed at real-time pace. These are small samples
on one machine; treat them as orders of magnitude.

| Step | Median | Worst seen |
|---|---|---|
| End of speech → final transcript (LFM3-Omni) | 0.20 s | 0.50 s |
| Same, with today's CPU Whisper dictation backend, for comparison | 2.0 s | 3.2 s |
| Transcript → first sentence of the answer (helper model) | 0.27 s | 0.53 s |
| First sentence → its audio (Kokoro) | 0.29 s | 0.56 s |
| **End of speech → first sentence ready to play** | **0.83 s** | **1.06 s** |

The voice detector waits for about 0.6 s of silence before it decides you have stopped, so from your
last word to her first sound is about 1.4 s. Each turn logs its own timings in
`~/.kookr/lucy-interactions.jsonl` (lines of kind `live_turn`).

The whole path was then checked in a real browser: headless Chromium with a WAV file as its
microphone, against a Kookr dev server, the recogniser, the speech service and the helper model.

| What was checked | Result |
|---|---|
| Detector decides you stopped → her first sound, in the browser | 0.97–1.14 s in most turns |
| You talk over her → her audio ducks | 6 ms or less |
| Silero confirms it was speech → her audio stops | 112 ms after the detector fired |
| A loud 400 ms noise burst while she talks | Ducked, rejected by Silero 260 ms later, her sentence played on |
| A noise-only turn while she is quiet | Dropped as empty, the recogniser was never asked |

Some turns were slow: the final transcript took 1–3.9 s instead of about 0.3 s, in about one turn in
four, and a later run timed out once. The GPU was shared during all of these measurements: an
unrelated model server ran two GPU processes, and the operator was fine-tuning a language model on
the same card. Requests sent straight to the recogniser during the same period were mostly fast, so
the likely cause is GPU contention, but it is unconfirmed. Re-measure on an idle GPU before treating
any number on this page as typical. `asrMs` in the log shows which turns were slow.

On 16 real French dictation recordings the recogniser was about as accurate as Kookr's CPU Whisper
backend: better on some phrases, worse on names (it heard "Kookr" as "Cooker" and "Lucy" as
"Lucie"). On near-silent audio it can produce invented text such as "Merci."; Kookr discards turns
that Silero found no speech in, and then turns that are too short or match known silence phrases.

Silero's measured output with the shipped model: probabilities up to 0.998 on a real spoken clip
(46 of 57 slices above 0.5), and at most 0.18 on 20 ms clicks, 150 ms bursts of loud white noise, a
sustained loud noise and silence (none above 0.5). The noise tests are in
`src/adapters/lucy-live/silero-vad.real.test.ts`.

## Questions from tasks

A running task can ask you a multiple-choice question with [`kookr ask`](cli.md#kookr-ask). The
question goes to your phone over Telegram. If the dashboard is open and the avatar panel is on, Lucy
asks it as well, whether or not hands-free talk is switched on.

**What you see and hear.** The panel shows a card: which task is asking, the question, the background
the task gave (folded under "Background"), a button for each page the question links to (`kookr ask
--link`, for example "Open mockups", which opens a new tab), an **Open task** button that selects the
asking task in the dashboard, one button per choice, a box for a typed answer when the task accepts
one, and how long the question stays open. URLs written in the question or its background are
clickable. If the task cannot be shown (it has no live session in the dashboard), the card says so. Lucy reads out who is asking, the question and
the choices. She does not read the background: it usually holds paths and numbers that are easier to
read than to hear. While a question is waiting, the list of recent messages is hidden to make room.

**One question, two places to answer.** Telegram and the panel show the same record, kept by the Kookr
server. Whichever answer arrives first is the answer; the task gets it as the same typed line either
way.

| You answer | What happens in the other place |
|---|---|
| In Lucy's panel | The Telegram message is edited to "✅ Already answered in Kookr: *choice*. Nothing more is needed here." and its buttons disappear. A later tap or reply there is told the same. |
| On Telegram | The card turns into "Answered on Telegram: *choice*" within a moment, with no reload, and Lucy stops reading the question if she was. |
| In both at the same moment | Exactly one wins. The other is told the question was already answered. |

A closed card (answered, expired, or withdrawn by the task) stays for 10 minutes and can be dismissed.
If Kookr recorded your answer but could not type it into the task's session, the card says so; the task
can still read the answer from Kookr. If Kookr does not confirm an answer within 10 seconds (the
connection dropped as you pressed), the card says so and you can press again.

**When she speaks.** Everything else Lucy says follows a press on a speaker button or something you
said to her. A question, and a task that has waited on a permission prompt (next paragraph), are what
she says unprompted, under these rules:

- once, when the question arrives. A reload or a reconnect lists the question again but does not make
  her ask again;
- in one browser tab. With several Kookr tabs open they agree on which one speaks, and a visible tab
  goes first;
- not with sound off in Settings or Do Not Disturb on. The clip is then kept in her message list,
  marked unheard, and the Replay button plays it;
- the same when the browser refuses to start audio because you have not clicked in the page yet;
- after anything she is already saying, one question at a time; she waits up to 45 seconds, then
  leaves it as unheard;
- she stops if the question is answered, withdrawn or expires while she is reading it.

**A task waiting for your permission** (issue #3932). When a task's agent has waited on a permission
prompt ("Claude needs your permission") for 60 seconds, her panel shows a card with the task, the tool
and the whole command (secrets hidden), and the same Approve once and Deny buttons as the finding card.
They send the same checked message, so a press meant for a prompt that is no longer on screen does
nothing. A button is shown only when its option is on the task's screen; the dashboard keeps a press
valid for 5 minutes after the prompt appeared, after which the card says to answer in the task's
terminal. The card goes as soon as the prompt is answered anywhere (here, on the finding card, on
Telegram or in the terminal), or the task stops. She also says one sentence, written by the server from
a fixed pattern and never from text an agent wrote:

> The task "Fix the login page" is waiting for your permission to use Bash. The command is on my card.

The command is never spoken. A task name that cannot be read aloud (too long, an id or a path in it)
becomes "A task", and a tool that is not a plain word becomes "an MCP tool" or "a tool". At most one such
sentence every 2 minutes: cards that arrive in the meantime are said together once the gap is over
("Two more tasks are waiting for you."), leaving out the ones answered by then. The rules above apply
(sound off, Do Not Disturb or quiet hours, or no click in the page yet: the card and an unheard clip,
no sound; one tab; a reload does not repeat it), and she stops if every prompt the sentence is about
is answered while she says it. Each spoken notice is one `said` line (`source: "permission_notice"`)
in `lucy-interactions.jsonl`. The delay is the `lucyPermissionNoticeAfterSeconds` setting in
`~/.kookr/settings.json` (whole seconds, 0 to 3600; 0 turns these cards and sentences off; at 300 or
more the card arrives after the 5-minute button limit, so it never has buttons). With no dashboard open
the sentence waits: she says it once one is. The
3-minute page to your phone and the Telegram card (issue #3925) are separate and unchanged.

**Hands-free talk.** With Talk on, the status Lucy answers from also lists the questions that are
waiting and the ones closed in the last 10 minutes, with where the answer came from. Ask her "does
anything need me?" and she can tell you.

**Opening it by voice.** While a question is waiting, say "show me", "open it", "show me the
mockups" (or the words of a link's label) to open its first link, or the named one, in a new tab, and
"show me the task" to select the task that asked. This always concerns the newest waiting question,
and the whole sentence must be the request: "show me the status of the build" is an ordinary question.
A wording she does not recognise as such a request ("show me the artifact from the question") opens
nothing: she says so and points you to the buttons on the question card.
Lucy then says what happened: the tab is open; your browser blocked it (a tab opened by voice has no
click behind it, so browsers usually block it until you allow pop-ups for the Kookr dashboard once;
the button on the card always works); the question has no link; or no question is waiting. Words heard
while her own voice was still audible never open anything.

**Answering by voice.** You can say one of the listed choices ("run it tonight"). A misheard word would
send the wrong decision to a task and that cannot be undone, so it takes two turns:

1. Your words are mapped to one listed choice (or to none) by a separate helper-model call that answers
   with numbers only. She then reads the choice back in words built from the question's own choice
   text, never from the model's: "You want: run it tonight. Shall I send that?" With two or more
   questions waiting the read-back names the task, and if your words fit more than one question she
   asks which one you mean instead.
2. She sends it only when your next turn is a clear yes ("yes", "go ahead", "send it", ...) as the whole
   sentence. "No" cancels. Anything else cancels and is handled as a new request. A yes that began while
   her voice was still audible, a yes more than 20 seconds after she finished the read-back, and any yes
   after she was interrupted mid read-back all send nothing.

Just before sending she checks that the same question is still waiting with the same choice. The answer
goes through the same audited path as the panel's buttons (one winner with Telegram, the Telegram message
edited), and she says what happened, including when the question was already answered elsewhere. A
mapping call that fails, times out or finds no match sends nothing and she answers as usual. Only the
listed choices can be answered by voice: free-text answers stay in the panel and on Telegram.

The "she cannot act" rule of the helper-model prompt was re-measured after this change
(`scripts/measure-lucy-voice-answer.ts`, against the real helper model): 10 of 10 questions about
waiting questions (cost, builds, authorship, "pick it for me", "cancel the deploy") were answered with
nothing invented, and the two spoken answers that reach her anyway ("Run it tonight.", "Yes, send it.")
produced "nothing was sent" and a pointer to the panel. The mapping call was run on 16 spoken cases,
seven that name a listed choice and nine that must not send one (a time or region that is not listed,
a bare "yes" with two questions waiting, a status question, "yes delete them" for a question that is
not waiting, "thank you", "the second one"): 16 of 16 as expected in each of three runs, and none of the
nine mapped to a choice. The model only proposes; the read-back and the yes are what stop a wrong mapping from being sent.

(With launching on, the default, spoken turns are answered by the operator conversation, whose
board does not list `kookr ask` questions yet: she cannot tell you about a waiting question by voice, but the
panel still shows and reads it aloud as before, and an answer you say is still handled by the flow above.
Tracked in #3685.)

**What it needs.** Telegram remote chat configured (without it `kookr ask` is unavailable altogether),
and the speech service (`KOOKR_TTS`) for her voice; without the speech service, or when it fails, the
card is shown and nothing is played. A voice used for the first time since the speech service started
takes several seconds to load, and a busy machine makes speech slow; Kookr allows up to 30 seconds and
tries a second time before giving up, so she may ask a little after the card appears. With the avatar panel switched off nothing is shown or spoken in the dashboard and
the question is on Telegram only. Questions are sent only to the owner's dashboard, never to a
read-only shared view.

`node --import tsx scripts/ask-lucy-browser-proof.ts` runs this end to end in a headless browser
against a throwaway server and a fake Telegram, and saves screenshots of the card in each state. With
`--autoplay-blocked` it checks the case where the browser will not start audio because nobody has
clicked in the page yet.

## Starting a task by voice

With launching on (the default whenever Lucy's operator conversation is on; `KOOKR_LUCY_LAUNCH=0` turns it off), a hands-free turn is answered by Lucy's
operator conversation instead of the helper model, so "Lucy, investigate why the issue tasks stop
chaining" becomes a launch proposal: she reads back one sentence, the avatar panel shows a card, and a
spoken "go", Enter or a click starts the task. Setup, the three permission levels and the safety rules
are in [Lucy operator](lucy-operator.md#launching-a-task-by-voice-or-text).

What matters when talking:

- **Echo.** With loudspeakers her voice can reach the microphone (still untested, see Limits). Words that
  began while she was reading the proposal aloud are ignored, as the server estimates the read-back time
  (about three words a second plus a second). They neither confirm nor drop the proposal. Use headphones,
  or click Go.
- **What is said.** Only a whole sentence of "go", "yes", "do it" or "launch it" confirms; "no" or "cancel"
  declines; anything else drops the proposal and is answered as a new request.
- **A long request with pauses** reaches her whole (issue #3674); only the last part of it is the "newest"
  message for the task writer, with the earlier parts as context.
- **When the task ends** she says so in the same conversation, in one or two sentences.
- Each connection is one conversation. Reconnecting forgets a pending proposal.

## When something goes wrong

A failure in one turn (the recogniser, the helper model or the speech service) ends that turn with
`turn_done` and `end: "error"` plus a plain-words `reason`; the panel shows the reason and the
conversation carries on with the next thing you say. A session-level `error` message with code
`bad_message` or `internal` is shown the same way while the connection is still open; only
`unavailable` or a lost connection (one automatic reconnect) turns hands-free off.

A `reason` can quote the error text the helper model's server sent back. Before it is shown or
written to the interaction log, secret-looking tokens in it are hidden, the same way as in transcripts.

Lucy live asks the helper model not to reason before answering (`reasoning_effort: "none"`), so she
can start speaking at once. If the model refuses that setting with HTTP 400, which a custom
`KOOKR_BASETEN_MODEL` may do, the turn asks again without it. Once a request without it succeeds,
later turns leave it out and Kookr logs one warning. The model then thinks
as long as it does by default, so her answers may start later.

## Limits

- Owner only. Lucy live answers from the status of every task and spends model credit, so the
  `/ws/lucy-live` upgrade is refused (403) for any viewer or other non-owner actor.

- She answers questions only, unless launching is on (the default; `KOOKR_LUCY_LAUNCH=0` turns it off), when she can also start a task you confirm ([Starting a task by voice](#starting-a-task-by-voice)). She cannot stop or approve anything yet. That includes a
  [question from a task](#questions-from-tasks): she can tell you about it, and you can answer one of its
  listed choices by voice after her read-back (see "Answering by voice" under [Questions from tasks](#questions-from-tasks)); a typed answer
  or one that is not a listed choice is not taken by voice.
- With Talk on, a question from a task is read through the ordinary clip player, not the conversation's
  own audio. Talking over it does not stop it, and her volume is not lowered while you speak. The
  conversation also does not know that this voice is hers: on loudspeakers, if the browser's echo
  cancellation lets her reading reach the open microphone, she can take it for something you said and
  answer it. This was not tested. Use headphones, or answer the question before talking to her
  ([#3711](https://github.com/kookr-ai/kookr/issues/3711)).
- She always answers in English: her voices are English voices.
- Headphones work best. Echo cancellation is on and a candidate interruption must be loud for 0.15 s
  and then pass Silero, but speaker-to-microphone echo was not tested: her own voice leaking into the
  microphone is speech to Silero and would stop her.
- Interruptions are confirmed by Silero in the Kookr server. If its model file (`stt/models/silero_vad_v5.onnx`)
  or runtime cannot load, Kookr logs one warning at start-up, `GET /api/lucy-live/status` reports
  `bargeInConfirmation: "off"`, and Lucy live still works with the older behaviour: her audio stops the
  moment the browser hears about 0.3 s of loud sound, a cough can stop her, and silence is not
  pre-filtered.
- A sound shorter than 0.25 s of speech is dropped as a misfire by the browser, so a very short interjection
  ("no!") may not stop her. Saying it again, a little longer, works.
- The recogniser needs an NVIDIA GPU with about 3.2 GB free.
- Its weights are under the LFM Open License v1.0 (commercial use is limited for organisations above
  USD 10M annual revenue). They are downloaded at runtime and are not part of Kookr.
- The recogniser's server has no API key and accepts any browser origin, so the compose file publishes
  it on `127.0.0.1` only. Do not expose that port.
