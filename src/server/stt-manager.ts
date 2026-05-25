/**
 * STT Manager — manages the lifecycle of the bundled STT Docker containers.
 *
 * When KOOKR_STT=true, this module:
 * 1. Runs `docker compose up -d` on the stt/ docker-compose.yml
 * 2. Waits for the STT service health check to pass
 * 3. Exposes the STT WebSocket URL for the frontend
 * 4. Tears down containers on server shutdown
 *
 * When KOOKR_STT is unset or false, this module is a no-op.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { hasDockerRuntime } from './docker-runtime.js';

const execFileAsync = promisify(execFile);
export const DEFAULT_STT_STARTUP_TIMEOUT_MS = 600_000;

export type STTDevice = 'auto' | 'cpu' | 'gpu';
export type ResolvedSTTDevice = 'cpu' | 'gpu';

export interface STTManagerConfig {
  /** Absolute path to the stt/ directory containing docker-compose.yml */
  sttDir: string;
  /** Port to expose the STT service on the host (default: 8003) */
  port?: number;
  /**
   * Whisper model. When omitted, the manager picks `base` for CPU and
   * `large-v3` for GPU so first-run downloads stay reasonable.
   */
  whisperModel?: string;
  /**
   * Inference device. `auto` (default) probes the docker daemon for an
   * nvidia runtime; `cpu` and `gpu` force the choice.
   */
  device?: STTDevice;
  /** Max time to wait for health check (ms, default: 600000) */
  startupTimeoutMs?: number;
}

export interface STTManager {
  /** The STT WebSocket URL to pass to the frontend (e.g. ws://localhost:8003) */
  url: string;
  /** Stop the Docker containers */
  stop(): Promise<void>;
}

/**
 * Start the STT Docker stack and wait for it to become healthy.
 * Throws if containers fail to start or health check times out.
 */
export async function startSTT(config: STTManagerConfig): Promise<STTManager> {
  const {
    sttDir,
    port = 8003,
    whisperModel,
    device = parseSTTDevice(),
    startupTimeoutMs = parseSTTHealthTimeoutMs(),
  } = config;

  const resolvedDevice = await resolveDevice(device);
  const defaults = deviceDefaults(resolvedDevice);
  // Explicit user overrides via env beat the device-derived defaults; the
  // typed config arg (whisperModel) beats both.
  const model = whisperModel ?? process.env.WHISPER_MODEL ?? defaults.model;
  const image = process.env.WHISPER_IMAGE ?? defaults.image;
  const whisperDevice = process.env.WHISPER_DEVICE ?? defaults.device;
  const computeType = process.env.WHISPER_COMPUTE_TYPE ?? defaults.computeType;

  const composePath = join(sttDir, 'docker-compose.yml');
  const gpuOverlayPath = join(sttDir, 'docker-compose.gpu.yml');
  const composeFlags =
    resolvedDevice === 'gpu' ? ['-f', composePath, '-f', gpuOverlayPath] : ['-f', composePath];

  const env = {
    ...process.env,
    KOOKR_STT_PORT: String(port),
    WHISPER_IMAGE: image,
    WHISPER_MODEL: model,
    WHISPER_DEVICE: whisperDevice,
    WHISPER_COMPUTE_TYPE: computeType,
  };

  console.log(
    `[stt] Starting STT containers (device: ${resolvedDevice}${
      device === 'auto' ? ' [auto]' : ''
    }, model: ${model}, port: ${port})...`,
  );

  // Start containers in detached mode
  try {
    await execFileAsync('docker', ['compose', ...composeFlags, 'up', '-d', '--build'], {
      env,
      timeout: 120_000,
    });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[stt] Failed to start Docker containers: ${msg}${stderr ? `\nstderr: ${stderr}` : ''}`);
  }

  // Wait for health check
  const healthUrl = `http://localhost:${port}/health`;
  const deadline = Date.now() + startupTimeoutMs;

  console.log(`[stt] Waiting for STT service at ${healthUrl}...`);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const health = await res.json();
        console.log(`[stt] STT service is ready (backend: ${health.backend ?? 'unknown'})`);

        const url = `ws://localhost:${port}`;
        return {
          url,
          stop: () => stopSTT(composeFlags, env),
        };
      }
    } catch {
      // Not ready yet
    }
    await sleep(2000);
  }

  // Timeout — tear down and throw
  await stopSTT(composeFlags, env).catch(() => {});
  throw new Error(`[stt] STT service did not become healthy within ${startupTimeoutMs / 1000}s`);
}

async function stopSTT(composeFlags: string[], env: NodeJS.ProcessEnv): Promise<void> {
  console.log('[stt] Stopping STT containers...');
  try {
    await execFileAsync('docker', ['compose', ...composeFlags, 'down'], {
      env,
      timeout: 30_000,
    });
    console.log('[stt] STT containers stopped');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[stt] Warning: failed to stop STT containers: ${msg}`);
  }
}

/**
 * Resolve `auto` to `cpu` or `gpu` by probing the docker daemon for an
 * nvidia runtime. Any probe failure (no docker, permission, parse error)
 * means "no GPU available" and falls back to CPU — never throws.
 */
export async function resolveDevice(
  device: STTDevice,
  probe: () => Promise<boolean> = () => hasDockerRuntime('nvidia'),
): Promise<ResolvedSTTDevice> {
  if (device === 'cpu' || device === 'gpu') return device;
  return (await probe()) ? 'gpu' : 'cpu';
}

interface DeviceDefaults {
  image: string;
  model: string;
  device: string;
  computeType: string;
}

function deviceDefaults(resolved: ResolvedSTTDevice): DeviceDefaults {
  if (resolved === 'gpu') {
    return {
      image: 'fedirz/faster-whisper-server:latest-cuda',
      model: 'large-v3',
      device: 'cuda',
      computeType: 'float16',
    };
  }
  return {
    image: 'fedirz/faster-whisper-server:latest-cpu',
    model: 'base',
    device: 'cpu',
    computeType: 'int8',
  };
}

export function parseSTTDevice(raw = process.env.KOOKR_STT_DEVICE): STTDevice {
  if (!raw) return 'auto';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'auto' || normalized === 'cpu' || normalized === 'gpu') {
    return normalized;
  }
  console.warn(
    `[stt] Warning: ignoring invalid KOOKR_STT_DEVICE=${JSON.stringify(raw)}; using auto`,
  );
  return 'auto';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseSTTHealthTimeoutMs(raw = process.env.KOOKR_STT_HEALTH_TIMEOUT_S): number {
  if (!raw) return DEFAULT_STT_STARTUP_TIMEOUT_MS;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.warn(
      `[stt] Warning: ignoring invalid KOOKR_STT_HEALTH_TIMEOUT_S=${JSON.stringify(raw)}; ` +
        `using ${DEFAULT_STT_STARTUP_TIMEOUT_MS / 1000}s`,
    );
    return DEFAULT_STT_STARTUP_TIMEOUT_MS;
  }

  return Math.round(seconds * 1000);
}
