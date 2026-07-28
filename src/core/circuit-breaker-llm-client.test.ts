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
    await expect(wrapper.completeWithFailureAudit({ maxTokens: 10, userMessage: 'hi' })).resolves.toMatchObject({
      text: null,
      failureCategory: 'other',
      failures: [{ provider: 'inner', model: 'm', category: 'other', message: 'circuit breaker open' }],
    });
    breakerSpy.mockRestore();
  });

  test('returns null on a generic inner failure (legacy contract)', async () => {
    const inner = mkInner(async () => { throw new Error('upstream 500'); });
    const wrapper = new CircuitBreakerLlmClient(inner, mkBreaker());
    await expect(wrapper.complete({ maxTokens: 10, userMessage: 'hi' })).resolves.toBeNull();
  });

  test('preserves categorized inner failures in the audit result', async () => {
    const inner = mkInner(async () => { throw new Error('504 Gateway Timeout'); });
    const wrapper = new CircuitBreakerLlmClient(inner, mkBreaker());

    await expect(wrapper.completeWithFailureAudit({ maxTokens: 10, userMessage: 'hi' })).resolves.toMatchObject({
      text: null,
      failureCategory: 'server_5xx',
      failures: [{ provider: 'inner', model: 'm', category: 'server_5xx', message: '504 Gateway Timeout' }],
    });
  });

  test('raw provider failures still count against the circuit breaker', async () => {
    const breaker = new CircuitBreaker({ name: 'test', failureThreshold: 1 });
    const inner = mkInner(async () => { throw new Error('504 Gateway Timeout'); });
    const wrapper = new CircuitBreakerLlmClient(inner, breaker);

    await expect(wrapper.completeWithFailureAudit({ maxTokens: 10, userMessage: 'hi' })).resolves.toMatchObject({
      failureCategory: 'server_5xx',
    });

    expect(breaker.getState()).toBe('open');
  });
});

// #1555: completeDetailed forwards the provider finish reason through the breaker.
describe('CircuitBreakerLlmClient.completeDetailed', () => {
  test('forwards the inner finish reason on success', async () => {
    const inner: LlmClient = {
      provider: 'inner',
      model: 'm',
      complete: vi.fn(),
      completeDetailed: vi.fn().mockResolvedValue({ text: 'A name', finishReason: 'stop' }),
    };
    const wrapper = new CircuitBreakerLlmClient(inner, mkBreaker());
    await expect(wrapper.completeDetailed({ maxTokens: 10, userMessage: 'hi' }))
      .resolves.toEqual({ text: 'A name', finishReason: 'stop' });
  });

  test('reports a synthetic circuit_open finish reason when the breaker is open', async () => {
    const breaker = mkBreaker();
    const breakerSpy = vi.spyOn(breaker, 'call').mockImplementation(async () => { throw new CircuitBreakerOpenError('test'); });
    const inner = mkInner(async () => 'never');
    const wrapper = new CircuitBreakerLlmClient(inner, breaker);
    await expect(wrapper.completeDetailed({ maxTokens: 10, userMessage: 'hi' }))
      .resolves.toEqual({ text: null, finishReason: 'circuit_open' });
    breakerSpy.mockRestore();
  });

  test('re-throws AbortError instead of masking it', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const inner: LlmClient = {
      provider: 'inner',
      model: 'm',
      complete: vi.fn(),
      completeDetailed: vi.fn().mockRejectedValue(abortErr),
    };
    const wrapper = new CircuitBreakerLlmClient(inner, mkBreaker());
    await expect(wrapper.completeDetailed({ maxTokens: 10, userMessage: 'hi' }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
