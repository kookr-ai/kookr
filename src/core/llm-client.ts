/**
 * Provider-agnostic LLM client interface.
 *
 * Supports multiple providers (Groq, Anthropic, and future: OpenAI, Google, etc.)
 * with automatic fallback: if the primary provider fails, the next is tried.
 */

export interface LlmCompletionRequest {
  maxTokens: number;
  system?: string;
  userMessage: string;
  /** Optional structured output hint. Providers that don't support it silently ignore it. */
  responseFormat?: {
    type: 'json_schema';
    jsonSchema: {
      name: string;
      schema: Record<string, unknown>;
    };
  };
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmClient {
  /** Returns the text content of the first message, or null on failure. */
  complete(request: LlmCompletionRequest): Promise<string | null>;
  /** Human-readable provider name for logging (e.g. "groq", "anthropic"). */
  readonly provider: string;
  /** Model ID used by this client (e.g. "meta-llama/llama-4-scout-17b-16e-instruct"). */
  readonly model: string;
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
 * Build an LlmClient from available environment variables.
 * Priority: GROQ_API_KEY > GEMINI_API_KEY > ANTHROPIC_API_KEY.
 * When multiple keys are set, all providers are chained for fallback.
 * Returns null if no API key is configured.
 */
export async function createLlmClient(): Promise<LlmClient | null> {
  const clients: LlmClient[] = [];

  const groqKey = process.env.GROQ_API_KEY?.trim();
  if (groqKey) {
    const { GroqLlmClient } = await import('./groq-client.js');
    clients.push(new GroqLlmClient(groqKey));
  }

  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    const { GoogleLlmClient } = await import('./google-client.js');
    clients.push(new GoogleLlmClient(geminiKey));
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    const { AnthropicLlmClient } = await import('./anthropic-client.js');
    clients.push(new AnthropicLlmClient(anthropicKey));
  }

  if (clients.length === 0) return null;
  if (clients.length === 1) return clients[0];
  return new FallbackLlmClient(clients);
}
