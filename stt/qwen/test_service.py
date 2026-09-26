"""Exercise HTTP contracts and real audio decoding without importing GPU libraries."""

import asyncio
import io
import subprocess
import tempfile
import threading
import unittest
import wave
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import numpy as np
from fastapi.testclient import TestClient

from app import create_app
from audio import InvalidAudio, decode_audio
from runtime import ALIGNER, ALIGNER_REVISION, DEFAULT_VOCABULARY, MODELS, QwenRuntime, Settings


class FakeRuntime:
    def __init__(self):
        self.calls = []

    def transcribe(self, audio, **options):
        self.calls.append(options)
        return {
            "text": "Bonjour Kookr.", "language": "French",
            "words": [{"word": "Kookr", "start": 0.3, "end": 0.7}] if options["timestamps"] else [],
        }


def fake_decoder(content):
    return np.zeros(16_000, dtype=np.float32)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.runtime = FakeRuntime()
        self.client = TestClient(create_app(runtime_factory=lambda _: self.runtime, decoder=fake_decoder))
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def post(self, **data):
        return self.client.post("/v1/audio/transcriptions", files={"file": ("voice.ogg", b"audio")}, data=data)

    def test_health_and_model_list_report_loaded_model(self):
        with patch.dict("os.environ", {"STT_CONFIG_ID": "abc"}):
            health = self.client.get("/health").json()
        self.assertEqual(health, {
            "status": "ok", "backend": "qwen", "model_name": Settings.model,
            "model_loaded": True, "device": "cuda", "runtime_backend": "transformers", "config_id": "abc",
        })
        self.assertEqual(self.client.get("/v1/models").json()["data"][0]["id"], Settings.model)

    def test_default_context_applies_without_a_browser_prompt(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "Bonjour Kookr.")
        self.assertEqual(response.json()["words"], [])
        self.assertEqual(self.runtime.calls, [{"language": None, "context": DEFAULT_VOCABULARY, "timestamps": False}])

    def test_browser_word_timestamps_and_request_scoped_language(self):
        response = self.post(**{"model": Settings.model, "language": "fr", "response_format": "verbose_json", "timestamp_granularities[]": "word"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["words"][0], {"word": "Kookr", "start": 0.3, "end": 0.7})
        self.post(language="en", prompt="Other terminology")
        self.post(language="auto", prompt="")
        self.assertEqual([call["language"] for call in self.runtime.calls], ["French", "English", None])
        self.assertEqual([call["context"] for call in self.runtime.calls], [DEFAULT_VOCABULARY, "Other terminology", ""])

    def test_recognition_reports_the_actual_request_options_and_model_revision(self):
        response = self.post(**{"language": "fr", "prompt": "Specific vocabulary", "timestamp_granularities[]": "word"})
        self.assertEqual(response.json()["recognition"], {
            "backend": "qwen", "model": Settings.model,
            "modelRevision": MODELS[Settings.model],
            "aligner": ALIGNER, "alignerRevision": ALIGNER_REVISION,
            "vocabulary": "Specific vocabulary", "languageHint": "fr",
            "dtype": "bfloat16", "attention": "sdpa", "maxNewTokens": 512,
        })
        recognition = self.post(language="auto", prompt="").json()["recognition"]
        self.assertEqual(recognition["vocabulary"], "")
        self.assertEqual(recognition["languageHint"], "auto")
        self.assertIsNone(recognition["aligner"])
        self.assertIsNone(recognition["alignerRevision"])
        self.assertEqual(self.post().json()["recognition"]["vocabulary"], DEFAULT_VOCABULARY)

    def test_rejects_wrong_model_and_invalid_options_before_inference(self):
        for fields in [
            {"model": "base"}, {"model": "Qwen/Qwen3-ASR-1.7B"}, {"language": "xx"},
            {"response_format": "text"}, {"timestamp_granularities[]": "segment"}, {"prompt": "x" * 2001},
        ]:
            with self.subTest(fields=fields):
                self.assertEqual(self.post(**fields).status_code, 400)
        self.assertEqual(self.runtime.calls, [])

    def test_requires_audio_file(self):
        self.assertEqual(self.client.post("/v1/audio/transcriptions", data={"model": Settings.model}).status_code, 422)

    def test_upload_limit_applies_before_multipart_parsing(self):
        with patch("app.MAX_UPLOAD_BYTES", 16):
            response = self.client.post("/v1/audio/transcriptions", content=b"x" * 17)
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.runtime.calls, [])

    def test_model_selection_and_empty_configured_vocabulary(self):
        settings = Settings(model="Qwen/Qwen3-ASR-1.7B", vocabulary="")
        with TestClient(create_app(settings, lambda _: self.runtime, fake_decoder)) as client:
            response = client.post("/v1/audio/transcriptions", files={"file": b"audio"}, data={"model": settings.model})
        self.assertEqual(response.json()["model"], settings.model)
        self.assertEqual(response.json()["recognition"]["modelRevision"], MODELS[settings.model])
        self.assertEqual(self.runtime.calls[-1]["context"], "")

    def test_decode_failure_does_not_leak_internal_details(self):
        def invalid(_):
            raise InvalidAudio("Unsupported or invalid audio file")
        with TestClient(create_app(runtime_factory=lambda _: self.runtime, decoder=invalid)) as client:
            response = client.post("/v1/audio/transcriptions", files={"file": b"broken"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.runtime.calls, [])

    def test_inference_failure_is_recoverable(self):
        with patch.object(self.runtime, "transcribe", side_effect=RuntimeError("private detail")):
            with self.assertLogs("qwen-asr", "ERROR"):
                response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private detail", response.text)
        self.assertEqual(self.post().status_code, 200)

    def test_startup_failure_never_reports_ready(self):
        def fail(_):
            raise RuntimeError("warmup failed")
        with self.assertRaisesRegex(RuntimeError, "warmup failed"):
            with TestClient(create_app(runtime_factory=fail)):
                pass
        app = create_app(runtime_factory=fail)
        with nullcontext(TestClient(app)) as client:
            self.assertEqual(client.get("/health").status_code, 503)


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_does_not_release_running_gpu_slot(self):
        entered = threading.Event()
        release = threading.Event()
        runtime = FakeRuntime()
        original = runtime.transcribe
        active = 0
        peak = 0

        def blocking(audio, **options):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            entered.set()
            release.wait(5)
            active -= 1
            return original(audio, **options)

        runtime.transcribe = blocking
        app = create_app(runtime_factory=lambda _: runtime, decoder=fake_decoder)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                async def post():
                    return await client.post("/v1/audio/transcriptions", files={"file": b"audio"})
                tasks = [asyncio.create_task(post()) for _ in range(3)]
                try:
                    self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                    self.assertEqual((await post()).status_code, 429)
                    tasks[0].cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await tasks[0]
                    self.assertEqual((await post()).status_code, 429)
                    self.assertEqual((await client.get("/health")).status_code, 200)
                finally:
                    release.set()
                    results = await asyncio.gather(*tasks, return_exceptions=True)
                self.assertEqual([result.status_code for result in results[1:]], [200, 200])
                self.assertEqual(peak, 1)
                self.assertEqual(len(runtime.calls), 3)
                self.assertEqual((await post()).status_code, 200)

    async def test_chunked_upload_cannot_bypass_size_limit(self):
        app = create_app(runtime_factory=lambda _: FakeRuntime(), decoder=fake_decoder)
        async def body():
            yield b"x" * 10
            yield b"x" * 10
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            with patch("app.MAX_UPLOAD_BYTES", 16):
                response = await client.post("/v1/audio/transcriptions", content=body())
        self.assertEqual(response.status_code, 413)


def wav_bytes(seconds=0.25):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(48_000)
        wav.writeframes(b"\0\0\0\0" * int(seconds * 48_000))
    return buffer.getvalue()


class DecoderTests(unittest.TestCase):
    def test_real_wav_is_resampled_and_mixed_to_mono(self):
        audio = decode_audio(wav_bytes())
        self.assertEqual(audio.shape, (4000,))
        self.assertEqual(audio.dtype, np.dtype("float32"))

    def test_real_ogg_mp3_and_mp4_are_decoded(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory, "source.wav")
            source.write_bytes(wav_bytes())
            for extension in ("ogg", "mp3", "m4a"):
                with self.subTest(extension=extension):
                    target = Path(directory, "encoded." + extension)
                    subprocess.run(["ffmpeg", "-v", "error", "-i", str(source), str(target)], check=True)
                    self.assertGreater(decode_audio(target.read_bytes()).size, 0)

    def test_empty_invalid_and_over_duration_audio_are_rejected(self):
        for content in (b"", b"not audio"):
            with self.assertRaises(InvalidAudio):
                decode_audio(content)
        with patch("audio.MAX_AUDIO_SECONDS", 0.1):
            with self.assertRaisesRegex(InvalidAudio, "300-second"):
                decode_audio(wav_bytes())

    def test_decoder_timeout_has_a_clear_error(self):
        with patch("audio.subprocess.run", side_effect=subprocess.TimeoutExpired("ffmpeg", 30)):
            with self.assertRaisesRegex(InvalidAudio, "30 seconds"):
                decode_audio(b"audio")


class RuntimeTests(unittest.TestCase):
    def test_long_recordings_preserve_chunk_order_and_timestamp_offsets(self):
        calls = []
        def transcribe(**kwargs):
            calls.append(kwargs)
            return [SimpleNamespace(
            text="Sentence.", language="French", time_stamps=SimpleNamespace(items=[
                SimpleNamespace(text="Sentence", start_time=0.2, end_time=0.8),
            ]),
            )]
        model = SimpleNamespace(transcribe=transcribe)
        seen = []
        def split(**kwargs):
            seen.append(kwargs["max_chunk_sec"])
            return [(np.zeros(10), 0), (np.zeros(10), 30)]
        runtime = QwenRuntime(model, SimpleNamespace(inference_mode=nullcontext), split)
        result = runtime.transcribe(np.zeros(20), language="French", context="Kookr, pnpm.", timestamps=True)
        self.assertEqual(result["text"], "Sentence. Sentence.")
        self.assertEqual(result["language"], "French")
        self.assertEqual(result["words"][1], {"word": "Sentence", "start": 30.2, "end": 30.8})
        self.assertEqual(seen, [30])
        self.assertEqual(len(calls), 2)
        for call in calls:
            self.assertEqual(call["language"], "French")
            self.assertEqual(call["context"], "Kookr, pnpm.")
            self.assertTrue(call["return_time_stamps"])
            self.assertEqual(call["audio"][1], 16_000)
        calls.clear()
        plain = runtime.transcribe(np.zeros(20), language=None, context="", timestamps=False)
        self.assertEqual(plain["words"], [])
        for call in calls:
            self.assertIsNone(call["language"])
            self.assertEqual(call["context"], "")
            self.assertFalse(call["return_time_stamps"])

    def test_config_rejects_unknown_model_and_oversized_vocabulary(self):
        with self.assertRaises(ValueError):
            Settings(model="Whisper")
        with self.assertRaises(ValueError):
            Settings(vocabulary="x" * 2001)
        with patch.dict("os.environ", {"STT_VOCABULARY": "", "QWEN_ASR_MODEL": "Qwen/Qwen3-ASR-1.7B"}):
            self.assertEqual(Settings.from_env(), Settings(model="Qwen/Qwen3-ASR-1.7B", vocabulary=""))


if __name__ == "__main__":
    unittest.main()
