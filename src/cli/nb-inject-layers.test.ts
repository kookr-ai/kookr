// Tests for the layered view of the SessionStart notebook index
// (plugin/hooks/nb-inject.mjs, issue #3592): project shelves first, then domain,
// then fleet-global, other repos' shelves hidden behind a count.
//
// Most tests put a fake `nb` (a shell script) first on PATH that answers
// `nb list --json --limit 1000` from a fixture, and fails loudly on any other call,
// so they also prove WHICH `nb` command the hook runs. One test runs the real
// `nb` (the pinned agent-notebook) through bin/nb.js against a throwaway NB_DIR (never the live store).
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const BIN = join(ROOT, 'bin/nb.js');
const HOOK = join(ROOT, 'plugin/hooks/nb-inject.mjs');
const RETRO = join(ROOT, 'plugin/hooks/nb-retro.mjs');
// Names-only snapshot of the live store (44 shelves; private slugs replaced by placeholders).
const FIXTURE: { shelves: { name: string; lessons: number; described: boolean }[] } = JSON.parse(
  readFileSync(join(ROOT, 'scripts/fixtures/nb-store-shelves-2026-11-11.json'), 'utf-8'),
);

type Row = { shelf: string; lessons?: number; desc?: string | null; auto?: string | null };

let work: string; // holds the stub `nb` and its data
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'kookr-nb-layers-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** `nb list --json` output for these rows. */
function listJson(rows: Row[]): string {
  return JSON.stringify({
    dir: '/store',
    total: rows.length,
    rows: rows.map((r) => ({ role: r.shelf, shelf: r.shelf, lessons: r.lessons ?? 1, desc: r.desc === undefined ? 'when to open it' : r.desc, auto: r.auto ?? null })),
  });
}

const fixtureRows: Row[] = FIXTURE.shelves.map((s) => ({ shelf: s.name, lessons: s.lessons, desc: s.described ? `when ${s.name}` : null, auto: 'top lesson' }));

/** Env for the hook: a clean base plus explicit overrides (undefined removes a key). */
function envWith(extra: Record<string, string | undefined>, path: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NB_DIR: join(work, 'nbdir'), PATH: path };
  delete env.KOOKR_REPO_SLUG;
  delete env.KOOKR_NB_LAYERS;
  delete env.NB_RETRO_DISABLED; // would make the retro hook exit 0 in the placement-parity test
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * Run the hook with a fake `nb`. `jsonOut` answers `list --json --limit 1000`;
 * `flatOut` answers the flat `list --limit 1000`; anything else exits 9.
 */
function inject(
  rows: Row[] | string,
  env: Record<string, string | undefined>,
  opts: { flatOut?: string; script?: string; hook?: string } = {},
): { code: number; out: string; calls: string } {
  const stub = join(work, 'bin');
  execFileSync('mkdir', ['-p', stub]);
  const json = typeof rows === 'string' ? rows : listJson(rows);
  writeFileSync(join(work, 'list.json'), json);
  writeFileSync(join(work, 'list.txt'), opts.flatOut ?? '');
  const calls = join(work, 'calls.log');
  writeFileSync(
    join(stub, 'nb'),
    opts.script ??
      `#!/bin/sh\necho "$*" >> '${calls}'\n` +
        `if [ "$*" = "list --json --limit 1000" ]; then cat '${join(work, 'list.json')}'; exit 0; fi\n` +
        `if [ "$*" = "list --limit 1000" ]; then cat '${join(work, 'list.txt')}'; exit 0; fi\n` +
        `exit 9\n`,
  );
  chmodSync(join(stub, 'nb'), 0o755);
  const r = spawnSync(process.execPath, [opts.hook ?? HOOK], {
    env: envWith(env, `${stub}:${dirname(process.execPath)}:/usr/bin:/bin`),
    encoding: 'utf-8',
  });
  let called = '';
  try {
    called = readFileSync(calls, 'utf-8');
  } catch {
    /* stub never ran */
  }
  return { code: r.status ?? -1, out: r.stdout, calls: called };
}

