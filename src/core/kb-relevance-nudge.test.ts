import { describe, it, expect } from 'vitest';
import {
  decideNudge,
  formatNudge,
  isNudgeEligiblePrompt,
  nudgeMaxDistance,
  parseScoredSources,
  runKbNudge,
  shelfOf,
  NUDGE_MAX_DISTANCE_DEFAULT,
  type ScoredSource,
} from './kb-relevance-nudge.js';
import type { KbSearchExec } from './kb-context-injection.js';
import { hookMode, runHook } from './kb-context-injection-hook.js';

// --- builders ---------------------------------------------------------------

// The real `kb search --format=json` emits `chunk_id` (never a top-level
// `source`), so fixtures mirror that shape — otherwise the happy-path tests
// would exercise a code branch production never hits (correctness review).
function searchPayload(results: Array<{ score: number; chunk_id: string }>): string {
  return JSON.stringify({
    results: results.map((r) => ({ score: r.score, chunk_id: r.chunk_id, content: 'x' })),
    gate_verdict: { state: 'bypassed' },
  });
}

function execReturning(exec: Partial<KbSearchExec>): (args: string[]) => Promise<KbSearchExec> {
  return () => Promise.resolve({ stdout: '', stderr: '', exitCode: 0, ...exec });
}

// --- eligibility ------------------------------------------------------------

describe('isNudgeEligiblePrompt', () => {
  it('rejects empty and whitespace prompts', () => {
    expect(isNudgeEligiblePrompt('')).toBe(false);
    expect(isNudgeEligiblePrompt('   ')).toBe(false);
  });

  it('rejects short glue / approval / command turns', () => {
    for (const glue of [
      'yes',
      'ok',
      'proceed',
      'go ahead',
      'yes push the PR',
      'push it and open the PR',
      'merge it',
      'lgtm',
      'do it',
      'continue',
      'thanks!',
    ]) {
      expect(isNudgeEligiblePrompt(glue), glue).toBe(false);
    }
  });

  it('rejects prompts under the minimum word count', () => {
    expect(isNudgeEligiblePrompt('fix the auth bug')).toBe(false); // 4 words
  });

  it('pins the 6-word boundary', () => {
    expect(isNudgeEligiblePrompt('fix the broken auth retry')).toBe(false); // 5 words → reject
    expect(isNudgeEligiblePrompt('fix the broken auth token retry')).toBe(true); // 6 words → accept
  });

  it('accepts a substantive information-need prompt', () => {
    expect(
      isNudgeEligiblePrompt('How should the supervisor recover a task after an exhausted review loop?'),
    ).toBe(true);
  });

  it('strips the playbook context header before judging eligibility', () => {
    const prompt =
      '> _Kookr playbook context_ — foo.md\n\nDesign a retry policy for the orchestration worker pool';
    expect(isNudgeEligiblePrompt(prompt)).toBe(true);
  });
});

// --- parsing ----------------------------------------------------------------

describe('shelfOf', () => {
  it('takes the first path segment as the shelf', () => {
    expect(shelfOf('agent-task-lessons/notes/foo.md#L1')).toBe('agent-task-lessons');
    expect(shelfOf('./llm-agents/x')).toBe('llm-agents');
    expect(shelfOf('solo')).toBe('solo');
    expect(shelfOf('')).toBe('');
  });
});

describe('parseScoredSources', () => {
  it('extracts (shelf, distance) pairs and skips malformed entries', () => {
    const stdout = JSON.stringify({
      results: [
        { score: 0.5, source: 'agent-task-lessons/a.md' },
        { score: 'nope', source: 'x/y' }, // non-numeric score → skipped
        { source: 'z/w' }, // no score → skipped
        { score: 0.7, chunk_id: 'llm-agents/b.md#2' }, // falls back to chunk_id
      ],
    });
    expect(parseScoredSources(stdout)).toEqual<ScoredSource[]>([
      { shelf: 'agent-task-lessons', distance: 0.5 },
      { shelf: 'llm-agents', distance: 0.7 },
    ]);
  });

  it('returns [] on non-JSON, non-object, or error payloads', () => {
    expect(parseScoredSources('not json')).toEqual([]);
    expect(parseScoredSources('[]')).toEqual([]);
    expect(parseScoredSources(JSON.stringify({ error: 'boom' }))).toEqual([]);
  });
});

