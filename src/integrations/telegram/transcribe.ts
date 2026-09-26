/**
 * Telegram audio transcription via the local Whisper or Qwen HTTP sidecar.
 *
 * The selected server (port 8010) exposes an
 * OpenAI-compatible HTTP endpoint at POST /v1/audio/transcriptions. We POST
 * Telegram audio bytes as a multipart form (`file=<audio>`, `model=<configured
 * model>`) and read the JSON `{ text }` reply.
 *
 * Both services accept Telegram voice, uploaded audio, and MP4 video-note
 * containers directly — no client-side conversion is needed. See issues #574
 * and #585.
 */

import { TelegramApiError } from './api-client.js';
import {
  createTranscriptionCorpus, getCorpusConfig,
  type CorpusRecord, type TranscriptionCorpus,
} from '../../../stt/src/transcription-corpus.cjs';

const DEFAULT_MODEL_NAME = 'base';

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
  /**
   * Model selected by bundled startup. External services default to
   * WHISPER_MODEL when set, then `base` for compatibility.
   */
  model?: string;
  /** Present only for user recordings; warmup requests never populate the corpus. */
  capture?: { durationSeconds?: number; kind?: string };
}

let corpus: TranscriptionCorpus | undefined;

function getCaptureStore(): TranscriptionCorpus | undefined {
  // The application loads .env after imports, so configuration must be lazy.
  try {
    const config = getCorpusConfig();
    if (!config.enabled) return undefined;
    if (corpus?.configId !== config.configId) corpus = createTranscriptionCorpus();
    return corpus;
  } catch {
    // An invalid optional capture destination must not disable transcription.
    return undefined;
  }
}

function audioFormat(filename: string, mimeType: string): CorpusRecord['format'] {
  const extension = filename.split('.').at(-1)?.toLowerCase();
  if (extension === 'oga') return 'ogg';
  if (extension && ['wav', 'ogg', 'mp3', 'mp4', 'm4a', 'webm', 'flac', 'aac'].includes(extension)) {
    return extension as CorpusRecord['format'];
  }
  const mimeFormats: Record<string, CorpusRecord['format']> = {
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'video/webm': 'webm',
    'audio/flac': 'flac', 'audio/aac': 'aac',
  };
  return mimeFormats[mimeType.toLowerCase().split(';')[0].trim()] ?? 'bin';
}

function recognitionMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  // Accept only known model settings. An external service may include unrelated
  // identifiers or private URLs elsewhere in its response.
  for (const key of ['backend', 'model', 'modelRevision', 'aligner', 'alignerRevision', 'vocabulary', 'languageHint', 'dtype', 'attention']) {
    if (typeof input[key] === 'string' || input[key] === null) result[key] = input[key];
  }
  if (typeof input.maxNewTokens === 'number' && Number.isFinite(input.maxNewTokens)) {
    result.maxNewTokens = input.maxNewTokens;
  }
  return result;
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
 * 4xx statuses that genuinely mean "this specific recording was rejected" —
 * the payload-rejected bucket. Other 4xx (429 rate limit, 408 timeout,
 * 401/403 auth, 407 proxy auth) are infrastructure problems where the OGG
 * itself is fine; routing those to "re-record" gives users wrong advice.
 */
const PAYLOAD_REJECTED_STATUSES = new Set([
  400, // Bad Request — whisper rejected the body shape
  413, // Payload Too Large
  415, // Unsupported Media Type
  422, // Unprocessable Entity
]);

/**
 * Classify an audio-pipeline error into one of four user-facing replies. The
 * audit log records the error string for diagnosis, with credential-shaped
 * content redacted by the audit writer before disk append.
 */
