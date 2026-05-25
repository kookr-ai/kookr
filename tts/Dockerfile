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

COPY src/server.py /app/server.py
COPY voices/ /app/voices/

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
