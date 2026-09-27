# Local speech recognition

Kookr uses Qwen3-ASR 0.6B for bundled NVIDIA GPU recognition and Whisper
`base` on CPU. The browser keeps its existing microphone controls and draft
preview. Telegram uses the same selected model when its audio URL points to
the bundled HTTP service.

## Model and vocabulary

Enable the bundled service in `.env`:

```dotenv
KOOKR_STT=true
KOOKR_STT_DEVICE=gpu
QWEN_ASR_MODEL=Qwen/Qwen3-ASR-0.6B
```

Set `QWEN_ASR_MODEL=Qwen/Qwen3-ASR-1.7B` to try the larger recognizer.
Both sizes use the same implementation. `KOOKR_STT_BACKEND=whisper` retains
Whisper, including existing `WHISPER_MODEL` overrides. In the default `auto`
backend mode, a GPU selects Qwen even if an old `WHISPER_MODEL=base` remains
in the environment. `KOOKR_STT_DEVICE=cpu` retains CPU Whisper.

Qwen uses a short vocabulary hint containing Kookr and common development
terms. Its canonical default is in
[`stt/qwen/vocabulary.json`](../../stt/qwen/vocabulary.json).
Whisper stays unhinted by default. Set `STT_VOCABULARY` to supply a vocabulary
override to either backend (maximum 2,000 Unicode code points), or set it to
an empty string to disable the hint. Browser and Telegram requests use the
same setting, including progressive updates and finalization. Validate Whisper
hints with representative recordings before enabling them: they can improve
names but also introduce repeated or unrelated words. They are not a guaranteed
spelling dictionary. There is no language-model rewriting after transcription.

Both clients send explicit overrides as the multipart `prompt` field and omit
it when no local override is set, so an external Qwen service keeps its own
configured default. Explicit overrides, including an empty string, are sent
to either service. For external browser dictation, configure
`STT_VOCABULARY` on its Node speech service; Telegram reads the Kookr process's
setting.

After the implementation is merged, apply configuration to the operator's
production instance with `pnpm prod:update`.
Bundled startup checks the active backend, model and vocabulary configuration
before reusing running Whisper or Qwen containers. Older Whisper services
without a vocabulary fingerprint are recreated once. Model weights remain cached between
restarts. The first boot downloads about 3.7 GB total for the 0.6B recognizer
and its aligner, or 6.5 GB total for 1.7B and the same aligner.

## Runtime and compatibility

The Qwen service requires an NVIDIA CUDA GPU with bfloat16 support. It uses
the Transformers backend with PyTorch's built-in scaled dot-product attention
(SDPA) and one inference worker.
The image pins qwen-asr, PyTorch and the model revisions. It loads the
recognizer and a separate forced aligner (a model that assigns times to words)
before becoming healthy. The aligner is necessary for Kookr's existing
progressive dictation: completed sentences stay stable while recognition continues updating the
remaining text. Native Qwen streaming is not used here.

Aligned words lack punctuation. The Node adapter matches them to the full
punctuated transcript before stabilizing sentences. If those texts disagree
or the timestamps are invalid, it preserves the transcript as active text
instead of guessing a cutoff and losing audio.

The HTTP service retains port 8010 and the legacy Compose service name
`kookr-stt-whisper` so existing URLs keep working. Its actual backend is
reported as `qwen`. Telegram still uses
`KOOKR_STT_WHISPER_URL=http://127.0.0.1:8010`; bundled startup supplies the
selected Qwen model for both warmup and audio messages. A separately configured
external HTTP endpoint retains its own `WHISPER_MODEL` setting.

Uploads are limited to 25 MiB and five minutes of decoded audio. Qwen accepts
at most one running and two queued inference jobs; additional requests receive
HTTP 429. Qwen finalization has a two-minute total deadline, including any
in-flight recognition; the browser allows five additional seconds for delivery.
An expired connection is closed, so late results cannot affect a new recording.
For recordings of at least half a second, finalization includes the last short
audio block. It reuses a cached transcript only when that cache covers the exact
received audio position. A failed inference leaves the last successful cache
intact. If finalization fails, the service reports incomplete text instead of
claiming success.

The recognition buffer holds at most five minutes of audio; already finalized
sentences remain as text when older audio is trimmed. If recognition cannot
finalize that audio before trimming overtakes it, the service reports
`audio_window_exhausted` and preserves the available text as incomplete.
This is a processing-backlog limit, not a universal five-minute recording
limit. Cancelling a browser recording rejects late results. With Qwen, it also
aborts the Node HTTP request. An inference already executing in Python continues
occupying its bounded GPU slot until it finishes.

