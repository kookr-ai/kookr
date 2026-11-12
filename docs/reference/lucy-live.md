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
   even if `KOOKR_LUCY_EARS=true` is also set.
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
the task gave (folded under "Background"), one button per choice, a box for a typed answer when the
task accepts one, and how long the question stays open. Lucy reads out who is asking, the question and
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

**When she speaks.** Everything else Lucy says follows a press on a speaker button or something you
said to her. A question is the one thing she says unprompted, under these rules:

- once, when the question arrives. A reload or a reconnect lists the question again but does not make
  her ask again;
- in one browser tab. With several Kookr tabs open they agree on which one speaks, and a visible tab
  goes first;
- not with sound off in Settings or Do Not Disturb on. The clip is then kept in her message list,
  marked unheard, and the Replay button plays it;
- the same when the browser refuses to start audio because you have not clicked in the page yet;
- after anything she is already saying; she waits up to 45 seconds, then leaves it as unheard;
- she stops if the question is answered, withdrawn or expires while she is reading it.

**Hands-free talk.** With Talk on, the status Lucy answers from also lists the questions that are
waiting and the ones closed in the last 10 minutes, with where the answer came from. Ask her "does
anything need me?" and she can tell you. She cannot take an answer by voice: a misheard word would
send the wrong decision to a task, and that cannot be undone. Press the choice in her panel or answer
on Telegram.

**What it needs.** Telegram remote chat configured (without it `kookr ask` is unavailable altogether),
and the speech service (`KOOKR_TTS`) for her voice; without the speech service, or when it fails or
takes more than 15 seconds (a voice loading for the first time can), the card is shown and nothing is
played. With the avatar panel switched off nothing is shown or spoken in the dashboard and
the question is on Telegram only. Questions are sent only to the owner's dashboard, never to a
read-only shared view.

`node --import tsx scripts/ask-lucy-browser-proof.ts` runs this end to end in a headless browser
against a throwaway server and a fake Telegram, and saves screenshots of the card in each state.

## When something goes wrong

A failure in one turn (the recogniser, the helper model or the speech service) ends that turn with
`turn_done` and `end: "error"` plus a plain-words `reason`; the panel shows the reason and the
conversation carries on with the next thing you say. A session-level `error` message with code
`bad_message` or `internal` is shown the same way while the connection is still open; only
`unavailable` or a lost connection (one automatic reconnect) turns hands-free off.

## Limits

- Owner only. Lucy live answers from the status of every task and spends model credit, so the
  `/ws/lucy-live` upgrade is refused (403) for any viewer or other non-owner actor.

- She answers questions only. She cannot launch, stop or approve anything yet. That includes a
  [question from a task](#questions-from-tasks): she can tell you about it, but an answer you say out
  loud is not recorded.
- With Talk on, a question from a task is read through the ordinary clip player, not the conversation's
  own audio. Talking over it does not stop it, and her volume is not lowered while you speak. The
  conversation also does not know that this voice is hers: on loudspeakers, if the browser's echo
  cancellation lets her reading reach the open microphone, she can take it for something you said and
  answer it. This was not tested. Use headphones, or answer the question before talking to her
  ([#3680](https://github.com/kookr-ai/kookr/issues/3680)).
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
