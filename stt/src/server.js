/**
 * STT WebSocket server with progressive transcription through Qwen or Whisper.
 * Each connection selects its spoken language independently. 'auto' lets
 * the model detect it; 'fr' and 'en' provide French and English hints.
 * The optional Parakeet WASM backend does not use the language hint.
 *
 * WebSocket Protocol (same as Python server):
 *   Client -> Server:
 *     - Binary: 16-bit PCM audio at 16kHz
 *     - JSON: {"type": "config", "language": "auto", "progressive": true}
 *     - JSON: {"type": "stop"}
 *     - JSON: {"type": "clear"}
 *     - JSON: {"type": "ping"}
 *
 *   Server -> Client:
 *     - JSON: {"type": "progressive", "fixedText": "...", "activeText": "...", "timestamp": 3.5}
 *     - JSON: {"type": "transcription", "text": "...", "is_final": false, "confidence": 0.9}
 *     - JSON: {"type": "config_ack", "language": "auto", "progressive": true}
 *     - JSON: {"type": "cleared", "success": true}
 *     - JSON: {"type": "pong"}
 *
 * FR-STT-010: Parakeet STT Backend
 * FR-STT-015: Progressive Streaming Transcription
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

import { WebSocket, WebSocketServer } from 'ws';

import { AudioBuffer, DEFAULT_MAX_BUFFER_SECONDS } from './audio-buffer.js';
import {
  normalizeConfigMessage,
  DEFAULT_LANGUAGE as FALLBACK_LANGUAGE,
  DEFAULT_SUPPORTED_LANGUAGES,
} from './config-validation.js';
import { loadVAD } from './vad.js';
import {
  loadModel,
  isModelLoaded,
  getModelVersion,
  getRuntimeInfo,
} from './model-loader.js';
import { SmartProgressiveStreamingHandler } from './progressive-streaming.js';
import { createTranscriptionBackend } from './backends/index.js';
import { shouldFinalizeFromCache } from './finalization-policy.js';
import { createHealthPayload } from './health.js';
import { warmupTranscriptionBackend } from './warmup.js';
import { createTranscriptionCorpus } from './transcription-corpus.cjs';
import { BrowserCorpusCapture } from './browser-corpus.js';

const PORT = parseInt(process.env.PORT || '8003', 10);
const PROGRESSIVE_INTERVAL = parseFloat(process.env.PROGRESSIVE_INTERVAL || '0.5');
const MAX_WINDOW_SIZE = parseFloat(process.env.MAX_WINDOW_SIZE || '15.0');
const SENTENCE_BUFFER = parseFloat(process.env.SENTENCE_BUFFER || '2.0');
const MIN_AUDIO_SECONDS = parseFloat(process.env.MIN_AUDIO_SECONDS || '0.5');
const SAMPLE_RATE = 16000;
// Qwen can need another pass after fixing a sentence. Bound the entire stop
// operation, including any earlier pass still running, to two minutes.
const QWEN_FINALIZATION_TIMEOUT_MS = 120_000;
const QWEN_CLIENT_TIMEOUT_MS = QWEN_FINALIZATION_TIMEOUT_MS + 5_000;

/**
 * Parse a positive-number env var, falling back to `fallback` when unset or
 * not a finite value > 0. Without this a typo like `STT_MAX_BUFFER_SECONDS=abc`
 * yields NaN, and `NaN` comparisons silently disable the very bound this hardens.
 *
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
function parsePositiveNumber(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Largest inbound WebSocket frame the sidecar will accept before closing the
// connection. 16-bit PCM audio frames are small; 1 MB is generous. Mirrors the
// main-server frame caps added in #1322.
const WS_MAX_PAYLOAD_BYTES = parsePositiveNumber(process.env.STT_WS_MAX_PAYLOAD_BYTES, 1_000_000);
// Rolling-window cap for the per-connection audio buffer, in samples.
const MAX_BUFFER_SECONDS = parsePositiveNumber(
  process.env.STT_MAX_BUFFER_SECONDS,
  DEFAULT_MAX_BUFFER_SECONDS,
);
const MAX_BUFFER_SAMPLES = Math.round(MAX_BUFFER_SECONDS * SAMPLE_RATE);
// Languages the sidecar will accept in a `config` message; anything else clamps
// back to DEFAULT_LANGUAGE.
const requestedDefaultLanguage = process.env.DEFAULT_LANGUAGE || FALLBACK_LANGUAGE;
const configuredLanguages = process.env.STT_SUPPORTED_LANGUAGES
  || [...DEFAULT_SUPPORTED_LANGUAGES, requestedDefaultLanguage].join(',');
const SUPPORTED_LANGUAGES = configuredLanguages
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
// An operator's restricted allowlist also applies to connections that never
// send config and to the fallback for invalid client input.
const DEFAULT_LANGUAGE = SUPPORTED_LANGUAGES.includes(requestedDefaultLanguage)
  ? requestedDefaultLanguage
  : (SUPPORTED_LANGUAGES[0] || FALLBACK_LANGUAGE);
const DEFAULT_PROGRESSIVE = true;
const runtimeInfo = getRuntimeInfo();
const transcriptionBackend = createTranscriptionBackend();
export const transcriptionCorpus = createTranscriptionCorpus();

/**
 * Handle a WebSocket client connection with progressive streaming.
 *
 * @param {import('ws').WebSocket} ws
 * @param {import('http').IncomingMessage} req
 */
