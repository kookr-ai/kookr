/**
 * Voice Activity Detection using Silero VAD v5.
 *
 * Tiny ONNX model (~2.3MB) that detects speech vs silence/noise.
 * Runs at ~0.6ms per 32ms frame on CPU — negligible overhead.
 *
 * Used as a pre-filter before Whisper to prevent hallucinations
 * on silent or near-silent audio ("Thank you for watching!" etc).
 *
 * The model is mic-agnostic: it learned what speech sounds like,
 * not what silence measures at, so no threshold calibration needed.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = join(__dirname, '..', 'models', 'silero_vad_v5.onnx');

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512; // 32ms at 16kHz — required by Silero VAD v5

/** @type {any} */
let ort = null;
/** @type {any} */
let session = null;

/**
 * Import onnxruntime-web and configure WASM paths for Node.js.
 * Independent of model-loader.js so VAD works even when the
 * Parakeet model is skipped (whisper backend active).
 */
async function initOrt() {
  if (ort) return ort;

  // Reuse globalThis.ort if model-loader already configured it
  if (globalThis.ort) {
    ort = globalThis.ort;
    return ort;
  }

  try {
    const require = createRequire(import.meta.url);
    const ortEntry = require.resolve('onnxruntime-web');
    const distDir = dirname(ortEntry);

    const entryFile = [
      join(distDir, 'ort.node.min.mjs'),
      join(distDir, 'ort.node.min.js'),
      join(distDir, 'index.js'),
    ].find((f) => existsSync(f));

    if (!entryFile) throw new Error('No ort entry file found');

    const ortModule = await import(pathToFileURL(entryFile).href);
    ort = ortModule.default || ortModule;
    ort.env.wasm.wasmPaths = pathToFileURL(`${distDir}/`).href;
    ort.env.wasm.numThreads = 1;
    return ort;
  } catch (err) {
    console.warn(`[vad] Failed to import onnxruntime-web: ${err.message}`);
    return null;
  }
}

/**
 * Load the Silero VAD model. Call once at startup.
 */
export async function loadVAD() {
  if (session) return;

  const ortInstance = await initOrt();
  if (!ortInstance) {
    console.warn('[vad] onnxruntime-web not available — VAD disabled');
    return;
  }

  try {
    const modelBuffer = await readFile(MODEL_PATH);
    session = await ortInstance.InferenceSession.create(modelBuffer.buffer);
    console.log('[vad] Silero VAD v5 loaded');
  } catch (err) {
    console.warn(`[vad] Failed to load VAD model: ${err.message} — VAD disabled`);
    session = null;
  }
}

/** @returns {boolean} Whether the VAD model is loaded and ready. */
export function isVADLoaded() {
  return session !== null;
}

/**
 * Compute speech probability for a full audio buffer.
 *
 * Processes the audio in 512-sample frames (32ms each) using the stateful
 * Silero VAD model. Returns the maximum speech probability seen across
 * all frames and the fraction of frames classified as speech.
 *
 * @param {Float32Array} audio - Audio samples at 16kHz
 * @param {object} [options]
 * @param {number} [options.threshold=0.5] - Speech probability threshold
 * @returns {Promise<{maxProb: number, speechRatio: number, hasSpeech: boolean}>}
 */
export async function detectSpeech(audio, options = {}) {
  const { threshold = 0.5 } = options;

  if (!session || !ort) {
    // VAD not available — assume speech to avoid blocking real audio
    return { maxProb: 1.0, speechRatio: 1.0, hasSpeech: true };
  }

  const totalFrames = Math.floor(audio.length / FRAME_SIZE);

  if (totalFrames === 0) {
    return { maxProb: 0, speechRatio: 0, hasSpeech: false };
  }

  // Initialize recurrent state (zeroed)
  let state = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128]);
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]));

  let maxProb = 0;
  let speechFrames = 0;

  for (let i = 0; i < totalFrames; i++) {
    const frame = audio.slice(i * FRAME_SIZE, (i + 1) * FRAME_SIZE);
    const input = new ort.Tensor('float32', frame, [1, FRAME_SIZE]);

    const result = await session.run({ input, state, sr });
    const prob = result.output.data[0];
    state = result.stateN;

    if (prob > maxProb) maxProb = prob;
    if (prob >= threshold) speechFrames++;
  }

  return {
    maxProb,
    speechRatio: speechFrames / totalFrames,
    hasSpeech: maxProb >= threshold,
  };
}
