import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_TOP,
  IDEA_CATEGORIES,
  IDEA_MAX_CHARS,
  IDEA_MAX_LINES,
  defaultNbBin,
  ideaNbEnv,
  ideaTarget,
  ideasDir,
  makeRunNb,
  runIdeaCli,
  similarIdeas,
  type IdeaEntry,
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

type Entry = { id: string; score: number; text: string };

/**
 * A fake nb: `show` answers from `shelves` (shelf name -> entries); every other
 * call takes the next canned response.
 */
function fakeNb(shelves: Record<string, Entry[]> = {}, responses: Array<Partial<NbResult>> = []) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runNb: RunNb = (args, env) => {
    calls.push({ args, env });
    if (args[0] === 'show') {
      const names = args.slice(1).filter((a) => a !== '--json');
      const groups = names.map((shelf) => ({ shelf, entries: shelves[shelf] ?? [], exists: shelf in shelves }));
      return { status: 0, stdout: JSON.stringify(groups), stderr: '' };
    }
    const next = responses.shift() ?? {};
    return { status: next.status ?? 0, stdout: next.stdout ?? '', stderr: next.stderr ?? '' };
  };
  const nonShow = () => calls.filter((c) => c.args[0] !== 'show').map((c) => c.args);
  return { calls, runNb, nonShow };
}

const GOOD = 'src/a/legacy.ts: imported nowhere -> delete it and its test (keeps: sync via src/a/queue.ts)';

describe('ideasDir / ideaNbEnv', () => {
  it('defaults to ~/.kookr/ideas, apart from the lesson notebooks', () => {
    expect(ideasDir({}, '/fake-home')).toBe('/fake-home/.kookr/ideas');
  });

  it('honours KOOKR_IDEAS_DIR, expanding a leading ~', () => {
    expect(ideasDir({ KOOKR_IDEAS_DIR: '/srv/ideas' }, '/fake-home')).toBe('/srv/ideas');
    expect(ideasDir({ KOOKR_IDEAS_DIR: '~/x' }, '/fake-home')).toBe('/fake-home/x');
    expect(ideasDir({ KOOKR_IDEAS_DIR: '~' }, '/fake-home')).toBe('/fake-home');
  });

  it('overrides an inherited NB_DIR and sets the idea caps', () => {
    const env = ideaNbEnv({ NB_DIR: '/fake-home/.kookr/notebooks', NB_MAX_CHARS: '200', KEEP: '1' }, '/fake-home');
    expect(env.NB_DIR).toBe('/fake-home/.kookr/ideas');
    expect(env.NB_MAX_CHARS).toBe(String(IDEA_MAX_CHARS));
    expect(env.NB_MAX_LINES).toBe(String(IDEA_MAX_LINES));
    expect(env.KEEP).toBe('1');
  });
});

describe('ideaTarget / similarIdeas', () => {
  const entry = (id: string, text: string): IdeaEntry => ({ id, score: 1, text, category: 'dead', shelf: 'dead@r' });

  it('reads the target as the text before the first ": "', () => {
    expect(ideaTarget('Src/A.ts: x -> y (keeps: z)')).toBe('src/a.ts');
    expect(ideaTarget('no target here -> y (keeps: z)')).toBe('');
  });

  it('finds an idea about the same target even when it is worded differently', () => {
    const other = entry('a1', 'src/a/legacy.ts: dead since the rewrite -> remove (keeps: queue sync)');
    const unrelated = entry('b2', 'docs/cli.md: documents a flag that is gone -> drop the row (keeps: other rows)');
    expect(similarIdeas(GOOD, [other, unrelated]).map((e) => e.id)).toEqual(['a1']);
  });

  it('does not treat two ideas without a target as similar when their wording differs', () => {
    const noTarget = entry('e5', 'kookr spawn --foo is never read -> remove the flag (keeps: spawn)');
    const other = 'the retry wrapper hides timeouts from callers -> let the timeout surface (keeps: one retry)';
    expect(similarIdeas(other, [noTarget])).toEqual([]);
  });

  it('finds close wording without a shared target, and ignores distant wording', () => {
    const close = entry('c3', 'legacy.ts imported nowhere -> delete it and its test (keeps: sync via queue.ts)');
    const far = entry('d4', 'scripts/x.sh: retries hide a failure -> fail on the first error (keeps: exit code)');
    const text = 'src/a/legacy.ts imported nowhere -> delete it and its test (keeps: sync via src/a/queue.ts)';
    expect(similarIdeas(text, [close, far]).map((e) => e.id)).toEqual(['c3']);
  });
});

