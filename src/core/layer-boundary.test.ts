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

      const reasons = checkCoreLayerBoundary(file).map((violation) => violation.reason);

      expect(reasons).toEqual(expect.arrayContaining([
        expect.stringContaining('server'),
        expect.stringContaining('adapters'),
        expect.stringContaining('frontend'),
      ]));
      expect(reasons.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