Requests use automatic language detection unless French or English
is explicitly selected. Recordings are decoded in temporary storage and
removed after decoding. The inference service does not archive audio. Collection
by the Node speech service and Telegram integration is described below.

## Recovering interrupted dictation

After a timeout, disconnect, or closed input, reopen the same input to recover
the last non-empty provisional text. The card is labeled **Incomplete
dictation** and shows its capture time. **Restore** appends to the existing
typed draft, **Copy** retains the recovery, and **Discard** removes it. None
of these actions submits a task. Restore or discard it before recording again
or launching this draft.

Recoveries belong to the original draft, working context and prompt/criteria/
reply field. Another task or field cannot restore them. Both launchers keep
copy/discard controls available if the original task, project or directory is
no longer selected, including when that task disappears. A successful final
delivery consumes only that recording's recovery, and repeated final events
cannot insert it twice. A recording that recognized nothing creates no text.

Browser storage retains up to twelve recoveries, each capped at 100,000
characters, for 24 hours. The card labels truncation. When storage fails, the
open tab keeps a fallback and warns that reloading may lose it; copy the text
before leaving. This saves text only and does not enable microphone archival.
It cannot recover a past recording or preview that was never retained.

## Local evaluation corpus

Enable collection in the operator's `.env`, then apply it with
`pnpm prod:update` after the change is merged:

```dotenv
KOOKR_STT_CORPUS=true
# Optional absolute host path; default is ~/.kookr/stt-corpus.
# KOOKR_STT_CORPUS_DIR=/absolute/private/path/stt-corpus
```

This retains the original audio and the final automatic prediction during
normal use. The corpus can later be replayed against another model, vocabulary
hint or decoding configuration. It is local and off by default; no recordings
are uploaded for training. With an external `KOOKR_STT_URL`, configure capture
on that Node speech service separately: the main process cannot record a
browser stream sent directly elsewhere. Telegram capture still runs locally.

Each entry has this layout, under its UTC recording date:

```text
2026-09-26/<uuid>/audio.wav
2026-09-26/<uuid>/record.json
```

Browser audio is mono 16-bit PCM at 16 kHz in a WAV container. It includes the
whole received recording, even after recognition advances its audio window.
Telegram retains the original container (including MP4 for video notes).
The JSON contains `schemaVersion`, `id`, `recordedAt`, `audio` (filename, size
and SHA-256), `metadata`, and `reference: null`.

Metadata includes the source, start time, duration when known, elapsed time,
language, model, final transcript and success/error status. Browser language is
the selected hint; Telegram language is the service's reported language when
available. Qwen also reports the exact model revision, applied vocabulary and
decoding settings; unavailable provenance remains null. Browser predictions
come from progressive recognition, while Telegram predictions are whole-file
requests. Preserve that distinction when comparing latency or decoding modes.

The automatic transcript is a prediction, **not a human reference**. Keep it
unchanged when annotating examples. Measuring word error rates requires a
separate reference verified by listening; later edits to a task's text are not
automatically treated as corrections to the recording.

Only finalized recordings are retained. Empty successful predictions and
inference errors are represented separately so evaluation can include misses.
Intermediate updates, startup warmups and cancelled/disconnected recordings
are excluded. Browser recordings longer than five minutes are omitted as a
whole; they are never paired with truncated audio. Capture also omits audio
over 25 MiB, metadata over 256 KiB and writes beyond four queued/running records
per process. These omissions mean the corpus is not a complete error-rate log
for every attempted interaction.

Entries publish atomically with directory mode 0700 and file mode 0600. The
Node container runs as the host user so browser and Telegram entries share the
same private directory. Capture pauses when a write would leave less than one
GiB free. It never deletes old recordings automatically; monitor disk usage and
archive or remove selected entries deliberately. Browser WAV files use about
115 MB per hour of captured audio. Saving failures leave transcription working
and log a fixed diagnostic code without the transcript. If the destination is
invalid or unavailable at startup, capture is disabled for that process while
recognition remains available. Correct the destination and restart to retry.

Set `KOOKR_STT_CORPUS=false` and restart to stop collection. Existing entries
remain. Browser health on port 8003 includes `corpus.enabled`, its configuration
fingerprint, and per-process write/skip/failure counts; those counts exclude
Telegram. Inspect local pairs directly, for example:

```bash
du -sh ~/.kookr/stt-corpus
find ~/.kookr/stt-corpus -name record.json -print
```

Ignore `.pending-*` directories if inspecting during a write. Each completed
UUID directory is self-contained and can be moved or copied for offline
evaluation. Raw recordings can contain the same private information spoken
into a task, so keep the corpus outside Git and preserve its private permissions.

