import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Durable inventory for issue #2823: every file matching the root Vitest
 * exclude globs (`*.integration.test.ts`, `*-e2e.test.ts`) must be classified
 * so the dedicated `pnpm test:integration` lane stays intentional.
 *
 * Classifications:
 * - `credential-gated` — needs a provider API key; uses `describe.skipIf` so
 *   the lane stays deterministic without secrets
 * - `self-contained` — runs without external credentials/ports
 */

const repoRoot = process.cwd();

type Classification = 'credential-gated' | 'self-contained';

/** Relative paths from repo root → classification. */
const INVENTORY: Readonly<Record<string, Classification>> = {
  'src/adapters/llm/task-naming.integration.test.ts': 'credential-gated',
  'src/server/task-naming-e2e.test.ts': 'credential-gated',
};

const EXCLUDE_FILE_RE = /\.integration\.test\.ts$|-e2e\.test\.ts$/;

function walkSrcTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkSrcTsFiles(full, out);
      continue;
    }
    if (st.isFile() && EXCLUDE_FILE_RE.test(name)) {
      out.push(relative(repoRoot, full).split('\\').join('/'));
    }
  }
  return out;
}

describe('root Vitest integration lane inventory (#2823)', () => {
  it('classifies every currently excluded integration/e2e-style Vitest file', () => {
    const onDisk = walkSrcTsFiles(join(repoRoot, 'src')).sort();
    const inventoried = Object.keys(INVENTORY).sort();

    expect(onDisk, 'disk set must match inventory keys').toEqual(inventoried);

    for (const [path, kind] of Object.entries(INVENTORY)) {
      expect(existsSync(join(repoRoot, path)), `${path} missing`).toBe(true);
      expect(['credential-gated', 'self-contained']).toContain(kind);
    }
  });

  it('exposes a deterministic root integration script and config', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:integration']).toBe(
      'vitest run --config vitest.integration.config.ts',
    );
    expect(existsSync(join(repoRoot, 'vitest.integration.config.ts'))).toBe(true);

    const selfContained = Object.entries(INVENTORY)
      .filter(([, kind]) => kind === 'self-contained')
      .map(([path]) => path);
    // Today's excluded set is entirely credential-gated; hyphen-named
    // `*-integration.test.ts` files stay in `pnpm test` by design.
    expect(selfContained).toEqual([]);
  });
});
