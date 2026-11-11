# Lucy live: hands-free conversation with the avatar

Lucy live lets you talk to Lucy, the character in the optional avatar panel, and hear her answer
about a second after you stop speaking. You can talk over her to stop her. This page covers setup,
how a turn works, the timings measured when it was built, and its limits. The user-facing summary is
in [features](../features.md#talk-to-lucy-hands-free-optional-off-by-default).

## Setup

1. Turn on the speech service (`KOOKR_TTS=true`, a GPU makes her voices fast) and a Baseten helper
   model (`KOOKR_BASETEN_API_KEY`). Both are existing Kookr settings.
2. Start Lucy's ears, a local speech recogniser, on an NVIDIA GPU:

   ```bash
   docker compose -f lucy-ears/docker-compose.yml up -d
   ```

   The first start downloads about 2.4 GB of model weights; later starts reuse them. It listens on
   `127.0.0.1:8095` only (`KOOKR_LUCY_EARS_PORT` changes the port).
3. Add `KOOKR_LUCY_EARS_URL=ws://127.0.0.1:8095` to Kookr's `.env` and restart Kookr.
4. Open the avatar panel (Settings → Notifications & Alerts → Avatar panel) and press **Talk**.

`GET /api/lucy-live/status` reports whether everything is configured, and if not, what is missing.

## How a turn works

Three models share the work, each doing what it was measured to do well:

| Part | What does it | Why this one |
|---|---|---|
| Hearing when you start and stop | A voice detector in the browser | Reacts in the same instant, so interrupting her needs no network round trip |
| Turning speech into text (her ears) | LFM3-Omni-2B in llama.cpp, local GPU | Final text about 0.2 s after you stop, because it reads the audio while you speak |
| Deciding what to say (her brain) | Kookr's helper model on Baseten | Answers from the task status without inventing facts |
| Saying it (her voice) | Kokoro, the voice you chose in Settings | Renders a sentence in a fraction of a second |

While you speak, the browser streams your audio to the Kookr server, which forwards it to the
recogniser. About once a second the recogniser re-reads everything said so far, so the text on screen
is a draft that improves as you talk. When you stop, the final text goes to the helper model with the
current task status. Its answer is cut into sentences as it arrives; each sentence is made speakable,
turned into audio and sent to the browser, so the first sentence plays while the rest is still being
written.

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

On 16 real French dictation recordings the recogniser was about as accurate as Kookr's CPU Whisper
backend: better on some phrases, worse on names (it heard "Kookr" as "Cooker" and "Lucy" as
"Lucie"). On near-silent audio it can produce invented text such as "Merci."; Kookr discards turns
that are too short or match known silence phrases.

## Limits

- She answers questions only. She cannot launch, stop or approve anything yet.
- She always answers in English: her voices are English voices.
- Headphones work best. Echo cancellation is on, and the detector needs longer, clearer speech to cut
  her off while she talks, but speaker-to-microphone echo was not tested.
- The recogniser needs an NVIDIA GPU with about 3.2 GB free.
- Its weights are under the LFM Open License v1.0 (commercial use is limited for organisations above
  USD 10M annual revenue). They are downloaded at runtime and are not part of Kookr.
- The recogniser's server has no API key and accepts any browser origin, so the compose file publishes
  it on `127.0.0.1` only. Do not expose that port.
