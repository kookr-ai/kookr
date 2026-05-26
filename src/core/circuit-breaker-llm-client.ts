/**
 * LLM client wrapper that routes calls through a circuit breaker.
 * When the breaker is open, calls return null (same as provider failure).
 */
import type { LlmClient, LlmCompletionRequest } from './llm-client.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { CircuitBreakerOpenError } from './circuit-breaker.js';

export class CircuitBreakerLlmClient implements LlmClient {
  constructor(
    private readonly inner: LlmClient,
    private readonly breaker: CircuitBreaker,
  ) {}

  get provider(): string {
    return this.inner.provider;
  }

  get model(): string {
    return this.inner.model;
  }

  async complete(request: LlmCompletionRequest): Promise<string | null> {
    try {
      return await this.breaker.call(() => this.inner.complete(request));
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        console.warn(`[llm] Circuit breaker open — skipping LLM call`);
        return null;
      }
      // Abort must escape the outer wrapper — otherwise the route-level
      // cancellation guarantee (rfc-speak-agent-summary-v2 R8 / D18) is
      // silently nullified here.
      if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
      // The inner call failed and the breaker recorded it. Return null to match
      // the existing LlmClient contract (null = failure).
      return null;
    }
  }
}
