/**
 * TTS Manager — manages the lifecycle of the bundled TTS Docker container.
 *
 * When KOOKR_TTS=true, this module:
 * 1. Runs `docker compose up -d` on the tts/ docker-compose.yml
 * 2. Waits for the TTS service health check to pass
 * 3. Probes synthesis with the configured voice
 * 4. Exposes the TTS HTTP URL for synthesis requests
 * 5. Tears down containers on server shutdown
 *
 * When KOOKR_TTS is unset or false, this module is a no-op.
 *
 * Mirrors the STT manager pattern (see stt-manager.ts).
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { hasDockerRuntime } from './docker-runtime.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_TTS_VOICE = '/app/voices/matilda.mp3';
const TTS_BUILD_STAMP_FILE = '.kookr-tts-build.hash';

export type TTSDevice = 'auto' | 'cpu' | 'gpu';
export type ResolvedTTSDevice = 'cpu' | 'gpu';

export interface TTSManagerConfig {
  /** Absolute path to the tts/ directory containing docker-compose.yml */
  ttsDir: string;
  /** Port to expose the TTS service on the host (default: 8004) */
  port?: number;
  /** TTS voice to use (default: bundled Matilda voice) */
  voice?: string;
  /**
   * Inference device. `auto` (default) probes the docker daemon for an
   * nvidia runtime; `cpu` and `gpu` force the choice.
   */
  device?: TTSDevice;
  /** Max time to wait for health check (ms, default: 120000) */
  startupTimeoutMs?: number;
  /** Max time to wait for the configured voice synthesis probe (ms, default: 30000) */
  readinessProbeTimeoutMs?: number;
}

export interface TTSManager {
  /** The TTS HTTP URL for synthesis requests (e.g. http://localhost:8004) */
  url: string;
  /** Stop the Docker container */
  stop(): Promise<void>;
}

/**
 * Start the TTS Docker stack and wait for it to become healthy.
 * Throws if the container fails to start or health check times out.
 */
