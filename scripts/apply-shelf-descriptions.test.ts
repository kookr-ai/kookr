import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hasDescription, applyDescriptions } from './apply-shelf-descriptions.mjs';

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
const NON_AGENT_SHELVES = new Set(['code-review', 'kookr-task-supervisor']);

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
