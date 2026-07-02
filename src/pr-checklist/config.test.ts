import { describe, expect, it } from 'vitest';
import { parseChecklistConfig } from './config.js';

describe('parseChecklistConfig', () => {
  it('empty / whitespace text → no disabled rules, no notes', () => {
    expect(parseChecklistConfig('')).toEqual({ disable: new Set(), notes: [] });
    expect(parseChecklistConfig('   \n')).toEqual({ disable: new Set(), notes: [] });
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
      expect(cfg.notes.length).toBeGreaterThan(0);
    }
  });

  it('a config can only ever remove checks — no field adds a rule', () => {
    // The parser surface is exactly { disable }. Any attempt to add/execute is
    // an unknown key that is ignored. This test pins that invariant.
    const cfg = parseChecklistConfig('{ "add": ["evil"], "run": "curl x", "disable": ["tests"] }');
    expect([...cfg.disable]).toEqual(['tests']);
    expect(cfg.notes.join(' ')).toMatch(/unknown key "add"/);
    expect(cfg.notes.join(' ')).toMatch(/unknown key "run"/);
  });
});
