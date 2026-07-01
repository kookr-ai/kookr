import { describe, expect, it, vi } from 'vitest';
import {
  EXIT_INTERNAL,
  EXIT_PASS,
  EXIT_USAGE,
  EXIT_VERIFICATION_FAILURE,
  runPrChecklistCli,
} from './kookr-pr-checklist.js';
import type { GitRunner } from '../pr-checklist/git.js';

function out() {
  return { log: vi.fn(), error: vi.fn() };
}

function fakeGit(map: Record<string, { stdout?: string; exitCode?: number }>): GitRunner {
  return async (args) => {
    const hit = map[args.join(' ')];
    return { stdout: hit?.stdout ?? '', stderr: '', exitCode: hit?.exitCode ?? (hit ? 0 : 1) };
  };
}

describe('runPrChecklistCli', () => {
  it('--help returns 0', async () => {
    const o = out();
    expect(await runPrChecklistCli(['--help'], { out: o })).toBe(EXIT_PASS);
    expect(o.log).toHaveBeenCalled();
  });

  it('missing subcommand is a usage error (64)', async () => {
    expect(await runPrChecklistCli([], { out: out() })).toBe(EXIT_USAGE);
  });

  it('unknown option is a usage error (64)', async () => {
    expect(await runPrChecklistCli(['verify', '--nope'], { out: out() })).toBe(EXIT_USAGE);
  });

  it('--explain returns 0 and lists the built-in rules', async () => {
    const o = out();
    expect(await runPrChecklistCli(['verify', '--explain'], { out: o })).toBe(EXIT_PASS);
    const printed = o.log.mock.calls[0][0] as string;
    expect(printed).toMatch(/"id": "env"/);
    expect(printed).toMatch(/changed-when/);
  });

  it('returns 0 on a clean structural verify', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: 'B' },
      'diff --name-status B...HEAD': { stdout: 'M\tREADME.md' },
      'diff --unified=0 B...HEAD': { stdout: '+++ b/README.md\n+x' },
    });
    expect(await runPrChecklistCli(['verify'], { out: out(), cwd: '/repo', gitRunner: git })).toBe(EXIT_PASS);
  });

  it('returns 2 (verification failure) when a checked box is unbacked', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: 'B' },
      'diff --name-status B...HEAD': { stdout: 'M\tsrc/x.ts' },
      'diff --unified=0 B...HEAD': { stdout: '+++ b/src/x.ts\n+code' },
    });
    const code = await runPrChecklistCli(['verify', '--pr-body', '-'], {
      out: out(),
      cwd: '/repo',
      gitRunner: git,
      readStdin: async () => '- [x] <!-- kookr:check:mbse --> refreshed',
    });
    expect(code).toBe(EXIT_VERIFICATION_FAILURE);
  });

  it('fails CLOSED (2) when the body cannot be read — repo input error (S2)', async () => {
    const code = await runPrChecklistCli(['verify', '--pr-body', '../../etc/passwd'], {
      out: out(),
      cwd: '/repo',
      readBodyFile: async () => {
        throw Object.assign(new Error('path escapes repository root'), { name: 'ChecklistInputError' });
      },
    });
    expect(code).toBe(EXIT_VERIFICATION_FAILURE);
  });

  it('returns internal (70) — never fail-open — on an unexpected engine fault (S7)', async () => {
    const explode: GitRunner = async () => {
      throw new Error('git segfault');
    };
    const code = await runPrChecklistCli(['verify'], { out: out(), cwd: '/repo', gitRunner: explode });
    expect(code).toBe(EXIT_INTERNAL);
  });

  it('emits JSON with --json', async () => {
    const o = out();
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: 'B' },
      'diff --name-status B...HEAD': { stdout: '' },
      'diff --unified=0 B...HEAD': { stdout: '' },
    });
    await runPrChecklistCli(['verify', '--json'], { out: o, cwd: '/repo', gitRunner: git });
    expect(() => JSON.parse(o.log.mock.calls[0][0] as string)).not.toThrow();
  });
});
