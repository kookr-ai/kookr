import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  hasDescription,
  applyDescriptions,
  buildSeed,
  composeProjectDescription,
  deriveProjectDescriptions,
  legacyShelfNames,
  listShelfFiles,
} from './apply-shelf-descriptions.mjs';
import { spawnSync } from 'node:child_process';
import { classifyShelf, loadSlugAliases } from '../plugin/hooks/lib/notebook-layers.mjs';

// Validity guard for the Slice C seed manifest (plugin/notebooks/shelves.json)
// AND unit coverage for the apply logic that writes to the live notebook store —
// the orphan-avoidance pre-flight, the don't-overwrite skip, and idempotency.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'plugin', 'notebooks', 'shelves.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const shelves: Record<string, string> = manifest.shelves ?? {};

// Mirrors agent-notebook's NB_MAX_CHARS default (docs/reference/agent-notebook.md);
// over this, `nb describe` rejects, so a too-long trigger would fail at apply time.
const MAX_CHARS = 200;
const SHELF_NAME = /^[a-z0-9][a-z0-9._-]*$/;
// Shelves with no backing plugin agent: the code-review fan-out shelf, the supervisor,
// the single global shelf, and bases that exist only as per-repo project shelves
// (`orchestrator@<slug>` ...). Their triggers also describe those project shelves.
const NON_AGENT_SHELVES = new Set([
  'code-review',
  'kookr-task-supervisor',
  'fleet-global',
  'orchestrator',
  'diagnostician',
  'planner',
  'refactorer',
  'tester',
]);

function pluginAgentNames(): Set<string> {
  const dir = join(repoRoot, 'plugin', 'agents');
  return new Set(readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)));
}

describe('shelves.json seed manifest is valid', () => {
  test('has a non-empty shelves map', () => {
    expect(Object.keys(shelves).length).toBeGreaterThan(10);
  });

  const entries = Object.entries(shelves);

  test.each(entries)('%s: name is a valid shelf name', (name) => {
    expect(name).toMatch(SHELF_NAME);
  });

  test.each(entries)('%s: trigger is non-empty and within the char cap', (_name, desc) => {
    expect(desc.trim().length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThanOrEqual(MAX_CHARS);
  });

  test('every shelf maps to a real plugin agent or a known non-agent shelf', () => {
    const agents = pluginAgentNames();
    const unknown = Object.keys(shelves).filter(
      (name) => !agents.has(name) && !NON_AGENT_SHELVES.has(name),
    );
    expect(unknown, `manifest shelves with no backing agent/known shelf: ${unknown.join(', ')}`).toEqual([]);
  });

  test('the apply script file exists', () => {
    expect(existsSync(join(repoRoot, 'scripts', 'apply-shelf-descriptions.mjs'))).toBe(true);
  });
});

describe('hasDescription', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const write = (body: string) => {
    dir = mkdtempSync(join(tmpdir(), 'nbdesc-'));
    const f = join(dir, 's.md');
    writeFileSync(f, body);
    return f;
  };

  test('true when a `# desc:` line leads the file', () => {
    expect(hasDescription(write('# desc: open me when X\n+1\tlesson\n'))).toBe(true);
  });
  test('true when `# desc:` follows other `# key:` metadata', () => {
    expect(hasDescription(write('# role: s\n# desc: trigger\n+1\tlesson\n'))).toBe(true);
  });
  // nb's META_RE accepts non-canonical spacing; these are real descriptions to nb
  // and MUST be seen as such, else the seeder overwrites a human-edited one.
  test.each(['#desc: trigger', '#  desc: trigger', '#\tdesc: trigger'])(
    'true for nb-valid non-canonical spacing: %j',
    (header) => {
      expect(hasDescription(write(`${header}\n+1\tlesson\n`))).toBe(true);
    },
  );
  test('true for a file with CRLF line ends or a leading byte-order mark, which nb 0.8.0 reads as described', () => {
    expect(hasDescription(write('# desc: human trigger text\r\n+3\tfirst lesson\r\n'))).toBe(true);
    expect(hasDescription(write('\uFEFF# desc: human trigger text\n+3\tfirst lesson\n'))).toBe(true);
    expect(hasDescription(write('\uFEFF# desc: human trigger text\r\n+3\tfirst lesson\r\n'))).toBe(true);
    // Still false when such a file really has no description.
    expect(hasDescription(write('+3\tfirst lesson\r\n'))).toBe(false);
    expect(hasDescription(write('\uFEFF+3\tfirst lesson\n'))).toBe(false);
  });
  test('false when the desc value is empty (a cleared description)', () => {
    expect(hasDescription(write('# desc:\n+1\tlesson\n'))).toBe(false);
  });
  test('false when there is no description, only lessons', () => {
    expect(hasDescription(write('+1\ta lesson line\n+2\tanother\n'))).toBe(false);
  });
  test('false when a blank line then a lesson precede (no desc in header)', () => {
    expect(hasDescription(write('\n+1\tlesson\n# desc: too late, after a lesson\n'))).toBe(false);
  });
});

