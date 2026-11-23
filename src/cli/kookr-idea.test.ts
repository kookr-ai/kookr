import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TOP,
  IDEA_MAX_CHARS,
  IDEA_MAX_LINES,
  defaultNbBin,
  makeRunNb,
  ideaNbEnv,
  ideasDir,
  runIdeaCli,
  type NbResult,
  type RunNb,
} from './kookr-idea.js';

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: { log: (...a: unknown[]) => lines.push(a.join(' ')) },
    err: { error: (...a: unknown[]) => errors.push(a.join(' ')) },
  };
}

function fakeNb(responses: Array<Partial<NbResult>>) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runNb: RunNb = (args, env) => {
    calls.push({ args, env });
    const next = responses.shift() ?? {};
    return { status: next.status ?? 0, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
  };
  return { calls, runNb };
}

describe('ideasDir / ideaNbEnv', () => {
  it('defaults to ~/.kookr/ideas, apart from the lesson notebooks', () => {
    expect(ideasDir({}, '/fake-home')).toBe('/fake-home/.kookr/ideas');
  });

  it('honours KOOKR_IDEAS_DIR, expanding a leading ~', () => {
    expect(ideasDir({ KOOKR_IDEAS_DIR: '/srv/ideas' }, '/fake-home')).toBe('/srv/ideas');
    expect(ideasDir({ KOOKR_IDEAS_DIR: '~/x' }, '/fake-home')).toBe('/fake-home/x');
  });

  it('overrides an inherited NB_DIR and sets the idea caps', () => {
    const env = ideaNbEnv({ NB_DIR: '/fake-home/.kookr/notebooks', NB_MAX_CHARS: '200', KEEP: '1' }, '/fake-home');
    expect(env.NB_DIR).toBe('/fake-home/.kookr/ideas');
    expect(env.NB_MAX_CHARS).toBe(String(IDEA_MAX_CHARS));
    expect(env.NB_MAX_LINES).toBe(String(IDEA_MAX_LINES));
    expect(env.KEEP).toBe('1');
  });
});

describe('runIdeaCli (fake nb)', () => {
  const env = { KOOKR_REPO_SLUG: 'acme-repo', NB_DIR: '/lessons' };

  it('refuses a shelf-scoped command with no shelf and no KOOKR_REPO_SLUG', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb([]);
    const code = await runIdeaCli(['show'], { ...io, env: {}, runNb, homeDir: '/h' });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(io.errors.join('\n')).toMatch(/--shelf/);
  });

  it('refuses an idea without the "->" separator and calls nothing', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb([]);
    const code = await runIdeaCli(['add', 'make merges safer'], { ...io, env, runNb, homeDir: '/h' });
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
    expect(io.errors.join('\n')).toMatch(/Nothing was recorded/);
  });

  it('adds to the repository shelf in the ideas folder', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb([{ stdout: JSON.stringify({ added: true, id: 'abc123' }) }]);
    const code = await runIdeaCli(['add', 'x is slow -> cache y'], { ...io, env, runNb, homeDir: '/h' });
    expect(code).toBe(0);
    expect(calls[0].args).toEqual(['add', 'acme-repo', 'x is slow -> cache y', '--json']);
    expect(calls[0].env.NB_DIR).toBe('/h/.kookr/ideas');
    expect(io.lines).toEqual(['Recorded idea abc123 on acme-repo.']);
  });

  it('turns an exact duplicate into a +1 vote for the existing idea', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb([
      { stdout: JSON.stringify({ added: false, reason: 'duplicate', id: 'abc123', collidedId: 'abc123' }) },
      { stdout: '+1 → [+2] x is slow -> cache y' },
    ]);
    const code = await runIdeaCli(['add', 'x is slow -> cache y', '--shelf', 'other'], { ...io, env, runNb, homeDir: '/h' });
    expect(code).toBe(0);
    expect(calls.map((c) => c.args)).toEqual([
      ['add', 'other', 'x is slow -> cache y', '--json'],
      ['vote', 'other', 'abc123', '+1'],
    ]);
    expect(io.lines.join('\n')).toMatch(/Already recorded as abc123 on other; voted \+1/);
  });

  it('reports a failed duplicate vote instead of claiming success', async () => {
    const io = capture();
    const { runNb } = fakeNb([
      { stdout: JSON.stringify({ added: false, reason: 'duplicate', collidedId: 'abc123' }) },
      { status: 1, stderr: 'nb: locked' },
    ]);
    const code = await runIdeaCli(['add', 'a -> b'], { ...io, env, runNb, homeDir: '/h' });
    expect(code).toBe(1);
    expect(io.lines.join('\n')).not.toMatch(/voted/);
    expect(io.errors).toEqual(['nb: locked']);
  });

  it('passes an nb failure on add (for example an over-long idea) straight through', async () => {
    const io = capture();
    const { runNb } = fakeNb([{ status: 1, stderr: 'lesson is 450 chars; cap is 400' }]);
    const code = await runIdeaCli(['add', 'a -> b'], { ...io, env, runNb, homeDir: '/h' });
    expect(code).toBe(1);
    expect(io.errors).toEqual(['lesson is 450 chars; cap is 400']);
  });

  it('shows only the best-scored ideas, highest first', async () => {
    const entries = Array.from({ length: DEFAULT_TOP + 3 }, (_, i) => ({ id: `id${i}`, score: i, text: `p${i} -> c${i}` }));
    const io = capture();
    const { calls, runNb } = fakeNb([{ stdout: JSON.stringify({ shelf: 'acme-repo', entries }) }]);
    const code = await runIdeaCli(['show'], { ...io, env, runNb, homeDir: '/h' });
    expect(code).toBe(0);
    expect(calls[0].args).toEqual(['show', 'acme-repo', '--json']);
    const ideaLines = io.lines.filter((l) => /^id\d+ /.test(l));
    expect(ideaLines).toHaveLength(DEFAULT_TOP);
    expect(ideaLines[0]).toBe(`id${DEFAULT_TOP + 2}  [+${DEFAULT_TOP + 2}]  p${DEFAULT_TOP + 2} -> c${DEFAULT_TOP + 2}`);
    expect(io.lines[0]).toBe(`Ideas for acme-repo: top ${DEFAULT_TOP} of ${DEFAULT_TOP + 3}, best score first`);
  });

  it('show --top N --json returns N entries and the total', async () => {
    const entries = [
      { id: 'a', score: -1, text: 'a -> a' },
      { id: 'b', score: 4, text: 'b -> b' },
      { id: 'c', score: 2, text: 'c -> c' },
    ];
    const io = capture();
    const { runNb } = fakeNb([{ stdout: JSON.stringify({ entries }) }]);
    const code = await runIdeaCli(['show', '--top', '2', '--json'], { ...io, env, runNb, homeDir: '/h' });
    expect(code).toBe(0);
    expect(JSON.parse(io.lines[0])).toEqual({ shelf: 'acme-repo', total: 3, entries: [entries[1], entries[2]] });
  });

  it('rejects a non-numeric --top', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb([]);
    expect(await runIdeaCli(['show', '--top', 'lots'], { ...io, env, runNb, homeDir: '/h' })).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('forwards vote and rm with their reason to the repository shelf', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb([{}, {}]);
    await runIdeaCli(['vote', 'abc123', '-1'], { ...io, env, runNb, homeDir: '/h' });
    await runIdeaCli(['rm', 'abc123', '--reason', 'obsolete', '--note=fixed in #1'], { ...io, env, runNb, homeDir: '/h' });
    expect(calls.map((c) => c.args)).toEqual([
      ['vote', 'acme-repo', 'abc123', '-1'],
      ['rm', 'acme-repo', 'abc123', '--reason', 'obsolete', '--note', 'fixed in #1'],
    ]);
  });

  it('runs store-wide commands without a shelf, so they work outside a task', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb([{ stdout: 'ok' }]);
    expect(await runIdeaCli(['doctor'], { ...io, env: {}, runNb, homeDir: '/h' })).toBe(0);
    expect(calls[0].args).toEqual(['doctor']);
    expect(calls[0].env.NB_DIR).toBe('/h/.kookr/ideas');
  });

  it('rejects an unknown subcommand', async () => {
    const io = capture();
    const { runNb } = fakeNb([]);
    expect(await runIdeaCli(['promote'], { ...io, env, runNb, homeDir: '/h' })).toBe(2);
  });
});

