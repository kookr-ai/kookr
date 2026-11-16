/**
 * Decides, from the environment, whether Lucy's operator conversation is switched on
 * and which model answers (issue #3660).
 *
 * It is on by default (issue #3937) and needs an OpenRouter key, the same one the helper
 * model uses. With `KOOKR_LUCY_OPERATOR` unset it turns itself on when that key is
 * present and stays quietly off when it is not. Setting it to `true` asks for it
 * explicitly: a missing key then makes the route answer 503 and say why. `0`, `false`,
 * `off` or `no` switches it off. The model, the providers allowed to serve it and how
 * much it thinks before answering are each a setting; their defaults are the ones
 * chosen from the model trial recorded on issue #3632.
 */

import { isDefaultOnFlagEnabled, isKillSwitchValue } from '../../core/default-on-flag.js';
import {
  LUCY_OPERATOR_REASONING_LEVELS,
  type LucyOperatorReasoning,
  type OpenRouterChatStreamConfig,
} from '../../adapters/llm/openrouter-chat-stream.js';

export const DEFAULT_LUCY_OPERATOR_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
/**
 * Cohere only, at 8-bit precision: the operator's OpenRouter account guardrail allows
 * this model on Cohere and nothing else, so any other fallback could only fail with 404.
 */
export const DEFAULT_LUCY_OPERATOR_PROVIDERS: readonly string[] = ['cohere/fp8'];
export const DEFAULT_LUCY_OPERATOR_REASONING: LucyOperatorReasoning = 'medium';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** A provider tag as OpenRouter writes it: a slug, optionally followed by variants (`deepinfra/fp8/flex`). */
const PROVIDER_TAG_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

export type LucyOperatorConfigResult =
  /** Switched off, or left unset with no OpenRouter key: the route answers 404. */
  | { enabled: false }
  /** Switched on and usable. `warnings` lists settings that were ignored, for the start-up log. */
  | { enabled: true; ok: true; model: OpenRouterChatStreamConfig; /** On unless `KOOKR_LUCY_LAUNCH` is a kill switch: she may propose launching a task. */ launch: boolean; warnings: string[] }
  /** Switched on but something is missing: the route answers 503 with `reason`. */
  | { enabled: true; ok: false; reason: string; warnings: string[] };

export function resolveLucyOperatorConfig(env: Record<string, string | undefined>): LucyOperatorConfigResult {
  const rawSwitch = env.KOOKR_LUCY_OPERATOR;
  if (isKillSwitchValue(rawSwitch)) return { enabled: false };
  const askedFor = (rawSwitch ?? '').trim() !== '';
  const warnings: string[] = [];

  const rawReasoning = env.KOOKR_LUCY_OPERATOR_REASONING?.trim().toLowerCase();
  let reasoning = DEFAULT_LUCY_OPERATOR_REASONING;
  if (rawReasoning) {
    if ((LUCY_OPERATOR_REASONING_LEVELS as readonly string[]).includes(rawReasoning)) reasoning = rawReasoning as LucyOperatorReasoning;
    else warnings.push(`KOOKR_LUCY_OPERATOR_REASONING="${rawReasoning}" is not one of ${LUCY_OPERATOR_REASONING_LEVELS.join(', ')}; using ${DEFAULT_LUCY_OPERATOR_REASONING}.`);
  }

  // `any` (or `auto`) lifts the restriction; anything else is a comma-separated list of provider tags.
  const rawProviders = env.KOOKR_LUCY_OPERATOR_PROVIDERS?.trim().toLowerCase();
  let providers: readonly string[] = DEFAULT_LUCY_OPERATOR_PROVIDERS;
  if (rawProviders === 'any' || rawProviders === 'auto') {
    providers = [];
  } else if (rawProviders) {
    const tags = rawProviders.split(',').map((tag) => tag.trim()).filter(Boolean);
    const bad = tags.filter((tag) => !PROVIDER_TAG_RE.test(tag));
    if (tags.length === 0 || bad.length > 0) {
      warnings.push(`KOOKR_LUCY_OPERATOR_PROVIDERS is not a list of provider tags such as "cohere/fp8,deepinfra/fp8"; using ${DEFAULT_LUCY_OPERATOR_PROVIDERS.join(',')}.`);
    } else {
      providers = [...new Set(tags)];
    }
  }

  const apiKey = env.KOOKR_OPENROUTER_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    // Unset: on only where the key is present, so a host without one sees no change.
    if (!askedFor) return { enabled: false };
    return { enabled: true, ok: false, reason: 'Lucy\'s conversation needs an OpenRouter key (set KOOKR_OPENROUTER_API_KEY or OPENROUTER_API_KEY).', warnings };
  }

  return {
    enabled: true,
    ok: true,
    warnings,
    launch: isDefaultOnFlagEnabled(env.KOOKR_LUCY_LAUNCH),
    model: {
      apiKey,
      model: env.KOOKR_LUCY_OPERATOR_MODEL?.trim() || DEFAULT_LUCY_OPERATOR_MODEL,
      baseUrl: OPENROUTER_BASE_URL,
      providers,
      reasoning,
      appTitle: env.KOOKR_LLM_APP_TITLE?.trim() || 'Kookr',
    },
  };
}
