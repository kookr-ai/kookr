import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ANOMALY_TYPES } from './anomaly-types.js';
import {
  ANOMALY_TYPES as SHARED_ANOMALY_TYPES,
  canonicalizeAnomalyTypeKey,
  DEPRECATED_ANOMALY_TYPE_ALIASES,
} from '../shared/contracts/anomalies.js';

// Drift guard: docs/reference/findings.md must document every AnomalyType.
// Adding a new type to the union (and ANOMALY_TYPES) without a matching section
// here fails CI, keeping the reference catalog in sync with the source of truth.
const findingsDocPath = join(
  import.meta.dirname,
  '..',
  '..',
  'docs',
  'reference',
  'findings.md',
);

const repoRoot = join(import.meta.dirname, '..', '..');
const srcRoot = join(repoRoot, 'src');

/** Walk src/ for .ts/.tsx files (no recursion into node_modules). */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (name.endsWith('.ts') || name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('findings reference catalog', () => {
  const doc = readFileSync(findingsDocPath, 'utf-8');

  test.each(ANOMALY_TYPES)('documents the %s anomaly type', (type) => {
    // Each type gets a `## \`<type>\`` section heading in the catalog.
    expect(doc).toContain(`## \`${type}\``);
  });

  test('has a section heading for every type and no undocumented extras', () => {
    const documented = [...doc.matchAll(/^## `([a-z_]+)`$/gm)].map((m) => m[1]);
    expect([...documented].sort()).toEqual([...ANOMALY_TYPES].sort());
  });
});

describe('core/shared ANOMALY_TYPES parity', () => {
  // The wire contract (src/shared/contracts/anomalies.ts) carries its own runtime
  // ANOMALY_TYPES so frontend code can enumerate the union without importing
  // src/core (forbidden by protocol-boundary.test.ts). The two arrays are
  // hand-maintained in lockstep; this guard fails if they drift — same order and
  // membership required.
  test('core and shared arrays are identical', () => {
    expect([...SHARED_ANOMALY_TYPES]).toEqual([...ANOMALY_TYPES]);
  });
});

describe('backend_unreachable canonicalization (issue #1766)', () => {
  test('maps the deprecated tmux_unresponsive alias to backend_unreachable', () => {
    expect(DEPRECATED_ANOMALY_TYPE_ALIASES.tmux_unresponsive).toBe('backend_unreachable');
    expect(canonicalizeAnomalyTypeKey('tmux_unresponsive')).toBe('backend_unreachable');
  });

  test('leaves already-canonical and unknown keys unchanged', () => {
    expect(canonicalizeAnomalyTypeKey('backend_unreachable')).toBe('backend_unreachable');
    expect(canonicalizeAnomalyTypeKey('needs_input')).toBe('needs_input');
    expect(canonicalizeAnomalyTypeKey('not_a_real_type')).toBe('not_a_real_type');
  });

  test('canonical type is in ANOMALY_TYPES; deprecated alias is not', () => {
    expect(ANOMALY_TYPES).toContain('backend_unreachable');
    expect(ANOMALY_TYPES).not.toContain('tmux_unresponsive');
  });

  test('no production src emits the legacy symbol outside the alias map', () => {
    // Only the contract-edge alias definition may contain the literal in
    // non-test production source. Tests may assert the mapping; docs live
    // outside src/ and are allowed to mention the historical name.
    const allowedRelative = new Set([
      'src/shared/contracts/anomalies.ts',
    ]);
    const legacyLiteral = /['"]tmux_unresponsive['"]/;
    const offenders: string[] = [];

    for (const file of listSourceFiles(srcRoot)) {
      const rel = relative(repoRoot, file).replaceAll('\\', '/');
      if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
      if (allowedRelative.has(rel)) continue;
      const text = readFileSync(file, 'utf-8');
      if (legacyLiteral.test(text)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });
});
