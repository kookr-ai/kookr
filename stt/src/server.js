/**
 * STT WebSocket Server for AegisCore - Parakeet TDT 0.6B (Node.js)
 *
 * Uses parakeet.js with onnxruntime-node (CUDA) for server-side inference.
 * Replaces the Python/NeMo implementation for better transcription quality
 * by using the same model and algorithm as the original parakeet-v3-streaming.
 *
 * WebSocket Protocol (same as Python server):
 *   Client -> Server:
 *     - Binary: 16-bit PCM audio at 16kHz
 *     - JSON: {"type": "config", "language": "en", "progressive": true}
 *     - JSON: {"type": "stop"}
 *     - JSON: {"type": "clear"}
 *     - JSON: {"type": "ping"}
 *
 *   Server -> Client:
 *     - JSON: {"type": "progressive", "fixedText": "...", "activeText": "...", "timestamp": 3.5}
 *     - JSON: {"type": "transcription", "text": "...", "is_final": false, "confidence": 0.9}
 *     - JSON: {"type": "config_ack", "language": "en", "progressive": true}
 *     - JSON: {"type": "cleared", "success": true}
 *     - JSON: {"type": "pong"}
 *
 * FR-STT-010: Parakeet STT Backend
 * FR-STT-015: Progressive Streaming Transcription
 */

import { createServer } from 'node:http';

import { WebSocketServer } from 'ws';

import { AudioBuffer, DEFAULT_MAX_BUFFER_SECONDS } from './audio-buffer.js';
import { normalizeConfigMessage } from './config-validation.js';
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

const PORT = parseInt(process.env.PORT || '8003', 10);
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || 'en';
const PROGRESSIVE_INTERVAL = parseFloat(process.env.PROGRESSIVE_INTERVAL || '0.5');
const MAX_WINDOW_SIZE = parseFloat(process.env.MAX_WINDOW_SIZE || '15.0');
const SENTENCE_BUFFER = parseFloat(process.env.SENTENCE_BUFFER || '2.0');
const MIN_AUDIO_SECONDS = parseFloat(process.env.MIN_AUDIO_SECONDS || '0.5');
const SAMPLE_RATE = 16000;

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
const SUPPORTED_LANGUAGES = (process.env.STT_SUPPORTED_LANGUAGES || DEFAULT_LANGUAGE)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_PROGRESSIVE = true;
const runtimeInfo = getRuntimeInfo();
const transcriptionBackend = createTranscriptionBackend();

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
  const streamingHandler = new SmartProgressiveStreamingHandler(transcriptionBackend, {
    maxWindowSize: MAX_WINDOW_SIZE,
    sentenceBuffer: SENTENCE_BUFFER,
    sampleRate: SAMPLE_RATE,
    minAudioSeconds: MIN_AUDIO_SECONDS,
  });

  let progressiveEnabled = DEFAULT_PROGRESSIVE;
  let language = DEFAULT_LANGUAGE;
  let lastProgressiveTime = 0;
  let processing = false;
  let lastEmittedTranscription = '';
  let lastProcessedAudioSeconds = 0;

  /**
   * Wait for any in-flight incremental transcription to finish.
   * Prevents stop-handler races where finalization happens before
   * last progressive text is available.
   *
   * @param {number} timeoutMs
   * @returns {Promise<void>}
   */
  async function waitForProcessingDrain(timeoutMs = 30000) {
    const start = Date.now();
    while (processing && Date.now() - start < timeoutMs) {
      // Keep this short so stop remains responsive while waiting for model inference.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  ws.on('message', async (message, isBinary) => {
    if (isBinary) {
      // Audio data - add to buffer
      const duration = audioBuffer.addChunk(message);

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

      try {
        const audio = audioBuffer.getAudio();
        const result = await streamingHandler.transcribeIncremental(
          audio,
          audioBuffer.trimmedSamples,
        );
        lastProcessedAudioSeconds = audio.length / SAMPLE_RATE;

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
        if (fullText && !progressiveEnabled) {
          lastEmittedTranscription = fullText;
          ws.send(
            JSON.stringify({
              type: 'transcription',
              text: fullText,
              is_final: false,
              confidence: 0.9,
              language,
            }),
          );
        }
      } catch (err) {
        console.error('Transcription error:', err.message);
      } finally {
        processing = false;
      }

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
      language = normalized.language;
      progressiveEnabled = normalized.progressive;

      console.log(`Client config: language=${language}, progressive=${progressiveEnabled}`);

      ws.send(
        JSON.stringify({
          type: 'config_ack',
          language,
          progressive: progressiveEnabled,
        }),
      );
    } else if (msgType === 'stop') {
      // Final transcription
      if (audioBuffer.duration() > 0) {
        try {
          if (processing) {
            await waitForProcessingDrain();
          }

          const audioSeconds = audioBuffer.duration();
          const canFinalizeFromCache = shouldFinalizeFromCache({
            lastEmittedTranscription,
            audioSeconds,
            lastProcessedAudioSeconds,
            maxUnprocessedTailSeconds: 0.25,
          });

          if (canFinalizeFromCache) {
            ws.send(
              JSON.stringify({
                type: 'transcription',
                text: lastEmittedTranscription,
                is_final: true,
                confidence: 0.9,
                language,
              }),
            );
            streamingHandler.reset();
            audioBuffer.clear();
            lastProgressiveTime = 0;
            lastEmittedTranscription = '';
            lastProcessedAudioSeconds = 0;
            processing = false;
            return;
          }

          const audio = audioBuffer.getAudio();
          const result = await streamingHandler.transcribeIncremental(
            audio,
            audioBuffer.trimmedSamples,
          );
          lastProcessedAudioSeconds = audio.length / SAMPLE_RATE;

          const fullText = [result.fixedText, result.activeText]
            .filter(Boolean)
            .join(' ');
          if (fullText) {
            lastEmittedTranscription = fullText;
          }

          if (progressiveEnabled && fullText) {
            ws.send(
              JSON.stringify({
                type: 'progressive',
                fixedText: fullText,
                activeText: '',
                timestamp: Math.round(result.timestamp * 100) / 100,
                isFinal: true,
              }),
            );
          }

          // Always emit a final frame so clients can terminate requests
          // even when decoding yields empty text.
          ws.send(
            JSON.stringify({
              type: 'transcription',
              text: fullText,
              is_final: true,
              confidence: 0.9,
              language,
            }),
          );
        } catch (err) {
          const errMessage = err instanceof Error ? err.message : String(err);
          const errStack = err instanceof Error ? err.stack : '';
          console.error('Final transcription error:', errMessage);
          if (errStack) {
            console.error(errStack);
          }
          ws.send(
            JSON.stringify({
              type: 'transcription',
              text: lastEmittedTranscription,
              is_final: true,
              confidence: 0.9,
              language,
            }),
          );
        }
      }

      // Reset for next recording session
      streamingHandler.reset();
      audioBuffer.clear();
      lastProgressiveTime = 0;
      lastEmittedTranscription = '';
      lastProcessedAudioSeconds = 0;
    } else if (msgType === 'clear') {
      streamingHandler.reset();
      audioBuffer.clear();
      lastProgressiveTime = 0;
      lastEmittedTranscription = '';
      lastProcessedAudioSeconds = 0;
      ws.send(JSON.stringify({ type: 'cleared', success: true }));
    } else if (msgType === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected: ${clientAddr}`);
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${clientAddr}:`, err.message);
  });
}

