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

const execFileAsync = promisify(execFile);

export interface STTManagerConfig {
  /** Absolute path to the stt/ directory containing docker-compose.yml */
  sttDir: string;
  /** Port to expose the STT service on the host (default: 8003) */
  port?: number;
  /** Whisper model to use (default: large-v3) */
  whisperModel?: string;
  /** Max time to wait for health check (ms, default: 120000) */
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
    whisperModel = 'large-v3',
    startupTimeoutMs = 120_000,
  } = config;

  const composePath = join(sttDir, 'docker-compose.yml');
  const env = {
    ...process.env,
    KOOKR_STT_PORT: String(port),
    WHISPER_MODEL: whisperModel,
  };

  console.log(`[stt] Starting STT containers (model: ${whisperModel}, port: ${port})...`);

  // Start containers in detached mode
  try {
    await execFileAsync('docker', ['compose', '-f', composePath, 'up', '-d', '--build'], {
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
          stop: () => stopSTT(composePath, env),
        };
      }
    } catch {
      // Not ready yet
    }
    await sleep(2000);
  }

  // Timeout — tear down and throw
  await stopSTT(composePath, env).catch(() => {});
  throw new Error(`[stt] STT service did not become healthy within ${startupTimeoutMs / 1000}s`);
}

async function stopSTT(composePath: string, env: NodeJS.ProcessEnv): Promise<void> {
  console.log('[stt] Stopping STT containers...');
  try {
    await execFileAsync('docker', ['compose', '-f', composePath, 'down'], {
      env,
      timeout: 30_000,
    });
    console.log('[stt] STT containers stopped');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[stt] Warning: failed to stop STT containers: ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
