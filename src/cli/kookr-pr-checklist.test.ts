import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import { ChecklistInputError } from '../pr-checklist/errors.js';
import type { GitRunner } from '../pr-checklist/git.js';

const GIT_REDIRECT_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_WORK_TREE',
];

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

    it('a repo with no marker template and no config gets no opinion (0, noted) for any body shape', async () => {
      const git = fakeGit({
        'merge-base origin/main HEAD': { stdout: 'B' },
        'diff --name-status B...HEAD': { stdout: 'M\tsrc/x.ts' },
        // split so this test file itself does not trip the env rule
        'diff --unified=0 B...HEAD': { stdout: `+++ b/src/x.ts\n+const k = ${'process' + '.env.NEW_ONE'}` },
      });
      for (const cmd of ['gh pr create --fill', 'gh pr create --body "plain"', heredoc('plain')]) {
        const o = out();
        const code = await runPrChecklistCli(['verify', '--from-command', cmd], { out: o, cwd: '/repo', gitRunner: git });
        expect(code).toBe(EXIT_PASS);
        expect(printed(o)).toMatch(/No opinion/);
      }
    });

    describe('-R / --repo naming a different repo', () => {
      const remotes = (url: string) =>
        fakeGit({
          'remote -v': { stdout: `origin\t${url} (fetch)\norigin\t${url} (push)` },
          'merge-base origin/main HEAD': { stdout: 'B' },
          'diff --name-status B...HEAD': { stdout: 'M\tsrc/core/x.test.ts' },
          'diff --unified=0 B...HEAD': { stdout: '+++ b/src/core/x.test.ts\n+t' },
          'ls-files -- .github/PULL_REQUEST_TEMPLATE.md': { stdout: '.github/PULL_REQUEST_TEMPLATE.md' },
        });
      const go = (cmd: string, git: GitRunner, o = out()) =>
        runPrChecklistCli(['verify', '--from-command', cmd], { out: o, cwd: '/repo', gitRunner: git, readFileText: readTemplate(TEMPLATE) });

      it('a foreign repo gets no opinion (0) in every -R spelling, incl. quoted and = forms', async () => {
        for (const flag of ['-R other/x', '--repo other/x', '--repo=other/x', '-R=other/x', '-R "other/x"']) {
          const o = out();
          expect(await go(`gh pr create ${flag} --title t --fill`, remotes('git@github.com:acme/own.git'), o)).toBe(EXIT_PASS);
          expect(printed(o)).toMatch(/no opinion/i);
        }
      });

      it("the session repo's own -R (ssh or https remote, any case) is still judged", async () => {
        expect(await go('gh pr create -R ACME/Own --fill', remotes('git@github.com:acme/own.git'))).toBe(EXIT_VERIFICATION_FAILURE);
        expect(await go('gh pr create -R acme/own --fill', remotes('https://github.com/acme/own'))).toBe(EXIT_VERIFICATION_FAILURE);
      });

      it('an unresolvable or non-literal -R target is judged, never skipped as foreign', async () => {
        const git = remotes('git@github.com:acme/own.git');
        for (const flag of ['-R "$REPO"', '-R ${UPSTREAM}', '-R github.com/acme/own', '-R https://github.com/acme/own/']) {
          expect(await go(`gh pr create ${flag} --fill`, git)).toBe(EXIT_VERIFICATION_FAILURE);
        }
      });

      it('a trailing-slash or ssh:// remote URL still matches its own repo', async () => {
        expect(await go('gh pr create -R acme/own --fill', remotes('https://github.com/acme/own/'))).toBe(EXIT_VERIFICATION_FAILURE);
        expect(await go('gh pr create -R acme/own --fill', remotes('ssh://git@github.com/acme/own.git'))).toBe(EXIT_VERIFICATION_FAILURE);
      });

      it('unreadable remotes mean "cannot tell": the PR is judged, not skipped', async () => {
        const git = fakeGit({
          'ls-files -- .github/PULL_REQUEST_TEMPLATE.md': { stdout: '.github/PULL_REQUEST_TEMPLATE.md' },
        });
        expect(await go('gh pr create -R other/x --fill', git)).toBe(EXIT_VERIFICATION_FAILURE);
      });

      it('-R prose inside a multi-line quoted body or heredoc body does not make the PR foreign', async () => {
        const git = remotes('git@github.com:acme/own.git');
        expect(await go('gh pr create --title t --body "\nsee gh pr create\n -R x/y\n"', git)).toBe(EXIT_VERIFICATION_FAILURE);
        expect(await go(heredoc('use gh -R src/lib or --repo a/b'), git)).toBe(EXIT_VERIFICATION_FAILURE);
      });
    });

    it('never echoes the heredoc body text', async () => {
      const o = out();
      await run(heredoc('SECRET-BODY-TEXT'), o);
      expect(printed(o)).not.toContain('SECRET-BODY-TEXT');
    });
  });

  it('run from a repo SUBDIRECTORY it still finds the toplevel template (real git repo)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'kookr-prc-sub-'));
    // Under a git hook (pre-push runs `pnpm test`) git exports repo-redirecting vars;
    // strip them (also for the code under test) so `git -C <tmp>` hits the fixture.
    const saved: Record<string, string | undefined> = {};
    for (const name of GIT_REDIRECT_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    try {
      const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf-8' });
      git('init', '-q');
      await mkdir(join(repo, '.github'), { recursive: true });
      await mkdir(join(repo, 'src', 'deep'), { recursive: true });
      await writeFile(join(repo, '.github', 'pull_request_template.md'), '- [ ] <!-- kookr:check:tests --> t\n');
      git('add', '.github/pull_request_template.md');
      const o = out();
      const code = await runPrChecklistCli(['verify', '--from-command', 'gh pr create --fill'], {
        out: o,
        cwd: join(repo, 'src', 'deep'),
      });
      expect(code).toBe(EXIT_VERIFICATION_FAILURE);
      expect(o.log.mock.calls.flat().join('\n')).toMatch(/pr-template/);
    } finally {
      for (const name of GIT_REDIRECT_VARS) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      await rm(repo, { recursive: true, force: true });
    }
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

// #3651: `scaffold` prints a body in the syntax verify accepts; `--title` checks
// the PR title against the repo's commit-lint rule.
describe('runPrChecklistCli scaffold + title', () => {
  const TEMPLATE = [
    '## Summary',
    '- [ ] <!-- kookr:check:tests --> Tests added',
    '- [ ] <!-- kookr:check:mbse --> System design docs up to date',
  ].join('\n');
  const COMMITLINT = 'module.exports = { extends: ["@commitlint/config-conventional"] };';

  function repo(
    opts: {
      base?: boolean;
      template?: boolean | string;
      commitlint?: boolean | 'package.json' | 'angular' | 'custom';
      config?: string;
    } = {},
  ) {
    const map: Record<string, { stdout?: string; exitCode?: number }> = {
      'diff --name-status B...HEAD': { stdout: 'M\tsrc/core/x.test.ts' },
      'diff --unified=0 B...HEAD': { stdout: '+++ b/src/core/x.test.ts\n+t' },
    };
    if (opts.base !== false) map['merge-base origin/main HEAD'] = { stdout: 'B' };
    if (opts.template !== false) map['ls-files -- .github/pull_request_template.md'] = { stdout: '.github/pull_request_template.md' };
    if (opts.commitlint === true || opts.commitlint === 'angular' || opts.commitlint === 'custom') {
      map['ls-files -- commitlint.config.cjs'] = { stdout: 'commitlint.config.cjs' };
    }
    if (opts.commitlint === 'package.json') map['ls-files -- package.json'] = { stdout: 'package.json' };
    if (opts.config) map['ls-files -- .kookr/pr-checklist.json'] = { stdout: '.kookr/pr-checklist.json' };
    const template = typeof opts.template === 'string' ? opts.template : TEMPLATE;
    return {
      gitRunner: fakeGit(map),
      readFileText: async (p: string) => {
        if (p.endsWith('commitlint.config.cjs')) {
          if (opts.commitlint === 'angular') return 'module.exports = { extends: ["@commitlint/config-angular"] };';
          if (opts.commitlint === 'custom') {
            return 'module.exports = { extends: ["@commitlint/config-conventional"], rules: { "subject-case": [0] } };';
          }
          return COMMITLINT;
        }
        if (p.endsWith('package.json')) return JSON.stringify({ name: 'x', commitlint: { extends: ['@commitlint/config-conventional'] } });
        if (p.endsWith('pr-checklist.json')) return opts.config ?? '';
        return template;
      },
    };
  }
  const stdout = (o: ReturnType<typeof out>) => o.log.mock.calls.flat().join('\n');
  const stderr = (o: ReturnType<typeof out>) => o.error.mock.calls.flat().join('\n');

  it('prints the scaffolded body on stdout only, with the summary on stderr', async () => {
    const o = out();
    expect(await runPrChecklistCli(['scaffold'], { out: o, cwd: '/repo', ...repo() })).toBe(EXIT_PASS);
    expect(stdout(o)).toBe([
      '## Summary',
      '- [x] <!-- kookr:check:tests --> Tests added',
      '- [ ] ~~<!-- kookr:check:mbse --> System design docs up to date~~ — TODO: say why this row does not apply',
    ].join('\n'));
    expect(stderr(o)).toMatch(/ticked .*: tests/);
    expect(stderr(o)).toMatch(/struck .*: mbse/);
  });

  it('the scaffold fails verify as printed and passes once the reason is filled (end to end)', async () => {
    const o = out();
    await runPrChecklistCli(['scaffold'], { out: o, cwd: '/repo', ...repo() });
    const body = stdout(o);
    const verify = (text: string, v = out()) =>
      runPrChecklistCli(['verify', '--pr-body', '-'], { out: v, cwd: '/repo', ...repo(), readStdin: async () => text });
    const raw = out();
    expect(await verify(body, raw)).toBe(EXIT_VERIFICATION_FAILURE);
    expect(stdout(raw)).toContain(
      '        - [ ] ~~<!-- kookr:check:mbse --> System design docs up to date~~ — TODO: one-line reason',
    );
    expect(await verify(body.replace('TODO: say why this row does not apply', 'CLI-only change'))).toBe(EXIT_PASS);
  });

  it('prints the accepted line when verify rejects a box-inside-strike row', async () => {
    const o = out();
    const body = '- [x] <!-- kookr:check:tests --> Tests added\n- ~~[ ] <!-- kookr:check:mbse --> System design docs up to date~~ — n/a';
    const code = await runPrChecklistCli(['verify', '--pr-body', '-'], { out: o, cwd: '/repo', ...repo(), readStdin: async () => body });
    expect(code).toBe(EXIT_VERIFICATION_FAILURE);
    expect(stdout(o)).toContain('        - [ ] ~~<!-- kookr:check:mbse --> System design docs up to date~~ — TODO: one-line reason');
  });

  it('refuses (2) when the diff base cannot be resolved, rather than striking every row', async () => {
    const o = out();
    expect(await runPrChecklistCli(['scaffold', '--base', 'nope'], { out: o, cwd: '/repo', ...repo({ base: false }) }))
      .toBe(EXIT_VERIFICATION_FAILURE);
    expect(stderr(o)).toMatch(/Could not resolve the diff base "nope"/);
    expect(stdout(o)).toBe('');
  });

  it('refuses (2) when the repo has no PR template', async () => {
    const o = out();
    expect(await runPrChecklistCli(['scaffold'], { out: o, cwd: '/repo', ...repo({ template: false }) })).toBe(EXIT_VERIFICATION_FAILURE);
    expect(stderr(o)).toMatch(/No tracked PR template/);
  });

  it('--json returns the body and row lists', async () => {
    const o = out();
    expect(await runPrChecklistCli(['scaffold', '--json'], { out: o, cwd: '/repo', ...repo() })).toBe(EXIT_PASS);
    const parsed = JSON.parse(stdout(o));
    expect(parsed).toMatchObject({ ok: true, checked: ['tests'], struck: ['mbse'], undecided: [] });
    expect(parsed.body).toContain('- [x] <!-- kookr:check:tests -->');
  });

  it('rejects verify-only flags on scaffold (64)', async () => {
    expect(await runPrChecklistCli(['scaffold', '--pr-body', 'x'], { out: out() })).toBe(EXIT_USAGE);
    expect(await runPrChecklistCli(['scaffold', '--explain'], { out: out() })).toBe(EXIT_USAGE);
    const o = out();
    expect(await runPrChecklistCli(['scaffold', '--from-command', 'gh pr create'], { out: o })).toBe(EXIT_USAGE);
    expect(o.error.mock.calls.flat().join('\n')).toMatch(/scaffold takes only --base, --title and --json/);
    expect(await runPrChecklistCli(['scaffold', '--title'], { out: out() })).toBe(EXIT_USAGE);
  });

  it('scaffold --title reports a title the repo commit-lint rule would reject (2), still printing the body', async () => {
    const o = out();
    const code = await runPrChecklistCli(['scaffold', '--title', 'Add scaffold'], { out: o, cwd: '/repo', ...repo({ commitlint: true }) });
    expect(code).toBe(EXIT_VERIFICATION_FAILURE);
    expect(stdout(o)).toContain('## Summary');
    expect(stderr(o)).toMatch(/pr-title: PR title would fail the repo's commit-lint rule \(commitlint\.config\.cjs/);
  });

  it('scaffold --title passes a conventional title, and is not checked when the repo has no commit-lint config', async () => {
    expect(await runPrChecklistCli(['scaffold', '--title', 'feat(cli): add scaffold'], { out: out(), cwd: '/repo', ...repo({ commitlint: true }) }))
      .toBe(EXIT_PASS);
    expect(await runPrChecklistCli(['scaffold', '--title', 'Add scaffold'], { out: out(), cwd: '/repo', ...repo() })).toBe(EXIT_PASS);
  });

  it('verify --from-command checks the --title on the gh command against commit-lint', async () => {
    const body = '- [x] <!-- kookr:check:tests --> Tests added\n- [ ] ~~<!-- kookr:check:mbse --> docs~~ — CLI-only';
    const cmd = (title: string) => `gh pr create --title "${title}" --body "${body}"`;
    const bad = out();
    expect(await runPrChecklistCli(['verify', '--from-command', cmd('Add scaffold')], { out: bad, cwd: '/repo', ...repo({ commitlint: true }) }))
      .toBe(EXIT_VERIFICATION_FAILURE);
    expect(stdout(bad)).toMatch(/\[fail\] pr-title/);
    expect(await runPrChecklistCli(['verify', '--from-command', cmd('feat(cli): add scaffold')], { out: out(), cwd: '/repo', ...repo({ commitlint: true }) }))
      .toBe(EXIT_PASS);
  });

  it('verify --title checks a title given directly, and an explicit --title wins over the gh command', async () => {
    const body = '- [x] <!-- kookr:check:tests --> Tests added\n- [ ] ~~<!-- kookr:check:mbse --> docs~~ — CLI-only';
    const o = out();
    const direct = await runPrChecklistCli(['verify', '--title', 'Add x', '--pr-body', '-'], {
      out: o, cwd: '/repo', ...repo({ commitlint: true }), readStdin: async () => body,
    });
    expect(direct).toBe(EXIT_VERIFICATION_FAILURE);
    expect(stdout(o)).toMatch(/\[fail\] pr-title/);
    const cmd = `gh pr create --title "Add x" --body "${body}"`;
    expect(await runPrChecklistCli(['verify', '--title', 'feat: ok', '--from-command', cmd], {
      out: out(), cwd: '/repo', ...repo({ commitlint: true }),
    })).toBe(EXIT_PASS);
  });

  it('a gh --title built from a shell variable is not checked (the hook must not block it)', async () => {
    const body = '- [x] <!-- kookr:check:tests --> Tests added\n- [ ] ~~<!-- kookr:check:mbse --> docs~~ — CLI-only';
    const o = out();
    expect(await runPrChecklistCli(['verify', '--from-command', `gh pr create --title "$TITLE" --body "${body}"`], {
      out: o, cwd: '/repo', ...repo({ commitlint: true }),
    })).toBe(EXIT_PASS);
    expect(stdout(o)).not.toMatch(/pr-title/);
  });

  it('scaffold and verify agree when the repo disables pr-title', async () => {
    const config = '{ "disable": ["pr-title"] }';
    expect(await runPrChecklistCli(['scaffold', '--title', 'Add x'], { out: out(), cwd: '/repo', ...repo({ commitlint: true, config }) }))
      .toBe(EXIT_PASS);
    const body = '- [x] <!-- kookr:check:tests --> Tests added\n- [ ] ~~<!-- kookr:check:mbse --> docs~~ — CLI-only';
    expect(await runPrChecklistCli(['verify', '--title', 'Add x', '--pr-body', '-'], {
      out: out(), cwd: '/repo', ...repo({ commitlint: true, config }), readStdin: async () => body,
    })).toBe(EXIT_PASS);
  });

  it('scaffold leaves a disabled row as the template wrote it and says so', async () => {
    const o = out();
    expect(await runPrChecklistCli(['scaffold'], { out: o, cwd: '/repo', ...repo({ config: '{ "disable": ["mbse"] }' }) })).toBe(EXIT_PASS);
    expect(stdout(o)).toContain('- [ ] <!-- kookr:check:mbse --> System design docs up to date');
    expect(stderr(o)).toMatch(/rule disabled by \.kookr\/pr-checklist\.json\): mbse/);
  });

  it('scaffold --json reports a failing title with ok:false and exit 2', async () => {
    const o = out();
    expect(await runPrChecklistCli(['scaffold', '--json', '--title', 'Add scaffold'], { out: o, cwd: '/repo', ...repo({ commitlint: true }) }))
      .toBe(EXIT_VERIFICATION_FAILURE);
    const parsed = JSON.parse(stdout(o));
    expect(parsed.ok).toBe(false);
    expect(parsed.results[0]).toMatchObject({ id: 'pr-title', status: 'fail' });
  });

  it('prints a marker-less template as-is without needing the diff', async () => {
    const o = out();
    const template = '## Summary\n- [ ] plain box';
    expect(await runPrChecklistCli(['scaffold'], { out: o, cwd: '/repo', ...repo({ base: false, template }) })).toBe(EXIT_PASS);
    expect(stdout(o)).toBe(template);
    expect(stderr(o)).toMatch(/declares no kookr:check rows/);
  });

  it('marks a row with no evidence rule as undecided on stderr', async () => {
    const o = out();
    const template = '- [ ] <!-- kookr:check:prose --> Summary is clear';
    await runPrChecklistCli(['scaffold'], { out: o, cwd: '/repo', ...repo({ template }) });
    expect(stderr(o)).toMatch(/\? no diff rule .*: prose/);
  });

  it('finds a commitlint config in package.json, and notes (not fails) a non-conventional one', async () => {
    expect(await runPrChecklistCli(['scaffold', '--title', 'Add x'], { out: out(), cwd: '/repo', ...repo({ commitlint: 'package.json' }) }))
      .toBe(EXIT_VERIFICATION_FAILURE);
    const o = out();
    expect(await runPrChecklistCli(['scaffold', '--title', 'Add x'], { out: o, cwd: '/repo', ...repo({ commitlint: 'angular' }) }))
      .toBe(EXIT_PASS);
    expect(stderr(o)).toMatch(/does not extend config-conventional — PR title not checked/);
  });

  // Independent review of #3782: the hook must not deny titles real commitlint accepts.
  it('never denies a title commitlint ignores by default, or one a customised config may accept', async () => {
    const body = '- [x] <!-- kookr:check:tests --> Tests added\n- [ ] ~~<!-- kookr:check:mbse --> docs~~ — CLI-only';
    const cmd = (title: string) => `gh pr create --title '${title}' --body "${body}"`;
    expect(await runPrChecklistCli(['verify', '--from-command', cmd('Revert "feat: add x"')], {
      out: out(), cwd: '/repo', ...repo({ commitlint: true }),
    })).toBe(EXIT_PASS);
    const o = out();
    expect(await runPrChecklistCli(['verify', '--from-command', cmd('feat: Add OAuth login')], {
      out: o, cwd: '/repo', ...repo({ commitlint: 'custom' }),
    })).toBe(EXIT_PASS);
    expect(stdout(o)).toMatch(/may fail commit-lint .*not enforced/);
    // The same title with the plain preset is a real failure.
    expect(await runPrChecklistCli(['verify', '--from-command', cmd('feat: Add OAuth login')], {
      out: out(), cwd: '/repo', ...repo({ commitlint: true }),
    })).toBe(EXIT_VERIFICATION_FAILURE);
  });

  it('fails closed (2), not internal (70), when a repo file trips the input guard', async () => {
    const o = out();
    const { gitRunner } = repo();
    const code = await runPrChecklistCli(['scaffold'], {
      out: o, cwd: '/repo', gitRunner,
      readFileText: async () => { throw new ChecklistInputError('file exceeds size cap'); },
    });
    expect(code).toBe(EXIT_VERIFICATION_FAILURE);
    expect(stderr(o)).toMatch(/input guard/);
  });
});
