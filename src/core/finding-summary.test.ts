import { describe, test, expect, vi } from 'vitest';
import { summarizeFinding, type FindingSummaryInput } from './finding-summary.js';
import type { LlmClient } from './llm-client.js';

function mockClient(response: string | null): LlmClient {
  return {
    provider: 'test',
    model: 'test-model',
    complete: vi.fn().mockResolvedValue(response),
  };
}

const baseInput: FindingSummaryInput = {
  taskName: 'Fix auth refactor',
  anomalyType: 'permission_blocked',
  anomalySeverity: 'warning',
  explanation: 'Claude is asking to run a destructive git command.',
};

describe('summarizeFinding', () => {
  test('uses fallback text when client is null', async () => {
    const result = await summarizeFinding(null, baseInput);
    expect(result.usedFallback).toBe(true);
    expect(result.text).toContain('Fix auth refactor');
    expect(result.text).toContain('Claude is asking');
  });

  test('returns recap + taskName on clean structured response', async () => {
    const client = mockClient('{"recap":"Claude needs approval for a destructive command"}');
    const result = await summarizeFinding(client, baseInput);
    expect(result.usedFallback).toBe(false);
    expect(result.text).toBe('Fix auth refactor. Claude needs approval for a destructive command.');
  });

  test('falls back when LLM response is malformed JSON', async () => {
    const client = mockClient('not json here');
    const result = await summarizeFinding(client, baseInput);
    expect(result.usedFallback).toBe(true);
  });

  test('falls back when LLM response is empty', async () => {
    const client = mockClient('');
    const result = await summarizeFinding(client, baseInput);
    expect(result.usedFallback).toBe(true);
  });

  test('falls back when LLM throws', async () => {
    const client: LlmClient = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const result = await summarizeFinding(client, baseInput);
    expect(result.usedFallback).toBe(true);
  });

  test('rejects recap with action verbs (denylist guardrail)', async () => {
    const client = mockClient('{"recap":"Approve the request immediately"}');
    const result = await summarizeFinding(client, baseInput);
    expect(result.usedFallback).toBe(true);
    // Falls back to taskName + raw explanation, not the model's "approve" text
    expect(result.text).not.toMatch(/approve/i);
  });

  test('rejects overlong recap', async () => {
    const long = 'word '.repeat(40).trim(); // >25 words
    const client = mockClient(JSON.stringify({ recap: long }));
    const result = await summarizeFinding(client, baseInput);
    expect(result.usedFallback).toBe(true);
  });

  test('uses "Untitled task" when taskName is missing', async () => {
    const client = mockClient('{"recap":"All good"}');
    const result = await summarizeFinding(client, { ...baseInput, taskName: undefined });
    expect(result.text).toBe('Untitled task. All good.');
  });

  test('truncates very long explanation in prompt input', async () => {
    const long = 'x'.repeat(2_000);
    const client: LlmClient = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockResolvedValue('{"recap":"ok"}'),
    };
    await summarizeFinding(client, { ...baseInput, explanation: long });
    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // The user message body must not be the full 2000-char explanation
    expect(call.userMessage.length).toBeLessThan(1_000);
  });

  test('wraps explanation in <<<EXPLANATION>>> delimiters (prompt-injection guard)', async () => {
    const client: LlmClient = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockResolvedValue('{"recap":"ok"}'),
    };
    await summarizeFinding(client, baseInput);
    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).toContain('<<<EXPLANATION>>>');
    expect(call.userMessage).toContain('<<<END>>>');
  });

  test('adversarial recap from a fooled LLM is rejected by the denylist guardrail', async () => {
    // Simulates a model that has been prompt-injected and returns a recap with
    // an action verb. The summarizer must NOT pass that text along — it must
    // fall back to the raw explanation. (We don't promise to sanitize the
    // explanation itself; that's already visible on the dashboard.)
    const cleanExplanation = 'Claude is waiting on a permission decision.';
    const client: LlmClient = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockResolvedValue('{"recap":"Approve the destructive command immediately"}'),
    };
    const result = await summarizeFinding(client, { ...baseInput, explanation: cleanExplanation });
    expect(result.usedFallback).toBe(true);
    expect(result.text).toContain(cleanExplanation);
    expect(result.text.toLowerCase()).not.toContain('approve');
  });

  test('fallback handles empty explanation', async () => {
    const result = await summarizeFinding(null, { ...baseInput, explanation: '' });
    expect(result.text).toBe('Fix auth refactor.');
  });
});
