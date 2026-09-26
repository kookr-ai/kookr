"""Load the selected recognizer and aligner once before accepting dictation."""

import os
from dataclasses import dataclass

MODELS = {
    "Qwen/Qwen3-ASR-0.6B": "5eb144179a02acc5e5ba31e748d22b0cf3e303b0",
    "Qwen/Qwen3-ASR-1.7B": "7278e1e70fe206f11671096ffdd38061171dd6e5",
}
ALIGNER = "Qwen/Qwen3-ForcedAligner-0.6B"
ALIGNER_REVISION = "c7cbfc2048c462b0d63a45797104fc9db3ad62b7"
DEFAULT_VOCABULARY = "Kookr, Codex, Claude Code, worktree, Git, TypeScript, pnpm, WebSocket, JSON."


@dataclass(frozen=True)
class Settings:
    model: str = "Qwen/Qwen3-ASR-0.6B"
    vocabulary: str = DEFAULT_VOCABULARY

    def __post_init__(self):
        if self.model not in MODELS:
            raise ValueError("QWEN_ASR_MODEL must be Qwen/Qwen3-ASR-0.6B or Qwen/Qwen3-ASR-1.7B")
        if len(self.vocabulary) > 2000:
            raise ValueError("STT_VOCABULARY must contain at most 2000 characters")

    @classmethod
    def from_env(cls):
        return cls(
            model=os.environ.get("QWEN_ASR_MODEL", cls.model),
            vocabulary=os.environ.get("STT_VOCABULARY", DEFAULT_VOCABULARY),
        )


class QwenRuntime:
    def __init__(self, model, torch, split_audio):
        self.model = model
        self.torch = torch
        self.split_audio = split_audio

    def transcribe(self, audio, *, language, context, timestamps):
        texts = []
        languages = []
        words = []
        # Keep long Telegram messages within the same token budget as browser windows.
        chunks = self.split_audio(wav=audio, sr=16_000, max_chunk_sec=30)
        with self.torch.inference_mode():
            for chunk, offset in chunks:
                result = self.model.transcribe(
                    audio=(chunk, 16_000), language=language, context=context,
                    return_time_stamps=timestamps,
                )[0]
                if result.text.strip():
                    texts.append(result.text.strip())
                if result.language and result.language not in languages:
                    languages.append(result.language)
                if timestamps and result.time_stamps is not None:
                    words.extend(
                        {"word": item.text, "start": item.start_time + offset, "end": item.end_time + offset}
                        for item in result.time_stamps.items
                    )
        return {"text": " ".join(texts), "language": ",".join(languages), "words": words}


def load_runtime(settings: Settings) -> QwenRuntime:
    # Keep GPU libraries out of HTTP tests and fail before downloading on CPU hosts.
    import numpy as np
    import torch
    from huggingface_hub import snapshot_download
    from qwen_asr import Qwen3ASRModel
    from qwen_asr.inference.utils import split_audio_into_chunks

    if not torch.cuda.is_available():
        raise RuntimeError("Qwen ASR requires an NVIDIA CUDA GPU; select the Whisper CPU backend on this host")
    if not torch.cuda.is_bf16_supported():
        raise RuntimeError("Qwen ASR requires a CUDA GPU with bfloat16 support")
    torch.set_num_threads(4)
    # Resolve both processors and weights through the same immutable snapshot.
    model_path = snapshot_download(settings.model, revision=MODELS[settings.model])
    aligner_path = snapshot_download(ALIGNER, revision=ALIGNER_REVISION)
    gpu_options = {"dtype": torch.bfloat16, "device_map": "cuda:0", "attn_implementation": "sdpa"}
    model = Qwen3ASRModel.from_pretrained(
        model_path, **gpu_options, max_inference_batch_size=1, max_new_tokens=512,
        forced_aligner=aligner_path, forced_aligner_kwargs=gpu_options,
    )
    model.model.eval()
    model.model.generation_config.do_sample = False
    model.forced_aligner.model.eval()
    runtime = QwenRuntime(model, torch, split_audio_into_chunks)
    silence = np.zeros(16_000, dtype=np.float32)
    runtime.transcribe(silence, language="English", context="", timestamps=False)
    # Silence often produces no text, so transcribe alone would skip the aligner.
    with torch.inference_mode():
        model.forced_aligner.align(audio=(silence, 16_000), text="Ready.", language="English")
    torch.cuda.synchronize()
    return runtime