// --- decision ---------------------------------------------------------------

describe('decideNudge', () => {
  it('nudges when a hit is at or below the distance threshold', () => {
    const d = decideNudge([{ shelf: 'agent-task-lessons', distance: 0.6 }], 0.8);
    expect(d).toEqual({ nudge: true, shelves: ['agent-task-lessons'], count: 1 });
  });

  it('does not nudge when every hit is above the threshold', () => {
    const d = decideNudge([{ shelf: 'x', distance: 0.9 }], 0.8);
    expect(d.nudge).toBe(false);
  });

  it('treats the threshold as inclusive (distance == max → nudge)', () => {
    expect(decideNudge([{ shelf: 'x', distance: 0.8 }], 0.8).nudge).toBe(true);
  });

  it('dedupes shelves, orders by closeness, and caps the shelf list', () => {
    const items: ScoredSource[] = [
      { shelf: 'b', distance: 0.7 },
      { shelf: 'a', distance: 0.5 },
      { shelf: 'a', distance: 0.55 },
      { shelf: 'c', distance: 0.6 },
      { shelf: 'd', distance: 0.65 },
    ];
    const d = decideNudge(items, 0.8);
    expect(d.count).toBe(5);
    expect(d.shelves).toEqual(['a', 'c', 'd']); // closest-first, distinct, max 3
  });
});

describe('nudgeMaxDistance', () => {
  it('defaults when unset or invalid, honors a valid override', () => {
    expect(nudgeMaxDistance({})).toBe(NUDGE_MAX_DISTANCE_DEFAULT);
    expect(nudgeMaxDistance({ KOOKR_KB_NUDGE_MAX_DISTANCE: 'abc' })).toBe(NUDGE_MAX_DISTANCE_DEFAULT);
    expect(nudgeMaxDistance({ KOOKR_KB_NUDGE_MAX_DISTANCE: '-1' })).toBe(NUDGE_MAX_DISTANCE_DEFAULT);
    expect(nudgeMaxDistance({ KOOKR_KB_NUDGE_MAX_DISTANCE: '0.65' })).toBe(0.65);
  });
});

// --- formatting -------------------------------------------------------------

describe('formatNudge', () => {
  it('is empty when not nudging', () => {
    expect(formatNudge({ nudge: false, shelves: [], count: 0 }, 'q')).toBe('');
  });

  it('names the shelves, count, and a ready kb search command', () => {
    const out = formatNudge({ nudge: true, shelves: ['agent-task-lessons', 'llm-agents'], count: 3 }, 'retry policy');
    expect(out).toContain('<system-reminder>');
    expect(out).toContain('[kb-nudge]');
    expect(out).toContain('3 notes');
    expect(out).toContain('agent-task-lessons, llm-agents');
    expect(out).toContain('kb search "retry policy"');
    expect(out).toContain('</system-reminder>');
  });

  it('uses the singular noun for a single note', () => {
    const out = formatNudge({ nudge: true, shelves: ['agent-task-lessons'], count: 1 }, 'q');
    expect(out).toContain('1 note ');
    expect(out).not.toContain('1 notes');
  });
});

// --- orchestration ----------------------------------------------------------

