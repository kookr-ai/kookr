
import os
import io
import base64
import logging
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

app = FastAPI(title="Pocket TTS API")

MAX_TEXT_LENGTH = int(os.environ.get("TTS_MAX_TEXT_LENGTH", "5000"))

# Global model state
model = None
voice_states = {}

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

@app.on_event("startup")
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
    if model is None:
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

    if model is None:
        raise HTTPException(status_code=503, detail="Model not initialized")
        
    try:
        import time
        start_time = time.time()
        
        voice_state = get_voice_state(req.voice)
        logger.info(f"Voice state type: {type(voice_state)}")
        
        # Move voice state to model device recursively
        voice_state = move_to_device(voice_state, model.device)
        
        frames_after_eos = req.params.framesAfterEos
        
        audio_tensor = model.generate_audio(
            voice_state, 
            req.text, 
            frames_after_eos=frames_after_eos
        )
        
        # Encode to WAV (move to CPU for export)
        buffer = io.BytesIO()
        scipy.io.wavfile.write(buffer, model.sample_rate, audio_tensor.cpu().numpy())
        wav_bytes = buffer.getvalue()
        
        duration_ms = (len(audio_tensor) / model.sample_rate) * 1000
        gen_time_ms = (time.time() - start_time) * 1000
        
        return {
            "audioBase64": base64.b64encode(wav_bytes).decode('ascii'),
            "durationMs": duration_ms,
            "generationTimeMs": gen_time_ms
        }
    except Exception as e:
        logger.error(f"Synthesis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