// --- HTTP + WebSocket Server ---

const httpServer = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    const health = createHealthPayload({
      modelLoaded: isModelLoaded(),
      modelName: getModelVersion(),
      runtimeInfo,
      transcriptionBackend,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: WS_MAX_PAYLOAD_BYTES });
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
    httpServer.close(() => {
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

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Startup ---

const WARMUP_TIMEOUT_MS = parseInt(process.env.STT_WARMUP_TIMEOUT_MS || '120000', 10);
const WARMUP_RETRY_DELAY_MS = parseInt(process.env.STT_WARMUP_RETRY_DELAY_MS || '2000', 10);

async function main() {
  console.log('Starting Parakeet STT WebSocket Server (Node.js)...');
  console.log(`Transcription backend: ${transcriptionBackend.name}`);

  if (transcriptionBackend.name === 'wasm') {
    // loadModel() already runs its own silence warmup (see model-loader.js).
    await loadModel();
  } else {
    console.log('Skipping local Parakeet model load because whisper backend is active');
    // The upstream sidecar lazy-loads on first request. Warm it up now so
    // /health does not go green until the whole stack is hot.
    await warmupTranscriptionBackend(transcriptionBackend, {
      timeoutMs: WARMUP_TIMEOUT_MS,
      retryDelayMs: WARMUP_RETRY_DELAY_MS,
    });
  }

  // Load Silero VAD (non-fatal — degrades gracefully if unavailable)
  await loadVAD();

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Parakeet STT Server running on ws://0.0.0.0:${PORT}`);
    console.log(`Health check: http://0.0.0.0:${PORT}/health`);
    console.log(
      `Model: ${getModelVersion()}, Backend: ${runtimeInfo.backend}, Device: ${runtimeInfo.device}`,
    );
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
