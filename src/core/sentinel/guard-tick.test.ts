import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { at, sentinelFacts, sentinelState } from '../__fixtures__/sentinel-builders.js';
import { runGuardTick } from './guard-tick.js';
import { SENTINEL_DUTIES } from './types.js';

describe('runGuardTick', () => {
  it('runs every duty once per tick, in a fixed order, and logs each decision', () => {
    const r = runGuardTick(sentinelFacts(), sentinelState(), at(5));
    expect(r.log.map((l) => l.duty)).toEqual(['crash-recovery', 'backstop', 'worker-events', 'compaction', 'progress', 'expiry']);
    expect([...r.log.map((l) => l.duty)].sort()).toEqual([...SENTINEL_DUTIES].sort());
  });

  it('a silent, oversized, stalled lead in P0 produces only dry-run actions', () => {
    const facts = sentinelFacts({ transcript: { lastAssistantAtMs: at(0), contextTokens: 400_000 }, lead: { lastScreenChangeAtMs: at(0) } });
    const r = runGuardTick(facts, sentinelState(), at(95));
    expect(r.actions.length).toBeGreaterThan(0);
    expect(r.actions.every((a) => a.dryRun)).toBe(true);
    expect(r.log.every((l) => l.dryRun)).toBe(true);
  });
});

describe('src/core/sentinel stays pure', () => {
  it('imports nothing from server, adapters or node, and never reads the clock', () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      expect(src, file).not.toMatch(/from '(node:|\.\.\/\.\.\/server|\.\.\/\.\.\/adapters)/);
      expect(src, file).not.toMatch(/Date\.now\(|new Date\(\)/);
    }
  });
});
