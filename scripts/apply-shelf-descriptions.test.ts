import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Validity guard for the Slice C seed manifest (plugin/notebooks/shelves.json).
// A malformed manifest, an over-long trigger (the tool rejects an over-long
// `nb describe`), or a key that matches no real shelf would make the apply step
// a silent no-op or an error. This keeps the manifest honest as the agent set
// evolves.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'plugin', 'notebooks', 'shelves.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const shelves: Record<string, string> = manifest.shelves ?? {};

// Mirrors agent-notebook's NB_MAX_CHARS default; the reference doc is the source.
const MAX_CHARS = 200;
// Shelf names resolve to <name>.md — must start alnum and use the nb name charset.
const SHELF_NAME = /^[a-z0-9][a-z0-9._-]*$/;

// Shelves that are real but not backed by a plugin/agents/*.md file.
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

  test('the apply script exists and is referenced where it lives', () => {
    expect(existsSync(join(repoRoot, 'scripts', 'apply-shelf-descriptions.mjs'))).toBe(true);
  });
});
