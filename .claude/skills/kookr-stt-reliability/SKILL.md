---
name: kookr-stt-reliability
description: Verify Kookr dictation recovery and long-recording transport with CPU lifecycle tests and paced browser speech runs. Requires the Kookr source checkout.
---

# Dictation recovery and long recordings

Use this when changing Kookr's microphone capture, provisional text recovery,
rolling speech buffer, or finalization. These checks establish whether captured
speech reaches its original input; recognition accuracy needs a separate,
listened-to reference.

For vocabulary changes, replay the same audio with and without the hint through
both partial and final requests, keeping the language setting fixed. A hint can
correct a technical name yet introduce repeated or unspoken text elsewhere.
Check output content as well as hint delivery before enabling a new default.

1. Read `docs/reference/speech-recognition.md`, the relevant `R19` requirements,
   `useSTT`, the PCM worklet, and the Node STT lifecycle. Check the actual service
   health and model identity. Never infer browser delivery from an HTTP 200.
2. Run CPU tests before real inference. STT tests must disable corpus capture by
   default; corpus-specific cases opt in only to temporary directories. Keep
   test fixtures out of the operator's configured corpus. Use an isolated
   Python environment matching the supported runtime for `stt/qwen` tests.
3. Reproduce defects before changing behavior. Cover unflushed microphone samples,
   delayed/hung inference, stop while busy, exact audio cursors after rolling
   trim, failed cache updates, and late responses after clear/disconnect. An
   incomplete result must remain explicitly incomplete.
4. Check GPU activity, then serialize speech runs through one safe local endpoint.
   Do not restart production or change the model for a lifecycle check. Start
   an isolated Node speech service with corpus disabled and a test app using
   `e2e/test-server.ts`. Spawn the test app with `sanitizedChildServerEnv` from
   `e2e/child-server-env.ts`; directly inheriting the shell enables live adapters.
5. Use known or explicitly constructed recordings at a short duration, roughly
   two minutes, just below/above five minutes, and at least ten minutes. Include
   identifiable speech near the start/middle/end, natural pauses and a long
   silence. Keep audio and full recognized text local. Corpus archival's
   five-minute limit is independent of the rolling recognition buffer.
6. Run the ten-minute case through the browser at natural pace. The harness uses
   a WebAudio source as the microphone, the shipped AudioWorklet and actual
   speech WebSocket; it does not submit a task:

   ```sh
   node scripts/verify-live-dictation.mjs \
     --app-url http://127.0.0.1:18037 \
     --stt-url ws://127.0.0.1:18036 \
     --audio /path/to/known-recording.wav \
     --output /path/to/private-evidence
   ```

   Pass `--browser /path/to/chrome` when using an installed Chrome instead of
   Playwright's Chromium. The output contains a screenshot and `result.json`
   with recording duration, time to first partial, stop-to-final latency,
   negotiated deadline, sent sample count and received events. Inspect the
   actual start/middle/end content; a successful final frame alone is insufficient.
7. Exercise recovery in the real launch dialog: timeout (both default and
   negotiated deadlines), disconnect, close/reopen, reload, storage failure,
   empty result, second recording and another task/field. Preserve typed text
   and require explicit restore/copy/discard. Leave an inspectable screenshot
   or video, and report measured durations rather than claiming unlimited
   recordings from mocked tests.

When the recognizer cannot finalize text before unprocessed audio leaves the
bounded window, a visible failure with recoverable text is truthful. Record
that limit separately from ordinary substitutions or hallucinations. Cancelling
Node's HTTP request cannot interrupt Python inference already running; retain
its concurrency bound until the underlying GPU job finishes.

## Corpus corrections and launch ownership

When changing capture identity, launch snapshots or corpus review, use the CPU
browser fixture. It runs the shipped speech protocol, corpus writer and dashboard
proxy against a temporary corpus with controlled inference responses:

```sh
pnpm test:stt
pnpm build:frontend
pnpm exec playwright test e2e/dictation-corpus.spec.ts e2e/dictation-corpus-disabled.spec.ts e2e/voice-dictation.spec.ts e2e/voice-dictation-recovery.spec.ts --workers=1
```

The fixture can hold audio publication while Launch completes. Verify that the
same recording later receives its submitted field snapshot and the server's
actual task acknowledgement. Repeat across a reload with every editor closed:
retry recovery must run at application reconnection, not depend on mounting the
launcher or review panel. A receipt failure after a successful task launch means
association is pending; it must not report that the task itself failed.

Keep three facts separate: original recording/prediction, submitted field text,
and listened-to per-recording correction. Typed additions and multiple clips
make a whole submitted field unsuitable as a reference for each recording.
Verify candidate, reformulation and excluded exports separately from faithful
references; missing or incomplete audio cannot qualify. Deletion tests must use
fixtures and cover queued publication, retries and unsafe paths. Never test
deletion against the operator's corpus.

Corpus HTTP requests require the private `.api-token` shared through the existing
corpus directory. Give the fixture's Kookr server and sidecar the same temporary
directory, initialize the key, and authenticate direct fixture requests. Test
unauthenticated access over a real non-loopback socket: the proxy marker alone
must never permit reads, review writes or deletion. A loopback-only peer filter
is insufficient because Docker's bridge presents a different peer address to
the bundled service. Keep the credential out of exports and shared datasets.

The browser suite writes a screenshot and downloaded manifest under
`runs/dictation-corpus-browser/`. Inspect their contents before reporting success.
Keep the files available to the operator. These controlled fixtures establish
workflow integrity; they do not establish recognition accuracy.
