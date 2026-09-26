# Interrupted dictation and long-recording reliability

Verified on 2026-09-26 for issue #3366. The reported original recording was
not recovered, and its timeout could not be attributed to a particular request.
These experiments establish recovery behavior and specific lifecycle defects;
they do not establish the cause of that earlier incident.

## Method

The real runs used the configured Qwen3-ASR 0.6B service on an RTX 3090, one
recording at a time. GPU activity was checked before each run; other workloads
were left running. An isolated browser app and Node speech service shared the
existing inference endpoint. Corpus collection was disabled in both these runs
and the CPU test configuration. The operator's archival opt-in was unchanged.

Five fixtures were constructed from a known prerecorded French lesson. Each
has distinct speech near its start, middle and end, shorter repeated passages,
natural pauses and, in the longer cases, a long silence. They are test fixtures,
not the operator's missing dictation. Raw audio, full recognized text, fixture
hashes and browser evidence remain local.

`scripts/verify-live-dictation.mjs` plays each fixture at its natural pace through
WebAudio, the shipped microphone worklet, a browser WebSocket and the speech
service. It records the first non-final preview after audio transmission starts,
stop-to-final latency, the negotiated deadline, sent samples and all received
events. Source playback and capture include a small scheduling offset; the
fixture duration is distinct from the slightly longer transmitted silence.

## Measured browser runs

| Fixture duration | First preview | Stop to final | Outcome | Start / middle / end |
| --- | --- | --- | --- | --- |
| 45 s | 2.292 s | 2.765 s | One successful final | Each present once |
| 2 min 00 s | 2.285 s | 2.065 s | One successful final | Each present once |
| 4 min 50 s | 2.384 s | 1.054 s | One successful final | Each present once |
| 5 min 10 s | 2.374 s | 2.299 s | One successful final | Each present once |
| 10 min 10 s | 2.244 s | 2.723 s | One successful final | Each present once |

All five browser runs completed without a timeout or browser error. The
ten-minute-ten-second source played for 609.918 seconds; capture sent 611.352
seconds including scheduling silence. The three distinct semantic anchors
were present once each in every final transcript. This is boundary evidence,
not a claim that every recognized word was accurate. The repeated test passage
also appeared the expected number of times: zero, one, five, five and fourteen
respectively. No missing or extra passage occurrence was observed in this matrix.

The Qwen browser deadline remained 125 seconds, covering the service's existing
120-second finalization budget and delivery allowance. No timeout was increased.
A separate browser regression verifies the existing fifteen-second fallback
when the service does not advertise a deadline.

A ten-minute-ten-second run against the original base also completed, taking
2.485 seconds after stop. Thus recording length alone did not reproduce the
operator's timeout. The deterministic regressions below reproduce boundary
losses. The constructed browser recordings exercise the full capture path;
they are not a recognition-quality benchmark. Recognition sometimes inserted words
or changed spelling during pauses. Those inaccuracies are separate from the
transport and finalization defects below, and model behavior was not changed.

## Reproduced defects and corrections

| Failure reproduced before the fix | Corrected behavior and regression evidence |
| --- | --- |
| Closing the launch dialog loses its provisional preview; the browser reproduction cannot find recovery on reopening. | Text remains owned by its original draft and field, with explicit restore/copy/discard. Browser regressions cover timeout, disconnect, close/reopen, reload and context isolation. |
| Stopping capture drops the worklet's pending samples below its 4,096-sample output block. | Stop waits for a bounded worklet drain before sending the service stop message. Tests compare exact samples and exercise a missing acknowledgement. |
| Finalization can reuse text while a short audio tail remains unprocessed; a failed pass can advance the position recorded as successfully transcribed. | Cache reuse requires an exact processed position. Failed passes preserve the previous successful state. Tests include a final 100 ms segment and a failed second inference pass. |
| Progressive previews do not update the server's fallback text; failure can be sent as a successful final result. | Finalization failure sends an error carrying available incomplete text. Delayed and hung-backend tests cover the deadline, busy stop and late results. |
| Unprocessed audio can leave the bounded window without a truthful failure. | Window exhaustion reports `audio_window_exhausted`, retains the prior preview and closes the connection. A real WebSocket CPU regression overflows a three-second test buffer while inference is pending. |
| Clear or disconnect can leave old asynchronous work able to change later state. | A per-recording identity rejects stale events; Qwen HTTP requests receive cancellation. Tests resolve old work after clear and check that it cannot deliver or mutate a new recording. |

Accelerated CPU tests represent 45, 120, 290, 310 and 610 seconds of audio through
the real WebSocket handler with a deterministic recognizer. Every expected marker,
including the last short segment, must appear exactly once. These tests establish
segment accounting independently of speech recognition accuracy.

## Limits

The recognition buffer retains five minutes of audio while finalized sentences
remain as text. If recognition falls behind enough that unprocessed audio is
trimmed, recovery is explicitly incomplete. This is a backlog threshold, not
a five-minute maximum recording duration. Corpus archival independently omits
complete browser recordings over five minutes; this change does not alter it.

Recovery retains up to twelve text drafts of 100,000 characters each for
24 hours. Storage failure falls back to the current tab, with a visible warning
that reload recovery is not guaranteed. Empty recognition cannot recover words
that were never recognized. Recordings shorter than half a second keep their
existing empty-result behavior.

Cancelling a Qwen HTTP request rejects its later result but cannot interrupt an
inference already executing in Python. That job retains its bounded GPU slot
until it finishes. The tests do not claim arbitrary recording lengths, arbitrary
GPU contention or perfect recognition.

## Reproduction

See `.claude/skills/kookr-stt-reliability/SKILL.md` for isolation and browser
replay instructions. CPU checks are `npm test` in `stt/`, the recovery/worklet
Vitest tests, and `e2e/voice-dictation-recovery.spec.ts`. Local evidence contains
the duration matrix, original failing regressions, JSON measurements and UI
screenshots; it is deliberately excluded from the public repository.