export async function startTTS(config: TTSManagerConfig): Promise<TTSManager> {
  const {
    ttsDir,
    port = 8004,
    voice = DEFAULT_TTS_VOICE,
    device = parseTTSDeviceFromEnv(),
    startupTimeoutMs = 120_000,
    readinessProbeTimeoutMs = 30_000,
  } = config;

  const resolvedDevice = await resolveTTSDevice(device);
  const composePath = join(ttsDir, 'docker-compose.yml');
  const gpuOverlayPath = join(ttsDir, 'docker-compose.gpu.yml');
  const composeFlags =
    resolvedDevice === 'gpu' ? ['-f', composePath, '-f', gpuOverlayPath] : ['-f', composePath];

  const env = {
    ...process.env,
    KOOKR_TTS_PORT: String(port),
    TTS_VOICE: voice,
  };

  console.log(
    `[tts] Starting TTS container (device: ${resolvedDevice}${
      device === 'auto' ? ' [auto]' : ''
    }, voice: ${voice}, port: ${port})...`,
  );

  const buildPlan = await planTTSImageBuild(ttsDir);
  if (buildPlan.build) {
    console.log(`[tts] Building TTS image (${buildPlan.reason})...`);
  } else {
    console.log('[tts] Reusing existing TTS image; build inputs are unchanged');
  }

  // Start container in detached mode
  try {
    const upArgs = [
      'compose',
      ...composeFlags,
      'up',
      '-d',
      ...(buildPlan.build ? ['--build'] : []),
    ];
    await execFileAsync('docker', upArgs, {
      env,
      timeout: 600_000, // PyTorch + CUDA install can take several minutes on first build
    });
    if (buildPlan.build) {
      await writeTTSBuildStamp(ttsDir, buildPlan.inputHash);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[tts] Failed to start Docker container: ${msg}`);
  }

  // Wait for health check
  const healthUrl = `http://localhost:${port}/health`;
  const deadline = Date.now() + startupTimeoutMs;

  console.log(`[tts] Waiting for TTS service at ${healthUrl}...`);

  while (Date.now() < deadline) {
    let healthy = false;
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      healthy = res.ok;
    } catch {
      // Not ready yet
    }
    if (healthy) {
      const url = `http://localhost:${port}`;
      try {
        await probeTTSReadiness(url, voice, readinessProbeTimeoutMs);
      } catch (err) {
        await stopTTS(composeFlags, env).catch(() => {});
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[tts] TTS service health passed but synthesis probe failed: ${msg}`);
      }

      console.log('[tts] TTS service is ready');
      return {
        url,
        stop: () => stopTTS(composeFlags, env),
      };
    }
    await sleep(2000);
  }

  // Timeout — tear down and throw
  await stopTTS(composeFlags, env).catch(() => {});
  throw new Error(`[tts] TTS service did not become healthy within ${startupTimeoutMs / 1000}s`);
}

async function probeTTSReadiness(
  url: string,
  voice: string,
  timeoutMs: number,
): Promise<void> {
  console.log(`[tts] Probing configured TTS voice (${voice})...`);
  const res = await fetch(`${url}/synthesize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: 'ready',
      voice,
      params: { framesAfterEos: 0 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // Keep the readiness error useful even if the response body cannot be read.
    }
    const suffix = detail ? `: ${detail.slice(0, 500)}` : '';
    throw new Error(`HTTP ${res.status}${suffix}`);
  }
}

async function stopTTS(composeFlags: string[], env: NodeJS.ProcessEnv): Promise<void> {
  console.log('[tts] Stopping TTS container...');
  try {
    await execFileAsync('docker', ['compose', ...composeFlags, 'down'], {
      env,
      timeout: 30_000,
    });
    console.log('[tts] TTS container stopped');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tts] Warning: failed to stop TTS container: ${msg}`);
  }
}

/**
 * Resolve `auto` to `cpu` or `gpu` by probing the docker daemon for an
 * nvidia runtime. Any probe failure means "no GPU available" and falls
 * back to CPU.
 */
export async function resolveTTSDevice(
  device: TTSDevice,
  probe: () => Promise<boolean> = () => hasDockerRuntime('nvidia'),
): Promise<ResolvedTTSDevice> {
  if (device === 'cpu' || device === 'gpu') return device;
  return (await probe()) ? 'gpu' : 'cpu';
}

export function parseTTSDevice(raw: string | undefined): TTSDevice {
  if (!raw) return 'auto';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'cpu' || normalized === 'gpu') {
    return normalized;
  }
  console.warn(
    `[tts] Warning: ignoring invalid KOOKR_TTS_DEVICE=${JSON.stringify(raw)}; using auto`,
  );
  return 'auto';
}

export function parseTTSDeviceFromEnv(): TTSDevice {
  return parseTTSDevice(process.env.KOOKR_TTS_DEVICE);
}

interface TTSImageBuildPlan {
  build: boolean;
  inputHash: string;
  reason: string;
}

async function planTTSImageBuild(ttsDir: string): Promise<TTSImageBuildPlan> {
  const inputHash = await hashTTSBuildInputs(ttsDir);
  const stampPath = join(ttsDir, TTS_BUILD_STAMP_FILE);
  let previousHash = '';

  try {
    previousHash = (await readFile(stampPath, 'utf-8')).trim();
  } catch {
    // First run, deleted stamp, or unreadable stamp: rebuild conservatively.
    return { build: true, inputHash, reason: 'no prior build stamp' };
  }

  if (previousHash !== inputHash) {
    return { build: true, inputHash, reason: 'TTS build inputs changed' };
  }

  return { build: false, inputHash, reason: 'TTS build inputs unchanged' };
}

async function hashTTSBuildInputs(ttsDir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relativePath of [
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.gpu.yml',
    'src',
    'voices',
  ]) {
    await addPathToHash(hash, ttsDir, relativePath);
  }
  return hash.digest('hex');
}

async function addPathToHash(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  relativePath: string,
): Promise<void> {
  const absolutePath = join(rootDir, relativePath);
  try {
    const stats = await lstat(absolutePath);
    if (stats.isDirectory()) {
      hash.update(`dir\0${relativePath}\0`);
      const entries = await readdir(absolutePath);
      for (const entry of entries.sort()) {
        await addPathToHash(hash, rootDir, join(relativePath, entry));
      }
      return;
    }

    if (stats.isFile()) {
      hash.update(`file\0${relativePath}\0`);
      hash.update(await readFile(absolutePath));
      hash.update('\0');
      return;
    }

    hash.update(`other\0${relativePath}\0${stats.mode}\0`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      hash.update(`missing\0${relativePath}\0`);
      return;
    }
    throw err;
  }
}

async function writeTTSBuildStamp(ttsDir: string, inputHash: string): Promise<void> {
  try {
    await mkdir(ttsDir, { recursive: true });
    await writeFile(join(ttsDir, TTS_BUILD_STAMP_FILE), `${inputHash}\n`, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tts] Warning: failed to write TTS build stamp: ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
