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

  it('--from-command extracts an inline body and evaluates attestation (pass)', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: 'B' },
      'diff --name-status B...HEAD': { stdout: 'M\tdocs/system-models/x.md' },
      'diff --unified=0 B...HEAD': { stdout: '+++ b/docs/system-models/x.md\n+x' },
    });
    const code = await runPrChecklistCli(
      ['verify', '--from-command', 'gh pr create --title T --body "- [x] <!-- pr:mbse --> refreshed"'],
      { out: out(), cwd: '/repo', gitRunner: git },
    );
    expect(code).toBe(EXIT_PASS);
  });

  it('--from-command fails CLOSED (2) on a checked box with no backing change', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: 'B' },
      'diff --name-status B...HEAD': { stdout: 'M\tsrc/x.ts' },
      'diff --unified=0 B...HEAD': { stdout: '+++ b/src/x.ts\n+code' },
    });
    const code = await runPrChecklistCli(
      ['verify', '--from-command', 'gh pr create --body "- [x] <!-- pr:mbse --> refreshed"'],
      { out: out(), cwd: '/repo', gitRunner: git },
    );
    expect(code).toBe(EXIT_VERIFICATION_FAILURE);
  });

  it('--from-command --fill is attest-unverified — structural only, prints a CI-authoritative note', async () => {
    const o = out();
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: 'B' },
      'diff --name-status B...HEAD': { stdout: 'M\tREADME.md' },
      'diff --unified=0 B...HEAD': { stdout: '+++ b/README.md\n+x' },
    });
    const code = await runPrChecklistCli(['verify', '--from-command', 'gh pr create --fill'], {
      out: o,
      cwd: '/repo',
      gitRunner: git,
    });
    expect(code).toBe(EXIT_PASS);
    expect((o.log.mock.calls.flat() as string[]).join('\n')).toMatch(/attest-unverified.*CI is authoritative/);
  });

  it('--from-command uses the base named on the command', async () => {
    const git = fakeGit({
      'merge-base origin/release HEAD': { stdout: 'B' },
      'diff --name-status B...HEAD': { stdout: '' },
      'diff --unified=0 B...HEAD': { stdout: '' },
    });
    const code = await runPrChecklistCli(['verify', '--from-command', 'gh pr create --base release --fill'], {
      out: out(),
      cwd: '/repo',
      gitRunner: git,
    });
    expect(code).toBe(EXIT_PASS);
  });

  it('--pr-body and --from-command together is a usage error (64)', async () => {
    const code = await runPrChecklistCli(['verify', '--pr-body', '-', '--from-command', 'gh pr create'], { out: out() });
    expect(code).toBe(EXIT_USAGE);
  });

  it('--run-commands ci is a usage error (reserved for P4)', async () => {
    expect(await runPrChecklistCli(['verify', '--run-commands', 'ci'], { out: out() })).toBe(EXIT_USAGE);
  });

  it('--run-commands with a bogus value is a usage error', async () => {
    expect(await runPrChecklistCli(['verify', '--run-commands', 'wat'], { out: out() })).toBe(EXIT_USAGE);
  });

  it('--from-command reads the --body-file body and evaluates it (pass)', async () => {
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: 'B' },
      'diff --name-status B...HEAD': { stdout: 'M\tdocs/system-models/x.md' },
      'diff --unified=0 B...HEAD': { stdout: '+++ b/docs/system-models/x.md\n+x' },
    });
    const code = await runPrChecklistCli(
      ['verify', '--from-command', 'gh pr create --base main --body-file PR_BODY.md'],
      { out: out(), cwd: '/repo', gitRunner: git, readBodyFile: async () => '- [x] <!-- pr:mbse --> refreshed' },
    );
    expect(code).toBe(EXIT_PASS);
  });

  it('--from-command fails CLOSED (2) when the named --body-file cannot be read (S2)', async () => {
    const code = await runPrChecklistCli(
      ['verify', '--from-command', 'gh pr create --body-file ../../etc/passwd'],
      {
        out: out(),
        cwd: '/repo',
        readBodyFile: async () => {
          throw Object.assign(new Error('path escapes repository root'), { name: 'ChecklistInputError' });
        },
      },
    );
    expect(code).toBe(EXIT_VERIFICATION_FAILURE);
  });

  it('--from-command with a non-gh-pr-create string runs structural only (allows, printed)', async () => {
    const o = out();
    const git = fakeGit({
      'merge-base origin/main HEAD': { stdout: 'B' },
      'diff --name-status B...HEAD': { stdout: 'M\tREADME.md' },
      'diff --unified=0 B...HEAD': { stdout: '+++ b/README.md\n+x' },
    });
    const code = await runPrChecklistCli(['verify', '--from-command', 'git commit -m x'], {
      out: o,
      cwd: '/repo',
      gitRunner: git,
    });
    expect(code).toBe(EXIT_PASS);
    expect((o.log.mock.calls.flat() as string[]).join('\n')).toMatch(/not a `gh pr create`/);
  });
});

describe('runPrChecklistCli doctor', () => {
  it('reports healthy when no degrade log exists', async () => {
    const o = out();
    const code = await runPrChecklistCli(['doctor'], {
      out: o,
      env: { HOME: '/test-home' } as NodeJS.ProcessEnv,
      readDegradeLog: async () => null,
    });
    expect(code).toBe(EXIT_PASS);
    expect((o.log.mock.calls.flat() as string[]).join('\n')).toMatch(/no fail-open/);
  });

  it('--json counts recent vs old fail-opens, tolerates malformed lines, and warns', async () => {
    const o = out();
    const now = () => new Date('2026-07-02T00:00:00Z');
    const log = [
      JSON.stringify({ at: '2026-07-01T12:00:00Z', event: 'fail-open', reason: 'kookr not on PATH' }), // 12h ago
      JSON.stringify({ at: '2026-01-01T00:00:00Z', event: 'fail-open', reason: 'old' }), // > 7d ago
      'garbage-not-json',
    ].join('\n');
    const code = await runPrChecklistCli(['doctor', '--json'], {
      out: o,
      env: { HOME: '/h' } as NodeJS.ProcessEnv,
      now,
      readDegradeLog: async () => log,
    });
    expect(code).toBe(EXIT_PASS);
    const rep = JSON.parse(o.log.mock.calls[0][0] as string);
    expect(rep.status).toBe('warn');
    expect(rep.total).toBe(2);
    expect(rep.last24h).toBe(1);
    expect(rep.last7d).toBe(1);
    expect(rep.malformedLines).toBe(1);
  });

  it('renders a text-mode warn listing recent entries when a fail-open is recent', async () => {
    const o = out();
    const now = () => new Date('2026-07-02T00:00:00Z');
    const log = JSON.stringify({ at: '2026-07-01T20:00:00Z', event: 'fail-open', reason: 'kookr not on PATH' });
    const code = await runPrChecklistCli(['doctor'], {
      out: o,
      env: { HOME: '/h' } as NodeJS.ProcessEnv,
      now,
      readDegradeLog: async () => log,
    });
    expect(code).toBe(EXIT_PASS);
    const text = (o.log.mock.calls.flat() as string[]).join('\n');
    expect(text).toMatch(/failed open recently/);
    expect(text).toMatch(/kookr not on PATH/);
  });

  it('reports internal (70) if the log cannot be read', async () => {
    const code = await runPrChecklistCli(['doctor'], {
      out: out(),
      env: { HOME: '/h' } as NodeJS.ProcessEnv,
      readDegradeLog: async () => {
        throw new Error('EACCES');
      },
    });
    expect(code).toBe(EXIT_INTERNAL);
  });
});
