/**
 * Silero voice-activity detection for Lucy live, running inside the Kookr server.
 *
 * Why it exists. The browser decides "the operator started talking" from loudness alone,
 * so a cough, a click or a door slam looks the same as speech. Before Lucy is cut off,
 * the server asks this model: "was that really a human voice?". Silero VAD v5 is a tiny
 * neural network (about 2 MB, about 1 ms per 32 ms of audio) that answers with a
 * probability of speech for each 32 ms slice of audio.
 *
 * It is the same model and the same runtime (onnxruntime-web, single-threaded WASM) that
 * `stt/src/vad.js` uses to filter silence before transcription.
 *
 * Use: `loadSileroVad()` once at startup (never throws; returns null and logs one warning
 * when the model or the runtime is missing), then `openTurn()` for each stretch of audio.
 * The turn detector is streaming: feed it any size of PCM16 chunk and it returns one
 * probability per complete 512-sample frame, remembering the leftover samples and the
 * network's recurrent state for the next call.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Samples per model frame: 32 ms at 16 kHz, the size Silero VAD v5 requires. */
export const SILERO_FRAME_SAMPLES = 512;
const SAMPLE_RATE = 16_000;
const BYTES_PER_FRAME = SILERO_FRAME_SAMPLES * 2;
const STATE_SIZE = 2 * 1 * 128;
const MODEL_FILE = 'silero_vad_v5.onnx';

/** The slice of onnxruntime-web this adapter uses, so tests can supply a fake. */
export interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<{ output: { data: ArrayLike<number> }; stateN: unknown }>;
}
export interface OrtLike {
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims?: readonly number[]) => unknown;
  InferenceSession: { create(model: Uint8Array): Promise<OrtSessionLike> };
}

/** One stretch of audio (one candidate interruption or one operator turn). */
export interface SileroTurn {
  /**
   * Feed PCM16 little-endian mono 16 kHz audio of any length. Resolves with the speech
   * probability (0..1) of every frame completed by this chunk, in order; may be empty.
   * Calls are processed strictly in order. Rejects if the model fails.
   */
  push(pcm16: Buffer): Promise<number[]>;
}

export interface SileroVad {
  openTurn(): SileroTurn;
}

export interface LoadSileroOptions {
  /** Absolute path of the model file. Default: found next to the repo's `stt/` folder. */
  modelPath?: string;
  /** Test seam: supply the runtime instead of importing onnxruntime-web. */
  loadOrt?: () => Promise<OrtLike>;
  warn?: (message: string) => void;
}

// Kookr's server compiles to CommonJS, so `__dirname` exists both under tsx and in dist/.
const moduleDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

/**
 * Where the model lives. `src/adapters/lucy-live/` (run with tsx) and
 * `dist/adapters/lucy-live/` (built) are both three folders below the repo root, so one
 * relative path serves both; the working directory is the fallback for odd layouts.
 */
export function resolveSileroModelPath(): string | null {
  const candidates = [
    join(moduleDir, '..', '..', '..', 'stt', 'models', MODEL_FILE),
    join(process.cwd(), 'stt', 'models', MODEL_FILE),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function importOrt(): Promise<OrtLike> {
  const require = createRequire(join(moduleDir, 'silero-vad.js'));
  const distDir = dirname(require.resolve('onnxruntime-web'));
  // The CommonJS build: this file is CommonJS, so a plain require() needs no ESM interop.
  const entry = join(distDir, 'ort.node.min.js');
  if (!existsSync(entry)) throw new Error('onnxruntime-web has no Node entry file');
  const mod = require(entry);
  const ort = (mod.default ?? mod) as OrtLike & { env: { wasm: { wasmPaths: string; numThreads: number } } };
  ort.env.wasm.wasmPaths = pathToFileURL(`${distDir}/`).href;
  ort.env.wasm.numThreads = 1;
  return ort;
}

/** Load the model once. Never throws: returns null (after one warning) when Silero cannot run. */
export async function loadSileroVad(options: LoadSileroOptions = {}): Promise<SileroVad | null> {
  const warn = options.warn ?? ((m: string) => console.warn(`[lucy-live] ${m}`));
  try {
    const modelPath = options.modelPath ?? resolveSileroModelPath();
    if (!modelPath) throw new Error(`${MODEL_FILE} not found under stt/models`);
    const ort = await (options.loadOrt ?? importOrt)();
    const bytes = await readFile(modelPath);
    const session = await ort.InferenceSession.create(new Uint8Array(bytes));
    return createSileroVad(ort, session);
  } catch (err) {
    warn(`Silero voice check unavailable, interruptions will not be confirmed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Build the detector over an already created runtime and session (exported for tests). */
export function createSileroVad(ort: OrtLike, session: OrtSessionLike): SileroVad {
  return {
    openTurn(): SileroTurn {
      // Recurrent memory of the network; zero at the start of every turn.
      let state: unknown = new ort.Tensor('float32', new Float32Array(STATE_SIZE), [2, 1, 128]);
      const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]));
      let leftover: Buffer = Buffer.alloc(0);
      let tail: Promise<unknown> = Promise.resolve();

      return {
        push(pcm16: Buffer): Promise<number[]> {
          // Cut frames now (synchronously) so the leftover is right whatever order inference finishes in.
          const joined = leftover.length === 0 ? pcm16 : Buffer.concat([leftover, pcm16]);
          const frameCount = Math.floor(joined.length / BYTES_PER_FRAME);
          const used = frameCount * BYTES_PER_FRAME;
          leftover = Buffer.from(joined.subarray(used)); // a copy: the caller may reuse its buffer
          const frames: Float32Array[] = [];
          for (let f = 0; f < frameCount; f++) {
            const frame = new Float32Array(SILERO_FRAME_SAMPLES);
            for (let i = 0; i < SILERO_FRAME_SAMPLES; i++) frame[i] = joined.readInt16LE(f * BYTES_PER_FRAME + i * 2) / 32768;
            frames.push(frame);
          }
          if (frames.length === 0) return Promise.resolve([]);

          const run = tail.then(async () => {
            const probs: number[] = [];
            for (const frame of frames) {
              const input = new ort.Tensor('float32', frame, [1, SILERO_FRAME_SAMPLES]);
              const result = await session.run({ input, state, sr });
              probs.push(Number(result.output.data[0]));
              state = result.stateN;
            }
            return probs;
          });
          tail = run.catch(() => undefined); // one failure must not wedge later calls' ordering
          return run;
        },
      };
    },
  };
}
