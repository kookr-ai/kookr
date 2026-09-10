import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_GATED_INTEGRATION_FILES,
  INTEGRATION_LANE_INVENTORY,
  INTEGRATION_STYLE_FILE_RE,
  SELF_CONTAINED_INTEGRATION_FILES,
  type IntegrationLaneClass,
} from './integration-lane-inventory.ts';

/**
 * Drift guard for issue #2823: every integration-style Vitest file under
 * `src/` and `relay/` must appear in the shared inventory, and the executable
 * lane configs must select exactly the classified subsets.
 */

const repoRoot = process.cwd();

function walkIntegrationStyleFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkIntegrationStyleFiles(full, out);
      continue;
    }
    if (st.isFile() && INTEGRATION_STYLE_FILE_RE.test(name)) {
      out.push(relative(repoRoot, full).split('\\').join('/'));
    }
  }
  return out;
}

function readConfigInclude(configPath: string): string[] {
  const source = readFileSync(join(repoRoot, configPath), 'utf8');
  // Configs import the shared inventory arrays; assert they reference them.
  return [source];
}

describe('root Vitest integration lane inventory (#2823)', () => {
  it('classifies every integration-style Vitest file under src/ and relay/', () => {
    const onDisk = [
      ...walkIntegrationStyleFiles(join(repoRoot, 'src')),
      ...walkIntegrationStyleFiles(join(repoRoot, 'relay')),
    ].sort();
    const inventoried = Object.keys(INTEGRATION_LANE_INVENTORY).sort();

    expect(onDisk, 'disk set must match inventory keys').toEqual(inventoried);
    expect(inventoried).toHaveLength(9);

    for (const [path, kind] of Object.entries(INTEGRATION_LANE_INVENTORY) as [
      string,
      IntegrationLaneClass,
    ][]) {
      expect(existsSync(join(repoRoot, path)), `${path} missing`).toBe(true);
      expect(['self-contained', 'credential-gated']).toContain(kind);
    }
  });

  it('exposes deterministic self-contained and opt-in live scripts/configs', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test:integration']).toBe(
      'vitest run --config vitest.integration.config.ts',
    );
    expect(pkg.scripts['test:integration:live']).toBe(
      'vitest run --config vitest.integration.live.config.ts',
    );
    expect(existsSync(join(repoRoot, 'vitest.integration.config.ts'))).toBe(true);
    expect(existsSync(join(repoRoot, 'vitest.integration.live.config.ts'))).toBe(
      true,
    );

    expect(SELF_CONTAINED_INTEGRATION_FILES).toEqual([
      'relay/__tests__/die-with-parent-integration.test.ts',
      'src/server/launch-dedup-integration.test.ts',
      'src/server/metrics-integration.test.ts',
      'src/server/oss-source-watcher-integration.test.ts',
      'src/server/post-recovery-pipeline-starvation-integration.test.ts',
      'src/server/session-reaper-dtach-integration.test.ts',
      'src/server/task-naming-integration.test.ts',
    ]);
    expect(CREDENTIAL_GATED_INTEGRATION_FILES).toEqual([
      'src/adapters/llm/task-naming.integration.test.ts',
      'src/server/task-naming-e2e.test.ts',
    ]);

    const [integrationConfig] = readConfigInclude('vitest.integration.config.ts');
    const [liveConfig] = readConfigInclude('vitest.integration.live.config.ts');
    expect(integrationConfig).toContain('SELF_CONTAINED_INTEGRATION_FILES');
    expect(liveConfig).toContain('CREDENTIAL_GATED_INTEGRATION_FILES');
  });
});
