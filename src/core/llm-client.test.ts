import { describe, test, expect, vi } from 'vitest';
import { FallbackLlmClient } from './llm-factory.js';
import type { LlmClient, LlmCompletionRequest } from './llm-types.js';

function makeClient(
  provider: string,
  result: string | null | Error,
): LlmClient & { complete: ReturnType<typeof vi.fn> } {
  return {
    provider,
    model: `${provider}-model`,
    complete: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

const req: LlmCompletionRequest = {
  maxTokens: 30,
  userMessage: 'test',
};

describe('FallbackLlmClient', () => {
  test('returns result from first provider on success', async () => {
    const a = makeClient('a', 'hello');
    const b = makeClient('b', 'world');
    const client = new FallbackLlmClient([a, b]);

    const result = await client.complete(req);
    expect(result).toBe('hello');
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).not.toHaveBeenCalled();
  });

  test('falls back to second provider when first throws', async () => {
    const a = makeClient('a', new Error('network error'));
    const b = makeClient('b', 'fallback');
    const client = new FallbackLlmClient([a, b]);

    const result = await client.complete(req);
    expect(result).toBe('fallback');
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).toHaveBeenCalledOnce();
  });

  test('falls back to second provider when first returns null', async () => {
    const a = makeClient('a', null);
    const b = makeClient('b', 'fallback');
    const client = new FallbackLlmClient([a, b]);

    const result = await client.complete(req);
    expect(result).toBe('fallback');
  });

  test('returns null when all providers fail', async () => {
    const a = makeClient('a', new Error('fail'));
    const b = makeClient('b', new Error('also fail'));
    const client = new FallbackLlmClient([a, b]);

    const result = await client.complete(req);
    expect(result).toBeNull();
  });

  test('returns null when all providers return null', async () => {
    const a = makeClient('a', null);
    const b = makeClient('b', null);
    const client = new FallbackLlmClient([a, b]);

    const result = await client.complete(req);
    expect(result).toBeNull();
  });

  test('provider string shows chain', async () => {
    const a = makeClient('groq', 'ok');
    const b = makeClient('anthropic', 'ok');
    const client = new FallbackLlmClient([a, b]);

    expect(client.provider).toBe('groq > anthropic');
  });

  test('model returns first provider model', async () => {
    const a = makeClient('groq', 'ok');
    const b = makeClient('anthropic', 'ok');
    const client = new FallbackLlmClient([a, b]);

    expect(client.model).toBe('groq-model');
  });

  test('throws if constructed with empty array', () => {
    expect(() => new FallbackLlmClient([])).toThrow('at least one provider');
  });

  test('chains through three providers', async () => {
    const a = makeClient('a', new Error('down'));
    const b = makeClient('b', null);
    const c = makeClient('c', 'third');
    const client = new FallbackLlmClient([a, b, c]);

    const result = await client.complete(req);
    expect(result).toBe('third');
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).toHaveBeenCalledOnce();
    expect(c.complete).toHaveBeenCalledOnce();
  });
});
