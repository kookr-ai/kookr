/**
 * Parakeet Model Loader for Node.js.
 *
 * FR-STT-010: Parakeet STT Backend
 */

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const MODEL_VERSION = process.env.MODEL_VERSION || 'parakeet-tdt-0.6b-v3';
const MODEL_REPO = process.env.MODEL_REPO || 'istupakov/parakeet-tdt-0.6b-v3-onnx';
const MODEL_REVISION = process.env.MODEL_REVISION || 'main';
const MODEL_CACHE_DIR = process.env.MODEL_CACHE_DIR || '/tmp/parakeet-model-cache';
// Use fp32 encoder by default for better recognition quality.
const ENCODER_QUANT = process.env.ENCODER_QUANT || 'fp32';
const DECODER_QUANT = process.env.DECODER_QUANT || 'int8';
const SAMPLE_RATE = 16000;
const RUNTIME_BACKEND = 'wasm';
const RUNTIME_DEVICE = 'cpu';

let model = null;
let loading = false;

async function configureOrtModule(entryFileUrl, wasmPaths, label) {
  const ortModule = await import(entryFileUrl);
  const ort = ortModule.default || ortModule;
  if (!ort?.env?.wasm) return false;

  ort.env.wasm.wasmPaths = wasmPaths;
  globalThis.ort = ort;
  console.log(`Configured ${label} ONNX wasm path: ${wasmPaths}`);
  return true;
}

/**
 * Configure ONNX Runtime Web to use local WASM files in Node.js.
 *
 * `parakeet.js` may resolve its own nested `onnxruntime-web` copy. We therefore
 * initialize both top-level and nested module entrypoints so neither can fall
 * back to CDN `https:` wasm imports, which Node's ESM loader rejects.
 *
 * @returns {Promise<string | undefined>} Local `file://` wasm dir URL if configured.
 */
