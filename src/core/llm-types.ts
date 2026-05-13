/**
 * Provider-neutral LLM client types.
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
