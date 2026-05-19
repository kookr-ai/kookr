import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assembleTaskContext,
  decideInjection,
  formatGateDebugEcho,
  formatInjectedContext,
  nextTurnId,
  parseKbSearchResponse,
  readCheckpointTaskContext,
  runKbContextInjection,
  type KbSearchExec,
  type TurnIdFsDeps,
} from './kb-context-injection.js';
import { runHook } from './kb-context-injection-hook.js';
import {
  RELEVANCE_GATE_SCHEMA_VERSION,
  RelevanceGateSchemaError,
  type RelevanceGateVerdict,
} from './relevance-gate-schema.js';

// --- builders ---------------------------------------------------------------

function verdict(overrides: Partial<RelevanceGateVerdict> = {}): RelevanceGateVerdict {
  return {
    schema_version: RELEVANCE_GATE_SCHEMA_VERSION,
    state: 'injected',
    low_confidence: false,
    input_count: 3,
    output_count: 2,
    dropped: [],
    judge: { status: 'succeeded' },
    empty_verdict_enabled: true,
    ...overrides,
  };
}

function searchPayload(
  verdictOverrides: Partial<RelevanceGateVerdict>,
  results: unknown[],
): string {
  return JSON.stringify({ results, gate_verdict: verdict(verdictOverrides) });
}

function execReturning(stdout: string, exitCode = 0): (args: string[]) => Promise<KbSearchExec> {
  return async () => ({ stdout, stderr: '', exitCode });
}

// --- assembleTaskContext ----------------------------------------------------

describe('assembleTaskContext', () => {
  it('stamps the turn id and includes the prompt', () => {
    const ctx = assembleTaskContext({ prompt: 'how does X work', turnId: 7, checkpoint: null });
    expect(ctx).toContain('[kookr-turn 7]');
    expect(ctx).toContain('Current request: how does X work');
  });

  it('folds in CHECKPOINT.json task_id and next_actions', () => {
    const ctx = assembleTaskContext({
      prompt: 'continue',
      turnId: 2,
      checkpoint: { taskId: 'rfc-018-m2', nextActions: ['wire the hook', 'add tests'] },
    });
    expect(ctx).toContain('Active task: rfc-018-m2');
    expect(ctx).toContain('- wire the hook');
  });

  it('hard-truncates to 2000 chars (RFC §1)', () => {
    const ctx = assembleTaskContext({ prompt: 'x'.repeat(5000), turnId: 1, checkpoint: null });
    expect(ctx.length).toBe(2000);
  });
});

// --- readCheckpointTaskContext ----------------------------------------------

describe('readCheckpointTaskContext', () => {
  const validCheckpoint = JSON.stringify({
    schema_version: 'semantic-checkpoint.v1',
    task_id: 'rfc-018-m2',
    next_actions: ['ship the hook', 42, 'add tests'],
  });

  it('returns null when no checkpoint dir is set', async () => {
    expect(await readCheckpointTaskContext(undefined)).toBeNull();
  });

  it('extracts task_id and string next_actions', async () => {
    const result = await readCheckpointTaskContext('/cp', async () => validCheckpoint);
    expect(result).toEqual({ taskId: 'rfc-018-m2', nextActions: ['ship the hook', 'add tests'] });
  });

  it('fail-softs to null on a wrong schema_version', async () => {
    const bad = JSON.stringify({ schema_version: 'other.v9', task_id: 'x' });
    expect(await readCheckpointTaskContext('/cp', async () => bad)).toBeNull();
  });

  it('fail-softs to null on malformed JSON or a read error', async () => {
    expect(await readCheckpointTaskContext('/cp', async () => 'not json')).toBeNull();
    expect(await readCheckpointTaskContext('/cp', async () => { throw new Error('ENOENT'); })).toBeNull();
  });
});

// --- nextTurnId -------------------------------------------------------------