## Retaining edits and reviewing recordings

With collection enabled, dictate into the launch dialog's prompt or completion
criteria, or Quick Launch. Edit the field normally and select **Launch**.
Kookr retains the original prediction and records the exact submitted field
text before adding generated instructions. Typed additions and several clips
can share a field; the field snapshot is therefore a review candidate, never
an automatic transcript for each clip. Failed launches retain their submission
attempt without claiming that a task was created.

Recording links survive closing and reopening the launcher and reloading the
tab. Other tabs own independent drafts. Archival status distinguishes pending,
saved, failed and omitted data. Launch does not wait for disk writes. Retry
retained submissions after temporary failures, or discard their local retry
copies. Discarding a retry does not delete retained audio. If browser storage
is unavailable, the current tab warns that its fallback cannot survive reload.
Retry storage expires after seven days. It holds at most 48 recording links and
48 submission attempts within a two-MiB text budget; each field is limited to
32,000 characters and 32 recording links. Exceeding these limits produces an
explicit omission instead of silently truncating the submitted text. Automatic
retry runs for at most ten passes; the Retry control remains available afterward.

Open **Settings → Dictation corpus** to review retained recordings after launch:

1. Select a recording and compare its original prediction with its submitted
   field snapshots. The recording also shows recognition settings and linked
   task identifiers.
2. Play the recording and enter a correction for that recording alone.
3. Save it as an unreviewed candidate, a reformulation, or an excluded example.
   After listening, explicitly confirm a faithful transcript to make it eligible
   as a verified reference. Leaving the original words unchanged is not a review.
4. Export verified pairs for evaluation, or include candidates for inspection.
   Delete a selected example to remove its audio and associated annotations.

An export is a versioned JSON manifest. It retains original predictions, audio
hashes, recognition provenance, submitted field snapshots and review revisions.
Only the latest faithful review of complete, readable, hash-matching audio enters
`verifiedPairs`. Other eligible records enter `candidates` with `reference: null`;
excluded examples are left out. Audio URLs locate the retained originals on this
Kookr server; the manifest does not embed or upload audio. Copy the private corpus
separately when moving an evaluation set to another machine.
Manifest export is limited to 2,000 recordings and eight MiB of JSON. A larger
archive reports that limit instead of downloading a truncated manifest; paged
review and the private on-disk corpus remain available. A recording retains at
most 256 annotations and two MiB of annotation data.

The original `record.json` and audio stay unchanged. Versioned annotations live
beside the record and remain separate facts. Concurrent review saves use a
revision check; refresh after a conflict before saving another correction.
The service validates recording identifiers and draft ownership, and rejects
paths supplied by callers. Retried operations carry stable identifiers so a
lost response cannot produce duplicate annotations.

Collection limits still apply. Restored partial text, missing audio and recordings
omitted by size or queue limits cannot become verified whole-recording pairs.
The browser retains bounded retry text, not a replacement copy of lost audio.
A failed audio write cannot be recovered after a speech-service restart merely
by retrying its text annotation. Existing records survive disabling collection;
the service performs no annotation writes while collection is disabled.

The archive belongs to the configured Node speech service. Older or external
services that do not advertise corpus support keep dictation usable but cannot
save corrections or supply playback through this workflow. The main server
checks capabilities before forwarding annotations and never invents a local
audio pair for an external recording. Corpus HTTP access goes through Kookr's
existing authentication; the speech service itself must remain on a trusted
local network, like its existing transcription endpoint. Its corpus routes
reject browser-origin requests and require the internal proxy header.

## Verification and diagnosis

Check the Node dictation service on port 8003 and the GPU inference service on
port 8010:

```bash
curl --fail http://127.0.0.1:8003/health
curl --fail http://127.0.0.1:8010/health
curl --fail http://127.0.0.1:8010/v1/models
```

For Qwen, health identifies the selected model, `device: cuda`, and
`model_loaded: true`. An unavailable inference service makes Node health
return HTTP 503. An old Whisper health response can contain Parakeet metadata;
it cannot establish the loaded Whisper model.

Run the Node service tests with `pnpm test:stt`. Python HTTP, decoder and
runtime contract tests are documented in `stt/qwen/README.md`; they run on CPU.
GPU verification must also exercise actual recordings through the built image,
including a recording longer than fifteen seconds through the WebSocket path.

References: [Qwen inference package](https://github.com/QwenLM/Qwen3-ASR),
[Qwen3-ASR 0.6B model](https://huggingface.co/Qwen/Qwen3-ASR-0.6B).
