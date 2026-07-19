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