export function classifyVoiceError(err: unknown): string {
  // TranscriptionError.status can be null (transport failure) — skip the
  // range checks in that case so the message regex below has a chance.
  // TelegramApiError.status is always a number, so a non-2xx Telegram CDN
  // response gets classified the same way as a whisper non-2xx response.
  const status =
    err instanceof TranscriptionError ? err.status :
    err instanceof TelegramApiError ? err.status :
    null;
  if (status !== null) {
    if (PAYLOAD_REJECTED_STATUSES.has(status)) {
      return 'Could not transcribe that recording. Please re-record or type.';
    }
    // Everything else 4xx (429 rate limit, 408 timeout, 401/403 auth, etc.)
    // and all 5xx — the recording is fine, the user should retry.
    if (status >= 400 && status < 600) {
      return 'Transcription failed (server error). Please type or try again.';
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  // 2xx whisper responses with a malformed body — TranscriptionError carries
  // the original 2xx status, so the range checks above miss it; the message
  // is the only signal. Strings here mirror transcribeVoice exactly.
  if (/non-JSON|missing "text" field/.test(msg)) {
    return 'Transcription failed (server error). Please type or try again.';
  }
  // Transport-layer failures from any leg. The undici fetch backend can
  // stringify failures in several shapes — best-effort coverage of common
  // ones. The AbortError name check catches both transcribeVoice's bespoke
  // "aborted after Nms" and downloadFile's raw AbortError.
  const TRANSPORT_FAIL =
    /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT)|getaddrinfo|aborted after \d+ms/i;
  if (TRANSPORT_FAIL.test(msg) || (err instanceof Error && err.name === 'AbortError')) {
    return 'Transcription server unreachable. Please type — audio will retry on the next message.';
  }
  return 'Transcription failed. Please type.';
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
  const model = opts.model ?? process.env.WHISPER_MODEL ?? DEFAULT_MODEL_NAME;
  const captureStore = opts.capture ? getCaptureStore() : undefined;
  const startedAt = new Date().toISOString();
  const startedMs = performance.now();
  let transcript: string | null = null;
  let language = 'auto';
  let reportedModel: string | null = null;
  let recognition: Record<string, unknown> | null = null;
  let errorCode: string | null = null;

  // Use the runtime-builtin FormData / Blob (Node 18+ ships them; the rest of
  // the codebase already relies on global fetch).
  const form = new FormData();
  // Buffer is a Uint8Array, which Blob accepts. faster-whisper-server/ffmpeg
  // still sniffs the bytes, but the MIME hint keeps multipart metadata honest.
  form.append('file', new Blob([new Uint8Array(audioBytes)], { type: mimeType }), filename);
  form.append('model', model);

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
    let json: { text?: unknown; language?: unknown; model?: unknown; recognition?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      throw new TranscriptionError(res.status, `whisper returned non-JSON body: ${String(err)}`);
    }
    if (typeof json.text !== 'string') {
      throw new TranscriptionError(res.status, `whisper response missing "text" field`);
    }
    transcript = json.text.trim();
    language = typeof json.language === 'string' ? json.language : 'auto';
    reportedModel = typeof json.model === 'string' ? json.model : null;
    recognition = recognitionMetadata(json.recognition);
    return transcript;
  } catch (err) {
    errorCode = err instanceof TranscriptionError
      ? (err.status !== null && err.status >= 400 ? `http_${err.status}` : 'invalid_response')
      : controller.signal.aborted ? 'timeout' : 'transport';
    if (err instanceof TranscriptionError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TranscriptionError(null, `whisper request aborted after ${opts.timeoutMs ?? 30_000}ms`);
    }
    throw new TranscriptionError(null, `whisper request failed: ${String(err)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', abortFromOuter);
    if (captureStore && !opts.signal?.aborted) {
      const durationSeconds = opts.capture?.durationSeconds;
      const kind = opts.capture?.kind;
      try {
        // The writer copies the buffer before returning and bounds its queue.
        // Disk I/O runs separately, so it cannot delay Telegram's reply.
        void captureStore.write({
          audio: audioBytes, format: audioFormat(filename, mimeType),
          metadata: {
            source: 'telegram', transcript, status: errorCode === null ? 'success' : 'error',
            model: { requested: model, reported: reportedModel, recognition }, language,
            startedAt, elapsedMs: performance.now() - startedMs,
            durationSeconds: typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds >= 0
              ? durationSeconds : null,
            kind: kind && ['voice', 'audio', 'video_note', 'document'].includes(kind) ? kind : 'audio',
            errorCode,
          },
        }).catch(() => {});
      } catch {
        // Corpus failures never replace the original transcription or error.
      }
    }
  }
}
