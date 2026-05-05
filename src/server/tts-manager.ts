/**
 * TTS Manager — manages the lifecycle of the bundled TTS Docker container.
 *
 * When KOOKR_TTS=true, this module:
 * 1. Runs `docker compose up -d` on the tts/ docker-compose.yml
 * 2. Waits for the TTS service health check to pass
 * 3. Exposes the TTS HTTP URL for synthesis requests
 * 4. Tears down containers on server shutdown
 *
 * When KOOKR_TTS is unset or false, this module is a no-op.
 *
 * Mirrors the STT manager pattern (see stt-manager.ts).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface TTSManagerConfig {
  /** Absolute path to the tts/ directory containing docker-compose.yml */
  ttsDir: string;
  /** Port to expose the TTS service on the host (default: 8004) */
  port?: number;
  /** TTS voice to use (default: matilda) */
  voice?: string;
  /** Max time to wait for health check (ms, default: 120000) */
  startupTimeoutMs?: number;
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
    voice = '/app/voices/matilda.mp3',
    startupTimeoutMs = 120_000,
  } = config;

  const composePath = join(ttsDir, 'docker-compose.yml');
  const env = {
    ...process.env,
    KOOKR_TTS_PORT: String(port),
    TTS_VOICE: voice,
  };

  console.log(`[tts] Starting TTS container (voice: ${voice}, port: ${port})...`);

  // Start container in detached mode
  try {
    await execFileAsync('docker', ['compose', '-f', composePath, 'up', '-d', '--build'], {
      env,
      timeout: 600_000, // PyTorch + CUDA install can take several minutes on first build
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[tts] Failed to start Docker container: ${msg}`);
  }

  // Wait for health check
  const healthUrl = `http://localhost:${port}/health`;
  const deadline = Date.now() + startupTimeoutMs;

  console.log(`[tts] Waiting for TTS service at ${healthUrl}...`);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        console.log('[tts] TTS service is ready');

        const url = `http://localhost:${port}`;
        return {
          url,
          stop: () => stopTTS(composePath, env),
        };
      }
    } catch {
      // Not ready yet
    }
    await sleep(2000);
  }

  // Timeout — tear down and throw
  await stopTTS(composePath, env).catch(() => {});
  throw new Error(`[tts] TTS service did not become healthy within ${startupTimeoutMs / 1000}s`);
}

async function stopTTS(composePath: string, env: NodeJS.ProcessEnv): Promise<void> {
  console.log('[tts] Stopping TTS container...');
  try {
    await execFileAsync('docker', ['compose', '-f', composePath, 'down'], {
      env,
      timeout: 30_000,
    });
    console.log('[tts] TTS container stopped');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tts] Warning: failed to stop TTS container: ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
