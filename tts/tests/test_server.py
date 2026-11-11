import importlib.util
import sys
import types
from pathlib import Path

import pytest
import torch
from fastapi.testclient import TestClient


def load_server_module():
    sys.modules.setdefault("torchaudio", types.ModuleType("torchaudio"))

    pocket_tts = types.ModuleType("pocket_tts")
    pocket_tts.TTSModel = object
    sys.modules["pocket_tts"] = pocket_tts

    server_path = Path(__file__).parents[1] / "src" / "server.py"
    spec = importlib.util.spec_from_file_location("tts_server", server_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def server():
    return load_server_module()


class FakeModel:
    device = torch.device("cpu")
    sample_rate = 24_000

    def __init__(self):
        self.voice_calls = []
        self.generate_calls = []

    def get_state_for_audio_prompt(self, voice):
        self.voice_calls.append(voice)
        return {"voice": voice}

    def generate_audio(self, voice_state, text, *, frames_after_eos):
        self.generate_calls.append((voice_state, text, frames_after_eos))
        return torch.zeros(24, dtype=torch.float32)


@pytest.mark.parametrize("text", ["", "   ", "\n\t"])
def test_synthesize_rejects_blank_text_before_model_work(server, text):
    fake_model = FakeModel()
    server.model = fake_model

    response = TestClient(server.app).post("/synthesize", json={"text": text})

    assert response.status_code == 400
    assert "must not be blank" in response.json()["detail"]
    assert fake_model.voice_calls == []
    assert fake_model.generate_calls == []


def test_synthesize_rejects_text_above_configured_character_limit(server, monkeypatch):
    fake_model = FakeModel()
    server.model = fake_model
    monkeypatch.setattr(server, "MAX_TEXT_LENGTH", 4)

    response = TestClient(server.app).post("/synthesize", json={"text": "abcde"})

    assert response.status_code == 413
    assert response.json()["detail"] == "Text exceeds maximum length of 4 characters"
    assert fake_model.voice_calls == []
    assert fake_model.generate_calls == []


def test_maximum_text_length_is_configurable_from_environment(monkeypatch):
    monkeypatch.setenv("TTS_MAX_TEXT_LENGTH", "123")

    server = load_server_module()

    assert server.MAX_TEXT_LENGTH == 123


def test_synthesize_accepts_text_at_configured_character_limit(server, monkeypatch):
    fake_model = FakeModel()
    server.model = fake_model
    monkeypatch.setattr(server, "MAX_TEXT_LENGTH", 4)

    response = TestClient(server.app).post("/synthesize", json={"text": "éabc"})

    assert response.status_code == 200
    assert response.json()["audioBase64"]
    assert response.json()["durationMs"] == pytest.approx(1.0)
    assert fake_model.generate_calls == [({"voice": "alba"}, "éabc", None)]


class FakeKokoroResult:
    def __init__(self, audio):
        self.audio = audio


class FakeKokoroPipeline:
    """Stands in for kokoro.KPipeline: one result per call, 12 samples each, plus one empty result."""

    def __init__(self):
        self.calls = []

    def __call__(self, text, *, voice, speed):
        self.calls.append((text, voice, speed))
        return [
            FakeKokoroResult(torch.zeros(12, dtype=torch.float32)),
            FakeKokoroResult(None),
            FakeKokoroResult(torch.zeros(12, dtype=torch.float32)),
        ]


@pytest.mark.parametrize("voice", ["af_heart", "af_sky", "af_sarah"])
def test_kokoro_voices_are_synthesized_by_kokoro_not_pocket(server, voice):
    fake_model = FakeModel()
    fake_pipeline = FakeKokoroPipeline()
    server.model = fake_model
    server.kokoro_pipeline = fake_pipeline

    response = TestClient(server.app).post("/synthesize", json={"text": "Tests pass. It is merged.", "voice": voice})

    assert response.status_code == 200
    # Softened text, the requested voice, and the pace the voices were chosen at.
    assert fake_pipeline.calls == [("Tests pass... It is merged.", voice, 0.88)]
    # Two 12-sample chunks at 24 kHz; the empty result is skipped.
    assert response.json()["durationMs"] == pytest.approx(1.0)
    assert response.json()["audioBase64"]
    assert fake_model.voice_calls == []
    assert fake_model.generate_calls == []


@pytest.mark.parametrize("voice", ["alba", "/clips/a-voice-that-is-not-on-disk.mp3", "af_bella", "AF_HEART"])
def test_every_other_voice_still_goes_to_pocket(server, voice):
    fake_model = FakeModel()
    fake_pipeline = FakeKokoroPipeline()
    server.model = fake_model
    server.kokoro_pipeline = fake_pipeline

    response = TestClient(server.app).post("/synthesize", json={"text": "Tests pass. It is merged.", "voice": voice})

    assert response.status_code == 200
    assert fake_pipeline.calls == []
    # Pocket gets the text as written: the softening is a Kokoro rule.
    assert fake_model.generate_calls == [({"voice": voice}, "Tests pass. It is merged.", None)]


@pytest.mark.parametrize(
    "text,expected",
    [
        ("One. Two.", "One... Two."),
        ("One.\nTwo.  Three", "One... Two... Three"),
        ("Version 2.5 is out", "Version 2.5 is out"),
        ("No full stop here", "No full stop here"),
    ],
)
def test_soften_for_kokoro_lengthens_only_the_pause_between_sentences(server, text, expected):
    assert server.soften_for_kokoro(text) == expected


def test_kokoro_speed_is_configurable_from_environment(monkeypatch):
    monkeypatch.setenv("TTS_KOKORO_SPEED", "1.0")

    server = load_server_module()

    assert server.KOKORO_SPEED == 1.0


@pytest.mark.parametrize(
    "default_voice,expected",
    [("af_heart", ["kokoro"]), ("/app/voices/matilda.mp3", ["pocket"]), ("alba", ["pocket"])],
)
def test_only_the_engine_for_the_default_voice_loads_at_startup(server, monkeypatch, default_voice, expected):
    loaded = []
    monkeypatch.setattr(server, "DEFAULT_VOICE", default_voice)
    monkeypatch.setattr(server, "ensure_kokoro", lambda: loaded.append("kokoro"))
    monkeypatch.setattr(server, "ensure_pocket_model", lambda: loaded.append("pocket"))

    server.load_default_engine()

    assert loaded == expected


def test_default_voice_comes_from_the_environment(monkeypatch):
    monkeypatch.setenv("TTS_VOICE", "af_sky")

    server = load_server_module()

    assert server.DEFAULT_VOICE == "af_sky"


def test_health_is_ok_with_only_kokoro_loaded_and_503_with_neither(server):
    client = TestClient(server.app)
    server.model = None
    server.kokoro_pipeline = None
    assert client.get("/health").status_code == 503

    server.kokoro_pipeline = FakeKokoroPipeline()
    assert client.get("/health").status_code == 200


def test_a_kokoro_voice_that_yields_no_audio_is_a_server_error(server):
    class EmptyPipeline:
        def __call__(self, text, *, voice, speed):
            return [FakeKokoroResult(None)]

    server.kokoro_pipeline = EmptyPipeline()

    response = TestClient(server.app).post("/synthesize", json={"text": "Hello.", "voice": "af_heart"})

    assert response.status_code == 500
    assert "no audio" in response.json()["detail"]
