/**
 * Shared STT/TTS compose teardown for `pnpm prod:stop --with-sidecars` (R14).
 *
 * Uses the same compose project identity / GPU overlay flags as
 * stt-manager.ts and tts-manager.ts so operator reclaim tears down the
 * containers start created. Does not clobber foreign stacks when only
 * external speech URLs are configured.
 *
 * Usage:
 *   node --import tsx scripts/stop-sidecars.ts
 *   (cwd should be the Kookr app dir, e.g. kookr-prod)
 *
 * Env (same as start.ts / managers):
 *   KOOKR_STT, KOOKR_STT_URL, KOOKR_STT_PORT, KOOKR_STT_DEVICE, WHISPER_MODEL
 *   KOOKR_TTS, KOOKR_TTS_URL, KOOKR_TTS_PORT, KOOKR_TTS_DEVICE, KOOKR_TTS_VOICE
 *   KOOKR_LUCY_EARS, KOOKR_LUCY_EARS_URL, KOOKR_LUCY_EARS_PORT
 */

import { join } from 'node:path';
import { stopBundledSTT } from '../src/server/stt-manager.js';
import { ownsBundledLucyEars, parseLucyEarsPort, stopBundledLucyEars } from '../src/server/lucy-ears-manager.js';
import { DEFAULT_TTS_VOICE, stopBundledTTS } from '../src/server/tts-manager.js';

function isTruthy(raw: string | undefined): boolean {
  return raw === 'true' || raw === '1';
}

async function main(): Promise<void> {
  const appDir = process.cwd();
  const sttUrlOverride = process.env.KOOKR_STT_URL ?? '';
  const ttsUrlOverride = process.env.KOOKR_TTS_URL ?? '';
  const sttEnabled = isTruthy(process.env.KOOKR_STT);
  const ttsEnabled = isTruthy(process.env.KOOKR_TTS);

  // Bundled ownership: start.ts only owns containers when enabled AND no URL override.
  const ownsStt = sttEnabled && !sttUrlOverride;
  const ownsTts = ttsEnabled && !ttsUrlOverride;

  // Lucy's ears: bundled only when KOOKR_LUCY_EARS=true and no KOOKR_LUCY_EARS_URL (a hand-run
  // sidecar behind a URL is the operator's, so it is left alone).
  const ownsEars = ownsBundledLucyEars(process.env);

  if (!ownsStt && !ownsTts && !ownsEars) {
    if (sttUrlOverride || ttsUrlOverride) {
      console.warn(
        '[stop-sidecars] External speech URL(s) configured (KOOKR_STT_URL / KOOKR_TTS_URL); ' +
          'skipping compose down so foreign containers are not clobbered.',
      );
    } else if (!sttEnabled && !ttsEnabled) {
      console.warn(
        '[stop-sidecars] Bundled STT/TTS not enabled (KOOKR_STT / KOOKR_TTS); nothing to tear down.',
      );
    } else {
      console.warn('[stop-sidecars] No bundled speech stack owned by this instance; skipping.');
    }
    return;
  }

  if (ownsStt) {
    const sttDir = join(appDir, 'stt');
    const port = parseInt(process.env.KOOKR_STT_PORT ?? '8003', 10);
    console.log(`[stop-sidecars] Stopping bundled STT (dir=${sttDir}, port=${port})...`);
    await stopBundledSTT({
      sttDir,
      port,
      whisperModel: process.env.WHISPER_MODEL,
    });
  } else if (sttUrlOverride) {
    console.warn('[stop-sidecars] KOOKR_STT_URL set — skipping STT compose down.');
  }

  if (ownsTts) {
    const ttsDir = join(appDir, 'tts');
    const port = parseInt(process.env.KOOKR_TTS_PORT ?? '8004', 10);
    const voice = process.env.KOOKR_TTS_VOICE ?? DEFAULT_TTS_VOICE;
    console.log(`[stop-sidecars] Stopping bundled TTS (dir=${ttsDir}, port=${port})...`);
    await stopBundledTTS({
      ttsDir,
      port,
      voice,
    });
  } else if (ttsUrlOverride) {
    console.warn('[stop-sidecars] KOOKR_TTS_URL set — skipping TTS compose down.');
  }

  if (ownsEars) {
    const earsDir = join(appDir, 'lucy-ears');
    console.log(`[stop-sidecars] Stopping bundled Lucy's ears (dir=${earsDir})...`);
    await stopBundledLucyEars({ earsDir, port: parseLucyEarsPort() });
  }
}

main().catch((err) => {
  console.error('[stop-sidecars]', err instanceof Error ? err.message : err);
  process.exit(1);
});
