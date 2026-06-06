/**
 * Provider construction and fallback composition for LLM clients.
 */

import type { LlmClient, LlmCompletionRequest } from './llm-types.js';

export interface LlmProviderBuilders {
  buildOpenRouter?: () => LlmClient | null | Promise<LlmClient | null>;
  buildRequesty?: () => LlmClient | null | Promise<LlmClient | null>;
}

/**
 * An LlmClient that tries multiple providers in order.
 * On any failure, the next provider is attempted. If all fail, returns null.
 */
export class FallbackLlmClient implements LlmClient {
  private clients: LlmClient[];

  constructor(clients: LlmClient[]) {
    if (clients.length === 0) {
      throw new Error('FallbackLlmClient requires at least one provider');
    }
    this.clients = clients;
  }

  get provider(): string {
    return this.clients.map(c => c.provider).join(' > ');
  }

  get model(): string {
    return this.clients[0].model;
  }

  async complete(request: LlmCompletionRequest): Promise<string | null> {
    for (const client of this.clients) {
      // Re-check between providers so an abort that fired during the previous
      // attempt does not silently retry on the next provider. See R8 in
      // rfc-speak-agent-summary-v2 — the route's cancellation guarantee
      // depends on this loop short-circuiting.
      if (request.signal?.aborted) {
        const err = new Error('Request aborted');
        err.name = 'AbortError';
        throw err;
      }
      try {
        const result = await client.complete(request);
        if (result !== null) return result;
        // null means the provider returned empty — try next
        console.warn(`[llm] ${client.provider} (${client.model}) returned empty response, trying next provider`);
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
        console.warn(
          `[llm] ${client.provider} (${client.model}) failed: ${err instanceof Error ? err.message : err}, trying next provider`,
        );
      }
    }
    return null;
  }
}

/**
 * Provider selection mode read from `KOOKR_LLM_PROVIDER`. Note `gemini` selects
 * the Google provider, whose client reports its name as `google` in logs.
 */
export type LlmProvider = 'openrouter' | 'requesty' | 'groq' | 'gemini' | 'anthropic' | 'auto';

const EXPLICIT_PROVIDERS: readonly LlmProvider[] = ['openrouter', 'requesty', 'groq', 'gemini', 'anthropic'];

/**
 * Resolve `KOOKR_LLM_PROVIDER`. Unset or blank means `auto`; an unrecognized
 * value falls back to `auto` with a warning so a typo never disables AI silently.
 */
export function readLlmProvider(): LlmProvider {
  const raw = process.env.KOOKR_LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) return 'auto';
  if (raw === 'auto' || (EXPLICIT_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as LlmProvider;
  }
  console.warn(
    `[llm] Unknown KOOKR_LLM_PROVIDER="${raw}" — expected openrouter|requesty|groq|gemini|anthropic|auto. Using auto provider selection.`,
  );
  return 'auto';
}

async function buildGroq(): Promise<LlmClient | null> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return null;
  const { GroqLlmClient } = await import('./groq-client.js');
  return new GroqLlmClient(key);
}

async function buildGemini(): Promise<LlmClient | null> {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return null;
  const { GoogleLlmClient } = await import('./google-client.js');
  return new GoogleLlmClient(key);
}

async function buildAnthropic(): Promise<LlmClient | null> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
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

function hasProviderBuilder(provider: Exclude<LlmProvider, 'auto'>, builders: LlmProviderBuilders): boolean {
  switch (provider) {
    case 'openrouter': return builders.buildOpenRouter !== undefined;
    case 'requesty': return builders.buildRequesty !== undefined;
    case 'groq':
    case 'gemini':
    case 'anthropic':
      return true;
  }
}

function buildProvider(provider: Exclude<LlmProvider, 'auto'>, builders: LlmProviderBuilders): Promise<LlmClient | null> {
  switch (provider) {
    case 'openrouter': return buildOpenRouter(builders);
    case 'requesty': return buildRequesty(builders);
    case 'groq': return buildGroq();
    case 'gemini': return buildGemini();
    case 'anthropic': return buildAnthropic();
  }
}

/**
 * Build an LlmClient from environment configuration.
 *
 * `KOOKR_LLM_PROVIDER` selects the mode:
 *  - `auto` (default): chain every configured provider for fallback, in
 *    priority order GROQ > GEMINI > ANTHROPIC > OPENROUTER.
 *  - `openrouter` | `requesty` | `groq` | `gemini` | `anthropic`: use only that provider.
 *
 * Returns null when the selected provider(s) have no API key configured.
 */
export async function createLlmClient(builders: LlmProviderBuilders = {}): Promise<LlmClient | null> {
  const provider = readLlmProvider();

  if (provider !== 'auto') {
    if (!hasProviderBuilder(provider, builders)) {
      console.warn(`[llm] KOOKR_LLM_PROVIDER=${provider} but that provider adapter is not configured at the composition boundary`);
      return null;
    }
    const client = await buildProvider(provider, builders);
    if (!client) {
      console.warn(`[llm] KOOKR_LLM_PROVIDER=${provider} but no API key is configured for that provider`);
    }
    return client;
  }

  // auto: chain configured providers in the existing order. Requesty is
  // explicit-only and intentionally not included here.
  const clients: LlmClient[] = [];
  for (const build of [buildGroq, buildGemini, buildAnthropic, () => buildOpenRouter(builders)]) {
    const client = await build();
    if (client) clients.push(client);
  }

  if (clients.length === 0) return null;
  if (clients.length === 1) return clients[0];
  return new FallbackLlmClient(clients);
}
