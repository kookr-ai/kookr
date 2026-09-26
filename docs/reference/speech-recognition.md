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

Qwen receives this short vocabulary hint by default:

```text
Kookr, Codex, Claude Code, worktree, Git, TypeScript, pnpm, WebSocket, JSON.
```

Set `STT_VOCABULARY` to replace it (maximum 2,000 characters), or set it to
an empty string to disable the hint. The Qwen service applies it to browser
and Telegram requests. It guides recognition; it is not a guaranteed spelling
dictionary. There is no language-model rewriting after transcription.

After the implementation is merged, apply configuration to the operator's
production instance with `pnpm prod:update`.
Bundled startup checks the active backend, model and vocabulary configuration
before reusing running Qwen containers. Model weights remain cached between
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
Requests use automatic language detection unless French or English
is explicitly selected. Recordings are decoded in temporary storage and
removed after decoding; this service does not archive microphone audio.

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
