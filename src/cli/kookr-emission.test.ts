import { describe, expect, it } from 'vitest';
import {
  parseEmissionArgs,
  runEmissionCli,
  USAGE,
} from './kookr-emission.js';

function mkIo() {
  const logs: string[] = [];
  const errs: string[] = [];
  return {
    out: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errs.push(a.map(String).join(' ')) },
    logs,
    errs,
  };
}

describe('parseEmissionArgs', () => {
  it('parses plan with repo and requested', () => {
    expect(parseEmissionArgs(['plan', '--repo', 'o/r', '--requested', '10', '--json'])).toMatchObject({
      verb: 'plan',
      repo: 'o/r',
      requested: 10,
      json: true,
    });
  });

  it('parses equals-form flags', () => {
    expect(parseEmissionArgs(['dedupe', '--repo=o/r', '--title=Hello world'])).toMatchObject({
      verb: 'dedupe',
      repo: 'o/r',
      title: 'Hello world',
    });
  });
});

describe('runEmissionCli', () => {
  it('prints help', async () => {
    const io = mkIo();
    const code = await runEmissionCli(['--help'], io);
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toBe(USAGE);
  });

  it('plans with a mocked open list over the threshold', async () => {
    const io = mkIo();
    const open = Array.from({ length: 5 }, (_, i) => ({
      number: i + 1,
      title: `Issue ${i + 1}`,
      state: 'OPEN',
      url: `https://example/${i + 1}`,
    }));
    const code = await runEmissionCli(
      ['plan', '--repo', 'kookr-ai/kookr', '--requested', '10', '--json'],
      {
        ...io,
        runGh: (args) => {
          // plan: search total_count first, then issue list for sample/dedupe surface
          if (args[0] === 'api') return '65\n';
          expect(args[0]).toBe('issue');
          return JSON.stringify(open);
        },
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.plan.openBacklogCount).toBe(65);
    expect(payload.plan.allowedBudget).toBe(2);
    expect(payload.plan.action).toBe('constrain');
    expect(payload.plan.deferredCount).toBe(8);
    expect(payload.plan.overThreshold).toBe(true);
  });

  it('always logs a dedupe check line (stdout when not --json)', async () => {
    const io = mkIo();
    const code = await runEmissionCli(
      ['dedupe', '--repo', 'kookr-ai/kookr', '--title', 'Add dark mode toggle'],
      {
        ...io,
        runGh: () =>
          JSON.stringify([
            { number: 42, title: 'Add dark mode toggle', state: 'OPEN', url: 'https://x/42' },
          ]),
      },
    );
    expect(code).toBe(0);
    expect(io.logs[0]).toMatch(/^dedupe-check: DUPLICATE/);
    expect(io.logs[0]).toContain('#42');
  });

  it('with --json, emits one JSON on stdout and audit line on stderr', async () => {
    const io = mkIo();
    const code = await runEmissionCli(
      ['dedupe', '--repo', 'kookr-ai/kookr', '--title', 'Add dark mode toggle', '--json'],
      {
        ...io,
        runGh: () =>
          JSON.stringify([
            { number: 42, title: 'Add dark mode toggle', state: 'OPEN', url: 'https://x/42' },
          ]),
      },
    );
    expect(code).toBe(0);
    expect(io.errs[0]).toMatch(/^dedupe-check: DUPLICATE/);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.isDuplicate).toBe(true);
    expect(payload.match.number).toBe(42);
    expect(payload.logLine).toMatch(/DUPLICATE/);
  });

  it('returns 4 when gh fails', async () => {
    const io = mkIo();
    const code = await runEmissionCli(
      ['plan', '--repo', 'kookr-ai/kookr', '--requested', '1', '--json'],
      {
        ...io,
        runGh: () => {
          throw new Error('gh boom');
        },
      },
    );
    expect(code).toBe(4);
    expect(io.errs.join('\n')).toMatch(/gh boom/);
  });

  it('returns 2 on unknown verb', async () => {
    const io = mkIo();
    const code = await runEmissionCli(['explode', '--repo', 'o/r'], io);
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/unknown verb/);
  });

  it('metrics exposes netBacklogDelta7d', async () => {
    const io = mkIo();
    let call = 0;
    const code = await runEmissionCli(
      ['metrics', '--repo', 'kookr-ai/kookr', '--json'],
      {
        ...io,
        now: () => new Date('2026-07-27T12:00:00.000Z'),
        runGh: (args) => {
          // three search total_count calls
          call++;
          const q = args.find((a, i) => args[i - 1] === '-f' && a.startsWith('q=')) ?? '';
          if (q.includes('is:open')) return '83\n';
          if (q.includes('created:>=')) return '60\n';
          if (q.includes('closed:>=')) return '14\n';
          throw new Error(`unexpected gh args: ${args.join(' ')}`);
        },
      },
    );
    expect(code).toBe(0);
    expect(call).toBe(3);
    const payload = JSON.parse(io.logs[0]!);
    expect(payload.netBacklogDelta7d).toBe(46);
    expect(payload.opened7d).toBe(60);
    expect(payload.closed7d).toBe(14);
    expect(payload.openBacklogCount).toBe(83);
    expect(payload.emissionBudgetIfRequested10.allowedBudget).toBe(2);
  });

  it('defers by appending a JSONL line', async () => {
    const io = mkIo();
    const lines: Array<{ path: string; line: string }> = [];
    const code = await runEmissionCli(
      [
        'defer',
        '--repo',
        'kookr-ai/kookr',
        '--title',
        'Repository idea: deferred thing',
        '--source',
        'repository-idea-scout',
        '--json',
        '--kookr-dir',
        '/tmp/kookr-emission-test',
      ],
      {
        ...io,
        now: () => new Date('2026-07-27T00:00:00.000Z'),
        appendLine: (path, line) => lines.push({ path, line }),
      },
    );
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.path).toContain('deferred-ideas/kookr-ai-kookr.jsonl');
    const rec = JSON.parse(lines[0]!.line);
    expect(rec.title).toBe('Repository idea: deferred thing');
    expect(rec.source).toBe('repository-idea-scout');
  });

  it('returns 2 on missing required flags', async () => {
    const io = mkIo();
    const code = await runEmissionCli(['plan', '--repo', 'o/r'], io);
    expect(code).toBe(2);
    expect(io.errs.join('\n')).toMatch(/--requested/);
  });
});