/** Lines of the group under `title`, up to the next unindented line. */
function group(out: string, title: string): string[] {
  const lines = out.split('\n');
  const at = lines.findIndex((l) => l.startsWith(title));
  if (at === -1) return [];
  const rows: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith('  ')) break;
    rows.push(l.trim().split(/\s+/)[0]);
  }
  return rows;
}
const PROJECT = 'Project shelves';
const DOMAIN = 'Domain shelves';
const GLOBAL = 'Global';
const allRows = (out: string) => [...group(out, PROJECT), ...group(out, DOMAIN), ...group(out, GLOBAL)];

describe('nb-inject layered index — the 44-shelf store snapshot', () => {
  test('fixture is the 44-shelf snapshot this test was written against', () => {
    expect(FIXTURE.shelves).toHaveLength(44);
  });

  test('jeanibarz-agent-notebook: 9 project (legacy @agent-notebook shelves included), 15 hidden, 29 shown', () => {
    const r = inject(fixtureRows, { KOOKR_REPO_SLUG: 'jeanibarz-agent-notebook' });
    expect(r.code).toBe(0);
    expect(r.calls.trim()).toBe('list --json --limit 1000'); // a bare `nb list` returns only 50 rows
    const project = group(r.out, PROJECT);
    expect(project).toHaveLength(9);
    expect(project).toContain('code-review@agent-notebook'); // legacy slug, resolved by slug-aliases.json
    expect(project).toContain('code-review@jeanibarz-agent-notebook');
    expect(group(r.out, DOMAIN)).toHaveLength(19);
    expect(group(r.out, GLOBAL)).toEqual(['fleet-global']);
    expect(allRows(r.out)).toHaveLength(29);
    expect(r.out).toContain('15 shelves for other projects hidden (slug: jeanibarz-agent-notebook); `nb list --limit 1000` shows all');
    expect(r.out).not.toContain('private-repo'); // other repos' shelves are not named
    expect(r.out).not.toContain('@jeanibarz-knowledge-base-mcp-server');
  });

  test('kookr-ai-kookr: 2 project, 22 hidden, 22 shown', () => {
    const r = inject(fixtureRows, { KOOKR_REPO_SLUG: 'kookr-ai-kookr' });
    expect(group(r.out, PROJECT).sort()).toEqual(['code-review@kookr-ai-kookr', 'orchestrator@kookr-ai-kookr']);
    expect(group(r.out, DOMAIN)).toHaveLength(19);
    expect(allRows(r.out)).toHaveLength(22);
    expect(r.out).toContain('22 shelves for other projects hidden (slug: kookr-ai-kookr)');
  });

  test('layers come in the order project, domain, global, then the hidden count, precedence and placement', () => {
    const out = inject(fixtureRows, { KOOKR_REPO_SLUG: 'kookr-ai-kookr' }).out;
    const at = (needle: string) => out.indexOf(needle);
    const order = [PROJECT, DOMAIN, GLOBAL, 'shelves for other projects hidden', 'project > domain > global', 'Placement:'].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).toContain('## Your agent-notebook index'); // the same intro as the flat index
    expect(out).toContain('Open the shelves that fit this task');
  });

  test('the placement sentence is the one the retro nudge uses (they must not drift)', () => {
    const slug = 'kookr-ai-kookr';
    const placement = (text: string) => /Placement: add to .*?Never write fleet-global directly\./s.exec(text.replace(/\s+/g, ' '))?.[0];
    const fromIndex = placement(inject(fixtureRows, { KOOKR_REPO_SLUG: slug }).out);
    const retro = spawnSync(process.execPath, [RETRO], {
      env: envWith({ KOOKR_REPO_SLUG: slug }, process.env.PATH ?? ''),
      input: JSON.stringify({ session_id: 'layers-parity' }),
      encoding: 'utf-8',
    });
    expect(retro.status).toBe(2); // the retro nudge blocks once
    expect(fromIndex).toBeDefined();
    expect(fromIndex).toBe(placement(retro.stderr));
  });
});

