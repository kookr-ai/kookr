import type { PluginStaleness } from '../../shared/contracts/plugins.js';
import { compareVersions } from './registry.js';

/**
 * Per-plugin available-version sourcing (RFC Layer 1 / R5). This is a
 * version-SOURCE strategy, not an identity branch: the git source works only
 * for the toolkit (which is the kookr repo and has a local git tree); every
 * other plugin's available version needs a marketplace catalog refresh + parse
 * — new code with new failure modes, isolated here and NOT a generalization of
 * the git path. `compareVersions` generalizes; the sourcing does not.
 *
 * In P1 the fleet GET does not perform a (slow, network) catalog refresh, so a
 * non-toolkit plugin's staleness degrades to `unknown` with an honest reason
 * rather than a misleading `current`. That keeps the check legible instead of
 * silent (the view shows the provenance).
 */

/** Git-sourced staleness for the toolkit: compare installed vs the manifest on origin/main. */
export function gitStaleness(
  installedVersion: string | null,
  availableVersion: string | null,
  observedAt: string,
): PluginStaleness {
  if (installedVersion === null) {
    return { state: 'unknown', reason: 'Not installed via the marketplace', source: 'git', observedAt };
  }
  if (availableVersion === null) {
    return { state: 'unknown', reason: 'Available version could not be read from origin/main', source: 'git', observedAt };
  }
  const behind = compareVersions(installedVersion, availableVersion) < 0;
  return { state: behind ? 'behind' : 'current', source: 'git', observedAt };
}

/** Non-toolkit staleness in P1: catalog not refreshed, so the verdict is unknown with provenance. */
export function catalogStalenessUnknown(observedAt: string): PluginStaleness {
  return {
    state: 'unknown',
    reason: 'Catalog not refreshed — open this plugin in /plugin to check for updates',
    source: 'catalog',
    observedAt,
  };
}