describe('nextTurnId', () => {
  it('increments monotonically per session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-turn-'));
    expect(await nextTurnId('sess-a', dir)).toBe(1);
    expect(await nextTurnId('sess-a', dir)).toBe(2);
    expect(await nextTurnId('sess-a', dir)).toBe(3);
  });

  it('tracks sessions independently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kookr-turn-'));
    expect(await nextTurnId('sess-a', dir)).toBe(1);
    expect(await nextTurnId('sess-b', dir)).toBe(1);
    expect(await nextTurnId('sess-a', dir)).toBe(2);
  });

  it('resets to 1 on a corrupt counter file', async () => {
    const deps: TurnIdFsDeps = {
      readFileImpl: async () => 'not-a-number',
      writeFileImpl: async () => undefined,
      mkdirImpl: async () => undefined,
    };
    expect(await nextTurnId('s', '/state', deps)).toBe(1);
  });

  it('stays non-decreasing when the counter cannot be persisted', async () => {
    const deps: TurnIdFsDeps = {
      readFileImpl: async () => { throw new Error('ENOENT'); },
      writeFileImpl: async () => { throw new Error('EROFS'); },
      mkdirImpl: async () => { throw new Error('EROFS'); },
    };
    const first = await nextTurnId('s', '/state', deps);
    const second = await nextTurnId('s', '/state', deps);
    expect(first).toBe(1);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});

// --- parseKbSearchResponse --------------------------------------------------

describe('parseKbSearchResponse', () => {
  it('parses results and validates gate_verdict', () => {
    const parsed = parseKbSearchResponse(searchPayload({}, [
      { source: 'kb/a.md', content: 'alpha content' },
      { path: 'kb/b.md', text: 'beta content' },
    ]));
    expect(parsed.gateVerdict.state).toBe('injected');
    expect(parsed.results).toEqual([
      { source: 'kb/a.md', content: 'alpha content' },
      { source: 'kb/b.md', content: 'beta content' },
    ]);
  });

  it('throws on non-JSON output', () => {
    expect(() => parseKbSearchResponse('kb: error')).toThrow(/did not return JSON/);
  });

  it('throws RelevanceGateSchemaError on a contract break', () => {
    const wrong = JSON.stringify({ results: [], gate_verdict: { state: 'injected' } });
    expect(() => parseKbSearchResponse(wrong)).toThrow(RelevanceGateSchemaError);
    const wrongVersion = JSON.stringify({
      results: [],
      gate_verdict: { ...verdict(), schema_version: 'kb.relevance-gate.v2' },
    });
    expect(() => parseKbSearchResponse(wrongVersion)).toThrow(RelevanceGateSchemaError);
  });
});

// --- decideInjection --------------------------------------------------------

describe('decideInjection', () => {
  const item = { source: 'kb/a.md', content: 'alpha' };

  it('injects the post-gate set for an injected verdict', () => {
    const d = decideInjection({ results: [item], gateVerdict: verdict({ state: 'injected' }) });
    expect(d.inject).toBe(true);
    expect(d.items).toEqual([item]);
  });

  it('propagates low_confidence', () => {
    const d = decideInjection({
      results: [item],
      gateVerdict: verdict({ state: 'injected', low_confidence: true }),
    });
    expect(d.inject).toBe(true);
    expect(d.lowConfidence).toBe(true);
  });

  it('injects nothing on no-relevant-context', () => {
    const d = decideInjection({ results: [], gateVerdict: verdict({ state: 'no-relevant-context' }) });
    expect(d.inject).toBe(false);
    expect(d.emptyIndex).toBe(false);
  });

  it('injects nothing on empty-index but flags the absence', () => {
    const d = decideInjection({ results: [], gateVerdict: verdict({ state: 'empty-index' }) });
    expect(d.inject).toBe(false);
    expect(d.emptyIndex).toBe(true);
  });

  it('treats a bypassed verdict identically to injected', () => {
    const d = decideInjection({ results: [item], gateVerdict: verdict({ state: 'bypassed' }) });
    expect(d.inject).toBe(true);
    expect(d.items).toEqual([item]);
  });

  it('injects nothing when an injected verdict carries no results', () => {
    const d = decideInjection({ results: [], gateVerdict: verdict({ state: 'injected' }) });
    expect(d.inject).toBe(false);
  });
});

// --- formatting -------------------------------------------------------------

