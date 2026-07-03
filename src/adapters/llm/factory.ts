/**
 * Environment-backed provider construction for LLM clients.
 */

import {
  FallbackLlmClient,
  withHelperLlmAccounting,
} from '../../core/llm-factory.js';
import type { LlmClient } from '../../core/llm-types.js';

type LlmFactoryEnv = Record<string, string | undefined>;

export interface LlmProviderBuilders {
  buildOpenRouter?: () => LlmClient | null | Promise<LlmClient | null>;
  buildRequesty?: () => LlmClient | null | Promise<LlmClient | null>;
  buildBaseten?: () => LlmClient | null | Promise<LlmClient | null>;
}

/**
 * Provider selection mode read from `KOOKR_LLM_PROVIDER`. Note `gemini` selects
 * the Google provider, whose client reports its name as `google` in logs.
 */
export type LlmProvider = 'openrouter' | 'requesty' | 'baseten' | 'groq' | 'gemini' | 'anthropic' | 'auto';

const EXPLICIT_PROVIDERS: readonly LlmProvider[] = ['openrouter', 'requesty', 'baseten', 'groq', 'gemini', 'anthropic'];

/**
 * Resolve `KOOKR_LLM_PROVIDER`. Unset or blank means `auto`; an unrecognized
 * value falls back to `auto` with a warning so a typo never disables AI silently.
 */
export function readLlmProvider(env: LlmFactoryEnv = process.env): LlmProvider {
  const raw = env.KOOKR_LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === 'auto' || (EXPLICIT_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as LlmProvider;
  }
  console.warn(
    `[llm] Unknown KOOKR_LLM_PROVIDER="${raw}" — expected openrouter|requesty|baseten|groq|gemini|anthropic|auto. Using auto provider selection.`,
  );
  return 'auto';
}

async function buildGroq(env: LlmFactoryEnv): Promise<LlmClient | null> {
  const key = env.GROQ_API_KEY?.trim();
  if (!key) return null;
  const { GroqLlmClient } = await import('./groq-client.js');
  return new GroqLlmClient(key);
}

async function buildGemini(env: LlmFactoryEnv): Promise<LlmClient | null> {
  const key = env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  const { GoogleLlmClient } = await import('./google-client.js');
  return new GoogleLlmClient(key);
}

async function buildAnthropic(env: LlmFactoryEnv): Promise<LlmClient | null> {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) return null;
  const { AnthropicLlmClient } = await import('./anthropic-client.js');
  return new AnthropicLlmClient(key);
}

async function buildOpenRouter(builders: LlmProviderBuilders): Promise<LlmClient | null> {
  return await builders.buildOpenRouter?.() ?? null;
}

async function buildRequesty(builders: LlmProviderBuilders): Promise<LlmClient | null> {
  return await builders.buildRequesty?.() ?? null;
}

async function buildBaseten(builders: LlmProviderBuilders): Promise<LlmClient | null> {
  return await builders.buildBaseten?.() ?? null;
}

function hasProviderBuilder(provider: Exclude<LlmProvider, 'auto'>, builders: LlmProviderBuilders): boolean {
  switch (provider) {
    case 'openrouter': return builders.buildOpenRouter !== undefined;
    case 'requesty': return builders.buildRequesty !== undefined;
    case 'baseten': return builders.buildBaseten !== undefined;
    case 'groq':
    case 'gemini':
    case 'anthropic':
      return true;
  }
}

function buildProvider(
  provider: Exclude<LlmProvider, 'auto'>,
  builders: LlmProviderBuilders,
  env: LlmFactoryEnv,
): Promise<LlmClient | null> {
  switch (provider) {
    case 'openrouter': return buildOpenRouter(builders);
    case 'requesty': return buildRequesty(builders);
    case 'baseten': return buildBaseten(builders);
    case 'groq': return buildGroq(env);
    case 'gemini': return buildGemini(env);
    case 'anthropic': return buildAnthropic(env);
  }
}

/**
 * Build an LlmClient from environment configuration.
 *
 * `KOOKR_LLM_PROVIDER` selects the mode:
 *  - `auto` (default): chain every configured provider for fallback, in
 *    priority order GROQ > GEMINI > ANTHROPIC > OPENROUTER.
 *  - `openrouter` | `requesty` | `baseten` | `groq` | `gemini` | `anthropic`: use only that provider.
 *
 * Returns null when the selected provider(s) have no API key configured.
 */
export async function createLlmClient(
  builders: LlmProviderBuilders = {},
  env: LlmFactoryEnv = process.env,
): Promise<LlmClient | null> {
  const provider = readLlmProvider(env);

  if (provider !== 'auto') {
    if (!hasProviderBuilder(provider, builders)) {
      console.warn(`[llm] KOOKR_LLM_PROVIDER=${provider} but that provider adapter is not configured at the composition boundary`);
      return null;
    }
    const client = await buildProvider(provider, builders, env);
    if (!client) {
      console.warn(`[llm] KOOKR_LLM_PROVIDER=${provider} but no API key is configured for that provider`);
    }
    return client ? withHelperLlmAccounting(client) : null;
  }

  // auto: chain configured providers in the existing order. Requesty and
  // Baseten are explicit-only and intentionally not included here.
  const clients: LlmClient[] = [];
  for (const build of [
    () => buildGroq(env),
    () => buildGemini(env),
    () => buildAnthropic(env),
    () => buildOpenRouter(builders),
  ]) {
    const client = await build();
    if (client) clients.push(withHelperLlmAccounting(client));
  }

  if (clients.length === 0) return null;
  if (clients.length === 1) return clients[0];
  return new FallbackLlmClient(clients);
}
