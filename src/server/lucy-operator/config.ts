/**
 * Decides, from the environment, whether Lucy's operator conversation is switched on,
 * which service answers (Baseten or OpenRouter) and which model (issue #3660).
 *
 * It is on by default (issue #3937) and needs a key for one of the two services.
 * `KOOKR_LUCY_OPERATOR_PROVIDER` chooses the service. Unset, Baseten is used when its key
 * is configured (the key Lucy live already uses; the operator's OpenRouter account may
 * block the model, which no setting here can fix), otherwise OpenRouter when its key is
 * configured. With `KOOKR_LUCY_OPERATOR` unset it turns itself on when a key is present and
 * stays quietly off when none is. Setting it to `true` asks for it explicitly: a missing
 * key then makes the route answer 503 and say why. `0`, `false`, `off` or `no` switches it
 * off. The model and how much it thinks before answering are settings too; the OpenRouter
 * defaults are the ones chosen from the model trial recorded on issue #3632, and its
 * provider list is empty by default, so the routing rule on the OpenRouter account picks.
 */

import { isDefaultOnFlagEnabled, isKillSwitchValue } from '../../core/default-on-flag.js';
import { DEFAULT_BASETEN_BASE_URL, DEFAULT_BASETEN_MODEL, type BasetenChatStreamConfig } from '../../adapters/llm/baseten-chat-stream.js';
import {
  LUCY_OPERATOR_REASONING_LEVELS,
  type LucyOperatorReasoning,
  type OpenRouterChatStreamConfig,
} from '../../adapters/llm/openrouter-chat-stream.js';

export const DEFAULT_LUCY_OPERATOR_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
/**
 * No provider: the request carries no `provider` field and the routing rule on the
 * OpenRouter account decides which provider serves it (operator decision, 2026-11-23).
 * Pinning one here would bypass that rule, and a pinned provider that stops serving
 * the model fails every turn with 404. `KOOKR_LUCY_OPERATOR_PROVIDERS` opts in to a list.
 */
export const DEFAULT_LUCY_OPERATOR_PROVIDERS: readonly string[] = [];
export const DEFAULT_LUCY_OPERATOR_REASONING: LucyOperatorReasoning = 'medium';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
/** A provider tag as OpenRouter writes it: a slug, optionally followed by variants (`deepinfra/fp8/flex`). */
const PROVIDER_TAG_RE = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;

export type LucyOperatorProvider = 'baseten' | 'openrouter';
const LUCY_OPERATOR_PROVIDERS: readonly LucyOperatorProvider[] = ['baseten', 'openrouter'];

/** The service of a usable configuration; a configuration written without the field is an OpenRouter one. */
export function lucyOperatorProviderOf(config: { provider?: LucyOperatorProvider }): LucyOperatorProvider {
  return config.provider ?? 'openrouter';
}

type LucyOperatorUsable = {
  /** On unless `KOOKR_LUCY_LAUNCH` is a kill switch: she may propose launching a task. */
  launch: boolean;
  /** Settings that were ignored, for the start-up log. */
  warnings: string[];
};

