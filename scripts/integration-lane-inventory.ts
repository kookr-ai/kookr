/**
 * Shared inventory for the root Vitest integration lanes (#2823).
 *
 * Consumed by:
 * - `vitest.integration.config.ts` (self-contained / deterministic lane)
 * - `vitest.integration.live.config.ts` (opt-in live-LLM lane)
 * - `scripts/integration-lane-inventory.test.ts` (drift guard)
 *
 * File-name patterns (under `src/` and `relay/`):
 * - `*-integration.test.ts`
 * - `*.integration.test.ts`
 * - `*-e2e.test.ts`
 */

export type IntegrationLaneClass = 'self-contained' | 'credential-gated';

/** Relative paths from repo root → lane classification. */
export const INTEGRATION_LANE_INVENTORY: Readonly<
  Record<string, IntegrationLaneClass>
> = {
  'relay/__tests__/die-with-parent-integration.test.ts': 'self-contained',
  'src/adapters/llm/task-naming.integration.test.ts': 'credential-gated',
  'src/server/launch-dedup-integration.test.ts': 'self-contained',
  'src/server/metrics-integration.test.ts': 'self-contained',
  'src/server/oss-source-watcher-integration.test.ts': 'self-contained',
  'src/server/post-recovery-pipeline-starvation-integration.test.ts':
    'self-contained',
  'src/server/session-reaper-dtach-integration.test.ts': 'self-contained',
  'src/server/task-naming-e2e.test.ts': 'credential-gated',
  'src/server/task-naming-integration.test.ts': 'self-contained',
};

/** Basename matcher for integration-style Vitest files under src/ and relay/. */
export const INTEGRATION_STYLE_FILE_RE =
  /(?:^|\/)(?:[^/]+-integration\.test\.ts|[^/]+\.integration\.test\.ts|[^/]+-e2e\.test\.ts)$/;

export function pathsForIntegrationClass(
  kind: IntegrationLaneClass,
): readonly string[] {
  return Object.entries(INTEGRATION_LANE_INVENTORY)
    .filter(([, classification]) => classification === kind)
    .map(([path]) => path)
    .sort();
}

export const SELF_CONTAINED_INTEGRATION_FILES = pathsForIntegrationClass(
  'self-contained',
);

export const CREDENTIAL_GATED_INTEGRATION_FILES = pathsForIntegrationClass(
  'credential-gated',
);
