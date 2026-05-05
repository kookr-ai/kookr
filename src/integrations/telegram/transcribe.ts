/**
 * Telegram audio transcription via the local faster-whisper-server sidecar.
 *
 * The server (image: fedirz/faster-whisper-server, port 8010) exposes an
 * OpenAI-compatible HTTP endpoint at POST /v1/audio/transcriptions. We POST
 * Telegram audio bytes as a multipart form (`file=<audio>`, `model=whisper-1`)
 * and read the JSON `{ text }` reply.
 *
 * Faster-whisper accepts Telegram voice, uploaded audio, and MP4 video-note
 * containers directly — no client-side conversion is needed. See issues #574
 * and #585.
 */

const MODEL_NAME = 'whisper-1';

export interface TranscribeOpts {
  /** Base URL of the whisper server, e.g. `http://127.0.0.1:8010`. */
  whisperUrl: string;
  /** Total request timeout. Default 30 s — large-v3 on GPU runs ~10x realtime. */
  timeoutMs?: number;
  /**
   * Override the multipart filename Telegram suggests. Telegram voice files
   * always end in `.oga` server-side, but phase-2 Telegram audio can arrive
   * as MP3, M4A, FLAC, OGG, or MP4 video-note containers.
   */
  filename?: string;
  /** MIME type hint for the multipart part. Defaults to Telegram voice OGG. */
  mimeType?: string;
  /** Optional external cancellation signal, used by integration shutdown. */
  signal?: AbortSignal;
}

export class TranscriptionError extends Error {
  constructor(
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

/**
 * Transcribe Telegram audio bytes. Returns the recognized text (possibly
 * empty for silent clips). Throws TranscriptionError on HTTP errors,
 * timeouts, or invalid bodies.
 */
export async function transcribeVoice(audioBytes: Buffer, opts: TranscribeOpts): Promise<string> {
  const url = `${opts.whisperUrl.replace(/\/$/, '')}/v1/audio/transcriptions`;
  const filename = opts.filename ?? 'voice.oga';
  const mimeType = opts.mimeType ?? 'audio/ogg';

  // Use the runtime-builtin FormData / Blob (Node 18+ ships them; the rest of
  // the codebase already relies on global fetch).
  const form = new FormData();
  // Buffer is a Uint8Array, which Blob accepts. faster-whisper-server/ffmpeg
  // still sniffs the bytes, but the MIME hint keeps multipart metadata honest.
  form.append('file', new Blob([new Uint8Array(audioBytes)], { type: mimeType }), filename);
  form.append('model', MODEL_NAME);

  const controller = new AbortController();
  const abortFromOuter = () => controller.abort();
  if (opts.signal?.aborted) {
    controller.abort();
  } else {
    opts.signal?.addEventListener('abort', abortFromOuter, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new TranscriptionError(res.status, `whisper ${res.status}: ${body.slice(0, 200)}`);
    }
    let json: { text?: unknown };
    try {
      json = (await res.json()) as { text?: unknown };
    } catch (err) {
      throw new TranscriptionError(res.status, `whisper returned non-JSON body: ${String(err)}`);
    }
    if (typeof json.text !== 'string') {
      throw new TranscriptionError(res.status, `whisper response missing "text" field`);
    }
    return json.text.trim();
  } catch (err) {
    if (err instanceof TranscriptionError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TranscriptionError(null, `whisper request aborted after ${opts.timeoutMs ?? 30_000}ms`);
    }
    throw new TranscriptionError(null, `whisper request failed: ${String(err)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abortFromOuter);
  }
}
