/**
 * Provider construction and fallback composition for LLM clients.
 */

import type { LlmClient, LlmCompletionRequest } from './llm-types.js';

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
      try {
        const result = await client.complete(request);
        if (result !== null) return result;
        // null means the provider returned empty — try next
        console.warn(`[llm] ${client.provider} (${client.model}) returned empty response, trying next provider`);
      } catch (err) {
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
export type LlmProvider = 'openrouter' | 'groq' | 'gemini' | 'anthropic' | 'auto';

const EXPLICIT_PROVIDERS: readonly LlmProvider[] = ['openrouter', 'groq', 'gemini', 'anthropic'];

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
    `[llm] Unknown KOOKR_LLM_PROVIDER="${raw}" — expected openrouter|groq|gemini|anthropic|auto. Using auto provider selection.`,
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

async function buildOpenRouter(): Promise<LlmClient | null> {
  // Component-specific key wins so a separate OpenRouter credit limit can be
  // scoped to Kookr; OPENROUTER_API_KEY remains a valid single-key fallback.
  // Trim before falling through so a blank KOOKR_OPENROUTER_API_KEY (empty
  // .env line, empty CI secret) does not shadow a working OPENROUTER_API_KEY.
  const key = process.env.KOOKR_OPENROUTER_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
  if (!key) return null;
  // Optional timeout override; a non-numeric or non-positive value is ignored
  // so the client falls back to its DEFAULT_TIMEOUT_MS floor.
  const parsedTimeout = Number(process.env.KOOKR_LLM_TIMEOUT_MS?.trim());
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined;
  const { OpenRouterLlmClient } = await import('./openrouter-client.js');
  return new OpenRouterLlmClient({
    apiKey: key,
    model: process.env.KOOKR_LLM_MODEL?.trim() || undefined,
    baseUrl: process.env.KOOKR_LLM_BASE_URL?.trim() || undefined,
    httpReferer: process.env.KOOKR_LLM_HTTP_REFERER?.trim() || undefined,
    appTitle: process.env.KOOKR_LLM_APP_TITLE?.trim() || undefined,
    timeoutMs,
  });
}

function buildProvider(provider: Exclude<LlmProvider, 'auto'>): Promise<LlmClient | null> {
  switch (provider) {
    case 'openrouter': return buildOpenRouter();
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
 *  - `openrouter` | `groq` | `gemini` | `anthropic`: use only that provider.
 *
 * Returns null when the selected provider(s) have no API key configured.
 */
export async function createLlmClient(): Promise<LlmClient | null> {
  const provider = readLlmProvider();

  if (provider !== 'auto') {
    const client = await buildProvider(provider);
    if (!client) {
      console.warn(`[llm] KOOKR_LLM_PROVIDER=${provider} but no API key is configured for that provider`);
    }
    return client;
  }

  // auto: chain all configured providers. Free-tier providers are tried first
  // so paid OpenRouter usage stays last-resort within the fallback chain.
  const clients: LlmClient[] = [];
  for (const build of [buildGroq, buildGemini, buildAnthropic, buildOpenRouter]) {
    const client = await build();
    if (client) clients.push(client);
  }

  if (clients.length === 0) return null;
  if (clients.length === 1) return clients[0];
  return new FallbackLlmClient(clients);
}
