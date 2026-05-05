import { describe, test, expect, vi } from 'vitest';
import { generateSuggestedResponses, type SuggestionContext } from './response-suggest.js';
import type { LlmClient } from './llm-client.js';

function mockClient(responseText: string | null): LlmClient {
  return {
    provider: 'test',
    model: 'test-model',
    complete: vi.fn().mockResolvedValue(responseText),
  };
}

describe('generateSuggestedResponses', () => {
  // --- Happy path ---

  test('returns parsed JSON array of suggestions', async () => {
    const client = mockClient('["yes, go ahead", "hold on", "no thanks"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'Should I continue?',
    };
    const result = await generateSuggestedResponses(client, ctx);
    expect(result).toEqual(['yes, go ahead', 'hold on', 'no thanks']);
  });

  test('handles structured output format { responses: [...] }', async () => {
    const client = mockClient('{"responses": ["yes", "no", "maybe"]}');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'Should I continue?',
    };
    const result = await generateSuggestedResponses(client, ctx);
    expect(result).toEqual(['yes', 'no', 'maybe']);
  });

  test('trims whitespace from each suggestion', async () => {
    const client = mockClient('[" yes ", " no "]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'Should I?',
    };
    const result = await generateSuggestedResponses(client, ctx);
    expect(result).toEqual(['yes', 'no']);
  });

  test('filters out empty strings', async () => {
    const client = mockClient('["yes", "", "  ", "no"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'Continue?',
    };
    const result = await generateSuggestedResponses(client, ctx);
    expect(result).toEqual(['yes', 'no']);
  });

  test('caps at 5 suggestions, keeping the first 5', async () => {
    const suggestions = '["a", "b", "c", "d", "e", "f", "g"]';
    const client = mockClient(suggestions);
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'What?',
    };
    const result = await generateSuggestedResponses(client, ctx);
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('filters out non-string values', async () => {
    const client = mockClient('["yes", 42, null, "no"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'Ok?',
    };
    const result = await generateSuggestedResponses(client, ctx);
    expect(result).toEqual(['yes', 'no']);
  });

  test('includes lastAssistantMessage in request', async () => {
    const client = mockClient('["suggestion"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'Do you want me to fix the bug?',
    };
    await generateSuggestedResponses(client, ctx);

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).toContain('Do you want me to fix the bug?');
  });

  test('includes taskPrompt when provided', async () => {
    const client = mockClient('["suggestion"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'What should I do?',
      taskPrompt: 'Fix authentication flow',
    };
    await generateSuggestedResponses(client, ctx);

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).toContain('Task: Fix authentication flow');
  });

  test('includes cwd when provided', async () => {
    const client = mockClient('["suggestion"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'Which module?',
      cwd: '/home/user/project',
    };
    await generateSuggestedResponses(client, ctx);

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).toContain('Working directory: /home/user/project');
  });

  test('includes recentToolCalls when provided', async () => {
    const client = mockClient('["suggestion"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'Done reading files.',
      recentToolCalls: ['Read', 'Grep', 'Bash'],
    };
    await generateSuggestedResponses(client, ctx);

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).toContain('Recent agent actions: Read, Grep, Bash');
  });

  test('omits taskPrompt from prompt when not provided', async () => {
    const client = mockClient('["suggestion"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'What next?',
    };
    await generateSuggestedResponses(client, ctx);

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).not.toContain('Task:');
  });

  test('omits cwd from prompt when not provided', async () => {
    const client = mockClient('["suggestion"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'What next?',
    };
    await generateSuggestedResponses(client, ctx);

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).not.toContain('Working directory:');
  });

  test('omits recentToolCalls when empty array', async () => {
    const client = mockClient('["suggestion"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'What next?',
      recentToolCalls: [],
    };
    await generateSuggestedResponses(client, ctx);

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).not.toContain('Recent agent actions');
  });

  // --- API parameters ---

  test('sets bounded maxTokens and timeoutMs', async () => {
    const client = mockClient('["ok"]');
    await generateSuggestedResponses(client, { lastAssistantMessage: 'hi' });

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.maxTokens).toBeGreaterThan(0);
    expect(call.maxTokens).toBeLessThanOrEqual(1000);
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.timeoutMs).toBeLessThanOrEqual(30000);
  });

  test('includes system prompt and responseFormat for structured output', async () => {
    const client = mockClient('["ok"]');
    await generateSuggestedResponses(client, { lastAssistantMessage: 'hi' });

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.system).toBeDefined();
    expect(typeof call.system).toBe('string');
    expect(call.responseFormat).toBeDefined();
    expect(call.responseFormat.type).toBe('json_schema');
  });

  // --- Full context ---

  test('includes all context fields when all provided', async () => {
    const client = mockClient('["refactor the auth module"]');
    const ctx: SuggestionContext = {
      lastAssistantMessage: 'What should I work on next?',
      taskPrompt: 'Fix all bugs in auth',
      cwd: '/home/user/project',
      recentToolCalls: ['Read', 'Edit'],
    };
    await generateSuggestedResponses(client, ctx);

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).toContain('Task: Fix all bugs in auth');
    expect(call.userMessage).toContain('Working directory: /home/user/project');
    expect(call.userMessage).toContain('Recent agent actions: Read, Edit');
    expect(call.userMessage).toContain('What should I work on next?');
  });

  // --- Error handling ---

  test('returns empty array when LLM returns null', async () => {
    const client = mockClient(null);
    const result = await generateSuggestedResponses(client, { lastAssistantMessage: 'hi' });
    expect(result).toEqual([]);
  });

  test('returns empty array when LLM returns invalid JSON', async () => {
    const client = mockClient('not json at all');
    const result = await generateSuggestedResponses(client, { lastAssistantMessage: 'hi' });
    expect(result).toEqual([]);
  });

  test('returns empty array when LLM returns non-array, non-structured JSON', async () => {
    const client = mockClient('{"suggestion": "yes"}');
    const result = await generateSuggestedResponses(client, { lastAssistantMessage: 'hi' });
    expect(result).toEqual([]);
  });

  test('returns empty array on error', async () => {
    const client: LlmClient = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };
    const result = await generateSuggestedResponses(client, { lastAssistantMessage: 'hi' });
    expect(result).toEqual([]);
  });

  test('returns empty array on timeout', async () => {
    const client: LlmClient = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockRejectedValue(new Error('Request timed out')),
    };
    const result = await generateSuggestedResponses(client, { lastAssistantMessage: 'hi' });
    expect(result).toEqual([]);
  });
});
