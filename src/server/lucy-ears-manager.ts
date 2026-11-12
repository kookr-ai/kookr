/**
 * Lucy's ears manager: starts and stops the speech-recogniser sidecar for Lucy live
 * (`lucy-ears/docker-compose.yml`, LFM3-Omni-2B in llama.cpp) when `KOOKR_LUCY_EARS=true`
 * and no `KOOKR_LUCY_EARS_URL` is given.
 *
 * It follows stt-manager.ts / tts-manager.ts (GPU probe through the Docker runtime list,
 * reuse of a healthy container before any compose change, a routine Kookr restart leaves the
 * container running, `pnpm prod:stop --with-sidecars` runs `compose down`) with one difference:
 * the first start downloads about 2.4 GB, so bring-up does NOT block server startup. `start`
 * returns a handle at once whose state moves `starting` -> `ready` | `unavailable`, and
 * Lucy live's status route reports "starting" meanwhile.
 *
 * The compose project is pinned to `lucy-ears` (what the directory name gives by default), so
 * an operator who started the sidecar by hand is adopted: same containers, same weights volume,
 * nothing downloaded again.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { hasDockerRuntime } from './docker-runtime.js';

const execFileAsync = promisify(execFile);

export const LUCY_EARS_COMPOSE_PROJECT = 'lucy-ears';
export const DEFAULT_LUCY_EARS_PORT = 8095;
/** The first start downloads ~2.4 GB and pulls a CUDA image; allow 15 minutes. */
export const DEFAULT_LUCY_EARS_STARTUP_TIMEOUT_MS = 900_000;

export type LucyEarsState =
  | { phase: 'starting' }
  | { phase: 'ready'; url: string }
  | { phase: 'unavailable'; reason: string };

export interface LucyEarsHandle {
  getState(): LucyEarsState;
  /** Called after every state change. Returns an unsubscribe function. */
  onChange(listener: (state: LucyEarsState) => void): () => void;
  /** Settles when bring-up has finished (ready or unavailable). Never rejects. */
  settled: Promise<void>;
  /** `compose down`. Volumes (the downloaded weights) are kept. */
  stop(): Promise<void>;
}

