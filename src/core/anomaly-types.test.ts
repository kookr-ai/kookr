import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANOMALY_TYPES } from './anomaly-types.js';

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
