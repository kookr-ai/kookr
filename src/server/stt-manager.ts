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
import { ensureCorpusDirectory, getCorpusConfig } from '../../stt/src/transcription-corpus.cjs';

const execFileAsync = promisify(execFile);
export const DEFAULT_STT_STARTUP_TIMEOUT_MS = 600_000;
const STT_BUILD_STAMP_FILE = '.kookr-stt-build.hash';
const DEFAULT_REUSE_ATTEMPTS = 3;
const DEFAULT_REUSE_BACKOFF_MS = 150;
const WHISPER_CONTAINER_NAME = 'kookr-stt-whisper';
export type STTBackend = 'whisper' | 'qwen';

export type STTDevice = 'auto' | 'cpu' | 'gpu';
export type ResolvedSTTDevice = 'cpu' | 'gpu';

export interface STTManagerConfig {
  /** Absolute path to the stt/ directory containing docker-compose.yml */
  sttDir: string;
  /** Port to expose the STT service on the host (default: 8003) */
  port?: number;
  /**
   * Whisper-only model override. GPU defaults to Qwen; explicit Whisper
   * uses `base` on CPU or `large-v3` on GPU when this is omitted.
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
  /** Bundled HTTP endpoint identity, also used by Telegram. */
  transcription?: { url: string; model: string };
  /** Stop the Docker containers (compose down) — failed-start / operator reclaim */
  stop(): Promise<void>;
}

export interface STTComposeIdentity {
  backend: STTBackend;
  configId?: string;
  corpus: ReturnType<typeof getCorpusConfig>;
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

  // Corpus storage is optional. A bad path or full disk must not take speech
  // recognition down, and an unsafe destination must never be mounted.
  let disableCorpus = false;
  try {
    const requestedCorpus = getCorpusConfig(process.env);
    if (requestedCorpus.enabled) {
      if (!process.getuid || !process.getgid) throw new Error('corpus_host_identity_unavailable');
      await ensureCorpusDirectory(requestedCorpus.directory);
    }
  } catch {
    disableCorpus = true;
    console.warn('[stt-corpus] corpus_capture_disabled');
  }

  const identity = await resolveSTTComposeIdentity({
    sttDir,
    port,
    whisperModel,
    device,
    disableCorpus,
  });
  const { composeFlags, env, resolvedDevice, model, backend, configId, corpus } = identity;

