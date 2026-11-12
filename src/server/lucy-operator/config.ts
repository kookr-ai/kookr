/**
 * Decides, from the environment, whether Lucy's operator conversation is switched on
 * and which model answers (issue #3660).
 *
 * It is off unless `KOOKR_LUCY_OPERATOR=true`. When on it needs an OpenRouter key, the
 * same one the helper model uses. The model, the providers allowed to serve it and how
 * much it thinks before answering are each a setting; their defaults are the ones
 * chosen from the model trial recorded on issue #3632.
 */

import {
  LUCY_OPERATOR_REASONING_LEVELS,
  type LucyOperatorReasoning,
  type OpenRouterChatStreamConfig,
} from '../../adapters/llm/openrouter-chat-stream.js';

export const DEFAULT_LUCY_OPERATOR_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
/** Cohere first, DeepInfra as the only fallback, both at 8-bit precision. */
export const DEFAULT_LUCY_OPERATOR_PROVIDERS: readonly string[] = ['cohere/fp8', 'deepinfra/fp8'];
export const DEFAULT_LUCY_OPERATOR_REASONING: LucyOperatorReasoning = 'medium';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** A provider tag as OpenRouter writes it: a slug, optionally followed by variants (`deepinfra/fp8/flex`). */
const PROVIDER_TAG_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

export type LucyOperatorConfigResult =
  /** The setting is off: the route answers 404. */
  | { enabled: false }
  /** Switched on and usable. `warnings` lists settings that were ignored, for the start-up log. */
  | { enabled: true; ok: true; model: OpenRouterChatStreamConfig; warnings: string[] }
  /** Switched on but something is missing: the route answers 503 with `reason`. */
  | { enabled: true; ok: false; reason: string; warnings: string[] };

function isTrue(value: string | undefined): boolean {
  return ['true', '1', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

export function resolveLucyOperatorConfig(env: Record<string, string | undefined>): LucyOperatorConfigResult {
  if (!isTrue(env.KOOKR_LUCY_OPERATOR)) return { enabled: false };
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
    return { enabled: true, ok: false, reason: 'Lucy\'s conversation needs an OpenRouter key (set KOOKR_OPENROUTER_API_KEY or OPENROUTER_API_KEY).', warnings };
  }

  return {
    enabled: true,
    ok: true,
    warnings,
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