describe('applyDescriptions', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function store() {
    dir = mkdtempSync(join(tmpdir(), 'nbstore-'));
    // Non-canonical spacing on purpose: nb treats `#desc:` as a real description,
    // so the seeder must NOT overwrite it (regression pin for the META_RE fix).
    writeFileSync(join(dir, 'described.md'), '#desc: human wrote this\n+1\tlesson\n');
    writeFileSync(join(dir, 'undescribed.md'), '+1\tlesson\n');
    // 'absent' intentionally not created
    return dir;
  }
  const shelvesFixture = { described: 'auto-A', undescribed: 'auto-B', absent: 'auto-C' };
  // A stub that mimics `nb describe`: prepend the canonical `# desc:` header.
  const makeDescribe = (calls: Array<[string, string]>) => (shelf: string, text: string) => {
    calls.push([shelf, text]);
    const f = join(dir, `${shelf}.md`);
    writeFileSync(f, `# desc: ${text}\n` + readFileSync(f, 'utf-8'));
  };

  test('describes only the existing, undescribed shelf; never creates an orphan; never overwrites', () => {
    store();
    const calls: Array<[string, string]> = [];
    const r = applyDescriptions({ dir, shelves: shelvesFixture, describe: makeDescribe(calls) });
    expect(calls).toEqual([['undescribed', 'auto-B']]);
    expect(r).toMatchObject({ described: 1, skippedDescribed: 1, skippedAbsent: 1, failed: [] });
    expect(existsSync(join(dir, 'absent.md'))).toBe(false); // orphan NOT created
    expect(readFileSync(join(dir, 'described.md'), 'utf-8')).toContain('#desc: human wrote this'); // not overwritten (non-canonical spacing preserved)
  });

  test('never overwrites a description in a CRLF or byte-order-mark file (nb 0.8.0 reads both as described)', () => {
    dir = mkdtempSync(join(tmpdir(), 'nbstore-'));
    const crlf = '# desc: human trigger text\r\n+3\tfirst lesson\r\n';
    const bom = '\uFEFF# desc: human trigger text\n+3\tfirst lesson\n';
    writeFileSync(join(dir, 'crlf.md'), crlf);
    writeFileSync(join(dir, 'bom.md'), bom);
    const calls: Array<[string, string]> = [];
    applyDescriptions({ dir, shelves: { crlf: 'auto-A', bom: 'auto-B' }, describe: makeDescribe(calls) });
    expect(calls).toEqual([]);
    expect(readFileSync(join(dir, 'crlf.md'), 'utf-8')).toBe(crlf);
    expect(readFileSync(join(dir, 'bom.md'), 'utf-8')).toBe(bom);
  });

  test('is idempotent — a second run describes nothing', () => {
    store();
    const describe = makeDescribe([]);
    applyDescriptions({ dir, shelves: shelvesFixture, describe });
    const calls: Array<[string, string]> = [];
    const r = applyDescriptions({ dir, shelves: shelvesFixture, describe: makeDescribe(calls) });
    expect(calls).toEqual([]);
    expect(r.described).toBe(0);
  });

  test('--dry-run writes nothing', () => {
    store();
    const calls: Array<[string, string]> = [];
    const r = applyDescriptions({ dir, shelves: shelvesFixture, dryRun: true, describe: makeDescribe(calls) });
    expect(calls).toEqual([]); // describe never invoked
    expect(r.described).toBe(1); // but it counts the would-describe
    expect(readFileSync(join(dir, 'undescribed.md'), 'utf-8')).not.toContain('# desc:');
  });

  test('one failing describe is isolated, not fatal', () => {
    dir = mkdtempSync(join(tmpdir(), 'nbstore-'));
    writeFileSync(join(dir, 'a.md'), '+1\tlesson\n');
    writeFileSync(join(dir, 'b.md'), '+1\tlesson\n');
    const r = applyDescriptions({
      dir,
      shelves: { a: 'ta', b: 'tb' },
      describe: (shelf: string) => {
        if (shelf === 'a') throw new Error('transient');
      },
    });
    expect(r.failed).toEqual(['a']);
    expect(r.described).toBe(1); // b still described despite a failing
  });
});