describe('runIdeaCli (fake nb)', () => {
  const env = { KOOKR_REPO_SLUG: 'acme-repo', NB_DIR: '/lessons' };
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const scratch = () => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-idea-unit-'));
    return dir;
  };

  it('refuses a repository command with no --repo and no KOOKR_REPO_SLUG', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb();
    expect(await runIdeaCli(['show'], { ...io, env: {}, runNb, homeDir: '/h' })).toBe(2);
    expect(calls).toHaveLength(0);
    expect(io.errors.join('\n')).toMatch(/--repo/);
  });

  it('refuses add without a category, or with one outside the closed list, and lists the categories', async () => {
    for (const extra of [[], ['--category', 'feature']]) {
      const io = capture();
      const { calls, runNb } = fakeNb();
      expect(await runIdeaCli(['add', GOOD, ...extra], { ...io, env, runNb, homeDir: '/h' })).toBe(2);
      expect(calls).toHaveLength(0);
      for (const [name] of IDEA_CATEGORIES) expect(io.errors.join('\n')).toContain(name);
    }
  });

  it('refuses add without "->" or without "(keeps:"', async () => {
    for (const text of ['src/a.ts: slow (keeps: x)', 'src/a.ts: slow -> cache it']) {
      const io = capture();
      const { calls, runNb } = fakeNb();
      expect(await runIdeaCli(['add', '--category', 'overbuilt', text], { ...io, env, runNb, homeDir: '/h' })).toBe(2);
      expect(calls).toHaveLength(0);
      expect(io.errors.join('\n')).toMatch(/Nothing recorded/);
    }
  });

  it('adds to <category>@<repo> when nothing similar exists', async () => {
    const io = capture();
    const home = scratch();
    const { calls, runNb, nonShow } = fakeNb({}, [{ stdout: JSON.stringify({ added: true, id: 'abc123' }) }]);
    const code = await runIdeaCli(['add', '--category', 'dead', GOOD], { ...io, env, runNb, homeDir: home });
    expect(code).toBe(0);
    expect(nonShow()).toEqual([['add', 'dead@acme-repo', GOOD, '--json']]);
    expect(calls[0].env.NB_DIR).toBe(join(home, '.kookr', 'ideas'));
    expect(io.lines).toEqual(['Recorded idea abc123 on dead@acme-repo.']);
  });

  it('records nothing when a similar idea exists in any category, and lists it', async () => {
    const io = capture();
    const shelves = { 'tests@acme-repo': [{ id: 'old111', score: 2, text: 'src/a/legacy.ts: only its own test uses it -> delete both (keeps: queue sync)' }] };
    const { runNb, nonShow } = fakeNb(shelves);
    const code = await runIdeaCli(['add', '--category', 'dead', GOOD], { ...io, env, runNb, homeDir: scratch() });
    expect(code).toBe(3);
    expect(nonShow()).toEqual([]);
    expect(io.lines.join('\n')).toContain('old111');
    expect(io.errors.join('\n')).toMatch(/kookr idea vote <id> \+1 --because/);
    expect(io.errors.join('\n')).toMatch(/--new/);
  });

  it('--new records the idea even though a similar one exists', async () => {
    const shelves = { 'tests@acme-repo': [{ id: 'old111', score: 2, text: 'src/a/legacy.ts: x -> y (keeps: z)' }] };
    const { runNb, nonShow } = fakeNb(shelves, [{ stdout: JSON.stringify({ added: true, id: 'new222' }) }]);
    expect(await runIdeaCli(['add', '--category', 'dead', GOOD, '--new'], { ...capture(), env, runNb, homeDir: scratch() })).toBe(0);
    expect(nonShow()).toEqual([['add', 'dead@acme-repo', GOOD, '--json']]);
  });

  it('turns an identical idea into a +1 vote and logs it as a sighting', async () => {
    const io = capture();
    const home = scratch();
    const { runNb, nonShow } = fakeNb({ 'dead@acme-repo': [{ id: 'abc123', score: 1, text: GOOD }] }, [{ stdout: '+1 → [+2]' }]);
    const code = await runIdeaCli(['add', '--category', 'dead', GOOD], { ...io, env: { ...env, NB_SESSION: 'task-2' }, runNb, homeDir: home });
    expect(code).toBe(0);
    expect(nonShow()).toEqual([['vote', 'dead@acme-repo', 'abc123', '+1']]);
    expect(io.lines.join('\n')).toMatch(/Already recorded as abc123 on dead@acme-repo; voted \+1/);
    expect(readFileSync(join(home, '.kookr', 'ideas', '.votes.tsv'), 'utf8')).toMatch(/\ttask-2\tdead@acme-repo\tabc123\t\+1\tidentical idea added again\n$/);
  });

  it('votes on the original shelf when the identical idea is filed under another category, even with --new', async () => {
    const io = capture();
    const home = scratch();
    // Same text up to case and punctuation, which is how agent-notebook compares lines.
    const shelves = { 'dead@acme-repo': [{ id: 'abc123', score: 1, text: GOOD }] };
    const { runNb, nonShow } = fakeNb(shelves, [{ stdout: '+1 → [+2]' }]);
    const code = await runIdeaCli(['add', '--category', 'duplicate', `${GOOD.replace('imported nowhere', 'Imported  nowhere')}.`, '--new'], { ...io, env: { ...env, NB_SESSION: 'task-3' }, runNb, homeDir: home });
    expect(code).toBe(0);
    expect(nonShow()).toEqual([['vote', 'dead@acme-repo', 'abc123', '+1']]);
    expect(io.lines.join('\n')).toMatch(/Already recorded as abc123 on dead@acme-repo/);
  });

  it('still votes when this task has already added an idea, since a repeat is a sighting, not a new idea', async () => {
    const home = scratch();
    const taskEnv = { ...env, NB_SESSION: 'task-1' };
    const first = fakeNb({}, [{ stdout: JSON.stringify({ added: true, id: 'a1' }) }]);
    expect(await runIdeaCli(['add', '--category', 'dead', GOOD], { ...capture(), env: taskEnv, runNb: first.runNb, homeDir: home })).toBe(0);
    const again = fakeNb({ 'dead@acme-repo': [{ id: 'a1', score: 1, text: GOOD }] }, [{ stdout: '+1' }]);
    expect(await runIdeaCli(['add', '--category', 'dead', GOOD], { ...capture(), env: taskEnv, runNb: again.runNb, homeDir: home })).toBe(0);
    expect(again.nonShow()).toEqual([['vote', 'dead@acme-repo', 'a1', '+1']]);
  });

  it('reports a failed duplicate vote instead of claiming success', async () => {
    const io = capture();
    const { runNb } = fakeNb({}, [
      { stdout: JSON.stringify({ added: false, reason: 'duplicate', collidedId: 'abc123' }) },
      { status: 1, stderr: 'nb: locked' },
    ]);
    expect(await runIdeaCli(['add', '--category', 'dead', GOOD], { ...io, env, runNb, homeDir: scratch() })).toBe(1);
    expect(io.lines.join('\n')).not.toMatch(/voted/);
    expect(io.errors).toEqual(['nb: locked']);
  });

  it('accepts one new idea per task', async () => {
    const home = scratch();
    const taskEnv = { ...env, NB_SESSION: 'task-1' };
    const first = fakeNb({}, [{ stdout: JSON.stringify({ added: true, id: 'a1' }) }]);
    expect(await runIdeaCli(['add', '--category', 'dead', GOOD], { ...capture(), env: taskEnv, runNb: first.runNb, homeDir: home })).toBe(0);
    const io = capture();
    const second = fakeNb();
    const other = 'docs/cli.md: lists a removed flag -> drop the row (keeps: the other rows)';
    expect(await runIdeaCli(['add', '--category', 'guidance', other], { ...io, env: taskEnv, runNb: second.runNb, homeDir: home })).toBe(3);
    expect(second.nonShow()).toEqual([]);
    expect(io.errors.join('\n')).toMatch(/already added an idea/);
    // Another task may still add.
    const third = fakeNb({}, [{ stdout: JSON.stringify({ added: true, id: 'b2' }) }]);
    expect(await runIdeaCli(['add', '--category', 'guidance', other], { ...capture(), env: { ...env, NB_SESSION: 'task-9' }, runNb: third.runNb, homeDir: home })).toBe(0);
  });

  it('passes an nb failure on add (for example an over-long idea) straight through', async () => {
    const io = capture();
    const { runNb } = fakeNb({}, [{ status: 1, stderr: 'lesson is 450 chars; cap is 400' }]);
    expect(await runIdeaCli(['add', '--category', 'dead', GOOD], { ...io, env, runNb, homeDir: scratch() })).toBe(1);
    expect(io.errors).toEqual(['lesson is 450 chars; cap is 400']);
  });

  it('show merges every category of the repository, best score first, and filters with --grep and --category', async () => {
    const shelves = {
      'dead@acme-repo': [{ id: 'd1', score: 1, text: 'src/x.ts: unused -> delete (keeps: y)' }],
      'tests@acme-repo': [{ id: 't1', score: 4, text: 'src/x.test.ts: tautological -> delete (keeps: coverage of y)' }],
      'guidance@other-repo': [{ id: 'g1', score: 9, text: 'not this repo' }],
    };
    const io = capture();
    const { calls, runNb } = fakeNb(shelves);
    expect(await runIdeaCli(['show'], { ...io, env, runNb, homeDir: '/h' })).toBe(0);
    expect(calls[0].args).toEqual(['show', ...IDEA_CATEGORIES.map(([c]) => `${c}@acme-repo`), '--json']);
    const ideaLines = io.lines.filter((l) => /^[a-z]\d /.test(l));
    expect(ideaLines.map((l) => l.slice(0, 2))).toEqual(['t1', 'd1']);
    expect(ideaLines[0]).toBe('t1  [+4]  tests      src/x.test.ts: tautological -> delete (keeps: coverage of y)');

    const grep = capture();
    await runIdeaCli(['show', '--grep', 'SRC/X.TS:'], { ...grep, env, runNb, homeDir: '/h' });
    expect(grep.lines.filter((l) => /^[a-z]\d /.test(l)).map((l) => l.slice(0, 2))).toEqual(['d1']);

    const cat = capture();
    await runIdeaCli(['show', '--category', 'tests', '--json'], { ...cat, env, runNb, homeDir: '/h' });
    expect(JSON.parse(cat.lines[0])).toMatchObject({ repo: 'acme-repo', total: 1, entries: [{ id: 't1', category: 'tests' }] });
  });

  it('show refuses an unknown --category and lists the categories', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb();
    expect(await runIdeaCli(['show', '--category', 'feature'], { ...io, env, runNb, homeDir: '/h' })).toBe(2);
    expect(calls).toHaveLength(0);
    expect(io.errors.join('\n')).toContain('guidance');
  });

  it('says so when adding evicted the lowest-scored idea of a full shelf', async () => {
    const io = capture();
    const { runNb } = fakeNb({}, [{ stdout: JSON.stringify({ added: true, id: 'n1', evicted: 'old idea text' }) }]);
    expect(await runIdeaCli(['add', '--category', 'dead', GOOD], { ...io, env, runNb, homeDir: scratch() })).toBe(0);
    expect(io.lines.join('\n')).toMatch(/evicted: old idea text/);
  });

  it('vote takes one id; a comma list is refused', async () => {
    const io = capture();
    const { calls, runNb } = fakeNb();
    expect(await runIdeaCli(['vote', 'a1,b2', '-1'], { ...io, env, runNb, homeDir: '/h' })).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('show caps the list at --top (default 30) and says how many more there are', async () => {
    const entries = Array.from({ length: DEFAULT_TOP + 2 }, (_, i) => ({ id: `e${i}`, score: i, text: `f${i}: p -> c (keeps: k)` }));
    const io = capture();
    const { runNb } = fakeNb({ 'dead@acme-repo': entries });
    await runIdeaCli(['show'], { ...io, env, runNb, homeDir: '/h' });
    expect(io.lines.filter((l) => /^e\d+ /.test(l))).toHaveLength(DEFAULT_TOP);
    expect(io.lines.join('\n')).toMatch(/# 2 more/);
    const two = capture();
    await runIdeaCli(['show', '--top', '2'], { ...two, env, runNb, homeDir: '/h' });
    expect(two.lines.filter((l) => /^e\d+ /.test(l))).toHaveLength(2);
  });

  it('show reports an nb failure instead of an empty list', async () => {
    const io = capture();
    const runNb: RunNb = () => ({ status: 1, stdout: '', stderr: 'nb: unreadable shelf' });
    expect(await runIdeaCli(['show'], { ...io, env, runNb, homeDir: '/h' })).toBe(1);
    expect(io.errors).toEqual(['nb: unreadable shelf']);
    expect(io.lines.join('\n')).not.toMatch(/none recorded/);
  });

  it('vote +1 needs --because, finds the shelf from the id, and logs the reason', async () => {
    const home = scratch();
    const shelves = { 'fragile@acme-repo': [{ id: 'f00d01', score: 1, text: 'x: y -> z (keeps: w)' }] };
    const a = fakeNb(shelves);
    expect(await runIdeaCli(['vote', 'f00d', '+1'], { ...capture(), env, runNb: a.runNb, homeDir: home })).toBe(2);
    expect(a.calls).toHaveLength(0);

    const b = fakeNb(shelves, [{ stdout: '+1 → [+2]' }]);
    const code = await runIdeaCli(['vote', 'f00d', '+1', '--because', 'retry loop hid a 500'], { ...capture(), env: { ...env, NB_SESSION: 't7' }, runNb: b.runNb, homeDir: home });
    expect(code).toBe(0);
    expect(b.nonShow()).toEqual([['vote', 'fragile@acme-repo', 'f00d01', '+1']]);
    expect(readFileSync(join(home, '.kookr', 'ideas', '.votes.tsv'), 'utf8')).toMatch(/\tt7\tfragile@acme-repo\tf00d01\t\+1\tretry loop hid a 500\n$/);
  });

  it('vote -1 needs no reason; an unknown id is refused', async () => {
    const shelves = { 'dead@acme-repo': [{ id: 'aa1111', score: 2, text: 'x: y -> z (keeps: w)' }] };
    const ok = fakeNb(shelves, [{ stdout: '-1 → [+1]' }]);
    expect(await runIdeaCli(['vote', 'aa1111', '-1'], { ...capture(), env, runNb: ok.runNb, homeDir: scratch() })).toBe(0);
    expect(ok.nonShow()).toEqual([['vote', 'dead@acme-repo', 'aa1111', '-1']]);
    const io = capture();
    const missing = fakeNb(shelves);
    expect(await runIdeaCli(['vote', 'zz9999', '-1'], { ...io, env, runNb: missing.runNb, homeDir: '/h' })).toBe(2);
    expect(io.errors.join('\n')).toMatch(/no idea matches "zz9999"/);
  });

  it('rm finds the shelf from the id and forwards the reason and note', async () => {
    const { runNb, nonShow } = fakeNb({ 'unused@acme-repo': [{ id: 'bb2222', score: 3, text: 'x: y -> z (keeps: w)' }] }, [{}]);
    await runIdeaCli(['rm', 'bb22', '--reason', 'other', '--note=promoted: #1'], { ...capture(), env, runNb, homeDir: '/h' });
    expect(nonShow()).toEqual([['rm', 'unused@acme-repo', 'bb2222', '--reason', 'other', '--note', 'promoted: #1']]);
  });

  it('runs store-wide commands without a repository, so they work outside a task', async () => {
    const { calls, runNb } = fakeNb({}, [{ stdout: 'ok' }, { stdout: '{}' }]);
    expect(await runIdeaCli(['doctor'], { ...capture(), env: {}, runNb, homeDir: '/h' })).toBe(0);
    expect(await runIdeaCli(['list', '--json'], { ...capture(), env: {}, runNb, homeDir: '/h' })).toBe(0);
    expect(calls.map((c) => c.args)).toEqual([['doctor'], ['list', '--json', '--limit', '1000']]);
    expect(calls[0].env.NB_DIR).toBe('/h/.kookr/ideas');
  });

  it('prints usage and exits 2 with no subcommand; rejects an unknown one', async () => {
    const io = capture();
    expect(await runIdeaCli([], { ...io, env, runNb: fakeNb().runNb, homeDir: '/h' })).toBe(2);
    expect(io.lines.join('\n')).toMatch(/Categories/);
    expect(await runIdeaCli(['promote'], { ...capture(), env, runNb: fakeNb().runNb, homeDir: '/h' })).toBe(2);
  });
});

describe('defaultNbBin', () => {
  it('resolves bin/nb.js two levels above the module directory', () => {
    expect(defaultNbBin('/repo/dist/cli')).toBe('/repo/bin/nb.js');
  });
});

describe('kookr idea with the real bin/nb.js', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("records, turns a second task's identical idea into a vote, accepts long lines and leaves the lesson store alone", async () => {
    dir = mkdtempSync(join(tmpdir(), 'kookr-idea-'));
    const ideas = join(dir, 'ideas');
    const lessons = join(dir, 'lessons');
    const runNb = makeRunNb(join(process.cwd(), 'bin', 'nb.js'));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: dir,
      TMPDIR: process.env.TMPDIR,
      KOOKR_IDEAS_DIR: ideas,
      NB_DIR: lessons,
      NB_GIT_AUTOCOMMIT: '0',
      KOOKR_REPO_SLUG: 'acme-repo',
    };
    const long = `src/sync/legacy-bridge.ts: ${'kept only for a migration that finished long ago, '.repeat(4).trim()} -> delete it and its test (keeps: sync through src/sync/queue.ts)`;
    expect(long.length).toBeGreaterThan(200);
    expect(long.length).toBeLessThanOrEqual(IDEA_MAX_CHARS);

    expect(await runIdeaCli(['add', '--category', 'dead', long], { ...capture(), env: { ...env, NB_SESSION: 'task-1' }, runNb })).toBe(0);
    const second = capture();
    expect(await runIdeaCli(['add', '--category', 'dead', long], { ...second, env: { ...env, NB_SESSION: 'task-2' }, runNb })).toBe(0);
    expect(second.lines.join('\n')).toMatch(/voted \+1/);

    const shown = capture();
    expect(await runIdeaCli(['show', '--json'], { ...shown, env, runNb })).toBe(0);
    const result = JSON.parse(shown.lines[0]);
    expect(result.total).toBe(1);
    expect(result.entries[0]).toMatchObject({ score: 2, category: 'dead', text: long });

    expect(readFileSync(join(ideas, 'dead@acme-repo.md'), 'utf8')).toContain(long);
    expect(existsSync(lessons) ? readdirSync(lessons) : []).toEqual([]);

    // The curator counts supporting tasks from the usage log and the vote log.
    const usage = readFileSync(join(ideas, '.nb-usage.log'), 'utf8');
    expect(usage).toMatch(/\ttask-1\t/);
    expect(usage).toMatch(/\ttask-2\t/);
    expect(readFileSync(join(ideas, '.votes.tsv'), 'utf8')).toMatch(/\ttask-2\tdead@acme-repo\t/);

    const doctor = capture();
    expect(await runIdeaCli(['doctor'], { ...doctor, env, runNb })).toBe(0);
    expect(doctor.lines.join('\n')).not.toMatch(/lesson-too-long/);
  }, 30_000);

  // bin/kookr.js prefers dist/ when it exists, so this checks the dispatch only, not the current text.
  it('is reachable through bin/kookr.js', () => {
    const res = spawnSync(process.execPath, [join(process.cwd(), 'bin', 'kookr.js'), 'idea', '--help'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: process.env.TMPDIR },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('kookr idea show');
  }, 30_000);
});
