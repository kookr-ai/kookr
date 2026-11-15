/**
 * Decides whether Lucy live can be switched on, from the environment.
 *
 * It needs three things: the speech recogniser (`KOOKR_LUCY_EARS_URL`), the helper model
 * (a Baseten key) and the speech service (`ttsUrl`). When any is missing the dashboard
 * is told which one, in words the operator can act on.
 */

import { readBasetenStreamConfig, type BasetenStreamConfig } from '../../adapters/llm/baseten-stream.js';
import type { LucyLiveStatus } from '../../shared/contracts/lucy-live.js';

export interface LucyLiveConfig {
  earsUrl: string;
  brain: BasetenStreamConfig;
  ttsUrl: string;
}

export type LucyLiveConfigResult =
  | { ok: true; config: LucyLiveConfig }
  | { ok: false; reason: string };

export function resolveLucyLiveConfig(
  env: Record<string, string | undefined>,
  ttsUrl: string | undefined,
): LucyLiveConfigResult {
  const missing: string[] = [];
  const earsUrl = env.KOOKR_LUCY_EARS_URL?.trim();
  if (!earsUrl) missing.push('the speech recogniser (set KOOKR_LUCY_EARS=true to let Kookr run it, or KOOKR_LUCY_EARS_URL for one you run; see lucy-ears/docker-compose.yml)');
  const brain = readBasetenStreamConfig(env);
  if (!brain) missing.push('the helper model (set KOOKR_BASETEN_API_KEY or BASETEN_API_KEY)');
  if (!ttsUrl) missing.push('the speech service (enable KOOKR_TTS or set KOOKR_TTS_URL)');
  if (!earsUrl || !brain || !ttsUrl) return { ok: false, reason: `Lucy live needs ${missing.join('; ')}.` };
  return { ok: true, config: { earsUrl, brain, ttsUrl } };
}

/**
 * The start-up warning for a recogniser that is not on this machine, or undefined when it is.
 * The recogniser hears the microphone, so a non-loopback `KOOKR_LUCY_EARS_URL` sends the
 * operator's voice over the network. That can be intended (a GPU box on the LAN), so this only
 * warns; Lucy live still switches on.
 */
export function earsUrlWarning(earsUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(earsUrl).hostname.toLowerCase();
  } catch {
    return 'KOOKR_LUCY_EARS_URL could not be read as a URL, so Kookr cannot check that your voice stays on this machine.';
  }
  if (isLoopbackHost(host)) return undefined;
  return `KOOKR_LUCY_EARS_URL points at ${host}, which is not this machine: what you say to Lucy live is sent there over the network. Use a loopback address (127.0.0.1) to keep the audio on this machine.`;
}

function isLoopbackHost(host: string): boolean {
  // WHATWG URL keeps the brackets around an IPv6 host and normalises IPv4 forms (127.1 -> 127.0.0.1).
  return host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** `bargeInConfirmation` says whether the server can confirm interruptions with Silero (see the contract). */
export function lucyLiveStatusOf(result: LucyLiveConfigResult, bargeInConfirmation?: 'silero' | 'off'): LucyLiveStatus {
  if (!result.ok) return { available: false, reason: result.reason };
  return bargeInConfirmation ? { available: true, bargeInConfirmation } : { available: true };
}
