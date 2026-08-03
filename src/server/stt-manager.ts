/**
 * STT Manager — manages the lifecycle of the bundled STT Docker containers.
 *
 * When KOOKR_STT=true, this module:
 * 1. Reuses healthy running containers when possible (zero compose mutation)
 * 2. Otherwise runs `docker compose up -d` on the stt/ docker-compose.yml
 * 3. Waits for the STT service health check to pass
 * 4. Exposes the STT WebSocket URL for the frontend
 * 5. Keeps a real stop() = compose down for failed-start cleanup and
 *    `pnpm prod:stop --with-sidecars` (routine SIGTERM detaches — see shutdown.ts)
 *
 * When KOOKR_STT is unset or false, this module is a no-op.
 *
 * Reuse identity (R11, docs/rfc/rfc-fast-prod-restart.md): live Whisper health
 * returns e.g. status:ok, backend:whisper, model_loaded:false, and model_name
 * set to a Parakeet MODEL_VERSION — so P1 MUST NOT require model_loaded===true
 * or compare model_name to WHISPER_MODEL. Prefer status/backend + optional
 * docker inspect of WHISPER__MODEL on kookr-stt-whisper.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { hasDockerRuntime } from './docker-runtime.js';

const execFileAsync = promisify(execFile);
export const DEFAULT_STT_STARTUP_TIMEOUT_MS = 600_000;
const STT_BUILD_STAMP_FILE = '.kookr-stt-build.hash';
const DEFAULT_REUSE_ATTEMPTS = 3;
const DEFAULT_REUSE_BACKOFF_MS = 150;
const WHISPER_CONTAINER_NAME = 'kookr-stt-whisper';
/** Expected bundled backend identity on the Node STT health endpoint. */
const EXPECTED_BUNDLED_BACKEND = 'whisper';

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
  /** Multi-try reuse attempts before any compose mutation (default: 3) */
  reuseAttempts?: number;
  /** Backoff between reuse attempts (ms, default: 150) */
  reuseBackoffMs?: number;
  /**
   * Optional inspect of the running Whisper container's model env.
   * Return the model string, null when inspect is unavailable, or throw.
   * Injected for tests so healthy reuse can prove zero docker invocations.
   */
  inspectWhisperModel?: () => Promise<string | null>;
}

export interface STTManager {
  /** The STT WebSocket URL to pass to the frontend (e.g. ws://localhost:8003) */
  url: string;
  /** Stop the Docker containers (compose down) — failed-start / operator reclaim */
  stop(): Promise<void>;
}

export interface STTComposeIdentity {
  composeFlags: string[];
  env: NodeJS.ProcessEnv;
  sttDir: string;
  resolvedDevice: ResolvedSTTDevice;
  model: string;
  port: number;
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
    reuseAttempts = DEFAULT_REUSE_ATTEMPTS,
    reuseBackoffMs = DEFAULT_REUSE_BACKOFF_MS,
    inspectWhisperModel = () => inspectWhisperModelFromDocker(),
  } = config;

  const identity = await resolveSTTComposeIdentity({
    sttDir,
    port,
    whisperModel,
    device,
  });
  const { composeFlags, env, resolvedDevice, model } = identity;

  // --- Warm reuse path: multi-try health before any compose mutation ---
  const reuseResult = await tryReuseSTT({
    port,
    model,
    attempts: reuseAttempts,
    backoffMs: reuseBackoffMs,
    inspectWhisperModel,
  });
  if (reuseResult.ok) {
    console.log(
      `[stt] Reusing healthy STT service at port ${port}` +
        ` (backend: ${reuseResult.backend ?? 'unknown'}, status: ${reuseResult.status}` +
        `${reuseResult.inspectedModel ? `, inspect model: ${reuseResult.inspectedModel}` : ''}` +
        `${reuseResult.inspectSkipped ? '; health-only reuse (Whisper model not verified via inspect)' : ''})`,
    );
    return {
      url: `ws://localhost:${port}`,
      stop: () => stopSTT(composeFlags, env),
    };
  }
  console.log(`[stt] Cannot reuse existing STT (reason=${reuseResult.reason}); starting containers...`);

  console.log(
    `[stt] Starting STT containers (device: ${resolvedDevice}${
      device === 'auto' ? ' [auto]' : ''
    }, model: ${model}, port: ${port})...`,
  );

  const buildPlan = await planSTTImageBuild(sttDir);
  if (buildPlan.build) {
    console.log(`[stt] Building STT image (${buildPlan.reason})...`);
  } else {
    console.log('[stt] Reusing existing STT image; build inputs are unchanged');
  }

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
      timeout: 120_000,
    });
    if (buildPlan.build) {
      await writeSTTBuildStamp(sttDir, buildPlan.inputHash);
    }
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
        const health = (await res.json()) as { backend?: string };
        console.log(`[stt] STT service is ready (backend: ${health.backend ?? 'unknown'}, reason=started)`);

        return {
          url: `ws://localhost:${port}`,
          stop: () => stopSTT(composeFlags, env),
        };
      }
    } catch {
      // Not ready yet
    }
    await sleep(2000);
  }

  // Timeout — tear down and throw (R13 failed-start cleanup)
  await stopSTT(composeFlags, env).catch(() => {});
  throw new Error(`[stt] STT service did not become healthy within ${startupTimeoutMs / 1000}s`);
}

/**
 * Resolve compose project identity (flags + env) the same way start does.
 * Used by startSTT and by the shared stop-sidecars entrypoint (R14).
 */
