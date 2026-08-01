// Load .env file if present (for ANTHROPIC_API_KEY and other config).
// Must run before any module reads process.env.
try {
  process.loadEnvFile();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[env] Warning: failed to load .env from ${process.cwd()}: ${msg}`);
}

import { accessSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { LocalDtachBackend } from '../adapters/local-dtach-backend.js';
import { createKookrServer } from './index.js';
import { resolveApiAuth, type ApiAuthConfig } from './auth.js';
import {
  resolveSessionTransport,
  describeSessionTransport,
  generateCsrfSecret,
  type SessionAuthConfig,
} from './auth-session.js';
import { runStartupConfigPreflightOrExit } from './config-preflight.js';
import { resolveListenPort } from './resolve-listen-port.js';
import { parseSTTDevice, startSTT, type STTManager } from './stt-manager.js';
import { DEFAULT_TTS_VOICE, parseTTSDeviceFromEnv, startTTS, type TTSManager } from './tts-manager.js';
import { createShutdownHandler } from './shutdown.js';
import { readRingFleetBudgetBytesFromEnv } from './config.js';

const HOST = process.env.KOOKR_HOST ?? '127.0.0.1';
const STT_ENABLED = process.env.KOOKR_STT === 'true';
const STT_URL_OVERRIDE = process.env.KOOKR_STT_URL ?? '';
const STT_PORT = parseInt(process.env.KOOKR_STT_PORT ?? '8003', 10);
const STT_DEVICE = parseSTTDevice();
const WHISPER_MODEL = process.env.WHISPER_MODEL;
const TTS_ENABLED = process.env.KOOKR_TTS === 'true';
const TTS_URL_OVERRIDE = process.env.KOOKR_TTS_URL ?? '';
const TTS_PORT = parseInt(process.env.KOOKR_TTS_PORT ?? '8004', 10);
const TTS_VOICE = process.env.TTS_VOICE ?? DEFAULT_TTS_VOICE;
const TTS_DEVICE = parseTTSDeviceFromEnv();
const AGENT_BIN = process.env.KOOKR_AGENT_BIN || undefined;
const CODEX_BIN = process.env.KOOKR_CODEX_BIN || undefined;
const GROK_BIN = process.env.KOOKR_GROK_BIN || undefined;
const BYPASS_ALL_PERMISSIONS = process.env.KOOKR_BYPASS_ALL_PERMISSIONS === 'true';
const SPEAK_FINDING_ENABLED = process.env.KOOKR_SPEAK !== 'false';

/**
 * V8: Fail loud if the dtach binary is unreachable. Startup gets ONE
 * structured error + exit; no backend fallback, no warn-and-continue.
 * The failure-mode reviewer (round-1) flagged silent binary-missing as a
 * first-run abandonment risk. See rfc-v8-tmux-removal.md §Startup hard
 * requirement on the dtach binary.
 */
function resolveDtachBinaryOrExit(): string {
  const vendored = join(process.cwd(), 'vendor', 'dtach', 'dtach');
  try {
    accessSync(vendored);
    return vendored;
  } catch {
    // Fall through to PATH probe.
  }
  // Best-effort PATH probe via `which`-equivalent — accessSync against a
  // relative name fails, so we instead trust the child-process layer's
  // PATH resolution. Rely on a probe spawn to surface binary-missing
  // before first session.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process');
    execFileSync('dtach', ['-V'], { stdio: 'pipe', timeout: 2000 });
    return 'dtach';
  } catch {
    console.error(
      '[fatal] dtach binary not found. Expected vendored binary at vendor/dtach/dtach\n' +
        'or a system binary on $PATH. Run `pnpm build:dtach` to compile the\n' +
        'vendored copy, or install dtach via your package manager.',
    );
    process.exit(1);
  }
}

/**
 * Issue #708: resolve the API-token auth posture from the bind host + env,
 * print the operator-facing summary, and fail-closed (exit 1) when a
 * non-loopback bind is missing a usable token. Returns the `ApiAuthConfig` to
 * thread into the server.
 */
function resolveApiAuthOrExit(host: string): ApiAuthConfig {
  const resolution = resolveApiAuth({ host, env: process.env });
  switch (resolution.kind) {
    case 'loopback':
      return resolution.config;
    case 'token-provided':
      if (resolution.weakTokenAllowed) {
        console.warn(
          `[auth] WARNING: Non-loopback bind (KOOKR_HOST=${host}) is accepting a weak KOOKR_API_TOKEN because ` +
            'KOOKR_ALLOW_WEAK_API_TOKEN=true is set.',
        );
      }
      console.log(`[auth] Non-loopback bind (KOOKR_HOST=${host}); API token auth ENABLED (KOOKR_API_TOKEN).`);
      return resolution.config;
    case 'token-generated':
      console.log(
        `[auth] Non-loopback bind (KOOKR_HOST=${host}); no KOOKR_API_TOKEN set — auto-generated one for this run.\n` +
          `[auth] API token: ${resolution.token}\n` +
          '[auth] Send it as `Authorization: Bearer <token>` (CLI). Browsers authenticate via the session cookie.\n' +
          '[auth] Set KOOKR_API_TOKEN to pin a stable token across restarts.',
      );
      return resolution.config;
    case 'fail-closed':
      console.error(`[fatal] ${resolution.reason}`);
      process.exit(1);
  }
}

async function main(): Promise<void> {
  await runStartupConfigPreflightOrExit(process.env);

  // Resolve KOOKR_PORT: validate, probe for EADDRINUSE with actionable
  // guidance, or scan for a free port when KOOKR_PORT=auto. See
  // src/server/resolve-listen-port.ts.
  const portResolution = await resolveListenPort(process.env.KOOKR_PORT, HOST);
  const PORT = portResolution.port;
  // Resolve API-token auth before binding. Exits (fail-closed) when a
  // non-loopback bind lacks both a token and the explicit opt-out.
  const apiAuth = resolveApiAuthOrExit(HOST);
  // #804: browser cookie-exchange + CSRF posture. Resolve the transport posture
  // from the bind host + env and log it (the `https-required` line is the
  // fail-closed notice that plain-HTTP browser sessions are refused). The session
  // feature is only meaningful on a non-loopback bind where a credential exists.
  const sessionTransport = resolveSessionTransport({ host: HOST, env: process.env });
  console.log(describeSessionTransport(sessionTransport, HOST));
  const sessionAuth: SessionAuthConfig | undefined =
    sessionTransport.mode === 'loopback'
      ? undefined
      : { csrfSecret: generateCsrfSecret(), transport: sessionTransport };
  const KOOKR_DIR = PORT === 4800 ? join(homedir(), '.kookr') : join(homedir(), `.kookr-${PORT}`);
  // Per-instance namespace so kookr-prod (4800) and kookr-dev (4801) keep
  // their dtach sockets + manifest separate under /tmp/kookr-dtach/<uid>/.
  const INSTANCE_ID = `port-${PORT}`;

  if (portResolution.source === 'auto') {
    console.log(`[port] KOOKR_PORT=auto resolved to ${PORT} (open http://${HOST}:${PORT})`);
  }

  // Bundled STT containers (unless user provides their own URL)
  let sttManager: STTManager | null = null;
  let sttUrl: string | undefined;

  if (STT_URL_OVERRIDE) {
    sttUrl = STT_URL_OVERRIDE;
  } else if (STT_ENABLED) {
    const sttDir = join(process.cwd(), 'stt');
    try {
      sttManager = await startSTT({
        sttDir,
        port: STT_PORT,
        whisperModel: WHISPER_MODEL,
        device: STT_DEVICE,
      });
      sttUrl = sttManager.url;
    } catch (err) {
      console.warn(`[stt] ${err instanceof Error ? err.message : String(err)}`);
      console.warn('[stt] Continuing without speech-to-text');
    }
  }

  // Bundled TTS container
  let ttsManager: TTSManager | null = null;
  let ttsUrl: string | undefined;

  if (TTS_URL_OVERRIDE) {
    ttsUrl = TTS_URL_OVERRIDE;
  } else if (TTS_ENABLED) {
    const ttsDir = join(process.cwd(), 'tts');
    try {
      ttsManager = await startTTS({
        ttsDir,
        port: TTS_PORT,
        voice: TTS_VOICE,
        device: TTS_DEVICE,
      });
      ttsUrl = ttsManager.url;
    } catch (err) {
      console.warn(`[tts] ${err instanceof Error ? err.message : String(err)}`);
      console.warn('[tts] Continuing without text-to-speech');
    }
  }

  if (ttsUrl) {
    console.log(`[tts] Text-to-speech enabled (${ttsUrl})`);
  } else {
    console.log('[tts] Text-to-speech disabled (set KOOKR_TTS=true or KOOKR_TTS_URL to enable)');
  }

  const dtachBinary = resolveDtachBinaryOrExit();
  // Fleet ring budget (issue #1779): caps sum of live ring capacities and
  // shrinks least-recently-active rings under pressure. `0` disables.
  const ringFleetBudgetBytes = readRingFleetBudgetBytesFromEnv();
  const terminalBackend = new LocalDtachBackend({
    instanceId: INSTANCE_ID,
    dtachBinary,
    ringFleetBudgetBytes,
  });
  console.log(
    `[terminal] backend=dtach instanceId=${INSTANCE_ID} dtach=${dtachBinary}`
    + ` ringFleetBudgetBytes=${ringFleetBudgetBytes}`,
  );

  const lifecycleAc = new AbortController();

  const server = await createKookrServer({
    port: PORT,
    host: HOST,
    kookrDir: KOOKR_DIR,
    tasksFile: join(KOOKR_DIR, 'tasks.json'),
    hooksDir: join(KOOKR_DIR, 'hooks'),
    settingsDir: join(KOOKR_DIR, 'settings'),
    serverCwd: process.cwd(),
    frontendDir: join(process.cwd(), 'dist', 'frontend'),
    saveIntervalMs: 5000,
    livenessIntervalMs: 5000,
    terminalBackend,
    terminalInstanceDir: terminalBackend.getInstanceDir(),
    sttUrl,
    ttsUrl,
    ttsVoice: TTS_VOICE,
    speakFindingEnabled: SPEAK_FINDING_ENABLED,
    agentBin: AGENT_BIN,
    codexBin: CODEX_BIN,
    grokBin: GROK_BIN,
    bypassAllPermissions: BYPASS_ALL_PERMISSIONS,
    lifecycleSignal: lifecycleAc.signal,
    apiAuth,
    sessionAuth,
  });

  // Issue #1320: a single re-entrancy-guarded handler backs both signals so a
  // second Ctrl-C during a slow graceful shutdown force-exits instead of
  // re-running the container stops concurrently.
  const shutdown = createShutdownHandler({ lifecycleAc, sttManager, ttsManager, server });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Safety net — keep the server alive when a single background task misbehaves.
  //
  // Background: pre-V8, a SessionGoneError thrown from a terminal-bridge ws
  // 'message' listener bubbled through ws's internal EventEmitter and became
  // an uncaughtException that exited the process — a single dead terminal
  // took every other active session down with it. V8 moved the write/resize
  // path to fire-and-forget promises (`void backend.write(...)`), which shifts
  // the same failure mode to unhandledRejection; in Node 15+ that still
  // terminates the process by default.
  //
  // SessionBridge now contains its own rejections, but the last-ditch net
  // matters: future code paths may forget to `.catch()` once, and we would
  // rather log a loud error than kill every live agent session. We do NOT
  // re-raise or exit — operators see the log and can decide to restart.
  process.on('uncaughtException', (err, origin) => {
    console.error(`[fatal] uncaughtException (${origin}):`, err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandledRejection:', reason);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
