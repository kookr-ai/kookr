"""Decode browser recordings and Telegram voice messages into bounded PCM audio."""

import subprocess
import tempfile

import numpy as np

SAMPLE_RATE = 16_000
MAX_AUDIO_SECONDS = 300
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


class InvalidAudio(ValueError):
    """The upload cannot be decoded within the service's audio limits."""


def decode_audio(content: bytes) -> np.ndarray:
    if not content:
        raise InvalidAudio("Audio file is empty")
    if len(content) > MAX_UPLOAD_BYTES:
        raise InvalidAudio("Audio file exceeds 25 MiB")
    # A seekable input also handles MP4 files whose metadata follows the audio.
    with tempfile.NamedTemporaryFile() as source:
        source.write(content)
        source.flush()
        try:
            decoded = subprocess.run(
                [
                    "ffmpeg", "-nostdin", "-v", "error", "-threads", "1",
                    "-protocol_whitelist", "file,pipe",
                    "-format_whitelist", "wav,ogg,mp3,mov,matroska,webm,flac,aac",
                    "-i", source.name, "-map", "0:a:0", "-vn", "-sn", "-dn",
                    "-t", str(MAX_AUDIO_SECONDS + 0.001),
                    "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1",
                ],
                capture_output=True, timeout=30, check=True,
            )
        except subprocess.TimeoutExpired as error:
            raise InvalidAudio("Audio decoding exceeded 30 seconds") from error
        except subprocess.CalledProcessError as error:
            raise InvalidAudio("Unsupported or invalid audio file") from error
    audio = np.frombuffer(decoded.stdout, dtype="<f4")
    if not audio.size:
        raise InvalidAudio("Audio file contains no samples")
    if audio.size > MAX_AUDIO_SECONDS * SAMPLE_RATE:
        raise InvalidAudio("Audio exceeds the 300-second limit")
    if not np.isfinite(audio).all():
        raise InvalidAudio("Audio contains non-finite samples")
    return audio
