/**
 * Provider construction and fallback composition for LLM clients.
 */

import {
  classifyLlmProviderHttpStatus,
  isLlmProviderFailureCategory,
  type LlmClient,
  type LlmCompletionAuditResult,
  type LlmCompletionRequest,
  type LlmProviderFailureCategory,
  type LlmProviderFailureRecord,
} from './llm-types.js';

export interface LlmProviderBuilders {
  buildOpenRouter?: () => LlmClient | null | Promise<LlmClient | null>;
  buildRequesty?: () => LlmClient | null | Promise<LlmClient | null>;
}

function hasProviderFailureCategory(err: unknown): err is { providerFailureCategory: LlmProviderFailureCategory } {
  const category = (err as { providerFailureCategory?: unknown } | null)?.providerFailureCategory;
  return isLlmProviderFailureCategory(category);
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function classifyStatus(status: number | null): LlmProviderFailureCategory | null {
  if (status === null) return null;
  const category = classifyLlmProviderHttpStatus(status);
  return category === 'other' ? null : category;
}

export function classifyLlmProviderFailure(err: unknown): LlmProviderFailureCategory {
  if (hasProviderFailureCategory(err)) return err.providerFailureCategory;

  const shaped = err as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    name?: unknown;
    message?: unknown;
  } | null;
  const status = classifyStatus(
    numberFromUnknown(shaped?.status) ?? numberFromUnknown(shaped?.statusCode),
  );
  if (status) return status;

  const code = typeof shaped?.code === 'string' ? shaped.code.toUpperCase() : '';
  if (['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return 'network_timeout';
  }

  const text = `${typeof shaped?.name === 'string' ? shaped.name : ''} ${
    typeof shaped?.message === 'string' ? shaped.message : String(err)
  }`.toLowerCase();
  if (/unauthori[sz]ed|forbidden|invalid api key|api key|authentication|authorization|permission denied/.test(text)) {
    return 'auth';
  }
  if (/\b5\d\d\b|server error|bad gateway|service unavailable|gateway timeout/.test(text)) return 'server_5xx';
  if (/json|parse|malformed|invalid response|unexpected end|message content|choices/.test(text)) return 'malformed_response';
  if (/timed?\s*out|timeout|network|fetch failed|socket|dns|connection/.test(text)) return 'network_timeout';
  return 'other';
}

function emptyResponseFailure(client: LlmClient): LlmProviderFailureRecord {
  return {
    provider: client.provider,
    model: client.model,
    category: 'malformed_response',
    message: 'provider returned empty response',
  };
}

function caughtFailure(client: LlmClient, err: unknown): LlmProviderFailureRecord {
  return {
    provider: client.provider,
    model: client.model,
    category: classifyLlmProviderFailure(err),
    message: err instanceof Error ? err.message : String(err),
  };
}

export async function completeLlmWithFailureAudit(
  client: LlmClient,
  request: LlmCompletionRequest,
): Promise<LlmCompletionAuditResult> {
  if (client.completeWithFailureAudit) {
    return client.completeWithFailureAudit(request);
  }

  try {
    const text = await client.complete(request);
    if (text !== null) return { text, failures: [], failureCategory: null };
    const failure = emptyResponseFailure(client);
    return { text: null, failures: [failure], failureCategory: failure.category };
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
    const failure = caughtFailure(client, err);
    return { text: null, failures: [failure], failureCategory: failure.category };
  }
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

  async completeWithFailureAudit(request: LlmCompletionRequest): Promise<LlmCompletionAuditResult> {
    const failures: LlmProviderFailureRecord[] = [];
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
        if (result !== null) {
          return { text: result, failures, failureCategory: null };
        }
        // null means the provider returned empty — try next
        const failure = emptyResponseFailure(client);
        failures.push(failure);
        console.warn(
          `[llm] ${client.provider} (${client.model}) failed category=${failure.category}: ${failure.message}, trying next provider`,
        );
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
        const failure = caughtFailure(client, err);
        failures.push(failure);
        console.warn(
          `[llm] ${client.provider} (${client.model}) failed category=${failure.category}: ${failure.message}, trying next provider`,
        );
      }
    }
    const lastFailure = failures[failures.length - 1] ?? null;
    return { text: null, failures, failureCategory: lastFailure?.category ?? null };
  }

  async complete(request: LlmCompletionRequest): Promise<string | null> {
    return (await this.completeWithFailureAudit(request)).text;
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