describe('project-shelf descriptions (RFC memory layers, D4)', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const aliases = loadSlugAliases();
  const mkStore = (files: Record<string, string>) => {
    dir = mkdtempSync(join(tmpdir(), 'nbstore-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, `${name}.md`), body);
    return dir;
  };
  const stubDescribe = (calls: Array<[string, string]> = []) => (shelf: string, text: string) => {
    calls.push([shelf, text]);
    const f = join(dir, `${shelf}.md`);
    writeFileSync(f, `# desc: ${text}\n` + readFileSync(f, 'utf-8'));
  };

  test('derives "<base trigger> (only in <slug>)" for an existing project shelf', () => {
    mkStore({ 'code-review@kookr-ai-kookr': '+1\tx\n' });
    const seed = buildSeed({ dir, manifestShelves: shelves, aliases });
    expect(seed['code-review@kookr-ai-kookr']).toBe(`${shelves['code-review']} (only in kookr-ai-kookr)`);
  });

  test('every base the live store uses has a seed trigger', () => {
    for (const base of ['orchestrator', 'diagnostician', 'planner', 'refactorer', 'tester', 'fleet-global']) {
      expect(shelves[base], base).toBeTruthy();
    }
  });

  test('never creates a shelf: only names present on disk are derived', () => {
    mkStore({ 'code-review@kookr-ai-kookr': '+1\tx\n' });
    const calls: Array<[string, string]> = [];
    applyDescriptions({ dir, shelves: buildSeed({ dir, manifestShelves: shelves, aliases }), describe: stubDescribe(calls) });
    expect(calls.map(([s]) => s)).toEqual(['code-review@kookr-ai-kookr']);
    expect(listShelfFiles(dir)).toEqual(['code-review@kookr-ai-kookr']);
  });

  test('never overwrites a human-written description, in any spacing', () => {
    mkStore({
      'code-review@a': '#desc: human wrote this\n+1\tx\n',
      'code-review@b': '# desc: and this\n+1\tx\n',
      'code-review@c': '+1\tx\n',
    });
    const calls: Array<[string, string]> = [];
    applyDescriptions({ dir, shelves: buildSeed({ dir, manifestShelves: shelves, aliases }), describe: stubDescribe(calls) });
    expect(calls.map(([s]) => s)).toEqual(['code-review@c']);
    expect(readFileSync(join(dir, 'code-review@a.md'), 'utf-8')).toContain('#desc: human wrote this');
  });

  test('skips a legacy-slug shelf, even though its base has a seed trigger', () => {
    mkStore({ 'code-review@agent-notebook': '+1\tx\n', 'code-review@Agent-Notebook': '+1\ty\n' });
    expect(legacyShelfNames({ dir, aliases }).sort()).toEqual(['code-review@Agent-Notebook', 'code-review@agent-notebook']);
    const calls: Array<[string, string]> = [];
    applyDescriptions({ dir, shelves: buildSeed({ dir, manifestShelves: shelves, aliases }), describe: stubDescribe(calls) });
    expect(calls).toEqual([]);
  });

  test('skips a legacy-slug shelf even when the alias file is gone (built-in fallback)', () => {
    mkStore({ 'code-review@agent-notebook': '+1\tx\n' });
    const noFile = loadSlugAliases(join(dir, 'does-not-exist.json'));
    const calls: Array<[string, string]> = [];
    applyDescriptions({
      dir,
      aliases: noFile,
      shelves: buildSeed({ dir, manifestShelves: shelves, aliases: noFile }),
      describe: stubDescribe(calls),
    });
    expect(calls).toEqual([]);
  });

  test('skips a legacy shelf even when it is named explicitly in the manifest', () => {
    mkStore({ 'code-review@agent-notebook': '+1\tx\n' });
    const calls: Array<[string, string]> = [];
    const r = applyDescriptions({ dir, shelves: { 'code-review@agent-notebook': 'explicit' }, aliases, describe: stubDescribe(calls) });
    expect(calls).toEqual([]);
    expect(r.skippedLegacy).toBe(1);
  });

  test('skips a 0-byte file (the leftover of a moved-out shelf)', () => {
    mkStore({ 'code-review@kookr-ai-kookr': '', 'fleet-global': '' });
    const calls: Array<[string, string]> = [];
    const r = applyDescriptions({ dir, shelves: buildSeed({ dir, manifestShelves: shelves, aliases }), aliases, describe: stubDescribe(calls) });
    expect(calls).toEqual([]);
    expect(r.skippedEmpty).toBe(2);
  });

  test('a long slug shortens the trigger, never the "(only in <slug>)" suffix, and stays within 200 chars', () => {
    const slug = 's'.repeat(80);
    const text = composeProjectDescription(shelves['change-verifier'], slug)!;
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.endsWith(` (only in ${slug})`)).toBe(true);
    expect(text).toContain('…');
    expect(composeProjectDescription('short trigger', 'abc')).toBe('short trigger (only in abc)');
    expect(composeProjectDescription('anything', 'x'.repeat(200))).toBeNull();
  });

  test('a manifest entry for the exact project shelf wins over the derived text', () => {
    mkStore({ 'code-review@kookr-ai-kookr': '+1\tx\n' });
    const derived = deriveProjectDescriptions({
      manifestShelves: { ...shelves, 'code-review@kookr-ai-kookr': 'explicit text' },
      shelfNames: ['code-review@kookr-ai-kookr'],
      aliases,
    });
    expect(derived).toEqual({});
  });

  test('a@b@c and a@@c are classified on the LAST @ (base "a@b" / "a@" has no seed, so nothing is derived)', () => {
    const derived = deriveProjectDescriptions({ manifestShelves: { ...shelves, a: 'trigger a' }, shelfNames: ['a@b@c', 'a@@c', 'a@c'], aliases });
    expect(derived).toEqual({ 'a@c': 'trigger a (only in c)' });
  });

  test('a case-different base slug is still the same project shelf kind', () => {
    const derived = deriveProjectDescriptions({ manifestShelves: shelves, shelfNames: ['code-review@Kookr-AI-Kookr'], aliases });
    expect(derived['code-review@Kookr-AI-Kookr']).toContain('(only in Kookr-AI-Kookr)');
  });

  test('is idempotent: a second run over the seeded store describes nothing', () => {
    mkStore({ 'orchestrator@kookr-ai-kookr': '+1\tx\n' });
    applyDescriptions({ dir, shelves: buildSeed({ dir, manifestShelves: shelves, aliases }), describe: stubDescribe() });
    const calls: Array<[string, string]> = [];
    applyDescriptions({ dir, shelves: buildSeed({ dir, manifestShelves: shelves, aliases }), describe: stubDescribe(calls) });
    expect(calls).toEqual([]);
  });
});