export type LucyOperatorConfigResult =
  /** Switched off, or left unset with no key: the route answers 404. */
  | { enabled: false }
  /** Switched on and usable. */
  | ({ enabled: true; ok: true; provider: 'baseten'; model: BasetenChatStreamConfig } & LucyOperatorUsable)
  | ({ enabled: true; ok: true; provider?: 'openrouter'; model: OpenRouterChatStreamConfig } & LucyOperatorUsable)
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

  // Unset, `any` or `auto`: no restriction. Anything else is a comma-separated list of provider tags.
  const rawProviders = env.KOOKR_LUCY_OPERATOR_PROVIDERS?.trim().toLowerCase();
  let providers: readonly string[] = DEFAULT_LUCY_OPERATOR_PROVIDERS;
  if (rawProviders === 'any' || rawProviders === 'auto') {
    providers = [];
  } else if (rawProviders) {
    const tags = rawProviders.split(',').map((tag) => tag.trim()).filter(Boolean);
    const bad = tags.filter((tag) => !PROVIDER_TAG_RE.test(tag));
    if (tags.length === 0 || bad.length > 0) {
      warnings.push('KOOKR_LUCY_OPERATOR_PROVIDERS is not a list of provider tags such as "deepinfra/fp8,novita"; letting the OpenRouter account routing rule choose.');
    } else {
      providers = [...new Set(tags)];
    }
  }

  const basetenKey = env.KOOKR_BASETEN_API_KEY?.trim() || env.BASETEN_API_KEY?.trim();
  const openRouterKey = env.KOOKR_OPENROUTER_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();

  // Unset or unknown: the first service with a key. An unknown value is a typo, so it is reported once.
  const rawProvider = env.KOOKR_LUCY_OPERATOR_PROVIDER?.trim().toLowerCase();
  let chosen: LucyOperatorProvider | undefined;
  if (rawProvider) {
    if ((LUCY_OPERATOR_PROVIDERS as readonly string[]).includes(rawProvider)) chosen = rawProvider as LucyOperatorProvider;
    else warnings.push(`KOOKR_LUCY_OPERATOR_PROVIDER="${rawProvider.slice(0, 40)}" is not one of ${LUCY_OPERATOR_PROVIDERS.join(', ')}; choosing by which key is configured.`);
  }
  const explicit = chosen !== undefined;
  const provider: LucyOperatorProvider = chosen ?? (basetenKey ? 'baseten' : 'openrouter');

  // Left to the keys, with none of either: on only where a key is present, so a host without one sees no change.
  if (!explicit && !basetenKey && !openRouterKey) {
    if (!askedFor) return { enabled: false };
    return { enabled: true, ok: false, reason: 'Lucy\'s conversation needs a Baseten key (KOOKR_BASETEN_API_KEY or BASETEN_API_KEY) or an OpenRouter key (KOOKR_OPENROUTER_API_KEY or OPENROUTER_API_KEY).', warnings };
  }

  if (provider === 'baseten') {
    if (!basetenKey) {
      return { enabled: true, ok: false, reason: 'Lucy\'s conversation is set to use Baseten and needs a Baseten key (set KOOKR_BASETEN_API_KEY or BASETEN_API_KEY).', warnings };
    }
    if (rawProviders) warnings.push('KOOKR_LUCY_OPERATOR_PROVIDERS only applies to OpenRouter and is ignored on Baseten.');
    // Baseten's named levels include all four this setting accepts; `none` is its own "do not think" level.
    const modelFromOperatorSetting = env.KOOKR_LUCY_OPERATOR_MODEL?.trim();
    return {
      enabled: true,
      ok: true,
      provider: 'baseten',
      warnings,
      launch: isDefaultOnFlagEnabled(env.KOOKR_LUCY_LAUNCH),
      model: {
        apiKey: basetenKey,
        // Lucy live's own Baseten settings apply only when this one is unset, so one line moves both together.
        model: modelFromOperatorSetting || env.KOOKR_BASETEN_MODEL?.trim() || DEFAULT_BASETEN_MODEL,
        baseUrl: env.KOOKR_BASETEN_BASE_URL?.trim() || DEFAULT_BASETEN_BASE_URL,
        reasoningEffort: reasoning,
      },
    };
  }

  if (!openRouterKey) {
    return { enabled: true, ok: false, reason: 'Lucy\'s conversation is set to use OpenRouter and needs an OpenRouter key (set KOOKR_OPENROUTER_API_KEY or OPENROUTER_API_KEY).', warnings };
  }

  return {
    enabled: true,
    ok: true,
    provider: 'openrouter',
    warnings,
    launch: isDefaultOnFlagEnabled(env.KOOKR_LUCY_LAUNCH),
    model: {
      apiKey: openRouterKey,
      model: env.KOOKR_LUCY_OPERATOR_MODEL?.trim() || DEFAULT_LUCY_OPERATOR_MODEL,
      baseUrl: OPENROUTER_BASE_URL,
      providers,
      reasoning,
      appTitle: env.KOOKR_LLM_APP_TITLE?.trim() || 'Kookr',
    },
  };
}
