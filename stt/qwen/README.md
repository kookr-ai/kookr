# Qwen speech recognition service

This service runs the same local recognizer for browser dictation and Telegram
voice messages. It defaults to Qwen3-ASR 0.6B on an NVIDIA GPU, uses a short
technical vocabulary hint, and supplies word timings for progressive dictation:
completed sentences stay stable while recognition continues updating the
remaining text.
The 1.7B model is available through configuration. Apply a model change by
restarting the service; model weights are downloaded into the persistent
Hugging Face cache when needed.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `QWEN_ASR_MODEL` | `Qwen/Qwen3-ASR-0.6B` | Select this model or `Qwen/Qwen3-ASR-1.7B`. |
| `STT_VOCABULARY` | `Kookr, Codex, Claude Code, worktree, Git, TypeScript, pnpm, WebSocket, JSON.` | Context supplied to every request. An explicit empty value disables the context. |
| `STT_CONFIG_ID` | Empty | Opaque configuration fingerprint supplied by Kookr so it can detect an outdated running service. |
| `HF_HOME` | `/root/.cache/huggingface` in Docker | Persistent cache for the pinned recognizer and aligner snapshots. |

The service requires CUDA and a GPU supporting bfloat16. It uses PyTorch's
built-in scaled dot-product attention (SDPA), so FlashAttention and vLLM are
unnecessary. Startup
loads and warms both the recognizer and the 0.6B forced aligner, which assigns
word times to the recognized text. A failed download, unsupported GPU, or failed
warmup prevents the server from reporting ready.

The exact model revisions live in `runtime.py`. The Dockerfile pins Python,
PyTorch 2.14.0 with CUDA 13.0, Qwen ASR 0.0.6, and the direct Python dependencies.
System packages and transitive Python dependencies still resolve during build.
The GPU driver must support the selected CUDA runtime.

## HTTP contract

The server listens on port 8010. `GET /health` reports the selected model,
`backend: "qwen"`, `device: "cuda"`, and readiness. `GET /v1/models` lists only
the loaded model.

`POST /v1/audio/transcriptions` accepts multipart data:

| Field | Behavior |
| --- | --- |
| `file` | Required audio upload; WAV, OGG, MP3, MP4/M4A, WebM, FLAC, and AAC are decoded through ffmpeg. |
| `model` | Optional; when supplied, it must match the loaded model's full identifier. |
| `language` | Omit or use `auto` for detection; `fr` and `en` force French and English. |
| `prompt` | Optional request context, replacing `STT_VOCABULARY`; at most 2,000 characters. |
| `response_format` | `json` or `verbose_json`. |
| `timestamp_granularities[]` | Set to `word` to request alignment. Other granularities are rejected. |

Both JSON formats return `text`, `language`, `model`, and `words`. Without a
timestamp request, `words` is empty. With timestamps, each word contains
`word`, `start`, and `end` in seconds. The aligner can omit punctuation from its
word tokens; clients must preserve sentence punctuation from the full text.

The complete multipart body is limited to 25 MiB and decoded audio to five
minutes. ffmpeg reads a local temporary file with network protocols disabled
and must finish decoding within 30 seconds. Long recordings use the pinned Qwen
package's silence-aware splitting around 30-second boundaries. Each chunk has
the same 512-token generation budget, and word timestamps are adjusted to their
positions in the original recording.

One worker serializes decoding and GPU inference. At most three jobs are
admitted: one running and two waiting. Further requests receive HTTP 429 with
`Retry-After: 1`. Disconnecting a caller does not free its GPU slot until the
underlying work finishes. Uvicorn additionally limits simultaneous connections
to eight, bounding the number of uploads being buffered.

Audio remains in memory apart from the temporary decoding file, which is
deleted after decoding. The service stores no recording or transcript history.

## Verification

The CPU suite covers model selection, context and language isolation, readiness
failures, word response shapes, admission limits, cancellation, upload limits,
decoder errors, and real WAV/OGG/MP3/MP4 conversion. It also checks ordered text
and restored timestamps across long-recording chunks. It does not load PyTorch
or require a GPU.

```sh
python3 -m venv /tmp/kookr-qwen-tests
/tmp/kookr-qwen-tests/bin/pip install -r stt/qwen/requirements-test.txt
/tmp/kookr-qwen-tests/bin/python -m unittest discover -s stt/qwen -v
```

ffmpeg must be installed to run the decoder tests. GPU acceptance additionally
requires building the image, waiting for healthy startup, transcribing a real
recording with word timestamps, and replaying a multi-sentence recording longer
than 15 seconds through Kookr's WebSocket dictation path. These integration
checks validate the shipped clients as well as the service.

Upstream contracts: [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR) and
[official PyTorch CUDA 13.0 wheels](https://download.pytorch.org/whl/cu130/torch/).
