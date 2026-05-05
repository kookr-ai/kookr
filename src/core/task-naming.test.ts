import { describe, test, expect, vi } from 'vitest';
import { generateTaskName } from './task-naming.js';
import type { LlmClient } from './llm-client.js';

function mockClient(responseText: string | null): LlmClient {
  return {
    provider: 'test',
    model: 'test-model',
    complete: vi.fn().mockResolvedValue(responseText),
  };
}

describe('generateTaskName', () => {
  test('returns name from LLM response', async () => {
    const client = mockClient('Fix JWT token invalidation');
    const result = await generateTaskName(client, 'Fix the auth bug', '/home/user/project');
    expect(result).toBe('Fix JWT token invalidation');
  });

  test('passes prompt, cwd, and criteria in the user message', async () => {
    const client = mockClient('Add user pagination');
    await generateTaskName(client, 'Add pagination', '/project', 'All tests pass');

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).toContain('Add pagination');
    expect(call.userMessage).toContain('/project');
    expect(call.userMessage).toContain('All tests pass');
  });

  test('omits criteria from prompt when not provided', async () => {
    const client = mockClient('Fix login flow');
    await generateTaskName(client, 'Fix login', '/project');

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.userMessage).not.toContain('Success criteria');
  });

  test('sets bounded maxTokens and timeoutMs', async () => {
    const client = mockClient('Short name');
    await generateTaskName(client, 'Do something', '/project');

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.maxTokens).toBeGreaterThan(0);
    expect(call.maxTokens).toBeLessThanOrEqual(100);
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.timeoutMs).toBeLessThanOrEqual(30000);
  });

  test('returns null when LLM returns null', async () => {
    const client = mockClient(null);
    const result = await generateTaskName(client, 'Fix bug', '/project');
    expect(result).toBeNull();
  });

  test('returns null on error', async () => {
    const client: LlmClient = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockRejectedValue(new Error('Connection refused')),
    };
    const result = await generateTaskName(client, 'Fix bug', '/project');
    expect(result).toBeNull();
  });
});