function handleConnection(ws, req) {
  const clientAddr = req.socket.remoteAddress;
  console.log(`Client connected: ${clientAddr}`);

  const audioBuffer = new AudioBuffer(SAMPLE_RATE, MAX_BUFFER_SAMPLES);
  const capture = new BrowserCorpusCapture(transcriptionCorpus, transcriptionBackend, {
    kind: 'progressive', maxWindowSeconds: MAX_WINDOW_SIZE, sentenceBufferSeconds: SENTENCE_BUFFER,
  });
  const recordingBackend = transcriptionCorpus.enabled
    ? { ...transcriptionBackend, transcribe: (audio, options) => capture.transcribe(audio, options) }
    : transcriptionBackend;
  const streamingHandler = new SmartProgressiveStreamingHandler(recordingBackend, {
    maxWindowSize: MAX_WINDOW_SIZE,
    sentenceBuffer: SENTENCE_BUFFER,
    sampleRate: SAMPLE_RATE,
    minAudioSeconds: MIN_AUDIO_SECONDS,
  });

  let progressiveEnabled = DEFAULT_PROGRESSIVE;
  let language = DEFAULT_LANGUAGE;
  let lastProgressiveTime = 0;
  let processing = false;
  let processingTask = Promise.resolve();
  let finalizing = false;
  let stopped = false;
  let generation = 0;
  let controller = new AbortController();
  let lastEmittedTranscription = '';
  let lastProcessedAudioSeconds = 0;
  let lastProcessedLanguage = null;

  function resetRecording() {
    generation += 1;
    controller.abort();
    controller = new AbortController();
    capture.discard();
    streamingHandler.reset();
    audioBuffer.clear();
    lastProgressiveTime = 0;
    lastEmittedTranscription = '';
    lastProcessedAudioSeconds = 0;
    lastProcessedLanguage = null;
    processing = false;
    processingTask = Promise.resolve();
    finalizing = false;
  }

  function failRecording(error, code) {
    const partialText = lastProcessedLanguage === language ? lastEmittedTranscription : '';
    capture.finish(partialText, language, 'error', code);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'error', error: error.message, code, partial_text: partialText }));
    }
    resetRecording();
    stopped = true;
    ws.close(1011, code);
  }

  ws.on('message', async (message, isBinary) => {
    if (isBinary) {
      if (finalizing || ws.readyState !== WebSocket.OPEN) return;
      stopped = false;
      // Audio data - add to buffer
      const duration = audioBuffer.addChunk(message);
      capture.append(message);

      // Throttle progressive updates
      const now = Date.now() / 1000;
      if (
        now - lastProgressiveTime < PROGRESSIVE_INTERVAL ||
        duration < MIN_AUDIO_SECONDS ||
        processing
      ) {
        return;
      }

      processing = true;
      lastProgressiveTime = now;
      const transcriptionLanguage = language;
      const recordingGeneration = generation;
      const signal = controller.signal;

      processingTask = (async () => {
        try {
          const audio = audioBuffer.getAudio();
          const audioStartSample = audioBuffer.trimmedSamples;
          const result = await streamingHandler.transcribeIncremental(
            audio,
            audioStartSample,
            { language: transcriptionLanguage, signal },
          );
          if (recordingGeneration !== generation || ws.readyState !== WebSocket.OPEN) return;
          lastProcessedAudioSeconds = (audioStartSample + audio.length) / SAMPLE_RATE;
          lastProcessedLanguage = transcriptionLanguage;
          if (transcriptionLanguage !== language) return;

          // Send progressive update
          if (progressiveEnabled && (result.fixedText || result.activeText)) {
            ws.send(
              JSON.stringify({
                type: 'progressive',
                fixedText: result.fixedText,
                activeText: result.activeText,
                timestamp: Math.round(result.timestamp * 100) / 100,
              }),
            );
          }

          // Send backward-compatible non-final transcription only when progressive
          // mode is disabled. When progressive is enabled, emitting both message
          // types causes duplicate rendering in some clients.
          const fullText = [result.fixedText, result.activeText]
            .filter(Boolean)
            .join(' ');
          lastEmittedTranscription = fullText;
          if (fullText && !progressiveEnabled) {
            ws.send(
              JSON.stringify({
                type: 'transcription',
                text: fullText,
                is_final: false,
                confidence: 0.9,
                language: transcriptionLanguage,
              }),
            );
          }
        } catch (err) {
          if (recordingGeneration !== generation || signal.aborted) return;
          if (err.code === 'audio_window_exhausted') failRecording(err, err.code);
          else console.error('Transcription error:', err.message);
        } finally {
          if (recordingGeneration === generation) processing = false;
        }
      })();
      await processingTask;

      return;
    }

    // Text message - parse as JSON control message
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      console.warn('Invalid JSON message received');
      return;
    }

    const msgType = data.type;

    if (msgType === 'config') {
      const normalized = normalizeConfigMessage(data, {
        currentLanguage: language,
        currentProgressive: progressiveEnabled,
        defaultLanguage: DEFAULT_LANGUAGE,
        defaultProgressive: DEFAULT_PROGRESSIVE,
        supportedLanguages: SUPPORTED_LANGUAGES,
      });
      if (language !== normalized.language) lastEmittedTranscription = '';
      language = normalized.language;
      progressiveEnabled = normalized.progressive;

      console.log(`Client config: language=${language}, progressive=${progressiveEnabled}`);

      ws.send(
        JSON.stringify({
          type: 'config_ack',
          ...(transcriptionBackend.name === 'qwen' ? { finalization_timeout_ms: QWEN_CLIENT_TIMEOUT_MS } : {}),
          language,
          progressive: progressiveEnabled,
        }),
      );
    } else if (msgType === 'stop') {
      if (finalizing || stopped || ws.readyState !== WebSocket.OPEN) return;
      finalizing = true;
      const recordingGeneration = generation;
      const signal = controller.signal;
      const deadlineError = new Error('Transcription timed out. Please try again.');
      let deadlineTimer;
      let onAbort;
      const cancelled = new Promise((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const deadline = transcriptionBackend.name === 'qwen'
        ? new Promise((_resolve, reject) => {
          deadlineTimer = setTimeout(() => reject(deadlineError), QWEN_FINALIZATION_TIMEOUT_MS);
        })
        : null;
      const beforeDeadline = (operation) => Promise.race([operation, cancelled, ...(deadline ? [deadline] : [])]);
      try {
        if (processing) await beforeDeadline(processingTask);
        if (recordingGeneration !== generation || ws.readyState !== WebSocket.OPEN) return;
        const finalLanguage = language;
        const audio = audioBuffer.getAudio();
        const audioStartSample = audioBuffer.trimmedSamples;
        const audioSeconds = (audioStartSample + audio.length) / SAMPLE_RATE;
        const canFinalizeFromCache = lastProcessedLanguage === finalLanguage
          && shouldFinalizeFromCache({ lastEmittedTranscription, audioSeconds, lastProcessedAudioSeconds });
        let fullText = lastEmittedTranscription;
        if (!canFinalizeFromCache) {
          const result = await beforeDeadline(streamingHandler.transcribeIncremental(
            audio, audioStartSample, { language: finalLanguage, signal },
          ));
          if (recordingGeneration !== generation || ws.readyState !== WebSocket.OPEN) return;
          fullText = [result.fixedText, result.activeText].filter(Boolean).join(' ');
        }
        if (progressiveEnabled && fullText) {
          ws.send(JSON.stringify({
            type: 'progressive', fixedText: fullText, activeText: '',
            timestamp: Math.round(audioSeconds * 100) / 100, isFinal: true,
          }));
        }
        // Empty recognition also terminates the request. Errors never pretend
        // that a partial preview is a complete, successful transcription.
        capture.finish(fullText, finalLanguage);
        ws.send(JSON.stringify({
          type: 'transcription', text: fullText, is_final: true,
          confidence: 0.9, language: finalLanguage,
        }));
        signal.removeEventListener('abort', onAbort);
        resetRecording();
        stopped = true;
      } catch (err) {
        if (recordingGeneration !== generation || signal.aborted) return;
        const code = err === deadlineError ? 'finalization_timeout'
          : err.code === 'audio_window_exhausted' ? err.code : 'inference_failed';
        console.error('Final transcription error:', err.message);
        failRecording(err, code);
      } finally {
        clearTimeout(deadlineTimer);
        signal.removeEventListener('abort', onAbort);
        if (recordingGeneration === generation) finalizing = false;
      }
    } else if (msgType === 'clear') {
      resetRecording();
      stopped = false;
      ws.send(JSON.stringify({ type: 'cleared', success: true }));
    } else if (msgType === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    resetRecording();
    console.log(`Client disconnected: ${clientAddr}`);
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${clientAddr}:`, err.message);
  });
}

// --- HTTP + WebSocket Server ---

export const httpServer = createServer(async (req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    let backendHealth;
    if (transcriptionBackend.getHealth) {
      try {
        backendHealth = await transcriptionBackend.getHealth();
      } catch {
        // An unavailable upstream must not inherit the local WASM model's
        // stale metadata or a successful warmup from earlier in the process.
      }
    }
    const health = createHealthPayload({
      modelLoaded: isModelLoaded(),
      modelName: getModelVersion(),
      runtimeInfo,
      transcriptionBackend,
      backendHealth,
    });
    health.corpus = {
      enabled: transcriptionCorpus.enabled,
      configId: process.env.STT_CORPUS_CONFIG_ID || transcriptionCorpus.configId,
      ...transcriptionCorpus.stats(),
    };

    res.writeHead(health.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

export const wss = new WebSocketServer({ server: httpServer, maxPayload: WS_MAX_PAYLOAD_BYTES });
wss.on('connection', handleConnection);

// --- Graceful Shutdown ---

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  // Close all WebSocket connections
  for (const client of wss.clients) {
    client.close(1001, 'Server shutting down');
  }

  wss.close(() => {
    httpServer.close(async () => {
      await transcriptionCorpus.flush();
      console.log('Server stopped');
      process.exit(0);
    });
  });

  // Force exit after 10s
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

// --- Startup ---

const WARMUP_TIMEOUT_MS = parseInt(process.env.STT_WARMUP_TIMEOUT_MS || '120000', 10);
const WARMUP_RETRY_DELAY_MS = parseInt(process.env.STT_WARMUP_RETRY_DELAY_MS || '2000', 10);

export async function startServer() {
  console.log('Starting STT WebSocket Server (Node.js)...');
  console.log(`Transcription backend: ${transcriptionBackend.name}`);

  if (transcriptionBackend.name === 'wasm') {
    // loadModel() already runs its own silence warmup (see model-loader.js).
    await loadModel();
  } else {
    console.log(`Using upstream ${transcriptionBackend.name} model`);
    // Exercise inference before accepting dictation. Whisper can lazy-load
    // on this request; Qwen must already have loaded its model and aligner.
    const warmup = await warmupTranscriptionBackend(transcriptionBackend, {
      timeoutMs: WARMUP_TIMEOUT_MS,
      retryDelayMs: WARMUP_RETRY_DELAY_MS,
    });
    if (transcriptionBackend.name === 'qwen' && !warmup?.ok) {
      throw new Error('Qwen ASR warmup failed; refusing to start an unavailable transcription service');
    }
  }

  // Load Silero VAD (non-fatal — degrades gracefully if unavailable)
  await loadVAD();

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`STT Server running on ws://0.0.0.0:${PORT}`);
    console.log(`Health check: http://0.0.0.0:${PORT}/health`);
    if (transcriptionBackend.name === 'wasm') {
      console.log(`Model: ${getModelVersion()}, Backend: ${runtimeInfo.backend}, Device: ${runtimeInfo.device}`);
    }
  });
}

// Importing the server for isolated WebSocket tests must not bind a fixed port
// or register process-wide shutdown handlers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  startServer().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