describe('defaultNbBin', () => {
  it('resolves bin/nb.js two levels above the module directory', () => {
    expect(defaultNbBin('/repo/dist/cli')).toBe('/repo/bin/nb.js');
  });
});

describe('runIdeaCli with the real bin/nb.js', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('records, de-duplicates into a vote, accepts 400 characters and leaves the lesson store alone', async () => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-idea-'));
    const ideas = join(dir, 'ideas');
    const lessons = join(dir, 'lessons');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: dir,
      TMPDIR: process.env.TMPDIR,
      KOOKR_IDEAS_DIR: ideas,
      NB_DIR: lessons,
      NB_GIT_AUTOCOMMIT: '0',
      NB_SESSION: 'task-1',
      KOOKR_REPO_SLUG: 'acme-repo',
    };
    const runNb = makeRunNb(join(process.cwd(), 'bin', 'nb.js'));
    const io = capture();
    const long = `${'merge wrapper re-reviews after a late push '.repeat(5).trim()} -> compare SHAs first`.slice(0, IDEA_MAX_CHARS);
    expect(long.length).toBeGreaterThan(200);

    expect(await runIdeaCli(['add', long], { ...io, env, runNb })).toBe(0);
    expect(await runIdeaCli(['add', long], { ...io, env: { ...env, NB_SESSION: 'task-2' }, runNb })).toBe(0);
    expect(io.lines.join('\n')).toMatch(/voted \+1/);

    const shown = capture();
    expect(await runIdeaCli(['show', '--json'], { ...shown, env, runNb })).toBe(0);
    const result = JSON.parse(shown.lines[0]);
    expect(result.total).toBe(1);
    expect(result.entries[0].score).toBe(2);
    expect(result.entries[0].text).toBe(long);

    // The idea is on disk in the ideas folder only; the lesson folder was never created.
    expect(readFileSync(join(ideas, 'acme-repo.md'), 'utf8')).toContain(long);
    expect(existsSync(lessons) ? readdirSync(lessons) : []).toEqual([]);

    // Both tasks are visible to the curator through the usage log's session column.
    const usage = readFileSync(join(ideas, '.nb-usage.log'), 'utf8');
    expect(usage).toMatch(/\ttask-1\t/);
    expect(usage).toMatch(/\ttask-2\t/);

    const doctor = capture();
    expect(await runIdeaCli(['doctor'], { ...doctor, env, runNb })).toBe(0);
    expect(doctor.lines.join('\n')).not.toMatch(/lesson-too-long/);
  }, 30_000);
});
