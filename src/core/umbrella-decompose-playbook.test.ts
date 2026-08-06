import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlaybook, interpolateParameters } from './playbook-parser.js';

/**
 * Contract tests for the umbrella-decompose playbook (issue #2144). These lock
 * in the guarantees that make the idle-slot refinery safe to auto-spawn: it
 * decomposes ONE human-sanctioned umbrella, invents no new top-level scope,
 * emits leaves carrying scope + acceptance criteria, and never executes them.
 * A casual edit that drops one of those guarantees should fail this suite.
 */
describe('umbrella-decompose playbook', () => {
  const playbookPath = join(import.meta.dirname, '..', '..', 'plugin', 'playbooks', 'umbrella-decompose.md');
  const content = readFileSync(playbookPath, 'utf-8');
  const pb = parsePlaybook(content, 'umbrella-decompose.md', '/', 'plugin');

  test('parses with a name and no operator parameters (refinery carries no config)', () => {
    expect(pb.name).toBe('Umbrella Decompose');
    expect(pb.parameters).toEqual([]);
  });

  test('body needs no interpolation (has no {{placeholders}})', () => {
    const interpolated = interpolateParameters(pb.body, pb.parameters, {});
    expect(interpolated).toBe(pb.body);
    expect(pb.body).not.toMatch(/\{\{[^}]+\}\}/);
  });

  test('checklist encodes the acceptance guarantees', () => {
    const checklist = pb.checklist.join('\n').toLowerCase();
    expect(checklist).toContain('one open, human-sanctioned umbrella');
    expect(checklist).toContain('no new top-level scope');
    expect(checklist).toContain('acceptance criteria');
    expect(checklist).toContain('no implementation');
  });

  test('body restricts source to human-sanctioned umbrellas and forbids inventing scope', () => {
    const body = pb.body.toLowerCase();
    expect(body).toContain('human-sanctioned');
    expect(body).toContain('no new top-level scope');
    // Exactly one umbrella per run keeps each spawn bounded.
    expect(body).toMatch(/one and only one|exactly one/);
  });

  test('body requires leaves to carry scope + acceptance criteria and forbids execution', () => {
    const body = pb.body;
    expect(body).toContain('## Scope');
    expect(body).toContain('## Acceptance criteria');
    // Pin the execution prohibition to the "Do not" block itself: the execution
    // verbs (implement / open a PR) must appear inside the prohibition, not just
    // anywhere in the body — so gutting that block fails this test.
    expect(body.toLowerCase()).toMatch(/do not[\s\S]{0,300}(open a pr|implement)/);
  });
});