describe('nb-inject layered index — classification edge cases', () => {
  test('splits on the LAST @: a@b@c and a@@c are project shelves of slug c', () => {
    const rows: Row[] = [{ shelf: 'a@b@c' }, { shelf: 'a@@c' }, { shelf: 'a@b' }, { shelf: 'plain' }];
    const r = inject(rows, { KOOKR_REPO_SLUG: 'c' });
    expect(group(r.out, PROJECT).sort()).toEqual(['a@@c', 'a@b@c']);
    expect(group(r.out, DOMAIN)).toEqual(['plain']);
    expect(r.out).toContain('1 shelf for other projects hidden (slug: c)'); // a@b -> slug b; singular
    // and with slug b, a@b@c is NOT b's: its slug is c
    const b = inject(rows, { KOOKR_REPO_SLUG: 'b' });
    expect(group(b.out, PROJECT)).toEqual(['a@b']);
    expect(b.out).toContain('2 shelves for other projects hidden');
  });

  test('the slug compares case-insensitively and trimmed (Code-Review@Kookr-AI-Kookr)', () => {
    const rows: Row[] = [{ shelf: 'Code-Review@Kookr-AI-Kookr' }, { shelf: 'x@somebody-else' }];
    const r = inject(rows, { KOOKR_REPO_SLUG: '  kookr-ai-kookr  ' });
    expect(group(r.out, PROJECT)).toEqual(['Code-Review@Kookr-AI-Kookr']);
    expect(r.out).toContain('1 shelf for other projects hidden (slug: kookr-ai-kookr)'); // the trimmed slug is shown
  });

  test('a legacy slug in KOOKR_REPO_SLUG resolves to the same repo as its canonical slug', () => {
    const rows: Row[] = [{ shelf: 'x@jeanibarz-agent-notebook' }, { shelf: 'y@agent-notebook' }];
    expect(group(inject(rows, { KOOKR_REPO_SLUG: 'agent-notebook' }).out, PROJECT).sort()).toEqual(['x@jeanibarz-agent-notebook', 'y@agent-notebook']);
  });

  test('malformed names (empty base or slug) belong to no layer and are skipped, not guessed', () => {
    const r = inject([{ shelf: '@x' }, { shelf: 'x@' }, { shelf: 'ok@s' }], { KOOKR_REPO_SLUG: 's' });
    expect(allRows(r.out)).toEqual(['ok@s']);
    expect(r.out).toContain('2 shelves with a malformed name skipped');
    expect(r.out).toContain('0 shelves for other projects hidden');
  });

  test('says so plainly when the project group is empty while others are hidden', () => {
    const r = inject([{ shelf: 'a@other' }, { shelf: 'topic' }], { KOOKR_REPO_SLUG: 'mine' });
    expect(group(r.out, PROJECT)).toEqual([]);
    expect(r.out).not.toContain('Project shelves'); // no empty heading
    expect(r.out).toContain('No shelf is scoped to this project yet (slug: mine); 1 shelf for other projects hidden');
    expect(group(r.out, DOMAIN)).toEqual(['topic']);
  });

  test('a store of one repo only: the hidden-count line is still printed ("0 shelves ... hidden")', () => {
    const r = inject([{ shelf: 'a@mine' }], { KOOKR_REPO_SLUG: 'mine' });
    expect(r.out).toContain('0 shelves for other projects hidden (slug: mine); `nb list --limit 1000` shows all');
  });

  test('a description is cut at nb list\'s 80-column bound and a missing one falls back to "(auto)"', () => {
    const r = inject([{ shelf: 'a@s', desc: 'd'.repeat(200) }, { shelf: 'b@s', desc: null, auto: 'top lesson' }], { KOOKR_REPO_SLUG: 's' });
    expect(r.out).toContain(`${'d'.repeat(79)}…`);
    expect(r.out).not.toContain('d'.repeat(81));
    expect(r.out).toMatch(/b@s +1 {2}top lesson {2}\(auto\)/);
  });
});

