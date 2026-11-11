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
  if (!earsUrl) missing.push('the speech recogniser (set KOOKR_LUCY_EARS_URL, see lucy-ears/docker-compose.yml)');
  const brain = readBasetenStreamConfig(env);
  if (!brain) missing.push('the helper model (set KOOKR_BASETEN_API_KEY or BASETEN_API_KEY)');
  if (!ttsUrl) missing.push('the speech service (enable KOOKR_TTS or set KOOKR_TTS_URL)');
  if (!earsUrl || !brain || !ttsUrl) return { ok: false, reason: `Lucy live needs ${missing.join('; ')}.` };
  return { ok: true, config: { earsUrl, brain, ttsUrl } };
}

export function lucyLiveStatusOf(result: LucyLiveConfigResult): LucyLiveStatus {
  return result.ok ? { available: true } : { available: false, reason: result.reason };
}
