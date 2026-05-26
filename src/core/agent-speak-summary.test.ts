import { describe, test, expect, vi } from 'vitest';
import {
  buildFallbackText,
  buildSystemPrompt,
  resolveSpeakMode,
  summarizeAgent,
} from './agent-speak-summary.js';
import type { AgentSpeakContext, VerbosityScale } from '../shared/contracts/speech.js';
import type { LlmClient } from './llm-client.js';

const baseContext: AgentSpeakContext = {
  taskName: 'Refactor auth',
  agentType: 'claude-code',
  cwd: '/tmp/work',
  descriptionExcerpt: 'Refactor the auth module to use the new permissions service.',
  recentActivity: 'read 2 files, edited 1 file',
  recentMessages: 'Agent: All tests pass | User: keep going',
};

function mkClient(response: string | null, capture?: (req: unknown) => void): LlmClient {
  return {
    provider: 'test',
    model: 'test-model',
    complete: vi.fn().mockImplementation(async (req) => {
      capture?.(req);
      return response;
    }),
  };
}

describe('resolveSpeakMode', () => {
  test('returns finding when agent has anomaly and request=auto', () => {
    expect(resolveSpeakMode({ anomaly: { type: 'x' } }, 'auto')).toBe('finding');
  });
  test('returns activity when agent has no anomaly and request=auto', () => {
    expect(resolveSpeakMode({ anomaly: null }, 'auto')).toBe('activity');
  });
  test('preserves explicit finding mode', () => {
    expect(resolveSpeakMode({ anomaly: null }, 'finding')).toBe('finding');
  });
  test('preserves explicit activity mode', () => {
    expect(resolveSpeakMode({ anomaly: { type: 'x' } }, 'activity')).toBe('activity');
  });
});

describe('buildSystemPrompt', () => {
  test('mode=finding mentions finding language', () => {
    const prompt = buildSystemPrompt('finding', 'medium');
    expect(prompt).toMatch(/supervisor finding/i);
  });
  test('mode=activity mentions activity language', () => {
    const prompt = buildSystemPrompt('activity', 'medium');
    expect(prompt).toMatch(/current activity/i);
  });
  test.each<[VerbosityScale, string]>([
    ['terse', '15'],
    ['brief', '30'],
    ['medium', '60'],
    ['detailed', '120'],
  ])('verbosity %s names its word cap in the constraints (%s)', (rung, cap) => {
    const prompt = buildSystemPrompt('activity', rung);
    expect(prompt).toContain(`≤ ${cap} words`);
  });
});

describe('buildFallbackText (rung-aware)', () => {
  test('terse falls back to short anomaly-anchored sentence', () => {
    const text = buildFallbackText(
      { ...baseContext, anomaly: { type: 'needs_input', severity: 'info', explanation: 'long text…' } },
      'terse',
    );
    expect(text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
    expect(text).toContain('Refactor auth');
    expect(text).toContain('needs_input');
  });

  test('terse without anomaly uses the "working" placeholder', () => {
    const text = buildFallbackText(baseContext, 'terse');
    expect(text).toBe('Refactor auth. working.');
  });

  test('medium uses recent activity in the recap', () => {
    const text = buildFallbackText(baseContext, 'medium');
    expect(text).toContain('read 2 files');
    expect(text).toContain('Refactor auth');
  });

  test('strips trailing terminal punctuation before appending separator', () => {
    const text = buildFallbackText({ ...baseContext, taskName: 'Refactor auth.' }, 'brief');
    expect(text.startsWith('Refactor auth.')).toBe(true);
    expect(text).not.toContain('Refactor auth..');
  });
});

describe('summarizeAgent', () => {
  test('falls back when client is null with reason=no-llm-client', async () => {
    const result = await summarizeAgent(null, baseContext, 'medium', 'activity');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('no-llm-client');
    expect(result.text).toContain('Refactor auth');
  });

  test('returns the recap on a well-formed response', async () => {
    const client = mkClient('{"recap":"Working through the auth refactor"}');
    const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
    expect(result.usedFallback).toBe(false);
    expect(result.fallbackReason).toBe(null);
    expect(result.text).toBe('Refactor auth. Working through the auth refactor.');
  });

  test('rejects malformed JSON with reason=schema-violation', async () => {
    const client = mkClient('not json at all');
    const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('schema-violation');
  });

  test('rejects denylist verb with reason=denylist', async () => {
    const client = mkClient('{"recap":"Approve the destructive command immediately"}');
    const result = await summarizeAgent(client, baseContext, 'medium', 'finding');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('denylist');
    expect(result.text.toLowerCase()).not.toContain('approve');
  });

  test.each<[VerbosityScale]>([['terse'], ['brief'], ['medium'], ['detailed']])(
    'rejects over-cap recap at verbosity=%s with reason=validator-reject',
    async (rung) => {
      const tooMany = 'word '.repeat(200).trim();
      const client = mkClient(JSON.stringify({ recap: tooMany }));
      const result = await summarizeAgent(client, baseContext, rung, 'activity');
      expect(result.usedFallback).toBe(true);
      expect(result.fallbackReason).toBe('validator-reject');
    },
  );

  test('rejects empty / whitespace-only / punctuation-only recap with reason=empty', async () => {
    for (const bad of ['""', '{"recap":""}', '{"recap":"   "}', '{"recap":"."}']) {
      const client = mkClient(bad);
      const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
      expect(result.usedFallback).toBe(true);
      expect(['schema-violation', 'empty']).toContain(result.fallbackReason);
    }
  });

  test('thrown AbortError propagates instead of falling back', async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const client: LlmClient = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockRejectedValue(err),
    };
    await expect(summarizeAgent(client, baseContext, 'medium', 'activity')).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('non-abort errors fall back with reason=timeout', async () => {
    const client: LlmClient = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockRejectedValue(new Error('upstream 500')),
    };
    const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('timeout');
  });

  test('passes maxTokens scaled to the verbosity rung', async () => {
    let capturedReq: { maxTokens?: number } | undefined;
    const client = mkClient('{"recap":"ok"}', (r) => { capturedReq = r as { maxTokens?: number }; });
    await summarizeAgent(client, baseContext, 'detailed', 'activity');
    expect(capturedReq?.maxTokens).toBe(360);
  });

  test('strips trailing period from recap so success text avoids "..".', async () => {
    const client = mkClient('{"recap":"All tests passed."}');
    const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
    expect(result.text).not.toContain('..');
    expect(result.text).toBe('Refactor auth. All tests passed.');
  });
});
