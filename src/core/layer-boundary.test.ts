import { describe, expect, test } from 'vitest';
import { join, relative } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  checkCoreLayerBoundary,
  listTypeScriptFiles,
} from '../../scripts/check-architecture-boundaries.js';

describe('core layer boundary', () => {
  test('src/core has no imports into server/adapters/frontend/cli/remote/integrations', async () => {
    const root = process.cwd();
    const files = await listTypeScriptFiles(join(root, 'src/core'));
    const offenders = files
      .flatMap(checkCoreLayerBoundary)
      .map((violation) => `${relative(root, violation.file)}: ${violation.reason}`);

    expect(offenders).toEqual([]);
  });

  test('rejects core → server (and other outer) relative imports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-layer-boundary-'));
    try {
      const file = join(dir, 'leaky-core.ts');
      writeFileSync(file, [
        "import { canonicalizeScope } from '../server/viewer-data-policy.js';",
        "import type { ViewerTokenResolution } from '../server/auth.js';",
        "import { something } from '../../adapters/terminal-backend.js';",
        "const lazy = () => import('../frontend/App.js');",
      ].join('\n'));

      const violations = checkCoreLayerBoundary(file);
      const reasons = violations.map((violation) => violation.reason);

      expect(reasons).toEqual(expect.arrayContaining([
        expect.stringContaining('server'),
        expect.stringContaining('adapters'),
        expect.stringContaining('frontend'),
      ]));
      expect(reasons.length).toBeGreaterThanOrEqual(3);

      // Each violation carries a real 1-based line pointing at the exact
      // offending import in the synthetic file (not just any positive number).
      const lineFor = (needle: string) =>
        violations.find((violation) => violation.reason.includes(needle))?.line;
      expect(lineFor('server')).toBe(1); // first `../server/...` import, line 1
      expect(lineFor('adapters')).toBe(3); // `../../adapters/...`, line 3
      expect(lineFor('frontend')).toBe(4); // dynamic `import('../frontend/...')`, line 4
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports a distinct, correct line for each repeated outer import', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kookr-layer-boundary-'));
    try {
      const file = join(dir, 'repeated-core.ts');
      writeFileSync(file, [
        "const noop = 1;",
        "import { a } from '../server/first.js';",
        "import { b } from '../server/second.js';",
      ].join('\n'));

      const lines = checkCoreLayerBoundary(file)
        .filter((violation) => violation.reason.includes('server'))
        .map((violation) => violation.line)
        .sort((x, y) => x - y);

      // Each of the two `../server/...` imports is flagged on its own line (2, 3).
      expect(lines).toEqual([2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