describe('nb-inject layered index — when the flat index is shown instead', () => {
  const flat = 'agent-notebook notebooks — 2 in /store\n  a@mine  1  x\n  other@theirs  1  y\n';

  test.each([
    ['KOOKR_REPO_SLUG unset', {}],
    ['KOOKR_REPO_SLUG empty', { KOOKR_REPO_SLUG: '' }],
    ['KOOKR_REPO_SLUG only whitespace', { KOOKR_REPO_SLUG: '   ' }],
    ['kill switch KOOKR_NB_LAYERS=0', { KOOKR_REPO_SLUG: 'mine', KOOKR_NB_LAYERS: '0' }],
    ['kill switch with surrounding spaces', { KOOKR_REPO_SLUG: 'mine', KOOKR_NB_LAYERS: ' 0 ' }],
  ])('%s -> today\'s flat, capped index (no grouping, nothing hidden)', (_name, env) => {
    const r = inject([{ shelf: 'a@mine' }], env, { flatOut: flat });
    expect(r.code).toBe(0);
    // The rows come from the text listing; `--json` is asked for afterwards, only for the store warnings (#3836).
    expect(r.calls.trim().split('\n')).toEqual(['list --limit 1000', 'list --json --limit 1000']);
    expect(r.out).not.toContain('WARNING'); // a healthy store
    expect(r.out).toContain('a@mine');
    expect(r.out).toContain('other@theirs'); // everything is listed
    expect(r.out).not.toContain('Project shelves');
    expect(r.out).not.toContain('hidden');
  });

  test('KOOKR_NB_LAYERS set to anything but 0 keeps the layered view on', () => {
    for (const v of ['1', '', 'false']) {
      const r = inject([{ shelf: 'a@mine' }], { KOOKR_REPO_SLUG: 'mine', KOOKR_NB_LAYERS: v });
      expect(r.out).toContain('Project shelves');
    }
  });

  test('`nb list --json` output that is not the expected JSON falls back to the flat index', () => {
    const r = inject('this is not json', { KOOKR_REPO_SLUG: 'mine' }, { flatOut: flat });
    expect(r.calls.trim().split('\n')).toEqual(['list --json --limit 1000', 'list --limit 1000']); // tried layered first
    expect(r.out).toContain('other@theirs');
    expect(r.out).not.toContain('hidden');
    // JSON of the wrong shape too
    expect(inject('{"rows":[{"shelf":7}]}', { KOOKR_REPO_SLUG: 'mine' }, { flatOut: flat }).out).toContain('other@theirs');
  });

  test('a missing layers module degrades to the flat index and still exits 0', () => {
    // Copy the hook alone, so ./lib/notebook-layers.mjs does not exist next to it.
    const lonely = join(work, 'lonely-hooks');
    execFileSync('mkdir', ['-p', lonely]);
    copyFileSync(HOOK, join(lonely, 'nb-inject.mjs'));
    const r = inject([{ shelf: 'a@mine' }], { KOOKR_REPO_SLUG: 'mine' }, { flatOut: flat, hook: join(lonely, 'nb-inject.mjs') });
    expect(r.code).toBe(0);
    expect(r.out).toContain('other@theirs');
    expect(r.out).not.toContain('Project shelves');
  });

  test('a layers module that is broken (syntax error) degrades the same way', () => {
    const broken = join(work, 'broken-hooks');
    execFileSync('mkdir', ['-p', join(broken, 'lib')]);
    copyFileSync(HOOK, join(broken, 'nb-inject.mjs'));
    writeFileSync(join(broken, 'lib', 'notebook-layers.mjs'), 'export const x = ;\n');
    const r = inject([{ shelf: 'a@mine' }], { KOOKR_REPO_SLUG: 'mine' }, { flatOut: flat, hook: join(broken, 'nb-inject.mjs') });
    expect(r.code).toBe(0);
    expect(r.out).toContain('other@theirs');
  });
});

