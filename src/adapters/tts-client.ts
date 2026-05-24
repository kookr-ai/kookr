/**
 * Thin wrapper around the Pocket TTS HTTP API (tts/src/server.py:142).
 *
 * Owns: timeout, error normalization, AbortSignal propagation. Does not own
 * caching, voice selection policy, or HTTP transport for the calling route —
 * those belong to higher layers.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export interface TTSSynthesisResult {
  audioBase64: string;
  durationMs: number;
  generationTimeMs: number;
}

export class TTSClientError extends Error {
  constructor(public readonly kind: 'http' | 'network' | 'timeout' | 'bad-response', message: string) {
    super(message);
    this.name = 'TTSClientError';
  }
}

export interface SynthesizeOptions {
  ttsUrl: string;
  text: string;
  voice: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function synthesize(opts: SynthesizeOptions): Promise<TTSSynthesisResult> {
  const { ttsUrl, text, voice, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new TTSClientError('timeout', `TTS synthesize timed out after ${timeoutMs}ms`)), timeoutMs);
  const upstreamAbort = () => controller.abort(signal?.reason ?? new TTSClientError('network', 'TTS synthesize aborted by caller'));
  if (signal) {
    if (signal.aborted) upstreamAbort();
    else signal.addEventListener('abort', upstreamAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(`${ttsUrl.replace(/\/+$/, '')}/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, voice }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof TTSClientError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new TTSClientError('network', `TTS request failed: ${reason}`);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', upstreamAbort);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new TTSClientError('http', `TTS returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TTSClientError('bad-response', `TTS body not JSON: ${reason}`);
  }

  if (!json || typeof json !== 'object') {
    throw new TTSClientError('bad-response', 'TTS body not an object');
  }
  const obj = json as Record<string, unknown>;
  const audioBase64 = obj.audioBase64;
  const durationMs = obj.durationMs;
  const generationTimeMs = obj.generationTimeMs;
  if (
    typeof audioBase64 !== 'string' ||
    audioBase64.length === 0 ||
    typeof durationMs !== 'number' ||
    typeof generationTimeMs !== 'number'
  ) {
    throw new TTSClientError('bad-response', 'TTS body missing fields');
  }

  return { audioBase64, durationMs, generationTimeMs };
}
