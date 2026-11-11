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
    expect(text).toBe('Refactor auth needs your input.');
    expect(text).not.toContain('needs_input');
  });

  test('terse speaks an unknown anomaly type as plain words', () => {
    const text = buildFallbackText(
      { ...baseContext, anomaly: { type: 'disk_almost_full', severity: 'info', explanation: 'x' } },
      'terse',
    );
    expect(text).toBe('Refactor auth. disk almost full.');
  });

  test('medium finding fallback makes the explanation speakable', () => {
    const text = buildFallbackText(
      {
        ...baseContext,
        anomaly: { type: 'api_error', severity: 'warning', explanation: 'Call to /v1/messages failed: max_retries hit' },
      },
      'medium',
    );
    expect(text).toContain('max retries hit');
    expect(text).not.toContain('max_retries');
  });

  test('terse without anomaly uses the "working" placeholder', () => {
    const text = buildFallbackText(baseContext, 'terse');
    expect(text).toBe('Refactor auth. working.');
  });

  test.each([
    ['terse', '12. working.'],
    ['brief', '12. working.'],
  ] as const)('a task named with a number keeps its number at verbosity %s', (verbosity, expected) => {
    // "12. working." used to lose the "12" as if it were a numbered-list marker.
    expect(buildFallbackText({ ...baseContext, taskName: '12' }, verbosity)).toBe(expected);
    expect(buildFallbackText({ ...baseContext, taskName: '3' }, verbosity)).toBe('3. working.');
  });

  test('a task named with only an id is called "This task", never nothing and never "an ID"', () => {
    const text = buildFallbackText({ ...baseContext, taskName: '123e4567-e89b-12d3-a456-426614174000' }, 'terse');
    expect(text).toBe('This task is working.');
  });

  describe('a long, cut or missing task title is never read aloud (#3605)', () => {
    const longTitle = 'i lost approximetaly 6-7 kookr tasks that had hitten limits, can you check whic...';
    const anomaly = { type: 'needs_input', severity: 'warning', explanation: 'Agent asked which branch to use.' };

    test.each(['terse', 'brief'] as const)('%s: no anomaly speaks "This task is working."', (verbosity) => {
      expect(buildFallbackText({ ...baseContext, taskName: longTitle }, verbosity)).toBe('This task is working.');
      expect(buildFallbackText({ ...baseContext, taskName: 'Untitled task' }, verbosity)).toBe('This task is working.');
      expect(buildFallbackText({ ...baseContext, taskName: '' }, verbosity)).toBe('This task is working.');
    });

    test.each(['terse', 'brief'] as const)('%s: an anomaly speaks "This task needs your input."', (verbosity) => {
      expect(buildFallbackText({ ...baseContext, taskName: longTitle, anomaly }, verbosity)).toBe(
        'This task needs your input.',
      );
    });

    test('a short complete title keeps the exact wording', () => {
      const named = { ...baseContext, taskName: 'Repository Idea Scout' };
      expect(buildFallbackText(named, 'terse')).toBe('Repository Idea Scout. working.');
      expect(buildFallbackText({ ...named, anomaly }, 'brief')).toBe('Repository Idea Scout needs your input.');
    });

    test('an unknown anomaly type is reported on "This task" with the type in words', () => {
      const text = buildFallbackText(
        { ...baseContext, taskName: longTitle, anomaly: { ...anomaly, type: 'weird_state' } },
        'terse',
      );
      expect(text).toBe('This task reported weird state.');
    });

    test('a title cut with an ellipsis is generic even when it is short', () => {
      expect(buildFallbackText({ ...baseContext, taskName: 'Fix the login…' }, 'terse')).toBe('This task is working.');
    });

    test.each(['medium', 'detailed'] as const)('%s: the name sentence is left out, not spoken as "This task."', (verbosity) => {
      const text = buildFallbackText({ ...baseContext, taskName: longTitle }, verbosity);
      expect(text).not.toContain('This task.');
      expect(text).not.toContain('lost approximetaly');
      expect(text).toContain('read 2 files');
    });

    test.each(['medium', 'detailed'] as const)('%s: with nothing else to say, speaks "This task is working."', (verbosity) => {
      const quiet = { ...baseContext, taskName: longTitle, recentActivity: '(no recent activity)', recentMessages: '(no recent messages)' };
      expect(buildFallbackText(quiet, verbosity)).toBe('This task is working.');
    });

    test.each(['medium', 'detailed'] as const)('%s: a short title still leads the text', (verbosity) => {
      expect(buildFallbackText(baseContext, verbosity)).toMatch(/^Refactor auth\. /);
    });

    test('the fallback stays idempotent through the speakable step', async () => {
      const { makeSpeakable } = await import('./speakable-text.js');
      for (const verbosity of ['terse', 'brief', 'medium', 'detailed'] as const) {
        for (const taskName of [longTitle, 'Untitled task', 'Refactor auth']) {
          const text = buildFallbackText({ ...baseContext, taskName, anomaly }, verbosity);
          expect(makeSpeakable(text)).toBe(text);
        }
      }
    });
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

describe('system prompt speakability rules', () => {
  test.each<['finding' | 'activity']>([['finding'], ['activity']])('mode %s forbids paths, urls and identifiers', (mode) => {
    const prompt = buildSystemPrompt(mode, 'medium');
    expect(prompt).toContain('Never include file paths, URLs, commit hashes');
    expect(prompt).toContain('plain spoken English');
  });

  test('finding mode asks for plain-word finding phrasing', () => {
    expect(buildSystemPrompt('finding', 'brief')).toContain('needs your input');
  });
});

describe('summarizeAgent', () => {
  test('success text is made speakable and rawText keeps the pre-transform wording', async () => {
    const client = mkClient('{"recap":"Edited `src/core/foo-bar.ts` for #3608."}');
    const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
    expect(result.usedFallback).toBe(false);
    expect(result.text).toBe('Refactor auth. Edited foo-bar.ts for number 3608.');
    expect(result.rawText).toBe('Refactor auth. Edited `src/core/foo-bar.ts` for #3608.');
  });

  describe('a secret in the task title or in the model recap', () => {
    const secretTitle = 'Rotate sk-abcdefghijklmnop';

    test('is hidden in the prompt and in the spoken text when the model repeats the title', async () => {
      let prompt = '';
      const client = mkClient('{"recap":"Working on Rotate sk-abcdefghijklmnop now."}', (req) => {
        prompt = (req as { userMessage: string }).userMessage;
      });
      const result = await summarizeAgent(client, { ...baseContext, taskName: secretTitle }, 'medium', 'activity');
      expect(prompt).not.toContain('sk-abcdefghijklmnop');
      expect(prompt).toContain('Rotate [redacted]');
      expect(result.text).not.toContain('sk-abcdefghijklmnop');
      expect(result.rawText ?? '').not.toContain('sk-abcdefghijklmnop');
      expect(result.usedFallback).toBe(false);
    });

    test('is hidden when the recap carries a secret that is not in the title', async () => {
      const client = mkClient('{"recap":"Used key sk-abcdefghijklmnop to deploy."}');
      const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
      expect(result.text).not.toContain('sk-abcdefghijklmnop');
      expect(result.text).toContain('Used key');
      expect(result.text).toContain('to deploy');
    });
  });

  test('rawText is absent when the recap needed no changes', async () => {
    const client = mkClient('{"recap":"All tests passed."}');
    const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
    expect(result.text).toBe('Refactor auth. All tests passed.');
    expect('rawText' in result).toBe(false);
  });

  test('fallback text is made speakable and rawText is set only when it changed', async () => {
    const changed = await summarizeAgent(
      null,
      { ...baseContext, recentActivity: 'edited src/core/foo.ts' },
      'medium',
      'activity',
    );
    expect(changed.text).toContain('edited foo.ts');
    expect(changed.rawText).toContain('src/core/foo.ts');

    const unchanged = await summarizeAgent(
      null,
      { ...baseContext, anomaly: { type: 'needs_input', severity: 'info', explanation: 'x' } },
      'terse',
      'finding',
    );
    expect(unchanged.text).toBe('Refactor auth needs your input.');
    expect('rawText' in unchanged).toBe(false);
  });

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
    const call = (client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.useCase).toBe('agent_speech_summary');
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

  test('re-applies the denylist after the speakable rewrite (approve_request -> "approve request")', async () => {
    const client = mkClient('{"recap":"Waiting on approve_request from the user"}');
    const result = await summarizeAgent(client, baseContext, 'medium', 'finding');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('denylist');
    expect(result.text.toLowerCase()).not.toContain('approve');
  });

  test('re-applies the denylist for run_tests-style identifiers', async () => {
    const client = mkClient('{"recap":"Agent chose run_tests next"}');
    const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('denylist');
  });

  test('denylist still fires for push_notifications-style identifiers', async () => {
    const client = mkClient('{"recap":"Agent edited push_notifications settings"}');
    const result = await summarizeAgent(client, baseContext, 'medium', 'activity');
    expect(result.usedFallback).toBe(true);
    expect(result.fallbackReason).toBe('denylist');
  });

  test.each<[VerbosityScale]>([['terse'], ['brief'], ['medium'], ['detailed']])(
    'a commit hash does not trip the denylist at verbosity=%s',
    async (rung) => {
      for (const recap of ['Tests pass on abc1234 after the refactor.', 'Rebased onto 3f2a9c1 and tests are green.']) {
        const result = await summarizeAgent(mkClient(JSON.stringify({ recap })), baseContext, rung, 'activity');
        expect(result.usedFallback).toBe(false);
        expect(result.fallbackReason).toBeNull();
        expect(result.text).toContain('a commit');
      }
    },
  );

  test.each<[VerbosityScale, number]>([['terse', 15], ['brief', 30], ['medium', 60], ['detailed', 120]])(
    'an at-cap recap that grows when "#42" becomes "number 42" is accepted at verbosity=%s',
    async (rung, maxWords) => {
      const recap = `${Array(maxWords - 1).fill('ok').join(' ')} #42`;
      const result = await summarizeAgent(mkClient(JSON.stringify({ recap })), baseContext, rung, 'activity');
      expect(result.usedFallback).toBe(false);
      expect(result.text).toContain('number 42');
    },
  );

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

describe('multi-line markdown reaches the fallback as sentences', () => {
  test('a markdown anomaly explanation is made speakable before it is joined', () => {
    const text = buildFallbackText(
      {
        ...baseContext,
        anomaly: {
          type: 'needs_input',
          severity: 'info',
          explanation: '## Question\n- Which branch should I use?\n- Is /home/jean/git/kookr/src/a.ts the right file?',
        },
      },
      'medium',
    );
    expect(text).toBe(
      'Refactor auth. read 2 files, edited 1 file. Question. Which branch should I use? Is a.ts the right file?',
    );
    expect(text).not.toMatch(/##|\s-\s/);
  });

  test('an anomaly explanation with a table has no pipes left', async () => {
    const result = await summarizeAgent(
      null,
      {
        ...baseContext,
        anomaly: { type: 'api_error', severity: 'info', explanation: '| code | meaning |\n|---|---|\n| 429 | rate limited |' },
      },
      'detailed',
      'finding',
    );
    expect(result.text).toBe('Refactor auth. read 2 files, edited 1 file. code, meaning. 429, rate limited.');
  });
});


describe('the task title in the spoken text (#3605)', () => {
  const prodTitle = 'i lost approximetaly 6-7 kookr tasks that had hitten limits, can you check whic...';
  const secretTitle = 'Rotate key sk-abcdefghijklmnopqrstuvwxyz123456';
  const anomaly = { type: 'needs_input', severity: 'warning', explanation: 'Agent asked which branch to use.' };
  const rungs = ['terse', 'brief', 'medium', 'detailed'] as const;

  describe('LLM success path', () => {
    test('a long, cut-off title is not spoken: the text is the recap and a period', async () => {
      const client = mkClient('{"recap":"Working through the limit checks"}');
      const result = await summarizeAgent(client, { ...baseContext, taskName: prodTitle }, 'medium', 'activity');
      expect(result.usedFallback).toBe(false);
      expect(result.text).toBe('Working through the limit checks.');
      expect(result.text).not.toMatch(/approximetaly|kookr|whic/i);
    });

    test('a short complete title still leads the text (control)', async () => {
      const client = mkClient('{"recap":"Working through the limit checks"}');
      const result = await summarizeAgent(client, { ...baseContext, taskName: 'Refactor auth.' }, 'medium', 'activity');
      expect(result.text).toBe('Refactor auth. Working through the limit checks.');
    });

    test('a title that holds a secret is never spoken, and the text is the recap and a period', async () => {
      const client = mkClient('{"recap":"Working through the key rotation"}');
      const result = await summarizeAgent(client, { ...baseContext, taskName: secretTitle }, 'medium', 'activity');
      expect(result.text).toBe('Working through the key rotation.');
      expect(result.text).not.toMatch(/sk-|abcdefgh|Rotate|redacted/i);
      expect(result.rawText).toBeUndefined();
    });
  });

  describe('fallback path: a title that holds a secret is never spoken', () => {
    test.each(rungs)('%s: no title, no secret, no placeholder', (verbosity) => {
      for (const withAnomaly of [false, true]) {
        const context = { ...baseContext, taskName: secretTitle, ...(withAnomaly ? { anomaly } : {}) };
        const text = buildFallbackText(context, verbosity);
        expect(text).not.toMatch(/sk-|abcdefgh|Rotate|redacted/i);
      }
    });

    test.each(['terse', 'brief'] as const)('%s: the task is called "This task"', (verbosity) => {
      expect(buildFallbackText({ ...baseContext, taskName: secretTitle }, verbosity)).toBe('This task is working.');
      expect(buildFallbackText({ ...baseContext, taskName: secretTitle, anomaly }, verbosity)).toBe('This task needs your input.');
    });

    test.each(['medium', 'detailed'] as const)('%s: the name sentence is left out', (verbosity) => {
      const text = buildFallbackText({ ...baseContext, taskName: secretTitle }, verbosity);
      expect(text).toContain('read 2 files');
      expect(text).not.toContain('This task.');
    });

    test('through summarizeAgent without a client', async () => {
      const result = await summarizeAgent(null, { ...baseContext, taskName: secretTitle }, 'terse', 'activity');
      expect(result.text).toBe('This task is working.');
    });
  });
});