export async function resolveSTTComposeIdentity(opts: {
  sttDir: string;
  port?: number;
  whisperModel?: string;
  device?: STTDevice;
}): Promise<STTComposeIdentity> {
  const {
    sttDir,
    port = 8003,
    whisperModel,
    device = parseSTTDevice(),
  } = opts;

  const resolvedDevice = await resolveDevice(device);
  const defaults = deviceDefaults(resolvedDevice);
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

  return { composeFlags, env, sttDir, resolvedDevice, model, port };
}

/** Operator/failed-start teardown with the same compose flags as start. */
export async function stopBundledSTT(opts: {
  sttDir: string;
  port?: number;
  whisperModel?: string;
  device?: STTDevice;
}): Promise<void> {
  const identity = await resolveSTTComposeIdentity(opts);
  await stopSTT(identity.composeFlags, identity.env);
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

type ReuseOk = {
  ok: true;
  status: string;
  backend?: string;
  inspectedModel?: string;
  inspectSkipped: boolean;
};
type ReuseFail = { ok: false; reason: string };

async function tryReuseSTT(opts: {
  port: number;
  model: string;
  attempts: number;
  backoffMs: number;
  inspectWhisperModel: () => Promise<string | null>;
}): Promise<ReuseOk | ReuseFail> {
  let lastReason = 'missing';
  for (let i = 0; i < opts.attempts; i++) {
    const result = await evaluateSTTReuseOnce(opts.port, opts.model, opts.inspectWhisperModel);
    if (result.ok) return result;
    lastReason = result.reason;
    if (i + 1 < opts.attempts) {
      await sleep(opts.backoffMs);
    }
  }
  return { ok: false, reason: lastReason };
}

/**
 * R11 reuse predicate — exported for unit tests.
 * Does not require model_loaded or model_name === WHISPER_MODEL.
 */
export async function evaluateSTTReuseOnce(
  port: number,
  expectedModel: string,
  inspectWhisperModel: () => Promise<string | null> = () => inspectWhisperModelFromDocker(),
): Promise<ReuseOk | ReuseFail> {
  const healthUrl = `http://localhost:${port}/health`;
  let res: Response;
  try {
    res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
  } catch {
    return { ok: false, reason: 'flaky' };
  }
  if (!res.ok) {
    return { ok: false, reason: 'flaky' };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'unparseable' };
  }

  const health = body as { status?: unknown; backend?: unknown };
  const status = typeof health.status === 'string' ? health.status : '';
  if (status !== 'ok') {
    return { ok: false, reason: 'identity-mismatch' };
  }

  const backend = typeof health.backend === 'string' ? health.backend : undefined;
  if (backend !== undefined && backend !== EXPECTED_BUNDLED_BACKEND) {
    return { ok: false, reason: 'identity-mismatch' };
  }

  // Optional Whisper model identity via docker inspect (not health.model_name).
  let inspectedModel: string | undefined;
  let inspectSkipped = false;
  try {
    const inspected = await inspectWhisperModel();
    if (inspected === null) {
      inspectSkipped = true;
    } else if (inspected !== expectedModel) {
      return { ok: false, reason: 'identity-mismatch' };
    } else {
      inspectedModel = inspected;
    }
  } catch {
    // Inspect unavailable → docs-only for model config changes; health-only reuse.
    inspectSkipped = true;
  }

  return {
    ok: true,
    status,
    backend,
    inspectedModel,
    inspectSkipped,
  };
}

/**
 * Read WHISPER__MODEL (or WHISPER_MODEL) from the running whisper container.
 * Returns null when the container is missing / inspect fails softly.
 */
export async function inspectWhisperModelFromDocker(
  containerName = WHISPER_CONTAINER_NAME,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', containerName],
      { timeout: 5_000 },
    );
    const lines = stdout.split('\n');
    for (const line of lines) {
      // Compose maps WHISPER_MODEL → container env WHISPER__MODEL
      if (line.startsWith('WHISPER__MODEL=')) {
        return line.slice('WHISPER__MODEL='.length).trim() || null;
      }
      if (line.startsWith('WHISPER_MODEL=')) {
        return line.slice('WHISPER_MODEL='.length).trim() || null;
      }
    }
    return null;
  } catch {
    return null;
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

// --- TTS-style build stamp (R3) ---

interface STTImageBuildPlan {
  build: boolean;
  inputHash: string;
  reason: string;
}

async function planSTTImageBuild(sttDir: string): Promise<STTImageBuildPlan> {
  const inputHash = await hashSTTBuildInputs(sttDir);
  const stampPath = join(sttDir, STT_BUILD_STAMP_FILE);
  let previousHash = '';

  try {
    previousHash = (await readFile(stampPath, 'utf-8')).trim();
  } catch {
    return { build: true, inputHash, reason: 'no prior build stamp' };
  }

  if (previousHash !== inputHash) {
    return { build: true, inputHash, reason: 'STT build inputs changed' };
  }

  return { build: false, inputHash, reason: 'STT build inputs unchanged' };
}

async function hashSTTBuildInputs(sttDir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const relativePath of [
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.gpu.yml',
    'package.json',
    'src',
  ]) {
    await addPathToHash(hash, sttDir, relativePath);
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
        // Skip unit/integration tests and node_modules noise in the stamp.
        if (entry === 'node_modules' || entry.endsWith('.test.js')) continue;
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

async function writeSTTBuildStamp(sttDir: string, inputHash: string): Promise<void> {
  try {
    await mkdir(sttDir, { recursive: true });
    await writeFile(join(sttDir, STT_BUILD_STAMP_FILE), `${inputHash}\n`, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[stt] Warning: failed to write STT build stamp: ${msg}`);
  }
}
