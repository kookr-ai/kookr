import { describe, test, expect, vi } from 'vitest';
import { CircuitBreakerLlmClient } from './circuit-breaker-llm-client.js';
import { CircuitBreaker, CircuitBreakerOpenError } from './circuit-breaker.js';
import type { LlmClient } from './llm-client.js';

function mkInner(impl: () => Promise<string | null>): LlmClient {
  return {
    provider: 'inner',
    model: 'm',
    complete: vi.fn().mockImplementation(impl),
  };
}

function mkBreaker(): CircuitBreaker {
  return new CircuitBreaker({ name: 'test', failureThreshold: 100 });
}

describe('CircuitBreakerLlmClient.complete', () => {
  test('re-throws AbortError instead of swallowing it as null', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const inner = mkInner(async () => { throw abortErr; });
    const wrapper = new CircuitBreakerLlmClient(inner, mkBreaker());
    await expect(wrapper.complete({ maxTokens: 10, userMessage: 'hi' })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('returns null when the breaker is open', async () => {
    const breaker = mkBreaker();
    const openErr = new CircuitBreakerOpenError('test');
    const breakerSpy = vi.spyOn(breaker, 'call').mockImplementation(async () => { throw openErr; });
    const inner = mkInner(async () => 'never');
    const wrapper = new CircuitBreakerLlmClient(inner, breaker);
    await expect(wrapper.complete({ maxTokens: 10, userMessage: 'hi' })).resolves.toBeNull();
    breakerSpy.mockRestore();
  });

  test('returns null on a generic inner failure (legacy contract)', async () => {
    const inner = mkInner(async () => { throw new Error('upstream 500'); });
    const wrapper = new CircuitBreakerLlmClient(inner, mkBreaker());
    await expect(wrapper.complete({ maxTokens: 10, userMessage: 'hi' })).resolves.toBeNull();
  });
});
