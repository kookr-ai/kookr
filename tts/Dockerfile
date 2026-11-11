FROM python:3.10-slim

RUN apt-get update && apt-get install -y ffmpeg curl && rm -rf /var/lib/apt/lists/*

# Install uv for fast Python package management
RUN pip install uv

WORKDIR /app

# Create virtual environment
RUN uv venv .venv
ENV PATH="/app/.venv/bin:$PATH"

# Install PyTorch with CUDA support
RUN uv pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# Install TTS dependencies
RUN uv pip install \
    pocket-tts \
    fastapi \
    uvicorn \
    scipy \
    pydantic \
    soundfile

# Kokoro, for the preset voices Heart, Sky and Sarah. transformers is pinned below the
# release that requires torch >= 2.6: this image ships torch 2.5.1+cu121, and a newer
# transformers switches its PyTorch backend off at import, which breaks Kokoro's loader.
RUN uv pip install "kokoro==0.9.4" "transformers<4.50"

# Bake the Kokoro weights, the three voices and the English text front end (a spaCy
# model that Kokoro otherwise installs on first use) into the image, so the first
# sentence after a restart does not wait on a download.
RUN python -c "from kokoro import KPipeline; p = KPipeline(lang_code='a', repo_id='hexgrad/Kokoro-82M', device='cpu'); [p.load_voice(v) for v in ('af_heart', 'af_sky', 'af_sarah')]"

COPY src/server.py /app/server.py
COPY voices/ /app/voices/

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
