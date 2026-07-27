import { describe, test, expect, vi, afterEach } from 'vitest';
import { deterministicTaskName, generateTaskName } from './task-naming.js';
import type { LlmClient, LlmCompletionDetail, LlmCompletionRequest } from './llm-client.js';

function mockClient(responseText: string | null): LlmClient {
  return {
    provider: 'test',
    model: 'test-model',
    complete: vi.fn().mockResolvedValue(responseText),
  };
}

/**
 * Client that reports a provider finish reason via completeDetailed — the path
 * the namer uses to keep truncated/empty completions diagnosable (#1555).
 */
function detailedClient(
  responder: (req: LlmCompletionRequest) => LlmCompletionDetail,
): LlmClient {
  return {
    provider: 'test',
    model: 'test-model',
    complete: vi.fn(async (req: LlmCompletionRequest) => responder(req).text),
    completeDetailed: vi.fn(async (req: LlmCompletionRequest) => responder(req)),
  };
}

function modeOf(req: LlmCompletionRequest): 'json_schema' | 'json_object' | 'plain' {
  if (req.responseFormat?.type === 'json_schema') return 'json_schema';
  if (req.responseFormat?.type === 'json_object') return 'json_object';
  return 'plain';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('generateTaskName', () => {
  test('returns name from LLM response', async () => {
    const client = mockClient('Fix JWT token invalidation');
    const result = await generateTaskName(client, 'Fix the auth bug', '/home/user/project');
    expect(result).toBe('Fix JWT token invalidation');
  });

  test('returns name from structured LLM response', async () => {
    const client = mockClient('{"name":"Fix JWT token invalidation"}');
    const result = await generateTaskName(client, 'Fix the auth bug', '/home/user/project');
    expect(result).toBe('Fix JWT token invalidation');
  });

  test('strips common prose wrapper from fallback text response', async () => {
    const client = mockClient('Here is a name that you could use for the task: Fix login timeout');
    const result = await generateTaskName(client, 'Fix login timeout bug', '/home/user/project');
    expect(result).toBe('Fix login timeout');
  });

  test('strips quotes and trailing punctuation from fallback text response', async () => {
    const client = mockClient('"Fix login timeout."');
    const result = await generateTaskName(client, 'Fix login timeout bug', '/home/user/project');
    expect(result).toBe('Fix login timeout');
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
    // Budget must clear reasoning-token overhead (issue #1555): the old cap of
    // 30 was consumed by reasoning before any JSON name was emitted.
    expect(call.maxTokens).toBeGreaterThanOrEqual(256);
    expect(call.maxTokens).toBeLessThanOrEqual(2000);
    expect(call.timeoutMs).toBeGreaterThan(0);
    expect(call.timeoutMs).toBeLessThanOrEqual(30000);
    expect(call.useCase).toBe('task_naming');
  });

  test('requests structured output for task naming', async () => {
    const client = mockClient('{"name":"Short name"}');
    await generateTaskName(client, 'Do something', '/project');

    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.system).toContain('ONLY a JSON object');
    expect(call.responseFormat).toEqual({
      type: 'json_schema',
      jsonSchema: {
        name: 'task_name',
        schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
            },
          },
          required: ['name'],
          additionalProperties: false,
        },
      },
    });
  });

  test('returns null when LLM returns null', async () => {
    const client = mockClient(null);
    const result = await generateTaskName(client, 'Fix bug', '/project');
    expect(result).toBeNull();
  });

  test('returns null when structured response has no name', async () => {
    const client = mockClient('{"title":"Fix bug"}');
    const result = await generateTaskName(client, 'Fix bug', '/project');
    expect(result).toBeNull();
  });

  test('returns null when normalized name is too long', async () => {
    const client = mockClient('This task name is much too long because it contains far more than twelve words and should not be stored directly');
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

  // Issue #1555: a namer failure must log the provider finish reason so a
  // truncated-budget failure (finish_reason=length) is diagnosable from server
  // logs, not collapsed to a bare "empty name".
  test('logs a diagnosable finish reason when every completion is empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = detailedClient(() => ({ text: null, finishReason: 'length' }));

    const result = await generateTaskName(client, 'Fix bug', '/project');

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('finish_reason=length');
    // Not the bare, undiagnosable message the old namer produced.
    expect(message).not.toBe('LLM returned empty name');
  });

  test('logs the finish reason from an unparseable (non-empty) completion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Reasoning dump instead of a name: non-empty, but exceeds the word cap so
    // it never parses into a usable name — the truncated-reasoning shape #1555
    // describes.
    const client = detailedClient(() => ({
      text: 'Let me think about this task carefully before I decide what the best short name would be',
      finishReason: 'length',
    }));

    const result = await generateTaskName(client, 'Fix bug', '/project');

    expect(result).toBeNull();
    const message = warn.mock.calls[0][0] as string;
    expect(message).toContain('unparseable');
    expect(message).toContain('finish_reason=length');
  });

  // Issue #1555: json_schema failing must not fail open — the chain retries
  // json_object, then plain text.
  test('falls back to json_object when json_schema yields no usable name', async () => {
    const client = detailedClient((req) => {
      const mode = modeOf(req);
      if (mode === 'json_schema') return { text: null, finishReason: 'length' };
      if (mode === 'json_object') return { text: '{"name":"Fix JWT invalidation"}', finishReason: 'stop' };
      return { text: null, finishReason: 'stop' };
    });

    const result = await generateTaskName(client, 'Fix the auth bug', '/project');

    expect(result).toBe('Fix JWT invalidation');
    // json_schema then json_object — plain text never reached.
    expect((client.completeDetailed as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  test('falls back to plain-text parsing when both JSON modes fail', async () => {
    const client = detailedClient((req) => {
      const mode = modeOf(req);
      if (mode === 'plain') return { text: 'Fix login timeout', finishReason: 'stop' };
      return { text: null, finishReason: 'length' };
    });

    const result = await generateTaskName(client, 'Fix login', '/project');

    expect(result).toBe('Fix login timeout');
    expect((client.completeDetailed as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  test('continues the chain when a mode rejects the request shape', async () => {
    const client = detailedClient((req) => {
      const mode = modeOf(req);
      if (mode === 'json_schema') throw new Error('400 response_format json_schema not supported');
      if (mode === 'json_object') return { text: '{"name":"Add pagination"}', finishReason: 'stop' };
      return { text: null, finishReason: 'stop' };
    });

    const result = await generateTaskName(client, 'Add pagination', '/project');
    expect(result).toBe('Add pagination');
    // json_schema was actually attempted (and recovered from), not skipped.
    expect((client.completeDetailed as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  // A client-level condition (circuit breaker open) fails the same for every
  // mode — the namer must not re-trip it once per mode.
  test('short-circuits the chain on a circuit_open finish reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = detailedClient(() => ({ text: null, finishReason: 'circuit_open' }));

    const result = await generateTaskName(client, 'Fix bug', '/project');

    expect(result).toBeNull();
    expect((client.completeDetailed as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(warn.mock.calls[0][0]).toContain('circuit_open');
  });
});

describe('deterministicTaskName (issue #1526 Phase C4 — no task is ever unnamed)', () => {
  test('uses the first non-empty prompt line', () => {
    expect(deterministicTaskName('\n\nFix the auth bug\nWith much more detail below', '/p'))
      .toBe('Fix the auth bug');
  });

  test('strips leading markdown/list markers and collapses whitespace', () => {
    expect(deterministicTaskName('## Fix   the auth bug', '/p')).toBe('Fix the auth bug');
    expect(deterministicTaskName('- Fix the auth bug', '/p')).toBe('Fix the auth bug');
  });

  test('truncates long prompts to the 80-char cap with an ellipsis', () => {
    const name = deterministicTaskName(`Implement ${'x'.repeat(200)}`, '/p');
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.endsWith('…')).toBe(true);
    expect(name.startsWith('Implement')).toBe(true);
  });

  test('falls back to the cwd basename for a blank prompt, and is never empty', () => {
    expect(deterministicTaskName('   \n\t\n', '/srv/checkouts/kookr')).toBe('Task in kookr');
    expect(deterministicTaskName('')).toBe('Unnamed task');
  });
});