async function configureLocalOrtWasmPaths() {
  const require = createRequire(import.meta.url);
  const distDirs = [];

  try {
    const topLevelOrtEntry = require.resolve('onnxruntime-web');
    distDirs.push(dirname(topLevelOrtEntry));
  } catch (_error) {
    // no-op
  }

  try {
    const parakeetPkg = require.resolve('parakeet.js/package.json');
    const parakeetRequire = createRequire(parakeetPkg);
    const nestedOrtEntry = parakeetRequire.resolve('onnxruntime-web');
    distDirs.push(dirname(nestedOrtEntry));
  } catch (_error) {
    // no-op
  }

  const uniqueDistDirs = [...new Set(distDirs)];
  for (const distDir of uniqueDistDirs) {
    if (!existsSync(distDir)) continue;

    const wasmPaths = pathToFileURL(`${distDir}/`).href;
    const entryFileCandidates = [
      join(distDir, 'ort.node.min.mjs'),
      join(distDir, 'ort.node.min.js'),
      join(distDir, 'index.js'),
    ];
    const entryFile = entryFileCandidates.find((file) => existsSync(file));
    if (!entryFile) continue;
    const entryFileUrl = pathToFileURL(entryFile).href;

    try {
      const configured = await configureOrtModule(entryFileUrl, wasmPaths, distDir.includes('parakeet.js') ? 'nested' : 'top-level');
      if (configured) return wasmPaths;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Failed to configure ORT from ${entryFile}: ${message}`);
    }
  }

  console.warn('Could not configure local ONNX wasm paths');
  return undefined;
}

/**
 * Download a model file to local disk if not already cached.
 *
 * @param {string} url
 * @param {string} destination
 * @returns {Promise<void>}
 */
async function ensureLocalFile(url, destination) {
  if (existsSync(destination)) {
    return;
  }

  console.log(`Downloading model file: ${url}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await mkdir(dirname(destination), { recursive: true });

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(destination, buffer);
    return;
  }

  const bodyStream = Readable.fromWeb(response.body);
  await pipeline(bodyStream, createWriteStream(destination));
  console.log(`Saved model file: ${destination}`);
}

/**
 * Build local filesystem paths for Parakeet model artifacts and ensure they
 * are available on disk for ONNX Runtime Node.
 *
 * @returns {Promise<{
 *   encoderUrl: string,
 *   decoderUrl: string,
 *   tokenizerUrl: string,
 *   encoderDataUrl?: string,
 *   decoderDataUrl?: string,
 *   filenames: {encoder: string, decoder: string}
 * }>}
 */
async function buildModelUrls() {
  const encoderName = ENCODER_QUANT === 'int8' ? 'encoder-model.int8.onnx' : 'encoder-model.onnx';
  const decoderName =
    DECODER_QUANT === 'int8' ? 'decoder_joint-model.int8.onnx' : 'decoder_joint-model.onnx';
  const base = `https://huggingface.co/${MODEL_REPO}/resolve/${MODEL_REVISION}`;
  const cacheDir = join(MODEL_CACHE_DIR, MODEL_VERSION, `${ENCODER_QUANT}-${DECODER_QUANT}`);

  const result = {
    encoderUrl: join(cacheDir, encoderName),
    decoderUrl: join(cacheDir, decoderName),
    tokenizerUrl: `${base}/vocab.txt`,
    encoderDataUrl: join(cacheDir, `${encoderName}.data`),
    filenames: {
      encoder: encoderName,
      decoder: decoderName,
    },
  };

  await ensureLocalFile(`${base}/${encoderName}`, result.encoderUrl);
  await ensureLocalFile(`${base}/${decoderName}`, result.decoderUrl);
  await ensureLocalFile(`${base}/${encoderName}.data`, result.encoderDataUrl);

  return result;
}

/**
 * Load the Parakeet model.
 * Downloads from HuggingFace Hub on first run, cached thereafter.
 */
export async function loadModel() {
  if (model) return;
  if (loading) throw new Error('Model is already loading');

  loading = true;
  console.log(
    `Loading Parakeet model: ${MODEL_VERSION} (encoder: ${ENCODER_QUANT}, decoder: ${DECODER_QUANT})`,
  );

  try {
    const wasmPaths = await configureLocalOrtWasmPaths();

    const { fromUrls } = await import('parakeet.js');
    const modelUrls = await buildModelUrls();
    console.log(`Loading model assets from ${MODEL_REPO}@${MODEL_REVISION}`);

    model = await fromUrls({
      ...modelUrls,
      backend: RUNTIME_BACKEND,
      ...(wasmPaths ? { wasmPaths } : {}),
      preprocessorBackend: 'js',
    });

    console.log('Model loaded, running warmup inference...');

    // Warmup: 1s silence to initialize runtime kernels
    const warmupAudio = new Float32Array(SAMPLE_RATE);
    await model.transcribe(warmupAudio, SAMPLE_RATE);

    console.log('Parakeet model ready');
  } catch (err) {
    model = null;
    console.error('Failed to load Parakeet model:', err);
    throw err;
  } finally {
    loading = false;
  }
}

/**
 * Transcribe audio using the loaded model.
 *
 * @param {Float32Array} audio - Audio samples at 16kHz
 * @returns {Promise<{text: string, words: Array<{text: string, start_time: number, end_time: number}>, confidence_scores: any}>}
 */
export async function transcribe(audio) {
  if (!model) throw new Error('Model not loaded');
  if (audio.length === 0) return { text: '', words: [], confidence_scores: null };

  const result = await model.transcribe(audio, SAMPLE_RATE, {
    returnTimestamps: true,
    returnConfidences: true,
    temperature: 1.0,
  });

  return {
    text: result.utterance_text || '',
    words: result.words || [],
    confidence_scores: result.confidence_scores || null,
  };
}

/** @returns {boolean} Whether the model is loaded and ready */
export function isModelLoaded() {
  return model !== null;
}

/** @returns {string} Model version string */
export function getModelVersion() {
  return MODEL_VERSION;
}

/** @returns {{backend: string, device: string}} Runtime execution info */
export function getRuntimeInfo() {
  return {
    backend: RUNTIME_BACKEND,
    device: RUNTIME_DEVICE,
  };
}
