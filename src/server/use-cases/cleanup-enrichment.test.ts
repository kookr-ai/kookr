import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  parsePorcelainStatus,
  redactHome,
  runCommitEnrichment,
  runDirtyEnrichment,
} from './cleanup-enrichment.js';

const mockExecFile = vi.mocked(execFile);

function mockGit(rules: Array<{ match: (args: string[]) => boolean; stdout?: string; err?: Error & { stderr?: string; code?: number | string } }>) {
  mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
    const argsArr: string[] = Array.isArray(args) ? args : [];
    for (const rule of rules) {
      if (rule.match(argsArr)) {
        if (rule.err) {
          cb(rule.err, { stdout: '' }, '');
        } else {
          cb(null, { stdout: rule.stdout ?? '' }, '');
        }
        return;
      }
    }
    cb(null, { stdout: '' }, '');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runCommitEnrichment', () => {
  it('returns ahead/behind and last-commit fields on success', async () => {
    mockGit([
      { match: (a) => a.includes('rev-list'), stdout: '97\t2' },
      { match: (a) => a.includes('log'), stdout: 'abc1234defJean2026-04-01T12:00:00Zfix: something' },
    ]);

    const result = await runCommitEnrichment({
      repoPath: '/repo',
      worktreePath: '/repo-wt',
      branch: 'feature',
      baselineRef: 'origin/main',
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.aheadCount).toBe(2);
    expect(result.value.behindCount).toBe(97);
    expect(result.value.lastCommitSha).toBe('abc1234def');
    expect(result.value.lastCommitAuthor).toBe('Jean');
    expect(result.value.lastCommitAt).toBe('2026-04-01T12:00:00Z');
    expect(result.value.lastCommitSubject).toBe('fix: something');
  });

  it('returns error when rev-list fails', async () => {
    const err = Object.assign(new Error('rev-list failed'), { stderr: 'fatal: bad revision', code: 128 });
    mockGit([
      { match: (a) => a.includes('rev-list'), err },
    ]);

    const result = await runCommitEnrichment({
      repoPath: '/repo',
      worktreePath: '/repo-wt',
      branch: 'feature',
      baselineRef: 'origin/main',
    });

    expect(result.kind).toBe('error');
  });

  it('returns error when log fails after rev-list succeeds', async () => {
    const err = Object.assign(new Error('log failed'), { code: 1 });
    mockGit([
      { match: (a) => a.includes('rev-list'), stdout: '0\t5' },
      { match: (a) => a.includes('log'), err },
    ]);

    const result = await runCommitEnrichment({
      repoPath: '/repo',
      worktreePath: '/repo-wt',
      branch: 'feature',
      baselineRef: 'origin/main',
    });

    expect(result.kind).toBe('error');
  });

  it('returns error when a subprocess is killed by timeout (SIGTERM)', async () => {
    // execFile with `timeout` exceeded produces a killed=true error.
    // The warn log path categorizes this distinctly, but the caller
    // surface is the same `{ kind: 'error' }` outcome.
    const err = Object.assign(new Error('killed'), {
      killed: true,
      signal: 'SIGTERM',
      code: null,
      stderr: '',
    });
    mockGit([
      { match: (a) => a.includes('rev-list'), err },
    ]);

    const result = await runCommitEnrichment({
      repoPath: '/repo',
      worktreePath: '/repo-wt',
      branch: 'feature',
      baselineRef: 'origin/main',
    });

    expect(result.kind).toBe('error');
  });
});

describe('runDirtyEnrichment', () => {
  it('returns empty summary for a clean worktree', async () => {
    mockGit([
      { match: (a) => a.includes('status'), stdout: '' },
    ]);

    const result = await runDirtyEnrichment('/repo-wt');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.summary).toBeUndefined();
    expect(result.value.sample).toBeUndefined();
  });

  it('parses a mixed dirty status output', async () => {
    mockGit([
      { match: (a) => a.includes('status'), stdout: ' M src/a.ts\nA  src/b.ts\n?? src/c.ts\n?? src/d.ts' },
    ]);

    const result = await runDirtyEnrichment('/repo-wt');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.value.summary).toEqual({ modified: 1, added: 1, deleted: 0, renamed: 0, untracked: 2 });
    expect(result.value.sample).toHaveLength(4);
  });

  it('returns error when git status fails', async () => {
    const err = Object.assign(new Error('status failed'), { code: 1 });
    mockGit([
      { match: (a) => a.includes('status'), err },
    ]);

    const result = await runDirtyEnrichment('/repo-wt');
    expect(result.kind).toBe('error');
  });
});

describe('parsePorcelainStatus', () => {
  it('returns empty object for null input', () => {
    expect(parsePorcelainStatus(null)).toEqual({});
  });

  it('returns empty object for undefined input', () => {
    expect(parsePorcelainStatus(undefined)).toEqual({});
  });

  it('returns empty object for empty string', () => {
    expect(parsePorcelainStatus('')).toEqual({});
  });

  it('categorizes status letters correctly', () => {
    const raw = [
      ' M modified.ts',
      'A  added.ts',
      ' D deleted.ts',
      'R  renamed.ts',
      '?? untracked.ts',
    ].join('\n');
    const parsed = parsePorcelainStatus(raw);
    expect(parsed.summary).toEqual({
      modified: 1,
      added: 1,
      deleted: 1,
      renamed: 1,
      untracked: 1,
    });
  });
});

describe('redactHome', () => {
  it('replaces a home-prefix with ~', () => {
    // Uses the current HOME; not asserting the exact value, just the shape.
    const home = process.env.HOME ?? '';
    if (!home) {
      return;
    }
    expect(redactHome(`${home}/code/repo`)).toBe('~/code/repo');
  });

  it('returns paths outside HOME unchanged', () => {
    expect(redactHome('/tmp/foo')).toBe('/tmp/foo');
    expect(redactHome('/var/lib/something')).toBe('/var/lib/something');
  });

  it('handles exact HOME match', () => {
    const home = process.env.HOME ?? '';
    if (!home) return;
    expect(redactHome(home)).toBe('~');
  });
});