describe('runKbNudge', () => {
  const eligible = 'How should the supervisor recover a task after an exhausted review loop?';

  it('returns an empty nudge for an ineligible (glue) prompt without searching', async () => {
    let called = false;
    const res = await runKbNudge(
      { prompt: 'yes push the PR', sessionId: 's' },
      {
        execKbSearch: () => {
          called = true;
          return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
        },
        env: {},
      },
    );
    expect(res.stdout).toBe('');
    expect(called).toBe(false);
  });

  it('nudges when an eligible prompt yields a close hit', async () => {
    const res = await runKbNudge(
      { prompt: eligible, sessionId: 's' },
      {
        execKbSearch: execReturning({
          stdout: searchPayload([
            { score: 0.52, chunk_id: 'agent-task-lessons/recover.md#L1-L4' },
            { score: 0.61, chunk_id: 'llm-agents/loops.md#L2-L9' },
          ]),
        }),
        env: {},
      },
    );
    expect(res.stdout).toContain('[kb-nudge]');
    expect(res.stdout).toContain('agent-task-lessons');
  });

  it('does not nudge when no hit clears the threshold', async () => {
    const res = await runKbNudge(
      { prompt: eligible, sessionId: 's' },
      {
        execKbSearch: execReturning({ stdout: searchPayload([{ score: 0.95, chunk_id: 'x/y.md#L1' }]) }),
        env: {},
      },
    );
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('nudged=false');
  });

  it('fails open on a non-zero search exit', async () => {
    const res = await runKbNudge(
      { prompt: eligible, sessionId: 's' },
      { execKbSearch: execReturning({ exitCode: 1 }), env: {} },
    );
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('unavailable');
  });

  it('fails open when the search throws', async () => {
    const res = await runKbNudge(
      { prompt: eligible, sessionId: 's' },
      {
        execKbSearch: () => Promise.reject(new Error('boom')),
        env: {},
      },
    );
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('skipped');
  });

  it('honors a tightened KOOKR_KB_NUDGE_MAX_DISTANCE (two-sided)', async () => {
    const payload = searchPayload([{ score: 0.7, chunk_id: 'x/y.md#L1' }]);
    // Same payload nudges at the 0.8 default …
    const dflt = await runKbNudge(
      { prompt: eligible, sessionId: 's' },
      { execKbSearch: execReturning({ stdout: payload }), env: {} },
    );
    expect(dflt.stdout).toContain('[kb-nudge]');
    // … but is suppressed once the threshold is tightened below the hit.
    const tight = await runKbNudge(
      { prompt: eligible, sessionId: 's' },
      { execKbSearch: execReturning({ stdout: payload }), env: { KOOKR_KB_NUDGE_MAX_DISTANCE: '0.6' } },
    );
    expect(tight.stdout).toBe(''); // 0.7 > 0.6 → no nudge
  });

  it('runs an UNGATED search — no --gate, no --kb (the core promise)', async () => {
    let captured: string[] = [];
    await runKbNudge(
      { prompt: eligible, sessionId: 's' },
      {
        execKbSearch: (args) => {
          captured = args;
          return Promise.resolve({ stdout: searchPayload([{ score: 0.5, chunk_id: 'a/b.md#L1' }]), stderr: '', exitCode: 0 });
        },
        env: {},
      },
    );
    expect(captured).toContain('--format=json');
    expect(captured).not.toContain('--gate'); // no LLM judge → fast, no degradation
    expect(captured.some((a) => a.startsWith('--kb'))).toBe(false); // all shelves
  });
});

// --- hook mode dispatch -----------------------------------------------------

describe('hookMode', () => {
  it('resolves nudge, inject (+ legacy truthy), and off', () => {
    expect(hookMode({ KOOKR_KB_CONTEXT_INJECT: 'nudge' })).toBe('nudge');
    expect(hookMode({ KOOKR_KB_CONTEXT_INJECT: 'NUDGE' })).toBe('nudge'); // case-insensitive
    for (const v of ['inject', '1', 'true', 'on', 'yes']) {
      expect(hookMode({ KOOKR_KB_CONTEXT_INJECT: v }), v).toBe('inject');
    }
    for (const v of ['', 'bogus', '0', 'off']) {
      expect(hookMode({ KOOKR_KB_CONTEXT_INJECT: v }), v).toBe('off');
    }
    expect(hookMode({})).toBe('off');
  });
});

describe('runHook dispatch', () => {
  const event = (prompt: string) =>
    JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt });

  it('routes nudge mode to the nudge path (not the gated injection path)', async () => {
    let captured: string[] = [];
    const res = await runHook(
      event('How should the supervisor recover a task after an exhausted review loop?'),
      {
        execKbSearch: (args) => {
          captured = args;
          return Promise.resolve({ stdout: searchPayload([{ score: 0.5, chunk_id: 'agent-task-lessons/x.md#L1' }]), stderr: '', exitCode: 0 });
        },
        env: { KOOKR_KB_CONTEXT_INJECT: 'nudge' },
      },
    );
    expect(res.stdout).toContain('[kb-nudge]'); // proves dispatch to runKbNudge
    expect(res.stdout).not.toContain('kb-context-inject · turn'); // not the injection formatter
    expect(captured).not.toContain('--gate'); // nudge never gates
  });

  it('is inert when the mode is off', async () => {
    const res = await runHook(event('a substantive multi word information need prompt'), {
      execKbSearch: () => Promise.reject(new Error('should not run')),
      env: {},
    });
    expect(res).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });
});
