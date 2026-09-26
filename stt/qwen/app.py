"""Serve Qwen to both Kookr dictation clients without concurrent GPU inference."""

import asyncio
import logging
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from starlette.datastructures import UploadFile
from starlette.responses import JSONResponse

from audio import InvalidAudio, MAX_UPLOAD_BYTES, decode_audio
from runtime import ALIGNER, ALIGNER_REVISION, MODELS, Settings, load_runtime

LOG = logging.getLogger("qwen-asr")
LANGUAGES = {None: None, "": None, "auto": None, "fr": "French", "en": "English"}
MAX_JOBS = 3  # One running request and at most two waiting for the GPU.


class UploadLimit:
    """Limit multipart bodies before the parser can spool an arbitrary upload."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST":
            return await self.app(scope, receive, send)
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > MAX_UPLOAD_BYTES:
                return await JSONResponse({"detail": "Upload exceeds 25 MiB"}, status_code=413)(scope, receive, send)
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(settings=None, runtime_factory=load_runtime, decoder=decode_audio):
    settings = settings or Settings.from_env()
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="qwen-inference")
    pending = set()
    runtime = None

    @asynccontextmanager
    async def lifespan(app):
        nonlocal runtime
        try:
            runtime = await asyncio.get_running_loop().run_in_executor(executor, runtime_factory, settings)
            yield
        finally:
            runtime = None
            executor.shutdown(wait=True, cancel_futures=True)

    app = FastAPI(lifespan=lifespan)
    app.add_middleware(UploadLimit)

    @app.get("/health")
    async def health():
        loaded = runtime is not None
        return JSONResponse({
            "status": "ok" if loaded else "loading", "backend": "qwen",
            "model_name": settings.model, "model_loaded": loaded, "device": "cuda",
            "runtime_backend": "transformers", "config_id": os.environ.get("STT_CONFIG_ID", ""),
        }, status_code=200 if loaded else 503)

    @app.get("/v1/models")
    async def models():
        return {"object": "list", "data": [{"id": settings.model, "object": "model", "owned_by": "Qwen"}]}

    @app.post("/v1/audio/transcriptions")
    async def transcribe(request: Request):
        if runtime is None:
            raise HTTPException(503, "Qwen model is not ready")
        async with request.form(max_files=1, max_fields=8, max_part_size=8192) as form:
            file = form.get("file")
            if not isinstance(file, UploadFile):
                raise HTTPException(422, "A multipart audio file is required")
            model = form.get("model")
            if model is not None and model != settings.model:
                raise HTTPException(400, f"Loaded model is {settings.model}; restart the service to select another model")
            language = form.get("language")
            if not isinstance(language, (str, type(None))) or language not in LANGUAGES:
                raise HTTPException(400, "Language must be auto, fr, or en")
            response_format = form.get("response_format", "json")
            if response_format not in ("json", "verbose_json"):
                raise HTTPException(400, "Response format must be json or verbose_json")
            granularities = form.getlist("timestamp_granularities[]")
            if any(value != "word" for value in granularities):
                raise HTTPException(400, "Only word timestamps are supported")
            context = form.get("prompt", settings.vocabulary)
            if not isinstance(context, str) or len(context) > 2000:
                raise HTTPException(400, "Prompt must contain at most 2000 characters")
            if len(pending) >= MAX_JOBS:
                raise HTTPException(429, "Qwen inference queue is full", headers={"Retry-After": "1"})
            content = await file.read()

        active_runtime = runtime

        def infer():
            audio = decoder(content)
            return active_runtime.transcribe(
                audio, language=LANGUAGES[language], context=context,
                timestamps="word" in granularities,
            )

        # No await between admission and submission: the event loop owns this set.
        if len(pending) >= MAX_JOBS:
            raise HTTPException(429, "Qwen inference queue is full", headers={"Retry-After": "1"})
        future = asyncio.get_running_loop().run_in_executor(executor, infer)
        pending.add(future)
        def finished(job):
            pending.discard(job)
            # A disconnected caller may never await the result, including errors.
            if not job.cancelled():
                job.exception()

        future.add_done_callback(finished)
        try:
            result = await asyncio.shield(future)
        except InvalidAudio as error:
            raise HTTPException(400, str(error)) from error
        except Exception as error:
            LOG.exception("Qwen transcription failed")
            raise HTTPException(503, "Qwen transcription failed; retry when the GPU is available") from error
        # Report the settings used for this request so saved recordings can be
        # compared later without guessing which model or vocabulary was active.
        recognition = {
            "backend": "qwen", "model": settings.model,
            "modelRevision": MODELS[settings.model],
            "aligner": ALIGNER if "word" in granularities else None,
            "alignerRevision": ALIGNER_REVISION if "word" in granularities else None,
            "vocabulary": context, "languageHint": language or "auto",
            "dtype": "bfloat16", "attention": "sdpa", "maxNewTokens": 512,
        }
        return {**result, "model": settings.model, "recognition": recognition}

    return app
