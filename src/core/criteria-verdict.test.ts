import { describe, expect, test, vi } from 'vitest';
import type { AgentEvent } from './types.js';
import type { LlmClient } from './llm-types.js';
import {
  buildCriteriaVerdictRequest,
  evaluateCriteriaVerdict,
  parseCriteriaVerdictResponse,
  splitCriteria,
} from './criteria-verdict.js';

const events: AgentEvent[] = [
  { type: 'tool_use', sessionId: 's1', toolName: 'Edit', toolInput: { file_path: '/repo/src/app.ts' } },
  { type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolResponse: 'Tests  4 passed' },
  { type: 'stop', sessionId: 's1', lastMessage: 'Implemented the UI and ran pnpm test.' },
];

function llm(text: string | null): LlmClient {
  return {
    provider: 'fake',
    model: 'judge',
    complete: vi.fn(async () => text),
  };
}

describe('criteria verdict', () => {
  test('splits checklist, numbered, and semicolon criteria into individual items', () => {
    expect(splitCriteria('- Add UI\n- Run tests\n3. Open a PR')).toEqual([
      'Add UI',
      'Run tests',
      'Open a PR',
    ]);
    expect(splitCriteria('Build endpoint; add tests')).toEqual(['Build endpoint', 'add tests']);
  });

  test('builds a prompt with projected completion event evidence', () => {
    const request = buildCriteriaVerdictRequest(['Run tests'], events);

    expect(request.system).toContain('pass, fail, or unknown');
    expect(request.userMessage).toContain('Run tests');
    expect(request.userMessage).toContain('Tests  4 passed');
    expect(request.userMessage).toContain('Implemented the UI');
  });

  test('redacts known secrets before sending event evidence to the helper LLM', () => {
    const request = buildCriteriaVerdictRequest(['Do not leak secrets'], [
      { type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolResponse: 'token ghp_1234567890abcdefghijklmnop' },
    ]);

    expect(request.userMessage).toContain('[REDACTED]');
    expect(request.userMessage).not.toContain('ghp_1234567890abcdefghijklmnop');
  });

  test('keeps the most recent completion evidence when the event window is too large', () => {
    const request = buildCriteriaVerdictRequest(['Run tests'], [
      ...Array.from({ length: 40 }, (_, i): AgentEvent => ({
        type: 'tool_result',
        sessionId: 's1',
        toolName: 'Bash',
        toolResponse: `old output ${i} ${'x'.repeat(1_000)}`,
      })),
      { type: 'tool_result', sessionId: 's1', toolName: 'Bash', toolResponse: 'Tests  7 passed' },
      { type: 'stop', sessionId: 's1', lastMessage: 'Final response mentions the PR.' },
    ]);

    expect(request.userMessage).not.toContain('old output 0');
    expect(request.userMessage).toContain('Tests  7 passed');
    expect(request.userMessage).toContain('Final response mentions the PR.');
  });

  test('parses per-criterion LLM verdicts and preserves unknown for omitted items', () => {
    const verdict = parseCriteriaVerdictResponse(
      JSON.stringify({
        items: [
          { criterion: 'Run tests', verdict: 'pass', reason: 'Bash output showed 4 passed.' },
        ],
      }),
      ['Run tests', 'Open PR'],
      { evaluatedAt: new Date('2026-06-11T12:00:00.000Z'), provider: 'fake', model: 'judge' },
    );

    expect(verdict.summary).toEqual({ pass: 1, fail: 0, unknown: 1 });
    expect(verdict.items[0]).toMatchObject({ criterion: 'Run tests', verdict: 'pass' });
    expect(verdict.items[1]).toMatchObject({ criterion: 'Open PR', verdict: 'unknown' });
    expect(verdict.source).toBe('llm');
    expect(verdict.provider).toBe('fake');
  });

  test('returns unknown when no completion event window is available', async () => {
    const verdict = await evaluateCriteriaVerdict({
      criteria: 'Run tests',
      events: [],
      llmClient: llm(JSON.stringify({ items: [] })),
      now: () => new Date('2026-06-11T12:00:00.000Z'),
    });

    expect(verdict?.source).toBe('no-event-window');
    expect(verdict?.items).toEqual([
      expect.objectContaining({ criterion: 'Run tests', verdict: 'unknown' }),
    ]);
  });

  test('returns unknown on LLM errors', async () => {
    const client: LlmClient = {
      provider: 'fake',
      model: 'judge',
      complete: vi.fn(async () => { throw new Error('provider down'); }),
    };

    const verdict = await evaluateCriteriaVerdict({
      criteria: 'Run tests',
      events,
      llmClient: client,
      now: () => new Date('2026-06-11T12:00:00.000Z'),
    });

    expect(verdict?.source).toBe('llm-error');
    expect(verdict?.summary).toEqual({ pass: 0, fail: 0, unknown: 1 });
    expect(verdict?.error).toContain('provider down');
    const call = vi.mocked(client.complete).mock.calls[0][0];
    expect(call.useCase).toBe('criteria_verdict');
  });
});
