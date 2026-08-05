// Regression for issue #2095: plain-node source fallback must resolve the
// TypeScript dependency graph (relative `.js` → `.ts`) without a prior
// `pnpm build:server`. The bin helper activates tsx only when the entry is .ts.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importMaybeTs } from '../../bin/import-maybe-ts.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const contextPackSource = join(repoRoot, 'src/cli/kookr-context-pack.ts');
const contextPackDist = join(repoRoot, 'dist/cli/kookr-context-pack.js');

describe('importMaybeTs', () => {
  it('loads kookr-context-pack from TypeScript source (tsx graph resolution)', async () => {
    expect(existsSync(contextPackSource)).toBe(true);
    const mod = await importMaybeTs(contextPackSource);
    expect(typeof mod.runContextPackCli).toBe('function');

    const logs: string[] = [];
    const code = await mod.runContextPackCli(['--help'], {
      env: {},
      out: { log: (msg: string) => logs.push(msg), error: () => {} },
    });
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('kookr context-pack — build a spawn-time context pack');
  });

  it('loads compiled dist when present without requiring a tsx graph', async () => {
    if (!existsSync(contextPackDist)) {
      // Clean-clone / IVL path: dist is intentionally absent; source path is covered above.
      return;
    }
    const mod = await importMaybeTs(contextPackDist);
    expect(typeof mod.runContextPackCli).toBe('function');
  });
});
