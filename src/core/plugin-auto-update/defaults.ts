/**
 * Pure helpers for Layer-4 auto-update: the native `autoUpdate` default rule and
 * external-change detection (RFC Layer 4 / R6).
 */
import { pluginMarketplaceFromId } from '../../shared/contracts/plugins.js';
import type { AutoUpdateExternalChange } from '../../shared/contracts/plugins.js';

/**
 * The documented native `autoUpdate` default: ON for official / claude.ai
 * marketplaces, OFF for everyone else (RFC Background / evidence pack). The
 * `autoUpdate` key is ABSENT on live third-party entries, so this is READ as the
 * default rather than assuming the key exists.
 *
 * The exact set of "official" marketplace ids is not enumerated by Claude Code,
 * so this is a documented best-effort heuristic: a marketplace is treated as
 * official when its name is `claude`/`claude.ai`, mentions `anthropic`, or ends
 * with `-official`. Correctness does NOT hinge on it: when Kookr returns a
 * plugin to `off` it REMOVES its own `autoUpdate` key (an inverse single-key
 * edit), so the true native default re-applies regardless of this heuristic —
 * the default only drives what the UI shows and whether a redundant write is
 * skipped. Pure.
 */
export function defaultAutoUpdate(marketplace: string): boolean {
  const name = marketplace.toLowerCase();
  return (
    name === 'claude' ||
    name === 'claude.ai' ||
    name.includes('anthropic') ||
    name.endsWith('-official')
  );
}

/**
 * The effective native `autoUpdate` for a marketplace: the explicit flag when a
 * scope sets one, else the documented default. Pure.
 */
export function effectiveAutoUpdate(marketplace: string, explicit: boolean | undefined): boolean {
  return explicit ?? defaultAutoUpdate(marketplace);
}

/** The effective `autoUpdate` for a full plugin id (`<name>@<marketplace>`); no marketplace ⇒ OFF default. */
export function effectiveAutoUpdateForPlugin(pluginId: string, explicit: boolean | undefined): boolean {
  const marketplace = pluginMarketplaceFromId(pluginId);
  if (marketplace === null) return explicit ?? false;
  return effectiveAutoUpdate(marketplace, explicit);
}

/**
 * Detect external version changes by diffing the last-observed installed
 * versions against a fresh read. Emits one {@link AutoUpdateExternalChange} per
 * plugin whose version differs from what Kookr last observed, EXCLUDING ids in
 * `kookrChanged` (a version move Kookr itself just made is not "external"). A
 * plugin with no prior observation is NOT a change (it is the first baseline).
 * Pure — the caller persists the new observations and logs the events.
 */
export function detectExternalChanges(
  lastObserved: Readonly<Record<string, string | null>>,
  current: ReadonlyMap<string, string | null>,
  opts: { kookrChanged?: ReadonlySet<string>; now: string },
): AutoUpdateExternalChange[] {
  const kookrChanged = opts.kookrChanged ?? new Set<string>();
  const changes: AutoUpdateExternalChange[] = [];
  for (const [pluginId, toVersion] of current) {
    if (kookrChanged.has(pluginId)) continue;
    if (!(pluginId in lastObserved)) continue; // first observation — baseline, not a change
    const fromVersion = lastObserved[pluginId];
    if (fromVersion === toVersion) continue;
    changes.push({ pluginId, fromVersion, toVersion, detectedAt: opts.now });
  }
  return changes.sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}
