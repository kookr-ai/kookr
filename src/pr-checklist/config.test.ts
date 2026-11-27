import { describe, expect, it } from 'vitest';
import { MAX_TEST_GLOBS, parseChecklistConfig } from './config.js';

describe('parseChecklistConfig', () => {
  it('empty / whitespace text → no disabled rules, no notes', () => {
    expect(parseChecklistConfig('')).toEqual({ disable: new Set(), testGlobs: [], notes: [] });
    expect(parseChecklistConfig('   \n')).toEqual({ disable: new Set(), testGlobs: [], notes: [] });
  });

  it('disables known rule ids', () => {
    const cfg = parseChecklistConfig('{ "disable": ["env", "new-tests"] }');
    expect([...cfg.disable].sort()).toEqual(['env', 'new-tests']);
    expect(cfg.notes).toEqual([]);
  });

  it('ignores unknown rule ids with a note (typo-safe)', () => {
    const cfg = parseChecklistConfig('{ "disable": ["env", "bogus"] }');
    expect([...cfg.disable]).toEqual(['env']);
    expect(cfg.notes.join(' ')).toMatch(/unknown rule id "bogus"/);
  });

  it('ignores unknown top-level keys with a note', () => {
    const cfg = parseChecklistConfig('{ "disable": ["env"], "command": "rm -rf /" }');
    expect([...cfg.disable]).toEqual(['env']);
    expect(cfg.notes.join(' ')).toMatch(/unknown key "command"/);
  });

  it('never throws on malformed input — degrades to no-config with a note (S2)', () => {
    for (const bad of ['not json', '[1,2,3]', '"a string"', '42', 'null', '{ "disable": "env" }', '{ "disable": [1, 2] }']) {
      const cfg = parseChecklistConfig(bad);
      expect(cfg.disable.size).toBe(0);
      expect(cfg.testGlobs).toEqual([]);
      expect(cfg.notes.length).toBeGreaterThan(0);
    }
  });

  it('a config can only ever remove checks — no field adds a rule', () => {
    // The parser surface is exactly { disable, testGlobs }, and test globs only
    // widen what counts as a test. Any attempt to add/execute is
    // an unknown key that is ignored. This test pins that invariant.
    const cfg = parseChecklistConfig('{ "add": ["evil"], "run": "curl x", "disable": ["tests"] }');
    expect([...cfg.disable]).toEqual(['tests']);
    expect(cfg.notes.join(' ')).toMatch(/unknown key "add"/);
    expect(cfg.notes.join(' ')).toMatch(/unknown key "run"/);
  });

  it('reads testGlobs, keeping valid entries in order without duplicates', () => {
    const cfg = parseChecklistConfig('{ "testGlobs": ["*.check.ts", "checks/", "src/**/fixtures/*.sh", "*.check.ts"] }');
    expect(cfg.testGlobs).toEqual(['*.check.ts', 'checks/', 'src/**/fixtures/*.sh']);
    expect(cfg.notes).toEqual([]);
  });

  it('skips unusable testGlobs entries with a content-free note, keeping the rest', () => {
    const cfg = parseChecklistConfig(
      JSON.stringify({ testGlobs: ['ok/*.sh', 3, '', '[ab].ts', '{a,b}.ts', '!x', 'a\\b', '/abs/*', '../up/*', 'x'.repeat(201)] }),
    );
    expect(cfg.testGlobs).toEqual(['ok/*.sh']);
    const notes = cfg.notes.join('\n');
    expect(cfg.notes).toHaveLength(9);
    expect(notes).toMatch(/is not a string/);
    expect(notes).toMatch(/is empty/);
    expect(notes).toMatch(/unsupported syntax/);
    expect(notes).toMatch(/is absolute/);
    expect(notes).toMatch(/"\.\." segment/);
    expect(notes).toMatch(/longer than 200/);
    expect(notes).not.toMatch(/\/abs|up\//);
  });

  it('a non-array testGlobs is ignored with a note; the disable list still applies', () => {
    const cfg = parseChecklistConfig('{ "disable": ["env"], "testGlobs": "*.check.ts" }');
    expect(cfg.testGlobs).toEqual([]);
    expect([...cfg.disable]).toEqual(['env']);
    expect(cfg.notes.join(' ')).toMatch(/"testGlobs" must be an array/);
  });

  it('caps testGlobs at MAX_TEST_GLOBS entries', () => {
    const globs = Array.from({ length: MAX_TEST_GLOBS + 5 }, (_, i) => `t${i}/`);
    const cfg = parseChecklistConfig(JSON.stringify({ testGlobs: globs }));
    expect(cfg.testGlobs).toHaveLength(MAX_TEST_GLOBS);
    expect(cfg.notes.join(' ')).toMatch(/more than 50 entries/);
  });
});