/** Side effects, injectable so the logic is testable without Docker. */
export interface LucyEarsIo {
  hasNvidia(): Promise<boolean>;
  /** True when `GET /health` answers 200. */
  isHealthy(port: number): Promise<boolean>;
  composeUp(flags: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void>;
  composeDown(flags: string[], env: NodeJS.ProcessEnv): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface LucyEarsConfig {
  /** Absolute path of the lucy-ears/ directory holding docker-compose.yml. */
  earsDir: string;
  port?: number;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  io?: LucyEarsIo;
}

export function lucyEarsComposeIdentity(earsDir: string, port: number): { flags: string[]; env: NodeJS.ProcessEnv } {
  return {
    flags: ['-p', LUCY_EARS_COMPOSE_PROJECT, '-f', join(earsDir, 'docker-compose.yml')],
    env: { ...process.env, KOOKR_LUCY_EARS_PORT: String(port) },
  };
}

export const NO_GPU_REASON =
  'Lucy\'s ears need an NVIDIA GPU, and Docker has no nvidia runtime here, so the speech recogniser was not started.';

/**
 * Begin bringing the recogniser up. Returns immediately; progress is in the handle's state.
 * Never throws: every failure becomes an `unavailable` state with a reason for the operator.
 */
export function startLucyEars(config: LucyEarsConfig): LucyEarsHandle {
  const port = config.port ?? DEFAULT_LUCY_EARS_PORT;
  const timeoutMs = config.startupTimeoutMs ?? DEFAULT_LUCY_EARS_STARTUP_TIMEOUT_MS;
  const pollMs = config.pollIntervalMs ?? 2000;
  const io = config.io ?? defaultIo;
  const { flags, env } = lucyEarsComposeIdentity(config.earsDir, port);

  let state: LucyEarsState = { phase: 'starting' };
  const listeners = new Set<(s: LucyEarsState) => void>();
  const set = (next: LucyEarsState): void => {
    state = next;
    for (const l of [...listeners]) {
      try { l(next); } catch { /* a listener must not break bring-up */ }
    }
  };
  const fail = (reason: string): void => {
    console.warn(`[lucy-ears] ${reason}`);
    set({ phase: 'unavailable', reason });
  };

  const bringUp = async (): Promise<void> => {
    // Warm path: a healthy recogniser (ours from a previous run, or one started by hand
    // under the same compose project) is used as is: no compose change, no download.
    if (await io.isHealthy(port)) {
      console.log(`[lucy-ears] Reusing healthy speech recogniser at port ${port}`);
      return set({ phase: 'ready', url: `ws://127.0.0.1:${port}` });
    }

    // Only now is a GPU needed: adopting a healthy recogniser above must not depend on how
    // Docker exposes the GPU (a named runtime, CDI), which this probe cannot see.
    if (!(await io.hasNvidia())) return fail(NO_GPU_REASON);

    const deadline = io.now() + timeoutMs;
    console.log(`[lucy-ears] Starting speech recogniser (port ${port}); the first start downloads about 2.4 GB...`);
    try {
      await io.composeUp(flags, env, Math.max(1000, deadline - io.now()));
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? '';
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`Failed to start the speech recogniser container: ${msg}${stderr ? ` (${stderr.trim()})` : ''}`);
    }

    while (io.now() < deadline) {
      if (await io.isHealthy(port)) {
        console.log('[lucy-ears] Speech recogniser is ready');
        return set({ phase: 'ready', url: `ws://127.0.0.1:${port}` });
      }
      await io.sleep(pollMs);
    }
    // Not torn down: the container may be an operator's own or still downloading (the weights
    // volume keeps partial progress), and the next Kookr start adopts it. `pnpm prod:stop
    // --with-sidecars` frees the GPU.
    fail(`The speech recogniser did not become healthy within ${Math.round(timeoutMs / 1000)}s (raise KOOKR_LUCY_EARS_HEALTH_TIMEOUT_S on a slow connection). The container was left running; restart Kookr to pick it up.`);
  };

  const settled = bringUp().catch((err: unknown) => {
    fail(`Unexpected error starting the speech recogniser: ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    getState: () => state,
    onChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    settled,
    stop: () => io.composeDown(flags, env),
  };
}

/** Operator reclaim for `pnpm prod:stop --with-sidecars`: same project and file as start. */
export async function stopBundledLucyEars(opts: { earsDir: string; port?: number; io?: Pick<LucyEarsIo, 'composeDown'> }): Promise<void> {
  const { flags, env } = lucyEarsComposeIdentity(opts.earsDir, opts.port ?? DEFAULT_LUCY_EARS_PORT);
  console.log('[lucy-ears] Stopping speech recogniser container...');
  await (opts.io ?? defaultIo).composeDown(flags, env);
}

const defaultIo: LucyEarsIo = {
  hasNvidia: () => hasDockerRuntime('nvidia'),
  async isHealthy(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  },
  async composeUp(flags, env, timeoutMs) {
    await execFileAsync('docker', ['compose', ...flags, 'up', '-d'], { env, timeout: timeoutMs });
  },
  async composeDown(flags, env) {
    try {
      await execFileAsync('docker', ['compose', ...flags, 'down'], { env, timeout: 30_000 });
      console.log('[lucy-ears] Speech recogniser stopped');
    } catch (err) {
      console.warn(`[lucy-ears] Warning: failed to stop the speech recogniser: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export function parseLucyEarsPort(raw = process.env.KOOKR_LUCY_EARS_PORT): number {
  if (!raw) return DEFAULT_LUCY_EARS_PORT;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  console.warn(`[lucy-ears] Warning: ignoring invalid KOOKR_LUCY_EARS_PORT=${JSON.stringify(raw)}; using ${DEFAULT_LUCY_EARS_PORT}`);
  return DEFAULT_LUCY_EARS_PORT;
}

export function parseLucyEarsTimeoutMs(raw = process.env.KOOKR_LUCY_EARS_HEALTH_TIMEOUT_S): number {
  if (!raw) return DEFAULT_LUCY_EARS_STARTUP_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    console.warn(`[lucy-ears] Warning: ignoring invalid KOOKR_LUCY_EARS_HEALTH_TIMEOUT_S=${JSON.stringify(raw)}; using ${DEFAULT_LUCY_EARS_STARTUP_TIMEOUT_MS / 1000}s`);
    return DEFAULT_LUCY_EARS_STARTUP_TIMEOUT_MS;
  }
  return Math.round(seconds * 1000);
}

/** Bundled ownership: enabled AND no explicit URL (an explicit URL means an external sidecar). */
export function ownsBundledLucyEars(env: Record<string, string | undefined>): boolean {
  const enabled = env.KOOKR_LUCY_EARS === 'true' || env.KOOKR_LUCY_EARS === '1';
  return enabled && !env.KOOKR_LUCY_EARS_URL?.trim();
}
