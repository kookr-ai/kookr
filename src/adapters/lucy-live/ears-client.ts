/**
 * Client for Lucy's "ears": a llama.cpp server running the LFM3-Omni model, used only
 * to turn speech into text. It speaks an OpenAI-realtime-like protocol over a
 * WebSocket at `<url>/v1/realtime`:
 *
 *   server -> session.created
 *   client -> session.update {instructions: "Perform ASR in English."}   (before any audio)
 *   server -> session.updated
 *   client -> input_audio_buffer.append {audio: base64 PCM16 16 kHz}  (repeated)
 *   client -> input_audio_buffer.commit, then response.create
 *   server -> response.output_text.delta {delta}  (repeated), then response.done
 *
 * Each turn uses a fresh session: one long session drifts, starts repeating old
 * questions and answers instead of transcribing. Opening one costs time, so
 * {@link openEarsTurn} connects immediately and buffers audio until the session is ready;
 * the caller opens it when the operator starts speaking and the start-up hides under the speech.
 *
 * Closing a WebSocket takes about a second for the close handshake, so sessions are
 * closed fire-and-forget and nothing here ever waits for a close.
 */

import { WebSocket } from 'ws';
import type { LucyLiveLanguage } from '../../shared/contracts/lucy-live.js';

export interface EarsTurn {
  /** Queue PCM16 mono 16 kHz audio. Sent as soon as the session is ready. Ignored after finish/abort. */
  append(pcm: Buffer): void;
  /** Commit the audio and resolve with the transcript. Rejects on error, abort or timeout. */
  finish(): Promise<string>;
  /** Drop the session without a result. A pending {@link finish} rejects. */
  abort(): void;
}

export interface EarsOptions {
  /** Base URL of the ears server, e.g. `ws://127.0.0.1:8095`. `http(s)` is accepted and mapped. */
  url: string;
  language: LucyLiveLanguage;
  /** How long to wait for the session to become ready. Default 5 s. */
  connectTimeoutMs?: number;
  /** How long to wait for the transcript after {@link EarsTurn.finish}. Default 8 s. */
  finishTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_FINISH_TIMEOUT_MS = 8_000;
/** After this long a socket that has not finished its close handshake is torn down. */
const FORCE_CLOSE_AFTER_MS = 3_000;

export class EarsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EarsError';
  }
}

export function earsEndpoint(url: string): string {
  const base = url.trim().replace(/\/+$/, '').replace(/^http/i, 'ws');
  return `${base}/v1/realtime`;
}

function instructionFor(language: LucyLiveLanguage): string {
  switch (language) {
    case 'en': return 'Perform ASR in English.';
    case 'fr': return 'Perform ASR in French.';
  }
}

export function openEarsTurn(opts: EarsOptions): EarsTurn {
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const finishTimeoutMs = opts.finishTimeoutMs ?? DEFAULT_FINISH_TIMEOUT_MS;

  let settled = false;
  let resolveResult!: (text: string) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<string>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A turn aborted before finish() is called must not surface as an unhandled rejection.
  result.catch(() => {});

  let ws: WebSocket | undefined;
  let ready = false;
  let finishRequested = false;
  let commitSent = false;
  let text = '';
  const pending: Buffer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const closeQuietly = (): void => {
    const socket = ws;
    if (!socket) return;
    socket.removeAllListeners('message');
    socket.on('error', () => {}); // errors after we stopped caring
    try { socket.close(); } catch { /* already closed */ }
    const force = setTimeout(() => { try { socket.terminate(); } catch { /* gone */ } }, FORCE_CLOSE_AFTER_MS);
    force.unref();
    socket.once('close', () => clearTimeout(force));
  };

  const fail = (err: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectResult(err);
    closeQuietly();
  };
  const succeed = (value: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveResult(value);
    closeQuietly();
  };

  const sendJson = (payload: object): void => {
    ws?.send(JSON.stringify(payload));
  };
  const maybeCommit = (): void => {
    if (!ready || !finishRequested || commitSent || settled) return;
    commitSent = true;
    sendJson({ type: 'input_audio_buffer.commit' });
    sendJson({ type: 'response.create' });
  };
  const flush = (): void => {
    for (const chunk of pending.splice(0)) {
      sendJson({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
    }
  };

  timer = setTimeout(() => fail(new EarsError('Speech recogniser did not become ready in time')), connectTimeoutMs);

  try {
    ws = new WebSocket(earsEndpoint(opts.url), { perMessageDeflate: false });
  } catch (err) {
    fail(new EarsError(`Cannot reach speech recogniser: ${err instanceof Error ? err.message : String(err)}`));
  }

  ws?.on('message', (data) => {
    let msg: { type?: string; delta?: unknown; error?: { message?: unknown } };
    try {
      msg = JSON.parse(data.toString()) as typeof msg;
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case 'session.created':
          sendJson({
            type: 'session.update',
            session: { instructions: instructionFor(opts.language), output_modalities: ['text'] },
          });
          break;
        case 'session.updated':
          // The connect timer guards only the wait for readiness; a healthy session
          // may then stay open for as long as the operator speaks.
          if (!finishRequested) clearTimeout(timer); // else it is already the finish timer
          ready = true;
          flush();
          maybeCommit();
          break;
        case 'response.output_text.delta':
          if (typeof msg.delta === 'string') text += msg.delta;
          break;
        case 'response.done':
          succeed(text.trim());
          break;
        case 'error':
          fail(new EarsError(`Speech recogniser error: ${String(msg.error?.message ?? 'unknown')}`));
          break;
        default:
          break;
      }
    } catch (err) {
      fail(new EarsError(`Speech recogniser connection failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  });
  ws?.on('error', (err) => fail(new EarsError(`Speech recogniser connection failed: ${err.message}`)));
  ws?.on('close', () => fail(new EarsError('Speech recogniser closed the connection early')));

  return {
    append(pcm) {
      if (settled || finishRequested || pcm.length === 0) return;
      if (ready) sendJson({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') });
      else pending.push(pcm);
    },
    finish() {
      if (!finishRequested && !settled) {
        finishRequested = true;
        clearTimeout(timer);
        timer = setTimeout(() => fail(new EarsError('Speech recogniser took too long to answer')), finishTimeoutMs);
        maybeCommit();
      }
      return result;
    },
    abort() {
      fail(new EarsError('Transcription aborted'));
    },
  };
}

/** Transcribe a complete audio buffer in its own fresh session. Used for the improving drafts. */
export async function transcribeOnce(opts: EarsOptions & { pcm: Buffer; signal?: AbortSignal }): Promise<string> {
  const turn = openEarsTurn(opts);
  const onAbort = (): void => turn.abort();
  if (opts.signal?.aborted) turn.abort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    turn.append(opts.pcm);
    return await turn.finish();
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}