// The proof the RFC asks for: apply the seed to a copy of the live store and no
// canonical-slug project shelf is left undescribed. The fixture is the live
// store's shelf NAMES (lesson text is private; the four private repos' slugs are
// anonymized), materialized with placeholder lessons.
describe('seed coverage on a copy of the live store (2026-11-11 snapshot)', () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const fixture = JSON.parse(readFileSync(join(repoRoot, 'scripts', 'fixtures', 'nb-store-shelves-2026-11-11.json'), 'utf-8'));
  const aliases = loadSlugAliases();

  function materialize() {
    dir = mkdtempSync(join(tmpdir(), 'nbstore-'));
    for (const s of fixture.shelves as Array<{ name: string; lessons: number; described: boolean }>) {
      const header = s.described ? '# desc: written by a human\n' : '';
      const body = Array.from({ length: s.lessons }, (_, i) => `+1\tplaceholder lesson ${i}`).join('\n');
      writeFileSync(join(dir, `${s.name}.md`), `${header}${body}\n`);
    }
  }
  const describeStub = (shelf: string, text: string) => {
    const f = join(dir, `${shelf}.md`);
    writeFileSync(f, `# desc: ${text}\n` + readFileSync(f, 'utf-8'));
  };
  const projectShelves = () =>
    listShelfFiles(dir)
      .map((n) => classifyShelf(n, aliases))
      .filter((c) => c.layer === 'project');

  test('the snapshot has the shape the RFC measured: 24 project shelves, 17 canonical-slug and 7 legacy', () => {
    materialize();
    const ps = projectShelves();
    expect(ps).toHaveLength(24);
    expect(ps.filter((c) => c.legacy)).toHaveLength(7);
    expect(ps.filter((c) => !c.legacy)).toHaveLength(17);
  });

  test('after the seed, every canonical-slug project shelf is described and fleet-global too; legacy ones are not', () => {
    materialize();
    const r = applyDescriptions({ dir, shelves: buildSeed({ dir, manifestShelves: shelves, aliases }), aliases, describe: describeStub });
    expect(r.failed).toEqual([]);
    const undescribed = projectShelves()
      .filter((c) => !c.legacy)
      .filter((c) => !hasDescription(join(dir, `${c.name}.md`)))
      .map((c) => c.name);
    expect(undescribed).toEqual([]);
    expect(hasDescription(join(dir, 'fleet-global.md'))).toBe(true);
    for (const c of projectShelves().filter((x) => x.legacy)) {
      expect(hasDescription(join(dir, `${c.name}.md`)), c.name).toBe(false);
    }
  });

  test('a human description in the snapshot is untouched and a second run is a no-op', () => {
    materialize();
    applyDescriptions({ dir, shelves: buildSeed({ dir, manifestShelves: shelves, aliases }), aliases, describe: describeStub });
    expect(readFileSync(join(dir, 'code-review.md'), 'utf-8')).toContain('# desc: written by a human');
    const second = applyDescriptions({ dir, shelves: buildSeed({ dir, manifestShelves: shelves, aliases }), aliases, describe: describeStub });
    expect(second.described).toBe(0);
  });
});

describe('apply-shelf-descriptions CLI argument checking', () => {
  const script = join(repoRoot, 'scripts', 'apply-shelf-descriptions.mjs');
  const go = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf-8', env: { ...process.env, NB_DIR: join(tmpdir(), 'nbstore-never-used') } });

  test.each([
    [['--dry-run', '--bogus'], 'unknown argument'],
    [['--dry-run', '--map=/tmp/x.json'], 'unknown argument'],
    [['--map', ''], 'needs a value'],
    [['--map', join(tmpdir(), 'no-such-aliases.json')], 'does not exist'],
    [['--manifest', 'a', '--manifest', 'b'], 'more than once'],
    [['--manifest', '-x'], 'looks like a flag'],
  ])('%j is refused with exit 2 before anything runs', (args, message) => {
    const r = go(...(args as string[]));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(message);
  });
});

describe('apply-shelf-descriptions blank NB_DIR', () => {
  test('a set-but-blank NB_DIR is refused (nb would fall back to the live store)', () => {
    const r = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'apply-shelf-descriptions.mjs'), '--dry-run'], {
      encoding: 'utf-8',
      env: { ...process.env, NB_DIR: '' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('NB_DIR is set but empty');
  });
});
