
import os
import io
import re
import base64
import logging
import threading
from typing import Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Body
from pydantic import BaseModel
import torch
import torchaudio
import scipy.io.wavfile
from pocket_tts import TTSModel
from pathlib import Path

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger("tts-server")

app = FastAPI(title="Kookr TTS API")

MAX_TEXT_LENGTH = int(os.environ.get("TTS_MAX_TEXT_LENGTH", "5000"))

# The voice Kookr was started with. It decides which engine loads at startup; the other
# engine loads the first time one of its voices is requested, so an install that only
# ever uses one engine never pays for the other.
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "/app/voices/matilda.mp3")

# Kokoro preset voices. Every other voice value (a Pocket TTS built-in name or a clip
# path) goes to Pocket TTS, exactly as before Kokoro was added.
KOKORO_VOICES = ("af_heart", "af_sky", "af_sarah")
KOKORO_REPO_ID = "hexgrad/Kokoro-82M"
KOKORO_SAMPLE_RATE = 24_000
# 0.88 is the pace these voices were chosen at; 1.0 is Kokoro's own default.
DEFAULT_KOKORO_SPEED = 0.88


def read_kokoro_speed() -> float:
    """A value that is not a positive number falls back to the default: raising here
    would stop the whole service from starting, Pocket TTS voices included."""
    raw = os.environ.get("TTS_KOKORO_SPEED", "").strip()
    if not raw:
        return DEFAULT_KOKORO_SPEED
    try:
        speed = float(raw)
    except ValueError:
        speed = 0.0
    if speed <= 0:
        logger.warning(f"Ignoring TTS_KOKORO_SPEED={raw!r}; using {DEFAULT_KOKORO_SPEED}")
        return DEFAULT_KOKORO_SPEED
    return speed


KOKORO_SPEED = read_kokoro_speed()

# Global model state
model = None            # Pocket TTS
kokoro_pipeline = None  # Kokoro
voice_states = {}
# One load lock per engine: a slow first load of one engine must not hold up requests
# for the other, which is already loaded.
_pocket_load_lock = threading.Lock()
_kokoro_load_lock = threading.Lock()
_kokoro_generate_lock = threading.Lock()


def is_kokoro_voice(voice: str) -> bool:
    return voice in KOKORO_VOICES


def soften_for_kokoro(text: str) -> str:
    """Kokoro reads punctuation as breath. A full stop followed by a space becomes
    "... ", which gives the longer pause between sentences these voices were chosen with."""
    return re.sub(r"\.\s+", "... ", text)

class GenerationParams(BaseModel):
    temperature: Optional[float] = None
    framesAfterEos: Optional[int] = None

class SynthesisRequest(BaseModel):
    text: str
    voice: str = "alba"
    params: GenerationParams = GenerationParams()

class SynthesisResponse(BaseModel):
    audioBase64: str
    durationMs: float
    generationTimeMs: float

def load_model():
    global model
    try:
        # Load config from env
        temperature = float(os.environ.get("TTS_MODEL_TEMPERATURE", "0.7"))
        lsd_steps = int(os.environ.get("TTS_MODEL_LSD_STEPS", "1"))
        eos_threshold = float(os.environ.get("TTS_MODEL_EOS_THRESHOLD", "-4.0"))
        noise_clamp_str = os.environ.get("TTS_MODEL_NOISE_CLAMP", "")
        noise_clamp = float(noise_clamp_str) if noise_clamp_str else None

        logger.info(f"Loading Pocket TTS Model (temp={temperature}, steps={lsd_steps})")
        
        model = TTSModel.load_model(
            temp=temperature,
            lsd_decode_steps=lsd_steps,
            eos_threshold=eos_threshold,
            noise_clamp=noise_clamp
        )
        
        if torch.cuda.is_available():
            logger.info("Moving model to CUDA")
            model = model.cuda()
            
        logger.info(f"Model loaded on {model.device}")
    except Exception as e:
        logger.critical(f"Failed to load model: {e}")
        raise e

def ensure_pocket_model():
    """Load Pocket TTS on first use. Safe to call from concurrent requests."""
    if model is None:
        with _pocket_load_lock:
            if model is None:
                load_model()
    return model


def ensure_kokoro():
    """Load Kokoro on first use. Safe to call from concurrent requests."""
    global kokoro_pipeline
    if kokoro_pipeline is None:
        with _kokoro_load_lock:
            if kokoro_pipeline is None:
                # Imported here so an install that never uses a Kokoro voice does not load it.
                from kokoro import KPipeline
                device = "cuda" if torch.cuda.is_available() else "cpu"
                logger.info(f"Loading Kokoro on {device}")
                kokoro_pipeline = KPipeline(lang_code="a", repo_id=KOKORO_REPO_ID, device=device)
                logger.info("Kokoro loaded")
    return kokoro_pipeline


