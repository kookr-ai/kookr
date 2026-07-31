import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEffortSplitArgs, runEffortSplitCli, UsageError } from './kookr-effort-split.js';
import type { GhRunner } from '../core/effort-split-gh.js';

function captureIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    out: { log: (...a: unknown[]) => logs.push(a.map(String).join(' ')) },
    err: { error: (...a: unknown[]) => errors.push(a.map(String).join(' ')) },
  };
}

/** Minimal gh mock that returns balanced 80/20-ish metrics for two repos. */
function balancedGhRunner(): GhRunner {
  return async (args) => {
    const joined = args.join(' ');
    if (joined.includes('pr list')) {
      const repo = args[args.indexOf('-R') + 1] ?? '';
      if (repo.includes('lucy')) {
        return JSON.stringify([
          { number: 1, additions: 80, deletions: 0, mergedAt: '2026-07-30T12:00:00Z' },
        ]);
      }
      return JSON.stringify([
        { number: 2, additions: 20, deletions: 0, mergedAt: '2026-07-30T12:00:00Z' },
      ]);
    }
    if (joined.includes('/commits')) {
      const isLucy = joined.includes('jeanibarz/lucy');
      const n = isLucy ? 8 : 2;
      return JSON.stringify(
        Array.from({ length: n }, (_, i) => ({
          sha: `${isLucy ? 'l' : 'k'}-${i}`,
          parents: [{ sha: 'p' }],
          commit: { committer: { date: '2026-07-30T12:00:00Z' } },
        })),
      );
    }
    throw new Error(`unexpected gh: ${joined}`);
  };
}

describe('parseEffortSplitArgs', () => {
  it('defaults repos and window', () => {
    const a = parseEffortSplitArgs([]);
    expect(a.repos).toEqual(['jeanibarz/lucy', 'kookr-ai/kookr']);
    expect(a.windowHours).toBe(24);
    expect(a.persist).toBe(true);
  });

  it('accepts repeatable --repo and --no-persist', () => {
    const a = parseEffortSplitArgs(['--repo', 'a/b', '--repo=c/d', '--no-persist', '--json']);
    expect(a.repos).toEqual(['a/b', 'c/d']);
    expect(a.persist).toBe(false);
    expect(a.json).toBe(true);
  });

  it('rejects bad dates', () => {
    expect(() => parseEffortSplitArgs(['--date', '30-07-2026'])).toThrow(UsageError);
  });
});

describe('runEffortSplitCli', () => {
  it('prints the section and persists one JSONL row', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kookr-effort-cli-'));
    const io = captureIo();
    const code = await runEffortSplitCli(
      ['--kookr-dir', home, '--date', '2026-07-30', '--window-hours', '24'],
      {
        env: { HOME: home },
        out: io.out,
        err: io.err,
        now: () => new Date('2026-07-30T21:06:00.000Z'),
        runGh: balancedGhRunner(),
      },
    );
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('Effort split vs 80/20');
    expect(io.logs.join('\n')).toContain('jeanibarz/lucy');
    expect(io.errors.join('\n')).toMatch(/wrote|updated/);

    const raw = await readFile(join(home, 'effort-split.jsonl'), 'utf8');
    const rows = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-07-30');
    expect(rows[0].schemaVersion).toBe('effort-split.v1');
  });

  it('same-day re-run overwrites the JSONL row', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kookr-effort-cli-'));
    const baseOpts = {
      env: { HOME: home },
      now: () => new Date('2026-07-30T21:06:00.000Z'),
      runGh: balancedGhRunner(),
    };
    await runEffortSplitCli(['--kookr-dir', home, '--date', '2026-07-30'], {
      ...baseOpts,
      out: captureIo().out,
      err: captureIo().err,
    });
    await runEffortSplitCli(['--kookr-dir', home, '--date', '2026-07-30'], {
      ...baseOpts,
      out: captureIo().out,
      err: captureIo().err,
    });
    const raw = await readFile(join(home, 'effort-split.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  it('--json emits a machine-readable envelope with the section', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kookr-effort-cli-'));
    const io = captureIo();
    const code = await runEffortSplitCli(
      ['--kookr-dir', home, '--date', '2026-07-30', '--json', '--no-persist'],
      {
        env: { HOME: home },
        out: io.out,
        err: io.err,
        now: () => new Date('2026-07-30T21:06:00.000Z'),
        runGh: balancedGhRunner(),
      },
    );
    expect(code).toBe(0);
    const payload = JSON.parse(io.logs.join('\n'));
    expect(payload.ok).toBe(true);
    expect(payload.details.report.metrics).toHaveLength(3);
    expect(payload.details.section).toContain('Effort split vs 80/20');
  });

  it('returns 2 on bad flags', async () => {
    const io = captureIo();
    const code = await runEffortSplitCli(['--not-a-flag'], {
      out: io.out,
      err: io.err,
    });
    expect(code).toBe(2);
    expect(io.errors.join('\n')).toMatch(/unknown flag/i);
  });

  it('returns 4 when gh fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kookr-effort-cli-'));
    const io = captureIo();
    const code = await runEffortSplitCli(['--kookr-dir', home, '--no-persist'], {
      env: { HOME: home },
      out: io.out,
      err: io.err,
      runGh: async () => {
        throw new Error('gh: not authenticated');
      },
    });
    expect(code).toBe(4);
    expect(io.errors.join('\n')).toMatch(/gh query failed/);
  });

  it('help exits 0', async () => {
    const io = captureIo();
    const code = await runEffortSplitCli(['--help'], { out: io.out, err: io.err });
    expect(code).toBe(0);
    expect(io.logs.join('\n')).toContain('kookr effort-split');
  });
});