describe('nb-inject layered index — failure modes (fail-open, warnings on stdout)', () => {
  test('a failing `nb list --json` -> one-line WARNING on STDOUT, exit 0, no index', () => {
    const r = inject([], { KOOKR_REPO_SLUG: 'mine' }, { script: '#!/bin/sh\necho "cannot read store: EACCES" >&2\nexit 3\n' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('WARNING: `nb list` exited with status 3: cannot read store: EACCES');
    expect(r.out).toContain('not the same as an empty store');
    expect(r.out).not.toContain('Open the shelves that fit');
  });

  test('a hung `nb list --json` -> a timeout warning, exit 0', () => {
    const r = inject([], { KOOKR_REPO_SLUG: 'mine' }, { script: '#!/bin/sh\nexec sleep 30\n' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('timed out after 4s');
  }, 20_000);

  test('missing `nb` -> silent, exit 0 (an empty PATH directory cannot resolve it)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'kookr-nb-layers-empty-'));
    try {
      const out = execFileSync(process.execPath, [HOOK], {
        env: envWith({ KOOKR_REPO_SLUG: 'mine' }, empty),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      expect(out).toBe('');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('an empty store stays silent', () => {
    const r = inject([], { KOOKR_REPO_SLUG: 'mine' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });
});

describe('nb-inject layered index — files and shelves nb reports as unusable (issue #3673)', () => {
  /** `nb list --json` output with agent-notebook 0.8.0's `skipped` and `conflicts` fields. */
  const withProblems = (rows: Row[], skipped: unknown[], conflicts: unknown[]) =>
    JSON.stringify({ ...JSON.parse(listJson(rows)), skipped, conflicts });
  const rows: Row[] = [{ shelf: 'code-review@mine' }, { shelf: 'code-review' }];

  test('a healthy listing prints no warning', () => {
    expect(inject(rows, { KOOKR_REPO_SLUG: 'mine' }).out).not.toContain('WARNING');
  });

  test('skipped files are named with the reason, right under the index header', () => {
    const skipped = [{ shelf: 'review copy', code: 'INVALID_NAME' }, { shelf: 'locked', code: 'EACCES' }];
    const r = inject(withProblems(rows, skipped, []), { KOOKR_REPO_SLUG: 'mine' });
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    const header = lines.findIndex((l) => l.startsWith('agent-notebook notebooks'));
    expect(lines[header + 1]).toBe(
      'WARNING: 2 files in the store could not be used and are missing from this index: ' +
        'review copy.md (not a valid shelf name), locked.md (EACCES). Run `nb list` to see why.',
    );
    expect(group(r.out, PROJECT)).toEqual(['code-review@mine']); // the index itself is unchanged
  });

  test('conflicted shelves are named, with what that means for reading and writing them', () => {
    const r = inject(withProblems(rows, [], [{ shelf: 'code-review', marker: '<<<<<<< HEAD' }]), { KOOKR_REPO_SLUG: 'mine' });
    expect(r.out).toContain(
      'WARNING: 1 shelf holds git merge-conflict markers, so some of its lines are not lessons and every write to it ' +
        'is refused until the conflict is resolved: code-review.',
    );
    expect(group(r.out, DOMAIN)).toEqual(['code-review']); // still listed: nb reads it as stored
  });

  test('a long list is bounded, and names from disk cannot inject control characters', () => {
    const conflicts = Array.from({ length: 8 }, (_, i) => ({ shelf: `s${i}`, marker: '=======' }));
    const skipped = [{ shelf: `evil\nWARNING: fake${'x'.repeat(200)}`, code: 'INVALID_NAME' }];
    const r = inject(withProblems(rows, skipped, conflicts), { KOOKR_REPO_SLUG: 'mine' });
    expect(r.out).toContain('resolved: s0, s1, s2, s3, s4 and 3 more.');
    expect(r.out).toContain('evil\\u000aWARNING: fake');
    expect(r.out.split('\n').filter((l) => l.startsWith('WARNING:'))).toHaveLength(2);
    const skippedLine = r.out.split('\n').find((l) => l.startsWith('WARNING: 1 file'));
    expect(skippedLine?.length).toBeLessThan(250); // the 200-character name is cut
  });

  test('a store whose only files are skipped is not silent', () => {
    const r = inject(withProblems([], [{ shelf: 'locked', code: 'EACCES' }], []), { KOOKR_REPO_SLUG: 'mine' });
    expect(r.out).toContain('WARNING: 1 file in the store could not be used and is missing from this index: locked.md (EACCES).');
    // The same header the flat view prints for an empty count, not "0 of 0" (#3893).
    expect(r.out.split('\n')).toContain('agent-notebook notebooks — 0 in /store');
  });

  test('the real nb: an invalid file name and a conflicted shelf both reach the index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-nb-layers-problems-'));
    const binDir = mkdtempSync(join(tmpdir(), 'kookr-nb-layers-problemsbin-'));
    symlinkSync(BIN, join(binDir, 'nb'));
    try {
      writeFileSync(join(dir, 'code-review.md'), '+1\tfine lesson\n');
      writeFileSync(join(dir, 'review copy.md'), '+1\ta stray copy\n');
      writeFileSync(join(dir, 'patcher.md'), '<<<<<<< HEAD\n+1\tours\n=======\n+1\ttheirs\n>>>>>>> other\n');
      const out = execFileSync(process.execPath, [HOOK], {
        env: { ...envWith({ KOOKR_REPO_SLUG: 'acme-widgets' }, `${binDir}:${process.env.PATH ?? ''}`), NB_DIR: dir },
        encoding: 'utf-8',
      });
      expect(out).toContain('review copy.md (not a valid shelf name)');
      expect(out).toContain('is refused until the conflict is resolved: patcher.');
      expect(group(out, DOMAIN).sort()).toEqual(['code-review', 'patcher']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('nb-inject flat index — files and shelves nb reports as unusable (issue #3836)', () => {
  const withProblems = (rows: Row[], skipped: unknown[], conflicts: unknown[]) =>
    JSON.stringify({ ...JSON.parse(listJson(rows)), skipped, conflicts });
  const flat = 'agent-notebook notebooks — 2 in /store\n  code-review  1  x\n  patcher  1  y\n';
  const problems = withProblems([{ shelf: 'code-review' }, { shelf: 'patcher' }], [{ shelf: 'review copy', code: 'INVALID_NAME' }], [{ shelf: 'patcher', marker: '<<<<<<< HEAD' }]);
  const skippedLine =
    'WARNING: 1 file in the store could not be used and is missing from this index: review copy.md (not a valid shelf name). Run `nb list` to see why.';

  test.each([
    ['KOOKR_REPO_SLUG unset', {}],
    ['kill switch KOOKR_NB_LAYERS=0', { KOOKR_REPO_SLUG: 'mine', KOOKR_NB_LAYERS: '0' }],
  ])('%s -> the same WARNING lines as the layered view, right under the header, rows unchanged', (_name, env) => {
    const r = inject(problems, env, { flatOut: flat });
    expect(r.code).toBe(0);
    const lines = r.out.split('\n');
    const header = lines.findIndex((l) => l.startsWith('agent-notebook notebooks'));
    expect(lines[header + 1]).toBe(skippedLine);
    expect(lines[header + 2]).toContain('WARNING: 1 shelf holds git merge-conflict markers');
    expect(lines[header + 2]).toContain('is refused until the conflict is resolved: patcher.');
    expect(lines.slice(header + 3, header + 5)).toEqual(['  code-review  1  x', '  patcher  1  y']);
  });

  test('a missing layers module still prints the warnings', () => {
    const lonely = join(work, 'lonely-hooks');
    execFileSync('mkdir', ['-p', lonely]);
    copyFileSync(HOOK, join(lonely, 'nb-inject.mjs'));
    const r = inject(problems, { KOOKR_REPO_SLUG: 'mine' }, { flatOut: flat, hook: join(lonely, 'nb-inject.mjs') });
    expect(r.out).toContain(skippedLine);
    expect(r.out).not.toContain('Project shelves');
  });

  test('layered JSON of the wrong shape is reused for the warnings, not fetched twice', () => {
    const wrongShape = JSON.stringify({ rows: [{ shelf: 7 }], skipped: [{ shelf: 'review copy', code: 'INVALID_NAME' }] });
    const r = inject(wrongShape, { KOOKR_REPO_SLUG: 'mine' }, { flatOut: flat });
    expect(r.calls.trim().split('\n')).toEqual(['list --json --limit 1000', 'list --limit 1000']);
    expect(r.out).toContain(skippedLine);
    expect(r.out).toContain('  patcher  1  y');
  });

  test('a failing or garbled `--json` call leaves the flat index as it was, with no warning, exit 0', () => {
    const failing =
      `#!/bin/sh\nif [ "$*" = "list --limit 1000" ]; then printf '%s' '${flat}'; exit 0; fi\n` + `echo "boom" >&2; exit 3\n`;
    for (const script of [failing, `#!/bin/sh\nprintf '%s' '${flat}'\n`]) {
      const r = inject([], {}, { script });
      expect(r.code).toBe(0);
      expect(r.out).toContain('  patcher  1  y');
      expect(r.out).not.toContain('WARNING');
    }
  });

  test('a store whose only files are skipped is not silent in the flat view either', () => {
    const r = inject(withProblems([], [{ shelf: 'locked', code: 'EACCES' }], []), {}, { flatOut: '' });
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toContain('agent-notebook notebooks — 0 in /store');
    expect(r.out).toContain('WARNING: 1 file in the store could not be used and is missing from this index: locked.md (EACCES).');
  });

  test('the warnings and the instructions above the index count against the 8 KB budget', () => {
    const many = Array.from({ length: 60 }, (_, i) => `  shelf-${String(i).padStart(3, '0')}  1  ${'é'.repeat(70)}`);
    const big = `agent-notebook notebooks — 60 in /store\n${many.join('\n')}\n`;
    const conflicts = Array.from({ length: 5 }, (_, i) => ({ shelf: `c${i}${'x'.repeat(55)}`, marker: '=======' }));
    const r = inject(withProblems([], [], conflicts), {}, { flatOut: big });
    expect(r.out).toContain('WARNING: 5 shelves hold git merge-conflict markers');
    expect(r.out).toContain('Open the shelves that fit');
    expect(Buffer.byteLength(r.out)).toBeLessThanOrEqual(8 * 1024); // all of stdout (#3596)
    expect(r.out).toMatch(/… \d+ more shelves not shown/);
  });

  test('a slow `--json` call is cut off after 2 s; the flat index is still printed, with no warning', () => {
    // The JSON (which names a skipped file) arrives after 3 s: past the 2 s WARN_TIMEOUT_MS,
    // inside the 4 s timeout of the main call. Had the call waited for it, the WARNING would show.
    writeFileSync(join(work, 'slow.json'), problems);
    const slowJson =
      `#!/bin/sh\nif [ "$*" = "list --limit 1000" ]; then printf '%s' '${flat}'; exit 0; fi\n` +
      `sleep 3; cat '${join(work, 'slow.json')}'\n`;
    const r = inject([], {}, { script: slowJson });
    expect(r.code).toBe(0);
    expect(r.out).toContain('  patcher  1  y');
    expect(r.out).not.toContain('WARNING'); // best-effort: a slow extra call is dropped, not reported
  }, 20_000);

  test('the real nb: an invalid file name and a conflicted shelf reach the flat index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-nb-flat-problems-'));
    const binDir = mkdtempSync(join(tmpdir(), 'kookr-nb-flat-problemsbin-'));
    symlinkSync(BIN, join(binDir, 'nb'));
    try {
      writeFileSync(join(dir, 'code-review.md'), '+1\tfine lesson\n');
      writeFileSync(join(dir, 'review copy.md'), '+1\ta stray copy\n');
      writeFileSync(join(dir, 'patcher.md'), '<<<<<<< HEAD\n+1\tours\n=======\n+1\ttheirs\n>>>>>>> other\n');
      const out = execFileSync(process.execPath, [HOOK], {
        env: { ...envWith({}, `${binDir}:${process.env.PATH ?? ''}`), NB_DIR: dir },
        encoding: 'utf-8',
      });
      expect(out).toContain('review copy.md (not a valid shelf name)');
      expect(out).toContain('is refused until the conflict is resolved: patcher.');
      expect(out).not.toContain('Project shelves');
      expect(out).toMatch(/^ {2}code-review\s/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('nb-inject layered index — the 60-row / 8 KB cap', () => {
  const domain = (n: number, desc = 'when to open it'): Row[] => Array.from({ length: n }, (_, i) => ({ shelf: `topic-${String(i).padStart(3, '0')}`, desc }));
  const project = (n: number, desc = 'when to open it'): Row[] => Array.from({ length: n }, (_, i) => ({ shelf: `proj-${String(i).padStart(3, '0')}@mine`, desc }));
  const index = (out: string) => out.slice(out.indexOf('agent-notebook notebooks'));

  test('60 rows total: project rows are counted first, domain rows fill the rest, with a "more" tail', () => {
    const r = inject([...project(5), ...domain(80), { shelf: 'fleet-global' }], { KOOKR_REPO_SLUG: 'mine' });
    expect(group(r.out, PROJECT)).toHaveLength(5);
    expect(allRows(r.out)).toHaveLength(60);
    expect(group(r.out, GLOBAL)).toEqual(['fleet-global']); // the host-wide shelf survives a long domain list
    expect(group(r.out, DOMAIN)).toHaveLength(54);
    expect(r.out).toContain('26 more shelves not shown');
    expect(r.out).toContain('nb list --limit 1000');
  });

  test('the project group is never truncated, even past 60 rows; the other layers then get nothing', () => {
    const r = inject([...project(75), ...domain(10), { shelf: 'fleet-global' }], { KOOKR_REPO_SLUG: 'mine' });
    expect(group(r.out, PROJECT)).toHaveLength(75);
    expect(group(r.out, DOMAIN)).toHaveLength(0);
    expect(r.out).toContain('11 more shelves not shown');
  });

  test('the whole output, instructions included, stays within 8 KB (bytes) while every project row is kept whole', () => {
    const wide = 'é'.repeat(80);
    const r = inject([...project(10, wide), ...domain(100, wide)], { KOOKR_REPO_SLUG: 'mine' });
    expect(r.out).toContain('Open the shelves that fit');
    expect(Buffer.byteLength(r.out)).toBeLessThanOrEqual(8 * 1024); // all of stdout (#3596)
    expect(group(r.out, PROJECT)).toHaveLength(10);
    const shown = group(r.out, DOMAIN).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(100);
    expect(r.out).toContain(`${110 - 10 - shown} more shelves not shown`);
    for (const row of r.out.split('\n').filter((l) => l.startsWith('  '))) expect(row.endsWith(wide)).toBe(true); // whole rows
  });

  test('a project group larger than 8 KB (but under 60 rows) is still shown whole; only the other layers are byte-capped', () => {
    const wide = 'é'.repeat(80); // ~190 bytes a row
    const r = inject([...project(50, wide), ...domain(5), { shelf: 'fleet-global' }], { KOOKR_REPO_SLUG: 'mine' });
    expect(Buffer.byteLength(index(r.out))).toBeGreaterThan(8 * 1024);
    expect(group(r.out, PROJECT)).toHaveLength(50); // under the 60-row cap, over the byte cap
    expect(group(r.out, DOMAIN)).toHaveLength(0);
    expect(group(r.out, GLOBAL)).toHaveLength(0);
    expect(r.out).toContain('6 more shelves not shown');
  });

  test('a store under both caps shows no "more" tail', () => {
    const r = inject([...project(3), ...domain(10)], { KOOKR_REPO_SLUG: 'mine' });
    expect(r.out).not.toContain('more shelves not shown');
  });
});

describe('nb-inject layered index — the real nb against a throwaway NB_DIR', () => {
  test('groups real shelves and the hidden count is right', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-nb-layers-real-'));
    const binDir = mkdtempSync(join(tmpdir(), 'kookr-nb-layers-realbin-'));
    symlinkSync(BIN, join(binDir, 'nb'));
    try {
      const baseEnv = { ...envWith({}, process.env.PATH ?? ''), NB_DIR: dir, NB_GIT_AUTOCOMMIT: '0' };
      const nb = (...args: string[]) => execFileSync(process.execPath, [BIN, ...args], { env: baseEnv, stdio: 'ignore' });
      nb('add', 'code-review@acme-widgets', 'mine');
      nb('describe', 'code-review@acme-widgets', 'review a diff in the acme repo');
      nb('add', 'code-review@someone-else', 'theirs');
      nb('add', 'code-review', 'domain lesson');
      nb('add', 'fleet-global', 'host fact');
      const out = execFileSync(process.execPath, [HOOK], {
        env: { ...baseEnv, KOOKR_REPO_SLUG: 'acme-widgets', PATH: `${binDir}:${process.env.PATH ?? ''}` },
        encoding: 'utf-8',
      });
      expect(group(out, PROJECT)).toEqual(['code-review@acme-widgets']);
      expect(group(out, DOMAIN)).toEqual(['code-review']);
      expect(group(out, GLOBAL)).toEqual(['fleet-global']);
      expect(out).toContain('1 shelf for other projects hidden (slug: acme-widgets)');
      expect(out).toContain('review a diff in the acme repo');
      expect(out).not.toContain('someone-else');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);

  test('an empty real store stays silent in layered mode too (nb list --json prints rows: [])', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-nb-layers-realempty-'));
    const binDir = mkdtempSync(join(tmpdir(), 'kookr-nb-layers-realemptybin-'));
    symlinkSync(BIN, join(binDir, 'nb'));
    try {
      const out = execFileSync(process.execPath, [HOOK], {
        env: { ...envWith({ KOOKR_REPO_SLUG: 'acme-widgets' }, `${binDir}:${process.env.PATH ?? ''}`), NB_DIR: dir },
        encoding: 'utf-8',
      });
      expect(out).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);
});