  // --- Warm reuse path: multi-try health before any compose mutation ---
  const reuseResult = await tryReuseSTT({
    port,
    model,
    attempts: reuseAttempts,
    backoffMs: reuseBackoffMs,
    inspectWhisperModel,
    backend,
    configId,
    corpus,
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
      transcription: { url: `http://127.0.0.1:${env.KOOKR_STT_WHISPER_PORT || 8010}`, model },
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
      // A first Qwen image build includes CUDA wheels; use the operator's
      // startup budget rather than killing it after two minutes.
      timeout: backend === 'qwen' ? startupTimeoutMs : 120_000,
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
      const health = await evaluateSTTReuseOnce(port, model, inspectWhisperModel, backend, configId, corpus);
      if (health.ok) {
        console.log(`[stt] STT service is ready (backend: ${health.backend ?? 'unknown'}, model: ${model}, reason=started)`);

        return {
          url: `ws://localhost:${port}`,
          transcription: { url: `http://127.0.0.1:${env.KOOKR_STT_WHISPER_PORT || 8010}`, model },
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
  /** Internal fallback when optional corpus configuration or storage is unavailable. */
  disableCorpus?: boolean;
}): Promise<STTComposeIdentity> {
  const {
    sttDir,
    port = 8003,
    whisperModel,
    device = parseSTTDevice(),
  } = opts;

  const resolvedDevice = await resolveDevice(device);
  const requestedBackend = process.env.KOOKR_STT_BACKEND?.trim() || 'auto';
  if (!['auto', 'whisper', 'qwen'].includes(requestedBackend)) {
    throw new Error('KOOKR_STT_BACKEND must be auto, whisper, or qwen');
  }
  const backend: STTBackend = requestedBackend === 'auto'
    ? (resolvedDevice === 'gpu' ? 'qwen' : 'whisper')
    : requestedBackend as STTBackend;
  if (backend === 'qwen' && resolvedDevice !== 'gpu') {
    throw new Error('Qwen speech recognition requires an NVIDIA GPU; use KOOKR_STT_DEVICE=gpu or select whisper');
  }
  const defaults = deviceDefaults(resolvedDevice);
  const selectedWhisperModel = whisperModel || process.env.WHISPER_MODEL || defaults.model;
  const model = backend === 'qwen'
    ? (process.env.QWEN_ASR_MODEL?.trim() || 'Qwen/Qwen3-ASR-0.6B')
    : selectedWhisperModel;
  if (backend === 'qwen' && !['Qwen/Qwen3-ASR-0.6B', 'Qwen/Qwen3-ASR-1.7B'].includes(model)) {
    throw new Error('QWEN_ASR_MODEL must be Qwen/Qwen3-ASR-0.6B or Qwen/Qwen3-ASR-1.7B');
  }
  if (backend === 'qwen' && (process.env.STT_VOCABULARY?.length ?? 0) > 2000) {
    throw new Error('STT_VOCABULARY must contain at most 2000 characters');
  }
  // Distinguish an absent glossary override (service default) from an empty
  // one (disabled), so warm restarts apply configuration changes too.
  const configId = backend === 'qwen' ? createHash('sha256').update(JSON.stringify({
    model, vocabulary: process.env.STT_VOCABULARY ?? null,
  })).digest('hex') : undefined;
  const image = process.env.WHISPER_IMAGE ?? defaults.image;
  const whisperDevice = process.env.WHISPER_DEVICE ?? defaults.device;
  const computeType = process.env.WHISPER_COMPUTE_TYPE ?? defaults.computeType;

  const corpus = getCorpusConfig(opts.disableCorpus
    ? { ...process.env, KOOKR_STT_CORPUS: 'false' }
    : process.env);
  const corpusUid = process.getuid?.();
  const corpusGid = process.getgid?.();
  if (corpus.enabled && (corpusUid === undefined || corpusGid === undefined)) {
    throw new Error('Transcription corpus recording requires host user and group IDs');
  }
  const composePath = join(sttDir, 'docker-compose.yml');
  const gpuOverlayPath = join(sttDir, 'docker-compose.gpu.yml');
  const composeFlags =
    resolvedDevice === 'gpu' ? ['-f', composePath, '-f', gpuOverlayPath] : ['-f', composePath];
  if (backend === 'qwen') composeFlags.push('-f', join(sttDir, 'docker-compose.qwen.yml'));
  if (corpus.enabled) composeFlags.push('-f', join(sttDir, 'docker-compose.corpus.yml'));

  const env = {
    ...process.env,
    ...(opts.disableCorpus ? { KOOKR_STT_CORPUS: 'false' } : {}),
    KOOKR_STT_PORT: String(port),
    WHISPER_IMAGE: image,
    WHISPER_MODEL: selectedWhisperModel,
    ...(backend === 'qwen' ? { QWEN_ASR_MODEL: model, STT_CONFIG_ID: configId } : {}),
    WHISPER_DEVICE: whisperDevice,
    WHISPER_COMPUTE_TYPE: computeType,
    ...(corpus.enabled ? {
      KOOKR_STT_CORPUS_HOST_DIR: corpus.directory,
      KOOKR_STT_CORPUS_UID: String(corpusUid),
      KOOKR_STT_CORPUS_GID: String(corpusGid),
      STT_CORPUS_CONFIG_ID: corpus.configId,
    } : {}),
  };

  return { composeFlags, env, sttDir, resolvedDevice, model, port, backend, configId, corpus };
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
type CorpusIdentity = Pick<ReturnType<typeof getCorpusConfig>, 'enabled' | 'configId'>;

async function tryReuseSTT(opts: {
  backend: STTBackend;
  configId?: string;
  corpus: CorpusIdentity;
  port: number;
  model: string;
  attempts: number;
  backoffMs: number;
  inspectWhisperModel: () => Promise<string | null>;
}): Promise<ReuseOk | ReuseFail> {
  let lastReason = 'missing';
  for (let i = 0; i < opts.attempts; i++) {
    const result = await evaluateSTTReuseOnce(opts.port, opts.model, opts.inspectWhisperModel, opts.backend, opts.configId, opts.corpus);
    if (result.ok) return result;
    lastReason = result.reason;
    if (i + 1 < opts.attempts) {
      await sleep(opts.backoffMs);
    }
  }
  return { ok: false, reason: lastReason };
}

/**
 * Check whether the running service matches the requested backend.
 * Whisper uses status/backend and optional Docker model inspection because
 * its health endpoint can report unused Parakeet metadata. Qwen requires
 * the selected model loaded on CUDA and the expected configuration ID.
 */
export async function evaluateSTTReuseOnce(
  port: number,
  expectedModel: string,
  inspectWhisperModel: () => Promise<string | null> = () => inspectWhisperModelFromDocker(),
  expectedBackend: STTBackend = 'whisper',
  expectedConfigId?: string,
  expectedCorpus: CorpusIdentity = { enabled: false, configId: '' },
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

  const health = body as {
    status?: unknown; backend?: unknown; model_name?: unknown;
    model_loaded?: unknown; device?: unknown; config_id?: unknown; corpus?: unknown;
  };
  const status = typeof health.status === 'string' ? health.status : '';
  if (status !== 'ok') {
    return { ok: false, reason: 'identity-mismatch' };
  }

  const backend = typeof health.backend === 'string' ? health.backend : undefined;
  if (backend !== undefined && backend !== expectedBackend) {
    return { ok: false, reason: 'identity-mismatch' };
  }

  // Old services omit corpus health and are reusable only when capture is off.
  // Check this for both backends: enabling, disabling, or relocating capture
  // must recreate the Node service even when its recognition model is unchanged.
  if (!matchesCorpusIdentity(health.corpus, expectedCorpus)) {
    return { ok: false, reason: 'corpus-mismatch' };
  }

  if (expectedBackend === 'qwen') {
    if (backend !== 'qwen' || health.model_name !== expectedModel || health.model_loaded !== true
      || health.device !== 'cuda' || (expectedConfigId !== undefined && health.config_id !== expectedConfigId)) {
      return { ok: false, reason: 'identity-mismatch' };
    }
    return { ok: true, status, backend, inspectedModel: expectedModel, inspectSkipped: false };
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

function matchesCorpusIdentity(value: unknown, expected: CorpusIdentity): boolean {
  if (value === undefined) return !expected.enabled;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = value as { enabled?: unknown; configId?: unknown };
  return actual.enabled === expected.enabled
    && (!expected.enabled || actual.configId === expected.configId);
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
    'docker-compose.qwen.yml',
    'docker-compose.corpus.yml',
    'qwen',
    'package.json',
    'package-lock.json',
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
        if (entry === 'node_modules' || entry === '__pycache__' || entry.endsWith('.test.js') || entry.startsWith('test_')) continue;
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
