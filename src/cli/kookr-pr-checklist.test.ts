import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('--from-command --fill (no template markers) is attest-unverified — structural only, prints a note', async () => {
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
    expect((o.log.mock.calls.flat() as string[]).join('\n')).toMatch(/attest-unverified.*not checked against the PR template/);
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

  describe('--from-command body shapes against a repo PR template', () => {
    const TEMPLATE = [
      '## Summary',
      '- [ ] <!-- kookr:check:tests --> tests',
      '- [ ] <!-- kookr:check:prose --> prose',
    ].join('\n');
    const FULL_BODY = [
      '## Summary',
      'why',
      '- [x] <!-- kookr:check:tests --> tests',
      '- [ ] ~~<!-- kookr:check:prose -->~~ N/A, no prose in this change',
    ].join('\n');

    function gitWithTemplate() {
      return fakeGit({
        'merge-base origin/main HEAD': { stdout: 'B' },
        'diff --name-status B...HEAD': { stdout: 'M\tsrc/core/x.test.ts' },
        'diff --unified=0 B...HEAD': { stdout: '+++ b/src/core/x.test.ts\n+t' },
        'ls-files -- .github/PULL_REQUEST_TEMPLATE.md': { stdout: '.github/PULL_REQUEST_TEMPLATE.md' },
      });
    }
    const readTemplate = (text: string) => async () => text;
    const run = (command: string, o = out(), template = TEMPLATE) =>
      runPrChecklistCli(['verify', '--from-command', command], {
        out: o,
        cwd: '/repo',
        gitRunner: gitWithTemplate(),
        readFileText: readTemplate(template),
      });
    const heredoc = (body: string, opener = `<<'EOF'`, terminator = 'EOF') =>
      `gh pr create --title T --body "$(cat ${opener}\n${body}\n${terminator}\n)"`;
    const printed = (o: ReturnType<typeof out>) =>
      [...o.log.mock.calls.flat(), ...o.error.mock.calls.flat()].join('\n');

    it('a quoted heredoc body with every template marker passes', async () => {
      expect(await run(heredoc(FULL_BODY))).toBe(EXIT_PASS);
    });

    it('unquoted <<EOF and <<-EOF heredoc bodies with all markers pass', async () => {
      expect(await run(heredoc(FULL_BODY, '<<EOF'))).toBe(EXIT_PASS);
      expect(await run(heredoc(FULL_BODY, '<<-EOF', '\tEOF'))).toBe(EXIT_PASS);
    });

    it('a heredoc body missing the template markers fails (2) with the pr-template finding', async () => {
      const o = out();
      expect(await run(heredoc('## Summary\nx'), o)).toBe(EXIT_VERIFICATION_FAILURE);
      expect(printed(o)).toMatch(/pr-template.*omits 2 of 2/);
    });

    it('a heredoc body containing double quotes and an unbalanced ) is still read in full', async () => {
      const body = `${FULL_BODY}\nShe said "hi" :) and )\n`;
      expect(await run(heredoc(body))).toBe(EXIT_PASS);
    });

    it('a heredoc with a checked box lacking evidence fails attestation (2)', async () => {
      const body = '- [x] <!-- kookr:check:mbse --> refreshed\n' + FULL_BODY;
      const o = out();
      expect(await run(heredoc(body), o)).toBe(EXIT_VERIFICATION_FAILURE);
      expect(printed(o)).toMatch(/mbse/);
    });

    it('--fill fails (2) when the template declares markers, with a how-to-fix message', async () => {
      const o = out();
      expect(await run('gh pr create --fill', o)).toBe(EXIT_VERIFICATION_FAILURE);
      expect(printed(o)).toMatch(/--body-file/);
      expect(printed(o)).toMatch(/heredoc/);
    });

    it('no body flag fails (2) when the template declares markers', async () => {
      expect(await run('gh pr create --title T')).toBe(EXIT_VERIFICATION_FAILURE);
    });

    it('--fill / no body flag with a marker-less template stays a degraded pass (0), printed', async () => {
      for (const cmd of ['gh pr create --fill', 'gh pr create --title T']) {
        const o = out();
        expect(await run(cmd, o, '## Summary\n\nNo markers here.\n')).toBe(EXIT_PASS);
        expect(printed(o)).toMatch(/attest-unverified/);
      }
    });

    it('--fill / no body flag with no template at all stays a degraded pass (0)', async () => {
      const git = fakeGit({
        'merge-base origin/main HEAD': { stdout: 'B' },
        'diff --name-status B...HEAD': { stdout: 'M\tREADME.md' },
        'diff --unified=0 B...HEAD': { stdout: '+++ b/README.md\n+x' },
      });
      const code = await runPrChecklistCli(['verify', '--from-command', 'gh pr create --fill'], {
        out: out(),
        cwd: '/repo',
        gitRunner: git,
      });
      expect(code).toBe(EXIT_PASS);
    });

    it('--body-file - (stdin) and other command substitutions stay degraded passes even with a marker template', async () => {
      for (const cmd of ['gh pr create --body-file -', 'gh pr create --body "$(cat notes.md)"']) {
        const o = out();
        expect(await run(cmd, o)).toBe(EXIT_PASS);
        expect(printed(o)).toMatch(/attest-unverified/);
      }
    });

    it('never echoes the heredoc body text', async () => {
      const o = out();
      await run(heredoc('SECRET-BODY-TEXT'), o);
      expect(printed(o)).not.toContain('SECRET-BODY-TEXT');
    });
  });

  it('a --body-file outside the repo root fails closed (2) with an actionable message', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kookr-prc-repo-'));
    const elsewhere = await mkdtemp(join(tmpdir(), 'kookr-prc-else-'));
    try {
      const file = join(elsewhere, 'body.md');
      await writeFile(file, '- [x] <!-- kookr:check:tests --> t');
      const o = out();
      const code = await runPrChecklistCli(['verify', '--from-command', `gh pr create --body-file ${file}`], {
        out: o,
        cwd: repo,
      });
      expect(code).toBe(EXIT_VERIFICATION_FAILURE);
      const msg = o.error.mock.calls.flat().join('\n');
      expect(msg).toMatch(/outside the repository root/);
      expect(msg).toMatch(/quoted heredoc/);
      expect(msg).toMatch(/inside the repo\/worktree/);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
