import { describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SLUG_ALIASES,
  DEFAULT_ALIASES_PATH,
  GLOBAL_SHELF,
  MAX_SHELF_NAME_LENGTH,
  canonicalSlug,
  classifyShelf,
  exceedsShelfNameLimit,
  isLegacySlug,
  loadSlugAliases,
  normalizeSlug,
  projectShelfName,
  repoSlugFromEnv,
} from '../plugin/hooks/lib/notebook-layers.mjs';

const aliases = new Map([['agent-notebook', 'jeanibarz-agent-notebook']]);

describe('classifyShelf', () => {
  test('a bare name is the domain layer', () => {
    expect(classifyShelf('code-review', aliases)).toMatchObject({ layer: 'domain', base: 'code-review', slug: '' });
  });

  test('fleet-global is the global layer', () => {
    expect(classifyShelf(GLOBAL_SHELF, aliases).layer).toBe('global');
  });

  test('base@slug is a project shelf', () => {
    expect(classifyShelf('code-review@kookr-ai-kookr', aliases)).toMatchObject({
      layer: 'project',
      base: 'code-review',
      slug: 'kookr-ai-kookr',
      canonical: 'kookr-ai-kookr',
      legacy: false,
    });
  });

  test('splits on the LAST @: a@b@c is base "a@b", slug "c"', () => {
    expect(classifyShelf('a@b@c', aliases)).toMatchObject({ layer: 'project', base: 'a@b', slug: 'c' });
  });

  test('a@@c is base "a@", slug "c"', () => {
    expect(classifyShelf('a@@c', aliases)).toMatchObject({ layer: 'project', base: 'a@', slug: 'c' });
  });

  test('the slug is compared case-insensitively', () => {
    const c = classifyShelf('Code-Review@Kookr-AI-Kookr', aliases);
    expect(c).toMatchObject({ layer: 'project', base: 'Code-Review', slug: 'Kookr-AI-Kookr', canonical: 'kookr-ai-kookr' });
  });

  test('a legacy slug resolves to its canonical one, whatever its case', () => {
    expect(classifyShelf('x@agent-notebook', aliases)).toMatchObject({ legacy: true, canonical: 'jeanibarz-agent-notebook' });
    expect(classifyShelf('x@Agent-Notebook', aliases)).toMatchObject({ legacy: true, canonical: 'jeanibarz-agent-notebook' });
    expect(classifyShelf('x@jeanibarz-agent-notebook', aliases)).toMatchObject({ legacy: false, canonical: 'jeanibarz-agent-notebook' });
  });

  test('an empty base or slug is malformed, not guessed', () => {
    expect(classifyShelf('@kookr', aliases).layer).toBe('malformed');
    expect(classifyShelf('code-review@', aliases).layer).toBe('malformed');
    expect(classifyShelf('@', aliases).layer).toBe('malformed');
  });

  test('non-string input does not throw', () => {
    expect(classifyShelf(undefined as unknown as string, aliases).layer).toBe('domain');
  });
});

describe('slug helpers', () => {
  test('normalizeSlug trims and lower-cases; non-strings become empty', () => {
    expect(normalizeSlug('  Kookr-AI  ')).toBe('kookr-ai');
    expect(normalizeSlug(undefined)).toBe('');
    expect(normalizeSlug(3 as unknown as string)).toBe('');
  });

  test('canonicalSlug resolves one hop only (a chain or cycle cannot loop)', () => {
    const chain = new Map([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(canonicalSlug('a', chain)).toBe('b');
    expect(canonicalSlug('b', chain)).toBe('a');
    expect(canonicalSlug('unrelated', aliases)).toBe('unrelated');
  });

  test('isLegacySlug is true only for an alias source', () => {
    expect(isLegacySlug('agent-notebook', aliases)).toBe(true);
    expect(isLegacySlug('jeanibarz-agent-notebook', aliases)).toBe(false);
  });

  test('repoSlugFromEnv trims and treats empty as unset', () => {
    expect(repoSlugFromEnv({ KOOKR_REPO_SLUG: '  owner-repo \n' })).toBe('owner-repo');
    expect(repoSlugFromEnv({ KOOKR_REPO_SLUG: '   ' })).toBeUndefined();
    expect(repoSlugFromEnv({})).toBeUndefined();
  });

  test('the 128-character shelf name limit', () => {
    expect(MAX_SHELF_NAME_LENGTH).toBe(128);
    expect(exceedsShelfNameLimit(projectShelfName('b'.repeat(100), 's'.repeat(27)))).toBe(false); // 128
    expect(exceedsShelfNameLimit(projectShelfName('b'.repeat(100), 's'.repeat(28)))).toBe(true); // 129
  });
});

describe('loadSlugAliases', () => {
  test('the shipped alias file maps agent-notebook to jeanibarz-agent-notebook', () => {
    expect(Object.fromEntries(loadSlugAliases())).toEqual({ 'agent-notebook': 'jeanibarz-agent-notebook' });
    expect(JSON.parse(readFileSync(DEFAULT_ALIASES_PATH, 'utf-8'))).toEqual(BUILTIN_SLUG_ALIASES);
  });

  test('a missing or malformed file falls back to the built-in map instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aliases-'));
    try {
      expect(loadSlugAliases(join(dir, 'nope.json')).get('agent-notebook')).toBe('jeanibarz-agent-notebook');
      writeFileSync(join(dir, 'bad.json'), '{not json');
      expect(loadSlugAliases(join(dir, 'bad.json')).get('agent-notebook')).toBe('jeanibarz-agent-notebook');
      writeFileSync(join(dir, 'arr.json'), '[1,2]');
      expect(loadSlugAliases(join(dir, 'arr.json')).size).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an override file replaces the built-ins; bad entries and comment keys are dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aliases-'));
    try {
      const f = join(dir, 'map.json');
      writeFileSync(f, JSON.stringify({ _comment: 'x', Old: ' New-Slug ', same: 'same', blank: '  ', n: 4 }));
      const m = loadSlugAliases(f);
      expect([...m]).toEqual([['old', 'New-Slug']]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('strict mode (an explicit --map) throws on a missing, unparsable or non-object file instead of using the built-in map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aliases-'));
    try {
      expect(() => loadSlugAliases(join(dir, 'nope.json'), { strict: true })).toThrow(/does not exist/);
      writeFileSync(join(dir, 'bad.json'), '{not json');
      expect(() => loadSlugAliases(join(dir, 'bad.json'), { strict: true })).toThrow(/cannot be parsed/);
      writeFileSync(join(dir, 'arr.json'), '[1]');
      expect(() => loadSlugAliases(join(dir, 'arr.json'), { strict: true })).toThrow(/not a JSON object/);
      writeFileSync(join(dir, 'ok.json'), '{}');
      expect(loadSlugAliases(join(dir, 'ok.json'), { strict: true }).size).toBe(0); // an empty map is a valid choice
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the module lives where the shim and the hook expect it', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    expect(DEFAULT_ALIASES_PATH).toBe(join(here, '..', 'plugin', 'notebooks', 'slug-aliases.json'));
  });
});