describe('formatInjectedContext', () => {
  it('renders a system-reminder block with the snippets', () => {
    const out = formatInjectedContext(
      { inject: true, items: [{ source: 'kb/a.md', content: 'alpha' }], lowConfidence: false, state: 'injected', emptyIndex: false },
      5,
    );
    expect(out).toContain('<system-reminder>');
    expect(out).toContain('turn 5');
    expect(out).toContain('[kb/a.md]');
    expect(out).toContain('alpha');
  });

  it('flags every snippet when low_confidence is set', () => {
    const out = formatInjectedContext(
      { inject: true, items: [{ source: 'kb/a.md', content: 'alpha' }], lowConfidence: true, state: 'injected', emptyIndex: false },
      1,
    );
    expect(out).toContain('[low-confidence]');
  });

  it('returns empty string when nothing is injected', () => {
    expect(formatInjectedContext(
      { inject: false, items: [], lowConfidence: false, state: 'no-relevant-context', emptyIndex: false },
      1,
    )).toBe('');
  });
});

describe('formatGateDebugEcho', () => {
  it('reports state, kept count, and by-stage drop counts', () => {
    const echo = formatGateDebugEcho(verdict({
      dropped: [
        { id: 'c1', stage: 'A1-score-floor', reason: 'r' },
        { id: 'c2', stage: 'B-judge', reason: 'r' },
      ],
    }));
    expect(echo).toContain('state=injected');
    expect(echo).toContain('drops(A1=1 A2=0 B=1 other=0)');
  });

  it('reports degraded=true when the judge failed', () => {
    expect(formatGateDebugEcho(verdict({ judge: { status: 'failed', reason: 'x' } })))
      .toContain('degraded=true');
  });

  it('buckets A2 drops and unrecognized stages', () => {
    const echo = formatGateDebugEcho(verdict({
      dropped: [
        { id: 'c1', stage: 'A2-distribution-knee', reason: 'r' },
        { id: 'c2', stage: 'mystery-stage', reason: 'r' },
      ],
    }));
    expect(echo).toContain('drops(A1=0 A2=1 B=0 other=1)');
  });
});

// --- runKbContextInjection (orchestration) ----------------------------------

async function tmpStateDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'kookr-kbinj-'));
}

