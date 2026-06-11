/**
 * LLM client wrapper that routes calls through a circuit breaker.
 * When the breaker is open, calls return null (same as provider failure).
 */
import type { LlmClient, LlmCompletionAuditResult, LlmCompletionRequest } from './llm-client.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { CircuitBreakerOpenError } from './circuit-breaker.js';
import { classifyLlmProviderFailure } from './llm-factory.js';

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
    return (await this.completeWithFailureAudit(request)).text;
  }

  async completeWithFailureAudit(request: LlmCompletionRequest): Promise<LlmCompletionAuditResult> {
    try {
      if (this.inner.completeWithFailureAudit) {
        return await this.breaker.call(() => this.inner.completeWithFailureAudit!(request));
      }
      const text = await this.breaker.call(() => this.inner.complete(request));
      if (text !== null) return { text, failures: [], failureCategory: null };
      return {
        text: null,
        failures: [{
          provider: this.inner.provider,
          model: this.inner.model,
          category: 'malformed_response',
          message: 'provider returned empty response',
        }],
        failureCategory: 'malformed_response',
      };
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        console.warn(`[llm] Circuit breaker open — skipping LLM call`);
        return {
          text: null,
          failures: [{
            provider: this.inner.provider,
            model: this.inner.model,
            category: 'other',
            message: 'circuit breaker open',
          }],
          failureCategory: 'other',
        };
      }
      // Abort must escape the outer wrapper — otherwise the route-level
      // cancellation guarantee (rfc-speak-agent-summary-v2 R8 / D18) is
      // silently nullified here.
      if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
      const category = classifyLlmProviderFailure(err);
      return {
        text: null,
        failures: [{
          provider: this.inner.provider,
          model: this.inner.model,
          category,
          message: err instanceof Error ? err.message : String(err),
        }],
        failureCategory: category,
      };
    }
  }
}
