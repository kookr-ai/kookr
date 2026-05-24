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
import { resolveListenPort } from './resolve-listen-port.js';
import { parseSTTDevice, startSTT, type STTManager } from './stt-manager.js';
import { parseTTSDevice, startTTS, type TTSManager } from './tts-manager.js';

const HOST = process.env.KOOKR_HOST ?? '127.0.0.1';
const STT_ENABLED = process.env.KOOKR_STT === 'true';
const STT_URL_OVERRIDE = process.env.KOOKR_STT_URL ?? '';
const STT_PORT = parseInt(process.env.KOOKR_STT_PORT ?? '8003', 10);
const STT_DEVICE = parseSTTDevice();
const WHISPER_MODEL = process.env.WHISPER_MODEL;
const TTS_ENABLED = process.env.KOOKR_TTS === 'true';
const TTS_URL_OVERRIDE = process.env.KOOKR_TTS_URL ?? '';
const TTS_PORT = parseInt(process.env.KOOKR_TTS_PORT ?? '8004', 10);
const TTS_VOICE = process.env.TTS_VOICE ?? '/app/voices/matilda.mp3';
const TTS_DEVICE = parseTTSDevice();
const AGENT_BIN = process.env.KOOKR_AGENT_BIN || undefined;
const CODEX_BIN = process.env.KOOKR_CODEX_BIN || undefined;
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

async function main(): Promise<void> {
  // Resolve KOOKR_PORT: validate, probe for EADDRINUSE with actionable
  // guidance, or scan for a free port when KOOKR_PORT=auto. See
  // src/server/resolve-listen-port.ts.
  const portResolution = await resolveListenPort(process.env.KOOKR_PORT, HOST);
  const PORT = portResolution.port;
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

  // V8: the legacy `KOOKR_BACKEND=tmux` escape hatch is gone. Fail loud
  // so a stale .env entry does not boot a tmux-era Kookr against a
  // dtach-only codebase. See rfc-v8-tmux-removal.md §Risks #5.
  if (process.env.KOOKR_BACKEND && process.env.KOOKR_BACKEND !== 'dtach') {
    console.error(
      `[fatal] KOOKR_BACKEND=${process.env.KOOKR_BACKEND} is not supported. ` +
        'V8 removed the tmux backend. Remove the env var or set KOOKR_BACKEND=dtach.',
    );
    process.exit(1);
  }

  const dtachBinary = resolveDtachBinaryOrExit();
  const terminalBackend = new LocalDtachBackend({ instanceId: INSTANCE_ID, dtachBinary });
  console.log(`[terminal] backend=dtach instanceId=${INSTANCE_ID} dtach=${dtachBinary}`);

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
    sttUrl,
    ttsUrl,
    ttsVoice: TTS_VOICE,
    speakFindingEnabled: SPEAK_FINDING_ENABLED,
    agentBin: AGENT_BIN,
    codexBin: CODEX_BIN,
    bypassAllPermissions: BYPASS_ALL_PERMISSIONS,
    lifecycleSignal: lifecycleAc.signal,
  });

  async function shutdown(signal: string): Promise<void> {
    console.log(`\n${signal} received. Shutting down...`);
    // Signal lifecycle abort BEFORE stopping STT/TTS containers so any
    // in-flight startup-warmup work (Telegram whisper) cancels cleanly. The
    // catch path inside warmupWhisper turns this into a distinct info-level
    // log instead of a "warmup FAILED — first user message will pay the
    // cold-start cost" warning that misleads operators during a clean shutdown.
    // See issue #188.
    lifecycleAc.abort();
    // Stop Docker containers BEFORE closing the HTTP server so that the port
    // stays occupied until cleanup is complete. The restart scripts poll the
    // port to decide when to launch the new server — releasing it early caused
    // a race where the old process tore down containers the new process started.
    if (sttManager) {
      await sttManager.stop();
    }
    if (ttsManager) {
      await ttsManager.stop();
    }
    await server.close();
    console.log('Server closed.');
    process.exit(0);
  }

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