describe('runKbContextInjection', () => {
  it('injects the gated context and echoes the verdict on an injected verdict', async () => {
    const stateDir = await tmpStateDir();
    let capturedArgs: string[] = [];
    const result = await runKbContextInjection(
      { prompt: 'how does atomic save work', sessionId: 's1' },
      {
        env: {},
        stateDir,
        execKbSearch: async (args) => {
          capturedArgs = args;
          return { stdout: searchPayload({ state: 'injected' }, [{ source: 'kb/a.md', content: 'atomic save uses a symlink swap' }]), stderr: '', exitCode: 0 };
        },
      },
    );
    expect(capturedArgs).toContain('--gate');
    expect(capturedArgs).toContain('--format=json');
    expect(capturedArgs.some((a) => a.startsWith('--task-context-file='))).toBe(true);
    expect(result.stdout).toContain('atomic save uses a symlink swap');
    expect(result.stderr).toContain('state=injected');
  });

  it('injects NOTHING on a no-relevant-context verdict', async () => {
    const result = await runKbContextInjection(
      { prompt: 'unrelated question', sessionId: 's2' },
      { env: {}, stateDir: await tmpStateDir(), execKbSearch: execReturning(searchPayload({ state: 'no-relevant-context' }, [])) },
    );
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('state=no-relevant-context');
  });

  it('injects NOTHING on an empty-index verdict and surfaces the absence', async () => {
    const result = await runKbContextInjection(
      { prompt: 'anything', sessionId: 's3' },
      { env: {}, stateDir: await tmpStateDir(), execKbSearch: execReturning(searchPayload({ state: 'empty-index' }, [])) },
    );
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('kb index is empty');
  });

  it('flags low-confidence context per snippet', async () => {
    const result = await runKbContextInjection(
      { prompt: 'weak match query', sessionId: 's4' },
      {
        env: {},
        stateDir: await tmpStateDir(),
        execKbSearch: execReturning(searchPayload({ state: 'injected', low_confidence: true }, [{ source: 'kb/a.md', content: 'maybe relevant' }])),
      },
    );
    expect(result.stdout).toContain('[low-confidence]');
  });

  it('fail-opens (injects nothing) when kb search exits non-zero', async () => {
    const result = await runKbContextInjection(
      { prompt: 'q', sessionId: 's5' },
      { env: {}, stateDir: await tmpStateDir(), execKbSearch: execReturning('', 1) },
    );
    expect(result.stdout).toBe('');
  });

  it('fail-opens when kb search returns malformed output', async () => {
    const result = await runKbContextInjection(
      { prompt: 'q', sessionId: 's6' },
      { env: {}, stateDir: await tmpStateDir(), execKbSearch: execReturning('not json at all') },
    );
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('skipped');
  });

  it('does nothing for an empty prompt', async () => {
    const result = await runKbContextInjection(
      { prompt: '   ', sessionId: 's7' },
      { env: {}, stateDir: await tmpStateDir(), execKbSearch: execReturning(searchPayload({}, [])) },
    );
    expect(result.stdout).toBe('');
  });

  it('folds CHECKPOINT.json into the task_context passed to kb search', async () => {
    const cpDir = await mkdtemp(join(tmpdir(), 'kookr-cp-'));
    await writeFile(join(cpDir, 'CHECKPOINT.json'), JSON.stringify({
      schema_version: 'semantic-checkpoint.v1',
      task_id: 'rfc-018-m2',
      next_actions: ['wire the hook'],
    }), 'utf-8');
    let taskContext = '';
    await runKbContextInjection(
      { prompt: 'continue the work', sessionId: 'cp1' },
      {
        env: { TASK_CHECKPOINT_DIR: cpDir },
        stateDir: await tmpStateDir(),
        execKbSearch: async (args) => {
          const tcArg = args.find((a) => a.startsWith('--task-context-file='));
          if (tcArg !== undefined) {
            taskContext = await readFile(tcArg.slice('--task-context-file='.length), 'utf-8');
          }
          return {
            stdout: searchPayload({ state: 'injected' }, [{ source: 'kb/a.md', content: 'x' }]),
            stderr: '',
            exitCode: 0,
          };
        },
      },
    );
    expect(taskContext).toContain('Active task: rfc-018-m2');
    expect(taskContext).toContain('wire the hook');
  });
});

// --- runHook (UserPromptSubmit entry) ---------------------------------------

describe('runHook', () => {
  const enabledEnv = { KOOKR_KB_CONTEXT_INJECT: '1' };

  function event(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      session_id: 's',
      cwd: '/repo',
      hook_event_name: 'UserPromptSubmit',
      prompt: 'how does X work',
      ...overrides,
    });
  }

  it('is inert when the opt-in env var is unset', async () => {
    let called = false;
    const result = await runHook(event(), {
      env: {},
      execKbSearch: async () => { called = true; return { stdout: '', stderr: '', exitCode: 0 }; },
    });
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(called).toBe(false);
  });

  it('runs the injection when enabled on a UserPromptSubmit event', async () => {
    const result = await runHook(event(), {
      env: enabledEnv,
      stateDir: await tmpStateDir(),
      execKbSearch: execReturning(searchPayload({ state: 'injected' }, [{ source: 'kb/a.md', content: 'relevant note' }])),
    });
    expect(result.stdout).toContain('relevant note');
    expect(result.exitCode).toBe(0);
  });

  it('ignores non-UserPromptSubmit events', async () => {
    const result = await runHook(event({ hook_event_name: 'Stop' }), {
      env: enabledEnv,
      execKbSearch: execReturning(searchPayload({}, [])),
    });
    expect(result.stdout).toBe('');
  });

  it('skips synthetic <task-notification> re-entries', async () => {
    const result = await runHook(event({ prompt: '<task-notification>done</task-notification>' }), {
      env: enabledEnv,
      execKbSearch: execReturning(searchPayload({}, [])),
    });
    expect(result.stdout).toBe('');
  });

  it('fail-opens on malformed stdin without throwing', async () => {
    const result = await runHook('{not json', { env: enabledEnv, execKbSearch: execReturning('') });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
  });
});