@app.on_event("startup")
def load_default_engine():
    try:
        if is_kokoro_voice(DEFAULT_VOICE):
            ensure_kokoro()
        else:
            ensure_pocket_model()
    except Exception as e:
        logger.critical(f"Failed to load the engine for the default voice {DEFAULT_VOICE}: {e}")
        raise e


def synthesize_kokoro(text: str, voice: str):
    """Returns (audio tensor on CPU, sample rate)."""
    pipeline = ensure_kokoro()
    # One sentence at a time on the GPU; the pipeline is not written for concurrent calls.
    with _kokoro_generate_lock:
        chunks = [
            result.audio.detach().cpu().flatten()
            for result in pipeline(soften_for_kokoro(text), voice=voice, speed=KOKORO_SPEED)
            if result.audio is not None
        ]
    if not chunks:
        raise RuntimeError("Kokoro produced no audio")
    return torch.cat(chunks), KOKORO_SAMPLE_RATE


def synthesize_pocket(text: str, voice: str, frames_after_eos):
    """Returns (audio tensor on CPU, sample rate)."""
    pocket = ensure_pocket_model()
    voice_state = get_voice_state(voice)
    # Move voice state to model device recursively
    voice_state = move_to_device(voice_state, pocket.device)
    audio_tensor = pocket.generate_audio(
        voice_state,
        text,
        frames_after_eos=frames_after_eos
    )
    return audio_tensor.cpu(), pocket.sample_rate


def get_voice_state(voice_name_or_path: str):
    if voice_name_or_path in voice_states:
        return voice_states[voice_name_or_path]
    
    logger.info(f"Loading voice state: {voice_name_or_path}")
    
    # Workaround for potential device mismatch in pocket-tts during encoding
    original_device = model.device
    
    # Determine if cuda
    is_cuda = False
    if isinstance(original_device, torch.device):
        is_cuda = original_device.type == 'cuda'
    else:
        is_cuda = str(original_device).startswith('cuda')
        
    moved_temp = False
    
    try:
        # Check if local file path
        if os.path.exists(voice_name_or_path):
             # Move model to CPU temporarily for robust loading
             if is_cuda:
                 logger.info("Moving model to CPU for voice loading")
                 model.cpu()
                 moved_temp = True

             # Load using path
             state = model.get_state_for_audio_prompt(Path(voice_name_or_path))
             
        else:
             # Built-in voices
             if is_cuda:
                 logger.info("Moving model to CPU for voice loading")
                 model.cpu()
                 moved_temp = True
                 
             state = model.get_state_for_audio_prompt(voice_name_or_path)

        if moved_temp:
             logger.info("Moving model back to CUDA")
             if isinstance(original_device, torch.device):
                 model.to(original_device)
             else:
                 model.to(original_device) # works for string 'cuda' too
             
        voice_states[voice_name_or_path] = state
        return state
    except Exception as e:
        # Ensure model is moved back in case of error
        if moved_temp:
             model.to(original_device) # Use model.to() to move the model instance
        logger.error(f"Failed to load voice {voice_name_or_path}: {e}")
        raise HTTPException(status_code=400, detail=f"Voice load failed: {str(e)}")

@app.get("/health")
def health_check():
    if model is None and kokoro_pipeline is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    return {"status": "ok"}

def move_to_device(obj, device):
    if torch.is_tensor(obj):
        return obj.to(device)
    elif isinstance(obj, dict):
        return {k: move_to_device(v, device) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [move_to_device(v, device) for v in obj]
    elif isinstance(obj, tuple):
        return tuple(move_to_device(v, device) for v in obj)
    elif hasattr(obj, 'to'):
        return obj.to(device)
    return obj

@app.post("/synthesize")
def synthesize(req: SynthesisRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text must not be blank")

    if len(req.text) > MAX_TEXT_LENGTH:
        raise HTTPException(
            status_code=413,
            detail=f"Text exceeds maximum length of {MAX_TEXT_LENGTH} characters"
        )

    try:
        import time
        start_time = time.time()

        if is_kokoro_voice(req.voice):
            audio_tensor, sample_rate = synthesize_kokoro(req.text, req.voice)
        else:
            audio_tensor, sample_rate = synthesize_pocket(req.text, req.voice, req.params.framesAfterEos)

        # Encode to WAV
        buffer = io.BytesIO()
        scipy.io.wavfile.write(buffer, sample_rate, audio_tensor.numpy())
        wav_bytes = buffer.getvalue()

        duration_ms = (len(audio_tensor) / sample_rate) * 1000
        gen_time_ms = (time.time() - start_time) * 1000

        return {
            "audioBase64": base64.b64encode(wav_bytes).decode('ascii'),
            "durationMs": duration_ms,
            "generationTimeMs": gen_time_ms
        }
    except HTTPException:
        # A voice that failed to load is the caller's error (400), not a server failure.
        raise
    except Exception as e:
        logger.error(f"Synthesis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
