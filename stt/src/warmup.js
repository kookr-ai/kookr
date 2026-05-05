/**
 * Startup warmup for the active transcription backend.
 *
 * For the whisper backend the Node.js wrapper has no local model to load, but
 * the upstream Faster-Whisper sidecar lazy-loads its weights on the first
 * POST to /v1/audio/transcriptions. Sending a silent warmup buffer at startup
 * forces the model into GPU memory and JIT-compiles CUDA kernels before any
 * user request arrives, so /health only reports ok once the whole stack is
 * hot.
 *
 * Retries on error because docker-compose `depends_on: service_started` only
 * waits for the sidecar process to start, not for it to accept requests.
 */

const SAMPLE_RATE = 16000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 2_000;

/**
 * Warm up a transcription backend by sending 1s of silence and retrying
 * until it succeeds or the overall timeout elapses.
 *
 * @param {import('./backends/types.js').TranscriptionBackend} backend
 * @param {{timeoutMs?: number, retryDelayMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number}} [options]
 * @returns {Promise<{ok: boolean, attempts: number}>}
 */
export async function warmupTranscriptionBackend(backend, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());

  console.log(`Warming up ${backend.name} backend with 1s of silence...`);
  const silence = new Float32Array(SAMPLE_RATE);
  const deadline = now() + timeoutMs;
  let attempt = 0;

  while (now() < deadline) {
    attempt++;
    const started = now();
    try {
      await backend.transcribe(silence);
      console.log(`${backend.name} backend warmed up in ${now() - started}ms (attempt ${attempt})`);
      return { ok: true, attempts: attempt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const remainingSec = Math.max(0, Math.round((deadline - now()) / 1000));
      console.log(
        `Warmup attempt ${attempt} failed after ${now() - started}ms (${message}); ${remainingSec}s left, retrying in ${retryDelayMs}ms...`,
      );
      await sleep(retryDelayMs);
    }
  }

  console.warn(
    `${backend.name} backend warmup did not complete within ${timeoutMs / 1000}s; first transcription may be slow`,
  );
  return { ok: false, attempts: attempt };
}
